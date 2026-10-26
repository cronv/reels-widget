import type { LabelValue } from '../parsers/html.js';
import { parseArea, parseIntSafe, parseMoney, type RawCard } from '../normalize.js';

/**
 * Словарь характеристик новостроек.
 *
 * Сайты застройщиков показывают параметры объекта подписями по-русски —
 * «Площадь общая», «Срок сдачи», «Высота потолка». Разбирать их словарём
 * надёжнее, чем ловить те же числа регуляркой по сплошному тексту: «13»
 * рядом с «Этажность» — это этажность, а то же «13» где-то в тексте может
 * оказаться чем угодно.
 *
 * Словарь общий для всех сайтов: он не знает ни про одну конкретную вёрстку
 * и работает везде, где параметры размечены парами «подпись — значение».
 */

/** Куда кладётся распознанное значение. */
type Target =
  | 'lot.areaTotal' | 'lot.areaLiving' | 'lot.areaKitchen'
  | 'lot.rooms' | 'lot.floor' | 'lot.floorsTotal' | 'lot.section'
  | 'lot.building' | 'lot.finishing' | 'lot.ceilingHeight' | 'lot.id' | 'lot.view'
  | 'complex.completion' | 'complex.segment' | 'complex.developer'
  | 'complex.floorsTotal' | 'complex.buildingsCount' | 'complex.escrow'
  | 'complex.readinessPercent' | 'complex.finishing'
  | 'price.value' | 'price.perSquareMeter'
  | 'mortgage.rate' | 'mortgage.monthlyPayment' | 'mortgage.downPaymentPercent';

interface Rule {
  target: Target;
  /** Подпись должна совпасть с одним из образцов (без учёта регистра). */
  match: RegExp;
  /** Подписи, при которых правило не применяется. */
  reject?: RegExp;
}

/**
 * Конец слова для кириллицы.
 *
 * `\b` здесь бесполезен: в JS `\w` — это только латиница, цифры и
 * подчёркивание, поэтому между «к» и «а» в «Застройщикам» границы слова нет,
 * как нет её и в конце строки после «Застройщик». Правило с `\b` после
 * русского слова не срабатывает никогда и молча не находит ничего.
 */
const EOW = '(?![а-яёa-z])';

/**
 * Порядок важен: более специфичные подписи идут раньше общих, иначе
 * «Цена за м²» перехватывается правилом «Цена».
 */
const RULES: Rule[] = [
  // ── цена ────────────────────────────────────────────────────────────────
  { target: 'price.perSquareMeter', match: /цена\s*за\s*м|стоимость\s*за\s*м|за\s*квадратн/i },
  { target: 'price.value', match: /^цена|^стоимость|полная\s*стоимость/i, reject: /за\s*м|рассрочк|за\s*квадратн/i },

  // ── ипотека ─────────────────────────────────────────────────────────────
  { target: 'mortgage.monthlyPayment', match: /платёж|платеж|ежемесячн/i },
  { target: 'mortgage.rate', match: /ставка|процентная/i },
  { target: 'mortgage.downPaymentPercent', match: /первоначальн|взнос/i },

  // ── лот ─────────────────────────────────────────────────────────────────
  { target: 'lot.areaKitchen', match: /площад[ьи]\s*кухн|кухня|кухонн/i },
  { target: 'lot.areaLiving', match: /жила[яй]\s*площад|площад[ьи]\s*жила/i },
  { target: 'lot.areaTotal', match: /площад[ьи]\s*обща|обща[яй]\s*площад|^площадь$|общая\s*пл/i },
  { target: 'lot.ceilingHeight', match: /высота\s*потолк|потолки/i },
  { target: 'lot.rooms', match: /^комнат|количество\s*комнат|комнатность/i, reject: /стоимост|цена/i },
  { target: 'lot.floor', match: new RegExp(`^этаж${EOW}`, 'i'), reject: /этажност/i },
  { target: 'lot.section', match: /секция|подъезд/i },
  { target: 'lot.id', match: /№\s*квартиры|номер\s*квартиры|артикул/i },
  { target: 'lot.building', match: new RegExp(`^(корпус|дом|строение)${EOW}`, 'i'), reject: /корпусов/i },
  { target: 'lot.view', match: /вид\s*из\s*окон|видовая/i },
  { target: 'lot.finishing', match: /отделка|ремонт/i },

  // ── комплекс ────────────────────────────────────────────────────────────
  { target: 'complex.completion', match: /срок\s*сдачи|дата\s*выдачи\s*ключ|ввод\s*в\s*эксплуатац|сдача/i },
  { target: 'complex.floorsTotal', match: /этажност/i },
  { target: 'complex.buildingsCount', match: /корпусов|количество\s*корпус|домов\s*в\s*комплекс/i },
  { target: 'complex.developer', match: new RegExp(`^(застройщик|девелопер)${EOW}`, 'i') },
  { target: 'complex.segment', match: /класс\s*жил|^класс$|сегмент/i },
  { target: 'complex.readinessPercent', match: /готовност/i },
  { target: 'complex.escrow', match: /эскроу/i },
];

/** «Сдан», «Сдано» — дом уже готов; отдельная ветка, это не дата. */
const DONE = /^сдан|^построен|^готов(о)?$/i;

/**
 * Пары из навигации, подвала и меню. Сканер честно собирает все соседние
 * короткие блоки, и в шапке сайта «Каталог застройщиков» стоит рядом
 * с «Каталог риелторов» — для словаря это выглядело бы как застройщик
 * по имени «Каталог риелторов».
 */
const NAV_LABEL = /^(каталог|все\b|список|меню|новостройки|квартиры|аренда|вторичн|войти|подобрать|помощь|сервисы|ещё)/i;
const NAV_VALUE = /^(каталог|подобрать|смотреть|перейти|показать|войти)/i;

/** «8 из 13» → {floor: 8, total: 13}; «8/13» тоже. */
function parseFloorPair(value: string): { floor?: number; total?: number } {
  const m = /(\d{1,3})\s*(?:из|\/)\s*(\d{1,3})/.exec(value);
  if (m) return { floor: Number(m[1]), total: Number(m[2]) };
  const single = parseIntSafe(value);
  return single != null ? { floor: single } : {};
}

/** «Студия» / «2» / «2-комнатная» → комнатность либо флаг студии. */
function parseRooms(value: string): { rooms?: number; isStudio?: boolean } {
  if (/студи/i.test(value)) return { isStudio: true };
  if (/своб.*планиров/i.test(value)) return {};
  const n = parseIntSafe(value);
  return n != null && n > 0 && n < 10 ? { rooms: n } : {};
}

/**
 * «4,6 млн ₽ - 16,5 млн ₽» → 4 600 000. На странице комплекса цена почти
 * всегда диапазон, и для ролика нужна нижняя граница — та самая «цена от».
 */
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

function parseRate(value: string): number | undefined {
  const m = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/.exec(value);
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n < 40 ? n : undefined;
}

export interface SpecResult {
  patch: RawCard;
  /** Что именно распозналось — печатается в CLI проверки парсера. */
  matched: { label: string; value: string; target: Target }[];
}

/**
 * Превращает пары «подпись — значение» в кусочек карточки.
 *
 * Первое совпадение по каждому полю выигрывает: на странице характеристика
 * нередко повторяется в мобильной и десктопной вёрстке, и верхнее вхождение
 * ближе к основному блоку.
 */
export function applySpecs(pairs: LabelValue[]): SpecResult {
  const complex: Record<string, unknown> = {};
  const lot: Record<string, unknown> = {};
  const price: Record<string, unknown> = {};
  const mortgage: Record<string, unknown> = {};
  const matched: SpecResult['matched'] = [];
  const taken = new Set<Target>();

  const put = (target: Target, key: string, value: unknown, pair: LabelValue): void => {
    if (value == null || value === '' || taken.has(target)) return;
    const bucket = target.startsWith('complex.')
      ? complex
      : target.startsWith('lot.')
        ? lot
        : target.startsWith('price.')
          ? price
          : mortgage;
    bucket[key] = value;
    taken.add(target);
    matched.push({ label: pair.label, value: pair.value, target });
  };

  for (const pair of pairs) {
    const label = pair.label.trim();
    const value = pair.value.trim();
    if (!label || !value || value === '—' || value === '-') continue;
    if (NAV_LABEL.test(label) || NAV_VALUE.test(value)) continue;

    for (const rule of RULES) {
      if (!rule.match.test(label)) continue;
      if (rule.reject?.test(label)) continue;

      switch (rule.target) {
        case 'price.value': {
          const parsed = parsePriceRange(value);
          if (parsed.value) {
            put('price.value', 'value', parsed.value, pair);
            if (parsed.isFrom) price.isFrom = true;
          }
          break;
        }
        case 'price.perSquareMeter':
          put('price.perSquareMeter', 'perSquareMeter', parseMoney(value), pair);
          break;
        case 'mortgage.rate':
          put('mortgage.rate', 'rate', parseRate(value), pair);
          break;
        case 'mortgage.monthlyPayment':
          put('mortgage.monthlyPayment', 'monthlyPayment', parseMoney(value), pair);
          break;
        case 'mortgage.downPaymentPercent':
          put('mortgage.downPaymentPercent', 'downPaymentPercent', parseIntSafe(value), pair);
          break;
        case 'lot.rooms': {
          const parsed = parseRooms(value);
          if (parsed.isStudio) put('lot.rooms', 'isStudio', true, pair);
          else put('lot.rooms', 'rooms', parsed.rooms, pair);
          break;
        }
        case 'lot.floor': {
          const parsed = parseFloorPair(value);
          put('lot.floor', 'floor', parsed.floor, pair);
          if (parsed.total && lot.floorsTotal == null) lot.floorsTotal = parsed.total;
          break;
        }
        case 'lot.areaTotal':
          put('lot.areaTotal', 'areaTotal', parseArea(value), pair);
          break;
        case 'lot.areaLiving':
          put('lot.areaLiving', 'areaLiving', parseArea(value), pair);
          break;
        case 'lot.areaKitchen':
          put('lot.areaKitchen', 'areaKitchen', parseArea(value), pair);
          break;
        case 'lot.ceilingHeight':
          put('lot.ceilingHeight', 'ceilingHeight', parseArea(value), pair);
          break;
        case 'lot.section':
          put('lot.section', 'section', value, pair);
          break;
        case 'lot.building':
          put('lot.building', 'building', value, pair);
          break;
        case 'lot.id':
          put('lot.id', 'id', value.replace(/^№\s*/, ''), pair);
          break;
        case 'lot.view':
          put('lot.view', 'view', value, pair);
          break;
        case 'lot.finishing':
          // Отделка на странице комплекса — свойство дома, на странице
          // лота — свойство квартиры. Пишем в обе: нормализация разберётся.
          put('lot.finishing', 'finishing', value, pair);
          if (complex.finishing == null) complex.finishing = value;
          break;
        case 'complex.completion':
          put('complex.completion', 'completion', DONE.test(value) ? 'Сдан' : value, pair);
          break;
        case 'complex.floorsTotal':
          put('complex.floorsTotal', 'floorsTotal', parseIntSafe(value), pair);
          if (lot.floorsTotal == null) lot.floorsTotal = parseIntSafe(value);
          break;
        case 'complex.buildingsCount':
          put('complex.buildingsCount', 'buildingsCount', parseIntSafe(value), pair);
          break;
        case 'complex.developer':
          put('complex.developer', 'developer', { name: value }, pair);
          break;
        case 'complex.segment':
          put('complex.segment', 'segment', value, pair);
          break;
        case 'complex.readinessPercent':
          put('complex.readinessPercent', 'readinessPercent', parseIntSafe(value), pair);
          break;
        case 'complex.escrow':
          // Назван банк эскроу — значит схема эскроу применяется.
          put('complex.escrow', 'escrow', !/нет|без/i.test(value), pair);
          break;
        default:
          break;
      }
      break; // одна подпись — одно правило
    }
  }

  // Куски заведомо частичные — карточку из них собирает mergeRaw,
  // а обязательные поля проставляет normalizeCard.
  const patch: RawCard = {};
  if (Object.keys(complex).length) patch.complex = complex as unknown as RawCard['complex'];
  if (Object.keys(lot).length) patch.lot = lot as unknown as RawCard['lot'];
  if (price.value) patch.price = { currency: 'RUB', ...price } as unknown as RawCard['price'];
  if (mortgage.rate) patch.mortgage = mortgage as unknown as RawCard['mortgage'];

  return { patch, matched };
}
