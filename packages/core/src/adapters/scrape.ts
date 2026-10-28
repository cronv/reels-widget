import type { Media } from '../types.js';
import { normalizeCard, parseArea, parseIntSafe, parseMoney, type RawCard } from '../normalize.js';
import { collectJsonLd, firstText, scanHtml, type HtmlScan } from '../parsers/html.js';
import { applySpecs } from './specs.js';
import { matchProfile, mergeRaw, type SiteProfile } from './profiles.js';

/**
 * Адаптер «вставил ссылку на карточку — получил данные».
 *
 * Порядок доверия: JSON-LD → микроразметка → OpenGraph → эвристики по тексту.
 * Чем выше источник, тем он структурнее; регулярки включаются только для
 * полей, которые остались пустыми после разметки.
 */

const UA = 'ReelsWidget/1.0';

/**
 * Ошибка загрузки страницы, в которой виноват не сервер.
 *
 * Нужна, чтобы отличать «сайт нас не пустил» от настоящего сбоя: без
 * этого запрет robots.txt уходил клиенту как 500 и ложился в логи
 * внутренней ошибкой, хотя чинить там нечего — это ожидаемый ответ.
 */
export class ScrapeError extends Error {
  constructor(message: string, public status = 422) {
    super(message);
    this.name = 'ScrapeError';
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  /** Проверять robots.txt перед загрузкой. По умолчанию включено. */
  respectRobots?: boolean;
  fetchImpl?: typeof fetch;
}

/** Проверка Disallow для нашего UA и для `*`. */
export async function isAllowedByRobots(target: string, opts: FetchOptions = {}): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const url = new URL(target);
    const res = await doFetch(`${url.origin}/robots.txt`, {
      headers: { 'user-agent': opts.userAgent ?? UA },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) return true;
    const text = await res.text();

    let applies = false;
    const disallowed: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const clean = (line.split('#')[0] ?? '').trim();
      if (!clean) continue;
      const colon = clean.indexOf(':');
      if (colon === -1) continue;
      const key = clean.slice(0, colon).trim().toLowerCase();
      const value = clean.slice(colon + 1).trim();
      if (key === 'user-agent') {
        applies = value === '*' || (opts.userAgent ?? UA).toLowerCase().includes(value.toLowerCase());
      } else if (key === 'disallow' && applies && value) {
        disallowed.push(value);
      }
    }
    return !disallowed.some((rule) => url.pathname.startsWith(rule));
  } catch {
    return true; // недоступный robots.txt не повод блокировать загрузку
  }
}

export async function fetchHtml(target: string, opts: FetchOptions = {}): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL(target);
  if (!/^https?:$/.test(url.protocol)) {
    throw new ScrapeError('Поддерживаются только http и https-ссылки.', 400);
  }
  if (opts.respectRobots !== false) {
    const allowed = await isAllowedByRobots(target, opts);
    if (!allowed) {
      throw new ScrapeError(
        `robots.txt сайта ${url.hostname} запрещает автоматическую загрузку этой страницы. ` +
          'Если сайт ваш — добавьте домен в SCRAPE_TRUSTED_HOSTS и перезапустите сервис ' +
          '(docker compose … up -d), либо поправьте robots.txt на самом сайте.',
      );
    }
  }
  const res = await doFetch(target, {
    headers: {
      'user-agent': opts.userAgent ?? UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'ru-RU,ru;q=0.9',
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new ScrapeError(`Страница ответила ${res.status} ${res.statusText}`, 502);
  const type = res.headers.get('content-type') ?? '';
  if (!/html/i.test(type)) throw new ScrapeError(`Ожидался HTML, пришло «${type}»`);
  return res.text();
}

type Json = Record<string, unknown>;

function typeOf(node: Json): string {
  const t = node['@type'];
  if (typeof t === 'string') return t.toLowerCase();
  if (Array.isArray(t)) return t.map(String).join(' ').toLowerCase();
  return '';
}

function deepGet(node: unknown, key: string, depth = 0): unknown {
  if (depth > 5 || node == null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepGet(item, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const obj = node as Json;
  if (key in obj && obj[key] != null) return obj[key];
  for (const value of Object.values(obj)) {
    const found = deepGet(value, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

const RU = {
  price: /(?:цена|стоимость)[^\d]{0,20}([\d\s .,]+)\s*(?:млн\s*)?(?:₽|руб)/i,
  priceFrom: /от\s*([\d\s .,]+)\s*(?:млн\s*)?(?:₽|руб)/i,
  area: /(?:площад[ьи]|общая)[^\d]{0,20}([\d.,]+)\s*м/i,
  areaLoose: /(\d{1,3}(?:[.,]\d{1,2})?)\s*м²/,
  rooms: /(\d)\s*-?\s*комнатн/i,
  studio: /студи[яю]/i,
  floor: /(\d{1,2})\s*(?:этаж|эт\.)\s*(?:из|\/)\s*(\d{1,2})/i,
  floorSingle: /этаж[^\d]{0,10}(\d{1,2})/i,
  rate: /(?:ставк[аи]|ипотек[аи])[^\d]{0,25}(\d{1,2}(?:[.,]\d)?)\s*%/i,
  completion: /(I{1,3}V?|[1-4])\s*кв(?:артал)?\.?\s*(20\d{2})/i,
  readiness: /готовн[а-я]*[^\d]{0,15}(\d{1,3})\s*%/i,
  metro: /(?:м\.|метро)\s*«?([А-ЯЁ][а-яё\s-]{2,28})»?/,
  metroTime: /(\d{1,2})\s*мин[^.]{0,15}(?:пешк|транспорт)/i,
};

const BAD_IMAGE = /icon|logo|sprite|pixel|avatar|placeholder|\.svg($|\?)/i;

function classifyImage(hint: string): Media['kind'] {
  if (/план|plan|layout/i.test(hint)) return 'plan';
  if (/ход\s*строит|стройк|progress|construction/i.test(hint)) return 'progress';
  return 'render';
}

export interface ParseReport {
  raw: RawCard;
  /** Профиль, узнавший страницу, если такой нашёлся. */
  profile?: SiteProfile;
  /** Характеристики, распознанные словарём — видно в `npm run parse`. */
  matchedSpecs: { label: string; value: string; target: string }[];
  /** Сколько пар «подпись — значение» нашлось в разметке. */
  pairsFound: number;
}

/**
 * Разбирает страницу в три слоя, каждый следующий кладётся поверх:
 *
 *   1. универсальный — JSON-LD, OpenGraph, регулярки по тексту;
 *   2. словарь характеристик — пары «подпись — значение» из разметки;
 *   3. профиль движка — если страница узнана.
 *
 * Порядок именно такой: чем конкретнее источник, тем он точнее, и тем
 * позже должен применяться.
 */
export function parseListing(html: string, url: string): ParseReport {
  const scan = scanHtml(html);
  let raw = parseGeneric(html, url, scan);

  const specs = applySpecs(scan.pairs);
  raw = mergeRaw(raw, specs.patch);

  let profile: SiteProfile | undefined;
  try {
    const ctx = { scan, html, url: new URL(url) };
    profile = matchProfile(ctx);
    if (profile) {
      raw = mergeRaw(raw, profile.extract(ctx));
      // На странице комплекса «лот» собирается из каталога квартир —
      // это не объект страницы, а случайная карточка из списка.
      if (profile.pageKind?.(ctx) === 'complex') {
        delete raw.lot;
        if (raw.price) delete raw.price.perSquareMeter;
      }
    }
  } catch {
    // Некорректный URL или сбой профиля не должны ронять разбор:
    // универсального слоя и словаря обычно уже достаточно.
  }

  return { raw, profile, matchedSpecs: specs.matched, pairsFound: scan.pairs.length };
}

/** Совместимость: прежняя точка входа отдаёт только карточку. */
export function parseListingHtml(html: string, url: string): RawCard {
  return parseListing(html, url).raw;
}

/** Слой 1: то, что можно взять на любом сайте без знания его устройства. */
function parseGeneric(html: string, url: string, prescanned?: HtmlScan): RawCard {
  const scan: HtmlScan = prescanned ?? scanHtml(html);
  const ld = collectJsonLd(scan);
  const product = ld.find((n) =>
    /product|apartment|residence|offer|realestatelisting|singlefamilyresidence|place/.test(typeOf(n)),
  );
  const org = ld.find((n) => /organization|localbusiness/.test(typeOf(n)));
  const body = scan.text;

  const og = (key: string): string | undefined => scan.metas[`og:${key}`];

  // ── название ─────────────────────────────────────────────────────────────
  const rawName =
    asString(product?.name) ?? og('title') ?? firstText(scan, ['h1', 'title']) ?? '';
  const name = rawName
    .replace(/\s*[|—–-]\s*(купить|цена|официальный сайт|застройщик|новостройк).*$/i, '')
    .replace(/^жк\s*/i, 'ЖК ')
    .trim();

  // ── цена ─────────────────────────────────────────────────────────────────
  const ldPrice = parseMoney(deepGet(product, 'price') ?? deepGet(product, 'lowPrice'));
  const metaPrice = parseMoney(scan.metas['price'] ?? scan.metas['product:price:amount']);
  const textPrice = parseMoney(RU.price.exec(body)?.[1] ?? RU.priceFrom.exec(body)?.[1]);
  const priceValue = ldPrice ?? metaPrice ?? textPrice;
  const isFrom = !ldPrice && !metaPrice && RU.priceFrom.test(body);

  // ── лот ──────────────────────────────────────────────────────────────────
  const floorMatch = RU.floor.exec(body);
  const roomsMatch = RU.rooms.exec(body);
  const areaValue =
    parseArea(RU.area.exec(body)?.[1]) ??
    parseArea(deepGet(product, 'floorSize')) ??
    parseArea(RU.areaLoose.exec(body)?.[1]);

  // ── локация ──────────────────────────────────────────────────────────────
  const addressNode = deepGet(product, 'address');
  const address =
    typeof addressNode === 'string'
      ? { raw: addressNode }
      : {
          city: asString(deepGet(addressNode, 'addressLocality')),
          district: asString(deepGet(addressNode, 'addressRegion')),
          street: asString(deepGet(addressNode, 'streetAddress')),
        };
  const metroName = RU.metro.exec(body)?.[1]?.trim();

  // ── медиа ────────────────────────────────────────────────────────────────
  const media: Media[] = [];
  const push = (src: string | undefined, kind: Media['kind'], caption?: string): void => {
    if (!src) return;
    media.push({ kind, url: src, caption });
  };

  push(og('image'), 'render');
  const ldImages = deepGet(product, 'image');
  for (const img of Array.isArray(ldImages) ? ldImages : [ldImages]) {
    if (typeof img === 'string') push(img, 'render');
    else if (img && typeof img === 'object') push(asString((img as Json).url), 'render');
  }

  for (const attrs of scan.images) {
    if (media.length > 30) break;
    const src = attrs.src ?? attrs['data-src'] ?? attrs['data-lazy-src'] ?? attrs['data-original'];
    if (!src) continue;
    const hint = `${attrs.alt ?? ''} ${attrs.class ?? ''} ${src}`;
    if (BAD_IMAGE.test(hint)) continue;
    const width = parseIntSafe(attrs.width);
    if (width != null && width < 240) continue;
    push(src, classifyImage(hint), attrs.alt?.trim() || undefined);
  }

  // ── прочее ───────────────────────────────────────────────────────────────
  const completionMatch = RU.completion.exec(body);
  const rateMatch = RU.rate.exec(body);
  const readinessMatch = RU.readiness.exec(body);

  // Преимущества намеренно не собираются из <li>: на сайте застройщика
  // в списках лежит навигация, и в ролик попадали пункты меню вроде
  // «Каталог жилых комплексов». Ошибка здесь заметнее, чем пустое место:
  // сценарий без преимуществ подставляет нейтральную строку, а ролик
  // с меню вместо плюсов пришлось бы перевыпускать. Преимущества даёт
  // профиль сайта или ручной ввод.
  const highlights: string[] = [];

  return {
    source: 'url',
    sourceUrl: url,
    complex: {
      name,
      location: {
        ...address,
        metro: metroName
          ? { name: metroName, minutes: parseIntSafe(RU.metroTime.exec(body)?.[1]), byFoot: true }
          : undefined,
      },
      developer: asString(org?.name) ? { name: asString(org?.name)! } : undefined,
      completion: completionMatch ? `${completionMatch[1]} кв. ${completionMatch[2]}` : undefined,
      readinessPercent: parseIntSafe(readinessMatch?.[1]),
      highlights,
    },
    lot: {
      rooms: roomsMatch ? Number(roomsMatch[1]) : undefined,
      isStudio: !roomsMatch && RU.studio.test(body) ? true : undefined,
      areaTotal: areaValue,
      floor: floorMatch ? Number(floorMatch[1]) : parseIntSafe(RU.floorSingle.exec(body)?.[1]),
      floorsTotal: floorMatch ? Number(floorMatch[2]) : undefined,
    },
    price: priceValue ? { value: priceValue, currency: 'RUB', isFrom } : undefined,
    mortgage: rateMatch?.[1] ? { rate: Number(rateMatch[1].replace(',', '.')) } : undefined,
    media,
  };
}

/** Загружает страницу и возвращает нормализованную карточку. */
export async function scrapeUrl(url: string, opts: FetchOptions = {}) {
  const html = await fetchHtml(url, opts);
  const report = parseListing(html, url);
  return { card: normalizeCard(report.raw), report };
}
