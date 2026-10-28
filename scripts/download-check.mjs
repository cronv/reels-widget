/**
 * Сквозная проверка скачивания готового ролика.
 *
 *   npm run download-check
 *
 * Поднимает сервис и отдельный «сайт застройщика» на другом порту,
 * встраивает виджет, проходит весь путь до кнопки «Скачать MP4»
 * и убеждается, что файл действительно сохранился и не повреждён.
 *
 * Проверка живёт отдельно от общего прогона, потому что ломается
 * здесь не рендер, а доставка: абсолютная ссылка на файл строилась
 * из PUBLIC_URL, и при незаполненной настройке вела в никуда —
 * ролик собирался, но скачать его было нельзя.
 */

import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = Number(process.env.DL_PORT ?? 4451);
const SITE = APP + 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  — ' + extra : ''}`);
};

// PUBLIC_URL намеренно не задан: именно так выглядит забытая настройка,
// на которой ломалось скачивание.
const srv = spawn(process.execPath, [path.join(ROOT, 'packages/server/dist/index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP),
    OUTPUT_DIR: path.join(ROOT, '.output'),
    ALLOWED_ORIGINS: `http://127.0.0.1:${SITE}`,
    SCRAPE_ALLOW_PRIVATE: 'true',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><body><h1>Сайт ЖК</h1>` +
    `<script src="http://127.0.0.1:${APP}/loader.js" data-reels-widget ` +
    `data-api="http://127.0.0.1:${APP}"></script>`,
  );
});

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${APP}/health`)).ok) break; } catch { /* ждём */ }
    await wait(250);
  }
  await new Promise((r) => site.listen(SITE, r));

  console.log('\nРендер ролика');
  const asset = (n) => `http://127.0.0.1:${APP}/examples/assets/${n}`;
  const card = {
    complex: { name: 'ЖК «Проверка связи»', location: { city: 'Москва', street: 'Тестовая, 1' } },
    price: { value: 7_900_000, currency: 'RUB', isFrom: true },
    media: [1, 2, 3].map((i) => ({ kind: 'render', url: asset(`render-${i}.jpg`) })),
  };
  const started = await fetch(`http://127.0.0.1:${APP}/api/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card, scenario: 'complex-overview' }),
  }).then((r) => r.json());

  let result = null;
  for (let i = 0; i < 400; i++) {
    const { job } = await fetch(`http://127.0.0.1:${APP}/api/jobs/${started.job.id}`).then((r) => r.json());
    if (job.status === 'done') { result = job.result; break; }
    if (job.status === 'error') throw new Error(job.error);
    await wait(700);
  }
  check('ролик собран', Boolean(result), result ? `${result.seconds} с` : '');
  if (!result) throw new Error('рендер не завершился');

  check('путь относительный', result.videoPath?.startsWith('/files/'), result.videoPath);
  check('имя читаемое', /[А-Яа-я]/.test(result.downloadName ?? ''), result.downloadName);

  console.log('\nОтдача файла');
  const head = await fetch(
    `http://127.0.0.1:${APP}${result.videoPath}?download=${encodeURIComponent(result.downloadName)}`,
    { method: 'HEAD' },
  );
  check('файл доступен', head.ok, `код ${head.status}`);
  const disp = head.headers.get('content-disposition') ?? '';
  check('отдаётся как вложение', disp.startsWith('attachment'), disp.slice(0, 60));
  check('имя в UTF-8', disp.includes("filename*=UTF-8''"));

  console.log('\nСкачивание из встроенного виджета');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  await page.goto(`http://127.0.0.1:${SITE}/`, { waitUntil: 'domcontentloaded' });
  await wait(900);
  await page.evaluate(() =>
    document.getElementById('reels-widget-host').shadowRoot.querySelector('.launcher').click());
  await wait(2000);

  const frame = page.frames().find((f) => f.url().includes('/embed/widget.html'));
  check('виджет открылся', Boolean(frame));

  if (frame) {
    // Подставляем готовый результат в интерфейс: проверяется доставка
    // файла, а не повторный рендер, который уже проверен выше.
    await frame.evaluate((r) => window.__showDone(r), result);
    await frame.waitForSelector('#done a.btn', { timeout: 10_000 });

    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
    await frame.click('#done a.btn');
    const download = await downloadPromise;

    check('браузер начал скачивание', Boolean(download));
    if (download) {
      const saved = await download.path();
      const size = saved ? fs.statSync(saved).size : 0;
      check('файл сохранён целиком', size > 100_000, `${(size / 1048576).toFixed(2)} МБ`);
      // Имя сохранённого файла здесь намеренно не проверяется:
      // headless-браузер не применяет Content-Disposition к имени и
      // всегда отдаёт «download», тогда как обычный Chrome берёт имя
      // из заголовка. Корректность заголовка проверена выше — именно
      // он и определяет имя у пользователя.
    }
  }

  await browser.close();
} finally {
  srv.kill('SIGTERM');
  await wait(300);
  srv.kill('SIGKILL');
  site.close();
}

console.log(failures ? `\n✗ Проблем: ${failures}\n` : '\n✓ Скачивание работает\n');
process.exit(failures ? 1 : 0);
