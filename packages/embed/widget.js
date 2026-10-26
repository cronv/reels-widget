/**
 * Логика виджета.
 *
 * Состояние держится в одном объекте и всегда идёт в одну сторону:
 * источник → карточка → сценарий → таймлайн → превью → экспорт.
 * Превью живёт в отдельном iframe со сценой и общается с ней через
 * postMessage, поэтому стили сайта-носителя не могут повлиять на кадр.
 */

(function () {
  'use strict';

  var API = (function () {
    var self = document.currentScript;
    var attr = self && self.dataset ? self.dataset.api : null;
    if (attr) return attr.replace(/\/$/, '');
    var q = new URLSearchParams(location.search).get('api');
    return (q || location.origin).replace(/\/$/, '');
  })();

  var state = {
    card: null,
    /** Откуда пришла карточка: профиль сайта и счётчик характеристик. */
    meta: null,
    scenarios: [],
    selected: null,
    timeline: null,
    duration: 0,
    playing: false,
    job: null,
    poll: null,
  };

  var $ = function (id) { return document.getElementById(id); };
  var stageFrame = $('stage');

  // ── обмен с сервером ──────────────────────────────────────────────────

  function api(route, body) {
    return fetch(API + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Запрос не прошёл');
        return data;
      });
    });
  }

  function busy(button, on, labelWhenBusy) {
    if (!button) return;
    if (on) {
      button.dataset.label = button.textContent;
      button.textContent = labelWhenBusy || 'Подождите…';
      button.disabled = true;
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.disabled = false;
    }
  }

  function note(container, kind, title, items) {
    var div = document.createElement('div');
    div.className = 'note note--' + kind;
    div.textContent = title;
    if (items && items.length) {
      var ul = document.createElement('ul');
      items.forEach(function (i) {
        var li = document.createElement('li');
        li.textContent = i;
        ul.appendChild(li);
      });
      div.appendChild(ul);
    }
    container.appendChild(div);
    return div;
  }

  // ── вкладки источника ─────────────────────────────────────────────────

  ['feed', 'url', 'manual'].forEach(function (name) {
    $('tab-' + name).addEventListener('click', function () {
      ['feed', 'url', 'manual'].forEach(function (other) {
        var isMe = other === name;
        $('tab-' + other).setAttribute('aria-selected', String(isMe));
        $('pane-' + other).classList.toggle('is-active', isMe);
      });
    });
  });

  // ── источник: фид ─────────────────────────────────────────────────────

  function handleFeed(payload, button) {
    var out = $('feed-result');
    out.innerHTML = '';
    busy(button, true, 'Разбираю…');
    api('/api/extract/feed', payload)
      .then(function (data) {
        if (data.warnings.length) note(out, 'warn', 'Разбор прошёл с замечаниями:', data.warnings);
        if (!data.cards.length) {
          note(out, 'err', 'В фиде не нашлось объектов.');
          return;
        }
        if (data.cards.length === 1) {
          useCard(data.cards[0]);
          return;
        }
        renderPicker(out, data.cards, data.total);
      })
      .catch(function (err) { note(out, 'err', err.message); })
      .finally(function () { busy(button, false); });
  }

  function renderPicker(out, cards, total) {
    var head = document.createElement('p');
    head.className = 'hint';
    head.style.marginTop = '16px';
    head.textContent = 'Нашлось объектов: ' + total + '. Выберите, из какого собирать ролик.';
    out.appendChild(head);

    var list = document.createElement('div');
    list.className = 'picker';
    cards.forEach(function (card) {
      var b = document.createElement('button');
      b.type = 'button';

      var name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = card.complex.name || 'Без названия';

      var meta = document.createElement('span');
      meta.className = 'p-meta';
      meta.textContent = [
        card.lot && card.lot.areaTotal ? String(card.lot.areaTotal).replace('.', ',') + ' м²' : null,
        card.price ? formatRub(card.price.value) : null,
      ].filter(Boolean).join('  ');

      b.appendChild(name);
      b.appendChild(meta);
      b.addEventListener('click', function () { useCard(card); });
      list.appendChild(b);
    });
    out.appendChild(list);
  }

  $('feed-parse').addEventListener('click', function () {
    var text = $('feed-text').value.trim();
    if (!text) { $('feed-result').innerHTML = ''; note($('feed-result'), 'err', 'Вставьте содержимое фида.'); return; }
    handleFeed({ payload: text }, this);
  });

  $('feed-load').addEventListener('click', function () {
    var url = $('feed-url').value.trim();
    if (!url) { $('feed-result').innerHTML = ''; note($('feed-result'), 'err', 'Укажите ссылку на выгрузку.'); return; }
    handleFeed({ url: url }, this);
  });

  $('feed-sample').addEventListener('click', function () {
    var btn = this;
    busy(btn, true, 'Загружаю…');
    fetch(API + '/examples/feed.sample.xml')
      .then(function (r) { return r.text(); })
      .then(function (text) { $('feed-text').value = text; })
      .catch(function () { note($('feed-result'), 'err', 'Пример недоступен.'); })
      .finally(function () { busy(btn, false); });
  });

  // ── источник: ссылка ──────────────────────────────────────────────────

  $('page-load').addEventListener('click', function () {
    var out = $('url-result');
    out.innerHTML = '';
    var url = $('page-url').value.trim();
    if (!url) { note(out, 'err', 'Вставьте ссылку на страницу объекта.'); return; }
    var btn = this;
    busy(btn, true, 'Читаю страницу…');
    api('/api/extract/url', { url: url })
      .then(function (data) {
        useCard(data.card, { profile: data.profile, specsMatched: data.specsMatched });
        // Крупное предупреждение со списком полей было шумом: на странице
        // комплекса «нет площади лота» — это норма, а не проблема. Чего
        // не хватает конкретному ролику, написано у самого сценария.
        if (data.missing.length) {
          var hint = document.createElement('p');
          hint.className = 'hint';
          hint.style.marginTop = '12px';
          hint.textContent = 'Не нашлось на странице: ' +
            data.missing.map(function (m) { return m.label; }).join(', ') +
            '. Дополните вручную, если нужны все сценарии.';
          out.appendChild(hint);
        }
      })
      .catch(function (err) { note(out, 'err', err.message); })
      .finally(function () { busy(btn, false); });
  });

  // ── источник: форма ───────────────────────────────────────────────────

  $('manual-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var out = $('manual-result');
    out.innerHTML = '';
    var data = {};
    new FormData(this).forEach(function (value, key) { data[key] = value; });
    data.isStudio = $('m-studio').checked;
    data.priceIsFrom = $('m-from').checked;

    var btn = this.querySelector('button[type="submit"]');
    busy(btn, true, 'Собираю…');
    api('/api/extract/manual', data)
      .then(function (res) { useCard(res.card, { specsMatched: 0 }); })
      .catch(function (err) { note(out, 'err', err.message); })
      .finally(function () { busy(btn, false); });
  });

  /** Переносит уже разобранный объект в форму, чтобы дозаполнить пробелы. */
  function fillManualForm() {
    var c = state.card;
    if (!c) return;
    var set = function (id, value) { if (value != null && value !== '') $(id).value = value; };
    set('m-name', c.complex.name);
    set('m-segment', c.complex.segment);
    set('m-city', c.complex.location.city);
    set('m-district', c.complex.location.district);
    set('m-street', c.complex.location.street || c.complex.location.raw);
    set('m-metro', c.complex.location.metro && c.complex.location.metro.name);
    set('m-metro-min', c.complex.location.metro && c.complex.location.metro.minutes);
    set('m-dev', c.complex.developer && c.complex.developer.name);
    set('m-completion', c.complex.completion);
    set('m-readiness', c.complex.readinessPercent);
    set('m-highlights', (c.complex.highlights || []).join('\n'));
    if (c.lot) {
      set('m-rooms', c.lot.rooms);
      set('m-area', c.lot.areaTotal);
      set('m-kitchen', c.lot.areaKitchen);
      set('m-floor', c.lot.floor);
      set('m-floors', c.lot.floorsTotal);
      set('m-finish', c.lot.finishing);
      $('m-studio').checked = Boolean(c.lot.isStudio);
    }
    if (c.price) {
      set('m-price', c.price.value);
      set('m-oldprice', c.price.oldValue);
      $('m-from').checked = Boolean(c.price.isFrom);
    }
    if (c.mortgage) {
      set('m-rate', c.mortgage.rate);
      set('m-program', c.mortgage.program);
    }
    if (c.promo) {
      set('m-promo', c.promo.title);
      set('m-until', c.promo.until);
    }
    if (c.contact) {
      set('m-phone', c.contact.phone);
      set('m-site', c.contact.site);
    }
    var byKind = function (kind) {
      return c.media.filter(function (m) { return m.kind === kind; }).map(function (m) { return m.url; }).join('\n');
    };
    set('m-renders', byKind('render'));
    set('m-plans', byKind('plan'));
    set('m-progress', byKind('progress'));
  }

  $('manual-fill').addEventListener('click', fillManualForm);
  $('edit-card').addEventListener('click', function () {
    fillManualForm();
    $('tab-manual').click();
    $('pane-manual').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ── карточка ──────────────────────────────────────────────────────────

  function formatRub(value) {
    return new Intl.NumberFormat('ru-RU').format(value) + ' ₽';
  }

  /** «2027-11-01» → «IV кв. 2027»; всё остальное отдаём как есть. */
  function formatCompletion(value) {
    if (!value) return null;
    var iso = /^(\d{4})-(\d{2})/.exec(value);
    if (!iso) return value;
    var q = ['I', 'I', 'I', 'II', 'II', 'II', 'III', 'III', 'III', 'IV', 'IV', 'IV'][Number(iso[2]) - 1];
    return q + ' кв. ' + iso[1];
  }

  function useCard(card, meta) {
    state.meta = meta || null;
    state.card = card;
    state.selected = null;
    state.timeline = null;
    resetPreview();
    renderCard();
    loadScenarios();
    $('sec-card').hidden = false;
    $('sec-scenario').hidden = false;
    $('sec-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderCard() {
    var c = state.card;
    var view = $('card-view');
    view.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'card-head';
    var left = document.createElement('div');

    var title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = c.complex.name || 'Название не определилось';
    left.appendChild(title);

    var place = [c.complex.location.city, c.complex.location.district, c.complex.location.street]
      .filter(Boolean).join(', ') || c.complex.location.raw;
    if (c.complex.location.metro && c.complex.location.metro.name) {
      place = (place ? place + ' · ' : '') + 'м. ' + c.complex.location.metro.name +
        (c.complex.location.metro.minutes ? ', ' + c.complex.location.metro.minutes + ' мин' : '');
    }
    if (place) {
      var sub = document.createElement('div');
      sub.className = 'card-sub';
      sub.textContent = place;
      left.appendChild(sub);
    }
    head.appendChild(left);
    view.appendChild(head);

    var facts = document.createElement('div');
    facts.className = 'facts';
    var add = function (label, value) {
      if (!value) return;
      var f = document.createElement('span');
      f.className = 'fact';
      f.textContent = label + ' ';
      var s = document.createElement('strong');
      s.textContent = value;
      f.appendChild(s);
      facts.appendChild(f);
    };
    // Показывается всё извлечённое. Урезанный список выглядел так, будто
    // парсер почти ничего не взял, хотя полей было втрое больше.
    if (c.lot) {
      add('Комнат', c.lot.isStudio ? 'студия' : c.lot.rooms);
      add('Площадь', c.lot.areaTotal ? String(c.lot.areaTotal).replace('.', ',') + ' м²' : null);
      add('Кухня', c.lot.areaKitchen ? String(c.lot.areaKitchen).replace('.', ',') + ' м²' : null);
      add('Этаж', c.lot.floor ? c.lot.floor + (c.lot.floorsTotal ? ' из ' + c.lot.floorsTotal : '') : null);
      add('Секция', c.lot.section);
      add('Корпус', c.lot.building);
      add('Отделка', c.lot.finishing);
      add('Потолки', c.lot.ceilingHeight ? String(c.lot.ceilingHeight).replace('.', ',') + ' м' : null);
    }
    if (c.price) add('Цена', formatRub(c.price.value) + (c.price.isFrom ? ' (от)' : ''));
    if (c.price && c.price.perSquareMeter) add('За м²', formatRub(c.price.perSquareMeter));
    if (c.mortgage) add('Ставка', String(c.mortgage.rate).replace('.', ',') + '%');
    if (c.mortgage && c.mortgage.monthlyPayment) add('Платёж', formatRub(c.mortgage.monthlyPayment));
    add('Сдача', formatCompletion(c.complex.completion));
    if (c.complex.readinessPercent != null) add('Готовность', c.complex.readinessPercent + '%');
    if (!c.lot || !c.lot.finishing) add('Отделка', c.complex.finishing);
    add('Этажность', c.complex.floorsTotal);
    add('Корпусов', c.complex.buildingsCount);
    add('Застройщик', c.complex.developer && c.complex.developer.name);
    if (c.complex.escrow) add('Эскроу', 'да');
    add('Телефон', c.contact && c.contact.phone);
    view.appendChild(facts);

    if (c.complex.highlights && c.complex.highlights.length) {
      var hl = document.createElement('div');
      hl.className = 'facts';
      hl.style.marginTop = '10px';
      c.complex.highlights.forEach(function (h) {
        var chip = document.createElement('span');
        chip.className = 'fact fact--accent';
        chip.textContent = h;
        hl.appendChild(chip);
      });
      view.appendChild(hl);
    }

    renderMedia(view, c);
    renderSource(view);
  }

  var KIND_LABEL = {
    render: 'рендеры', plan: 'планировки', progress: 'стройка',
    photo: 'фото', map: 'карты', logo: 'лого',
  };

  function renderMedia(view, c) {
    if (!c.media.length) {
      note(view, 'warn', 'К объекту не привязано ни одной картинки — ролики будут без фона.');
      return;
    }
    var counts = {};
    c.media.forEach(function (m) { counts[m.kind] = (counts[m.kind] || 0) + 1; });

    var summary = document.createElement('p');
    summary.className = 'hint';
    summary.style.marginTop = '14px';
    summary.textContent = 'Изображений ' + c.media.length + ': ' +
      Object.keys(counts).map(function (k) {
        return (KIND_LABEL[k] || k) + ' ' + counts[k];
      }).join(', ');
    view.appendChild(summary);

    var thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    var broken = 0;
    c.media.slice(0, 8).forEach(function (m) {
      var img = document.createElement('img');
      img.src = m.url;
      img.alt = KIND_LABEL[m.kind] || m.kind;
      img.title = m.caption || KIND_LABEL[m.kind] || m.kind;
      img.loading = 'lazy';
      img.addEventListener('error', function () {
        this.classList.add('is-broken');
        broken += 1;
        hintBroken.hidden = false;
      });
      thumbs.appendChild(img);
    });
    view.appendChild(thumbs);

    var hintBroken = document.createElement('p');
    hintBroken.className = 'hint';
    hintBroken.style.marginTop = '8px';
    hintBroken.hidden = true;
    hintBroken.textContent = 'Часть миниатюр не открылась. В ролике эти кадры тоже будут пустыми — ' +
      'проверьте, что ссылки доступны без авторизации и хостинг не закрывает хотлинк.';
    view.appendChild(hintBroken);
  }

  /** Откуда взялись данные: без этого непонятно, почему полей мало. */
  function renderSource(view) {
    var m = state.meta;
    if (!m) return;
    var p = document.createElement('p');
    p.className = 'hint';
    p.style.marginTop = '12px';
    p.textContent = (m.profile
      ? 'Профиль сайта: ' + m.profile.label + '.'
      : 'Профиль сайта не определён — сработал универсальный разбор.') +
      ' Характеристик распознано: ' + (m.specsMatched || 0) + '.';
    view.appendChild(p);
  }

  // ── сценарии ──────────────────────────────────────────────────────────

  function loadScenarios() {
    api('/api/timeline/available', { card: state.card })
      .then(function (data) {
        state.scenarios = data.scenarios;
        renderScenarios();
        var first = data.scenarios.find(function (s) { return s.available; });
        if (first) selectScenario(first.id);
      })
      .catch(function (err) { note($('card-view'), 'err', err.message); });
  }

  function renderScenarios() {
    var box = $('scenarios');
    box.innerHTML = '';
    state.scenarios.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'scenario';
      b.disabled = !s.available;
      b.setAttribute('aria-pressed', String(state.selected === s.id));

      var bar = document.createElement('span');
      bar.className = 'bar';

      var body = document.createElement('span');
      body.className = 'body';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = s.title;
      var desc = document.createElement('span');
      desc.className = 'desc';
      desc.textContent = s.description;
      body.appendChild(name);
      body.appendChild(desc);
      if (!s.available) {
        var lack = document.createElement('span');
        lack.className = 'lack';
        lack.textContent = 'Не хватает: ' + s.missing.join(', ');
        body.appendChild(lack);
      }

      var secs = document.createElement('span');
      secs.className = 'secs';
      secs.textContent = s.seconds + ' с';

      b.appendChild(bar);
      b.appendChild(body);
      b.appendChild(secs);
      b.addEventListener('click', function () { selectScenario(s.id); });
      box.appendChild(b);
    });
  }

  function selectScenario(id) {
    state.selected = id;
    renderScenarios();
    $('status').textContent = '';
    $('status').className = 'status';
    $('done').innerHTML = '';
    $('progress-track').hidden = true;

    api('/api/timeline', { card: state.card, scenario: id })
      .then(function (data) {
        state.timeline = data.timeline;
        mountPreview(data.timeline);
        $('export').disabled = false;
        if (data.timeline.warnings.length) {
          $('status').textContent = data.timeline.warnings[0];
        }
      })
      .catch(function (err) {
        $('status').textContent = err.message;
        $('status').className = 'status status--err';
      });
  }

  // ── превью ────────────────────────────────────────────────────────────

  function resetPreview() {
    state.duration = 0;
    state.playing = false;
    $('play').disabled = true;
    $('scrub').disabled = true;
    $('scrub').value = '0';
    $('export').disabled = true;
    $('time').textContent = '0,0 / 0,0';
  }

  /**
   * Номер монтирования. Сцена отвечает асинхронно, и без этого счётчика
   * ответ от предыдущего таймлайна перезаписывал бы статус текущего.
   */
  var mountSeq = 0;

  function mountPreview(timeline) {
    mountSeq += 1;
    var seq = mountSeq;
    $('stage-empty').hidden = true;
    var src = API + '/stage/stage.html?fit=1';
    if (stageFrame.dataset.ready === '1' && stageFrame.src.indexOf('/stage/stage.html') !== -1) {
      send({ type: 'mount', timeline: timeline, seq: seq });
    } else {
      stageFrame.addEventListener('load', function onLoad() {
        stageFrame.removeEventListener('load', onLoad);
        stageFrame.dataset.ready = '1';
        send({ type: 'mount', timeline: timeline, seq: seq });
      });
      stageFrame.src = src;
    }
  }

  function send(message) {
    if (!stageFrame.contentWindow) return;
    message.source = 'reels-widget';
    stageFrame.contentWindow.postMessage(message, '*');
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== 'reels-stage') return;
    if (data.type === 'ready') {
      if (data.seq !== mountSeq) return; // ответ устаревшего монтирования
      state.duration = data.duration;
      $('play').disabled = false;
      $('scrub').disabled = false;
      $('scrub').max = String(data.duration - 1);
      // Нулевой кадр почти пустой: весь текст в этот момент ещё
      // проявляется. Показываем кадр, на котором первая сцена уже
      // собралась, — иначе превью выглядит как чёрный прямоугольник.
      var poster = Math.min(45, data.duration - 1);
      $('scrub').value = String(poster);
      send({ type: 'seek', frame: poster });
      updateTime(poster);
      if (data.assets && data.assets.failed) {
        $('status').textContent = 'Не загрузилось изображений: ' + data.assets.failed +
          '. Проверьте, что ссылки открываются без авторизации.';
      }
    }
    if (data.type === 'frame') {
      $('scrub').value = String(data.frame);
      state.playing = data.playing;
      updateTime(data.frame);
      setPlayIcon(data.playing);
    }
  });

  function updateTime(frame) {
    var fps = state.timeline ? state.timeline.fps : 30;
    var total = state.duration / fps;
    $('time').textContent = (frame / fps).toFixed(1).replace('.', ',') + ' / ' + total.toFixed(1).replace('.', ',');
  }

  function setPlayIcon(playing) {
    $('play-icon').innerHTML = playing
      ? '<path d="M3 2h4v12H3zM9 2h4v12H9z"/>'
      : '<path d="M3 1.5v13l11-6.5z"/>';
    $('play').setAttribute('aria-label', playing ? 'Пауза' : 'Запустить');
  }

  $('play').addEventListener('click', function () { send({ type: 'toggle' }); });
  $('scrub').addEventListener('input', function () { send({ type: 'seek', frame: Number(this.value) }); });

  // ── экспорт ───────────────────────────────────────────────────────────

  $('export').addEventListener('click', function () {
    if (!state.card || !state.selected) return;
    var btn = this;
    busy(btn, true, 'Ставлю в очередь…');
    $('done').innerHTML = '';
    $('progress-track').hidden = false;
    $('progress-fill').style.width = '0%';
    $('status').className = 'status';
    $('status').textContent = 'Готовлю рендер…';

    api('/api/render', { card: state.card, scenario: state.selected })
      .then(function (data) {
        state.job = data.job;
        pollJob(data.job.id, btn);
      })
      .catch(function (err) {
        busy(btn, false);
        $('progress-track').hidden = true;
        $('status').textContent = err.message;
        $('status').className = 'status status--err';
      });
  });

  function pollJob(id, btn) {
    clearInterval(state.poll);
    state.poll = setInterval(function () {
      fetch(API + '/api/jobs/' + id)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var job = data.job;
          $('progress-fill').style.width = Math.round(job.progress * 100) + '%';
          if (job.status === 'queued') {
            $('status').textContent = 'В очереди: ' + data.queue.waiting + ' перед вами';
          } else if (job.status === 'running') {
            $('status').textContent = 'Рендер ' + Math.round(job.progress * 100) + '%';
          } else if (job.status === 'done') {
            clearInterval(state.poll);
            busy(btn, false);
            showDone(job);
          } else if (job.status === 'error') {
            clearInterval(state.poll);
            busy(btn, false);
            $('progress-track').hidden = true;
            $('status').textContent = job.error;
            $('status').className = 'status status--err';
          }
        })
        .catch(function () { /* сеть моргнула — следующий тик попробует снова */ });
    }, 900);
  }

  function showDone(job) {
    var r = job.result;
    $('status').className = 'status status--ok';
    $('status').textContent = 'Готово: ' + r.seconds + ' с, ' + (r.bytes / 1024 / 1024).toFixed(1) + ' МБ';

    var box = $('done');
    box.innerHTML = '';

    var actions = document.createElement('div');
    actions.className = 'done-actions';

    var download = document.createElement('a');
    download.className = 'btn';
    download.href = r.videoUrl;
    download.download = r.fileName;
    download.textContent = 'Скачать MP4';
    actions.appendChild(download);

    var again = document.createElement('button');
    again.className = 'btn btn--ghost';
    again.type = 'button';
    again.textContent = 'Собрать заново';
    again.addEventListener('click', function () { selectScenario(state.selected); });
    actions.appendChild(again);

    box.appendChild(actions);

    if (r.caption) {
      var wrap = document.createElement('div');
      wrap.className = 'caption-box';
      var label = document.createElement('label');
      label.setAttribute('for', 'caption-text');
      label.textContent = 'Текст для описания поста';
      var ta = document.createElement('textarea');
      ta.id = 'caption-text';
      ta.value = r.caption;
      wrap.appendChild(label);
      wrap.appendChild(ta);

      var copy = document.createElement('button');
      copy.className = 'btn btn--ghost btn--small';
      copy.type = 'button';
      copy.textContent = 'Скопировать текст';
      copy.style.marginTop = '8px';
      copy.addEventListener('click', function () {
        ta.select();
        navigator.clipboard.writeText(ta.value).then(function () {
          copy.textContent = 'Скопировано';
          setTimeout(function () { copy.textContent = 'Скопировать текст'; }, 1600);
        }).catch(function () { document.execCommand('copy'); });
      });
      wrap.appendChild(copy);
      box.appendChild(wrap);
    }

    if (r.warnings && r.warnings.length) {
      note(box, 'warn', 'На что обратить внимание:', r.warnings);
    }
  }

  // ── запуск из модального окна на сайте ────────────────────────────────

  var params = new URLSearchParams(location.search);

  /**
   * Подставляет адрес страницы-носителя и, если не запрещено, сразу
   * запускает разбор. Смысл виджета в том, что менеджер уже стоит на
   * нужной странице: заставлять его копировать оттуда ссылку значит
   * терять ровно тот шаг, ради которого всё и делалось.
   */
  function usePageUrl(url, shouldParse) {
    if (!url) return;
    $('tab-url').click();
    $('page-url').value = url;
    if (shouldParse) $('page-load').click();
  }

  if (params.get('embedded') === '1') {
    document.body.classList.add('is-embedded');
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.source !== 'reels-widget-host') return;
    if (msg.type === 'page') usePageUrl(msg.url, msg.autoparse !== false);
  });

  usePageUrl(params.get('page'), params.get('autoparse') !== '0');

  // Сообщаем носителю, какой высоты получился виджет.
  function reportHeight() {
    if (window.parent === window) return;
    var h = document.documentElement.scrollHeight;
    window.parent.postMessage({ source: 'reels-widget-frame', type: 'height', height: h }, '*');
  }
  new ResizeObserver(reportHeight).observe(document.body);
  window.addEventListener('load', reportHeight);
})();
