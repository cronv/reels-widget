/**
 * Сцена — детерминированный рендерер таймлайна.
 *
 * Один и тот же код рисует превью в браузере и кадры для серверного экспорта.
 * Ключевое правило: ни одной CSS-анимации и ни одного обращения к Date.now().
 * Всё состояние — функция от номера кадра, поэтому seek(n) на сервере даёт
 * ровно ту картинку, которую пользователь видел в превью.
 *
 * Публичный API (его же дёргает Playwright при захвате):
 *   stage.mount(timeline)   — построить DOM
 *   stage.seek(frame)       — показать конкретный кадр
 *   stage.waitAssets()      — дождаться загрузки картинок
 *   stage.play() / pause()  — локальное воспроизведение для превью
 */

(function (global) {
  'use strict';

  // ── математика ──────────────────────────────────────────────────────────

  var EASINGS = {
    linear: function (t) { return t; },
    easeOut: function (t) { return 1 - Math.pow(1 - t, 3); },
    easeInOut: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    expoOut: function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    backOut: function (t) {
      var c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
  };

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function ease(name, t) {
    return (EASINGS[name] || EASINGS.easeOut)(clamp01(t));
  }

  /** Прогресс анимации 0..1 для локального кадра сцены. */
  function animProgress(spec, localFrame) {
    if (!spec) return 1;
    if (spec.dur <= 0) return localFrame >= spec.at ? 1 : 0;
    return ease(spec.easing, (localFrame - spec.at) / spec.dur);
  }

  var NBSP = ' ';

  function groupDigits(n) {
    var sign = n < 0 ? '-' : '';
    var s = String(Math.round(Math.abs(n)));
    var out = '';
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += NBSP;
      out += s[i];
    }
    return sign + out;
  }

  // ── типографика ─────────────────────────────────────────────────────────

  var TYPE = {
    display: { size: 96, lineHeight: 0.98, weight: 800, tracking: -0.03 },
    title: { size: 64, lineHeight: 1.06, weight: 700, tracking: -0.02 },
    subtitle: { size: 42, lineHeight: 1.25, weight: 500, tracking: 0 },
    body: { size: 36, lineHeight: 1.35, weight: 400, tracking: 0 },
    caption: { size: 28, lineHeight: 1.3, weight: 500, tracking: 0 },
    price: { size: 108, lineHeight: 1, weight: 800, tracking: -0.03 },
    kicker: { size: 26, lineHeight: 1, weight: 600, tracking: 0.18 }
  };

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function px(v) { return v + 'px'; }

  // ── построение слоёв ────────────────────────────────────────────────────

  /** У элементов стека рамки нет — их размещает поток, а не координаты. */
  function applyBox(node, box) {
    if (!box) return;
    node.style.position = 'absolute';
    node.style.left = px(box.x);
    node.style.top = px(box.y);
    node.style.width = px(box.w);
    if (box.h > 0) node.style.height = px(box.h);
  }

  function buildText(layer, theme) {
    var node = el('div', 'st-text');
    applyBox(node, layer.box);
    var role = TYPE[layer.role] || TYPE.body;
    node.style.fontFamily = layer.role === 'body' || layer.role === 'caption' ? theme.fontBody : theme.fontDisplay;
    node.style.fontSize = px(layer.size || role.size);
    node.style.lineHeight = String(layer.lineHeight || role.lineHeight);
    node.style.fontWeight = String(layer.weight || role.weight);
    node.style.letterSpacing = (role.tracking || 0) + 'em';
    node.style.color = layer.color || theme.text;
    node.style.textAlign = layer.align || 'left';
    if (layer.uppercase) node.style.textTransform = 'uppercase';
    if (layer.strike) {
      node.style.textDecoration = 'line-through';
      node.style.textDecorationThickness = '4px';
    }
    if (layer.shadow !== false && !layer.color) {
      node.style.textShadow = '0 2px 24px rgba(0,0,0,0.45)';
    }
    if (layer.maxLines) {
      node.style.display = '-webkit-box';
      node.style.webkitBoxOrient = 'vertical';
      node.style.webkitLineClamp = String(layer.maxLines);
      node.style.overflow = 'hidden';
    }
    node.textContent = layer.text;
    return { node: node, kind: 'text' };
  }

  function buildImage(layer, theme, assets) {
    var frame = el('div', 'st-img');
    applyBox(frame, layer.box);
    frame.style.overflow = 'hidden';
    frame.style.borderRadius = px(layer.radius || 0);
    frame.style.background = layer.background || theme.bg;

    var img = el('img');
    img.src = layer.src;
    img.alt = '';
    img.decoding = 'sync';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = layer.fit;
    img.style.display = 'block';
    img.style.willChange = 'transform';
    // Без этого кадры с contain-планировкой прыгают на пиксель при смене scale.
    img.style.transformOrigin = 'center center';
    img.addEventListener('error', function () {
      frame.classList.add('st-img--failed');
      img.style.visibility = 'hidden';
    });
    assets.push(img);
    frame.appendChild(img);

    var scrim = null;
    if (layer.scrim > 0) {
      scrim = el('div', 'st-scrim');
      scrim.style.position = 'absolute';
      scrim.style.inset = '0';
      scrim.style.background = 'rgba(6,8,11,' + layer.scrim + ')';
      frame.appendChild(scrim);
    }
    return { node: frame, kind: 'image', img: img };
  }

  function buildRect(layer) {
    var node = el('div', 'st-rect');
    applyBox(node, layer.box);
    node.style.background = layer.fill;
    node.style.borderRadius = px(layer.radius == null ? 0 : layer.radius);
    if (layer.blur) node.style.backdropFilter = 'blur(' + layer.blur + 'px)';
    return { node: node, kind: 'rect' };
  }

  function buildGradient(layer) {
    var node = el('div', 'st-grad');
    applyBox(node, layer.box);
    if (layer.radial) {
      node.style.background =
        'radial-gradient(' + layer.radial.r + '% ' + layer.radial.r + '% at ' +
        layer.radial.x + '% ' + layer.radial.y + '%, ' + layer.from + ', ' + layer.to + ')';
    } else {
      node.style.background =
        'linear-gradient(' + (layer.angle || 180) + 'deg, ' + layer.from + ', ' + layer.to + ')';
    }
    return { node: node, kind: 'gradient' };
  }

  // ── фоновая графика ─────────────────────────────────────────────────────

  /**
   * Цвета попадают прямо в разметку SVG, поэтому сюда пускаем только
   * безопасный набор символов. Тема приходит из конфигурации, но путь
   * «внешние данные → innerHTML» закрывать надо в любом случае.
   */
  function safeColor(value, fallback) {
    return typeof value === 'string' && /^[#a-zA-Z0-9(),.%\s-]{1,48}$/.test(value)
      ? value
      : fallback;
  }

  /**
   * Генератор псевдослучайных чисел с seed.
   * Math.random() сделал бы каждый кадр уникальным, и при покадровом
   * захвате фон бы мерцал — графика обязана быть детерминированной.
   */
  function rng(seed) {
    var s = (seed || 1) >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function svgWrap(w, h, inner) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" ' +
      'viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid slice">' + inner + '</svg>';
  }

  var GRAPHICS = {
    /** Чертёжная сетка: крупный модуль и мелкая клетка внутри. */
    grid: function (w, h, o) {
      var step = o.step || 60;
      var parts = ['<g stroke="' + o.color + '" fill="none">'];
      for (var x = 0; x <= w; x += step) {
        var major = (x / step) % 5 === 0;
        parts.push('<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + h +
          '" stroke-width="' + (major ? 2 : 1) + '" opacity="' + (major ? 0.5 : 0.22) + '"/>');
      }
      for (var y = 0; y <= h; y += step) {
        var majorY = (y / step) % 5 === 0;
        parts.push('<line x1="0" y1="' + y + '" x2="' + w + '" y2="' + y +
          '" stroke-width="' + (majorY ? 2 : 1) + '" opacity="' + (majorY ? 0.5 : 0.22) + '"/>');
      }
      parts.push('</g>');
      return parts.join('');
    },

    /**
     * Силуэт дома с окнами.
     *
     * Важна именно форма: россыпь окон во весь кадр читается как
     * текстура обоев, а не как здание. Поэтому рисуются три секции
     * разной высоты, стоящие на линии земли, и окна живут только
     * внутри них. Высота главной секции берётся из этажности объекта,
     * так что девятиэтажка и башня выглядят по-разному.
     */
    facade: function (w, h, o) {
      var floors = Math.max(5, Math.min(o.floors || 14, 30));
      var ground = h * 0.9;
      var floorH = Math.min(46, (ground - h * 0.1) / floors);

      // Боковые секции ниже главной — так силуэт перестаёт быть
      // прямоугольником и читается как дом, а не как столб.
      var sections = [
        { w: w * 0.26, floors: Math.max(4, Math.round(floors * 0.62)), cols: 3 },
        { w: w * 0.34, floors: floors, cols: 4 },
        { w: w * 0.24, floors: Math.max(4, Math.round(floors * 0.78)), cols: 3 },
      ];
      var totalW = sections.reduce(function (a, s) { return a + s.w; }, 0);
      var x0 = (w - totalW) / 2;

      var rand = rng(o.seed || floors * 7 + 11);
      var body = [];
      var dim = [];
      var lit = [];

      for (var i = 0; i < sections.length; i += 1) {
        var sec = sections[i];
        var top = ground - sec.floors * floorH;
        body.push('<rect x="' + x0.toFixed(1) + '" y="' + top.toFixed(1) +
          '" width="' + sec.w.toFixed(1) + '" height="' + (ground - top).toFixed(1) + '"/>');

        var cw = sec.w / sec.cols;
        var winW = cw * 0.46;
        var winH = floorH * 0.42;
        for (var r = 0; r < sec.floors; r += 1) {
          for (var c = 0; c < sec.cols; c += 1) {
            var wx = x0 + c * cw + (cw - winW) / 2;
            var wy = top + r * floorH + (floorH - winH) / 2;
            var cell = '<rect x="' + wx.toFixed(1) + '" y="' + wy.toFixed(1) +
              '" width="' + winW.toFixed(1) + '" height="' + winH.toFixed(1) + '" rx="1.5"/>';
            if (rand() > 0.72) lit.push(cell);
            else dim.push(cell);
          }
        }
        x0 += sec.w;
      }

      return [
        // Корпус чуть светлее фона — силуэт виден даже там, где окон нет.
        '<g fill="' + o.color + '" opacity="0.07">' + body.join('') + '</g>',
        '<g fill="' + o.color + '" opacity="0.16">' + dim.join('') + '</g>',
        '<g fill="' + o.accent + '" opacity="0.9">' + lit.join('') + '</g>',
        '<line x1="0" y1="' + ground.toFixed(1) + '" x2="' + w + '" y2="' + ground.toFixed(1) +
          '" stroke="' + o.color + '" stroke-width="1.5" opacity="0.22"/>',
      ].join('');
    },

    /** Концентрические дуги — язык карт доступности. */
    rings: function (w, h, o) {
      var cx = w * 0.5;
      var cy = h * 0.42;
      var parts = ['<g stroke="' + o.color + '" fill="none">'];
      for (var i = 1; i <= 7; i += 1) {
        var r = (o.step || 150) * i;
        parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r +
          '" stroke-width="' + (i % 3 === 0 ? 2.5 : 1.2) + '" opacity="' + (0.42 - i * 0.04).toFixed(3) + '"/>');
      }
      parts.push('</g>');
      return parts.join('');
    },

    /** Лучи из нижнего угла — направление, движение. */
    rays: function (w, h, o) {
      var ox = -w * 0.15;
      var oy = h * 1.1;
      var parts = ['<g stroke="' + o.color + '" fill="none" stroke-width="' + (o.step || 46) + '">'];
      for (var i = 0; i < 9; i += 1) {
        var angle = (-78 + i * 9.5) * Math.PI / 180;
        parts.push('<line x1="' + ox + '" y1="' + oy +
          '" x2="' + (ox + Math.cos(angle) * h * 2).toFixed(0) +
          '" y2="' + (oy + Math.sin(angle) * h * 2).toFixed(0) +
          '" opacity="' + (i % 2 ? 0.10 : 0.18) + '"/>');
      }
      parts.push('</g>');
      return parts.join('');
    },

    /** Обмерная линейка: длинные и короткие засечки. */
    ticks: function (w, h, o) {
      var step = o.step || 28;
      var parts = ['<g stroke="' + o.color + '">'];
      for (var x = 0, i = 0; x <= w; x += step, i += 1) {
        var long = i % 5 === 0;
        parts.push('<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + (long ? 26 : 13) +
          '" stroke-width="' + (long ? 2.5 : 1.5) + '" opacity="' + (long ? 0.7 : 0.35) + '"/>');
      }
      parts.push('</g>');
      return parts.join('');
    },

    /**
     * Зерно. Заливка без текстуры в видео выглядит мёртвой, а на
     * тёмном фоне ещё и показывает полосы от сжатия; лёгкий шум их
     * разбивает.
     */
    noise: function (w, h, o) {
      return '<filter id="n' + (o.seed || 1) + '">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="' + (o.seed || 1) + '"/>' +
        '<feColorMatrix type="saturate" values="0"/></filter>' +
        '<rect width="' + w + '" height="' + h + '" filter="url(#n' + (o.seed || 1) + ')"/>';
    },
  };

  function buildGraphic(layer, theme) {
    var node = el('div', 'st-graphic');
    applyBox(node, layer.box);
    node.style.overflow = 'hidden';
    node.style.pointerEvents = 'none';

    var inner = el('div');
    inner.style.position = 'absolute';
    inner.style.inset = '0';
    inner.style.opacity = String(layer.strength == null ? 0.3 : layer.strength);
    inner.style.willChange = 'transform';

    var draw = GRAPHICS[layer.variant] || GRAPHICS.grid;
    var w = Math.round(layer.box.w) || 1080;
    var h = Math.round(layer.box.h) || 1920;
    inner.innerHTML = svgWrap(w, h, draw(w, h, {
      color: safeColor(layer.color, theme.text),
      accent: safeColor(layer.accent, theme.accent),
      step: layer.step,
      floors: layer.floors,
      seed: layer.seed,
    }));

    node.appendChild(inner);
    return { node: node, kind: 'graphic', inner: inner };
  }

  function buildChips(layer, theme) {
    var node = el('div', 'st-chips');
    applyBox(node, layer.box);
    node.style.display = 'flex';
    node.style.flexWrap = 'wrap';
    node.style.gap = '16px';
    var chips = [];
    for (var i = 0; i < layer.items.length; i++) {
      var chip = el('span', 'st-chip');
      chip.textContent = layer.items[i];
      chip.style.display = 'inline-block';
      chip.style.padding = '18px 30px';
      chip.style.borderRadius = '999px';
      chip.style.background = layer.background || theme.surface;
      chip.style.border = '1px solid rgba(255,255,255,0.14)';
      chip.style.color = layer.color || theme.text;
      chip.style.font = '500 34px/1 ' + theme.fontBody;
      chip.style.willChange = 'transform, opacity';
      node.appendChild(chip);
      chips.push(chip);
    }
    return { node: node, kind: 'chips', chips: chips };
  }

  function buildCounter(layer, theme) {
    var node = el('div', 'st-counter');
    applyBox(node, layer.box);
    var role = TYPE[layer.role || 'price'];
    node.style.fontFamily = theme.fontDisplay;
    node.style.fontSize = px(role.size);
    node.style.lineHeight = String(role.lineHeight);
    node.style.fontWeight = String(role.weight);
    node.style.letterSpacing = (role.tracking || 0) + 'em';
    node.style.color = layer.color || theme.text;
    node.style.textAlign = layer.align || 'left';
    node.style.textShadow = '0 2px 24px rgba(0,0,0,0.45)';
    // Табличные цифры: иначе число «дёргается» по ширине пока крутится счётчик.
    node.style.fontVariantNumeric = 'tabular-nums';
    return { node: node, kind: 'counter' };
  }

  function buildProgress(layer, theme) {
    var node = el('div', 'st-progress');
    applyBox(node, layer.box);
    node.style.height = px((layer.box && layer.box.h) || layer.height || 18);
    node.style.borderRadius = '999px';
    node.style.background = layer.trackColor || 'rgba(255,255,255,0.16)';
    node.style.overflow = 'hidden';

    var fill = el('div', 'st-progress-fill');
    fill.style.height = '100%';
    fill.style.width = '0%';
    fill.style.borderRadius = '999px';
    fill.style.background = layer.color || theme.accent;
    node.appendChild(fill);
    return { node: node, kind: 'progress', fill: fill };
  }

  // ── потоковые блоки ─────────────────────────────────────────────────────

  /**
   * Элемент стека рисуется теми же сборщиками, но без абсолютной рамки:
   * высоту задаёт содержимое, а не сценарий. Благодаря этому заголовок,
   * переехавший на вторую строку, раздвигает блок вместо наложения.
   */
  function buildFlowItem(item, theme, assets, parts) {
    var node;
    var entry;

    switch (item.type) {
      case 'text':
        entry = buildText(item, theme);
        node = entry.node;
        break;
      case 'chips':
        entry = buildChips(item, theme);
        node = entry.node;
        break;
      case 'counter':
        entry = buildCounter(item, theme);
        node = entry.node;
        break;
      case 'progress':
        entry = buildProgress(item, theme);
        node = entry.node;
        node.style.height = px(item.height || 18);
        break;
      case 'grid':
        node = el('div', 'st-grid');
        node.style.display = 'grid';
        node.style.gridTemplateColumns = 'repeat(' + item.columns + ', 1fr)';
        node.style.gap = px(item.gap == null ? 20 : item.gap);
        entry = { node: node, kind: 'grid', cells: [] };
        for (var g = 0; g < item.cells.length; g++) {
          var cell = el('div', 'st-cell');
          cell.style.background = item.background || theme.surface;
          cell.style.border = '1px solid rgba(255,255,255,0.10)';
          cell.style.borderRadius = '22px';
          cell.style.padding = '32px';
          cell.style.willChange = 'transform, opacity';

          var cv = el('div');
          cv.style.font = '700 50px/1.1 ' + theme.fontDisplay;
          cv.style.color = theme.text;
          cv.style.letterSpacing = '-0.02em';
          cv.textContent = item.cells[g].value;

          var cl = el('div');
          cl.style.font = '500 27px/1.3 ' + theme.fontBody;
          cl.style.color = theme.textMuted;
          cl.style.marginTop = '12px';
          cl.textContent = item.cells[g].label;

          cell.appendChild(cv);
          cell.appendChild(cl);
          node.appendChild(cell);
          entry.cells.push(cell);
        }
        break;
      case 'badge':
        node = el('div', 'st-badge-wrap');
        var badge = el('span', 'st-badge');
        badge.textContent = item.text;
        badge.style.display = 'inline-block';
        badge.style.padding = '14px 26px';
        badge.style.borderRadius = '14px';
        badge.style.background = item.background;
        badge.style.color = item.color;
        badge.style.font = '700 30px/1 ' + theme.fontBody;
        badge.style.letterSpacing = '0.04em';
        node.appendChild(badge);
        entry = { node: node, kind: 'rect' };
        break;
      case 'rule':
        node = el('div', 'st-rule');
        node.style.width = px(item.width);
        node.style.height = px(item.height);
        node.style.background = item.color;
        node.style.borderRadius = '999px';
        node.style.flex = 'none';
        entry = { node: node, kind: 'rect' };
        break;
      case 'panel':
        node = el('div', 'st-panel');
        node.style.background = item.background;
        node.style.borderRadius = px(item.radius == null ? 26 : item.radius);
        node.style.padding = px(item.padding == null ? 36 : item.padding);
        node.style.display = 'flex';
        node.style.flexDirection = 'column';
        node.style.gap = '10px';
        node.style.border = '1px solid rgba(255,255,255,0.10)';
        entry = { node: node, kind: 'rect' };
        for (var i = 0; i < item.items.length; i++) {
          node.appendChild(buildFlowItem(item.items[i], theme, assets, parts));
        }
        break;
      default:
        node = el('div');
        entry = { node: node, kind: 'rect' };
    }

    // Абсолютное позиционирование из общих сборщиков потоку мешает.
    node.style.position = 'static';
    node.style.left = '';
    node.style.top = '';
    node.style.width = item.type === 'rule' ? px(item.width) : '100%';
    node.style.willChange = 'transform, opacity';
    if (item.gapBefore) node.style.marginTop = px(item.gapBefore);

    entry.layer = item;
    parts.push(entry);
    return node;
  }

  function buildStack(layer, theme, assets, frameHeight) {
    var node = el('div', 'st-stack');
    node.style.position = 'absolute';
    node.style.left = px(layer.box.x);
    node.style.width = px(layer.box.w);
    if (layer.anchor === 'bottom') {
      node.style.bottom = px(frameHeight - layer.box.y);
    } else {
      node.style.top = px(layer.box.y);
    }
    node.style.display = 'flex';
    node.style.flexDirection = 'column';
    node.style.alignItems = 'stretch';
    node.style.gap = px(layer.gap == null ? 18 : layer.gap);

    var parts = [];
    for (var i = 0; i < layer.items.length; i++) {
      node.appendChild(buildFlowItem(layer.items[i], theme, assets, parts));
    }
    return { node: node, kind: 'stack', parts: parts };
  }

  var BUILDERS = {
    text: buildText,
    image: buildImage,
    rect: buildRect,
    gradient: buildGradient,
    chips: buildChips,
    counter: buildCounter,
    progress: buildProgress,
    graphic: buildGraphic
  };

  // ── применение кадра ────────────────────────────────────────────────────

  function applyLayer(entry, layer, localFrame, sceneDuration, motionDuration) {
    var node = entry.node;

    // Контейнер стека не анимируется сам — анимируются его элементы,
    // иначе вложенные задержки схлопнулись бы в одну общую.
    if (entry.kind === 'stack') {
      node.style.opacity = '1';
      node.style.transform = 'none';
      for (var si = 0; si < entry.parts.length; si++) {
        applyLayer(entry.parts[si], entry.parts[si].layer, localFrame, sceneDuration, motionDuration);
      }
      return;
    }

    var inAnim = layer.anim && layer.anim.in;
    var outAnim = layer.anim && layer.anim.out;

    var opacity = layer.opacity == null ? 1 : layer.opacity;
    var transform = '';
    var clip = '';

    if (inAnim) {
      var p = animProgress(inAnim, localFrame);
      switch (inAnim.type) {
        case 'fade':
          opacity *= p;
          break;
        case 'fadeUp':
          opacity *= p;
          transform += ' translateY(' + ((1 - p) * (inAnim.distance || 48)).toFixed(2) + 'px)';
          break;
        case 'fadeDown':
          opacity *= p;
          transform += ' translateY(' + (-(1 - p) * (inAnim.distance || 48)).toFixed(2) + 'px)';
          break;
        case 'scaleIn':
          opacity *= clamp01(p * 1.6);
          transform += ' scale(' + (0.86 + 0.14 * p).toFixed(4) + ')';
          break;
        case 'wipeUp':
          clip = 'inset(' + ((1 - p) * 100).toFixed(2) + '% 0 0 0)';
          break;
        case 'slideLeft':
          transform += ' scaleX(' + p.toFixed(4) + ')';
          node.style.transformOrigin = 'left center';
          break;
        case 'slideRight':
          transform += ' scaleX(' + p.toFixed(4) + ')';
          node.style.transformOrigin = 'right center';
          break;
        default:
          opacity *= p;
      }
    }

    if (outAnim) {
      var q = animProgress(outAnim, localFrame);
      if (outAnim.type === 'fade') opacity *= 1 - q;
    }

    // Медленный дрейф фоновой графики: статичный узор за 3 секунды
    // приедается, а смещение на несколько пикселей оживляет кадр,
    // не перетягивая внимание на себя.
    if (entry.kind === 'graphic' && layer.drift) {
      var motion = motionDuration || sceneDuration;
      var dp = motion > 1 ? localFrame / (motion - 1) : 1;
      var dx = (layer.drift.x || 0) * dp;
      var dy = (layer.drift.y || 0) * dp;
      var ds = 1 + (layer.drift.scale || 0) * dp;
      entry.inner.style.transform =
        'translate(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px) scale(' + ds.toFixed(4) + ')';
    }

    // Ken Burns живёт всю сцену и не зависит от in/out анимаций.
    if (entry.kind === 'image' && layer.ken) {
      var kenSpan = motionDuration || sceneDuration;
      var k = ease(layer.ken.easing || 'linear', kenSpan > 1 ? localFrame / (kenSpan - 1) : 1);
      var scale = layer.ken.fromScale + (layer.ken.toScale - layer.ken.fromScale) * k;
      var tx = (layer.ken.fromX || 0) + ((layer.ken.toX || 0) - (layer.ken.fromX || 0)) * k;
      var ty = (layer.ken.fromY || 0) + ((layer.ken.toY || 0) - (layer.ken.fromY || 0)) * k;
      entry.img.style.transform =
        'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) scale(' + scale.toFixed(4) + ')';
    }

    if (entry.kind === 'counter') {
      var cp = layer.dur > 0 ? ease(layer.easing, (localFrame - layer.at) / layer.dur) : 1;
      var value = layer.from + (layer.to - layer.from) * cp;
      var body = layer.grouped ? groupDigits(value) : String(Math.round(value));
      node.textContent = (layer.prefix || '') + body + (layer.suffix || '');
    }

    if (entry.kind === 'progress') {
      var pp = layer.dur > 0 ? ease('expoOut', (localFrame - layer.at) / layer.dur) : 1;
      entry.fill.style.width = (layer.value * pp).toFixed(2) + '%';
    }

    // Ячейки сетки всплывают по очереди — иначе четыре блока появляются
    // одним прямоугольником и читаются как одна плашка.
    if (entry.kind === 'grid') {
      var gStagger = layer.stagger == null ? 4 : layer.stagger;
      var gAt = layer.at || 0;
      for (var gi = 0; gi < entry.cells.length; gi++) {
        var gp = ease('expoOut', (localFrame - gAt - gi * gStagger) / 14);
        entry.cells[gi].style.opacity = String(gp);
        entry.cells[gi].style.transform = 'translateY(' + ((1 - gp) * 28).toFixed(2) + 'px)';
      }
      node.style.opacity = '1';
      node.style.transform = 'none';
      node.style.clipPath = 'none';
      return;
    }

    if (entry.kind === 'chips') {
      var stagger = layer.stagger || 5;
      var base = inAnim ? inAnim.at : 0;
      var dur = inAnim ? inAnim.dur : 12;
      for (var i = 0; i < entry.chips.length; i++) {
        var cpr = ease('expoOut', (localFrame - base - i * stagger) / dur);
        entry.chips[i].style.opacity = String(cpr);
        entry.chips[i].style.transform = 'translateY(' + ((1 - cpr) * 24).toFixed(2) + 'px)';
      }
      // Контейнер чипов анимируется поэлементно, сам остаётся непрозрачным.
      opacity = layer.opacity == null ? 1 : layer.opacity;
      transform = '';
    }

    node.style.opacity = String(clamp01(opacity));
    node.style.transform = transform || 'none';
    node.style.clipPath = clip || 'none';
  }

  // ── сцена ───────────────────────────────────────────────────────────────

  function Stage(root) {
    this.root = root;
    this.timeline = null;
    this.scenes = [];
    this.assets = [];
    this.frame = -1;
    this._raf = null;
    this._playStartedAt = 0;
    this._playFromFrame = 0;
    this.onFrame = null;
  }

  Stage.prototype.mount = function (timeline) {
    this.pause();
    this.timeline = timeline;
    this.scenes = [];
    this.assets = [];
    this.root.innerHTML = '';
    this.root.style.width = px(timeline.width);
    this.root.style.height = px(timeline.height);
    this.root.style.background = timeline.theme.bg;
    this.root.style.position = 'relative';
    this.root.style.overflow = 'hidden';

    for (var s = 0; s < timeline.scenes.length; s++) {
      var def = timeline.scenes[s];
      var holder = el('div', 'st-scene');
      holder.style.position = 'absolute';
      holder.style.inset = '0';
      holder.style.zIndex = String(s + 1);
      holder.style.background = def.background || 'transparent';
      holder.style.willChange = 'opacity, transform';

      var entries = [];
      var sorted = def.layers.slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); });
      for (var l = 0; l < sorted.length; l++) {
        var layer = sorted[l];
        var entry;
        if (layer.kind === 'stack') {
          entry = buildStack(layer, timeline.theme, this.assets, timeline.height);
        } else {
          var builder = BUILDERS[layer.kind];
          if (!builder) continue;
          entry = builder(layer, timeline.theme, this.assets);
        }
        entry.layer = layer;
        entry.node.style.zIndex = String(layer.z || 0);
        holder.appendChild(entry.node);
        entries.push(entry);
      }

      this.root.appendChild(holder);
      this.scenes.push({ def: def, holder: holder, entries: entries });
    }

    this.frame = -1;
    this.seek(0);
    return this;
  };

  Stage.prototype.seek = function (frame) {
    if (!this.timeline) return;
    var f = Math.max(0, Math.min(Math.round(frame), this.timeline.durationInFrames - 1));
    this.frame = f;

    for (var s = 0; s < this.scenes.length; s++) {
      var entry = this.scenes[s];
      var def = entry.def;
      var next = this.scenes[s + 1];
      // Сцена доживает до конца перехода следующей — это и даёт кроссфейд.
      var tail = next && next.def.transition ? next.def.transition.dur : 0;
      var local = f - def.from;
      var visible = local >= 0 && local < def.duration + tail;

      if (!visible) {
        entry.holder.style.display = 'none';
        continue;
      }
      entry.holder.style.display = 'block';

      var trans = def.transition || { type: 'cut', dur: 0 };
      /**
       * Кроссфейд идёт строго линейно.
       *
       * Любая кривая с ускорением даёт пик скорости: easeOut прыгал на
       * первом кадре, easeInOut — в середине. А заметен именно пик:
       * переход с тёмной сцены на белый лист планировки меняет яркость
       * кадра примерно на 200 единиц, и вопрос лишь в том, размазано
       * это по всем кадрам перехода или собрано в три. При равномерной
       * скорости максимальный шаг минимален — это свойство прямой,
       * а не вкусовое предпочтение.
       */
      var tp = trans.dur > 0 ? ease('linear', local / trans.dur) : 1;
      entry.holder.style.opacity = String(clamp01(tp));
      if (trans.type === 'slideUp') {
        entry.holder.style.transform = 'translateY(' + ((1 - tp) * 120).toFixed(2) + 'px)';
      } else if (trans.type === 'whip') {
        entry.holder.style.transform = 'translateX(' + ((1 - tp) * 180).toFixed(2) + 'px)';
      } else {
        entry.holder.style.transform = 'none';
      }

      /**
       * Во время перехода уходящая сцена продолжает жить.
       *
       * Раньше её кадр подмораживался на последнем значении, пока
       * сверху проявлялась следующая: панорама по фотографии вставала,
       * и этот стоп-кадр читался как рывок — каждый стык между сценами
       * выглядел подёргиванием. Длительность для движения берётся
       * вместе с хвостом, поэтому панорама и дрейф идут без остановки
       * до самого конца наложения.
       */
      var motionDuration = def.duration + tail;
      for (var i = 0; i < entry.entries.length; i++) {
        applyLayer(entry.entries[i], entry.entries[i].layer, local, def.duration, motionDuration);
      }
    }

    if (this.onFrame) this.onFrame(f, this.timeline.durationInFrames);
  };

  /** Дожидается картинок. Битые не блокируют: сцена их просто скрывает. */
  Stage.prototype.waitAssets = function (timeoutMs) {
    var assets = this.assets;
    var limit = timeoutMs || 20000;
    var pending = assets.map(function (img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function (resolve) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    });
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    return Promise.race([
      Promise.all(pending.concat([fonts])),
      new Promise(function (resolve) { setTimeout(resolve, limit); })
    ]).then(function () {
      return {
        total: assets.length,
        failed: assets.filter(function (i) { return !i.naturalWidth; }).length
      };
    });
  };

  Stage.prototype.play = function (fromFrame) {
    if (!this.timeline) return;
    var self = this;
    this.pause();
    this._playFromFrame = fromFrame == null ? (this.frame >= this.timeline.durationInFrames - 1 ? 0 : this.frame) : fromFrame;
    this._playStartedAt = performance.now();

    var tick = function (now) {
      var elapsed = (now - self._playStartedAt) / 1000;
      var frame = self._playFromFrame + elapsed * self.timeline.fps;
      if (frame >= self.timeline.durationInFrames) {
        self.seek(0);
        self._playFromFrame = 0;
        self._playStartedAt = now;
      } else {
        self.seek(frame);
      }
      self._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  };

  Stage.prototype.pause = function () {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  };

  Stage.prototype.isPlaying = function () { return this._raf !== null; };

  global.Stage = Stage;
  global.__stageEasings = EASINGS;
})(window);
