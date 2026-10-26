import type { Card, Media, Price, SourceKind } from './types.js';
import { annuity, shortHash, slugify } from './format.js';

export type RawCard = Partial<Omit<Card, 'id' | 'missing' | 'fetchedAt' | 'source'>> & {
  source?: SourceKind;
};

/** Поля, по которым виджет решает, какие сценарии доступны. */
export const FIELD_LABELS: Record<string, string> = {
  'complex.name': 'Название ЖК',
  'complex.location': 'Расположение',
  'complex.completion': 'Срок сдачи',
  'complex.readinessPercent': 'Готовность, %',
  'complex.highlights': 'Преимущества',
  'price.value': 'Цена',
  'lot.areaTotal': 'Площадь лота',
  'lot.rooms': 'Комнатность',
  'lot.floor': 'Этаж',
  'mortgage.rate': 'Ставка по ипотеке',
  'promo.title': 'Акция',
  'media.render': 'Рендеры',
  'media.plan': 'Планировка',
  'media.progress': 'Фото со стройки',
};

const PLACEHOLDER_HOSTS = new Set(['example.com', 'localhost']);

function cleanUrl(url: string | undefined, base?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('data:')) return undefined;
  try {
    const resolved = new URL(trimmed, base);
    if (!/^https?:$/.test(resolved.protocol)) return undefined;
    if (PLACEHOLDER_HOSTS.has(resolved.hostname)) return undefined;
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function dedupeMedia(media: Media[], base?: string): Media[] {
  const seen = new Set<string>();
  const out: Media[] = [];
  for (const m of media) {
    const url = cleanUrl(m.url, base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...m, url });
  }
  return out;
}

/** Вытаскивает число из «от 8 450 000 ₽», «8,45 млн», «8450000». */
export function parseMoney(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.round(input);
  if (typeof input !== 'string') return undefined;
  const text = input.replace(/ |\s/g, '').toLowerCase();
  const isMillions = /млн|mln|m₽/.test(text);
  const match = /-?\d+(?:[.,]\d+)?/.exec(text);
  if (!match) return undefined;
  const n = Number(match[0].replace(',', '.'));
  if (!Number.isFinite(n)) return undefined;
  return Math.round(isMillions ? n * 1_000_000 : n);
}

/** «42,5 м²», «42.5», 42.5 → 42.5 */
export function parseArea(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'string') return undefined;
  const match = /-?\d+(?:[.,]\d+)?/.exec(input.replace(/\s/g, ''));
  if (!match) return undefined;
  const n = Number(match[0].replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n < 10_000 ? n : undefined;
}

export function parseIntSafe(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.round(input);
  if (typeof input !== 'string') return undefined;
  const match = /-?\d+/.exec(input);
  if (!match) return undefined;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Приводит сырой объект к `Card`: чистит URL, считает производные поля,
 * собирает список недостающих данных.
 */
export function normalizeCard(raw: RawCard): Card {
  const base = raw.sourceUrl;
  const complex = {
    name: (raw.complex?.name ?? '').trim(),
    location: raw.complex?.location ?? {},
    developer: raw.complex?.developer,
    segment: raw.complex?.segment,
    highlights: (raw.complex?.highlights ?? []).map((h) => h.trim()).filter(Boolean).slice(0, 6),
    completion: raw.complex?.completion,
    readinessPercent: raw.complex?.readinessPercent,
    buildingsCount: raw.complex?.buildingsCount,
    floorsTotal: raw.complex?.floorsTotal,
    finishing: raw.complex?.finishing,
    escrow: raw.complex?.escrow,
  };

  const lot = raw.lot ? { ...raw.lot } : undefined;
  if (lot?.areaTotal && lot.areaTotal > 400) {
    // Частая ошибка фидов: площадь пришла в дециметрах.
    lot.areaTotal = lot.areaTotal / 10;
  }

  let price: Price | undefined = raw.price ? { ...raw.price, currency: 'RUB' } : undefined;
  if (price && !price.perSquareMeter && lot?.areaTotal && lot.areaTotal > 0) {
    price.perSquareMeter = Math.round(price.value / lot.areaTotal);
  }
  if (price && price.value <= 0) price = undefined;

  const mortgage = raw.mortgage ? { ...raw.mortgage } : undefined;
  if (mortgage && !mortgage.monthlyPayment && price) {
    const down = (mortgage.downPaymentPercent ?? 20) / 100;
    const term = mortgage.termYears ?? 30;
    mortgage.monthlyPayment = annuity(price.value * (1 - down), mortgage.rate, term);
    mortgage.downPaymentPercent = mortgage.downPaymentPercent ?? 20;
    mortgage.termYears = term;
  }

  const media = dedupeMedia(raw.media ?? [], base);

  const missing: string[] = [];
  if (!complex.name) missing.push('complex.name');
  if (!complex.location.city && !complex.location.raw && !complex.location.street) {
    missing.push('complex.location');
  }
  if (!price) missing.push('price.value');
  if (!media.some((m) => m.kind === 'render' || m.kind === 'photo')) missing.push('media.render');
  if (!media.some((m) => m.kind === 'plan')) missing.push('media.plan');
  if (!media.some((m) => m.kind === 'progress')) missing.push('media.progress');
  if (!complex.completion) missing.push('complex.completion');
  if (complex.readinessPercent == null) missing.push('complex.readinessPercent');
  if (!complex.highlights.length) missing.push('complex.highlights');
  if (!lot?.areaTotal) missing.push('lot.areaTotal');
  if (!lot?.rooms && !lot?.isStudio) missing.push('lot.rooms');
  if (!lot?.floor) missing.push('lot.floor');
  if (!mortgage?.rate) missing.push('mortgage.rate');
  if (!raw.promo?.title) missing.push('promo.title');

  const idSeed = raw.sourceUrl ?? `${complex.name}|${lot?.id ?? ''}|${price?.value ?? ''}`;
  const id = `${slugify(complex.name || 'obj')}-${shortHash(idSeed)}`;

  return {
    id,
    source: raw.source ?? 'manual',
    sourceUrl: raw.sourceUrl,
    complex,
    lot,
    price,
    mortgage,
    promo: raw.promo,
    media,
    contact: raw.contact,
    missing,
    fetchedAt: new Date().toISOString(),
  };
}

/** Сливает карточку с правками из формы: ручной ввод всегда побеждает. */
export function mergeCard(base: Card, patch: RawCard): Card {
  const merged: RawCard = {
    source: base.source,
    sourceUrl: patch.sourceUrl ?? base.sourceUrl,
    complex: { ...base.complex, ...patch.complex, location: { ...base.complex.location, ...patch.complex?.location } },
    lot: patch.lot || base.lot ? { ...base.lot, ...patch.lot } : undefined,
    price: patch.price ?? base.price,
    mortgage: patch.mortgage ?? base.mortgage,
    promo: patch.promo ?? base.promo,
    media: patch.media ?? base.media,
    contact: { ...base.contact, ...patch.contact },
  };
  return normalizeCard(merged);
}

export function pickMedia(card: Card, kinds: Media['kind'][], limit: number): Media[] {
  const out: Media[] = [];
  for (const kind of kinds) {
    for (const m of card.media) {
      if (m.kind === kind && !out.includes(m)) out.push(m);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
