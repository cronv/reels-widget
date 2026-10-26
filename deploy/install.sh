#!/usr/bin/env bash
#
# Установка сервиса рендера на чистый Ubuntu 22.04/24.04 или Debian 12.
# Запускать из корня распакованного архива: bash deploy/install.sh
#
set -euo pipefail

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "нужен root (sudo bash deploy/install.sh)"
[ -f package.json ] || die "запускайте из корня проекта, рядом с package.json"

say "Обновляю список пакетов"
apt-get update -qq

say "Ставлю ffmpeg и системные библиотеки для Chromium"
# Набор библиотек — тот же, что ставит playwright install-deps; держим его
# явно, чтобы установка не зависела от версии playwright.
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg ffmpeg fonts-liberation fonts-noto-color-emoji \
  libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
  libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
  libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
  libxrandr2 xdg-utils 2>/dev/null || \
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg ffmpeg fonts-liberation \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
  libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
  libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
  libxrandr2 xdg-utils

say "Проверяю Node.js"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$MAJOR" -ge 20 ] && NEED_NODE=0
fi
if [ "$NEED_NODE" -eq 1 ]; then
  say "Ставлю Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

say "Ставлю зависимости проекта"
npm ci --omit=dev

say "Ставлю Chromium для рендера (около 450 МБ)"
# Браузер кладём в системный каталог: служба работает не от root,
# и домашний каталог пользователя ей недоступен.
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
npx playwright install chromium

say "Проверяю сборку"
# Архив приходит уже скомпилированным: компилятор в рабочих зависимостях
# не живёт, и собирать здесь было бы нечем.
if [ ! -f packages/server/dist/index.js ]; then
  die "в архиве нет packages/server/dist — пересоберите архив командой npm run bundle"
fi

say "Готовлю каталоги и пользователя"
id -u reels >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin reels
mkdir -p .output
chown -R reels:reels .output
chmod -R a+rX /opt/ms-playwright 2>/dev/null || true

if [ ! -f .env ]; then
  cp deploy/.env.production.example .env
  say "Создан .env — заполните PUBLIC_URL, ALLOWED_ORIGINS и SCRAPE_ALLOWED_HOSTS"
fi
chown reels:reels .env

say "Самопроверка рендера"
if npm run smoke --silent >/tmp/reels-smoke.log 2>&1; then
  tail -n 8 /tmp/reels-smoke.log
  say "Рендер работает"
else
  tail -n 25 /tmp/reels-smoke.log
  die "самопроверка не прошла, полный лог в /tmp/reels-smoke.log"
fi

cat <<'NEXT'

Дальше:
  1. nano .env                                   — заполнить адреса
  2. cp deploy/reels-widget.service /etc/systemd/system/
     systemctl daemon-reload && systemctl enable --now reels-widget
  3. настроить nginx по deploy/nginx.conf.example и выпустить сертификат
  4. добавить на сайт:
     <script src="https://reels.вашдомен.ru/loader.js" data-reels-widget></script>

NEXT
