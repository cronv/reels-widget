import type { Card, Scene, Theme, Timeline } from '../types.js';
import { pickMedia } from '../normalize.js';
import { clamp, completionLabel, completionPhrase, locationLine } from '../format.js';
import { FRAME } from '../theme.js';
import {
  bottomScrim,
  fadeIn,
  fadeUp,
  fullImage,
  outroScene,
  rect,
  sBadge,
  sKicker,
  sPanel,
  sProgress,
  sRule,
  sText,
  scene,
  sec,
  stack,
  watermark,
} from './kit.js';

/**
 * «Ход строительства» — 15 секунд, шесть ударов.
 *
 * Формат отчётный: три кадра со стройки с подписями, затем шкала готовности
 * и срок сдачи. Подпись под фото — дата съёмки; если её нет, кадр просто
 * нумеруется, чтобы не выдумывать месяц, которого в данных не было.
 */
export function buildProgress(card: Card, theme: Theme, warnings: string[]): Timeline {
  const shots = pickMedia(card, ['progress', 'photo', 'render'], 3);
  if (!card.media.some((m) => m.kind === 'progress')) {
    warnings.push('Фотографий со стройки нет — использованы рендеры. Для отчёта лучше подставить реальные кадры.');
  }
  if (card.complex.readinessPercent == null) {
    warnings.push('Процент готовности не указан — шкала в кадре не показана.');
  }

  const name = clamp(card.complex.name || 'Новостройка', 46);
  const place = locationLine(card.complex.location);
  const completion = completionLabel(card.complex.completion);
  const readiness = card.complex.readinessPercent;

  const BASE = 1440;

  // 2.4 + 3×2.6 + 3.2 + 1.6 = 15.0 с ровно
  const d1 = sec(2.4);
  const dShot = sec(2.6);
  const d4 = sec(3.2);
  const d5 = sec(1.6);
  const shotCount = Math.max(shots.length, 1);

  const scenes: Scene[] = [];
  let at = 0;

  // ── 1. Шапка отчёта ──────────────────────────────────────────────────────
  scenes.push(
    scene('intro', at, d1, [
      shots[0] ? fullImage(shots[0].url, { ken: 'in', scrim: 0.52 }) : null,
      bottomScrim(1100),
      stack('bottom', BASE, [
        sKicker('Ход строительства', theme, 2),
        sRule(theme, 4),
        sText(name, 'display', { size: 84, anim: { in: fadeUp(6, 16, 52) } }),
        place ? sText(place, 'subtitle', { color: theme.textMuted, anim: { in: fadeUp(12, 14, 32) } }) : null,
      ], { gap: 16 }),
    ]),
  );
  at += d1;

  // ── 2–4. Кадры со стройки ────────────────────────────────────────────────
  for (let i = 0; i < 3; i += 1) {
    const shot = shots[i % shotCount];
    const caption = shot?.caption ?? `Кадр ${i + 1} из 3`;
    scenes.push(
      scene(`shot-${i + 1}`, at, dShot, [
        shot ? fullImage(shot.url, { ken: i % 2 === 0 ? 'in' : 'out', scrim: 0.4 }) : null,
        bottomScrim(820, 0.88),
        stack('bottom', BASE, [
          sBadge(`0${i + 1}`, theme, 4),
          sText(caption, 'title', { size: 50, anim: { in: fadeUp(8, 14, 32) } }),
        ], { gap: 20 }),
      ]),
    );
    at += dShot;
  }

  // ── 5. Готовность ────────────────────────────────────────────────────────
  scenes.push(
    scene('readiness', at, d4, [
      // Подложка на случай, если фото не загрузилось: z ниже картинки.
      rect({ x: 0, y: 0, w: FRAME.width, h: FRAME.height }, theme.bg, { radius: 0, z: 0, anim: fadeIn(0, 8) }),
      shots[2] ? fullImage(shots[2].url, { ken: 'out', scrim: 0.7 }) : null,
      rect({ x: 0, y: 0, w: FRAME.width, h: FRAME.height }, 'rgba(8,10,14,0.58)', { radius: 0, anim: fadeIn(0, 8) }),
      stack('top', 720, [
        sText('Готовность объекта', 'kicker', {
          color: theme.accent,
          uppercase: true,
          align: 'center',
          anim: { in: fadeIn(2, 10) },
        }),
        readiness != null
          ? sText(`${readiness}%`, 'display', { size: 200, align: 'center', anim: { in: fadeUp(6, 16, 48) } })
          : sText(completion ?? 'Строительство идёт', 'display', {
              size: 92,
              align: 'center',
              anim: { in: fadeUp(6, 16, 48) },
            }),
        readiness != null ? sProgress(readiness, theme, 10) : null,
        completion
          ? sPanel(theme, [
              sText(completion === 'Сдан' ? 'Статус' : 'Срок сдачи', 'caption', {
                color: theme.textMuted,
                align: 'center',
                shadow: false,
                anim: { in: fadeUp(25, 14, 24) },
              }),
              sText(completion, 'title', {
                size: 62,
                align: 'center',
                shadow: false,
                anim: { in: fadeUp(28, 14, 24) },
              }),
            ], { at: 22 })
          : null,
        card.complex.escrow
          ? sText('Эскроу-счета · 214-ФЗ', 'caption', {
              color: theme.textMuted,
              align: 'center',
              gapBefore: 8,
              anim: { in: fadeIn(34, 12) },
            })
          : null,
      ], { gap: 22 }),
      card.complex.developer?.name ? watermark(card.complex.developer.name, theme) : null,
    ]),
  );
  at += d4;

  // ── 6. Финал ─────────────────────────────────────────────────────────────
  scenes.push(
    outroScene(at, d5, theme, {
      title: name,
      line: completionPhrase(card.complex.completion) ?? place ?? undefined,
      cta: card.contact?.site ?? card.contact?.phone ?? 'Отчёты каждый месяц',
    }),
  );
  at += d5;

  return {
    version: 1,
    id: `${card.id}-progress`,
    cardId: card.id,
    scenario: 'progress',
    width: FRAME.width,
    height: FRAME.height,
    fps: FRAME.fps,
    durationInFrames: at,
    theme,
    scenes,
    caption: [
      `Ход строительства — ${name}`,
      readiness != null ? `готовность ${readiness}%` : null,
      completion ? (completion === 'Сдан' ? 'дом сдан' : `сдача ${completion}`) : null,
    ]
      .filter(Boolean)
      .join(' · '),
    warnings,
  };
}
