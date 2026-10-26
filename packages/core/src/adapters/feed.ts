import type { Card, Media } from '../types.js';
import { normalizeCard, parseArea, parseIntSafe, parseMoney, type RawCard } from '../normalize.js';
import { findAllByTag, flattenXml, parseXml, textContent, type XmlNode } from '../parsers/xml.js';

/**
 * Адаптер выгрузок застройщиков.
 *
 * Поддерживает Яндекс.Недвижимость (realty-feed), Avito, ЦИАН и произвольный
 * JSON. Вместо жёсткой схемы — поиск по синонимам ключей: фиды в этой нише
 * расходятся в деталях у каждого застройщика, и толерантный разбор живёт
 * дольше, чем точная привязка к одному формату.
 */

type Flat = Record<string, string>;

/** Разворачивает JSON в ту же плоскую форму, что и `flattenXml`. */
function flattenJson(node: unknown, prefix = '', out: Flat = {}, depth = 0): Flat {
  if (depth > 10 || node == null) return out;
  if (typeof node !== 'object') {
    if (String(node).length) out[prefix] = String(node);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => flattenJson(item, i === 0 ? prefix : `${prefix}[${i}]`, out, depth + 1));
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    flattenJson(value, prefix ? `${prefix}.${key.toLowerCase()}` : key.toLowerCase(), out, depth + 1);
  }
  return out;
}

/** Сегменты пути без индексов и префикса атрибута: `price[1].@value` → ['price','value']. */
function segmentsOf(path: string): string[] {
  return path
    .replace(/\[\d+\]/g, '')
    .split('.')
    .map((s) => s.replace(/^@/, '').toLowerCase())
    .filter(Boolean);
}

/**
 * Обёртки, которые сами по себе ничего не значат. В фидах значение почти
 * всегда лежит на уровень глубже: `<area><value>62.4</value></area>`,
 * `<price><value>…</value></price>`. Поэтому совпадение по родительскому
 * сегменту считается валидным, если лист — одна из таких обёрток.
 */
const GENERIC_LEAVES = new Set(['value', 'amount', 'unit', 'name', 'text', '#text', 'num', 'count']);

/**
 * Ищет значение по списку синонимов **в порядке приоритета**: сначала точное
 * совпадение по листу, затем — по родительскому сегменту с обёрточным листом.
 * Порядок важен: иначе общий ключ `name` перехватывает `building-name`.
 */
function find(flat: Flat, names: string[]): string | undefined {
  const entries = Object.entries(flat);
  for (const raw of names) {
    const name = raw.toLowerCase();
    for (const [path, value] of entries) {
      if (!value) continue;
      const segs = segmentsOf(path);
      if (segs[segs.length - 1] === name) return value;
    }
    for (const [path, value] of entries) {
      if (!value) continue;
      const segs = segmentsOf(path);
      const leaf = segs[segs.length - 1] ?? '';
      if (GENERIC_LEAVES.has(leaf) && segs.slice(0, -1).includes(name)) return value;
    }
  }
  return undefined;
}

function findAll(flat: Flat, names: string[]): string[] {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const out: string[] = [];
  for (const [path, value] of Object.entries(flat)) {
    if (!value) continue;
    const segs = segmentsOf(path);
    const leaf = segs[segs.length - 1] ?? '';
    if (wanted.has(leaf) || (GENERIC_LEAVES.has(leaf) && segs.slice(0, -1).some((s) => wanted.has(s)))) {
      out.push(value);
    }
  }
  return out;
}

const KEYS = {
  complexName: [
    'building-name', 'buildingname', 'complex', 'complexname', 'жк',
    'newdevelopmentname', 'housename', 'residentialcomplex', 'name',
  ],
  city: ['locality-name', 'localityname', 'city', 'town'],
  district: ['sub-locality-name', 'sublocalityname', 'district', 'region'],
  street: ['address', 'street', 'full-address', 'fulladdress'],
  metro: ['metro-name', 'metroname', 'metro', 'undergroundname'],
  metroMinutes: ['time-on-foot', 'timeonfoot', 'timetometro', 'minutes'],
  // «price» идёт первым намеренно: по общему ключу «value» можно поймать
  // чужое значение (area.value, living-space.value) — порядок это исключает.
  price: ['price', 'cost', 'totalprice', 'value'],
  area: ['area', 'totalarea', 'total-area', 'square', 'totalsquare'],
  livingArea: ['living-space', 'livingarea', 'livingspace', 'livingsquare'],
  kitchenArea: ['kitchen-space', 'kitchenarea', 'kitchenspace', 'kitchensquare'],
  rooms: ['rooms', 'roomscount', 'rooms-offered', 'roomsoffered', 'flatrooms'],
  floor: ['floor', 'floornumber'],
  floorsTotal: ['floors-total', 'floorstotal', 'floorscount'],
  building: ['building-section', 'building', 'corpus', 'housenumber'],
  completion: ['built-year', 'builtyear', 'ready-quarter', 'readyquarter', 'deadline', 'completiondate'],
  readiness: ['readiness', 'readinesspercent', 'buildingreadiness'],
  finishing: ['renovation', 'finishing', 'decoration'],
  ceiling: ['ceiling-height', 'ceilingheight'],
  developer: ['developer', 'builder', 'organization', 'companyname'],
  rate: ['mortgage-rate', 'mortgagerate', 'rate'],
  url: ['url', 'link', 'offerurl'],
  lotId: ['internal-id', 'internalid', 'id'],
  segment: ['class', 'segment', 'housetype'],
};

const IMAGE_KEYS = ['image', 'photo', 'imageurl', 'photourl', 'images', 'picture', 'pictureurl'];
const PLAN_HINTS = /plan|планиров|layout|scheme/i;
const PROGRESS_HINTS = /progress|stroy|строй|hod|ход|construction/i;

function classifyMedia(url: string): Media['kind'] {
  if (PLAN_HINTS.test(url)) return 'plan';
  if (PROGRESS_HINTS.test(url)) return 'progress';
  return 'render';
}

function offerToRaw(flat: Flat): RawCard {
  const images = findAll(flat, IMAGE_KEYS).filter((u) => /^https?:\/\//i.test(u));
  const media: Media[] = images.slice(0, 24).map((url) => ({ kind: classifyMedia(url), url }));

  const roomsRaw = find(flat, KEYS.rooms);
  const category = `${find(flat, ['category', 'type', 'offertype']) ?? ''} ${roomsRaw ?? ''}`;
  const isStudio = /студи|studio/i.test(category);
  const rateRaw = find(flat, KEYS.rate);
  const rate = rateRaw ? Number(rateRaw.replace(',', '.').replace(/[^\d.]/g, '')) : NaN;

  return {
    source: 'feed',
    sourceUrl: find(flat, KEYS.url),
    complex: {
      name: find(flat, KEYS.complexName) ?? '',
      location: {
        city: find(flat, KEYS.city),
        district: find(flat, KEYS.district),
        street: find(flat, KEYS.street),
        metro: (() => {
          const name = find(flat, KEYS.metro);
          return name ? { name, minutes: parseIntSafe(find(flat, KEYS.metroMinutes)), byFoot: true } : undefined;
        })(),
      },
      developer: (() => {
        const name = find(flat, KEYS.developer);
        return name ? { name } : undefined;
      })(),
      segment: find(flat, KEYS.segment),
      completion: find(flat, KEYS.completion),
      readinessPercent: parseIntSafe(find(flat, KEYS.readiness)),
      highlights: [],
    },
    lot: {
      id: find(flat, KEYS.lotId),
      rooms: isStudio ? undefined : parseIntSafe(roomsRaw),
      isStudio: isStudio || undefined,
      areaTotal: parseArea(find(flat, KEYS.area)),
      areaLiving: parseArea(find(flat, KEYS.livingArea)),
      areaKitchen: parseArea(find(flat, KEYS.kitchenArea)),
      floor: parseIntSafe(find(flat, KEYS.floor)),
      floorsTotal: parseIntSafe(find(flat, KEYS.floorsTotal)),
      building: find(flat, KEYS.building),
      finishing: find(flat, KEYS.finishing),
      ceilingHeight: parseArea(find(flat, KEYS.ceiling)),
    },
    price: (() => {
      const value = parseMoney(find(flat, KEYS.price));
      return value ? { value, currency: 'RUB' as const } : undefined;
    })(),
    mortgage: Number.isFinite(rate) && rate > 0 && rate < 40 ? { rate } : undefined,
    media,
  };
}

const OFFER_TAGS = ['offer', 'object', 'ad', 'item', 'flat', 'apartment'];

/** Находит узлы-офферы: первый тег из списка, который реально встречается. */
function collectXmlOffers(root: XmlNode): XmlNode[] {
  for (const tag of OFFER_TAGS) {
    const found = findAllByTag(root, tag);
    if (found.length) return found;
  }
  return [];
}

function collectJsonOffers(tree: unknown, depth = 0): unknown[] {
  if (depth > 6 || tree == null || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree;
  const obj = tree as Record<string, unknown>;
  for (const key of ['offers', 'offer', 'objects', 'object', 'ads', 'items', 'flats', 'data', 'results']) {
    const value = obj[key];
    if (Array.isArray(value) && value.length) return value;
    if (value && typeof value === 'object') return [value];
  }
  for (const value of Object.values(obj)) {
    const found = collectJsonOffers(value, depth + 1);
    if (found.length) return found;
  }
  return [];
}

export interface FeedParseResult {
  cards: Card[];
  total: number;
  format: 'xml' | 'json';
  warnings: string[];
}

/** Разбирает XML- или JSON-фид в список карточек. */
export function parseFeed(payload: string, opts: { limit?: number } = {}): FeedParseResult {
  const limit = opts.limit ?? 200;
  const warnings: string[] = [];
  const trimmed = payload.trim();
  if (!trimmed) throw new Error('Пустой фид.');

  let flats: Flat[];
  let total: number;
  let format: 'xml' | 'json';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    format = 'json';
    let tree: unknown;
    try {
      tree = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Не удалось разобрать JSON-фид: ${(err as Error).message}`);
    }
    const offers = collectJsonOffers(tree);
    if (!offers.length) {
      throw new Error('В JSON не нашлось массива объектов. Ожидались ключи offers / objects / items / flats.');
    }
    total = offers.length;
    flats = offers.slice(0, limit).map((offer) => flattenJson(offer));
  } else {
    format = 'xml';
    const root = parseXml(trimmed);
    const offers = collectXmlOffers(root);
    if (!offers.length) {
      throw new Error('В XML не нашлось ни одного объекта. Ожидались узлы offer / object / Ad / item.');
    }
    total = offers.length;
    flats = offers.slice(0, limit).map((offer) => {
      const flat = flattenXml(offer);
      // Узлу-офферу часто дают id атрибутом: <offer internal-id="123">
      for (const [key, value] of Object.entries(offer.attrs)) flat[`@${key}`] = value;
      if (!flat['name'] && offer.text.trim()) flat['name'] = textContent(offer);
      return flat;
    });
  }

  const cards = flats.map((flat) => normalizeCard(offerToRaw(flat)));

  const nameless = cards.filter((c) => c.missing.includes('complex.name')).length;
  if (nameless) {
    warnings.push(`У ${nameless} из ${cards.length} объектов не определилось название ЖК — проверьте тег building-name.`);
  }
  const priceless = cards.filter((c) => c.missing.includes('price.value')).length;
  if (priceless) {
    warnings.push(`У ${priceless} объектов не нашлась цена.`);
  }
  if (total > limit) {
    warnings.push(`В фиде ${total} объектов, разобраны первые ${limit}.`);
  }

  return { cards, total, format, warnings };
}
