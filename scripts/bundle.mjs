/**
 * Собирает архив для выкладки на сервер.
 *
 *   npm run bundle
 *
 * В архив кладётся исходный код вместе с уже скомпилированным `dist`:
 * на сервере ставятся только рабочие зависимости (`npm ci --omit=dev`),
 * а компилятор туда не попадает, и собирать там было бы нечем.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });

console.log('→ Собираю проект');
run('npm', ['run', 'build']);

const compiled = await fs
  .stat(path.join(ROOT, 'packages/server/dist/index.js'))
  .then(() => true)
  .catch(() => false);
if (!compiled) {
  console.error('✗ Сборка не создала packages/server/dist — архив был бы нерабочим.');
  process.exit(1);
}

await fs.mkdir(DIST, { recursive: true });

/**
 * В имени есть и час с минутами, а не только дата.
 *
 * За день архив пересобирается не раз, и два файла с одинаковым именем
 * уже приводили к вопросу «какой из них верный?». Со временем в имени
 * свежий виден сразу, и старый не затирается молча.
 */
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const name = `reels-widget-${stamp}.tar.gz`;
const out = path.join(DIST, name);

console.log('→ Упаковываю');
run('tar', [
  '-czf', out,
  '--transform', `s,^\\.,reels-widget,`,
  '--exclude', './node_modules',
  '--exclude', './.output',
  '--exclude', './dist',
  '--exclude', './.git',
  '--exclude', './.env',
  '--exclude', './examples/fixtures',
  '--exclude', '*.tsbuildinfo',
  '-C', ROOT, '.',
]);

const { size } = await fs.stat(out);

// Готовый тег для вставки в шаблон сайта — чтобы не собирать его руками.
const snippet = `<!-- Виджет рилсов: вставить перед </body> -->
<script src="https://reels.ВАШДОМЕН.ru/loader.js" data-reels-widget></script>
`;
await fs.writeFile(path.join(DIST, 'snippet.html'), snippet, 'utf8');

console.log(`\n✓ ${path.relative(ROOT, out)}  (${(size / 1024 / 1024).toFixed(1)} МБ)`);
console.log(`✓ ${path.relative(ROOT, path.join(DIST, 'snippet.html'))}`);
console.log('\nДальше, на сервере:');
console.log('  tar -xzf <архив> --strip-components=1 -C /opt/reels-widget');
console.log('  cp deploy/.env.production.example .env && nano .env');
console.log('  docker compose -f deploy/docker-compose.yml up -d --build');
console.log('\nПодробности — deploy/README.md');
