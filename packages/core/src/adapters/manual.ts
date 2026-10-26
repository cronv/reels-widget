import type { Card, Media } from '../types.js';
import { normalizeCard, parseArea, parseIntSafe, parseMoney, type RawCard } from '../normalize.js';

/**
 * Адаптер ручного ввода. Форма отдаёт плоский объект со строками —
 * здесь он превращается в карточку. Тот же вход используется, когда
 * менеджер правит поля, не распознанные парсером.
 */

export interface ManualInput {
  complexName?: string;
  city?: string;
  district?: string;
  street?: string;
  metroName?: string;
  metroMinutes?: string | number;
  developer?: string;
  segment?: string;
  highlights?: string | string[];
  completion?: string;
  readinessPercent?: string | number;

  rooms?: string | number;
  isStudio?: boolean;
  areaTotal?: string | number;
  areaKitchen?: string | number;
  floor?: string | number;
  floorsTotal?: string | number;
  finishing?: string;
  view?: string;

  price?: string | number;
  priceIsFrom?: boolean;
  oldPrice?: string | number;

  mortgageRate?: string | number;
  mortgageProgram?: string;
  downPaymentPercent?: string | number;
  termYears?: string | number;

  promoTitle?: string;
  promoSubtitle?: string;
  promoUntil?: string;
  discountPercent?: string | number;

  phone?: string;
  site?: string;

  /** Ссылки на изображения, по одной на строку, или готовый массив. */
  renders?: string | string[];
  plans?: string | string[];
  progressPhotos?: string | string[];
  logoUrl?: string;
}

function toList(input: string | string[] | undefined): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((s) => s.trim()).filter(Boolean);
  return input
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function fromManual(input: ManualInput): Card {
  const media: Media[] = [
    ...toList(input.renders).map((url): Media => ({ kind: 'render', url })),
    ...toList(input.plans).map((url): Media => ({ kind: 'plan', url })),
    ...toList(input.progressPhotos).map((url): Media => ({ kind: 'progress', url })),
  ];

  const rate = input.mortgageRate != null && input.mortgageRate !== ''
    ? Number(String(input.mortgageRate).replace(',', '.'))
    : undefined;

  const raw: RawCard = {
    source: 'manual',
    complex: {
      name: (input.complexName ?? '').trim(),
      location: {
        city: input.city?.trim() || undefined,
        district: input.district?.trim() || undefined,
        street: input.street?.trim() || undefined,
        metro: input.metroName
          ? { name: input.metroName.trim(), minutes: parseIntSafe(input.metroMinutes), byFoot: true }
          : undefined,
      },
      developer: input.developer ? { name: input.developer.trim(), logoUrl: input.logoUrl } : undefined,
      segment: input.segment?.trim() || undefined,
      highlights: toList(input.highlights),
      completion: input.completion?.trim() || undefined,
      readinessPercent: parseIntSafe(input.readinessPercent),
    },
    lot: {
      rooms: input.isStudio ? undefined : parseIntSafe(input.rooms),
      isStudio: input.isStudio || undefined,
      areaTotal: parseArea(input.areaTotal),
      areaKitchen: parseArea(input.areaKitchen),
      floor: parseIntSafe(input.floor),
      floorsTotal: parseIntSafe(input.floorsTotal),
      finishing: input.finishing?.trim() || undefined,
      view: input.view?.trim() || undefined,
    },
    price: (() => {
      const value = parseMoney(input.price);
      if (!value) return undefined;
      return {
        value,
        currency: 'RUB' as const,
        isFrom: Boolean(input.priceIsFrom),
        oldValue: parseMoney(input.oldPrice),
      };
    })(),
    mortgage: Number.isFinite(rate) && rate! > 0
      ? {
          rate: rate!,
          program: input.mortgageProgram?.trim() || undefined,
          downPaymentPercent: parseIntSafe(input.downPaymentPercent),
          termYears: parseIntSafe(input.termYears),
        }
      : undefined,
    promo: input.promoTitle
      ? {
          title: input.promoTitle.trim(),
          subtitle: input.promoSubtitle?.trim() || undefined,
          until: input.promoUntil?.trim() || undefined,
          discountPercent: parseIntSafe(input.discountPercent),
        }
      : undefined,
    media,
    contact: {
      phone: input.phone?.trim() || undefined,
      site: input.site?.trim() || undefined,
    },
  };

  return normalizeCard(raw);
}
