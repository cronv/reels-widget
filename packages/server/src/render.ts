import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import type { Timeline } from '@reels/core';
import { config } from './config.js';

/**
 * Экспорт таймлайна в MP4.
 *
 * Схема: headless Chromium открывает ту же сцену, что и превью, и
 * перематывается покадрово; каждый кадр скриншотится и уходит в stdin ffmpeg.
 * Промежуточных файлов нет — 450 PNG на диск не пишутся.
 *
 * Почему покадровая перемотка, а не запись экрана: запись зависит от того,
 * успел ли браузер отрисовать кадр вовремя, и на загруженном сервере даёт
 * рывки. Перемотка по номеру кадра идёт ровно столько, сколько идёт, а на
 * выходе всегда честные 30 fps.
 */

let browserPromise: Promise<Browser> | null = null;

/**
 * Запускает браузер.
 *
 * Используется `playwright-core`, а не `playwright`: нужен только протокол
 * управления, браузер берётся системный. Для Alpine это единственный рабочий
 * путь — у Playwright нет сборок Chromium под musl, зато в Alpine есть
 * собственный пакет `chromium`, и его достаточно передать в `executablePath`.
 * Попутно из зависимостей уходит ~450 МБ загружаемого браузера.
 */
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright-core');
      try {
        return await chromium.launch({
          executablePath: config.render.chromiumPath,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--force-device-scale-factor=1',
            '--hide-scrollbars',
            '--disable-lcd-text',
            // Шрифты и цвета должны совпадать с превью, поэтому
            // никаких экспериментальных растеризаторов.
            '--font-render-hinting=none',
          ],
        });
      } catch (err) {
        // Без своего браузера playwright-core не умеет ничего, и штатная
        // ошибка про «executable doesn't exist» не подсказывает, что делать.
        browserPromise = null;
        const where = config.render.chromiumPath ?? '(путь не задан)';
        throw new Error(
          `Не удалось запустить Chromium по пути ${where}. ` +
            'Укажите CHROMIUM_PATH: в контейнере это /usr/bin/chromium, ' +
            'при локальной разработке — путь из «npx playwright install chromium». ' +
            `Исходная ошибка: ${(err as Error).message}`,
        );
      }
    })();
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close().catch(() => undefined);
}

export interface RenderOptions {
  timeline: Timeline;
  /** Абсолютный URL stage.html, доступный браузеру. */
  stageUrl: string;
  outPath: string;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  outPath: string;
  frames: number;
  bytes: number;
  durationMs: number;
  assets: { total: number; failed: number };
}

function startFfmpeg(outPath: string, fps: number): ReturnType<typeof spawn> {
  // anullsrc добавляет тихую звуковую дорожку: часть площадок отклоняет
  // или плохо обрабатывает видео вообще без аудио.
  const args = [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-i', 'pipe:0',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(config.render.crf),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.1',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    outPath,
  ];
  return spawn(config.render.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
}

/**
 * Пишет буфер в поток, уважая backpressure.
 *
 * Оба слушателя снимаются вручную: на 450 кадрах `once('error')`, который
 * так и не сработал, накапливается в сотни подписок и Node начинает ругаться
 * на утечку.
 */
function write(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.write(chunk)) {
      resolve();
      return;
    }
    const onDrain = (): void => {
      stream.removeListener('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      stream.removeListener('drain', onDrain);
      reject(err);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

export async function renderTimeline(opts: RenderOptions): Promise<RenderResult> {
  const { timeline, stageUrl, outPath } = opts;
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: timeline.width, height: timeline.height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    locale: 'ru-RU',
  });

  let page: Page | null = null;
  const ffmpeg = startFfmpeg(outPath, timeline.fps);
  let ffmpegErr = '';
  ffmpeg.stderr?.on('data', (d: Buffer) => {
    ffmpegErr += d.toString();
    if (ffmpegErr.length > 8000) ffmpegErr = ffmpegErr.slice(-8000);
  });

  const ffmpegDone = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg завершился с кодом ${code}:\n${ffmpegErr.slice(-1500)}`));
    });
  });

  try {
    page = await context.newPage();
    page.on('pageerror', (err) => {
      throw new Error(`Ошибка в сцене: ${err.message}`);
    });

    await page.goto(stageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction('typeof window.__mount === "function"', null, { timeout: 15_000 });

    const total: number = await page.evaluate(
      (tl) => (window as unknown as { __mount: (t: unknown) => number }).__mount(tl),
      timeline as unknown,
    );

    const assets = await page.evaluate(
      () => (window as unknown as { __waitAssets: (ms: number) => Promise<{ total: number; failed: number }> })
        .__waitAssets(20_000),
    );

    const stdin = ffmpeg.stdin;
    if (!stdin) throw new Error('Не удалось открыть stdin ffmpeg.');

    for (let frame = 0; frame < total; frame += 1) {
      if (opts.signal?.aborted) throw new Error('Рендер отменён.');
      await page.evaluate((f) => (window as unknown as { __seek: (n: number) => void }).__seek(f), frame);
      const shot = await page.screenshot({ type: 'png', animations: 'disabled' });
      await write(stdin, shot);
      opts.onProgress?.(frame + 1, total);
    }

    stdin.end();
    await ffmpegDone;

    const stat = await fs.stat(outPath);
    return {
      outPath,
      frames: total,
      bytes: stat.size,
      durationMs: Date.now() - startedAt,
      assets,
    };
  } catch (err) {
    ffmpeg.stdin?.destroy();
    ffmpeg.kill('SIGKILL');
    await fs.rm(outPath, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    await page?.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

/**
 * Обложка для поста: один кадр из середины первой сцены, где текст уже
 * проявился, но смены кадра ещё не было.
 */
export async function renderPoster(opts: {
  timeline: Timeline;
  stageUrl: string;
  outPath: string;
  frame?: number;
}): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: opts.timeline.width, height: opts.timeline.height },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
  });
  try {
    const page = await context.newPage();
    await page.goto(opts.stageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction('typeof window.__mount === "function"', null, { timeout: 15_000 });
    await page.evaluate((tl) => (window as unknown as { __mount: (t: unknown) => number }).__mount(tl), opts.timeline as unknown);
    await page.evaluate(() => (window as unknown as { __waitAssets: (ms: number) => Promise<unknown> }).__waitAssets(20_000));
    const first = opts.timeline.scenes[0];
    const frame = opts.frame ?? Math.round((first?.duration ?? 60) * 0.8);
    await page.evaluate((f) => (window as unknown as { __seek: (n: number) => void }).__seek(f), frame);
    await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
    await page.screenshot({ path: opts.outPath, type: 'jpeg', quality: 88, animations: 'disabled' });
    return opts.outPath;
  } finally {
    await context.close().catch(() => undefined);
  }
}
