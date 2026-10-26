import type { Card, ScenarioId, Theme } from '@reels/core';
import {
  SCENARIOS,
  buildTimeline,
  checkAvailability,
  fromManual,
  mergeCard,
  normalizeCard,
  parseFeed,
  parseListing,
  fetchHtml,
  FIELD_LABELS,
} from '@reels/core';
import { config } from './config.js';
import { HttpError, Router, json, readBody } from './http.js';
import { enqueue, getJob, listJobs, queueStats } from './jobs.js';

/** stage.html, каким его видит headless-браузер на этом же сервере. */
const stageUrl = `http://127.0.0.1:${config.port}/stage/stage.html`;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'Ожидался JSON-объект в теле запроса.');
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `Поле «${key}» обязательно.`);
  }
  return value.trim();
}

function assertScrapeAllowed(target: string): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new HttpError(400, 'Некорректная ссылка.');
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new HttpError(400, 'Поддерживаются только http и https.');
  }
  // Защита от обращения сервера к внутренней сети через чужую ссылку.
  const host = url.hostname.toLowerCase();
  if (
    !config.scrape.allowPrivateHosts &&
    (host === 'localhost' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host))
  ) {
    throw new HttpError(
      400,
      'Ссылки на внутренние адреса не обрабатываются. Для локальной отладки ' +
        'запустите сервер с SCRAPE_ALLOW_PRIVATE=true.',
    );
  }
  if (config.scrape.allowedHosts.length) {
    const ok = config.scrape.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) {
      throw new HttpError(403, `Домен ${host} не в списке разрешённых для разбора.`);
    }
  }
}

/** Карточка приходит с клиента и всегда проходит нормализацию заново. */
function cardFromBody(body: Record<string, unknown>): Card {
  if (!body.card) throw new HttpError(400, 'Нужна карточка объекта в поле «card».');
  return normalizeCard(body.card as never);
}

function scenarioFromBody(body: Record<string, unknown>): ScenarioId {
  const value = body.scenario;
  if (typeof value !== 'string' || !(value in SCENARIOS)) {
    throw new HttpError(400, `Неизвестный сценарий. Доступны: ${Object.keys(SCENARIOS).join(', ')}.`);
  }
  return value as ScenarioId;
}

function themeFromBody(body: Record<string, unknown>): Partial<Theme> | undefined {
  const theme = body.theme;
  if (!theme || typeof theme !== 'object') return undefined;
  const t = theme as Record<string, unknown>;
  const out: Partial<Theme> = {};
  // Белый список: тема уходит прямо в inline-стили сцены.
  for (const key of ['bg', 'surface', 'text', 'textMuted', 'accent', 'accentText', 'fontDisplay', 'fontBody'] as const) {
    const v = t[key];
    if (typeof v === 'string' && v.length < 160 && !/[<>{}]/.test(v)) out[key] = v;
  }
  if (typeof t.radius === 'number') out.radius = t.radius;
  return out;
}

export function buildRouter(): Router {
  const router = new Router();

  router.get('/health', ({ res }) => {
    json(res, 200, { ok: true, queue: queueStats(), uptime: Math.round(process.uptime()) });
  });

  router.get('/api/scenarios', ({ res }) => {
    json(res, 200, { scenarios: Object.values(SCENARIOS), fields: FIELD_LABELS });
  });

  // ── источник 1: фид ───────────────────────────────────────────────────
  router.post('/api/extract/feed', async ({ req, res }) => {
    const body = asRecord(await readBody(req, config.feed.maxBytes));
    let payload: string;

    if (typeof body.payload === 'string' && body.payload.trim()) {
      payload = body.payload;
    } else if (typeof body.url === 'string') {
      assertScrapeAllowed(body.url);
      const response = await fetch(body.url, {
        signal: AbortSignal.timeout(config.scrape.timeoutMs),
        headers: { 'user-agent': 'ReelsWidget/1.0' },
      });
      if (!response.ok) throw new HttpError(502, `Фид ответил ${response.status}.`);
      payload = await response.text();
    } else {
      throw new HttpError(400, 'Передайте содержимое фида в «payload» или ссылку в «url».');
    }

    const result = parseFeed(payload, { limit: config.feed.maxOffers });
    json(res, 200, {
      format: result.format,
      total: result.total,
      warnings: result.warnings,
      cards: result.cards,
    });
  });

  // ── источник 2: ссылка на карточку ────────────────────────────────────
  router.post('/api/extract/url', async ({ req, res }) => {
    const body = asRecord(await readBody(req, 64 * 1024));
    const target = requireString(body, 'url');
    assertScrapeAllowed(target);

    const host = new URL(target).hostname.toLowerCase();
    const trusted = config.scrape.trustedHosts.some((h) => host === h || host.endsWith(`.${h}`));

    const html = await fetchHtml(target, {
      timeoutMs: config.scrape.timeoutMs,
      respectRobots: config.scrape.respectRobots && !trusted,
    });
    const report = parseListing(html, target);
    const card = normalizeCard(report.raw);
    json(res, 200, {
      card,
      // Профиль видно в ответе: если он не определился, менеджер сразу
      // понимает, почему полей меньше обычного.
      profile: report.profile ? { id: report.profile.id, label: report.profile.label } : null,
      specsMatched: report.matchedSpecs.length,
      missing: card.missing.map((f) => ({ field: f, label: FIELD_LABELS[f] ?? f })),
    });
  });

  // ── источник 3: ручной ввод ───────────────────────────────────────────
  router.post('/api/extract/manual', async ({ req, res }) => {
    const body = asRecord(await readBody(req, 512 * 1024));
    const card = fromManual(body as never);
    json(res, 200, {
      card,
      missing: card.missing.map((f) => ({ field: f, label: FIELD_LABELS[f] ?? f })),
    });
  });

  // ── правки карточки из формы ──────────────────────────────────────────
  router.post('/api/card/merge', async ({ req, res }) => {
    const body = asRecord(await readBody(req, 512 * 1024));
    const base = cardFromBody(body);
    const card = mergeCard(base, (body.patch ?? {}) as never);
    json(res, 200, { card, missing: card.missing });
  });

  // ── таймлайн для превью ───────────────────────────────────────────────
  router.post('/api/timeline', async ({ req, res }) => {
    const body = asRecord(await readBody(req, 1024 * 1024));
    const card = cardFromBody(body);
    const scenario = scenarioFromBody(body);
    const availability = checkAvailability(card, scenario);
    if (!availability.ok) {
      throw new HttpError(
        422,
        `Для сценария «${SCENARIOS[scenario].title}» не хватает: ${availability.missing
          .map((f) => FIELD_LABELS[f] ?? f)
          .join(', ')}.`,
      );
    }
    json(res, 200, { timeline: buildTimeline(card, scenario, { theme: themeFromBody(body) }) });
  });

  /** Какие сценарии доступны этой карточке — виджет гасит остальные кнопки. */
  router.post('/api/timeline/available', async ({ req, res }) => {
    const body = asRecord(await readBody(req, 1024 * 1024));
    const card = cardFromBody(body);
    const available = (Object.keys(SCENARIOS) as ScenarioId[]).map((id) => {
      const check = checkAvailability(card, id);
      return {
        ...SCENARIOS[id],
        available: check.ok,
        missing: check.missing.map((f) => FIELD_LABELS[f] ?? f),
      };
    });
    json(res, 200, { scenarios: available });
  });

  // ── рендер ────────────────────────────────────────────────────────────
  router.post('/api/render', async ({ req, res }) => {
    const body = asRecord(await readBody(req, 1024 * 1024));
    const card = cardFromBody(body);
    const scenario = scenarioFromBody(body);
    const availability = checkAvailability(card, scenario);
    if (!availability.ok) {
      throw new HttpError(422, `Не хватает данных: ${availability.missing.join(', ')}.`);
    }
    const timeline = buildTimeline(card, scenario, { theme: themeFromBody(body) });
    const job = enqueue(timeline, stageUrl);
    json(res, 202, { job, queue: queueStats() });
  });

  router.get('/api/jobs/:id', ({ res, params }) => {
    const job = getJob(params.id ?? '');
    if (!job) throw new HttpError(404, 'Задача не найдена.');
    json(res, 200, { job, queue: queueStats() });
  });

  router.get('/api/jobs', ({ res }) => {
    json(res, 200, { jobs: listJobs(), queue: queueStats() });
  });

  return router;
}
