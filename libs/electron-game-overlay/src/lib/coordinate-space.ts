import type { Rect } from './types.js';

function roundSignedToNearest(value: number): number {
  const magnitude = Math.round(Math.abs(value));
  if (magnitude === 0) {
    return 0;
  }

  return value < 0 ? -magnitude : magnitude;
}

/** Convert a signed Electron DIP placement coordinate to physical pixels. */
export function dipPlacementToPhysical(
  value: number,
  scaleFactor: number,
): number {
  return roundSignedToNearest(value * scaleFactor);
}

/** Convert a nonnegative Electron DIP extent to physical pixels. */
export function dipExtentToPhysical(
  value: number,
  scaleFactor: number,
): number {
  return Math.floor(value * scaleFactor);
}

/** Convert an Electron DIP rectangle to the native physical-pixel contract. */
export function dipRectToPhysical(rect: Rect, scaleFactor: number): Rect {
  return {
    x: dipPlacementToPhysical(rect.x, scaleFactor),
    y: dipPlacementToPhysical(rect.y, scaleFactor),
    width: dipExtentToPhysical(rect.width, scaleFactor),
    height: dipExtentToPhysical(rect.height, scaleFactor),
  };
}

/** Convert a possibly signed overlay-local physical input coordinate to DIP. */
export function physicalInputToDip(value: number, scaleFactor: number): number {
  return roundSignedToNearest(value / scaleFactor);
}
