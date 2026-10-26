/**
 * Проверка парсера на сохранённой странице, без сети и без сервера.
 *
 *   npm run parse -- examples/fixtures/lot.html https://zhk-kosmos.alphasuper-baza.ru/flats/flat/1115
 *   npm run parse -- page.html <url> --pairs      показать все найденные пары
 *   npm run parse -- page.html <url> --json       выдать карточку как JSON
 *
 * Второй аргумент — адрес, с которого страница была сохранена. Он нужен
 * не для красоты: по нему достраиваются относительные ссылки на картинки
 * и срабатывает определение профиля сайта.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(path.join(ROOT, 'packages/core/dist/index.js'));

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [file, url] = args.filter((a) => !a.startsWith('--'));

if (!file) {
  console.error('Укажите HTML-файл: npm run parse -- <файл.html> [url] [--pairs] [--json]');
  process.exit(1);
}

const pageUrl = url ?? 'https://example.com/';
const html = await fs.readFile(path.resolve(ROOT, file), 'utf8');

const report = core.parseListing(html, pageUrl);
const card = core.normalizeCard(report.raw);

if (flags.has('--json')) {
  console.log(JSON.stringify(card, null, 2));
  process.exit(0);
}

const dash = (v) => (v == null || v === '' ? '—' : v);
const line = (label, value) => console.log(`  ${label.padEnd(22)} ${dash(value)}`);

console.log(`\nФайл:    ${file}  (${Math.round(html.length / 1024)} КБ)`);
console.log(`Адрес:   ${pageUrl}`);
console.log(`Профиль: ${report.profile ? `${report.profile.label} [${report.profile.id}]` : 'не определён — только универсальный разбор'}`);
console.log(`Пар «подпись — значение» в разметке: ${report.pairsFound}, распознано словарём: ${report.matchedSpecs.length}`);

console.log('\nКОМПЛЕКС');
line('Название', card.complex.name);
line('Город', card.complex.location.city);
line('Улица', card.complex.location.street ?? card.complex.location.raw);
line('Метро', card.complex.location.metro?.name);
line('Застройщик', card.complex.developer?.name);
line('Класс', card.complex.segment);
line('Срок сдачи', card.complex.completion);
line('Этажность', card.complex.floorsTotal);
line('Корпусов', card.complex.buildingsCount);
line('Эскроу', card.complex.escrow == null ? undefined : card.complex.escrow ? 'да' : 'нет');
line('Преимущества', card.complex.highlights?.join(' · '));

if (card.lot && Object.keys(card.lot).length) {
  console.log('\nЛОТ');
  line('Номер', card.lot.id);
  line('Комнат', card.lot.isStudio ? 'студия' : card.lot.rooms);
  line('Площадь', card.lot.areaTotal);
  line('Кухня', card.lot.areaKitchen);
  line('Этаж', card.lot.floor ? `${card.lot.floor}${card.lot.floorsTotal ? ` из ${card.lot.floorsTotal}` : ''}` : undefined);
  line('Секция', card.lot.section);
  line('Корпус', card.lot.building);
  line('Отделка', card.lot.finishing);
  line('Потолки', card.lot.ceilingHeight);
}

console.log('\nЦЕНА');
line('Значение', card.price ? `${card.price.value.toLocaleString('ru-RU')} ₽${card.price.isFrom ? ' (от)' : ''}` : undefined);
line('За м²', card.price?.perSquareMeter?.toLocaleString('ru-RU'));
line('Ставка', card.mortgage?.rate);
line('Платёж', card.mortgage?.monthlyPayment?.toLocaleString('ru-RU'));

console.log('\nКОНТАКТЫ');
line('Телефон', card.contact?.phone);
line('Сайт', card.contact?.site);

console.log('\nМЕДИА');
const byKind = {};
for (const m of card.media) (byKind[m.kind] ??= []).push(m.url);
for (const [kind, urls] of Object.entries(byKind)) {
  console.log(`  ${kind.padEnd(10)} ${urls.length}`);
  for (const u of urls.slice(0, 3)) console.log(`     ${u.length > 96 ? u.slice(0, 93) + '…' : u}`);
  if (urls.length > 3) console.log(`     … ещё ${urls.length - 3}`);
}
if (!card.media.length) console.log('  — ни одного изображения');

console.log('\nСЦЕНАРИИ');
for (const id of Object.keys(core.SCENARIOS)) {
  const meta = core.SCENARIOS[id];
  const check = core.checkAvailability(card, id);
  const mark = check.ok ? '✓' : '×';
  const why = check.ok ? '' : `  — нет: ${check.missing.map((f) => core.FIELD_LABELS[f] ?? f).join(', ')}`;
  console.log(`  ${mark} ${meta.title.padEnd(22)} ${meta.seconds} с${why}`);
}

if (card.missing.length) {
  console.log('\nНЕ НАЙДЕНО');
  console.log('  ' + card.missing.map((f) => core.FIELD_LABELS[f] ?? f).join(', '));
}

if (flags.has('--pairs')) {
  console.log('\nРАСПОЗНАНО СЛОВАРЁМ');
  for (const m of report.matchedSpecs) {
    console.log(`  ${m.target.padEnd(26)} ${m.label} → ${m.value}`);
  }
  const scan = core.scanHtml(html);
  console.log('\nВСЕ ПАРЫ В РАЗМЕТКЕ (первые 60)');
  for (const p of scan.pairs.slice(0, 60)) {
    console.log(`  [${p.from.padEnd(8)}] ${p.label} → ${p.value.slice(0, 60)}`);
  }
}

console.log('');
