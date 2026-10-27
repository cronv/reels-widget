# Сервис сборки рилсов: Node + системный Chromium + ffmpeg на Alpine.
#
# Почему системный Chromium, а не тот, что ставит Playwright: у Playwright
# нет сборок браузера под musl, и на Alpine `playwright install` не работает
# в принципе. Зато в Alpine есть собственный пакет chromium — его и берём,
# а из зависимостей оставляем только playwright-core, которому нужен
# протокол управления, а не свой браузер. Это же убирает ~450 МБ загрузки.
#
# Сборка:  docker compose -f deploy/docker-compose.yml build
# Проверка: docker compose -f deploy/docker-compose.yml run --rm reels npm run smoke

# ── 1. Сборка ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Браузер на этом этапе не нужен — компилируется только TypeScript.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/

# npm ci требует package-lock.json; без него (например, при сборке из
# архива) откатываемся на install, чтобы шаг не падал молча.
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

COPY tsconfig.base.json ./
COPY packages/ ./packages/
RUN npm run build && test -f packages/server/dist/index.js

# ── 2. Рабочие зависимости отдельно ──────────────────────────────────────────
# Отдельный слой: в финальный образ не должны попасть ни TypeScript,
# ни кеш npm.
FROM node:20-alpine AS deps

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/

RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi \
 && npm cache clean --force

# ── 3. Образ для запуска ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# chromium       — браузер для покадрового рендера
# ffmpeg         — сборка кадров в MP4 (ffprobe оттуда же, нужен самопроверке)
# font-noto      — кириллица: без неё весь русский текст станет квадратами
# ttf-dejavu     — запасной шрифт
# fontconfig     — чтобы Chromium вообще увидел шрифты
# tini           — корректная обработка сигналов и уборка зомби-процессов
#                  браузера: Node плохо справляется с этим как PID 1
RUN apk add --no-cache \
      chromium \
      ffmpeg \
      font-noto \
      ttf-dejavu \
      fontconfig \
      tini

# Шрифты проекта, если они положены в deploy/fonts (Inter и прочее).
# Каталог существует всегда — в нём лежит README, — поэтому COPY не упадёт.
COPY deploy/fonts/ /usr/share/fonts/reels/
RUN fc-cache -f

# Проверка окружения на этапе сборки: лучше не собрать образ, чем получить
# рабочий с виду контейнер, который падает на первом же рендере.
RUN set -eu; \
    if   [ -x /usr/bin/chromium ];         then CHROME=/usr/bin/chromium; \
    elif [ -x /usr/bin/chromium-browser ]; then CHROME=/usr/bin/chromium-browser; ln -sf "$CHROME" /usr/bin/chromium; \
    else echo "ОШИБКА: пакет chromium не поставил бинарь в /usr/bin" >&2; exit 1; fi; \
    echo "Chromium: $("$CHROME" --version 2>&1 | head -1)"; \
    echo "ffmpeg:   $(ffmpeg -version 2>&1 | head -1)"; \
    command -v ffprobe >/dev/null || { echo "ОШИБКА: нет ffprobe" >&2; exit 1; }; \
    fc-list :lang=ru >/dev/null 2>&1 || { echo "ОШИБКА: fontconfig недоступен" >&2; exit 1; }; \
    test "$(fc-list :lang=ru | wc -l)" -gt 0 || { echo "ОШИБКА: нет шрифтов с кириллицей" >&2; exit 1; }; \
    echo "Шрифтов с кириллицей: $(fc-list :lang=ru | wc -l)"

WORKDIR /app

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=4000 \
    OUTPUT_DIR=/app/.output

COPY --from=deps    /app/node_modules        ./node_modules
COPY --from=builder /app/packages/core/dist  ./packages/core/dist
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY packages/core/package.json   ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY package.json ./
# Статика отдаётся сервером напрямую, собирать её нечем и незачем.
COPY packages/stage/ ./packages/stage/
COPY packages/embed/ ./packages/embed/
COPY examples/ ./examples/
COPY scripts/ ./scripts/

# Служба работает не от root. Каталог вывода — единственное, куда она пишет.
RUN addgroup -S reels && adduser -S -G reels -h /app reels \
 && mkdir -p /app/.output && chown -R reels:reels /app/.output
USER reels

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
