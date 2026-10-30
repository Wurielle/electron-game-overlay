import type { Rect } from './types.js';

export type WindowContentBoundsSource = {
  getContentBounds: () => Rect;
};

/** Returns the DIP bounds of the content surface that produces OSR paints. */
export function getWindowContentBounds(
  window: WindowContentBoundsSource,
): Rect {
  return { ...window.getContentBounds() };
}
