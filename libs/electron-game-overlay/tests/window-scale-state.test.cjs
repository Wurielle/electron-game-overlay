const assert = require('node:assert/strict');
const test = require('node:test');

const { physicalInputToDip } = require('../dist/lib/coordinate-space.js');
const {
  armAmbiguousPaintBarrier,
  createWindowScaleState,
  expectedWindowFrameSize,
  getActivePhysicalBounds,
  getPhysicalWindowGeometry,
  isWindowScaleTransitionPending,
  reconcileWindowFrame,
  reconcileWindowScale,
  resolveInputScaleFactor,
  sameWindowGeometry,
  scaleFactorFromMicros,
  scaleFactorToMicros,
} = require('../dist/lib/window-scale-state.js');

const display = (id, scaleFactor, width = 1920, height = 1080) => ({
  id,
  scaleFactor,
  width,
  height,
});

const bounds = (x, y, width, height) => ({ x, y, width, height });

test('each overlay window keeps independent active and desired raster bounds', () => {
  const oneX = createWindowScaleState(display(1, 1), bounds(20, 30, 320, 220));
  const twoX = createWindowScaleState(
    display(2, 2, 1280, 720),
    bounds(20, 30, 320, 220),
  );

  assert.deepEqual(oneX.activeRasterBounds, bounds(20, 30, 320, 220));
  assert.deepEqual(oneX.desiredRasterBounds, bounds(20, 30, 320, 220));
  assert.deepEqual(getActivePhysicalBounds(oneX), bounds(20, 30, 320, 220));
  assert.deepEqual(getActivePhysicalBounds(twoX), bounds(40, 60, 640, 440));
});

test('a desired scale remains pending until a matching frame arrives', () => {
  const initialBounds = bounds(200, 136, 320, 220);
  const initial = createWindowScaleState(display(1, 1), initialBounds);
  const pending = reconcileWindowScale(
    initial,
    display(2, 1.25, 1536, 864),
    initialBounds,
  );

  assert.equal(pending.pending, true);
  assert.equal(pending.shouldInvalidate, true);
  assert.equal(pending.desiredRasterChanged, true);
  assert.equal(pending.state.activeDisplay.scaleFactor, 1);
  assert.equal(pending.state.desiredDisplay.scaleFactor, 1.25);
  assert.deepEqual(pending.state.activeRasterBounds, initialBounds);
  assert.deepEqual(pending.state.desiredRasterBounds, initialBounds);

  const activeFrame = reconcileWindowFrame(pending.state, {
    width: 320,
    height: 220,
  });
  assert.equal(activeFrame.accepted, true);
  assert.equal(activeFrame.rasterChanged, false);
  assert.equal(activeFrame.scaleFactor, 1);

  const desiredFrame = reconcileWindowFrame(activeFrame.state, {
    width: 400,
    height: 275,
  });
  assert.equal(desiredFrame.accepted, true);
  assert.equal(desiredFrame.rasterChanged, true);
  assert.equal(desiredFrame.scaleFactor, 1.25);
  assert.equal(desiredFrame.state.activeDisplay.id, 2);
  assert.equal(isWindowScaleTransitionPending(desiredFrame.state), false);
});

test('ordinary resize preserves active geometry until the new raster arrives', () => {
  const initialBounds = bounds(10, 20, 640, 360);
  const resizedBounds = bounds(10, 20, 800, 450);
  const initial = createWindowScaleState(display(1, 1), initialBounds);
  const pending = reconcileWindowScale(initial, display(1, 1), resizedBounds);

  assert.equal(pending.pending, true);
  assert.equal(pending.shouldInvalidate, true);
  assert.deepEqual(pending.state.activeRasterBounds, initialBounds);
  assert.deepEqual(pending.state.desiredRasterBounds, resizedBounds);
  assert.deepEqual(getActivePhysicalBounds(pending.state), initialBounds);

  const oldPaint = reconcileWindowFrame(pending.state, {
    width: 640,
    height: 360,
  });
  assert.equal(oldPaint.accepted, true);
  assert.equal(oldPaint.rasterChanged, false);
  assert.deepEqual(oldPaint.state.activeRasterBounds, initialBounds);

  const newPaint = reconcileWindowFrame(oldPaint.state, {
    width: 800,
    height: 450,
  });
  assert.equal(newPaint.accepted, true);
  assert.equal(newPaint.rasterChanged, true);
  assert.deepEqual(newPaint.state.activeRasterBounds, resizedBounds);
});

test('position-only movement publishes immediately without a raster transition', () => {
  const initial = createWindowScaleState(
    display(1, 1.5),
    bounds(10, 20, 640, 360),
  );
  const movedBounds = bounds(-30, 40, 640, 360);
  const moved = reconcileWindowScale(initial, display(2, 1.5), movedBounds);

  assert.equal(moved.pending, false);
  assert.equal(moved.shouldInvalidate, false);
  assert.equal(moved.desiredRasterChanged, false);
  assert.deepEqual(moved.state.activeRasterBounds, movedBounds);
  assert.equal(moved.state.activeDisplay.id, 2);
  assert.deepEqual(getActivePhysicalBounds(moved.state), {
    x: -45,
    y: 60,
    width: 960,
    height: 540,
  });
});

test('placement advances while a resized raster remains pending', () => {
  const initial = createWindowScaleState(
    display(1, 1),
    bounds(10, 20, 640, 360),
  );
  const movedAndResized = reconcileWindowScale(
    initial,
    display(1, 1),
    bounds(40, 50, 800, 450),
  );

  assert.equal(movedAndResized.pending, true);
  assert.deepEqual(
    movedAndResized.state.activeRasterBounds,
    bounds(40, 50, 640, 360),
  );
  assert.deepEqual(
    movedAndResized.state.desiredRasterBounds,
    bounds(40, 50, 800, 450),
  );
});

test('same-size raster collision stays rejected until capture is armed', () => {
  const initial = createWindowScaleState(display(1, 1), bounds(0, 0, 500, 250));
  const pending = reconcileWindowScale(
    initial,
    display(2, 1.25),
    bounds(0, 0, 400, 200),
  ).state;
  const ambiguous = reconcileWindowFrame(pending, {
    width: 500,
    height: 250,
  });

  assert.equal(isWindowScaleTransitionPending(pending), true);
  assert.equal(ambiguous.accepted, false);
  assert.equal(ambiguous.reason, 'ambiguous');
  assert.equal(ambiguous.recovery, 'begin-capture');
  assert.deepEqual(ambiguous.activeSize, { width: 500, height: 250 });
  assert.deepEqual(ambiguous.desiredSize, { width: 500, height: 250 });
  assert.deepEqual(ambiguous.state.activeRasterBounds, bounds(0, 0, 500, 250));

  const stillCapturing = reconcileWindowFrame(ambiguous.state, {
    width: 500,
    height: 250,
  });
  assert.equal(stillCapturing.accepted, false);
  assert.equal(stillCapturing.recovery, 'wait-for-capture');

  const armed = armAmbiguousPaintBarrier(stillCapturing.state);
  const recovered = reconcileWindowFrame(armed, { width: 500, height: 250 });
  assert.equal(recovered.accepted, true);
  assert.equal(recovered.rasterChanged, true);
  assert.equal(recovered.scaleFactor, 1.25);
  assert.deepEqual(recovered.state.activeRasterBounds, bounds(0, 0, 400, 200));
});

test('unmatched frames retain the old active raster and both expected sizes', () => {
  const initialBounds = bounds(0, 0, 319.9, 220.75);
  const initial = createWindowScaleState(display(1, 1), initialBounds);
  const pending = reconcileWindowScale(
    initial,
    display(2, 1.25),
    initialBounds,
  ).state;
  const unmatched = reconcileWindowFrame(pending, {
    width: 397,
    height: 275,
  });

  assert.equal(unmatched.accepted, false);
  assert.equal(unmatched.reason, 'unmatched');
  assert.deepEqual(unmatched.activeSize, { width: 319, height: 220 });
  assert.deepEqual(unmatched.desiredSize, { width: 399, height: 275 });
  assert.equal(unmatched.state.activeDisplay.scaleFactor, 1);
});

test('bounded Electron OSR rounding becomes authoritative geometry', () => {
  const activeDisplay = display(1, 1.25);
  const rasterBounds = bounds(12, 16, 320, 200);
  const initial = createWindowScaleState(activeDisplay, rasterBounds);
  const roundedPaint = reconcileWindowFrame(initial, {
    width: 400,
    height: 251,
  });

  assert.equal(roundedPaint.accepted, true);
  assert.equal(roundedPaint.rasterChanged, true);
  assert.deepEqual(roundedPaint.state.activeFrameSize, {
    width: 400,
    height: 251,
  });
  assert.deepEqual(getActivePhysicalBounds(roundedPaint.state), {
    x: 15,
    y: 20,
    width: 400,
    height: 251,
  });
  const geometry = getPhysicalWindowGeometry(
    roundedPaint.state.activeRasterBounds,
    roundedPaint.state.activeDisplay,
    { resizable: false, dragBorder: 0, captionHeight: 0 },
    roundedPaint.state.activeFrameSize,
  );
  assert.deepEqual(geometry.rect, { x: 15, y: 20, width: 400, height: 251 });
  assert.equal(geometry.minWidth, 400);
  assert.equal(geometry.maxWidth, 400);
  assert.equal(geometry.minHeight, 251);
  assert.equal(geometry.maxHeight, 251);

  const outsideTolerance = reconcileWindowFrame(initial, {
    width: 400,
    height: 252,
  });
  assert.equal(outsideTolerance.accepted, false);
  assert.equal(outsideTolerance.reason, 'unmatched');
});

test('empty and invalid paint dimensions are never accepted by tolerance', () => {
  const state = createWindowScaleState(display(1, 1), bounds(0, 0, 1, 1));

  for (const frame of [
    { width: 0, height: 0 },
    { width: 0, height: 1 },
    { width: 1, height: 0 },
    { width: Number.NaN, height: 1 },
    { width: 1.5, height: 1 },
  ]) {
    const reconciliation = reconcileWindowFrame(state, frame);
    assert.equal(reconciliation.accepted, false);
    assert.equal(reconciliation.reason, 'unmatched');
  }
});

test('input prefers a valid packet scale tag and falls back for legacy packets', () => {
  assert.equal(scaleFactorToMicros(1.25), 1_250_000);
  assert.equal(scaleFactorFromMicros(1_250_000), 1.25);
  assert.equal(resolveInputScaleFactor(1_000_000, 1.25), 1);
  assert.equal(resolveInputScaleFactor(undefined, 1.25), 1.25);

  assert.equal(
    physicalInputToDip(125, resolveInputScaleFactor(1_000_000, 1.25)),
    125,
  );
  assert.equal(
    physicalInputToDip(125, resolveInputScaleFactor(undefined, 1.25)),
    100,
  );

  for (const invalid of [
    0,
    -1,
    1.5,
    0x1_0000_0000,
    Number.NaN,
    Infinity,
    '1250000',
  ]) {
    assert.equal(resolveInputScaleFactor(invalid, 1.5), 1.5);
  }
});

test('full geometry includes scale identity and ignores transient raster flags', () => {
  const activeDisplay = display(7, 1.5, 1280, 720);
  const rasterBounds = bounds(-12, 34, 640, 360);
  const geometry = getPhysicalWindowGeometry(rasterBounds, activeDisplay, {
    resizable: true,
    dragBorder: 10,
    captionHeight: 40,
  });

  assert.deepEqual(geometry, {
    rect: bounds(-18, 51, 960, 540),
    maxWidth: 1920,
    maxHeight: 1080,
    minWidth: 150,
    minHeight: 150,
    caption: { left: 15, right: 15, top: 15, height: 60 },
    dragBorderWidth: 15,
    scaleFactorMicros: 1_500_000,
  });
  assert.equal(
    sameWindowGeometry(geometry, { ...geometry, rasterChanged: true }),
    true,
  );
  assert.deepEqual(expectedWindowFrameSize(rasterBounds, 1.5), {
    width: 960,
    height: 540,
  });
});
