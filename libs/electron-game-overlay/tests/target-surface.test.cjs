const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getTargetFollowPhysicalBounds,
  normalizeTargetFollowOptions,
  parseOverlayTargetSurface,
  selectTargetSurface,
} = require('../dist/lib/target-surface.js');

const surface = (pid, surfaceId, x, revision = 1) =>
  parseOverlayTargetSurface({
    pid,
    surfaceId,
    hwnd: '0xabcd',
    revision,
    graphicsApi: 'd3d11',
    renderSize: { width: 1600, height: 900 },
    clientBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    clientScreenBounds: { x, y: 30, width: 1920, height: 1080 },
    windowScreenBounds: { x: x - 8, y: 0, width: 1936, height: 1119 },
    dpi: { x: 144, y: 144 },
    monitor: {
      id: '0x55',
      bounds: { x, y: 0, width: 2560, height: 1440 },
      workArea: { x, y: 0, width: 2560, height: 1400 },
    },
    focused: true,
    minimized: false,
    visible: true,
    fullscreen: false,
  });

test('target selector defaults to the newest matching live surface', () => {
  const first = surface(100, '0x1', 0);
  const second = surface(200, '0x2', -2560);
  const third = surface(100, '0x3', 2560);
  const surfaces = [first, second, third];

  assert.equal(
    selectTargetSurface(surfaces, normalizeTargetFollowOptions()),
    third,
  );
  assert.equal(
    selectTargetSurface(surfaces, normalizeTargetFollowOptions({ pid: 200 })),
    second,
  );
  assert.equal(
    selectTargetSurface(
      surfaces,
      normalizeTargetFollowOptions({ pid: 100, surfaceId: '0x1' }),
    ),
    first,
  );
  assert.equal(
    selectTargetSurface(
      surfaces,
      normalizeTargetFollowOptions({ surfaceId: '0xff' }),
    ),
    null,
  );
});

test('render and client follow areas keep screen placement but choose authoritative size', () => {
  const target = surface(100, '0x1', -2560);
  assert.deepEqual(getTargetFollowPhysicalBounds(target, 'render'), {
    x: -2560,
    y: 30,
    width: 1600,
    height: 900,
  });
  assert.deepEqual(getTargetFollowPhysicalBounds(target, 'client'), {
    x: -2560,
    y: 30,
    width: 1920,
    height: 1080,
  });
  assert.equal(target.dpi.scaleFactor, 1.5);
});

test('target-follow selectors reject ambiguous non-canonical identifiers', () => {
  assert.throws(
    () => normalizeTargetFollowOptions({ pid: 0 }),
    /unsigned non-zero/,
  );
  assert.throws(
    () => normalizeTargetFollowOptions({ surfaceId: '0xABCD' }),
    /canonical lowercase/,
  );
  assert.throws(
    () => normalizeTargetFollowOptions({ area: 'window' }),
    /render.*client/,
  );
});

test('target telemetry rejects zero and inexact revisions', () => {
  assert.equal(surface(100, '0x1', 0, 0), null);
  assert.equal(surface(100, '0x1', 0, Number.MAX_SAFE_INTEGER + 1), null);
  assert.ok(surface(100, '0x1', 0, Number.MAX_SAFE_INTEGER));
});

test('target telemetry enforces native non-zero handles and physical geometry ranges', () => {
  const valid = surface(100, '0x1', 0);
  assert.ok(valid);

  assert.equal(surface(100, '0x0', 0), null);
  assert.ok(surface(100, '0xffffffffffffffff', 0));
  assert.equal(surface(100, '0x10000000000000000', 0), null);
  assert.equal(parseOverlayTargetSurface({ ...valid, hwnd: '0x0' }), null);
  assert.equal(
    parseOverlayTargetSurface({
      ...valid,
      hwnd: '0x10000000000000000',
    }),
    null,
  );
  assert.equal(
    parseOverlayTargetSurface({
      ...valid,
      monitor: { ...valid.monitor, id: '0x0' },
    }),
    null,
  );
  assert.equal(
    parseOverlayTargetSurface({
      ...valid,
      monitor: { ...valid.monitor, id: '0x10000000000000000' },
    }),
    null,
  );
  assert.equal(
    parseOverlayTargetSurface({
      ...valid,
      clientBounds: { ...valid.clientBounds, width: 0 },
    }),
    null,
  );
  assert.equal(
    parseOverlayTargetSurface({
      ...valid,
      clientScreenBounds: { ...valid.clientScreenBounds, x: 0x8000_0000 },
    }),
    null,
  );
  assert.equal(
    parseOverlayTargetSurface({
      ...valid,
      windowScreenBounds: {
        ...valid.windowScreenBounds,
        y: -0x8000_0001,
      },
    }),
    null,
  );
});
