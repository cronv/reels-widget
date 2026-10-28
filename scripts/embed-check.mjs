/**
 * Проверка встраивания виджета на чужой домен.
 *
 *   npm run embed-check
 *
 * Это самое хрупкое место всей установки: браузер отказывается
 * показывать iframe молча — ни ошибки на странице, ни события, окно
 * просто остаётся белым. Ошибиться можно в трёх местах сразу (список
 * доменов, заголовок от nginx, адрес сервиса), а симптом один на всех.
 *
 * Поэтому здесь поднимается настоящий «сайт застройщика» на отдельном
 * домене и проверяется то, что видит пользователь: открылся виджет или
 * нет, и если нет — называет ли сообщение настоящую причину.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = Number(process.env.EMBED_PORT ?? 4461);
const SITE = APP + 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Поддомены *.localhost браузер и резолвер отправляют на петлю, поэтому
// на одной машине можно проверить и точное совпадение, и шаблон.
const ALLOWED = `http://site.localhost:${SITE}`;
const WILDCARD = `http://*.partner.localhost:${SITE}`;

let failures = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  — ' + extra : ''}`);
};

const srv = spawn(process.execPath, [path.join(ROOT, 'packages/server/dist/index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP),
    OUTPUT_DIR: path.join(ROOT, '.output'),
    PUBLIC_URL: `http://127.0.0.1:${APP}`,
    ALLOWED_ORIGINS: `${ALLOWED},${WILDCARD}`,
    SCRAPE_ALLOW_PRIVATE: 'true',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

// Один сайт на три имени: различается только Origin, который видит сервис.
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Сайт ЖК</title><body><h1>Сайт ЖК</h1>` +
    `<script src="http://127.0.0.1:${APP}/loader.js" data-reels-widget ` +
    `data-api="http://127.0.0.1:${APP}"></script>`,
  );
});

/** Открывает окно виджета на указанном домене и ждёт развязки. */
async function openOn(browser, host) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(`http://${host}:${SITE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('reels-widget-host')?.shadowRoot?.querySelector('.launcher'),
    null, { timeout: 10_000 },
  );
  await page.evaluate(() =>
    document.getElementById('reels-widget-host').shadowRoot.querySelector('.launcher').click());

  /**
   * Фрейм отдан с другого домена, и заглянуть в него со страницы
   * нельзя — заблокированный и просто чужой выглядят одинаково.
   * Поэтому признак берётся оттуда же, откуда его берёт загрузчик:
   * фрейм прислал сообщение, загрузчик пометил это на host-элементе.
   */
  const loaded = await page
    .waitForFunction(
      () => document.getElementById('reels-widget-host')?.hasAttribute('data-reels-ready'),
      null, { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);

  // Загрузчик ждёт шесть секунд, прежде чем признать фрейм мёртвым,
  // и ещё раз — пока сервис ответит, в чём дело.
  let notice = '';
  if (!loaded) {
    await page.waitForFunction(
      () => {
        const n = document.getElementById('reels-widget-host')?.shadowRoot?.querySelector('.notice');
        return n && !n.hidden && !/выясняю причину/.test(n.textContent);
      },
      null, { timeout: 15_000 },
    ).catch(() => undefined);
    notice = await page.evaluate(() => {
      const n = document.getElementById('reels-widget-host')?.shadowRoot?.querySelector('.notice');
      return n && !n.hidden ? n.textContent.trim() : '';
    });
  }

  await page.close();
  return { loaded, notice };
}

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${APP}/health`)).ok) break; } catch { /* ждём */ }
    await wait(250);
  }
  await new Promise((r) => site.listen(SITE, '0.0.0.0', r));

  console.log('\nРешение сервиса по доменам');
  const verdict = async (origin) => {
    const d = await fetch(`http://127.0.0.1:${APP}/api/embed/check?origin=${encodeURIComponent(origin)}`)
      .then((r) => r.json());
    return d.allowed;
  };
  check('точный домен разрешён', (await verdict(ALLOWED)) === true, ALLOWED);
  check('поддомен по шаблону разрешён',
    (await verdict(`http://a.partner.localhost:${SITE}`)) === true);
  check('чужой домен отклонён', (await verdict('https://evil.ru')) === false);
  check('подделка суффиксом отклонена',
    (await verdict(`http://site.localhost.evil.ru:${SITE}`)) === false,
    'site.localhost.evil.ru');
  check('шаблон не покрывает сам домен',
    (await verdict(`http://partner.localhost:${SITE}`)) === false);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox', `--host-resolver-rules=MAP *.localhost 127.0.0.1`],
  });

  console.log('\nРазрешённый домен');
  const good = await openOn(browser, 'site.localhost');
  check('виджет открылся', good.loaded, good.notice.slice(0, 80));

  console.log('\nПоддомен по шаблону');
  const sub = await openOn(browser, 'a.partner.localhost');
  check('виджет открылся', sub.loaded, sub.notice.slice(0, 80));

  console.log('\nДомен не в списке');
  const bad = await openOn(browser, 'stranger.localhost');
  check('виджет не открылся', !bad.loaded);
  check('названа настоящая причина', /не разрешено показывать виджет/.test(bad.notice));
  check('перечислен текущий список', /ALLOWED_ORIGINS/.test(bad.notice));
  if (bad.notice) console.log('    «' + bad.notice.slice(0, 150) + '…»');

  await browser.close();
} finally {
  srv.kill('SIGTERM');
  await wait(300);
  srv.kill('SIGKILL');
  site.close();
}

console.log(failures ? `\n✗ Проблем: ${failures}\n` : '\n✓ Встраивание работает\n');
process.exit(failures ? 1 : 0);
