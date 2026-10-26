import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** packages/server/dist → корень репозитория. */
export const ROOT = path.resolve(here, '../../..');

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: int('PORT', 4000),
  host: process.env.HOST ?? '0.0.0.0',

  /** Публичный адрес сервера — попадает в ссылки на готовые MP4. */
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${int('PORT', 4000)}`).replace(/\/$/, ''),

  /**
   * Сайты, которым разрешено встраивать виджет. Пустой список = любой.
   * В проде заполните: виджет умеет ходить по чужим URL, и ограничение
   * происхождения — первый барьер от использования как открытого прокси.
   */
  allowedOrigins: list('ALLOWED_ORIGINS'),

  paths: {
    stage: path.join(ROOT, 'packages/stage'),
    embed: path.join(ROOT, 'packages/embed'),
    examples: path.join(ROOT, 'examples'),
    output: process.env.OUTPUT_DIR ?? path.join(ROOT, '.output'),
  },

  render: {
    /** Параллельных рендеров. Каждый держит вкладку Chromium. */
    concurrency: int('RENDER_CONCURRENCY', 2),
    /** Сколько готовых роликов хранить, прежде чем удалять старые. */
    keepFiles: int('RENDER_KEEP_FILES', 200),
    /** Потолок на один рендер, мс. */
    timeoutMs: int('RENDER_TIMEOUT_MS', 240_000),
    crf: int('RENDER_CRF', 20),
    /** Путь к бинарю Chromium, если не хотите полагаться на playwright-ский. */
    chromiumPath: process.env.CHROMIUM_PATH || undefined,
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  },

  scrape: {
    timeoutMs: int('SCRAPE_TIMEOUT_MS', 15_000),
    respectRobots: process.env.SCRAPE_RESPECT_ROBOTS !== 'false',
    /**
     * Если список непустой, парсить можно только эти домены.
     * Рекомендуется включить: иначе эндпоинт /api/extract превращается
     * в анонимный загрузчик произвольных URL.
     */
    allowedHosts: list('SCRAPE_ALLOWED_HOSTS'),
    /**
     * Собственные домены, для которых проверка robots.txt пропускается.
     *
     * Это не выключатель проверки, а явный список: сайты застройщика часто
     * закрыты `Disallow: /` целиком — так ставят staging и так остаётся
     * после запуска. Для чужих доменов проверка продолжает работать.
     * Вносите сюда только то, чем владеете.
     */
    trustedHosts: list('SCRAPE_TRUSTED_HOSTS'),
    /**
     * Разрешить разбор localhost и адресов внутренней сети.
     *
     * Только для локальной разработки: так можно натравить виджет на
     * сохранённую страницу, поднятую рядом. В проде это открывает SSRF —
     * сервер начнёт ходить по внутренним адресам по чужой ссылке.
     */
    allowPrivateHosts: process.env.SCRAPE_ALLOW_PRIVATE === 'true',
  },

  feed: {
    maxBytes: int('FEED_MAX_BYTES', 25 * 1024 * 1024),
    maxOffers: int('FEED_MAX_OFFERS', 500),
  },
} as const;
