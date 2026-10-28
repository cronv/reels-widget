/**
 * Проверка поведения сценариев на неполных данных.
 *
 *   npm run sparse
 *
 * Берёт карточку и последовательно вынимает из неё поля, проверяя, что
 * ролик собирается и в кадр не попадает ничего, чего в данных нет.
 * Нужна потому, что на полной карточке все ветки выглядят одинаково
 * хорошо, а реальные выгрузки почти всегда неполные.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(path.join(ROOT, 'packages/core/dist/index.js'));

/** Строки, которых не должно быть в кадре: их нет в исходных данных. */
const INVENTED = [
  'Комфорт', 'Собственная инфраструктура', 'Специальная цена',
  'Спецпредложение', 'Отчёты каждый месяц', 'Строительство идёт', 'Новостройка',
];

const full = {
  complex: {
    name: 'ЖК «Проверка»',
    location: { city: 'Москва', street: 'Тестовая улица, 1', metro: { name: 'Тестовая', minutes: 7 } },
    developer: { name: 'ООО «Застройщик»' },
    segment: 'Бизнес',
    highlights: ['Школа во дворе', 'Паркинг'],
    completion: '2027-11-01',
    readinessPercent: 62,
    floorsTotal: 18,
    buildingsCount: 4,
    escrow: true,
  },
  lot: { rooms: 2, areaTotal: 62.4, areaKitchen: 14.8, floor: 12, floorsTotal: 18, finishing: 'White box', ceilingHeight: 3.1 },
  price: { value: 18_450_000, currency: 'RUB' },
  mortgage: { rate: 5.9 },
  promo: { title: 'Скидка 7%', discountPercent: 7, until: '2026-12-31' },
  media: [
    { kind: 'render', url: 'https://example.org/r1.jpg' },
    { kind: 'render', url: 'https://example.org/r2.jpg' },
    { kind: 'render', url: 'https://example.org/r3.jpg' },
    { kind: 'plan', url: 'https://example.org/p1.jpg' },
    { kind: 'progress', url: 'https://example.org/s1.jpg', caption: 'Август' },
  ],
  contact: { phone: '+7 495 000-00-00', site: 'example.org' },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const drop = (base, mutate) => { const c = clone(base); mutate(c); return c; };

const cases = [
  ['полные данные', full],
  ['без площади лота', drop(full, (c) => { delete c.lot.areaTotal; })],
  ['без комнатности', drop(full, (c) => { delete c.lot.rooms; })],
  ['без лота вовсе', drop(full, (c) => { delete c.lot; })],
  ['без цены', drop(full, (c) => { delete c.price; })],
  ['без преимуществ', drop(full, (c) => { c.complex.highlights = []; })],
  ['без класса', drop(full, (c) => { delete c.complex.segment; })],
  ['без срока сдачи', drop(full, (c) => { delete c.complex.completion; })],
  ['без акции и ипотеки', drop(full, (c) => { delete c.promo; delete c.mortgage; })],
  ['без планировки', drop(full, (c) => { c.media = c.media.filter((m) => m.kind !== 'plan'); })],
  ['без фото стройки', drop(full, (c) => { c.media = c.media.filter((m) => m.kind !== 'progress'); })],
  ['без изображений', drop(full, (c) => { c.media = []; })],
  ['без контактов', drop(full, (c) => { delete c.contact; })],
  ['только название', { complex: { name: 'ЖК «Минимум»', location: {} }, media: [] }],
];

/** Собирает весь текст, который попадёт в кадр. */
function textsOf(timeline) {
  const out = [];
  const walk = (items) => {
    for (const it of items ?? []) {
      if (it.text) out.push(it.text);
      if (it.items) walk(it.items);
      if (it.cells) for (const c of it.cells) out.push(c.value, c.label);
    }
  };
  for (const scene of timeline.scenes) {
    for (const layer of scene.layers) {
      if (layer.kind === 'text') out.push(layer.text);
      if (layer.kind === 'chips') out.push(...layer.items);
      if (layer.kind === 'stack') walk(layer.items);
    }
  }
  return out;
}

let failures = 0;
console.log('');

for (const [label, raw] of cases) {
  const card = core.normalizeCard(raw);
  const line = [];
  for (const id of Object.keys(core.SCENARIOS)) {
    const check = core.checkAvailability(card, id);
    if (!check.ok) { line.push(`${id}:—`); continue; }

    let timeline;
    try {
      timeline = core.buildTimeline(card, id);
    } catch (err) {
      line.push(`${id}:ОШИБКА`);
      console.log(`  ✗ ${label} / ${id}: ${err.message}`);
      failures += 1;
      continue;
    }

    const texts = textsOf(timeline);
    const bad = INVENTED.filter((w) => texts.some((t) => t.includes(w)));
    // «Новостройка» и «Бизнес» законны, если пришли в данных.
    const realSegment = raw.complex?.segment;
    const trulyBad = bad.filter((w) => w !== realSegment);

    if (trulyBad.length) {
      line.push(`${id}:ВЫДУМКА`);
      console.log(`  ✗ ${label} / ${id}: в кадре «${trulyBad.join('», «')}» — этого нет в данных`);
      failures += 1;
    } else {
      line.push(`${id}:${texts.length}`);
    }
  }
  console.log(`  ${label.padEnd(22)} ${line.join('  ')}`);
}

console.log(
  failures
    ? `\n✗ Проблем: ${failures}\n`
    : '\n✓ На всех наборах данных сценарии собираются, выдуманных значений в кадре нет\n',
);
process.exit(failures ? 1 : 0);
