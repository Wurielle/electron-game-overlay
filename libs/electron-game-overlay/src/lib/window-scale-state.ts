import { dipExtentToPhysical, dipRectToPhysical } from './coordinate-space.js';
import type { Rect } from './types.js';

const SCALE_FACTOR_MICROS = 1_000_000;
const MAX_SCALE_FACTOR_MICROS = 0xffff_ffff;

export type FrameSize = {
  width: number;
  height: number;
};

export type WindowDisplayScale = {
  id: number;
  scaleFactor: number;
  width: number;
  height: number;
};

export type WindowScaleState = {
  activeDisplay: WindowDisplayScale;
  desiredDisplay: WindowDisplayScale;
  activeRasterBounds: Rect;
  desiredRasterBounds: Rect;
  activeFrameSize: FrameSize;
  ambiguousPaintBarrier: 'idle' | 'capturing' | 'armed';
};

export type WindowGeometryOptions = {
  dragBorder: number;
  captionHeight: number;
};

export type WindowGeometry = {
  rect: Rect;
  caption: {
    left: number;
    right: number;
    top: number;
    height: number;
  };
  scaleFactorMicros: number;
  rasterChanged?: boolean;
};

export type WindowScaleReconciliation = {
  state: WindowScaleState;
  pending: boolean;
  shouldInvalidate: boolean;
  desiredRasterChanged: boolean;
};

export type WindowFrameReconciliation =
  | {
      accepted: true;
      state: WindowScaleState;
      scaleFactor: number;
      rasterChanged: boolean;
    }
  | {
      accepted: false;
      state: WindowScaleState;
      activeSize: FrameSize;
      desiredSize: FrameSize;
      reason: 'ambiguous' | 'unmatched';
      recovery: 'begin-capture' | 'wait-for-capture' | 'none';
    };

export function createWindowScaleState(
  display: WindowDisplayScale,
  rasterBounds: Rect,
): WindowScaleState {
  const bounds = copyRect(rasterBounds);
  return {
    activeDisplay: copyDisplay(display),
    desiredDisplay: copyDisplay(display),
    activeRasterBounds: bounds,
    desiredRasterBounds: copyRect(rasterBounds),
    activeFrameSize: expectedWindowFrameSize(bounds, display.scaleFactor),
    ambiguousPaintBarrier: 'idle',
  };
}

export function reconcileWindowScale(
  current: WindowScaleState,
  desiredDisplay: WindowDisplayScale,
  desiredRasterBounds: Rect,
): WindowScaleReconciliation {
  const desiredRasterChanged = !sameRasterDefinition(
    current.desiredDisplay,
    current.desiredRasterBounds,
    desiredDisplay,
    desiredRasterBounds,
  );
  const desiredMatchesActiveRaster = sameRasterDefinition(
    current.activeDisplay,
    current.activeRasterBounds,
    desiredDisplay,
    desiredRasterBounds,
  );

  // Placement is independent of the backing bitmap, so apply x/y immediately.
  // Any width, height, or scale change remains staged until a matching paint.
  const state: WindowScaleState = desiredMatchesActiveRaster
    ? {
        activeDisplay: copyDisplay(desiredDisplay),
        desiredDisplay: copyDisplay(desiredDisplay),
        activeRasterBounds: copyRect(desiredRasterBounds),
        desiredRasterBounds: copyRect(desiredRasterBounds),
        activeFrameSize: copyFrameSize(current.activeFrameSize),
        ambiguousPaintBarrier: 'idle',
      }
    : {
        activeDisplay: copyDisplay(current.activeDisplay),
        desiredDisplay: copyDisplay(desiredDisplay),
        activeRasterBounds: {
          ...current.activeRasterBounds,
          x: desiredRasterBounds.x,
          y: desiredRasterBounds.y,
        },
        desiredRasterBounds: copyRect(desiredRasterBounds),
        activeFrameSize: copyFrameSize(current.activeFrameSize),
        ambiguousPaintBarrier: desiredRasterChanged
          ? 'idle'
          : current.ambiguousPaintBarrier,
      };
  const pending = isWindowScaleTransitionPending(state);

  return {
    state,
    pending,
    shouldInvalidate: pending && desiredRasterChanged,
    desiredRasterChanged,
  };
}

export function reconcileWindowFrame(
  current: WindowScaleState,
  frameSize: FrameSize,
): WindowFrameReconciliation {
  const activeSize = current.activeFrameSize;
  const desiredSize = expectedWindowFrameSize(
    current.desiredRasterBounds,
    current.desiredDisplay.scaleFactor,
  );
  const pending = isWindowScaleTransitionPending(current);
  const matchesActive = frameSizeMatches(frameSize, activeSize);
  const matchesDesired = frameSizeMatches(frameSize, desiredSize);

  // Pixel dimensions alone cannot identify which raster produced this paint.
  // Size cannot identify this paint. The session obtains a renderer-state
  // acknowledgement and a causally subsequent capture before arming it.
  if (pending && matchesActive && matchesDesired) {
    const beginCapture = current.ambiguousPaintBarrier === 'idle';
    if (current.ambiguousPaintBarrier === 'armed') {
      return commitDesiredRaster(current, frameSize);
    }

    return {
      accepted: false,
      state: beginCapture
        ? { ...current, ambiguousPaintBarrier: 'capturing' }
        : current,
      activeSize,
      desiredSize,
      reason: 'ambiguous',
      recovery: beginCapture ? 'begin-capture' : 'wait-for-capture',
    };
  }

  if (pending && matchesDesired) {
    return commitDesiredRaster(current, frameSize);
  }

  if (matchesActive) {
    const rasterChanged = !sameFrameSize(frameSize, current.activeFrameSize);
    return {
      accepted: true,
      state: rasterChanged
        ? { ...current, activeFrameSize: copyFrameSize(frameSize) }
        : current,
      scaleFactor: current.activeDisplay.scaleFactor,
      rasterChanged,
    };
  }

  return {
    accepted: false,
    state: current,
    activeSize,
    desiredSize,
    reason: 'unmatched',
    recovery: 'none',
  };
}

export function armAmbiguousPaintBarrier(
  state: WindowScaleState,
): WindowScaleState {
  if (state.ambiguousPaintBarrier !== 'capturing') {
    return state;
  }

  return {
    ...state,
    ambiguousPaintBarrier: 'armed',
  };
}

export function resetAmbiguousPaintBarrier(
  state: WindowScaleState,
): WindowScaleState {
  if (state.ambiguousPaintBarrier === 'idle') {
    return state;
  }

  return {
    ...state,
    ambiguousPaintBarrier: 'idle',
  };
}

export function expectedWindowFrameSize(
  rasterBounds: Pick<Rect, 'width' | 'height'>,
  scaleFactor: number,
): FrameSize {
  return {
    width: dipExtentToPhysical(rasterBounds.width, scaleFactor),
    height: dipExtentToPhysical(rasterBounds.height, scaleFactor),
  };
}

export function getActivePhysicalBounds(state: WindowScaleState): Rect {
  const rect = dipRectToPhysical(
    state.activeRasterBounds,
    state.activeDisplay.scaleFactor,
  );
  return {
    ...rect,
    ...state.activeFrameSize,
  };
}

export function getPhysicalWindowGeometry(
  rasterBounds: Rect,
  display: WindowDisplayScale,
  options: WindowGeometryOptions,
  frameSize = expectedWindowFrameSize(rasterBounds, display.scaleFactor),
): WindowGeometry {
  const scaleFactor = display.scaleFactor;
  const rect = dipRectToPhysical(rasterBounds, scaleFactor);

  return {
    rect: {
      ...rect,
      ...frameSize,
    },
    caption: {
      left: dipExtentToPhysical(options.dragBorder, scaleFactor),
      right: dipExtentToPhysical(options.dragBorder, scaleFactor),
      top: dipExtentToPhysical(options.dragBorder, scaleFactor),
      height: dipExtentToPhysical(options.captionHeight, scaleFactor),
    },
    scaleFactorMicros: scaleFactorToMicros(scaleFactor),
  };
}

export function sameWindowGeometry(
  left: WindowGeometry,
  right: WindowGeometry,
): boolean {
  return (
    left.rect.x === right.rect.x &&
    left.rect.y === right.rect.y &&
    left.rect.width === right.rect.width &&
    left.rect.height === right.rect.height &&
    left.caption.left === right.caption.left &&
    left.caption.right === right.caption.right &&
    left.caption.top === right.caption.top &&
    left.caption.height === right.caption.height &&
    left.scaleFactorMicros === right.scaleFactorMicros
  );
}

export function isWindowScaleTransitionPending(
  state: WindowScaleState,
): boolean {
  return !sameRasterDefinition(
    state.activeDisplay,
    state.activeRasterBounds,
    state.desiredDisplay,
    state.desiredRasterBounds,
  );
}

export function scaleFactorToMicros(scaleFactor: number): number {
  return Math.round(scaleFactor * SCALE_FACTOR_MICROS);
}

export function scaleFactorFromMicros(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_SCALE_FACTOR_MICROS
  ) {
    return null;
  }

  const scaleFactor = value / SCALE_FACTOR_MICROS;
  return Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : null;
}

export function resolveInputScaleFactor(
  scaleFactorMicros: unknown,
  fallbackScaleFactor: number,
): number {
  return scaleFactorFromMicros(scaleFactorMicros) ?? fallbackScaleFactor;
}

function sameRasterDefinition(
  leftDisplay: WindowDisplayScale,
  leftBounds: Pick<Rect, 'width' | 'height'>,
  rightDisplay: WindowDisplayScale,
  rightBounds: Pick<Rect, 'width' | 'height'>,
): boolean {
  return (
    leftDisplay.scaleFactor === rightDisplay.scaleFactor &&
    leftBounds.width === rightBounds.width &&
    leftBounds.height === rightBounds.height
  );
}

function sameFrameSize(left: FrameSize, right: FrameSize): boolean {
  return left.width === right.width && left.height === right.height;
}

function frameSizeMatches(actual: FrameSize, expected: FrameSize): boolean {
  return (
    validFrameSize(actual) &&
    validFrameSize(expected) &&
    Math.abs(actual.width - expected.width) <= 1 &&
    Math.abs(actual.height - expected.height) <= 1
  );
}

function validFrameSize(size: FrameSize): boolean {
  return (
    Number.isSafeInteger(size.width) &&
    Number.isSafeInteger(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

function commitDesiredRaster(
  current: WindowScaleState,
  frameSize: FrameSize,
): Extract<WindowFrameReconciliation, { accepted: true }> {
  return {
    accepted: true,
    state: {
      activeDisplay: copyDisplay(current.desiredDisplay),
      desiredDisplay: copyDisplay(current.desiredDisplay),
      activeRasterBounds: copyRect(current.desiredRasterBounds),
      desiredRasterBounds: copyRect(current.desiredRasterBounds),
      activeFrameSize: copyFrameSize(frameSize),
      ambiguousPaintBarrier: 'idle',
    },
    scaleFactor: current.desiredDisplay.scaleFactor,
    rasterChanged: true,
  };
}

function copyDisplay(display: WindowDisplayScale): WindowDisplayScale {
  return { ...display };
}

function copyRect(rect: Rect): Rect {
  return { ...rect };
}

function copyFrameSize(size: FrameSize): FrameSize {
  return { ...size };
}
