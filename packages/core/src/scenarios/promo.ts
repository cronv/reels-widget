import type { Card, Scene, Theme, Timeline } from '../types.js';
import { pickMedia } from '../normalize.js';
import { clamp, deadlineLabel, formatPrice, formatRate, groupDigits, locationLine } from '../format.js';
import { FRAME } from '../theme.js';
import {
  bottomScrim,
  fadeIn,
  fadeUp,
  fullImage,
  graphic,
  outroScene,
  rect,
  sCounter,
  sKicker,
  sPanel,
  sText,
  scaleIn,
  scene,
  sec,
  surface,
  stack,
  watermark,
} from './kit.js';

/**
 * «Акция / ипотека» — 10 секунд, четыре удара.
 *
 * Порядок обратный обзору: выгода идёт первым кадром, потому что ролик должен
 * останавливать листание цифрой, а не красивым фасадом. Акцент горячий, фон
 * сплошной: на первом кадре ничто не должно конкурировать с оффером.
 */
export function buildPromo(card: Card, theme: Theme, warnings: string[]): Timeline {
  const promo = card.promo;
  const mortgage = card.mortgage;
  const price = card.price;
  if (!promo && !mortgage) {
    warnings.push('Нет ни акции, ни ипотечной ставки — этому сценарию нечего показать.');
  }

  const renders = pickMedia(card, ['render', 'photo'], 2);
  const name = clamp(card.complex.name || 'Новостройка', 44);
  const place = locationLine(card.complex.location);

  // Заголовок берётся только из того, что есть: акция или ставка.
  // Сценарий без них теперь недоступен, поэтому запасной вариант
  // «Специальная цена» — обещание выгоды без основания — не нужен.
  const offerTitle =
    promo?.title ?? (mortgage ? `Ипотека ${formatRate(mortgage.rate)}` : card.complex.name);
  const offerSub = promo?.subtitle ?? mortgage?.program ?? place;
  const deadline = promo?.until ? deadlineLabel(promo.until) : undefined;

  const BASE = 1440;

  const d1 = sec(2.4);
  const d2 = sec(3.0);
  const d3 = sec(3.0);
  const d4 = sec(1.6);

  const scenes: Scene[] = [];
  let at = 0;

  // ── 1. Оффер на весь экран ───────────────────────────────────────────────
  scenes.push(
    scene(
      'offer',
      at,
      d1,
      [
        // Акцент остаётся фоном — он здесь работает как сигнал, — но
        // перестаёт быть плоским: пятно света сверху, расходящиеся
        // лучи от нижнего угла и зерно дают поверхность и направление.
        ...surface(theme.accent, {
          glow: 'rgba(255,255,255,0.42)',
          glowAt: [50, 8],
          noise: 0.05,
        }),
        graphic('rays', theme.accentText, {
          strength: 0.14,
          step: 54,
          z: 2,
          drift: { x: 26 },
          anim: { in: fadeIn(0, 20) },
        }),
        graphic('rings', theme.accentText, {
          strength: 0.1,
          step: 190,
          z: 2,
          drift: { scale: 0.05 },
          anim: { in: fadeIn(4, 24) },
        }),
        // Обмерная линейка сверху — тонкая отсылка к чертежу, она же
        // задаёт кадру верхнюю границу.
        graphic('ticks', theme.accentText, {
          box: { x: 0, y: 300, w: FRAME.width, h: 30 },
          strength: 0.5,
          step: 30,
          z: 3,
          anim: { in: fadeIn(8, 16) },
        }),
        stack('top', 560, [
          promo?.discountPercent
            ? sText(`−${promo.discountPercent}%`, 'display', {
                size: 220,
                color: theme.accentText,
                align: 'center',
                shadow: false,
                anim: { in: scaleIn(6, 18) },
              })
            : null,
          sText(offerTitle, 'display', {
            size: promo?.discountPercent ? 84 : 104,
            color: theme.accentText,
            align: 'center',
            shadow: false,
            anim: { in: fadeUp(10, 14, 44) },
          }),
          offerSub
            ? sText(offerSub, 'subtitle', {
                color: 'rgba(20,17,11,0.74)',
                align: 'center',
                shadow: false,
                anim: { in: fadeUp(16, 14, 30) },
              })
            : null,
          sText(name, 'kicker', {
            color: theme.accentText,
            align: 'center',
            uppercase: true,
            shadow: false,
            gapBefore: 24,
            anim: { in: fadeIn(20, 12) },
          }),
        ], { gap: 18 }),
      ],
      { background: theme.accent, transition: { type: 'fade', dur: 12 } },
    ),
  );
  at += d1;

  // ── 2. Было / стало ──────────────────────────────────────────────────────
  const oldPrice =
    price?.oldValue ??
    (promo?.discountPercent && price ? Math.round(price.value / (1 - promo.discountPercent / 100)) : undefined);

  scenes.push(
    scene('price', at, d2, [
      renders[0] ? fullImage(renders[0].url, { ken: 'in', scrim: 0.6 }) : null,
      bottomScrim(1150, 0.94),
      stack('bottom', BASE, [
        sKicker(oldPrice ? 'Цена со скидкой' : 'Стоимость', theme, 2),
        oldPrice
          ? sText(formatPrice(oldPrice), 'subtitle', {
              color: theme.textMuted,
              strike: true,
              anim: { in: fadeUp(6, 12, 24) },
            })
          : null,
        price
          ? sCounter(oldPrice ?? Math.round(price.value * 0.9), price.value, { at: 10, dur: 30 })
          : sText('Цена по запросу', 'title', { anim: { in: fadeUp(6, 16, 40) } }),
        deadline
          ? sText(deadline, 'body', { color: theme.accent, gapBefore: 10, anim: { in: fadeUp(26, 14, 26) } })
          : null,
      ], { gap: 14 }),
      card.complex.developer?.name ? watermark(card.complex.developer.name, theme) : null,
    ], { transition: { type: 'fade', dur: 28 } }),
  );
  at += d2;

  // ── 3. Платёж в месяц ────────────────────────────────────────────────────
  scenes.push(
    scene('mortgage', at, d3, [
      renders[1] ? fullImage(renders[1].url, { ken: 'out', scrim: 0.68 }) : null,
      rect({ x: 0, y: 0, w: FRAME.width, h: FRAME.height }, 'rgba(8,10,14,0.5)', { radius: 0, anim: fadeIn(0, 8) }),
      mortgage
        ? stack('top', 740, [
            sText(mortgage.program ?? 'Ипотека', 'kicker', {
              color: theme.accent,
              uppercase: true,
              align: 'center',
              anim: { in: fadeIn(2, 10) },
            }),
            sText(formatRate(mortgage.rate), 'display', {
              size: 180,
              align: 'center',
              anim: { in: scaleIn(6, 18) },
            }),
            mortgage.monthlyPayment
              ? sPanel(theme, [
                  sText('Платёж в месяц', 'caption', {
                    color: theme.textMuted,
                    align: 'center',
                    shadow: false,
                    anim: { in: fadeUp(21, 14, 24) },
                  }),
                  sText(`${groupDigits(mortgage.monthlyPayment)} ₽`, 'title', {
                    size: 86,
                    align: 'center',
                    shadow: false,
                    anim: { in: fadeUp(24, 14, 26) },
                  }),
                ], { at: 18 })
              : null,
            mortgage.downPaymentPercent
              ? sText(
                  `Первоначальный взнос ${mortgage.downPaymentPercent}% · срок ${mortgage.termYears ?? 30} лет`,
                  'caption',
                  { color: theme.textMuted, align: 'center', gapBefore: 10, anim: { in: fadeIn(30, 12) } },
                )
              : null,
          ], { gap: 20 })
        : stack('top', 820, [
            sKicker('Стоимость', theme, 2),
            price
              ? sText(formatPrice(price.value, { from: price.isFrom }), 'display', {
                  size: 110,
                  align: 'center',
                  anim: { in: fadeUp(6, 16, 44) },
                })
              : sText('Цена по запросу', 'title', { align: 'center', anim: { in: fadeUp(6, 16, 40) } }),
          ], { gap: 18 }),
    ]),
  );
  at += d3;

  // ── 4. Дедлайн и действие ────────────────────────────────────────────────
  scenes.push(
    outroScene(at, d4, theme, {
      floors: card.complex.floorsTotal ?? card.lot?.floorsTotal,
      title: deadline ?? offerTitle,
      line: name,
      cta: card.contact?.phone ?? card.contact?.site ?? 'Условия в описании',
    }),
  );
  at += d4;

  return {
    version: 1,
    id: `${card.id}-promo`,
    cardId: card.id,
    scenario: 'promo',
    width: FRAME.width,
    height: FRAME.height,
    fps: FRAME.fps,
    durationInFrames: at,
    theme,
    scenes,
    caption: [offerTitle, name, place, price ? formatPrice(price.value, { from: price.isFrom }) : null]
      .filter(Boolean)
      .join(' · '),
    warnings,
  };
}
