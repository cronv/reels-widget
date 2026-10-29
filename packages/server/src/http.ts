import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';

/**
 * Минимальный роутер и отдача статики поверх node:http.
 *
 * Фреймворк тут не окупается: эндпоинтов меньше десятка, а отсутствие
 * зависимостей означает, что сервер ставится одной командой и не требует
 * регулярного обновления ради чужих патчей.
 */

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Запасное имя файла латиницей.
 *
 * В заголовке Content-Disposition имя указывается дважды: в UTF-8 по
 * RFC 5987 и в ASCII для клиентов, которые первого не понимают.
 * Заменять кириллицу подчёркиваниями нельзя — Chrome получает строку
 * из одних «_», не может вывести осмысленное имя и сохраняет файл
 * как «download». Транслитерация оставляет имя читаемым в любом случае.
 */
export function asciiFileName(name: string): string {
  const body = name
    .split('')
    .map((ch) => {
      const lower = ch.toLowerCase();
      const mapped = TRANSLIT[lower];
      if (mapped === undefined) return ch;
      return ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    })
    .join('')
    // Кавычки и управляющие символы ломают разбор заголовка.
    .replace(/[^\x20-\x7E]/g, '-')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim();
  return body || 'reel.mp4';
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Собственный адрес сервера всегда разрешён.
 *
 * Виджет живёт в iframe на домене сервера и оттуда же обращается к API.
 * Браузер шлёт Origin и на такие запросы, поэтому список, заполненный
 * только доменом сайта-носителя, отрезал бы виджет от его собственного
 * API — и всё переставало бы работать ровно после включения защиты.
 */
function selfOrigin(): string | null {
  try {
    return new URL(config.publicUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Пришёл ли запрос на тот же адрес, с которого загружена страница.
 *
 * Прежде «свой» адрес брался только из PUBLIC_URL, и при пустой или
 * ошибочной настройке сервис запрещал доступ сам себе: виджет грузился
 * с его домена, стучался к нему же и получал 403 с сообщением «этому
 * домену не разрешено» — то есть обвинял в чужеродности собственную
 * страницу. Заголовок Host говорит, по какому адресу к нам пришли на
 * самом деле, поэтому правило «свой домен разрешён» перестаёт зависеть
 * от того, вспомнили ли заполнить настройку.
 */
function sameHost(req: IncomingMessage, origin: string): boolean {
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Кому разрешено встраивать виджет в iframe.
 *
 * Заголовок формируется здесь, а не в конфиге nginx, намеренно: список
 * доменов уже задан в ALLOWED_ORIGINS, и второе место, где то же самое
 * пишется руками, однажды разойдётся с первым. Разошлось: в примере
 * конфига остался чужой домен, и встраивание молча блокировалось —
 * модальное окно открывалось пустым, без единой ошибки на странице.
 *
 * Если список пуст, ограничений нет: это режим разработки.
 */
export function frameAncestors(): string {
  if (!config.allowedOrigins.length) return "frame-ancestors *";
  const self = (() => {
    try { return new URL(config.publicUrl).origin; } catch { return null; }
  })();
  const list = [...new Set([...(self ? [self] : []), ...config.allowedOrigins])];
  return `frame-ancestors 'self' ${list.join(' ')}`;
}

/**
 * Совпадает ли происхождение с записью списка.
 *
 * Поддерживается шаблон `https://*.domain.ru`. Без него платформа,
 * где у каждого ЖК свой поддомен, требовала бы дописывать в настройки
 * каждый новый объект — и виджет молча переставал бы работать на нём
 * до того момента, пока кто-нибудь это не заметит.
 *
 * Звёздочка заменяет ровно одну или несколько меток слева и не
 * покрывает сам домен: `*.example.ru` не пропустит `example.ru`,
 * чтобы правило нельзя было прочитать шире, чем оно написано.
 */
function originMatches(origin: string, pattern: string): boolean {
  if (origin === pattern) return true;
  if (!pattern.includes('*')) return false;

  const [patternScheme, patternHost] = pattern.split('://');
  if (!patternScheme || !patternHost) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  // protocol возвращается с двоеточием: «https:».
  if (originUrl.protocol !== `${patternScheme}:`) return false;

  const suffix = patternHost.replace(/^\*\./, '');
  const host = originUrl.host;
  return host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
}

/** Открыто для проверки: разбор шаблонов легко испортить незаметно. */
export const __originMatches = originMatches;

/**
 * Пустит ли сервис этот домен к себе в iframe.
 *
 * То же решение, что принимает CSP и проверка CORS, но в виде ответа
 * на вопрос — чтобы загрузчик мог сказать, в чём дело, а не гадать.
 */
export function embedAllowed(origin: string): boolean {
  if (!config.allowedOrigins.length) return true;
  if (origin === selfOrigin()) return true;
  return config.allowedOrigins.some((p) => originMatches(origin, p));
}

/** Разрешено ли происхождение встраивать виджет и дёргать API. */
function originAllowed(origin: string | undefined, req?: IncomingMessage): string | null {
  if (!config.allowedOrigins.length) return origin ?? '*';
  if (!origin) return null;
  if (origin === selfOrigin()) return origin;
  if (req && sameHost(req, origin)) return origin;
  return config.allowedOrigins.some((p) => originMatches(origin, p)) ? origin : null;
}

/**
 * Адреса, открытые любому домену.
 *
 * `/api/embed/check` отвечает на вопрос «пускаете ли вы меня?» — и если
 * закрыть его тем же правилом, он будет молчать ровно в том случае,
 * ради которого написан. Запрещённый домен получал вместо ответа 403,
 * загрузчик видел неудачный запрос и сообщал «сервис не отвечает», хотя
 * сервис работал и просто не пускал этот домен. Диагностика обязана
 * пережить тот отказ, который диагностирует.
 */
const OPEN_TO_ANY_ORIGIN = new Set(['/api/embed/check', '/health']);

export function applyCors(req: IncomingMessage, res: ServerResponse, pathname?: string): boolean {
  const origin = req.headers.origin;
  const allowed = originAllowed(origin, req);
  const diagnostic = pathname != null && OPEN_TO_ANY_ORIGIN.has(pathname);
  if (origin && allowed === null && !diagnostic) {
    json(res, 403, { error: 'Этому домену не разрешено обращаться к виджету.' });
    return false;
  }
  res.setHeader('access-control-allow-origin', (diagnostic ? origin : allowed) ?? '*');
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-max-age', '600');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return false;
  }
  return true;
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      throw new HttpError(413, `Тело запроса больше ${Math.round(maxBytes / 1024 / 1024)} МБ.`);
    }
    chunks.push(buf);
  }
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new HttpError(400, `Невалидный JSON: ${(err as Error).message}`);
    }
  }
  return raw;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const regex = pattern
      .replace(/\/:([A-Za-z0-9_]+)/g, (_m, key: string) => {
        keys.push(key);
        return '/([^/]+)';
      })
      .replace(/\*$/, '(.*)');
    this.routes.push({ method, pattern: new RegExp(`^${regex}$`), keys, handler });
    return this;
  }

  get(pattern: string, handler: Handler): this { return this.add('GET', pattern, handler); }
  post(pattern: string, handler: Handler): this { return this.add('POST', pattern, handler); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1] ?? '');
      });
      if (!route.keys.length && m[1] != null) params['*'] = m[1];
      return { handler: route.handler, params };
    }
    return null;
  }
}

/** Отдаёт файл из каталога, не выпуская путь наружу через `..`. */
export async function serveStatic(
  res: ServerResponse,
  baseDir: string,
  relative: string,
  opts: { immutable?: boolean; range?: string; downloadAs?: string } = {},
): Promise<boolean> {
  const clean = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(baseDir, clean);
  if (!full.startsWith(path.resolve(baseDir))) return false;

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(full);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return serveStatic(res, baseDir, path.join(clean, 'index.html'), opts);

  const mime = MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'content-type': mime,
    'cache-control': opts.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'accept-ranges': 'bytes',
  };
  // Страницы виджета открываются в iframe на сайте-носителе, поэтому
  // список разрешённых родителей едет вместе с самой страницей.
  if (mime.startsWith('text/html')) {
    headers['content-security-policy'] = frameAncestors();
  }

  /**
   * Явное указание скачать файл.
   *
   * Одного атрибута `download` у ссылки мало: браузер игнорирует его
   * в части случаев и открывает видео вместо сохранения, а внутри
   * встроенного фрейма это выглядит так, будто кнопка не работает.
   * Заголовок снимает неоднозначность. Имя передаётся дважды: в ASCII
   * для старых клиентов и в UTF-8 по RFC 5987 — иначе русское название
   * объекта превратится в мусор.
   */
  if (opts.downloadAs) {
    headers['content-disposition'] =
      `attachment; filename="${asciiFileName(opts.downloadAs)}"; ` +
      `filename*=UTF-8''${encodeURIComponent(opts.downloadAs)}`;
  }

  // Диапазонные запросы нужны, чтобы готовый MP4 можно было проматывать
  // прямо в <video> без полной загрузки.
  const range = opts.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start < stat.size && end < stat.size && start <= end) {
        headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['content-length'] = String(end - start + 1);
        res.writeHead(206, headers);
        fs.createReadStream(full, { start, end }).pipe(res);
        return true;
      }
    }
  }

  headers['content-length'] = String(stat.size);
  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
  return true;
}
