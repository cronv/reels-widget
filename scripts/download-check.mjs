/**
 * Сквозная проверка: от пароля до сохранённого файла.
 *
 *   npm run download-check
 *
 * Поднимает сервис и отдельный «сайт застройщика» на другом порту,
 * встраивает виджет и проходит весь путь руками браузера: вход по
 * паролю, ввод объекта, выбор сценария, экспорт, ожидание рендера,
 * нажатие «Скачать MP4» — и проверяет, что файл сохранился целиком.
 *
 * Пароль здесь включён намеренно. Раньше проверка работала с открытым
 * API, и из-за этого пропустила поломку, которая ломала весь экспорт
 * в рабочей установке: опрос задачи ходил без токена, получал 401 и
 * молча замолкал. Ролик собирался, но виджет об этом не узнавал и
 * навсегда оставался в состоянии «Ставлю в очередь…». Проверка, не
 * повторяющая боевые настройки, такую поломку увидеть не может.
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
const PASSWORD = 'проверка-пароля';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  — ' + extra : ''}`);
};

// PUBLIC_URL намеренно не задан: именно так выглядит забытая настройка,
// на которой когда-то ломалось скачивание.
const srv = spawn(process.execPath, [path.join(ROOT, 'packages/server/dist/index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP),
    OUTPUT_DIR: path.join(ROOT, '.output'),
    ALLOWED_ORIGINS: `http://127.0.0.1:${SITE}`,
    ACCESS_PASSWORD: PASSWORD,
    AUTH_SECRET: 'proverka-sekreta-dlya-testa-0123456789',
    SCRAPE_ALLOW_PRIVATE: 'true',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Сайт ЖК</title><body><h1>Сайт ЖК</h1>` +
    `<script src="http://127.0.0.1:${APP}/loader.js" data-reels-widget ` +
    `data-autoparse="false" data-api="http://127.0.0.1:${APP}"></script>`,
  );
});

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${APP}/health`)).ok) break; } catch { /* ждём */ }
    await wait(250);
  }
  await new Promise((r) => site.listen(SITE, r));

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  console.log('\nОткрываю виджет на сайте');
  await page.goto(`http://127.0.0.1:${SITE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('reels-widget-host')?.shadowRoot?.querySelector('.launcher'),
    null, { timeout: 10_000 },
  );
  await page.evaluate(() =>
    document.getElementById('reels-widget-host').shadowRoot.querySelector('.launcher').click());

  await page.waitForFunction(
    () => document.getElementById('reels-widget-host')?.hasAttribute('data-reels-ready'),
    null, { timeout: 15_000 },
  );
  const frame = page.frames().find((f) => f.url().includes('/embed/widget.html'));
  check('виджет открылся', Boolean(frame));
  if (!frame) throw new Error('фрейм виджета не загрузился');

  console.log('\nВход по паролю');
  await frame.waitForSelector('#gate:not([hidden])', { timeout: 10_000 });
  await frame.fill('#gate-password', PASSWORD);
  await frame.click('#gate-submit');
  await frame.waitForSelector('#app:not([hidden])', { timeout: 10_000 });
  check('пароль принят, интерфейс открыт', true);

  console.log('\nВвод объекта');
  const asset = (n) => `http://127.0.0.1:${APP}/examples/assets/${n}`;
  await frame.click('#tab-manual');
  await frame.fill('#m-name', 'ЖК «Проверка связи»');
  await frame.fill('#m-city', 'Москва');
  await frame.fill('#m-street', 'Тестовая, 1');
  await frame.fill('#m-price', '7 900 000');
  await frame.fill('#m-renders', [1, 2, 3].map((i) => asset(`render-${i}.jpg`)).join('\n'));
  await frame.click('#manual-form button[type="submit"]');

  // Сценарий выбирается сам, как только карточка разобрана.
  await frame.waitForSelector('#export:not([disabled])', { timeout: 20_000 });
  check('объект разобран, сценарий выбран', true);

  console.log('\nЭкспорт');
  await frame.click('#export');

  // Здесь и пряталась поломка: опрос задачи шёл без токена, статус
  // никогда не менялся, и ссылка на файл не появлялась вовсе.
  const progressed = await frame
    .waitForFunction(
      () => /Рендер|В очереди/.test(document.getElementById('status')?.textContent ?? ''),
      null, { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false);
  check('статус задачи обновляется', progressed,
    await frame.evaluate(() => document.getElementById('status')?.textContent ?? ''));

  const link = await frame
    .waitForSelector('#done a.btn', { timeout: 360_000 })
    .catch(() => null);
  check('ссылка на готовый файл появилась', Boolean(link),
    await frame.evaluate(() => document.getElementById('status')?.textContent ?? ''));
  if (!link) throw new Error('рендер не довёл до ссылки');

  const href = await link.getAttribute('href');
  check('ссылка ведёт на сервис', href.startsWith(`http://127.0.0.1:${APP}/files/`), href.slice(0, 70));

  console.log('\nОтдача файла');
  const head = await fetch(href, { method: 'HEAD' });
  check('файл доступен', head.ok, `код ${head.status}`);
  const disp = head.headers.get('content-disposition') ?? '';
  check('отдаётся как вложение', disp.startsWith('attachment'), disp.slice(0, 60));
  check('имя в UTF-8', disp.includes("filename*=UTF-8''"));

  console.log('\nСкачивание');
  const downloadPromise = page.waitForEvent('download', { timeout: 20_000 }).catch(() => null);
  await link.click();
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

  await browser.close();
} finally {
  srv.kill('SIGTERM');
  await wait(300);
  srv.kill('SIGKILL');
  site.close();
}

console.log(failures ? `\n✗ Проблем: ${failures}\n` : '\n✓ Экспорт и скачивание работают\n');
process.exit(failures ? 1 : 0);
