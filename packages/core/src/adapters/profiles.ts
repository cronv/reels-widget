import type { Media } from '../types.js';
import type { HtmlScan } from '../parsers/html.js';
import { parseArea, parseMoney, type RawCard } from '../normalize.js';

/**
 * Профили конкретных движков.
 *
 * Универсальный разбор (JSON-LD, OpenGraph, словарь характеристик) работает
 * везде, но на сайте, устроенном известным образом, можно взять кратно
 * больше и без догадок. Профиль срабатывает только если узнал страницу,
 * и его данные кладутся поверх универсальных.
 *
 * Чтобы добавить новый движок, достаточно дописать объект в `PROFILES`:
 * `detect` отвечает «моя ли это страница», `extract` возвращает кусочек
 * карточки. Остальной конвейер трогать не нужно.
 */

export interface ProfileContext {
  scan: HtmlScan;
  /** Исходный HTML — для точечных выборок, до которых не достаёт сканер. */
  html: string;
  url: URL;
}

export interface SiteProfile {
  id: string;
  label: string;
  detect(ctx: ProfileContext): boolean;
  extract(ctx: ProfileContext): RawCard;
  /**
   * Что это за страница. Важно для страницы комплекса: на ней выводится
   * каталог квартир, и универсальный разбор охотно собирает «лот» из первой
   * попавшейся карточки каталога. В ролике это выглядело бы так, будто у ЖК
   * есть одна конкретная квартира с случайной площадью и этажом.
   */
  pageKind?(ctx: ProfileContext): 'complex' | 'lot' | 'unknown';
}

// ── общие мелочи ────────────────────────────────────────────────────────────

const clean = (s: string | undefined): string | undefined => {
  const t = s?.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  return t || undefined;
};

/** `ЖК "Космос"` → `ЖК «Космос»`: ёлочки в кадре выглядят опрятнее. */
function prettyQuotes(name: string): string {
  return name.replace(/"([^"]+)"/g, '«$1»').replace(/''|``/g, '');
}

/** «4,6 млн ₽ - 16,5 млн ₽» → нижняя граница и признак «от». */
function parsePriceRange(value: string): { value?: number; isFrom?: boolean } {
  const cleaned = value.replace(/ /g, ' ');
  const parts = cleaned.split(/\s*[-–—]\s*|\s+до\s+/i).filter((p) => /\d/.test(p));
  if (parts.length >= 2) {
    const low = parseMoney(parts[0]);
    return low ? { value: low, isFrom: true } : {};
  }
  const single = parseMoney(cleaned);
  return single ? { value: single, isFrom: /^\s*от\b/i.test(cleaned) } : {};
}

/**
 * «Россия, Домодедово, улица Жуковского, 1» → город и улица.
 * Страна отбрасывается: в кадре она не нужна.
 */
function splitAddress(raw: string): { city?: string; street?: string; raw: string } {
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const withoutCountry = parts[0] && /^россия$/i.test(parts[0]) ? parts.slice(1) : parts;
  if (!withoutCountry.length) return { raw };
  const [city, ...rest] = withoutCountry;
  return { city, street: rest.join(', ') || undefined, raw };
}

/** Словарь выгод для плашек над галереей. */
const PROMO_BADGE =
  /рассрочк|ставк|ипотек|скидк|trade-?in|подар|акци|паркинг|кладов|меблир|отделк|ключи|заселен/i;

// ── профиль «СуперБаза» ─────────────────────────────────────────────────────

/**
 * Движок, на котором работают сайты ЖК вида `zhk-<name>.alphasuper-baza.ru`.
 *
 * Разметки Schema.org и OpenGraph на страницах нет вовсе, поэтому опора —
 * набор атрибутов `data-call-*` на кнопке звонка. Это готовая сводка по
 * объекту: название, адрес, цена, телефон и главное изображение. Она есть
 * и на странице комплекса, и на странице лота, и переживает смену вёрстки
 * лучше, чем любые CSS-классы, которые здесь генерируются утилитарно.
 */
const superbaza: SiteProfile = {
  id: 'superbaza',
  label: 'СуперБаза (alphasuper-baza.ru)',

  detect({ scan, url }) {
    if (/alphasuper-baza\.ru$/i.test(url.hostname)) return true;
    const hasCallData = scan.links.some((l) => l.attrs['data-call-title']);
    const hasBreadcrumbs = scan.nodes.some((n) => /breadcrumbs__item/.test(n.cls ?? ''));
    return hasCallData && hasBreadcrumbs;
  },

  pageKind({ scan, url }) {
    if (/\/flats?\/flat\//.test(url.pathname)) return 'lot';
    const title = scan.links.find((l) => l.attrs['data-call-title'])?.attrs['data-call-title'];
    if (title && /№\s*\d/.test(title)) return 'lot';
    return 'complex';
  },

  extract({ scan, html, url }) {
    // ── сводка с кнопки звонка ────────────────────────────────────────────
    const call = scan.links.find((l) => l.attrs['data-call-title'])?.attrs ?? {};
    const callTitle = clean(call['data-call-title']);
    const callCompany = clean(call['data-call-company']);
    const callAddress = clean(call['data-call-address']);
    const callPrice = clean(call['data-call-price']);
    // Каждый вариант чистится отдельно: на странице комплекса
    // data-call-phone-pretty присутствует, но пустой, и `??` его бы принял.
    const phone = clean(call['data-call-phone-pretty']) ?? clean(call['data-call-phone']);

    const isLot = /\/flats?\/flat\//.test(url.pathname) || /№\s*\d/.test(callTitle ?? '');

    // ── название ЖК ───────────────────────────────────────────────────────
    // На странице лота data-call-company — это сам ЖК; на странице комплекса
    // он совпадает с заголовком. Запасной путь — хлебные крошки.
    const breadcrumbName = scan.links.find(
      (l) => /breadcrumbs/.test(l.cls ?? '') === false && /^ЖК\s/i.test(l.text),
    )?.text;
    const rawName = callCompany ?? breadcrumbName ?? scan.texts.find((t) => t.tag === 'h1')?.text;
    const name = rawName ? prettyQuotes(rawName) : undefined;

    // ── разбор заголовка лота ─────────────────────────────────────────────
    // «№ 167, Студия, 28.85 м², ЖК "Космос", (квартира)»
    const lot: Record<string, unknown> = {};
    if (isLot && callTitle) {
      const number = /№\s*(\d+)/.exec(callTitle)?.[1];
      if (number) lot.id = number;
      const area = /(\d+(?:[.,]\d+)?)\s*м²/.exec(callTitle)?.[1];
      if (area) lot.areaTotal = parseArea(area);
      if (/студи/i.test(callTitle)) lot.isStudio = true;
      else {
        const rooms = /(\d)\s*-?\s*комнатн/i.exec(callTitle)?.[1];
        if (rooms) lot.rooms = Number(rooms);
      }
    }

    // ── адрес и метро ─────────────────────────────────────────────────────
    const address = callAddress ? splitAddress(callAddress) : undefined;
    // Станция лежит в безымянном span сразу за иконкой метро — классов,
    // за которые можно зацепиться, у него нет.
    const metroName = clean(
      /icon-metro[\s\S]{0,260}?<\/span>\s*<span[^>]*>([^<]{2,40})<\/span>/.exec(html)?.[1],
    );

    // ── цена ──────────────────────────────────────────────────────────────
    const price = callPrice ? parsePriceRange(callPrice) : {};

    // ── изображения ───────────────────────────────────────────────────────
    const media = collectMedia(scan, html, isLot);

    // ── плашки-акции над галереей ─────────────────────────────────────────
    // Классы здесь утилитарные и по ним одним плашку от пункта меню
    // не отличить, поэтому дополнительно требуется словарь выгод.
    // Попавший в ролик пункт навигации — брак, который виден всем.
    const badges = scan.nodes
      .filter((n) => /rounded-\[7px\]/.test(n.cls ?? ''))
      .map((n) => n.text)
      .filter((t) => t && t.length <= 28 && PROMO_BADGE.test(t))
      .filter((t, i, all) => all.indexOf(t) === i)
      .slice(0, 4);

    const patch: RawCard = {
      source: 'url',
      sourceUrl: url.toString(),
      complex: {
        name: name ?? '',
        location: {
          ...(address ?? {}),
          metro: metroName ? { name: metroName, byFoot: true } : undefined,
        },
        highlights: badges,
      },
      media,
      contact: {
        phone,
        site: url.hostname,
      },
    };

    if (Object.keys(lot).length) patch.lot = lot as RawCard['lot'];
    if (price.value) {
      patch.price = { value: price.value, currency: 'RUB', isFrom: price.isFrom };
    }

    return patch;
  },
};

/**
 * Находит, в каком куске документа лежит раздел с заданным заголовком.
 *
 * Фотографии стройки висят в секции под <h2>Ход строительства</h2>, и
 * никакого id или класса, по которому её можно опознать, у этой секции нет.
 * Имя файла тоже не признак: сегодня там IMG_5989.jpg, завтра что угодно.
 * Границы раздела в документе — единственный устойчивый признак.
 */
function sectionRange(html: string, heading: RegExp): [number, number] | null {
  const m = heading.exec(html);
  if (!m) return null;
  const start = m.index;
  const end = html.indexOf('</section>', start);
  return [start, end === -1 ? Math.min(start + 60_000, html.length) : end];
}

/**
 * Галереи этого движка разложены по вкладкам с говорящими id, а полные
 * версии снимков лежат в `href` лайтбокса — в `src` только миниатюры.
 */
function collectMedia(scan: HtmlScan, html: string, isLot: boolean): Media[] {
  const out: Media[] = [];
  const seen = new Set<string>();
  const progressRange = sectionRange(html, /Ход\s+строительства/i);

  const inProgressSection = (url: string): boolean => {
    if (!progressRange) return false;
    const at = html.indexOf(url);
    return at >= progressRange[0] && at <= progressRange[1];
  };

  const push = (url: string | undefined, kind: Media['kind'], caption?: string): void => {
    if (!url) return;
    const key = url.split('?')[0] ?? url;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(caption ? { kind, url, caption } : { kind, url });
  };

  const classify = (src: string, section?: string): Media['kind'] | null => {
    const file = (src.split('/').pop() ?? '').toLowerCase();
    // Иконки, логотипы, карты и баннеры интерфейса в ролик не идут.
    if (/^(logo|icon|image-map|compass|app-|google-play|rustore)/.test(file)) return null;
    if (/\.svg($|\?)/.test(file)) return null;
    if (/header-image-banner|item-tour-image/.test(file)) return null;

    if (inProgressSection(src)) return 'progress';
    if (section === 'objectPlan') return 'plan';
    // k7-et8-s3-kv2-northwest.png — планировка квартиры с компасом,
    // k7-et8-s3-kv2.jpg — план этажа. Обе полезны, планировка важнее.
    if (/^k\d+-et\d+-s\d+-kv\d+/.test(file)) return 'plan';
    if (/plan|planirov/.test(file)) return 'plan';
    return 'render';
  };

  // Сначала лайтбокс: там оригиналы, а в data-title — подпись к снимку,
  // которую сценарий «Ход строительства» показывает под кадром.
  for (const link of scan.links) {
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(link.href)) continue;
    const kind = classify(link.href, link.section);
    if (kind) push(link.href, kind, clean(link.attrs['data-title']));
  }

  for (const img of scan.images) {
    const src = img.src ?? img['data-src'];
    if (!src) continue;
    const kind = classify(src, img.__section);
    if (kind) push(src, kind);
  }

  // На странице лота планировка должна идти первой: сценарий «Лот
  // с планировкой» берёт первое изображение нужного типа.
  if (isLot) {
    out.sort((a, b) => Number(b.kind === 'plan') - Number(a.kind === 'plan'));
  }
  return out.slice(0, 40);
}

export const PROFILES: SiteProfile[] = [superbaza];

export function matchProfile(ctx: ProfileContext): SiteProfile | undefined {
  return PROFILES.find((p) => {
    try {
      return p.detect(ctx);
    } catch {
      return false;
    }
  });
}

/** Накладывает патч поверх базы: непустое значение патча побеждает. */
export function mergeRaw(base: RawCard, patch: RawCard): RawCard {
  const pickMedia = patch.media?.length ? patch.media : base.media;
  return {
    ...base,
    ...patch,
    complex: {
      ...base.complex,
      ...patch.complex,
      name: patch.complex?.name || base.complex?.name || '',
      location: { ...base.complex?.location, ...patch.complex?.location },
      developer: patch.complex?.developer ?? base.complex?.developer,
      highlights: patch.complex?.highlights?.length
        ? patch.complex.highlights
        : base.complex?.highlights,
    } as RawCard['complex'],
    lot: base.lot || patch.lot ? { ...base.lot, ...patch.lot } : undefined,
    price: patch.price ?? base.price,
    mortgage: patch.mortgage ?? base.mortgage,
    promo: patch.promo ?? base.promo,
    media: pickMedia,
    contact: { ...base.contact, ...patch.contact },
  };
}
