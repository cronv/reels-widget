import type {
  AnimSpec,
  Box,
  ChipsLayer,
  CounterLayer,
  GradientLayer,
  GraphicLayer,
  ImageLayer,
  Layer,
  ProgressLayer,
  RectLayer,
  Scene,
  StackItem,
  StackLayer,
  TextLayer,
  TextRole,
  Theme,
} from '../types.js';
import { CONTENT_WIDTH, FRAME, MARGIN } from '../theme.js';

/** Секунды → кадры. Все сценарии считают длительности в секундах. */
export const sec = (s: number): number => Math.round(s * FRAME.fps);

let idSeq = 0;
const uid = (prefix: string): string => `${prefix}-${(idSeq += 1)}`;

/** Сброс счётчика — чтобы таймлайн был детерминированным между вызовами. */
export function resetIds(): void {
  idSeq = 0;
}

// --- анимации ---------------------------------------------------------------

export const fadeUp = (at = 0, dur = 14, distance = 48): AnimSpec => ({
  type: 'fadeUp',
  at,
  dur,
  distance,
  easing: 'expoOut',
});

export const fadeIn = (at = 0, dur = 12): AnimSpec => ({ type: 'fade', at, dur, easing: 'easeOut' });

export const scaleIn = (at = 0, dur = 16): AnimSpec => ({ type: 'scaleIn', at, dur, easing: 'backOut' });

export const wipeUp = (at = 0, dur = 18): AnimSpec => ({ type: 'wipeUp', at, dur, easing: 'expoOut' });

/** Затухание в конце сцены: вызывается с длительностью сцены. */
export const fadeOutAt = (sceneDur: number, dur = 10): AnimSpec => ({
  type: 'fade',
  at: sceneDur - dur,
  dur,
  easing: 'easeOut',
});

// --- слои -------------------------------------------------------------------

export function fullImage(
  src: string,
  opts: { ken?: 'in' | 'out' | 'none'; scrim?: number; z?: number; anim?: AnimSpec } = {},
): ImageLayer {
  const ken =
    opts.ken === 'none'
      ? undefined
      : opts.ken === 'out'
        ? { fromScale: 1.12, toScale: 1.0, easing: 'linear' as const }
        : { fromScale: 1.0, toScale: 1.1, fromY: 0, toY: -16, easing: 'linear' as const };
  return {
    kind: 'image',
    id: uid('img'),
    src,
    fit: 'cover',
    box: { x: 0, y: 0, w: FRAME.width, h: FRAME.height },
    ken,
    scrim: opts.scrim ?? 0.45,
    z: opts.z ?? 0,
    anim: opts.anim ? { in: opts.anim } : { in: fadeIn(0, 8) },
  };
}

export function panelImage(
  src: string,
  box: { x: number; y: number; w: number; h: number },
  opts: { fit?: 'cover' | 'contain'; radius?: number; background?: string; anim?: AnimSpec; ken?: boolean } = {},
): ImageLayer {
  return {
    kind: 'image',
    id: uid('panel'),
    src,
    fit: opts.fit ?? 'cover',
    box,
    radius: opts.radius ?? 24,
    background: opts.background,
    scrim: 0,
    ken: opts.ken ? { fromScale: 1.0, toScale: 1.06, easing: 'linear' } : undefined,
    anim: { in: opts.anim ?? scaleIn(0, 18) },
    z: 1,
  };
}

export function gradient(
  from: string,
  to: string,
  box: Box = { x: 0, y: 0, w: FRAME.width, h: FRAME.height },
  angle = 180,
): GradientLayer {
  return { kind: 'gradient', id: uid('grad'), from, to, box, angle, z: 1 };
}

/** Градиент снизу — чтобы текст читался поверх любого рендера. */
export function bottomScrim(height = 1100, strength = 0.92): GradientLayer {
  return gradient(
    'rgba(5,7,10,0)',
    `rgba(5,7,10,${strength})`,
    { x: 0, y: FRAME.height - height, w: FRAME.width, h: height },
    180,
  );
}

export function text(
  value: string,
  role: TextRole,
  y: number,
  opts: Partial<TextLayer> & { anim?: AnimSpec } = {},
): TextLayer {
  const { anim, ...rest } = opts;
  return {
    kind: 'text',
    id: uid('txt'),
    text: value,
    role,
    box: { x: MARGIN, y, w: CONTENT_WIDTH, h: 0 },
    align: 'left',
    z: 3,
    anim: { in: anim ?? fadeUp() },
    ...rest,
  };
}

export function rect(
  box: { x: number; y: number; w: number; h: number },
  fill: string,
  opts: Partial<RectLayer> & { anim?: AnimSpec } = {},
): RectLayer {
  const { anim, ...rest } = opts;
  return {
    kind: 'rect',
    id: uid('rect'),
    box,
    fill,
    radius: 20,
    z: 2,
    anim: { in: anim ?? fadeIn() },
    ...rest,
  };
}

/** Тонкая акцентная линия — ритмический разделитель между блоками. */
export function accentRule(y: number, theme: Theme, width = 120, at = 0): RectLayer {
  return rect({ x: MARGIN, y, w: width, h: 5 }, theme.accent, {
    radius: 3,
    anim: { type: 'slideLeft', at, dur: 16, easing: 'expoOut', distance: width },
  });
}

export function chips(
  items: string[],
  y: number,
  theme: Theme,
  opts: { at?: number; stagger?: number } = {},
): ChipsLayer {
  return {
    kind: 'chips',
    id: uid('chips'),
    items: items.slice(0, 4),
    box: { x: MARGIN, y, w: CONTENT_WIDTH, h: 0 },
    color: theme.text,
    background: theme.surface,
    stagger: opts.stagger ?? 5,
    z: 3,
    anim: { in: fadeUp(opts.at ?? 0, 12, 24) },
  };
}

export function counter(
  from: number,
  to: number,
  y: number,
  opts: Partial<CounterLayer> = {},
): CounterLayer {
  return {
    kind: 'counter',
    id: uid('count'),
    from,
    to,
    at: 0,
    dur: 28,
    box: { x: MARGIN, y, w: CONTENT_WIDTH, h: 0 },
    role: 'price',
    grouped: true,
    suffix: ' ₽',
    align: 'left',
    easing: 'expoOut',
    z: 3,
    anim: { in: fadeUp(0, 12, 32) },
    ...opts,
  };
}

export function progress(
  value: number,
  y: number,
  theme: Theme,
  opts: Partial<ProgressLayer> = {},
): ProgressLayer {
  return {
    kind: 'progress',
    id: uid('prog'),
    value,
    at: 4,
    dur: 34,
    box: { x: MARGIN, y, w: CONTENT_WIDTH, h: 18 },
    color: theme.accent,
    trackColor: 'rgba(255,255,255,0.16)',
    z: 3,
    anim: { in: fadeIn(0, 10) },
    ...opts,
  };
}

/**
 * Пара «значение / подпись» в сетке. Используется для метрик лота:
 * площадь, этаж, отделка, высота потолков.
 */
export function statGrid(
  stats: { value: string; label: string }[],
  y: number,
  theme: Theme,
  opts: { at?: number; columns?: number } = {},
): Layer[] {
  const columns = opts.columns ?? 2;
  const gap = 24;
  const cellW = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const cellH = 168;
  const layers: Layer[] = [];

  stats.slice(0, columns * 2).forEach((stat, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = MARGIN + col * (cellW + gap);
    const cellY = y + row * (cellH + gap);
    const at = (opts.at ?? 0) + i * 4;

    layers.push(
      rect({ x, y: cellY, w: cellW, h: cellH }, theme.surface, {
        radius: 22,
        anim: fadeUp(at, 14, 28),
      }),
      {
        kind: 'text',
        id: uid('stat-v'),
        text: stat.value,
        role: 'title',
        size: 52,
        box: { x: x + 32, y: cellY + 34, w: cellW - 64, h: 0 },
        align: 'left',
        z: 3,
        anim: { in: fadeUp(at + 3, 14, 28) },
      },
      {
        kind: 'text',
        id: uid('stat-l'),
        text: stat.label,
        role: 'caption',
        color: theme.textMuted,
        box: { x: x + 32, y: cellY + 104, w: cellW - 64, h: 0 },
        align: 'left',
        z: 3,
        anim: { in: fadeUp(at + 5, 14, 28) },
      },
    );
  });

  return layers;
}

// --- потоковые блоки --------------------------------------------------------

/**
 * Блок, который сам считает свою высоту.
 *
 * `y` при anchor:'bottom' — это нижняя граница блока: сколько бы строк ни
 * заняло название, низ останется на месте, а блок вырастет вверх. Все
 * подписи поверх рендеров собираются только так.
 */
export function stack(
  anchor: 'top' | 'bottom',
  y: number,
  items: (StackItem | null | undefined | false)[],
  opts: { x?: number; w?: number; gap?: number; z?: number } = {},
): StackLayer {
  return {
    kind: 'stack',
    id: uid('stack'),
    anchor,
    gap: opts.gap ?? 18,
    box: { x: opts.x ?? MARGIN, y, w: opts.w ?? CONTENT_WIDTH, h: 0 },
    z: opts.z ?? 3,
    items: items.filter((i): i is StackItem => Boolean(i)),
  };
}

export function sText(
  value: string,
  role: TextRole,
  opts: Partial<Omit<TextLayer, 'kind' | 'id' | 'box' | 'z' | 'text' | 'role'>> & { gapBefore?: number } = {},
): StackItem {
  return { type: 'text', text: value, role, anim: { in: fadeUp() }, ...opts };
}

export function sKicker(value: string, theme: Theme, at = 0): StackItem {
  return sText(value, 'kicker', { color: theme.accent, uppercase: true, anim: { in: fadeIn(at, 10) } });
}

export function sRule(theme: Theme, at = 0, width = 96): StackItem {
  return {
    type: 'rule',
    width,
    height: 5,
    color: theme.accent,
    anim: { in: { type: 'slideLeft', at, dur: 16, easing: 'expoOut' } },
    gapBefore: 8,
  };
}

export function sChips(items: string[], theme: Theme, at = 0, stagger = 6): StackItem {
  return {
    type: 'chips',
    items: items.slice(0, 4),
    color: theme.text,
    background: theme.surface,
    stagger,
    anim: { in: fadeUp(at, 12, 24) },
  };
}

export function sCounter(from: number, to: number, opts: Partial<CounterLayer> = {}): StackItem {
  return {
    type: 'counter',
    from,
    to,
    at: 6,
    dur: 30,
    role: 'price',
    grouped: true,
    suffix: ' ₽',
    easing: 'expoOut',
    anim: { in: fadeUp(4, 12, 36) },
    ...opts,
  };
}

export function sProgress(value: number, theme: Theme, at = 10): StackItem {
  return {
    type: 'progress',
    value,
    at,
    dur: 36,
    color: theme.accent,
    trackColor: 'rgba(255,255,255,0.16)',
    anim: { in: fadeIn(at - 6 < 0 ? 0 : at - 6, 10) },
  };
}

/** Сетка метрик: пары «значение / подпись» в несколько колонок. */
export function sGrid(
  cells: { value: string; label: string }[],
  theme: Theme,
  opts: { columns?: number; at?: number; stagger?: number } = {},
): StackItem {
  return {
    type: 'grid',
    columns: opts.columns ?? 2,
    gap: 20,
    cells: cells.slice(0, (opts.columns ?? 2) * 2),
    background: theme.surface,
    at: opts.at ?? 0,
    stagger: opts.stagger ?? 4,
  };
}

export function sBadge(value: string, theme: Theme, at = 4): StackItem {
  return {
    type: 'badge',
    text: value,
    background: theme.accent,
    color: theme.accentText,
    anim: { in: fadeUp(at, 12, 20) },
  };
}

/** Карточка-подложка: заголовок и значение внутри скруглённого блока. */
export function sPanel(
  theme: Theme,
  items: (StackItem | null | undefined | false)[],
  opts: { at?: number; background?: string; padding?: number } = {},
): StackItem {
  return {
    type: 'panel',
    background: opts.background ?? theme.surface,
    padding: opts.padding ?? 36,
    radius: 26,
    anim: { in: fadeUp(opts.at ?? 0, 14, 28) },
    items: items.filter((i): i is StackItem => Boolean(i)),
  };
}

// --- фоновая графика --------------------------------------------------------

export function graphic(
  variant: GraphicLayer['variant'],
  color: string,
  opts: Partial<Omit<GraphicLayer, 'kind' | 'id' | 'variant' | 'color'>> = {},
): GraphicLayer {
  return {
    kind: 'graphic',
    id: uid('gfx'),
    variant,
    color,
    box: { x: 0, y: 0, w: FRAME.width, h: FRAME.height },
    strength: 0.3,
    z: 1,
    anim: { in: fadeIn(0, 14) },
    ...opts,
  };
}

/**
 * Слоистая подложка вместо плоской заливки.
 *
 * Три слоя: базовый цвет, смещённое радиальное пятно света и зерно.
 * По отдельности каждый почти незаметен, вместе они дают поверхность,
 * а не прямоугольник краски — именно этим «пустой» кадр отличается
 * от оформленного.
 */
export function surface(
  base: string,
  opts: { glow?: string; glowAt?: [number, number]; noise?: number; z?: number } = {},
): Layer[] {
  const z = opts.z ?? 0;
  const layers: Layer[] = [
    rect({ x: 0, y: 0, w: FRAME.width, h: FRAME.height }, base, { radius: 0, z, anim: fadeIn(0, 6) }),
  ];
  if (opts.glow) {
    const [gx, gy] = opts.glowAt ?? [22, 18];
    layers.push({
      kind: 'gradient',
      id: uid('glow'),
      from: opts.glow,
      to: 'rgba(0,0,0,0)',
      radial: { x: gx, y: gy, r: 85 },
      box: { x: 0, y: 0, w: FRAME.width, h: FRAME.height },
      z: z + 1,
      anim: { in: fadeIn(0, 18) },
    });
  }
  if (opts.noise !== 0) {
    layers.push(
      graphic('noise', '#ffffff', {
        strength: opts.noise ?? 0.05,
        seed: 7,
        z: z + 2,
        anim: { in: fadeIn(0, 10) },
      }),
    );
  }
  return layers;
}

/** Плашка в углу: застройщик или бренд агентства. */
export function watermark(label: string, theme: Theme): TextLayer {
  return {
    kind: 'text',
    id: uid('wm'),
    text: label,
    role: 'kicker',
    color: theme.textMuted,
    uppercase: true,
    box: { x: MARGIN, y: 1760, w: CONTENT_WIDTH, h: 0 },
    align: 'left',
    z: 4,
    anim: { in: fadeIn(6, 14) },
  };
}

/** Слой может быть «выключен» — сценарии так опускают блоки без данных. */
export type MaybeLayer = Layer | null | undefined | false;

export function scene(
  id: string,
  from: number,
  duration: number,
  layers: MaybeLayer[],
  opts: Partial<Scene> = {},
): Scene {
  return {
    id,
    from,
    duration,
    transition: { type: 'fade', dur: 7 },
    layers: layers.filter((l): l is Layer => Boolean(l)),
    ...opts,
  };
}

/**
 * Финальный кадр.
 *
 * Раньше здесь была сплошная заливка акцентом — в ролике она читалась
 * как незавёрстанный экран. Теперь кадр строится из самого объекта:
 * фасад рисуется по этажности дома, поэтому у девятиэтажки и у башни
 * он разный, а подложка собрана слоями — цвет, пятно света, зерно.
 *
 * Тёмная база вместо акцентной: последний кадр держится на экране
 * дольше прочих, и залитый цветом прямоугольник на нём утомляет.
 * Акцент остаётся светящимся окнам и подчёркиванию — его мало,
 * и поэтому он заметен.
 */
export function outroScene(
  from: number,
  duration: number,
  theme: Theme,
  opts: { title: string; line?: string; cta?: string; floors?: number },
): Scene {
  return scene(
    'outro',
    from,
    duration,
    [
      ...surface('#0C0F14', { glow: hexToRgba(theme.accent, 0.3), glowAt: [78, 14], noise: 0.055 }),
      // Дом занимает верхние две трети кадра, нижняя треть остаётся
      // под текст. Затемнять окна градиентом до читаемости букв
      // пришлось бы так сильно, что от дома ничего не осталось бы;
      // проще развести их по кадру.
      graphic('facade', '#FFFFFF', {
        box: { x: 0, y: 0, w: FRAME.width, h: 1120 },
        floors: opts.floors,
        accent: theme.accent,
        strength: 0.95,
        seed: (opts.floors ?? 12) * 13 + opts.title.length,
        z: 2,
        // Дом «приближается» — кадр не стоит на месте в последнюю секунду.
        drift: { y: -12, scale: 0.03 },
        anim: { in: fadeIn(0, 18) },
      }),
      // Плотная подложка под текстом: окна за буквами съедают читаемость,
      // а финальный кадр — это прежде всего название и контакт.
      gradient(
        'rgba(12,15,20,0)',
        'rgba(12,15,20,1)',
        { x: 0, y: 800, w: FRAME.width, h: 320 },
        180,
      ),
      rect({ x: 0, y: 1115, w: FRAME.width, h: FRAME.height - 1115 }, '#0C0F14', {
        radius: 0,
        z: 2,
        anim: fadeIn(0, 6),
      }),
      // Текст прижат к низу и выровнен по левому краю — как во всех
      // остальных сценах. Центрированный блок посреди пустого кадра
      // был главной причиной, по которой финал смотрелся заглушкой.
      stack(
        'bottom',
        1440,
        [
          // Акцентная черта живёт в текстовом блоке, а не отдельным
          // слоем: иначе при смене высоты дома она оказывается поверх окон.
          sRule(theme, 6, 132),
          sText(opts.title, 'display', {
            color: '#FFFFFF',
            size: 82,
            anim: { in: fadeUp(10, 16, 44) },
          }),
          opts.line
            ? sText(opts.line, 'subtitle', {
                color: 'rgba(255,255,255,0.66)',
                anim: { in: fadeUp(15, 14, 30) },
              })
            : null,
          opts.cta
            ? sText(opts.cta, 'kicker', {
                color: theme.accent,
                uppercase: true,
                size: 30,
                weight: 700,
                gapBefore: 18,
                anim: { in: fadeIn(20, 12) },
              })
            : null,
        ],
        { gap: 16 },
      ),
    ],
    { transition: { type: 'cut', dur: 0 }, background: '#0C0F14' },
  );
}

/** `#E3C08A` + 0.3 → `rgba(227,192,138,0.3)`. Для подсветки фона. */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return hex;
  const n = Number.parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
