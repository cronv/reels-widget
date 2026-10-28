import type { IncomingMessage } from 'node:http';
import { config } from './config.js';

/**
 * Ограничение частоты запросов.
 *
 * Авторизация отсекает посторонних, но не защищает от своих же:
 * открытая вкладка с автообновлением способна занять очередь рендера
 * целиком. Поэтому лимиты раздельные — на дорогой рендер свой, на разбор
 * страниц свой, на попытки входа третий, иначе пароль можно перебирать.
 *
 * Счётчики живут в памяти процесса: сервис однонодовый, и внешнее
 * хранилище здесь было бы лишней зависимостью. При перезапуске окна
 * сбрасываются — для защиты от злоупотребления это несущественно.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Разовая уборка, чтобы карта не росла бесконечно. */
let lastSweep = Date.now();
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Адрес клиента. За nginx реальный адрес приходит в X-Forwarded-For,
 * но доверять заголовку можно только если перед нами действительно свой
 * прокси: иначе любой подставит чужой адрес и обойдёт лимит.
 */
export function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const raw = Array.isArray(header) ? header[0] : header;
    const first = raw?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export interface LimitResult {
  allowed: boolean;
  /** Сколько секунд ждать до следующей попытки. */
  retryAfter: number;
  remaining: number;
}

export function hit(key: string, limit: number, windowMs: number): LimitResult {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0, remaining: limit - 1 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  return { allowed: true, retryAfter: 0, remaining: limit - bucket.count };
}

/** Сбрасывает окно — после удачного входа счётчик попыток ни к чему. */
export function reset(key: string): void {
  buckets.delete(key);
}
