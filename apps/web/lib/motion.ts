/**
 * Motion numbers shared by every JS animation.
 *
 * These mirror the CSS duration tokens in `app/tokens.css` and must stay in
 * step: fast 150ms, base 200ms, sheet 250ms. Durations never exceed 250ms —
 * these transitions explain a state change, they are not an entrance show.
 */
export const DURATION = {
  fast: 0.15,
  base: 0.2,
  slow: 0.25,
} as const;

/** The same curve as `--habi-ease-standard`. */
export const EASE: [number, number, number, number] = [0.2, 0.6, 0.2, 1];

/** A bubble arriving from the composer has weight; a spring is honest there. */
export const ARRIVE_SPRING = {
  type: 'spring',
  stiffness: 420,
  damping: 32,
  mass: 0.6,
} as const;

/** Panels move a short distance; the grid column itself never animates width. */
export const PANEL_OFFSET = 12;
