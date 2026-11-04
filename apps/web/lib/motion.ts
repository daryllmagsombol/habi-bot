/**
 * Motion numbers shared by every JS animation.
 *
 * These mirror the CSS duration tokens in `app/tokens.css` and must stay in
 * step: fast 140ms, base 180ms, slow 200ms. Durations never exceed 200ms —
 * these transitions explain a state change, they are not an entrance show.
 */
export const DURATION = {
  fast: 0.14,
  base: 0.18,
  slow: 0.2,
} as const;

/** The same curve as `--habi-ease-standard`. */
export const EASE: [number, number, number, number] = [0.2, 0.8, 0.2, 1];

/** A bubble arriving from the composer has weight; a spring is honest there. */
export const ARRIVE_SPRING = {
  type: 'spring',
  stiffness: 420,
  damping: 32,
  mass: 0.6,
} as const;

/** Panels move a short distance and never animate their own width. */
export const PANEL_OFFSET = 10;

/** Gallery cards arrive together, offset by less than an eyeblink. */
export const STAGGER = 0.045;
