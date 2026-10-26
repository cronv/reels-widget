import type { Card, ScenarioId, ScenarioMeta, Theme, Timeline } from '../types.js';
import { accentPresets, makeTheme } from '../theme.js';
import { resetIds } from './kit.js';
import { buildComplexOverview } from './complex-overview.js';
import { buildLotPlan } from './lot-plan.js';
import { buildPromo } from './promo.js';
import { buildProgress } from './progress.js';

export const SCENARIOS: Record<ScenarioId, ScenarioMeta> = {
  'complex-overview': {
    id: 'complex-overview',
    title: 'Обзор ЖК',
    seconds: 10,
    requires: ['complex.name'],
    description: 'Название, локация, преимущества и цена «от». Универсальный ролик для первого касания.',
  },
  'lot-plan': {
    id: 'lot-plan',
    title: 'Лот с планировкой',
    seconds: 15,
    requires: ['complex.name', 'lot.areaTotal'],
    description: 'Параметры квартиры, планировка на светлом фоне, цена и ипотечный платёж.',
  },
  promo: {
    id: 'promo',
    title: 'Акция / ипотека',
    seconds: 10,
    requires: ['complex.name'],
    description: 'Оффер первым кадром, старая и новая цена, ставка и платёж, дедлайн.',
  },
  progress: {
    id: 'progress',
    title: 'Ход строительства',
    seconds: 15,
    requires: ['complex.name'],
    description: 'Три кадра со стройки, шкала готовности и срок сдачи.',
  },
};

/** Акцент под характер ролика: акция — горячий, остальные — спокойный. */
const SCENARIO_ACCENT: Record<ScenarioId, string> = {
  'complex-overview': accentPresets.warm,
  'lot-plan': accentPresets.warm,
  promo: accentPresets.hot,
  progress: accentPresets.sky,
};

export interface BuildOptions {
  /**
   * Переопределение темы: фирменный цвет, шрифты, вотермарка.
   * Переданный `accent` всегда побеждает акцент сценария по умолчанию.
   */
  theme?: Partial<Theme>;
}

/**
 * Сообщает, можно ли собрать сценарий из этой карточки.
 * Виджет использует это, чтобы гасить недоступные кнопки и объяснять почему.
 */
export function checkAvailability(
  card: Card,
  scenario: ScenarioId,
): { ok: boolean; missing: string[] } {
  const meta = SCENARIOS[scenario];
  const missing = meta.requires.filter((field) => card.missing.includes(field));
  return { ok: missing.length === 0, missing };
}

/** Карточка → таймлайн. Чистая функция: одинаковый вход даёт одинаковый JSON. */
export function buildTimeline(card: Card, scenario: ScenarioId, opts: BuildOptions = {}): Timeline {
  resetIds();

  const theme = makeTheme({
    ...opts.theme,
    accent: opts.theme?.accent ?? SCENARIO_ACCENT[scenario],
  });

  const warnings: string[] = [];
  const availability = checkAvailability(card, scenario);
  if (!availability.ok) {
    warnings.push(`Не хватает обязательных полей: ${availability.missing.join(', ')}.`);
  }

  const timeline = (() => {
    switch (scenario) {
      case 'complex-overview':
        return buildComplexOverview(card, theme, warnings);
      case 'lot-plan':
        return buildLotPlan(card, theme, warnings);
      case 'promo':
        return buildPromo(card, theme, warnings);
      case 'progress':
        return buildProgress(card, theme, warnings);
      default: {
        const exhaustive: never = scenario;
        throw new Error(`Неизвестный сценарий: ${String(exhaustive)}`);
      }
    }
  })();

  assertTimeline(timeline);
  return timeline;
}

/**
 * Страховка от расхождения сцен и заявленного хронометража: ролик «на 10
 * секунд» обязан быть ровно 10 секунд, иначе площадки обрежут финальный кадр,
 * а превью разойдётся с экспортом. Ошибка здесь — всегда баг сценария.
 */
export function assertTimeline(timeline: Timeline): void {
  const expected = SCENARIOS[timeline.scenario].seconds * timeline.fps;
  if (timeline.durationInFrames !== expected) {
    throw new Error(
      `Сценарий «${timeline.scenario}» собрал ${timeline.durationInFrames} кадров вместо ${expected}.`,
    );
  }
  let cursor = 0;
  for (const scene of timeline.scenes) {
    if (scene.from !== cursor) {
      throw new Error(`Разрыв таймлайна на сцене «${scene.id}»: ${scene.from} вместо ${cursor}.`);
    }
    if (scene.duration <= 0) {
      throw new Error(`Сцена «${scene.id}» имеет нулевую длительность.`);
    }
    cursor += scene.duration;
  }
  if (cursor !== timeline.durationInFrames) {
    throw new Error(`Сумма сцен (${cursor}) не равна длительности (${timeline.durationInFrames}).`);
  }
}

/** Собирает все доступные сценарии разом — для превью-ленты в виджете. */
export function buildAll(card: Card, opts: BuildOptions = {}): Timeline[] {
  return (Object.keys(SCENARIOS) as ScenarioId[])
    .filter((id) => checkAvailability(card, id).ok)
    .map((id) => buildTimeline(card, id, opts));
}

export { buildComplexOverview, buildLotPlan, buildPromo, buildProgress };
