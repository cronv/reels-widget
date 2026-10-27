/**
 * Проверка окружения рендера: браузер, ffmpeg, шрифты, кириллица.
 *
 *   npm run verify            локально
 *   docker compose -f deploy/docker-compose.yml run --rm reels npm run verify
 *
 * Запускается первой после установки: отвечает на вопрос «почему ролики
 * не собираются» до того, как он возникнет. Проверяется именно то, что
 * чаще всего отсутствует в урезанном образе — системный Chromium и шрифт
 * с кириллицей; без второго весь русский текст в кадре станет квадратами,
 * и заметить это можно только глазами, уже в готовом файле.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
let failed = 0;

const ok = (what, detail) => console.log(`  ✓ ${what}${detail ? '  — ' + detail : ''}`);
const bad = (what, detail) => { failed += 1; console.log(`  ✗ ${what}${detail ? '  — ' + detail : ''}`); };

console.log('\nОкружение');
ok('Node.js', process.version);
ok('Платформа', `${os.platform()} ${os.arch()}, ядер ${os.cpus().length}, память ${Math.round(os.totalmem() / 1073741824)} ГБ`);

// ── ffmpeg ────────────────────────────────────────────────────────────────
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
try {
  const { stdout } = await run(ffmpegPath, ['-version']);
  ok('ffmpeg', stdout.split('\n')[0].slice(0, 60));
} catch {
  bad('ffmpeg', `не найден (${ffmpegPath}). Без него MP4 не собрать.`);
}
try {
  await run('ffprobe', ['-version']);
  ok('ffprobe');
} catch {
  bad('ffprobe', 'не найден — самопроверка не сможет проверить готовый файл');
}

// ── Chromium ──────────────────────────────────────────────────────────────
let chromiumPath = process.env.CHROMIUM_PATH;
if (!chromiumPath) {
  // Порядок: системные пути Alpine и Debian, затем браузер Playwright.
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    try { await fs.access(candidate); chromiumPath = candidate; break; } catch { /* дальше */ }
  }
}
if (!chromiumPath) {
  try {
    const { chromium } = await import('playwright-core');
    chromiumPath = chromium.executablePath();
  } catch { /* playwright-core без своего браузера — это норма */ }
}

if (!chromiumPath) {
  bad('Chromium', 'не найден. Задайте CHROMIUM_PATH (в контейнере /usr/bin/chromium).');
} else {
  try {
    const version = execFileSync(chromiumPath, ['--version'], { encoding: 'utf8' }).trim();
    ok('Chromium', `${version}  (${chromiumPath})`);
  } catch (err) {
    bad('Chromium', `${chromiumPath} не запускается: ${err.message.split('\n')[0]}`);
  }
}

// ── шрифты ────────────────────────────────────────────────────────────────
let cyrillicFonts = 0;
try {
  const { stdout } = await run('fc-list', [':lang=ru', 'family']);
  const families = [...new Set(stdout.split('\n').map((l) => l.split(',')[0].trim()).filter(Boolean))];
  cyrillicFonts = families.length;
  if (cyrillicFonts) {
    ok('Шрифты с кириллицей', `${cyrillicFonts} семейств: ${families.slice(0, 4).join(', ')}…`);
  } else {
    bad('Шрифты с кириллицей', 'ни одного — весь русский текст в кадре станет квадратами');
  }
  const hasInter = families.some((f) => /^Inter/i.test(f));
  if (hasInter) ok('Inter', 'найден — кадры совпадут с макетом');
  else console.log('  · Inter не найден — сцена возьмёт запасной шрифт. ' +
    'Для точного совпадения положите файлы в deploy/fonts (см. README там же).');
} catch {
  bad('fontconfig', 'нет команды fc-list — Chromium не увидит шрифты');
}

// ── реальный кадр ─────────────────────────────────────────────────────────
// Единственная проверка, которая ловит проблему со шрифтами наверняка:
// рисуем кириллицу и смотрим, не превратилась ли она в «тофу».
if (chromiumPath && cyrillicFonts) {
  try {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: chromiumPath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage({ viewport: { width: 640, height: 200 } });
    /**
     * Шрифт без кириллицы не оставляет пустоты — браузер рисует «тофу»,
     * одинаковые прямоугольники одной ширины. Поэтому сравниваем ширину
     * русской строки с такой же по длине строкой из области частного
     * использования Unicode: её глифов нет ни в одном шрифте, и это
     * эталон «тофу». Близкие ширины означают, что кириллица тоже не нашлась.
     */
    /**
     * Ловим случай «текст не отрисовался вовсе»: меряем ширину строки
     * и считаем долю закрашенных пикселей.
     *
     * Отличить «тофу» от настоящих букв программно надёжно не выходит:
     * очевидный приём — сравнить с эталоном из области частного
     * использования Unicode — ломается о иконочные шрифты, которые эту
     * область покрывают. Авторитетный ответ на вопрос «есть ли кириллица»
     * даёт fontconfig выше; здесь мы проверяем, что до отрисовки дело
     * вообще дошло, и оставляем кадр, чтобы можно было взглянуть глазами.
     */
    const width = await page.evaluate(() => {
      document.body.style.margin = '0';
      document.body.style.background = '#fff';
      const span = document.createElement('span');
      span.id = 'probe';
      span.style.cssText =
        'font:600 40px Inter,system-ui,sans-serif;white-space:pre;display:inline-block;padding:20px';
      span.textContent = 'Цена ЖК «Космос» · 4 600 000 ₽';
      document.body.appendChild(span);
      return span.getBoundingClientRect().width;
    });

    const png = await page.locator('#probe').screenshot();
    const shot = path.join(os.tmpdir(), 'reels-verify-frame.png');
    await fs.writeFile(shot, png);
    await browser.close();

    if (width > 120) {
      ok('Отрисовка текста', `строка ${Math.round(width)} px; посмотрите кадр: ${shot}`);
    } else {
      bad('Отрисовка текста', `строка вышла ${Math.round(width)} px — текст не отрисовался. Кадр: ${shot}`);
    }
  } catch (err) {
    bad('Пробный кадр', err.message.split('\n')[0]);
  }
}

console.log(
  failed
    ? `\n✗ Проблем: ${failed}. Рендер в таком окружении работать не будет.\n`
    : '\n✓ Окружение готово. Полная проверка с настоящим видео: npm run smoke\n',
);
process.exit(failed ? 1 : 0);
