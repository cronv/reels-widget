import type { Card, Scene, Theme, Timeline } from '../types.js';
import { pickMedia } from '../normalize.js';
import {
  clamp,
  completionLabel,
  completionPhrase,
  formatPerMeter,
  formatPrice,
  locationLine,
  metroLabel,
} from '../format.js';
import { CONTENT_WIDTH, FRAME, MARGIN } from '../theme.js';
import {
  bottomScrim,
  fadeIn,
  fadeUp,
  fullImage,
  surface,
  scaleIn,
  panelImage,
  hexToRgba,
  graphic,
  outroScene,
  sChips,
  sCounter,
  sKicker,
  sRule,
  sText,
  scene,
  sec,
  stack,
  watermark,
} from './kit.js';

/**
 * «Обзор ЖК» — 10 секунд, четыре удара.
 *
 * Задача ролика — за первые полторы секунды назвать объект и место, дальше
 * держать внимание сменой рендеров, а цену показать на третьем ударе, когда
 * зритель уже решил, интересно ему или нет.
 *
 * Все подписи собраны потоковыми блоками с привязкой к низу: названия ЖК
 * бывают и в три слова, и в семь, и верстка не должна от этого ломаться.
 */
export function buildComplexOverview(card: Card, theme: Theme, warnings: string[]): Timeline {
  // Пять кадров: три полноэкранных и два в сцене-галерее. Объект
  // показывается с разных сторон, а не трижды одним ракурсом.
  const renders = pickMedia(card, ['render', 'photo', 'progress'], 5);
  if (renders.length === 0) {
    warnings.push('Нет ни одного изображения — сцены собраны на графическом фоне.');
  } else if (renders.length < 5) {
    warnings.push(`Изображений меньше пяти (${renders.length}) — часть кадров повторяется.`);
  }

  const img = (i: number): string | undefined =>
    renders.length ? renders[i % renders.length]!.url : undefined;

  const name = clamp(card.complex.name || 'Новый жилой комплекс', 52);
  const place = locationLine(card.complex.location);
  const metro = metroLabel(card.complex.location.metro);
  const highlights = card.complex.highlights ?? [];
  const completion = completionPhrase(card.complex.completion);
  const price = card.price;

  /** Низ текстового блока: выше зоны, которую перекрывает интерфейс Reels. */
  const BASE = 1440;

  // 2.5 + 2.1 + 2.0 + 2.0 + 1.4 = 10.0 с ровно
  const d1 = sec(2.5);
  const d2 = sec(2.1);
  const dGallery = sec(2.0);
  const d3 = sec(2.0);
  const d4 = sec(1.4);

  const scenes: Scene[] = [];
  let at = 0;

  // ── 1. Кто и где ─────────────────────────────────────────────────────────
  scenes.push(
    scene('hero', at, d1, [
      img(0) ? fullImage(img(0)!, { ken: 'in', scrim: 0.3 }) : null,
      bottomScrim(1150),
      stack('bottom', BASE, [
        sKicker(card.complex.segment ?? 'Новостройка', theme, 2),
        sRule(theme, 4),
        sText(name, 'display', { anim: { in: fadeUp(6, 16, 56) } }),
        place ? sText(place, 'subtitle', { color: theme.textMuted, anim: { in: fadeUp(12, 14, 36) } }) : null,
        metro ? sText(metro, 'body', { color: theme.textMuted, anim: { in: fadeUp(16, 14, 28) } }) : null,
      ], { gap: 16 }),
    ]),
  );
  at += d1;

  // ── 2. Чем хорош ─────────────────────────────────────────────────────────
  scenes.push(
    scene('highlights', at, d2, [
      img(1) ? fullImage(img(1)!, { ken: 'out', scrim: 0.42 }) : null,
      bottomScrim(1050),
      stack('bottom', BASE, [
        sKicker('Что внутри', theme, 2),
        highlights.length
          ? sChips(highlights, theme, 6)
          : sText('Собственная инфраструктура', 'title', { anim: { in: fadeUp(6, 16, 40) } }),
        completion
          ? sText(completion, 'body', {
              color: theme.textMuted,
              gapBefore: 14,
              anim: { in: fadeUp(18, 14, 28) },
            })
          : null,
      ], { gap: 22 }),
    ]),
  );
  at += d2;

  // ── 3. Галерея: объект с разных сторон ───────────────────────────────────
  // Один крупный кадр и два поменьше. Коллаж показывает объём застройки
  // за те же две секунды, которые ушли бы на ещё один общий план.
  const GAP = 16;
  const galleryTop = 380;
  const bigH = 620;
  const smallH = 300;
  const halfW = (CONTENT_WIDTH - GAP) / 2;

  scenes.push(
    scene('gallery', at, dGallery, [
      ...surface('#0C0F14', { glow: hexToRgba(theme.accent, 0.16), glowAt: [50, 20], noise: 0.05 }),
      graphic('grid', '#FFFFFF', { strength: 0.05, step: 60, z: 1, anim: { in: fadeIn(0, 14) } }),
      stack('top', 330, [sKicker('Как это выглядит', theme, 2)]),
      img(2)
        ? panelImage(img(2)!, { x: MARGIN, y: galleryTop, w: CONTENT_WIDTH, h: bigH }, {
            radius: 22,
            ken: true,
            anim: scaleIn(4, 18),
          })
        : null,
      img(3)
        ? panelImage(img(3)!, { x: MARGIN, y: galleryTop + bigH + GAP, w: halfW, h: smallH }, {
            radius: 22,
            anim: fadeUp(10, 16, 32),
          })
        : null,
      img(4)
        ? panelImage(img(4)!, { x: MARGIN + halfW + GAP, y: galleryTop + bigH + GAP, w: halfW, h: smallH }, {
            radius: 22,
            anim: fadeUp(14, 16, 32),
          })
        : null,
      // Снизу — то, ради чего смотрят дальше: срок и класс. Без этой
      // строки под коллажем оставалась пустая треть кадра.
      stack('bottom', 1430, [
        completion || card.complex.segment
          ? sText(
              [card.complex.segment, completion].filter(Boolean).join('  ·  '),
              'body',
              { color: theme.textMuted, anim: { in: fadeUp(18, 14, 26) } },
            )
          : null,
      ]),
      card.complex.developer?.name ? watermark(card.complex.developer.name, theme) : null,
    ]),
  );
  at += dGallery;

  // ── 4. Сколько стоит ─────────────────────────────────────────────────────
  scenes.push(
    scene('price', at, d3, [
      img(2) ? fullImage(img(2)!, { ken: 'in', scrim: 0.52 }) : null,
      bottomScrim(1150, 0.95),
      stack('bottom', BASE, [
        sKicker(price?.isFrom === false ? 'Цена' : 'Квартиры от', theme, 2),
        price
          ? sCounter(Math.round(price.value * 0.86), price.value)
          : sText('Цена по запросу', 'title', { anim: { in: fadeUp(6, 16, 40) } }),
        price?.perSquareMeter
          ? sText(formatPerMeter(price.perSquareMeter), 'subtitle', {
              color: theme.textMuted,
              anim: { in: fadeUp(20, 14, 28) },
            })
          : null,
        card.complex.escrow
          ? sText('Эскроу-счета · 214-ФЗ', 'caption', {
              color: theme.textMuted,
              gapBefore: 10,
              anim: { in: fadeIn(24, 12) },
            })
          : null,
      ], { gap: 14 }),
      card.complex.developer?.name ? watermark(card.complex.developer.name, theme) : null,
    ]),
  );
  at += d3;

  // ── 4. Куда идти ─────────────────────────────────────────────────────────
  scenes.push(
    outroScene(at, d4, theme, {
      floors: card.complex.floorsTotal ?? card.lot?.floorsTotal,
      title: name,
      line: place || undefined,
      cta: card.contact?.site ?? card.contact?.phone ?? 'Подробности в описании',
    }),
  );
  at += d4;

  return {
    version: 1,
    id: `${card.id}-complex-overview`,
    cardId: card.id,
    scenario: 'complex-overview',
    width: FRAME.width,
    height: FRAME.height,
    fps: FRAME.fps,
    durationInFrames: at,
    theme,
    scenes,
    caption: buildCaption(card),
    warnings,
  };
}

function buildCaption(card: Card): string {
  const parts = [card.complex.name];
  const place = locationLine(card.complex.location);
  if (place) parts.push(place);
  if (card.price) parts.push(formatPrice(card.price.value, { from: card.price.isFrom !== false }));
  const completion = completionLabel(card.complex.completion);
  if (completion) parts.push(completion === 'Сдан' ? 'дом сдан' : `сдача ${completion}`);
  return parts.filter(Boolean).join(' · ');
}
