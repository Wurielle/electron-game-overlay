const assert = require('node:assert/strict');
const test = require('node:test');

const { parseOverlayDiagnostic } = require('../dist/lib/diagnostic.js');

const producerDiagnostic = (code, context, overrides = {}) => ({
  schemaVersion: 1,
  source: 'electron-game-overlay',
  code,
  context,
  ...overrides,
});

test('canonicalizes and freezes the fixed producer diagnostic contract', () => {
  const cases = [
    {
      code: 'producer-window-registered',
      severity: 'info',
      message: 'The Electron overlay SDK registered an offscreen window.',
      context: { windowId: 7 },
    },
    {
      code: 'producer-window-publication-failed',
      severity: 'error',
      message:
        'The Electron overlay SDK could not publish an offscreen window update.',
      context: {
        windowId: 7,
        operation: 'register',
        errorCode: 'EIO',
      },
    },
    {
      code: 'producer-frame-publication-started',
      severity: 'info',
      message:
        'The Electron overlay SDK published the first offscreen frame for a window.',
      context: { windowId: 7, width: 640, height: 360 },
    },
    {
      code: 'producer-frame-rejected',
      severity: 'warning',
      message:
        'The Electron overlay SDK rejected an offscreen frame that did not match the active or desired raster.',
      context: {
        windowId: 7,
        reason: 'ambiguous',
        width: 640,
        height: 360,
        activeWidth: 640,
        activeHeight: 360,
        desiredWidth: 960,
        desiredHeight: 540,
      },
    },
    {
      code: 'producer-frame-publication-failed',
      severity: 'error',
      message: 'The Electron overlay SDK could not publish an offscreen frame.',
      context: { windowId: 7, stage: 'transport', errorCode: 87 },
    },
    {
      code: 'producer-input-forwarding-failed',
      severity: 'error',
      message:
        'The Electron overlay SDK could not forward intercepted input to an offscreen window.',
      pid: 4321,
      context: { windowId: 0, stage: 'blur', errorCode: 'EPIPE' },
    },
  ];

  for (const diagnosticCase of cases) {
    const parsed = parseOverlayDiagnostic(
      producerDiagnostic(diagnosticCase.code, diagnosticCase.context, {
        ...(diagnosticCase.pid === undefined
          ? {}
          : { pid: diagnosticCase.pid }),
      }),
    );

    assert.deepEqual(parsed, {
      schemaVersion: 1,
      source: 'electron-game-overlay',
      severity: diagnosticCase.severity,
      code: diagnosticCase.code,
      message: diagnosticCase.message,
      ...(diagnosticCase.pid === undefined ? {} : { pid: diagnosticCase.pid }),
      context: diagnosticCase.context,
    });
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.context), true);
  }
});

test('rejects producer diagnostics with invalid PID ownership', () => {
  assert.equal(
    parseOverlayDiagnostic(
      producerDiagnostic('producer-window-registered', undefined),
    ),
    null,
  );
  assert.equal(
    parseOverlayDiagnostic(
      producerDiagnostic(
        'producer-window-registered',
        { windowId: 7 },
        { pid: 4321 },
      ),
    ),
    null,
  );
  assert.equal(
    parseOverlayDiagnostic(
      producerDiagnostic('producer-input-forwarding-failed', {
        windowId: 7,
        stage: 'dispatch',
      }),
    ),
    null,
  );
  assert.equal(
    parseOverlayDiagnostic(
      producerDiagnostic(
        'producer-input-forwarding-failed',
        { windowId: 7, stage: 'dispatch' },
        { pid: 0 },
      ),
    ),
    null,
  );
});

test('rejects producer diagnostic context extensions and invalid enums', () => {
  const invalid = [
    producerDiagnostic('producer-window-registered', {
      windowId: 7,
      name: 'must-not-escape',
    }),
    producerDiagnostic('producer-window-publication-failed', {
      windowId: 7,
      operation: 'show',
    }),
    producerDiagnostic('producer-frame-rejected', {
      windowId: 7,
      reason: 'stale',
      width: 640,
      height: 360,
      activeWidth: 640,
      activeHeight: 360,
      desiredWidth: 960,
      desiredHeight: 540,
    }),
    producerDiagnostic('producer-frame-publication-failed', {
      windowId: 7,
      stage: 'encode',
    }),
    producerDiagnostic(
      'producer-input-forwarding-failed',
      { windowId: 0, stage: 'route' },
      { pid: 4321 },
    ),
  ];

  for (const value of invalid) {
    assert.equal(parseOverlayDiagnostic(value), null);
  }
});

test('rejects non-uint32 producer window IDs and frame dimensions', () => {
  const validRejection = {
    windowId: 7,
    reason: 'unmatched',
    width: 640,
    height: 360,
    activeWidth: 640,
    activeHeight: 360,
    desiredWidth: 960,
    desiredHeight: 540,
  };
  const invalid = [
    producerDiagnostic('producer-window-registered', { windowId: 0 }),
    producerDiagnostic('producer-window-registered', {
      windowId: 0x1_0000_0000,
    }),
    producerDiagnostic('producer-frame-publication-started', {
      windowId: 7,
      width: 0,
      height: 360,
    }),
    producerDiagnostic('producer-frame-publication-started', {
      windowId: 7,
      width: 640,
      height: 1.5,
    }),
    producerDiagnostic('producer-frame-rejected', {
      ...validRejection,
      desiredWidth: 0x1_0000_0000,
    }),
    producerDiagnostic(
      'producer-input-forwarding-failed',
      { windowId: -1, stage: 'focus' },
      { pid: 4321 },
    ),
  ];

  for (const value of invalid) {
    assert.equal(parseOverlayDiagnostic(value), null);
  }
});

test('rejects arbitrary producer error strings and presentation overrides', () => {
  const invalid = [
    producerDiagnostic('producer-window-publication-failed', {
      windowId: 7,
      operation: 'bounds',
      errorCode: 'C:\\secret\\overlay.exe',
    }),
    producerDiagnostic('producer-frame-publication-failed', {
      windowId: 7,
      stage: 'bitmap',
      errorCode: 'token=SUPERSECRET',
    }),
    producerDiagnostic(
      'producer-input-forwarding-failed',
      {
        windowId: 7,
        stage: 'translate',
        errorCode: 'arbitrary producer text',
      },
      { pid: 4321 },
    ),
    producerDiagnostic(
      'producer-window-registered',
      { windowId: 7 },
      { severity: 'warning' },
    ),
    producerDiagnostic(
      'producer-window-registered',
      { windowId: 7 },
      { message: 'producer-owned message' },
    ),
  ];

  for (const value of invalid) {
    assert.equal(parseOverlayDiagnostic(value), null);
  }
});

test('snapshots accessor-backed producer context before validation', () => {
  const flippingContext = (initial) => {
    const reads = new Map();
    const context = {};
    for (const [key, safeValue] of Object.entries(initial)) {
      Object.defineProperty(context, key, {
        enumerable: true,
        get() {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          return count === 1 ? safeValue : { token: 'SUPERSECRET' };
        },
      });
    }
    return { context, reads };
  };
  const cases = [
    {
      code: 'producer-window-registered',
      context: { windowId: 7 },
    },
    {
      code: 'producer-frame-publication-started',
      context: { windowId: 7, width: 640, height: 360 },
    },
    {
      code: 'producer-window-publication-failed',
      context: { windowId: 7, operation: 'bounds', errorCode: 'EIO' },
    },
    {
      code: 'producer-input-forwarding-failed',
      context: { windowId: 7, stage: 'dispatch', errorCode: 'EPIPE' },
      pid: 4321,
    },
  ];

  for (const diagnosticCase of cases) {
    const { context, reads } = flippingContext(diagnosticCase.context);
    const parsed = parseOverlayDiagnostic(
      producerDiagnostic(diagnosticCase.code, context, {
        ...(diagnosticCase.pid === undefined
          ? {}
          : { pid: diagnosticCase.pid }),
      }),
    );

    assert.deepEqual(parsed.context, diagnosticCase.context);
    assert.deepEqual(
      Object.fromEntries(reads),
      Object.fromEntries(
        Object.keys(diagnosticCase.context).map((key) => [key, 1]),
      ),
    );
  }
});
