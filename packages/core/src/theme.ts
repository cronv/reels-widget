import type { Theme } from './types.js';

/** Кадр Reels / Shorts / VK Клипов. */
export const FRAME = { width: 1080, height: 1920, fps: 30 } as const;

/**
 * Безопасная зона. В Reels верхние ~280 px перекрывает шапка, нижние ~420 px —
 * подпись, аватар и кнопки. Всё, что обязано быть прочитано, держим внутри.
 */
export const SAFE = { top: 300, bottom: 1500, left: 88, right: 992 } as const;

export const MARGIN = 88;
export const CONTENT_WIDTH = FRAME.width - MARGIN * 2; // 904

export const defaultTheme: Theme = {
  bg: '#0B0D10',
  surface: 'rgba(255,255,255,0.08)',
  text: '#FFFFFF',
  textMuted: 'rgba(255,255,255,0.62)',
  accent: '#E3C08A',
  accentText: '#14110B',
  // Inter покрывает кириллицу целиком и есть почти везде; вариант Display —
  // более плотный кегль для крупных заголовков. Чтобы поставить свой шрифт,
  // достаточно положить его в packages/stage/fonts и поправить stage.html.
  fontDisplay: "'Inter Display', 'Inter', system-ui, sans-serif",
  fontBody: "'Inter', system-ui, sans-serif",
  radius: 28,
};

/** Акцент под сценарий: у акции он должен «кричать», у обзора — нет. */
export const accentPresets = {
  warm: '#E3C08A',
  hot: '#FF5C38',
  sky: '#5AA9FF',
  mint: '#5FD0A6',
} as const;

export function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return { ...defaultTheme, ...overrides };
}

/** Размеры типографики под 1080×1920. */
export const TYPE: Record<string, { size: number; lineHeight: number; weight: number; tracking?: number }> = {
  display: { size: 96, lineHeight: 0.98, weight: 800, tracking: -0.03 },
  title: { size: 64, lineHeight: 1.06, weight: 700, tracking: -0.02 },
  subtitle: { size: 42, lineHeight: 1.25, weight: 500 },
  body: { size: 36, lineHeight: 1.35, weight: 400 },
  caption: { size: 28, lineHeight: 1.3, weight: 500 },
  price: { size: 108, lineHeight: 1, weight: 800, tracking: -0.03 },
  kicker: { size: 26, lineHeight: 1, weight: 600, tracking: 0.18 },
};
