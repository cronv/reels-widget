/**
 * Компактный XML-парсер под выгрузки недвижимости.
 *
 * Зачем свой вместо библиотеки: ядро виджета крутится на сервере, который
 * принимает чужие файлы, и держать нулевую поверхность зависимостей тут
 * дешевле, чем обновлять парсер по CVE. Нужного хватает: теги, атрибуты,
 * CDATA, комментарии, сущности, самозакрывающиеся узлы.
 *
 * Чего намеренно нет: DTD, namespace-резолвинг, processing instructions
 * сложнее `<?xml ...?>`. В фидах ЦИАН/Яндекс/Avito они не встречаются.
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Собственный текст узла (без текста детей). */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const name = m[1];
    if (!name) continue;
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    attrs[name.toLowerCase()] = decodeEntities(value);
  }
  return attrs;
}

/** Разбирает XML-документ в дерево. Бросает только на явно битом входе. */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const len = source.length;

  const top = (): XmlNode => stack[stack.length - 1]!;

  while (i < len) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      top().text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) {
      top().text += decodeEntities(source.slice(i, lt));
    }

    // <!-- комментарий -->
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    // <![CDATA[ ... ]]>
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const body = source.slice(lt + 9, end === -1 ? len : end);
      top().text += body;
      i = end === -1 ? len : end + 3;
      continue;
    }
    // <?xml ... ?> и <!DOCTYPE ...>
    if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const gt = source.indexOf('>', lt);
    if (gt === -1) {
      top().text += decodeEntities(source.slice(lt));
      break;
    }
    const inner = source.slice(lt + 1, gt).trim();

    // закрывающий тег
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s]!.tag === name) {
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
    const tag = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    const attrs = spaceAt === -1 ? {} : parseAttrs(body.slice(spaceAt + 1));

    const node: XmlNode = { tag, attrs, children: [], text: '' };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return root;
}

/** Текст узла вместе с текстом всех потомков. */
export function textContent(node: XmlNode): string {
  let out = node.text;
  for (const child of node.children) out += textContent(child);
  return out.trim();
}

/** Все узлы с данным именем тега, в порядке обхода. */
export function findAllByTag(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  const wanted = tag.toLowerCase();
  for (const child of node.children) {
    if (child.tag === wanted) out.push(child);
    findAllByTag(child, wanted, out);
  }
  return out;
}

/**
 * Плоская карта `путь → значение` по дереву: и теги, и атрибуты.
 * Адаптер фида ищет по ней значения сразу по списку синонимов.
 */
export function flattenXml(node: XmlNode, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(node.attrs)) {
    out[`${prefix}@${key}`] = value;
  }
  const own = node.text.trim();
  if (own) out[prefix || node.tag] = own;

  const seen = new Map<string, number>();
  for (const child of node.children) {
    const n = seen.get(child.tag) ?? 0;
    seen.set(child.tag, n + 1);
    const path = prefix ? `${prefix}.${child.tag}` : child.tag;
    flattenXml(child, n === 0 ? path : `${path}[${n}]`, out);
  }
  return out;
}
