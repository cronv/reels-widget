import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config } from './config.js';

/**
 * Доступ к сервису.
 *
 * Сервис публичен по адресу и стоит дорого: один запрос к `/api/render`
 * занимает ядро на минуту, а `/api/extract/url` заставляет сервер ходить
 * по внешним ссылкам. Без проверки это открытый ресурс для чужого
 * использования, поэтому изменяющие и дорогие эндпоинты закрыты.
 *
 * Схема без базы данных: менеджер вводит общий пароль, сервер отдаёт
 * подписанный токен с сроком жизни, виджет кладёт его в заголовок.
 * Пароль по сети уходит один раз, в коде виджета его нет, а проверка
 * токена — это один HMAC без обращения к хранилищу.
 *
 * Почему не cookie: виджет живёт в iframe на чужом домене, и его cookie
 * для браузера третьесторонняя — Chrome такие блокирует по умолчанию.
 * Заголовок работает везде одинаково.
 */

const TOKEN_VERSION = 'v1';

export interface TokenPayload {
  /** Когда истекает, в секундах эпохи. */
  exp: number;
  /** Случайная часть: два токена подряд не совпадают. */
  jti: string;
}

function sign(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/** Сравнение, не зависящее от позиции первого различия. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function issueToken(ttlSeconds = config.auth.sessionTtlSeconds): string {
  const payload: TokenPayload = {
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    jti: crypto.randomBytes(9).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${TOKEN_VERSION}.${body}.${sign(`${TOKEN_VERSION}.${body}`, config.auth.secret)}`;
}

export function verifyToken(token: string | undefined): TokenPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, body, mac] = parts as [string, string, string];
  if (version !== TOKEN_VERSION) return null;
  if (!safeEqual(mac, sign(`${version}.${body}`, config.auth.secret))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Пароль сверяется так, чтобы по времени ответа нельзя было его подобрать. */
export function checkPassword(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  const expected = config.auth.password;
  if (!expected) return false;
  // Хеширование уравнивает длины: иначе сравнение выдавало бы длину пароля.
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function bearerFrom(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/** Включена ли защита. В продакшене выключить её нельзя — см. config. */
export function authEnabled(): boolean {
  return Boolean(config.auth.password);
}

export function isAuthorized(req: IncomingMessage): boolean {
  if (!authEnabled()) return true;
  return verifyToken(bearerFrom(req)) !== null;
}
