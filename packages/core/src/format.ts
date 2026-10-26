/** Форматирование под русскую недвижимость: цены, площади, склонения. */

const NBSP = ' ';

/** 8450000 → «8 450 000» (неразрывные пробелы, чтобы не рвалось в кадре). */
export function groupDigits(n: number): string {
  const sign = n < 0 ? '-' : '';
  const s = Math.round(Math.abs(n)).toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += NBSP;
    out += s[i];
  }
  return sign + out;
}

/** 8450000 → «8 450 000 ₽», с опциональным «от». */
export function formatPrice(value: number, opts: { from?: boolean; short?: boolean } = {}): string {
  const prefix = opts.from ? `от${NBSP}` : '';
  if (opts.short && value >= 1_000_000) {
    const m = value / 1_000_000;
    const str = m >= 10 ? m.toFixed(1) : m.toFixed(2);
    return `${prefix}${str.replace('.', ',').replace(/,?0+$/, '')}${NBSP}млн${NBSP}₽`;
  }
  return `${prefix}${groupDigits(value)}${NBSP}₽`;
}

/** 42.5 → «42,5 м²» */
export function formatArea(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const str = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
  return `${str}${NBSP}м²`;
}

/** 285000 → «285 000 ₽/м²» */
export function formatPerMeter(value: number): string {
  return `${groupDigits(value)}${NBSP}₽/м²`;
}

/**
 * Склонение по числу: plural(2, ['комната','комнаты','комнат']) → «комнаты».
 */
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/** 2 → «2-комнатная», студия → «Студия». */
export function roomsLabel(rooms: number | undefined, isStudio?: boolean): string {
  if (isStudio) return 'Студия';
  if (!rooms || rooms < 1) return 'Квартира';
  if (rooms >= 5) return `${rooms}-комнатная`;
  return `${rooms}-комнатная`;
}

/** Короткая метка для плашки: «2К», «СТ». */
export function roomsBadge(rooms: number | undefined, isStudio?: boolean): string {
  if (isStudio) return 'СТ';
  if (!rooms) return '—';
  return `${rooms}К`;
}

/** 7 из 24 → «7 этаж из 24». */
export function floorLabel(floor?: number, total?: number): string | undefined {
  if (!floor) return undefined;
  return total ? `${floor}${NBSP}этаж из${NBSP}${total}` : `${floor}${NBSP}этаж`;
}

/** 5 мин пешком до метро. */
export function metroLabel(metro?: { name: string; minutes?: number; byFoot?: boolean }): string | undefined {
  if (!metro?.name) return undefined;
  if (!metro.minutes) return metro.name;
  const mode = metro.byFoot === false ? 'на транспорте' : 'пешком';
  return `${metro.name} · ${metro.minutes}${NBSP}мин ${mode}`;
}

/** Собирает читаемый адрес из частей. */
export function locationLine(loc: {
  city?: string;
  district?: string;
  street?: string;
  raw?: string;
}): string {
  const parts = [loc.city, loc.district, loc.street].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return loc.raw ?? '';
}

const QUARTER = ['I', 'I', 'I', 'II', 'II', 'II', 'III', 'III', 'III', 'IV', 'IV', 'IV'];

/** Дом уже построен — на сайтах пишут «Сдан», «Сдано», «Ключи выданы». */
export function isCompleted(value?: string): boolean {
  return Boolean(value && /^(сдан|сдано|построен|готов|ключи)/i.test(value.trim()));
}

/** ISO, «04.08.2025» или «IV кв. 2027» → «IV кв. 2027». */
export function completionLabel(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (isCompleted(trimmed)) return 'Сдан';

  const iso = /^(\d{4})-(\d{2})/.exec(trimmed);
  if (iso) {
    return `${QUARTER[Number(iso[2]) - 1]}${NBSP}кв.${NBSP}${iso[1]}`;
  }
  // Российские сайты чаще пишут дату как ДД.ММ.ГГГГ.
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (ru) {
    return `${QUARTER[Number(ru[2]) - 1]}${NBSP}кв.${NBSP}${ru[3]}`;
  }
  return trimmed;
}

/**
 * Готовая строка для кадра. Отдельно от `completionLabel`, потому что
 * «Сдача — Сдан» читается как опечатка: у готового дома срок не в будущем,
 * и фраза должна быть другой.
 */
export function completionPhrase(value?: string): string | undefined {
  const label = completionLabel(value);
  if (!label) return undefined;
  return label === 'Сдан' ? 'Дом сдан' : `Сдача${NBSP}— ${label}`;
}

/** Сколько дней осталось до даты; null если дата в прошлом или не парсится. */
export function daysLeft(until?: string, now = new Date()): number | null {
  if (!until) return null;
  const end = new Date(until);
  if (Number.isNaN(end.getTime())) return null;
  const diff = Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
  return diff > 0 ? diff : null;
}

/** «Осталось 6 дней» */
export function deadlineLabel(until?: string, now = new Date()): string | undefined {
  const d = daysLeft(until, now);
  if (d === null) return undefined;
  return `Осталось ${d}${NBSP}${plural(d, ['день', 'дня', 'дней'])}`;
}

/** Ставка 5.9 → «5,9%». */
export function formatRate(rate: number): string {
  return `${String(Math.round(rate * 100) / 100).replace('.', ',')}%`;
}

/**
 * Аннуитетный платёж. Нужен, когда фид отдал ставку, но не платёж.
 * principal — сумма кредита, rate — годовых в процентах, years — срок.
 */
export function annuity(principal: number, rate: number, years: number): number {
  if (principal <= 0 || years <= 0) return 0;
  const months = years * 12;
  const i = rate / 100 / 12;
  if (i === 0) return Math.round(principal / months);
  const k = (i * Math.pow(1 + i, months)) / (Math.pow(1 + i, months) - 1);
  return Math.round(principal * k);
}

/** Обрезает строку по словам, чтобы влезала в кадр. */
export function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/**
 * Короткий стабильный хеш (FNV-1a, 32 бита) для идентификаторов карточек.
 * Криптостойкость тут не нужна — нужен детерминированный суффикс, который
 * не меняется между запусками и не тянет за собой `node:crypto`: ядро должно
 * собираться и в браузере тоже.
 */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(0, 7);
}

/** Безопасный slug для имён файлов. */
export function slugify(input: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
  };
  return input
    .toLowerCase()
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'object';
}
