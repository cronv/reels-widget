import http from 'node:http';
import fsp from 'node:fs/promises';
import { config } from './config.js';
import { HttpError, applyCors, json, serveStatic } from './http.js';
import { buildRouter } from './routes.js';
import { closeBrowser } from './render.js';

const router = buildRouter();

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (!applyCors(req, res)) return;

    // ── статика ───────────────────────────────────────────────────────────
    if (url.pathname.startsWith('/stage/')) {
      const ok = await serveStatic(res, config.paths.stage, url.pathname.slice('/stage/'.length));
      if (ok) return;
    }
    if (url.pathname.startsWith('/files/')) {
      const ok = await serveStatic(res, config.paths.output, url.pathname.slice('/files/'.length), {
        immutable: true,
        range: req.headers.range,
      });
      if (ok) return;
    }
    if (url.pathname.startsWith('/examples/')) {
      const ok = await serveStatic(res, config.paths.examples, url.pathname.slice('/examples/'.length));
      if (ok) return;
    }
    if (url.pathname === '/' || url.pathname === '/widget' || url.pathname.startsWith('/embed/')) {
      const rel = url.pathname.startsWith('/embed/')
        ? url.pathname.slice('/embed/'.length)
        : 'widget.html';
      const ok = await serveStatic(res, config.paths.embed, rel);
      if (ok) return;
    }
    /**
     * Виджет открывается и по `/`, и по `/embed/widget.html`, а ссылки
     * внутри страницы относительные: по корневому адресу `./widget.css`
     * превращается в `/widget.css`. Без этой ветки страница по `/`
     * приходила без стилей и без скрипта — внешне «сломанная вёрстка»,
     * хотя на деле не выполнялся ни один обработчик.
     * Условие с точкой в имени не даёт перехватывать маршруты API.
     */
    if (url.pathname.includes('.') && !url.pathname.startsWith('/api/')) {
      const ok = await serveStatic(res, config.paths.embed, url.pathname.slice(1));
      if (ok) return;
    }

    // ── API ───────────────────────────────────────────────────────────────
    const match = router.match(req.method ?? 'GET', url.pathname);
    if (!match) {
      json(res, 404, { error: `Нет обработчика для ${req.method} ${url.pathname}` });
      return;
    }
    await match.handler({ req, res, url, params: match.params, body: undefined });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Внутренняя ошибка';
    if (status >= 500) {
      console.error(`[${req.method} ${url.pathname}]`, err);
    }
    if (!res.headersSent) json(res, status, { error: message });
    else res.end();
  } finally {
    if (process.env.LOG_REQUESTS === 'true') {
      console.log(`${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
    }
  }
});

async function start(): Promise<void> {
  /**
   * В продакшене без пароля не стартуем.
   *
   * Сервис виден по публичному адресу, а рендер занимает ядро на минуту:
   * открытый `/api/render` — это чужой бесплатный видеосервис за ваш счёт.
   * Предупреждения в логе для такого мало, его никто не читает, поэтому
   * отказ запускаться — единственный надёжный способ не забыть.
   */
  if (config.isProduction && !config.auth.password) {
    console.error(
      '\nОШИБКА: не задан ACCESS_PASSWORD.\n' +
        'Сервис доступен снаружи, а рендер дорогой — без пароля его API открыт всем.\n' +
        'Добавьте в .env:\n' +
        '  ACCESS_PASSWORD=<пароль для менеджеров>\n' +
        '  AUTH_SECRET=<длинная случайная строка>\n' +
        'Для локальной разработки запускайте без NODE_ENV=production.\n',
    );
    process.exit(1);
  }

  await fsp.mkdir(config.paths.output, { recursive: true });
  server.listen(config.port, config.host, () => {
    console.log(`Виджет рилсов: http://localhost:${config.port}`);
    console.log(`  сцена:   ${config.publicUrl}/stage/stage.html`);
    console.log(`  встройка: <script src="${config.publicUrl}/loader.js" data-reels-widget></script>`);

    if (config.auth.password) {
      console.log(`  доступ:  по паролю, сессия ${config.auth.sessionTtlSeconds / 3600} ч`);
      if (!config.auth.secretFromEnv) {
        console.warn('  ВНИМАНИЕ: AUTH_SECRET не задан — после перезапуска придётся войти заново.');
      }
    } else {
      console.warn('  ВНИМАНИЕ: ACCESS_PASSWORD не задан — API открыт без входа (режим разработки).');
    }
    if (!config.allowedOrigins.length) {
      console.warn('  ВНИМАНИЕ: ALLOWED_ORIGINS пуст — API открыт любому домену.');
    }
    if (!config.scrape.allowedHosts.length) {
      console.warn('  ВНИМАНИЕ: SCRAPE_ALLOWED_HOSTS пуст — разбор ссылок разрешён для любого домена.');
    }
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal}: останавливаюсь…`);
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void start();

export { server };
