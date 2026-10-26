/**
 * Лёгкий сканер HTML — ровно под нужды парсера карточек.
 *
 * Полный DOM тут не нужен: из страницы берутся JSON-LD, meta-теги, картинки,
 * заголовки, пункты списков и текст без разметки. Сканер однопроходный и не
 * строит дерево, поэтому его не ломает невалидная вёрстка — а она на сайтах
 * застройщиков скорее правило, чем исключение.
 *
 * Помимо этого сканер собирает пары «характеристика — значение». Сайты
 * новостроек почти всегда показывают параметры лота таблицей или списком
 * определений, и вытащить «Общая площадь → 62,4 м²» напрямую куда надёжнее,
 * чем ловить то же число регуляркой по сплошному тексту страницы.
 */

import { decodeEntities } from './xml.js';

export interface HtmlNode {
  tag: string;
  id?: string;
  cls?: string;
  /** Глубина вложенности — по ней ищутся соседние элементы. */
  depth: number;
  /** Весь текст внутри элемента, схлопнутые пробелы. */
  text: string;
}

export interface LabelValue {
  label: string;
  value: string;
  /** Откуда взято — помогает отлаживать профили сайтов. */
  from: 'table' | 'dl' | 'siblings' | 'inline';
}

export interface HtmlLink {
  href: string;
  text: string;
  cls?: string;
  /** id ближайшего предка — по нему видно, из какой секции ссылка. */
  section?: string;
  /** Все атрибуты: сайты кладут в них готовые данные об объекте. */
  attrs: Record<string, string>;
}

export interface HtmlScan {
  /** meta-теги: ключ — name или property в нижнем регистре. */
  metas: Record<string, string>;
  /** Содержимое <script> с их атрибутом type. */
  scripts: { type: string; content: string }[];
  /**
   * Атрибуты каждого <img>. Дополнительно кладётся `__section` —
   * id ближайшего предка: галереи почти всегда разложены по вкладкам
   * (`#objectPhotos`, `#objectPlan`), и это единственный надёжный способ
   * отличить рендер от планировки, не угадывая по имени файла.
   */
  images: Record<string, string>[];
  links: HtmlLink[];
  /** Текст по тегам, которые нас интересуют: title, h1..h3, li. */
  texts: { tag: string; text: string }[];
  /** Элементы с классом или id и непустым текстом. */
  nodes: HtmlNode[];
  /** Пары «характеристика — значение», собранные из разметки. */
  pairs: LabelValue[];
  /** Весь видимый текст страницы, схлопнутые пробелы. */
  text: string;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe']);
const CAPTURE_TEXT = new Set(['title', 'h1', 'h2', 'h3', 'h4', 'li']);

const MAX_NODES = 6000;
const MAX_NODE_TEXT = 400;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:@.-]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const name = m[1];
    if (!name) continue;
    attrs[name.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

interface Frame {
  name: string;
  id?: string;
  cls?: string;
  depth: number;
  /** Копим текст, только если элемент может попасть в nodes или texts. */
  buf: string | null;
  /** Заполняется только для <a>. */
  href?: string;
  section?: string;
  attrs?: Record<string, string>;
  /** Ячейки текущей строки таблицы. */
  cells?: string[];
  /** Пары текущего списка определений. */
  terms?: { label?: string; value?: string }[];
}

export function scanHtml(source: string, limit = 2_500_000): HtmlScan {
  const html = source.length > limit ? source.slice(0, limit) : source;
  const scan: HtmlScan = {
    metas: {}, scripts: [], images: [], links: [], texts: [], nodes: [], pairs: [], text: '',
  };

  const textParts: string[] = [];
  const stack: Frame[] = [];
  let muted = 0;

  let i = 0;
  const len = html.length;

  const pushText = (raw: string): void => {
    if (!raw) return;
    const decoded = decodeEntities(raw);
    // Текст уходит во все открытые элементы, которые его копят,
    // поэтому узел знает весь свой текст, а не только прямой.
    for (const frame of stack) {
      if (frame.buf !== null) frame.buf += decoded;
    }
    if (!muted) textParts.push(decoded);
  };

  /** Ближайшая вверх по стеку строка таблицы или список определений. */
  const findFrame = (names: string[]): Frame | undefined => {
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      const f = stack[s];
      if (f && names.includes(f.name)) return f;
    }
    return undefined;
  };

  /** id ближайшего предка — секция, в которой лежит элемент. */
  const nearestSection = (): string | undefined => {
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      const id = stack[s]?.id;
      if (id) return id;
    }
    return undefined;
  };

  const closeFrame = (frame: Frame): void => {
    const text = frame.buf === null ? '' : squash(frame.buf);

    if (text && CAPTURE_TEXT.has(frame.name)) {
      scan.texts.push({ tag: frame.name, text });
    }

    if (frame.name === 'a' && frame.href && scan.links.length < MAX_NODES) {
      scan.links.push({
        href: frame.href,
        text,
        cls: frame.cls,
        section: frame.section,
        attrs: frame.attrs ?? {},
      });
    }

    if (text && text.length <= MAX_NODE_TEXT && scan.nodes.length < MAX_NODES && (frame.id || frame.cls)) {
      scan.nodes.push({
        tag: frame.name,
        id: frame.id,
        cls: frame.cls,
        depth: frame.depth,
        text,
      });
    }

    // Ячейка таблицы → в строку; dt/dd → в список определений.
    if (frame.name === 'td' || frame.name === 'th') {
      findFrame(['tr'])?.cells?.push(text);
    } else if (frame.name === 'dt' || frame.name === 'dd') {
      const dl = findFrame(['dl']);
      if (dl?.terms) {
        if (frame.name === 'dt') dl.terms.push({ label: text });
        else {
          const last = dl.terms[dl.terms.length - 1];
          if (last && last.value == null) last.value = text;
          else dl.terms.push({ value: text });
        }
      }
    } else if (frame.name === 'tr' && frame.cells && frame.cells.length >= 2) {
      const [label, value] = frame.cells;
      if (label && value) scan.pairs.push({ label, value, from: 'table' });
    } else if (frame.name === 'dl' && frame.terms) {
      for (const t of frame.terms) {
        if (t.label && t.value) scan.pairs.push({ label: t.label, value: t.value, from: 'dl' });
      }
    }
  };

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const gt = html.indexOf('>', lt);
    if (gt === -1) {
      pushText(html.slice(lt));
      break;
    }
    const inner = html.slice(lt + 1, gt);

    // ── закрывающий тег ────────────────────────────────────────────────────
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s]!.name === name) {
          // Закрываем изнутри наружу, чтобы вложенные ячейки успели
          // отдать текст своей строке.
          for (let k = stack.length - 1; k >= s; k -= 1) {
            const frame = stack[k]!;
            closeFrame(frame);
            if (SKIP_TEXT.has(frame.name)) muted -= 1;
          }
          stack.length = s;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const spaceAt = body.search(/\s/);
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    if (!name || !/^[a-z][\w:-]*$/.test(name)) {
      pushText(html.slice(lt, gt + 1));
      i = gt + 1;
      continue;
    }
    const attrs = spaceAt === -1 ? {} : parseAttrs(body.slice(spaceAt + 1));

    // ── script: тело целиком, в нём может быть JSON-LD ────────────────────
    if (name === 'script') {
      const closeAt = html.toLowerCase().indexOf('</script', gt);
      scan.scripts.push({
        type: (attrs.type ?? '').toLowerCase(),
        content: html.slice(gt + 1, closeAt === -1 ? len : closeAt),
      });
      i = closeAt === -1 ? len : html.indexOf('>', closeAt) + 1;
      continue;
    }
    if (name === 'style') {
      const closeAt = html.toLowerCase().indexOf('</style', gt);
      i = closeAt === -1 ? len : html.indexOf('>', closeAt) + 1;
      continue;
    }

    if (name === 'meta') {
      const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').toLowerCase();
      if (key && attrs.content) scan.metas[key] = attrs.content;
    } else if (name === 'img') {
      const section = nearestSection();
      scan.images.push(section ? { ...attrs, __section: section } : attrs);
    }

    if (!selfClosing && !VOID_TAGS.has(name)) {
      const wantsText = CAPTURE_TEXT.has(name) || Boolean(attrs.id || attrs.class) ||
        ['td', 'th', 'dt', 'dd', 'a'].includes(name);
      const frame: Frame = {
        name,
        id: attrs.id || undefined,
        cls: attrs.class || undefined,
        depth: stack.length,
        buf: wantsText ? '' : null,
      };
      if (name === 'a') {
        frame.href = attrs.href;
        frame.section = nearestSection();
        frame.attrs = attrs;
      }
      if (name === 'tr') frame.cells = [];
      if (name === 'dl') frame.terms = [];
      if (SKIP_TEXT.has(name)) muted += 1;
      stack.push(frame);
    }
    i = gt + 1;
  }

  // Незакрытые теги в конце документа — обычное дело, добираем их.
  for (let k = stack.length - 1; k >= 0; k -= 1) closeFrame(stack[k]!);

  scan.text = squash(textParts.join(' '));
  collectSiblingPairs(scan);
  return scan;
}

/**
 * Третий и самый частый способ вёрстки характеристик — два соседних блока
 * на одном уровне: подпись и значение.
 *
 * Классы здесь намеренно не используются. На utility-CSS (Tailwind и
 * подобных) подпись размечена как `text-gray-500`, а значение как
 * `font-medium` — по именам классов их не отличить, и попытка угадать
 * «label/value» по названию отсекла бы ровно те сайты, ради которых
 * всё и затевалось. Поэтому сюда попадают все короткие соседние пары,
 * а отбор делает словарь характеристик: незнакомая подпись просто
 * не превратится ни в какое поле карточки.
 */
function collectSiblingPairs(scan: HtmlScan): void {
  const seen = new Set(scan.pairs.map((p) => p.label.toLowerCase() + '|' + p.value.toLowerCase()));

  for (let i = 0; i < scan.nodes.length - 1; i += 1) {
    const a = scan.nodes[i]!;
    const b = scan.nodes[i + 1]!;
    if (a.depth !== b.depth) continue;
    if (!a.text || !b.text) continue;
    // Подпись короткая и не числовая; значение тоже умещается в строку.
    if (a.text.length > 48 || b.text.length > 90) continue;
    if (/^[\d\s.,]+$/.test(a.text)) continue;

    const label = a.text.replace(/[:：]\s*$/, '').trim();
    const value = b.text.trim();
    if (!label || !value || label === value) continue;

    const key = label.toLowerCase() + '|' + value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    scan.pairs.push({ label, value, from: 'siblings' });
  }

  // И четвёртый: «Общая площадь: 62,4 м²» одной строкой внутри элемента.
  for (const node of scan.nodes) {
    if (node.text.length > 90) continue;
    const m = /^([А-ЯЁA-Z][^:：]{2,40})[:：]\s*(.{1,60})$/.exec(node.text);
    if (!m || !m[1] || !m[2]) continue;
    const key = m[1].toLowerCase().trim() + '|' + m[2].toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    scan.pairs.push({ label: m[1].trim(), value: m[2].trim(), from: 'inline' });
  }
}

/** Все валидные JSON-объекты из <script type="application/ld+json">. */
export function collectJsonLd(scan: HtmlScan): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const script of scan.scripts) {
    if (!script.type.includes('ld+json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.content.trim());
    } catch {
      continue; // битый JSON-LD на сайтах встречается постоянно
    }
    const queue: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length) {
      const item = queue.shift();
      if (!item || typeof item !== 'object') continue;
      out.push(item as Record<string, unknown>);
      const graph = (item as Record<string, unknown>)['@graph'];
      if (Array.isArray(graph)) queue.push(...graph);
    }
  }
  return out;
}

/** Первый текст одного из перечисленных тегов. */
export function firstText(scan: HtmlScan, tags: string[]): string | undefined {
  for (const tag of tags) {
    const hit = scan.texts.find((t) => t.tag === tag && t.text);
    if (hit) return hit.text;
  }
  return undefined;
}

/** Узлы, чей класс или id совпадает с образцом. Опора для профилей сайтов. */
export function nodesByClass(scan: HtmlScan, pattern: RegExp): HtmlNode[] {
  return scan.nodes.filter((n) => pattern.test(`${n.cls ?? ''} ${n.id ?? ''}`));
}

/** Текст первого подходящего узла. */
export function textByClass(scan: HtmlScan, pattern: RegExp): string | undefined {
  return nodesByClass(scan, pattern)[0]?.text;
}
