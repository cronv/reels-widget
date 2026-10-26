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

/** Разрешено ли происхождение встраивать виджет и дёргать API. */
function originAllowed(origin: string | undefined): string | null {
  if (!config.allowedOrigins.length) return origin ?? '*';
  if (!origin) return null;
  if (origin === selfOrigin()) return origin;
  return config.allowedOrigins.includes(origin) ? origin : null;
}

export function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  const allowed = originAllowed(origin);
  if (origin && allowed === null) {
    json(res, 403, { error: 'Этому домену не разрешено обращаться к виджету.' });
    return false;
  }
  res.setHeader('access-control-allow-origin', allowed ?? '*');
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
  opts: { immutable?: boolean; range?: string } = {},
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
