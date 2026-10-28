/**
 * Единая модель данных: карточка объекта + таймлайн видео.
 *
 * Принцип: адаптеры (фид / URL / форма) приводят сырьё к `Card`.
 * Сценарий превращает `Card` в `Timeline` — чистый JSON без функций,
 * который одинаково понимают браузерное превью и серверный рендер.
 */

// ---------------------------------------------------------------------------
// Карточка объекта
// ---------------------------------------------------------------------------

export type MediaKind = 'render' | 'plan' | 'photo' | 'progress' | 'map' | 'logo';

export interface Media {
  kind: MediaKind;
  url: string;
  /** Подпись — используется в сценах с планировками и ходом стройки. */
  caption?: string;
  width?: number;
  height?: number;
  /** Точка интереса 0..1 — куда целиться при кадрировании cover. */
  focus?: { x: number; y: number };
}

export interface Location {
  city?: string;
  district?: string;
  street?: string;
  /** Готовая строка, если разбор на части не удался. */
  raw?: string;
  metro?: { name: string; minutes?: number; byFoot?: boolean };
  lat?: number;
  lon?: number;
}

export interface Price {
  /** Всегда в минорных единицах нет — храним целые рубли. */
  value: number;
  currency: 'RUB';
  /** true, если это «цена от» по всему ЖК, а не точная цена лота. */
  isFrom?: boolean;
  perSquareMeter?: number;
  oldValue?: number;
}

export interface Mortgage {
  /** Годовая ставка в процентах, например 5.9 */
  rate: number;
  monthlyPayment?: number;
  downPaymentPercent?: number;
  termYears?: number;
  /** «Семейная», «IT-ипотека», «Господдержка» и т.п. */
  program?: string;
}

export interface Promo {
  title: string;
  subtitle?: string;
  discountPercent?: number;
  discountValue?: number;
  /** ISO-дата окончания акции. */
  until?: string;
}

export interface Developer {
  name: string;
  logoUrl?: string;
}

export interface Complex {
  name: string;
  location: Location;
  developer?: Developer;
  /** «Комфорт», «Бизнес», «Премиум» */
  segment?: string;
  /** Короткие буллеты для чипов: «Школа во дворе», «Паркинг», «Своя набережная». */
  highlights?: string[];
  /** Квартал сдачи, ISO-дата или «IV кв. 2027». */
  completion?: string;
  /** 0..100 */
  readinessPercent?: number;
  buildingsCount?: number;
  /** Этажность дома — отдельно от этажа конкретного лота. */
  floorsTotal?: number;
  /** Отделка, заявленная по всему комплексу. */
  finishing?: string;
  escrow?: boolean;
}

export interface Lot {
  /** Внутренний артикул / номер квартиры. */
  id?: string;
  rooms?: number;
  /** true для студии; тогда rooms игнорируется. */
  isStudio?: boolean;
  areaTotal?: number;
  areaLiving?: number;
  areaKitchen?: number;
  floor?: number;
  floorsTotal?: number;
  building?: string;
  section?: string;
  /** «Черновая», «White box», «С отделкой» */
  finishing?: string;
  ceilingHeight?: number;
  hasBalcony?: boolean;
  /** Вид из окон: «на парк», «во двор». */
  view?: string;
}

export interface Card {
  /** Стабильный идентификатор для кеша и имени файла. */
  id: string;
  source: SourceKind;
  sourceUrl?: string;
  complex: Complex;
  lot?: Lot;
  price?: Price;
  mortgage?: Mortgage;
  promo?: Promo;
  media: Media[];
  /** Телефон / сайт для финального кадра. */
  contact?: { phone?: string; site?: string; qrUrl?: string };
  /** Что не удалось извлечь — виджет подсветит эти поля в форме. */
  missing: string[];
  fetchedAt: string;
}

export type SourceKind = 'feed' | 'url' | 'manual';

// ---------------------------------------------------------------------------
// Сценарии
// ---------------------------------------------------------------------------

export type ScenarioId =
  | 'complex-overview' // обзор ЖК, 10 с
  | 'lot-plan' // лот с планировкой, 15 с
  | 'promo' // акция / ипотека, 10 с
  | 'progress'; // ход строительства, 15 с

export interface ScenarioMeta {
  id: ScenarioId;
  title: string;
  seconds: 10 | 15;
  /** Поля карточки, без которых сценарий не соберётся. */
  requires: string[];
  description: string;
}

// ---------------------------------------------------------------------------
// Таймлайн (чистый JSON, общий для превью и рендера)
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Easing = 'linear' | 'easeOut' | 'easeInOut' | 'backOut' | 'expoOut';

export interface AnimSpec {
  type: 'fade' | 'fadeUp' | 'fadeDown' | 'scaleIn' | 'wipeUp' | 'slideLeft' | 'slideRight';
  /** Кадр начала, относительно начала сцены. */
  at: number;
  dur: number;
  easing?: Easing;
  /** Смещение в пикселях для fadeUp/slideLeft и т.п. */
  distance?: number;
}

export interface KenBurns {
  fromScale: number;
  toScale: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  easing?: Easing;
}

export type TextRole =
  | 'display' // крупный заголовок, название ЖК
  | 'title'
  | 'subtitle'
  | 'body'
  | 'caption'
  | 'price'
  | 'kicker'; // мелкий надзаголовок капсом

interface LayerBase {
  id: string;
  box: Box;
  anim?: { in?: AnimSpec; out?: AnimSpec };
  opacity?: number;
  z?: number;
}

export interface ImageLayer extends LayerBase {
  kind: 'image';
  src: string;
  fit: 'cover' | 'contain';
  radius?: number;
  ken?: KenBurns;
  /** Затемнение поверх картинки 0..1 — чтобы текст читался. */
  scrim?: number;
  background?: string;
}

export interface TextLayer extends LayerBase {
  kind: 'text';
  text: string;
  role: TextRole;
  align?: 'left' | 'center' | 'right';
  color?: string;
  /** Принудительный размер, если роль не подходит. */
  size?: number;
  lineHeight?: number;
  weight?: number;
  uppercase?: boolean;
  maxLines?: number;
  shadow?: boolean;
  /** Зачёркнутая строка — старая цена в сценарии акции. */
  strike?: boolean;
}

export interface RectLayer extends LayerBase {
  kind: 'rect';
  fill: string;
  radius?: number;
  blur?: number;
}

export interface GradientLayer extends LayerBase {
  kind: 'gradient';
  from: string;
  to: string;
  angle?: number;
  /**
   * Радиальный градиент со смещённым центром. Плоскую заливку он
   * превращает в освещённую поверхность — свет будто падает извне,
   * и фон перестаёт выглядеть как незаполненный прямоугольник.
   */
  radial?: { x: number; y: number; r: number };
}

export interface ChipsLayer extends LayerBase {
  kind: 'chips';
  items: string[];
  color?: string;
  background?: string;
  /** Задержка между появлением чипов, в кадрах. */
  stagger?: number;
}

export interface CounterLayer extends LayerBase {
  kind: 'counter';
  from: number;
  to: number;
  dur: number;
  at: number;
  prefix?: string;
  suffix?: string;
  role?: TextRole;
  color?: string;
  align?: 'left' | 'center' | 'right';
  easing?: Easing;
  /** Разрядность пробелами — для рублей. */
  grouped?: boolean;
}

export interface ProgressLayer extends LayerBase {
  kind: 'progress';
  value: number; // 0..100
  at: number;
  dur: number;
  color?: string;
  trackColor?: string;
  label?: string;
}

/**
 * Элемент потокового блока. Высоту считает браузер, а не сценарий, —
 * иначе длинное название ЖК переносится на вторую строку и наезжает
 * на адрес под ним.
 */
export type StackItem =
  | ({ type: 'text'; gapBefore?: number } & Omit<TextLayer, 'kind' | 'id' | 'box' | 'z'>)
  | ({ type: 'chips'; gapBefore?: number } & Omit<ChipsLayer, 'kind' | 'id' | 'box' | 'z'>)
  | ({ type: 'counter'; gapBefore?: number } & Omit<CounterLayer, 'kind' | 'id' | 'box' | 'z'>)
  | ({ type: 'progress'; gapBefore?: number } & Omit<ProgressLayer, 'kind' | 'id' | 'box' | 'z'>)
  | {
      type: 'rule';
      gapBefore?: number;
      width: number;
      height: number;
      color: string;
      anim?: { in?: AnimSpec };
    }
  | {
      /** Сетка метрик: площадь, этаж, отделка, потолки. */
      type: 'grid';
      gapBefore?: number;
      columns: number;
      gap?: number;
      cells: { value: string; label: string }[];
      background?: string;
      at?: number;
      stagger?: number;
    }
  | {
      /** Плашка-пилюля: номер кадра, статус, метка акции. */
      type: 'badge';
      gapBefore?: number;
      text: string;
      background: string;
      color: string;
      anim?: { in?: AnimSpec };
    }
  | {
      /** Подложка с вложенными элементами: карточка платежа, блок срока сдачи. */
      type: 'panel';
      gapBefore?: number;
      background: string;
      padding?: number;
      radius?: number;
      items: StackItem[];
      anim?: { in?: AnimSpec };
    };

/**
 * Декоративная графика фона.
 *
 * Сплошная заливка в вертикальном видео читается как незаполненный
 * шаблон, но украшать кадр абстракцией — значит просто сменить одну
 * пустоту на другую. Поэтому набор узкий и взят из языка, которым
 * объект описывают по-настоящему: чертёжная сетка, фасад, обмерные
 * засечки. `facade` вдобавок строится из этажности конкретного дома,
 * то есть рисует именно его, а не «какой-нибудь».
 *
 * Все варианты детерминированы: при равном `seed` картинка совпадает
 * покадрово, иначе превью разошлось бы с экспортом.
 */
export type GraphicVariant =
  | 'grid' // чертёжная сетка, как миллиметровка
  | 'facade' // сетка окон по этажности, часть светится
  | 'rings' // концентрические дуги — радиусы доступности
  | 'rays' // расходящиеся лучи из угла
  | 'ticks' // обмерная линейка с засечками
  | 'noise'; // зерно, чтобы заливка не была стерильной

export interface GraphicLayer extends LayerBase {
  kind: 'graphic';
  variant: GraphicVariant;
  color: string;
  /** Второй цвет: подсветка окон, акцент засечек. */
  accent?: string;
  /** 0..1 — насколько графика проступает. */
  strength?: number;
  /** Шаг сетки / плотность элементов. */
  step?: number;
  /** Этажей в доме — для `facade`. */
  floors?: number;
  /** Одинаковый seed даёт одинаковый рисунок. */
  seed?: number;
  /** Медленный дрейф за время сцены — оживляет статичный фон. */
  drift?: { x?: number; y?: number; scale?: number };
}

export interface StackLayer extends LayerBase {
  kind: 'stack';
  /**
   * `bottom` — блок растёт вверх от `box.y`, и добавление строки сдвигает
   * верх, а не низ. Для подписей поверх рендера это единственный безопасный
   * режим. `top` — обычный поток вниз.
   */
  anchor: 'top' | 'bottom';
  gap?: number;
  items: StackItem[];
}

export type Layer =
  | ImageLayer
  | TextLayer
  | RectLayer
  | GradientLayer
  | ChipsLayer
  | CounterLayer
  | ProgressLayer
  | GraphicLayer
  | StackLayer;

export interface Scene {
  id: string;
  /** Абсолютный кадр начала сцены. */
  from: number;
  duration: number;
  background?: string;
  /** Переход на входе в сцену. */
  transition?: { type: 'cut' | 'fade' | 'slideUp' | 'whip'; dur: number };
  layers: Layer[];
}

export interface Theme {
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  fontDisplay: string;
  fontBody: string;
  radius: number;
  /** Логотип в углу, если есть. */
  watermark?: { text?: string; url?: string };
}

export interface Timeline {
  version: 1;
  id: string;
  cardId: string;
  scenario: ScenarioId;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  theme: Theme;
  scenes: Scene[];
  /** Текст для описания поста — отдаётся рядом с видео. */
  caption?: string;
  /** Предупреждения: чего не хватило, что подставлено по умолчанию. */
  warnings: string[];
}
