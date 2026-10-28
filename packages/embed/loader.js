/**
 * Встраивание одной строкой: иконка в углу и модальное окно с виджетом.
 *
 *   <script src="https://reels.example.ru/loader.js" data-reels-widget></script>
 *
 * Скрипт ставит на страницу круглую кнопку (по умолчанию слева внизу),
 * по клику открывает модальное окно с виджетом и подставляет в него адрес
 * текущей страницы — менеджеру остаётся выбрать сценарий.
 *
 * Разметка кнопки и окна живёт в Shadow DOM: виджет попадает на сайты
 * с чужим CSS-ресетом и глобальными стилями, и без изоляции `button { }`
 * из темы сайта способен перекрасить и развалить кнопку. Сам виджет
 * загружается в iframe, то есть изолирован дважды.
 *
 * Атрибуты:
 *   data-api="https://…"       адрес сервера, если он не там же, где loader
 *   data-position="left|right" угол кнопки, по умолчанию left
 *   data-offset="24"           отступ от края, px
 *   data-accent="#15181D"      цвет кнопки
 *   data-label="Сделать рилс"  подпись у кнопки
 *   data-page="https://…"      какой адрес подставить вместо текущего
 *   data-autoparse="false"     не разбирать страницу сразу при открытии
 *   data-hide-on="/cart,/admin" не показывать кнопку на этих путях
 *   data-open-on-load          открыть окно сразу (для отладки)
 *
 * Программно: window.ReelsWidget.open() / .close() / .toggle()
 */

(function () {
  'use strict';

  var script = document.currentScript;
  if (!script || window.ReelsWidget) return;

  var data = script.dataset;
  var base = new URL(script.src, location.href);
  var api = (data.api || base.origin).replace(/\/$/, '');
  var position = data.position === 'right' ? 'right' : 'left';
  var offset = Number(data.offset || 24);
  var accent = data.accent || '#15181D';
  var label = data.label || 'Собрать рилс';
  var autoparse = data.autoparse !== 'false';

  // Страница-носитель: по ней виджет предзаполняет поле «Ссылка».
  var pageUrl = data.page || location.href.split('#')[0];

  // На служебных страницах кнопка обычно не нужна.
  var hideOn = (data.hideOn || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (hideOn.some(function (p) { return location.pathname.indexOf(p) === 0; })) return;

  // ── каркас ────────────────────────────────────────────────────────────

  var host = document.createElement('div');
  host.id = 'reels-widget-host';
  host.style.position = 'relative';
  host.style.zIndex = '2147483000';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var style = document.createElement('style');
  style.textContent = [
    ':host, * { box-sizing: border-box; }',
    '.launcher {',
    '  position: fixed; bottom: ' + offset + 'px; ' + position + ': ' + offset + 'px;',
    '  z-index: 2147483000; display: inline-flex; align-items: center; gap: 10px;',
    '  height: 56px; padding: 0 20px 0 16px; border: 0; border-radius: 999px;',
    '  background: ' + accent + '; color: #fff; cursor: pointer;',
    '  font: 500 15px/1 Inter, system-ui, -apple-system, "Segoe UI", sans-serif;',
    '  box-shadow: 0 6px 24px rgba(0,0,0,0.22); transition: transform .18s ease, box-shadow .18s ease;',
    '}',
    '.launcher:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(0,0,0,0.26); }',
    '.launcher:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }',
    '.launcher svg { width: 24px; height: 24px; flex: none; fill: currentColor; }',
    // Пока окно открыто, кнопка не нужна: закрыть можно крестиком, Esc
    // или кликом по фону, а третья точка выхода в углу только путает.
    '.launcher[hidden] { display: none; }',
    // На узких экранах подпись убирается, остаётся круглая иконка.
    '@media (max-width: 560px) {',
    '  .launcher { padding: 0; width: 56px; justify-content: center; }',
    '  .launcher .label { display: none; }',
    '}',

    '.overlay {',
    '  position: fixed; inset: 0; z-index: 2147483001;',
    '  background: rgba(10,12,16,0.55); backdrop-filter: blur(2px);',
    '  display: flex; align-items: center; justify-content: center; padding: 24px;',
    '}',
    '.overlay[hidden] { display: none; }',
    '.panel {',
    '  position: relative; width: 100%; max-width: 1180px; height: min(90vh, 980px);',
    '  background: #F2F3F5; border-radius: 20px; overflow: hidden;',
    '  box-shadow: 0 24px 80px rgba(0,0,0,0.4); display: flex; flex-direction: column;',
    '}',
    '.bar {',
    '  flex: none; display: flex; align-items: center; justify-content: space-between;',
    '  gap: 16px; padding: 14px 16px 14px 22px; background: #fff; border-bottom: 1px solid #DCDFE4;',
    '  font: 600 15px/1.2 Inter, system-ui, sans-serif; color: #15181D;',
    '}',
    '.bar .where { font-weight: 400; color: #767E8B; font-size: 13px; margin-top: 3px; }',
    '.close {',
    '  flex: none; width: 36px; height: 36px; border-radius: 10px; cursor: pointer;',
    '  border: 1px solid #DCDFE4; background: #fff; color: #15181D;',
    '  display: grid; place-items: center;',
    '}',
    '.close:hover { background: #EDEFF2; }',
    '.close:focus-visible { outline: 2px solid #15181D; outline-offset: 2px; }',
    '.close svg { width: 16px; height: 16px; fill: currentColor; }',
    'iframe { flex: 1; width: 100%; border: 0; display: block; background: #F2F3F5; }',
    '.notice {',
    '  margin: 16px; padding: 14px 16px; border-radius: 12px;',
    '  background: #FCEDEC; color: #96241F; font: 400 13.5px/1.5 Inter, system-ui, sans-serif;',
    '}',
    '.notice[hidden] { display: none; }',
    '@media (max-width: 760px) {',
    '  .overlay { padding: 0; }',
    '  .panel { height: 100%; max-width: none; border-radius: 0; }',
    '}',
    '@media (prefers-reduced-motion: reduce) { .launcher { transition: none; } }',
  ].join('\n');
  root.appendChild(style);

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'launcher';
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm2 2v2h2V5H6Zm10 0v2h2V5h-2ZM6 17v2h2v-2H6Zm10 0v2h2v-2h-2ZM10 8.5v7l6-3.5-6-3.5Z"/></svg>' +
    '<span class="label"></span>';
  launcher.querySelector('.label').textContent = label;
  root.appendChild(launcher);

  var overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.hidden = true;

  var panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Сборка рилса по объекту');

  var bar = document.createElement('div');
  var barText = document.createElement('div');
  var barTitle = document.createElement('div');
  barTitle.textContent = 'Рилс по объекту';
  var barWhere = document.createElement('div');
  barWhere.className = 'where';
  barWhere.textContent = pageUrl.replace(/^https?:\/\//, '');
  barText.appendChild(barTitle);
  barText.appendChild(barWhere);
  bar.className = 'bar';
  bar.appendChild(barText);

  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close';
  closeBtn.setAttribute('aria-label', 'Закрыть');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 6.6 13.3 1.3l1.4 1.4L9.4 8l5.3 5.3-1.4 1.4L8 9.4l-5.3 5.3-1.4-1.4L6.6 8 1.3 2.7l1.4-1.4L8 6.6Z"/></svg>';
  bar.appendChild(closeBtn);

  panel.appendChild(bar);

  var notice = document.createElement('div');
  notice.className = 'notice';
  notice.hidden = true;
  panel.appendChild(notice);

  overlay.appendChild(panel);
  root.appendChild(overlay);

  (document.body || document.documentElement).appendChild(host);

  // ── поведение ─────────────────────────────────────────────────────────

  var frame = null;
  var lastFocused = null;
  var scrollLock = '';
  var frameWatch = null;
  /** Фрейм прислал хоть одно сообщение — значит, он загрузился. */
  var frameAlive = false;

  /** iframe создаётся при первом открытии: до него виджет ничего не грузит. */
  function ensureFrame() {
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.title = 'Генератор рилсов по объекту';
    frame.setAttribute('allow', 'clipboard-write');
    var params = new URLSearchParams({
      api: api,
      page: pageUrl,
      embedded: '1',
      autoparse: autoparse ? '1' : '0',
    });
    frame.src = api + '/embed/widget.html?' + params.toString();
    panel.appendChild(frame);
    return frame;
  }

  /**
   * Показывает причину, если фрейм так и не ожил.
   *
   * Браузер блокирует встраивание по Content-Security-Policy молча:
   * на странице-носителе не возникает ни ошибки, ни события, и окно
   * просто остаётся белым. Единственный доступный признак — фрейм
   * не прислал ни одного сообщения; об этом и говорим прямым текстом.
   */
  function watchFrame() {
    clearTimeout(frameWatch);
    frameWatch = setTimeout(function () {
      if (frameAlive || overlay.hidden) return;
      notice.hidden = false;
      notice.textContent =
        'Виджет не загрузился. Чаще всего это значит, что сервис запрещает ' +
        'встраивание на этот домен: добавьте ' + location.origin +
        ' в ALLOWED_ORIGINS и перезапустите сервис. Подробности — в консоли браузера.';
    }, 6000);
  }

  function open() {
    if (!overlay.hidden) return;
    lastFocused = document.activeElement;
    notice.hidden = true;
    ensureFrame();
    watchFrame();
    overlay.hidden = false;
    launcher.hidden = true;
    launcher.setAttribute('aria-expanded', 'true');
    scrollLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
    document.addEventListener('keydown', onKey, true);
  }

  function close() {
    if (overlay.hidden) return;
    clearTimeout(frameWatch);
    overlay.hidden = true;
    launcher.hidden = false;
    launcher.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = scrollLock;
    document.removeEventListener('keydown', onKey, true);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    else launcher.focus();
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  launcher.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', function (event) {
    // Закрываем только по клику мимо панели, а не по отпусканию кнопки
    // после выделения текста внутри неё.
    if (event.target === overlay) close();
  });

  // Виджет сообщает, что внутри нажали «Закрыть» или всё готово.
  window.addEventListener('message', function (event) {
    if (!frame || event.source !== frame.contentWindow) return;
    var msg = event.data;
    if (!msg || msg.source !== 'reels-widget-frame') return;
    frameAlive = true;
    clearTimeout(frameWatch);
    notice.hidden = true;
    if (msg.type === 'close') close();
  });

  window.ReelsWidget = {
    open: open,
    close: close,
    toggle: function () { overlay.hidden ? open() : close(); },
    /** Сменить адрес объекта, не перезагружая страницу (для SPA-сайтов). */
    setPage: function (url) {
      pageUrl = url;
      barWhere.textContent = String(url).replace(/^https?:\/\//, '');
      if (frame) {
        frame.contentWindow.postMessage(
          { source: 'reels-widget-host', type: 'page', url: url, autoparse: autoparse },
          '*',
        );
      }
    },
  };

  if (data.openOnLoad !== undefined) open();
})();
