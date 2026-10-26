import type { Card, Scene, Theme, Timeline } from '../types.js';
import { pickMedia } from '../normalize.js';
import {
  clamp,
  completionLabel,
  floorLabel,
  formatArea,
  formatPerMeter,
  formatPrice,
  groupDigits,
  locationLine,
  roomsLabel,
} from '../format.js';
import { CONTENT_WIDTH, FRAME, MARGIN } from '../theme.js';
import {
  bottomScrim,
  fadeIn,
  fadeUp,
  fullImage,
  outroScene,
  panelImage,
  rect,
  sCounter,
  sGrid,
  sKicker,
  sPanel,
  sRule,
  sText,
  scaleIn,
  scene,
  sec,
  stack,
  watermark,
} from './kit.js';

/**
 * «Лот с планировкой» — 15 секунд, пять ударов.
 *
 * Центральная сцена — планировка. Она живёт на светлой подложке: чертежи
 * почти всегда чёрным по белому, и на тёмном фоне линии теряются.
 */
export function buildLotPlan(card: Card, theme: Theme, warnings: string[]): Timeline {
  const lot = card.lot;
  if (!lot) warnings.push('Данных по лоту нет — сценарий собран по минимуму.');

  const renders = pickMedia(card, ['render', 'photo'], 2);
  const plans = pickMedia(card, ['plan'], 1);
  if (!plans.length) {
    warnings.push('Планировка не найдена — вместо неё показан рендер. Добавьте изображение плана.');
  }

  const planSrc = plans[0]?.url ?? renders[0]?.url;
  const name = clamp(card.complex.name || 'Новостройка', 46);
  const place = locationLine(card.complex.location);
  const title = `${roomsLabel(lot?.rooms, lot?.isStudio)}${lot?.areaTotal ? ` · ${formatArea(lot.areaTotal)}` : ''}`;
  const price = card.price;
  const mortgage = card.mortgage;

  const BASE = 1440;

  const d1 = sec(2.6);
  const d2 = sec(3.2);
  const d3 = sec(4.4);
  const d4 = sec(3.4);
  const d5 = sec(1.4);

  const scenes: Scene[] = [];
  let at = 0;

  // ── 1. Контекст: что за дом ──────────────────────────────────────────────
  scenes.push(
    scene('intro', at, d1, [
      renders[0] ? fullImage(renders[0].url, { ken: 'in', scrim: 0.34 }) : null,
      bottomScrim(1050),
      stack('bottom', BASE, [
        sKicker('Квартира в продаже', theme, 2),
        sRule(theme, 4),
        sText(name, 'title', { anim: { in: fadeUp(6, 16, 48) } }),
        place ? sText(place, 'body', { color: theme.textMuted, anim: { in: fadeUp(12, 14, 30) } }) : null,
      ], { gap: 16 }),
    ]),
  );
  at += d1;

  // ── 2. Параметры лота ────────────────────────────────────────────────────
  const cells: { value: string; label: string }[] = [];
  if (lot?.areaTotal) cells.push({ value: formatArea(lot.areaTotal), label: 'Общая площадь' });
  if (lot?.floor) cells.push({ value: floorLabel(lot.floor, lot.floorsTotal) ?? '—', label: 'Этаж' });
  if (lot?.areaKitchen) cells.push({ value: formatArea(lot.areaKitchen), label: 'Кухня' });
  if (lot?.finishing) cells.push({ value: lot.finishing, label: 'Отделка' });
  if (lot?.ceilingHeight) cells.push({ value: `${String(lot.ceilingHeight).replace('.', ',')} м`, label: 'Потолки' });
  if (lot?.building) cells.push({ value: lot.building, label: 'Корпус' });
  if (cells.length < 2) cells.push({ value: card.complex.segment ?? 'Комфорт', label: 'Класс' });

  scenes.push(
    scene('specs', at, d2, [
      renders[1] ? fullImage(renders[1].url, { ken: 'out', scrim: 0.62 }) : null,
      rect({ x: 0, y: 0, w: FRAME.width, h: FRAME.height }, 'rgba(8,10,14,0.55)', { radius: 0, anim: fadeIn(0, 8) }),
      stack('top', 700, [
        sText(title, 'display', { size: 78, anim: { in: fadeUp(4, 16, 48) } }),
        sRule(theme, 10, 120),
        sGrid(cells, theme, { columns: 2, at: 14, stagger: 4 }),
      ], { gap: 28 }),
    ]),
  );
  at += d2;

  // ── 3. Планировка на светлой подложке ────────────────────────────────────
  const planFooter = [
    lot?.areaTotal ? formatArea(lot.areaTotal) : null,
    lot?.areaKitchen ? `кухня ${formatArea(lot.areaKitchen)}` : null,
    lot?.floor ? floorLabel(lot.floor, lot.floorsTotal) : null,
  ]
    .filter(Boolean)
    .join('   ·   ');

  scenes.push(
    scene('plan', at, d3, [
      // z: 0 — это подложка сцены. По умолчанию rect рисуется поверх
      // изображений (он чаще нужен как затемняющая вуаль), и без явного
      // нуля светлый фон закрыл бы саму планировку.
      rect({ x: 0, y: 0, w: FRAME.width, h: FRAME.height }, '#F4F2ED', { radius: 0, z: 0, anim: fadeIn(0, 8) }),
      stack('top', 330, [
        sText('Планировка', 'kicker', {
          color: '#8C8373',
          uppercase: true,
          align: 'center',
          anim: { in: fadeUp(4, 12, 20) },
        }),
        sText(title, 'title', {
          color: '#15130F',
          align: 'center',
          size: 56,
          shadow: false,
          anim: { in: fadeUp(7, 14, 28) },
        }),
      ], { gap: 16 }),
      planSrc
        ? panelImage(planSrc, { x: MARGIN, y: 600, w: CONTENT_WIDTH, h: 820 }, {
            fit: 'contain',
            background: '#FFFFFF',
            radius: 24,
            anim: scaleIn(10, 20),
          })
        : null,
      planFooter
        ? stack('bottom', 1560, [
            sPanel(theme, [
              sText(planFooter, 'body', {
                color: '#F4F2ED',
                align: 'center',
                size: 32,
                shadow: false,
                anim: { in: fadeUp(27, 14, 24) },
              }),
            ], { at: 24, background: '#15130F', padding: 30 }),
          ])
        : null,
    ], { background: '#F4F2ED' }),
  );
  at += d3;

  // ── 4. Цена и платёж ─────────────────────────────────────────────────────
  scenes.push(
    scene('price', at, d4, [
      renders[0] ? fullImage(renders[0].url, { ken: 'in', scrim: 0.66 }) : null,
      bottomScrim(1250, 0.95),
      stack('bottom', BASE, [
        sKicker('Стоимость', theme, 2),
        price
          ? sCounter(Math.round(price.value * 0.88), price.value, { at: 6, dur: 32 })
          : sText('Цена по запросу', 'title', { anim: { in: fadeUp(6, 16, 40) } }),
        price?.perSquareMeter
          ? sText(formatPerMeter(price.perSquareMeter), 'subtitle', {
              color: theme.textMuted,
              anim: { in: fadeUp(22, 14, 28) },
            })
          : null,
        mortgage?.monthlyPayment
          ? sPanel(theme, [
              sText(`${mortgage.program ?? 'Ипотека'} ${String(mortgage.rate).replace('.', ',')}%`, 'caption', {
                color: theme.textMuted,
                shadow: false,
                anim: { in: fadeUp(31, 14, 24) },
              }),
              sText(`${groupDigits(mortgage.monthlyPayment)} ₽ / мес.`, 'title', {
                size: 58,
                shadow: false,
                anim: { in: fadeUp(34, 14, 24) },
              }),
            ], { at: 28 })
          : null,
      ], { gap: 16 }),
      card.complex.developer?.name ? watermark(card.complex.developer.name, theme) : null,
    ]),
  );
  at += d4;

  // ── 5. Финал ─────────────────────────────────────────────────────────────
  scenes.push(
    outroScene(at, d5, theme, {
      title,
      line: name,
      cta: card.contact?.phone ?? card.contact?.site ?? 'Забронировать в описании',
    }),
  );
  at += d5;

  const completion = completionLabel(card.complex.completion);
  const caption = [
    `${title} в ${name}`,
    place,
    price ? formatPrice(price.value) : null,
    completion ? (completion === 'Сдан' ? 'дом сдан' : `сдача ${completion}`) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    version: 1,
    id: `${card.id}-lot-plan`,
    cardId: card.id,
    scenario: 'lot-plan',
    width: FRAME.width,
    height: FRAME.height,
    fps: FRAME.fps,
    durationInFrames: at,
    theme,
    scenes,
    caption,
    warnings,
  };
}
