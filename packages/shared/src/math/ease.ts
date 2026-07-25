/** Easing curves for animation clip keyframes. All map [0,1] -> roughly [0,1]. */

export type EaseName =
  | 'linear'
  | 'quadIn'
  | 'quadOut'
  | 'quadInOut'
  | 'cubicIn'
  | 'cubicOut'
  | 'cubicInOut'
  | 'backOut'
  | 'elasticOut'
  | 'step';

export type EaseFn = (t: number) => number;

const linear: EaseFn = (t) => t;
const quadIn: EaseFn = (t) => t * t;
const quadOut: EaseFn = (t) => t * (2 - t);
const quadInOut: EaseFn = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
const cubicIn: EaseFn = (t) => t * t * t;
const cubicOut: EaseFn = (t) => {
  const f = t - 1;
  return f * f * f + 1;
};
const cubicInOut: EaseFn = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 + (t - 1) * (2 * t - 2) * (2 * t - 2);

/** Overshoots past 1 then settles. Good for a throw release or a comedy bob. */
const backOut: EaseFn = (t) => {
  const c = 1.70158;
  const f = t - 1;
  return f * f * ((c + 1) * f + c) + 1;
};

const elasticOut: EaseFn = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const p = 0.3;
  return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * (Math.PI * 2)) / p) + 1;
};

/** No interpolation -- hold the start value until the next key. */
const step: EaseFn = (t) => (t >= 1 ? 1 : 0);

export const EASES: Record<EaseName, EaseFn> = {
  linear,
  quadIn,
  quadOut,
  quadInOut,
  cubicIn,
  cubicOut,
  cubicInOut,
  backOut,
  elasticOut,
  step,
};

export function ease(name: EaseName | undefined, t: number): number {
  return (name ? EASES[name] : linear)(t);
}
