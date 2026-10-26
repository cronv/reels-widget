# Размещение

## Что куда ставится

Виджет состоит из двух частей, и у них разные требования.

| Часть | Что это | Куда ставится |
|---|---|---|
| Кнопка на сайте | один тег `<script>` | на сайт, как есть — файлы загружать не нужно |
| Сервис рендера | Node.js + Chromium + ffmpeg | **VPS**, обычный хостинг не подойдёт |

**Почему обычный хостинг не подойдёт.** Рендер собирает видео так: headless
Chromium открывает сцену, перематывается покадрово и отдаёт кадры в ffmpeg.
Это требует права запускать процессы, примерно 400 МБ под браузер, рабочий
`/dev/shm` и собственный бинарь ffmpeg. Классический виртуальный хостинг —
у любого провайдера, не только у reg.ru — такого не даёт: там исполняется
код сайта в песочнице, а не произвольные бинарники. Даже если на тарифе
заявлена поддержка Node.js, поставить туда Chromium не выйдет.

Рабочая схема: сайт остаётся там, где он сейчас, а сервис рендера едет
на VPS (у reg.ru они есть) или на любой другой сервер с root-доступом.
Сайту от этого ничего не нужно, кроме одной строки в шаблоне.

**Сколько ресурсов нужно VPS.** Минимум — 2 ГБ RAM и 2 ядра: один рендер
держит вкладку Chromium примерно на 400 МБ, плюс ffmpeg. При
`RENDER_CONCURRENCY=2` комфортно на 4 ГБ. Диска хватит 20 ГБ: сам браузер
около 450 МБ, остальное — готовые ролики, которые подчищаются автоматически
(`RENDER_KEEP_FILES`).

---

## Шаг 1. Сервер

Ubuntu 22.04/24.04 или Debian 12, под root:

Архив готовится локально командой `npm run bundle` — он уже содержит
скомпилированный код, компилятор на сервере не нужен.

```bash
# распаковать архив сборки
mkdir -p /opt/reels-widget && tar -xzf reels-widget-*.tar.gz -C /opt/reels-widget --strip-components=1
cd /opt/reels-widget

# установка зависимостей, браузера и ffmpeg
bash deploy/install.sh
```

`install.sh` ставит Node.js 20 (если его нет), ffmpeg, системные библиотеки
для Chromium, зависимости проекта и сам браузер, затем собирает проект.

Настройки — в `.env`:

```bash
cp deploy/.env.production.example .env
nano .env
```

Обязательно задайте:

```ini
PUBLIC_URL=https://reels.вашдомен.ru      # адрес, по которому сервис виден снаружи
ALLOWED_ORIGINS=https://вашсайт.ru        # кто может встраивать виджет
SCRAPE_ALLOWED_HOSTS=вашсайт.ru           # какие домены можно разбирать по ссылке
SCRAPE_TRUSTED_HOSTS=вашсайт.ru           # если robots.txt закрывает свой же сайт
```

Домен самого сервиса в `ALLOWED_ORIGINS` вписывать не нужно — он разрешён
всегда, иначе виджет не смог бы обратиться к собственному API.

Запуск как служба:

```bash
cp deploy/reels-widget.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now reels-widget
systemctl status reels-widget
```

## Шаг 2. Домен и HTTPS

```bash
apt install -y nginx certbot python3-certbot-nginx
cp deploy/nginx.conf.example /etc/nginx/sites-available/reels-widget
# поправьте server_name внутри
ln -s /etc/nginx/sites-available/reels-widget /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d reels.вашдомен.ru
```

HTTPS обязателен: сайт работает по https, и браузер не пустит со страницы
запросы и iframe по http.

Проверка: `curl https://reels.вашдомен.ru/health` должен ответить `{"ok":true…}`.

## Шаг 3. Кнопка на сайте

Одна строка перед `</body>` в шаблоне сайта:

```html
<script src="https://reels.вашдомен.ru/loader.js" data-reels-widget></script>
```

Кнопка появится слева внизу. По клику откроется окно, адрес текущей страницы
подставится сам и разбор запустится сразу.

Если сайт на CMS и общего шаблона нет, тег добавляется в настройках темы
в поле для кода перед закрывающим `body` — у большинства CMS такое есть.

### Настройки кнопки

```html
<script src="https://reels.вашдомен.ru/loader.js"
        data-reels-widget
        data-position="right"
        data-offset="32"
        data-accent="#1B75BB"
        data-label="Сделать рилс"
        data-hide-on="/cart,/personal"
        data-autoparse="false"></script>
```

| Атрибут | Что делает |
|---|---|
| `data-position` | `left` (по умолчанию) или `right` |
| `data-offset` | отступ от края в пикселях |
| `data-accent` | цвет кнопки |
| `data-label` | подпись; на узких экранах скрывается |
| `data-page` | какой адрес подставить вместо текущего |
| `data-autoparse="false"` | не разбирать страницу сразу при открытии |
| `data-hide-on` | пути, на которых кнопку показывать не надо |
| `data-api` | адрес сервиса, если `loader.js` отдаётся с другого домена |

Для сайтов, которые меняют адрес без перезагрузки, есть
`window.ReelsWidget.setPage('https://…')`, а также `.open()`, `.close()`
и `.toggle()`.

### Кнопка только для сотрудников

Виджет ходит по вашим страницам и тратит ресурсы сервера, поэтому на
публичном сайте показывать его всем обычно не нужно. Самое простое —
выводить тег только авторизованным менеджерам средствами CMS. Если такой
возможности нет, оставьте `data-hide-on` для публичных разделов и закройте
сам сервис по IP в nginx (пример есть в `nginx.conf.example`).

---

## Обновление

```bash
cd /opt/reels-widget
tar -xzf /tmp/reels-widget-новая.tar.gz --strip-components=1
npm ci --omit=dev
systemctl restart reels-widget
```

## Если что-то не так

| Симптом | Куда смотреть |
|---|---|
| Кнопка не появилась | консоль браузера: загрузился ли `loader.js`, нет ли ошибки CORS |
| Окно открылось пустым | `ALLOWED_ORIGINS` — туда должен входить домен сайта |
| «robots.txt запрещает» | добавьте домен в `SCRAPE_TRUSTED_HOSTS` |
| Рендер падает | `journalctl -u reels-widget -n 100`; чаще всего не хватает памяти |
| Кадры пустые | картинки объекта недоступны снаружи или закрыт хотлинк по Referer |

Разобрать страницу без сервера, чтобы понять, парсер виноват или нет:

```bash
curl -s https://вашсайт.ru/объект > page.html
npm run parse -- page.html https://вашсайт.ru/объект
```
