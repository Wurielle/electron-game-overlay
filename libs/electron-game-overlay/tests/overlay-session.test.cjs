const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createElectronOverlayWindow,
  ElectronOverlayWindow,
} = require('../dist/lib/electron-overlay-window.js');
const {
  authorizeOverlaySessionTarget,
  createOverlaySession,
  OverlaySession,
} = require('../dist/lib/overlay-session.js');
const { createWindowScaleState } = require('../dist/lib/window-scale-state.js');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const display = {
  id: 1,
  scaleFactor: 1,
  width: 1920,
  height: 1080,
};
const bounds = { x: 0, y: 0, width: 640, height: 360 };

const targetSurface = (overrides = {}) => ({
  pid: 4321,
  surfaceId: '0x1234',
  hwnd: '0xabcd',
  revision: 1,
  graphicsApi: 'd3d11',
  renderSize: { width: 1920, height: 1080 },
  clientBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  clientScreenBounds: { x: 120, y: 60, width: 1920, height: 1080 },
  windowScreenBounds: { x: 112, y: 29, width: 1936, height: 1119 },
  dpi: { x: 144, y: 144 },
  monitor: {
    id: '0x55',
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    workArea: { x: 0, y: 0, width: 2560, height: 1400 },
  },
  focused: true,
  minimized: false,
  visible: true,
  fullscreen: false,
  ...overrides,
});

function createHarness() {
  const calls = [];
  const decoyCalls = [];
  const nativeWindowCalls = [];
  const timeline = [];
  const sentEvents = [];
  const translatedEvent = {
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    x: 120,
    y: 80,
    modifiers: [],
  };
  const nativeOverlay = {
    translateInputEvent: () => ({ ...translatedEvent }),
  };
  const session = createOverlaySession(nativeOverlay);
  const webContents = {
    focus: () => calls.push('webContents.focus'),
    isDestroyed: () => false,
    isFocused: () => calls.push('webContents.isFocused'),
    sendInputEvent: (event) => {
      calls.push('webContents.sendInputEvent');
      timeline.push('webContents.sendInputEvent');
      sentEvents.push(event);
    },
  };
  const overlayWindow = {
    nativeId: 7,
    visible: true,
    browserWindow: {
      focus: () => nativeWindowCalls.push('BrowserWindow.focus'),
      focusOnWebView: () => {
        nativeWindowCalls.push('BrowserWindow.focusOnWebView');
        timeline.push('BrowserWindow.focusOnWebView');
      },
      isDestroyed: () => false,
      webContents,
    },
  };

  session.windowsByNativeId.set(overlayWindow.nativeId, overlayWindow);
  session.windowsByNativeId.set(8, {
    nativeId: 8,
    visible: true,
    browserWindow: {
      isDestroyed: () => false,
      webContents: {
        focus: () => decoyCalls.push('webContents.focus'),
        isDestroyed: () => false,
        isFocused: () => true,
        sendInputEvent: () => decoyCalls.push('webContents.sendInputEvent'),
      },
    },
  });
  session.windowScaleStates.set(
    overlayWindow.nativeId,
    createWindowScaleState(display, bounds),
  );

  return {
    calls,
    decoyCalls,
    nativeWindowCalls,
    sentEvents,
    session,
    timeline,
    translatedEvent,
  };
}

function forwardInput(session) {
  session.handleEvent('game.input', {
    pid: 4321,
    windowId: 7,
    scaleFactorMicros: 1_000_000,
  });
}

function createOverlayWindowFocusHarness(focusOnReady) {
  const windowHandlers = new Map();
  const webContentsHandlers = new Map();
  const focusCalls = [];
  const removedWindows = [];
  let closeCalls = 0;
  let destroyCalls = 0;
  let browserWindowDestroyed = false;
  let invalidateCalls = 0;
  const browserWindow = {
    id: 41,
    webContents: {
      on(event, handler) {
        webContentsHandlers.set(event, handler);
      },
      removeListener(event, handler) {
        if (webContentsHandlers.get(event) === handler) {
          webContentsHandlers.delete(event);
        }
      },
      isDestroyed() {
        return browserWindowDestroyed;
      },
      isOffscreen() {
        return true;
      },
      invalidate() {
        invalidateCalls += 1;
      },
    },
    on(event, handler) {
      windowHandlers.set(event, handler);
    },
    removeListener(event, handler) {
      if (windowHandlers.get(event) === handler) {
        windowHandlers.delete(event);
      }
    },
    focusOnWebView() {
      focusCalls.push('focus');
    },
    isDestroyed() {
      return browserWindowDestroyed;
    },
    close() {
      closeCalls += 1;
    },
    destroy() {
      destroyCalls += 1;
      browserWindowDestroyed = true;
    },
  };
  const bridge = {
    registerWindow() {},
    unregisterWindow() {},
    removeWindow(window) {
      removedWindows.push(window);
    },
    syncWindowGeometry() {},
    followTarget() {},
    stopFollowingTarget() {},
    sendFrame() {},
  };
  const window = createElectronOverlayWindow(bridge, {
    existingWindow: browserWindow,
    ...(focusOnReady === undefined ? {} : { focusOnReady }),
  });
  return {
    browserWindow,
    get closeCalls() {
      return closeCalls;
    },
    get destroyCalls() {
      return destroyCalls;
    },
    get invalidateCalls() {
      return invalidateCalls;
    },
    focusCalls,
    bridge,
    removedWindows,
    window,
    windowHandlers,
    webContentsHandlers,
  };
}

function createProducerPublicationHarness(overlayOverrides = {}) {
  const calls = [];
  let contentBounds = { ...bounds };
  const overlay = {
    addWindow: (windowId, details) =>
      calls.push({ type: 'add', windowId, details }),
    closeWindow: (windowId) => calls.push({ type: 'close', windowId }),
    sendWindowBounds: (windowId, details) =>
      calls.push({ type: 'bounds', windowId, details }),
    sendFrameBuffer: (windowId, bitmap, width, height) => {
      calls.push({ type: 'frame', windowId, bitmap, width, height });
      return true;
    },
    ...overlayOverrides,
  };
  const session = createOverlaySession(overlay);
  session.started = true;
  session.electronScreen = {
    getDisplayMatching: () => ({
      id: display.id,
      scaleFactor: display.scaleFactor,
      bounds: { width: display.width, height: display.height },
    }),
    screenToDipRect: (_window, rect) => ({ ...rect }),
    on() {},
    removeListener() {},
  };
  const window = {
    id: 'producer-window',
    name: 'Producer window',
    nativeId: 7,
    transparent: true,
    dragBorder: 8,
    captionHeight: 32,
    visible: true,
    browserWindow: {
      id: 7,
      isDestroyed: () => false,
      getContentBounds: () => ({ ...contentBounds }),
      webContents: {
        invalidate() {},
        isDestroyed: () => false,
      },
    },
  };
  session.windowsById.set(window.id, window);
  session.windowsByNativeId.set(window.nativeId, window);

  return {
    calls,
    overlay,
    session,
    setContentBounds: (next) => {
      contentBounds = { ...next };
    },
    window,
  };
}

test('does not focus a ready overlay window unless explicitly requested', () => {
  const defaultHarness = createOverlayWindowFocusHarness();
  defaultHarness.windowHandlers.get('ready-to-show')();
  assert.deepEqual(defaultHarness.focusCalls, []);

  const focusedHarness = createOverlayWindowFocusHarness(true);
  focusedHarness.windowHandlers.get('ready-to-show')();
  assert.deepEqual(focusedHarness.focusCalls, ['focus']);
});

test('closing an attached overlay wrapper preserves its caller-owned BrowserWindow', () => {
  const harness = createOverlayWindowFocusHarness();

  harness.window.destroy();

  assert.equal(harness.closeCalls, 0);
  assert.equal(harness.destroyCalls, 0);
  assert.equal(harness.browserWindow.isDestroyed(), false);
});

test('attaching a BrowserWindow requires offscreen rendering at construction', () => {
  let startCalls = 0;
  const session = createOverlaySession({
    start() {
      startCalls += 1;
    },
  });
  const harness = createOverlayWindowFocusHarness();
  harness.browserWindow.webContents.isOffscreen = () => false;

  assert.throws(
    () => session.windows.attach(harness.browserWindow, { id: 'onscreen' }),
    /webPreferences\.offscreen: true/,
  );
  assert.equal(startCalls, 0);
  assert.equal(session.started, false);
  assert.equal(session.windows.get('onscreen'), null);
  assert.equal(harness.webContentsHandlers.size, 1);
  assert.equal(harness.windowHandlers.size, 4);
});

test('show requests a fresh frame and destroy detaches caller-owned window listeners', () => {
  const harness = createOverlayWindowFocusHarness();

  harness.window.show();
  assert.equal(harness.invalidateCalls, 1);
  assert.equal(harness.webContentsHandlers.size, 1);
  assert.equal(harness.windowHandlers.size, 4);

  harness.window.destroy();
  assert.equal(harness.webContentsHandlers.size, 0);
  assert.equal(harness.windowHandlers.size, 0);

  const replacement = createElectronOverlayWindow(harness.bridge, {
    existingWindow: harness.browserWindow,
    id: 'replacement',
  });
  assert.equal(harness.webContentsHandlers.size, 1);
  assert.equal(harness.windowHandlers.size, 4);
  harness.windowHandlers.get('closed')();
  assert.deepEqual(harness.removedWindows, [harness.window, replacement]);
});

test('duplicate logical and native window identities are rejected without losing the first wrapper', () => {
  const session = createOverlaySession({});
  session.started = true;
  const firstHarness = createOverlayWindowFocusHarness();
  const secondHarness = createOverlayWindowFocusHarness();
  secondHarness.browserWindow.id = 42;

  const first = session.windows.attach(firstHarness.browserWindow, {
    id: 'shared-id',
  });
  assert.throws(
    () =>
      session.windows.attach(secondHarness.browserWindow, { id: 'shared-id' }),
    /already exists/,
  );
  assert.throws(
    () => session.windows.attach(firstHarness.browserWindow, { id: 'other' }),
    /already attached/,
  );
  assert.equal(session.windows.get('shared-id'), first);
  assert.equal(firstHarness.closeCalls, 0);
  assert.equal(secondHarness.closeCalls, 0);

  const replacement = { id: 'replacement', nativeId: first.nativeId };
  session.windowsById.set(replacement.id, replacement);
  session.windowsByNativeId.set(replacement.nativeId, replacement);
  session.removeWindow(first);
  assert.equal(
    session.windowsByNativeId.get(replacement.nativeId),
    replacement,
  );
  assert.equal(session.windowsById.get(replacement.id), replacement);

  const derivedIdSession = createOverlaySession({});
  derivedIdSession.started = true;
  const derivedFirstHarness = createOverlayWindowFocusHarness();
  const derivedSecondHarness = createOverlayWindowFocusHarness();
  derivedSecondHarness.browserWindow.id = 42;
  const derivedFirst = derivedIdSession.windows.attach(
    derivedFirstHarness.browserWindow,
    { id: '42' },
  );
  assert.throws(
    () => derivedIdSession.windows.attach(derivedSecondHarness.browserWindow),
    /conflicts with an existing window/,
  );
  assert.equal(derivedIdSession.windows.get('42'), derivedFirst);
});

test('throwing lifecycle observers and a cancelable close cannot interrupt owned window or session teardown', () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const windowHarness = createOverlayWindowFocusHarness();
    windowHarness.window.ownsBrowserWindow = true;
    windowHarness.window.onClose(() => {
      throw new Error('window observer failed');
    });
    assert.doesNotThrow(() => windowHarness.window.destroy());
    assert.equal(windowHarness.closeCalls, 0);
    assert.equal(windowHarness.destroyCalls, 1);
    assert.equal(windowHarness.browserWindow.isDestroyed(), true);

    const calls = [];
    const session = createOverlaySession({
      stop() {
        calls.push('stop');
      },
    });
    session.started = true;
    session.windowsById.set('window', {
      destroy() {
        calls.push('destroy');
      },
    });
    session.targetAuthorizationReleases.add(() => calls.push('release'));
    session.onQuit(() => {
      throw new Error('quit observer failed');
    });
    session.onClose(() => {
      throw new Error('close observer failed');
    });

    assert.doesNotThrow(() => session.close());
    assert.equal(session.closed, true);
    assert.deepEqual(calls, ['destroy', 'release', 'stop']);
  } finally {
    console.error = originalError;
  }
});

test('window teardown completes after native unregister fails', () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const ownedHarness = createOverlayWindowFocusHarness();
    ownedHarness.window.ownsBrowserWindow = true;
    ownedHarness.window.show();
    ownedHarness.bridge.unregisterWindow = () => {
      throw new Error('native unregister failed');
    };
    let ownedCloseCalls = 0;
    ownedHarness.window.onClose(() => {
      ownedCloseCalls += 1;
    });

    assert.throws(
      () => ownedHarness.window.destroy(),
      /native unregister failed/,
    );
    assert.equal(ownedHarness.window.visible, false);
    assert.equal(ownedHarness.destroyCalls, 1);
    assert.equal(ownedCloseCalls, 1);
    assert.deepEqual(ownedHarness.removedWindows, [ownedHarness.window]);
    assert.equal(ownedHarness.webContentsHandlers.size, 0);
    assert.equal(ownedHarness.windowHandlers.size, 0);

    const attachedHarness = createOverlayWindowFocusHarness();
    attachedHarness.window.show();
    attachedHarness.bridge.unregisterWindow = () => {
      throw new Error('native unregister failed');
    };
    const closed = attachedHarness.windowHandlers.get('closed');

    assert.doesNotThrow(() => closed());
    assert.equal(attachedHarness.window.visible, false);
    assert.equal(attachedHarness.destroyCalls, 0);
    assert.deepEqual(attachedHarness.removedWindows, [attachedHarness.window]);
    assert.equal(attachedHarness.webContentsHandlers.size, 0);
    assert.equal(attachedHarness.windowHandlers.size, 0);
  } finally {
    console.error = originalError;
  }
});

test('session teardown rejects reentrant windows and contains cleanup failures', () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    let stopCalls = 0;
    const session = createOverlaySession({
      stop() {
        stopCalls += 1;
        throw new Error('backend stop failed');
      },
    });
    session.started = true;

    const ownedHarness = createOverlayWindowFocusHarness();
    ownedHarness.window.ownsBrowserWindow = true;
    ownedHarness.window.show();
    ownedHarness.bridge.unregisterWindow = () => {
      throw new Error('native unregister failed');
    };
    const lateHarness = createOverlayWindowFocusHarness();
    let lateWindowError;
    ownedHarness.window.onClose(() => {
      try {
        session.windows.attach(lateHarness.browserWindow, { id: 'late' });
      } catch (error) {
        lateWindowError = error;
      }
    });
    session.windowsById.set(ownedHarness.window.id, ownedHarness.window);
    session.targetAuthorizationReleases.add(() => {
      throw new Error('authorization release failed');
    });

    assert.doesNotThrow(() => session.close());
    assert.equal(session.closed, true);
    assert.equal(session.started, false);
    assert.equal(stopCalls, 1);
    assert.equal(ownedHarness.destroyCalls, 1);
    assert.match(lateWindowError.message, /session is closing/);
    assert.equal(session.windows.get('late'), null);
    assert.equal(session.targetAuthorizationReleases.size, 0);
  } finally {
    console.error = originalError;
  }
});

test('focuses the target page immediately before input dispatch without native focus', () => {
  const harness = createHarness();

  forwardInput(harness.session);

  assert.deepEqual(harness.calls, ['webContents.sendInputEvent']);
  assert.deepEqual(harness.nativeWindowCalls, ['BrowserWindow.focusOnWebView']);
  assert.deepEqual(harness.decoyCalls, []);
  assert.deepEqual(harness.sentEvents, [harness.translatedEvent]);
  assert.deepEqual(harness.timeline, [
    'BrowserWindow.focusOnWebView',
    'webContents.sendInputEvent',
  ]);
});

test('reasserts OSR page focus for every forwarded input event', (t) => {
  const harness = createHarness();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  forwardInput(harness.session);
  forwardInput(harness.session);

  assert.deepEqual(harness.calls, [
    'webContents.sendInputEvent',
    'webContents.sendInputEvent',
  ]);
  assert.deepEqual(harness.nativeWindowCalls, [
    'BrowserWindow.focusOnWebView',
    'BrowserWindow.focusOnWebView',
  ]);
  assert.deepEqual(harness.timeline, [
    'BrowserWindow.focusOnWebView',
    'webContents.sendInputEvent',
    'BrowserWindow.focusOnWebView',
    'webContents.sendInputEvent',
  ]);
  assert.deepEqual(warnings, []);
});

test('contains input dispatch failures and keeps forwarding later events', async (t) => {
  const harness = createHarness();
  const diagnostics = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });
  harness.session.on('diagnostic', (diagnostic) =>
    diagnostics.push(diagnostic),
  );

  const webContents =
    harness.session.windowsByNativeId.get(7).browserWindow.webContents;
  const failure = Object.assign(new Error('dispatch failed'), {
    code: 'EPIPE',
  });
  webContents.sendInputEvent = () => {
    throw failure;
  };

  assert.doesNotThrow(() => forwardInput(harness.session));
  await Promise.resolve();
  assert.deepEqual(diagnostics, [
    {
      schemaVersion: 1,
      source: 'electron-game-overlay',
      severity: 'error',
      code: 'producer-input-forwarding-failed',
      message:
        'The Electron overlay SDK could not forward intercepted input to an offscreen window.',
      pid: 4321,
      context: {
        windowId: 7,
        stage: 'dispatch',
        errorCode: 'EPIPE',
      },
    },
  ]);
  assert.equal(warnings.length, 1);

  webContents.sendInputEvent = (event) => harness.sentEvents.push(event);
  assert.doesNotThrow(() => forwardInput(harness.session));
  assert.equal(harness.sentEvents.length, 1);
});

test('retains immutable target surfaces and typed FPS until confirmed process exit', () => {
  const session = createOverlaySession({});
  const changed = [];
  const removed = [];
  const fps = [];
  session.on('targetSurfaceChanged', (payload) => changed.push(payload));
  session.on('targetSurfaceRemoved', (payload) => removed.push(payload));
  session.on('fps', (payload) => fps.push(payload));

  session.handleEvent('game.target.surface', targetSurface());
  const retained = session.targets.get(4321, '0x1234');
  assert.ok(retained);
  assert.equal(retained.dpi.scaleFactor, 1.5);
  assert.ok(Object.isFrozen(retained));
  assert.ok(Object.isFrozen(retained.renderSize));
  assert.ok(Object.isFrozen(retained.monitor));
  assert.ok(Object.isFrozen(retained.monitor.bounds));
  const listed = session.targets.list();
  assert.ok(Object.isFrozen(listed));
  assert.deepEqual(listed, [retained]);
  assert.deepEqual(changed, [retained]);

  session.handleEvent(
    'game.target.surface',
    targetSurface({ revision: 0, renderSize: { width: 800, height: 600 } }),
  );
  assert.equal(session.targets.get(4321, '0x1234'), retained);
  assert.equal(changed.length, 1, 'stale revisions must not replace state');

  session.handleEvent('game.graphics.fps', { pid: 4321, fps: 59.875 });
  assert.deepEqual(fps, [{ pid: 4321, fps: 59.875 }]);
  assert.ok(Object.isFrozen(fps[0]));

  session.handleEvent('game.process.transport-lost', {
    pid: 4321,
    path: 'C:\\Games\\example.exe',
  });
  assert.equal(
    session.targets.get(4321, '0x1234'),
    retained,
    'transient socket loss must retain the last authoritative surface',
  );

  session.handleEvent('game.process.disconnected', {
    pid: 4321,
    path: 'C:\\Games\\example.exe',
  });
  assert.equal(session.targets.get(4321, '0x1234'), null);
  assert.deepEqual(removed, [{ pid: 4321, surfaceId: '0x1234', revision: 1 }]);
  assert.ok(Object.isFrozen(removed[0]));
});

test('validates raw lifecycle packets and emits immutable typed events', () => {
  const session = createOverlaySession({});
  const observed = [];
  for (const event of [
    'targetConnected',
    'targetTransportLost',
    'targetDisconnected',
    'inputInterceptionChanged',
    'windowFocused',
  ]) {
    session.on(event, (payload) => observed.push({ event, payload }));
  }

  session.handleEvent('game.process', {
    pid: 4321,
    path: 'C:\\Games\\example.exe',
  });
  session.handleEvent('game.process.transport-lost', { pid: 4321 });
  session.handleEvent('game.input.intercept', {
    pid: 4321,
    intercepting: true,
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    session.handleEvent('game.window.focused', {
      pid: 4321,
      focusWindowId: 0,
    });
  } finally {
    console.warn = originalWarn;
  }
  session.handleEvent('game.process.disconnected', { pid: 4321 });

  assert.deepEqual(observed, [
    {
      event: 'targetConnected',
      payload: { pid: 4321, executablePath: 'C:\\Games\\example.exe' },
    },
    {
      event: 'targetTransportLost',
      payload: { pid: 4321, executablePath: 'C:\\Games\\example.exe' },
    },
    {
      event: 'inputInterceptionChanged',
      payload: { pid: 4321, intercepting: true },
    },
    {
      event: 'windowFocused',
      payload: { pid: 4321, windowId: 0 },
    },
    {
      event: 'targetDisconnected',
      payload: { pid: 4321, executablePath: 'C:\\Games\\example.exe' },
    },
  ]);
  assert.equal(
    observed.every(({ payload }) => Object.isFrozen(payload)),
    true,
  );

  session.handleEvent('game.process', { pid: 0, path: 'bad.exe' });
  session.handleEvent('game.process.transport-lost', { pid: 4321 });
  session.handleEvent('game.input.intercept', {
    pid: 4321,
    intercepting: 'yes',
  });
  session.handleEvent('game.window.focused', {
    pid: 4321,
    focusWindowId: -1,
  });
  session.handleEvent('game.process.disconnected', { pid: 4321 });
  assert.equal(observed.length, 5);
});

test('consumer event failures cannot corrupt telemetry or interrupt internal updates', (t) => {
  const session = createOverlaySession({});
  const warnings = [];
  const typedRevisions = [];
  const originalWarn = console.warn;
  let followerUpdates = 0;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  session.reapplyTargetFollowers = () => {
    followerUpdates += 1;
  };
  session.on('targetSurfaceChanged', () => {
    throw new Error('typed listener failure');
  });
  session.on('targetSurfaceChanged', ({ revision }) => {
    typedRevisions.push(revision);
  });
  session.on('targetSurfaceChanged', () => {
    throw new Error('second typed listener failure');
  });

  assert.doesNotThrow(() => {
    session.handleEvent('game.target.surface', targetSurface());
  });
  assert.equal(followerUpdates, 1);
  assert.equal(session.targets.get(4321, '0x1234').revision, 1);
  assert.deepEqual(typedRevisions, [1]);
  assert.equal(warnings.length, 2);
});

test('emits canonical immutable diagnostics and isolates consumer failures', (t) => {
  const session = createOverlaySession({});
  const warnings = [];
  const diagnostics = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  session.on('diagnostic', () => {
    throw new Error('diagnostic listener failure');
  });
  session.on('diagnostic', (diagnostic) => diagnostics.push(diagnostic));

  const raw = {
    schemaVersion: 1,
    source: 'electron-overlay-transport',
    severity: 'warning',
    code: 'target-packet-rejected',
    message:
      'The overlay transport rejected a packet from an authenticated target.',
    pid: 4321,
    context: {
      reason: 'invalid-graphics-fps',
      eventType: 'game.graphics.fps',
    },
  };
  session.handleDiagnostic(raw);
  raw.context.reason = 'mutated';

  assert.equal(diagnostics.length, 1);
  assert.ok(Object.isFrozen(diagnostics[0]));
  assert.ok(Object.isFrozen(diagnostics[0].context));
  assert.deepEqual(diagnostics[0], {
    schemaVersion: 1,
    source: 'electron-overlay-transport',
    severity: 'warning',
    code: 'target-packet-rejected',
    message:
      'The overlay transport rejected a packet from an authenticated target.',
    pid: 4321,
    context: {
      reason: 'invalid-graphics-fps',
      eventType: 'game.graphics.fps',
    },
  });
  assert.equal(warnings.length, 1);

  session.handleDiagnostic({
    ...raw,
    context: { nested: { token: 'must-not-escape' } },
  });
  session.handleDiagnostic({
    ...raw,
    pid: 0,
  });
  session.handleDiagnostic({
    ...raw,
    message: 'token=SUPERSECRET C:\\secret\\game.exe',
    context: {
      token: 'SUPERSECRET',
      stack: 'C:\\secret\\game.exe',
    },
  });
  assert.doesNotThrow(() => {
    session.handleDiagnostic(
      Object.defineProperty({}, 'schemaVersion', {
        get() {
          throw new Error('hostile diagnostic getter');
        },
      }),
    );
  });
  assert.equal(diagnostics.length, 1, 'invalid diagnostics must be ignored');
});

test('binds diagnostic observation before backend startup without re-entry', () => {
  const calls = [];
  let publishDiagnostic;
  let starts = 0;
  const overlay = {
    setEventCallback: () => calls.push('event-callback'),
    setDiagnosticCallback(callback) {
      calls.push('diagnostic-callback');
      publishDiagnostic = callback;
    },
    start() {
      starts += 1;
      if (starts > 1) {
        throw new Error('backend startup re-entered');
      }
      calls.push('start');
      publishDiagnostic({
        schemaVersion: 1,
        source: 'electron-overlay-transport',
        severity: 'info',
        code: 'transport-ready',
        message: 'The overlay loopback transport is ready.',
        context: { port: 4242 },
      });
    },
    setInputIntercept(intercept) {
      calls.push(`intercept-${intercept}`);
    },
    stop() {},
  };
  const session = createOverlaySession(overlay);
  session.electronScreen = {
    on() {},
    removeListener() {},
  };
  const diagnostics = [];
  session.on('diagnostic', (diagnostic) => {
    diagnostics.push(diagnostic);
    session.input.intercept();
  });

  session.start();

  assert.deepEqual(calls, [
    'event-callback',
    'diagnostic-callback',
    'start',
    'intercept-true',
  ]);
  assert.equal(starts, 1);
  assert.equal(diagnostics[0].code, 'transport-ready');
});

test('rolls back session startup state when the backend throws', () => {
  let starts = 0;
  let stops = 0;
  const overlay = {
    setEventCallback() {},
    start() {
      starts += 1;
      if (starts === 1) {
        throw new Error('startup failed');
      }
    },
    stop() {
      stops += 1;
    },
  };
  const session = createOverlaySession(overlay);
  session.electronScreen = {
    on() {},
    removeListener() {},
  };

  assert.throws(() => session.start(), /startup failed/);
  assert.equal(stops, 1);
  assert.doesNotThrow(() => session.start());
  assert.equal(starts, 2);
  session.close();
  assert.equal(stops, 2);
});

test('does not start a backend after callback registration closes the session', () => {
  const calls = [];
  const overlay = {
    setEventCallback() {
      calls.push('event-callback');
    },
    setDiagnosticCallback(callback) {
      calls.push('diagnostic-callback');
      callback({
        schemaVersion: 1,
        source: 'electron-overlay-transport',
        code: 'transport-ready',
        context: { port: 4242 },
      });
    },
    start() {
      calls.push('start');
    },
    stop() {
      calls.push('stop');
    },
  };
  const session = createOverlaySession(overlay);
  session.on('diagnostic', () => session.close());

  session.start();

  assert.deepEqual(calls, ['event-callback', 'diagnostic-callback', 'stop']);
  assert.throws(() => session.start(), /session is closed/);
});

test('stops once when a backend startup event closes the session synchronously', () => {
  const calls = [];
  let publishDiagnostic;
  const overlay = {
    setEventCallback() {},
    setDiagnosticCallback(callback) {
      publishDiagnostic = callback;
    },
    start() {
      calls.push('start');
      publishDiagnostic({
        schemaVersion: 1,
        source: 'electron-overlay-transport',
        code: 'transport-ready',
        context: { port: 4242 },
      });
    },
    stop() {
      calls.push('stop');
    },
  };
  const session = createOverlaySession(overlay);
  session.on('diagnostic', () => session.close());

  session.start();

  assert.equal(session.closed, true);
  assert.deepEqual(calls, ['start', 'stop']);
});

test('removes partial screen bindings and stops after screen setup fails', () => {
  const calls = [];
  const overlay = {
    setEventCallback() {},
    start() {
      calls.push('start');
    },
    stop() {
      calls.push('stop');
    },
  };
  const session = createOverlaySession(overlay);
  session.electronScreen = {
    on(event) {
      calls.push(`on:${event}`);
      if (event === 'display-metrics-changed') {
        throw new Error('screen binding failed');
      }
    },
    removeListener(event) {
      calls.push(`off:${event}`);
    },
  };

  assert.throws(() => session.start(), /screen binding failed/);
  assert.deepEqual(calls, [
    'start',
    'on:display-added',
    'on:display-removed',
    'on:display-metrics-changed',
    'off:display-removed',
    'off:display-added',
    'stop',
  ]);
});

test('surface removal honors revisions and causes the default selector to fall back', () => {
  const session = createOverlaySession({});
  session.handleEvent('game.target.surface', targetSurface());
  session.handleEvent(
    'game.target.surface',
    targetSurface({ pid: 9876, surfaceId: '0x99', revision: 4 }),
  );
  assert.deepEqual(
    session.targets.list().map(({ pid, surfaceId }) => [pid, surfaceId]),
    [
      [4321, '0x1234'],
      [9876, '0x99'],
    ],
  );

  session.handleEvent('game.target.surface.removed', {
    pid: 9876,
    surfaceId: '0x99',
    revision: 3,
  });
  assert.ok(session.targets.get(9876, '0x99'));

  session.handleEvent('game.target.surface.removed', {
    pid: 9876,
    surfaceId: '0x99',
    revision: 4,
  });
  assert.equal(session.targets.get(9876, '0x99'), null);
  assert.equal(
    session.targets.list().at(-1),
    session.targets.get(4321, '0x1234'),
  );
});

test('exact-target authorization delegates after readiness and has a legacy no-op fallback', async () => {
  const calls = [];
  const overlay = {
    start: () => calls.push('start'),
    stop() {},
    setEventCallback() {},
    whenReady: async () => calls.push('ready'),
    authorizeTarget: async (pid, discoveryPath, expectedExecutablePath) => {
      calls.push(['authorize', pid, discoveryPath, expectedExecutablePath]);
      return () => calls.push('release');
    },
  };
  const session = createOverlaySession(overlay);
  session.electronScreen = {
    on() {},
    removeListener() {},
  };

  const release = await authorizeOverlaySessionTarget(
    session,
    4321,
    'C:\\overlay-runs\\target\\electron-overlay-transport-v1.json',
    'C:\\games\\exact-target.exe',
  );
  assert.deepEqual(calls, [
    'start',
    'ready',
    [
      'authorize',
      4321,
      'C:\\overlay-runs\\target\\electron-overlay-transport-v1.json',
      'C:\\games\\exact-target.exe',
    ],
  ]);
  release();
  assert.equal(calls.at(-1), 'release');

  const legacySession = createOverlaySession({
    start() {},
    stop() {},
    setEventCallback() {},
    whenReady: () => Promise.resolve(),
  });
  legacySession.electronScreen = session.electronScreen;
  const legacyRelease = await authorizeOverlaySessionTarget(
    legacySession,
    4322,
    'C:\\overlay-runs\\legacy\\electron-overlay-transport-v1.json',
  );
  assert.equal(typeof legacyRelease, 'function');
  legacyRelease();
});

test('session close revokes active and late target authorizations', async () => {
  const activeCalls = [];
  const activeSession = createOverlaySession({
    start() {},
    stop() {},
    setEventCallback() {},
    whenReady: () => Promise.resolve(),
    authorizeTarget: async () => () => activeCalls.push('release'),
  });
  activeSession.electronScreen = {
    on() {},
    removeListener() {},
  };
  const activeRelease = await authorizeOverlaySessionTarget(
    activeSession,
    5001,
    'C:\\overlay-runs\\active\\electron-overlay-transport-v1.json',
  );
  activeSession.close();
  activeRelease();
  assert.deepEqual(activeCalls, ['release']);

  const readiness = deferred();
  let readinessAuthorizationCalled = false;
  const readinessSession = createOverlaySession({
    start() {},
    stop() {},
    setEventCallback() {},
    whenReady: () => readiness.promise,
    authorizeTarget: async () => {
      readinessAuthorizationCalled = true;
      return () => undefined;
    },
  });
  readinessSession.electronScreen = activeSession.electronScreen;
  const readinessAuthorization = authorizeOverlaySessionTarget(
    readinessSession,
    5002,
    'C:\\overlay-runs\\readiness\\electron-overlay-transport-v1.json',
  );
  readinessSession.close();
  readiness.resolve();
  await assert.rejects(readinessAuthorization, /session is closed/);
  assert.equal(readinessAuthorizationCalled, false);

  const backend = deferred();
  let backendAuthorizationCalled = false;
  let lateReleaseCount = 0;
  const backendSession = createOverlaySession({
    start() {},
    stop() {},
    setEventCallback() {},
    whenReady: () => Promise.resolve(),
    authorizeTarget: async () => {
      backendAuthorizationCalled = true;
      return backend.promise;
    },
  });
  backendSession.electronScreen = activeSession.electronScreen;
  const backendAuthorization = authorizeOverlaySessionTarget(
    backendSession,
    5003,
    'C:\\overlay-runs\\backend\\electron-overlay-transport-v1.json',
  );
  while (!backendAuthorizationCalled) {
    await Promise.resolve();
  }
  backendSession.close();
  backend.resolve(() => {
    ++lateReleaseCount;
  });
  await assert.rejects(backendAuthorization, /session is closed/);
  assert.equal(lateReleaseCount, 1);
});

test('target following moves the backing window in DIP but commits local physical bounds only with matching pixels', () => {
  const added = [];
  const boundsUpdates = [];
  const frames = [];
  const screenConversions = [];
  const overlay = {
    start() {},
    stop() {},
    setEventCallback() {},
    whenReady: () => Promise.resolve(),
    addWindow: (id, details) => added.push({ id, details }),
    closeWindow() {},
    sendWindowBounds: (id, details) => boundsUpdates.push({ id, details }),
    sendFrameBuffer: (id, bitmap, width, height) =>
      frames.push({ id, bitmap, width, height }),
  };
  const listeners = new Map();
  const fakeScreen = {
    on: (event, handler) => listeners.set(event, handler),
    removeListener: (event) => listeners.delete(event),
    screenToDipRect: (window, rect) => {
      screenConversions.push({ window, rect: { ...rect } });
      return { x: 80, y: 40, width: 1280, height: 720 };
    },
    getDisplayMatching: (rect) =>
      rect.x === 80
        ? {
            id: 2,
            scaleFactor: 1.5,
            bounds: { x: 0, y: 0, width: 1707, height: 960 },
          }
        : {
            id: 1,
            scaleFactor: 1,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          },
  };
  let contentBounds = { x: 10, y: 20, width: 640, height: 360 };
  const setContentBoundsCalls = [];
  const browserWindow = {
    id: 7,
    isDestroyed: () => false,
    getContentBounds: () => ({ ...contentBounds }),
    setContentBounds: (next) => {
      contentBounds = { ...next };
      setContentBoundsCalls.push({ ...next });
    },
    webContents: {
      invalidate() {},
    },
  };
  const window = {
    id: 'followed',
    name: 'followed',
    nativeId: 7,
    browserWindow,
    dragBorder: 12,
    captionHeight: 48,
    transparent: true,
    visible: true,
  };
  const session = createOverlaySession(overlay);
  session.electronScreen = fakeScreen;
  session.windowsById.set(window.id, window);
  session.windowsByNativeId.set(window.nativeId, window);
  session.registerWindow(window);
  assert.throws(() => session.followWindowTarget(window, { pid: 0 }), /pid/);
  assert.equal(session.targetFollowRestoreBounds.has(window.nativeId), false);
  session.followWindowTarget(window, { area: 'render' });

  session.handleEvent('game.target.surface', targetSurface());
  assert.deepEqual(screenConversions[0].rect, {
    x: 120,
    y: 60,
    width: 1920,
    height: 1080,
  });
  assert.equal(
    screenConversions[0].window,
    null,
    'conversion selects the display nearest the target rect, not the old backing window',
  );
  assert.deepEqual(setContentBoundsCalls, [
    { x: 80, y: 40, width: 1280, height: 720 },
  ]);
  assert.deepEqual(boundsUpdates.at(-1).details.rect, {
    x: 0,
    y: 0,
    width: 640,
    height: 360,
  });
  assert.deepEqual(boundsUpdates.at(-1).details.caption, {
    left: 0,
    right: 0,
    top: 0,
    height: 0,
  });
  assert.equal(
    boundsUpdates.at(-1).details.rasterChanged,
    undefined,
    'old pixels remain labeled with the active raster during resize',
  );

  session.sendFrame(window, {
    getSize: () => ({ width: 1920, height: 1080 }),
    toBitmap: () => Buffer.from([1, 2, 3, 4]),
  });
  assert.deepEqual(boundsUpdates.at(-1), {
    id: 7,
    details: {
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      caption: { left: 0, right: 0, top: 0, height: 0 },
      scaleFactorMicros: 1_500_000,
      rasterChanged: true,
    },
  });
  assert.deepEqual(frames, [
    {
      id: 7,
      bitmap: Buffer.from([1, 2, 3, 4]),
      width: 1920,
      height: 1080,
    },
  ]);
  assert.equal(added.length, 1);

  contentBounds = { x: 500, y: 500, width: 300, height: 200 };
  session.windowBridge.syncWindowGeometry(window);
  assert.deepEqual(
    setContentBoundsCalls.at(-1),
    { x: 80, y: 40, width: 1280, height: 720 },
    'a renderer/native resize is immediately corrected while following',
  );

  session.stopWindowFollowingTarget(window);
  assert.deepEqual(
    setContentBoundsCalls.at(-1),
    { x: 10, y: 20, width: 640, height: 360 },
    'stopping follow restores the ordinary pre-follow content bounds',
  );
  assert.equal(session.targetFollowOptions.has(window.nativeId), false);

  session.sendFrame(window, {
    getSize: () => ({ width: 640, height: 360 }),
    toBitmap: () => Buffer.from([5, 6, 7, 8]),
  });
  assert.deepEqual(boundsUpdates.at(-1).details.rect, {
    x: 10,
    y: 20,
    width: 640,
    height: 360,
  });
  assert.deepEqual(boundsUpdates.at(-1).details.caption, {
    left: 12,
    right: 12,
    top: 12,
    height: 48,
  });
});

test('publishes asynchronous producer milestones after window and first-frame success', async () => {
  const harness = createProducerPublicationHarness();
  const diagnostics = [];
  harness.session.on('diagnostic', (diagnostic) =>
    diagnostics.push(diagnostic),
  );

  harness.session.registerWindow(harness.window);
  harness.session.sendFrame(harness.window, {
    getSize: () => ({ width: 640, height: 360 }),
    toBitmap: () => Buffer.from([1, 2, 3, 4]),
  });
  assert.deepEqual(diagnostics, [], 'producer delivery must not re-enter show');

  await Promise.resolve();
  assert.deepEqual(
    diagnostics.map(({ code, context }) => ({ code, context })),
    [
      {
        code: 'producer-window-registered',
        context: { windowId: 7 },
      },
      {
        code: 'producer-frame-publication-started',
        context: { windowId: 7, width: 640, height: 360 },
      },
    ],
  );

  harness.session.sendFrame(harness.window, {
    getSize: () => ({ width: 640, height: 360 }),
    toBitmap: () => Buffer.from([5, 6, 7, 8]),
  });
  await Promise.resolve();
  assert.equal(
    diagnostics.filter(
      ({ code }) => code === 'producer-frame-publication-started',
    ).length,
    1,
  );
});

test('registration failure rolls back state and reports only a safe code', async () => {
  const failure = Object.assign(new Error('secret registration detail'), {
    code: 'ENOMEM',
  });
  const harness = createProducerPublicationHarness({
    addWindow: () => {
      throw failure;
    },
  });
  const diagnostics = [];
  harness.session.on('diagnostic', (diagnostic) =>
    diagnostics.push(diagnostic),
  );

  assert.throws(() => harness.session.registerWindow(harness.window), failure);
  assert.equal(harness.session.windowScaleStates.has(7), false);
  assert.equal(harness.session.publishedWindowGeometry.has(7), false);
  await Promise.resolve();
  assert.deepEqual(
    diagnostics.map(({ code, context }) => ({ code, context })),
    [
      {
        code: 'producer-window-publication-failed',
        context: {
          windowId: 7,
          operation: 'register',
          errorCode: 'ENOMEM',
        },
      },
    ],
  );
});

test('frame transport rejection is contained and does not claim publication', async (t) => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });
  const harness = createProducerPublicationHarness({
    sendFrameBuffer: () => false,
  });
  const diagnostics = [];
  harness.session.on('diagnostic', (diagnostic) =>
    diagnostics.push(diagnostic),
  );
  harness.session.registerWindow(harness.window);
  await Promise.resolve();
  diagnostics.length = 0;

  assert.doesNotThrow(() => {
    harness.session.sendFrame(harness.window, {
      getSize: () => ({ width: 640, height: 360 }),
      toBitmap: () => Buffer.from([1, 2, 3, 4]),
    });
  });
  await Promise.resolve();
  assert.deepEqual(
    diagnostics.map(({ code, context }) => ({ code, context })),
    [
      {
        code: 'producer-frame-publication-failed',
        context: { windowId: 7, stage: 'transport' },
      },
    ],
  );
  assert.equal(harness.session.producerFramePublicationStarted.has(7), false);
  assert.equal(warnings.length, 1);
});

test('producer diagnostic delivery is bounded and rate limited per window code', async () => {
  const session = createOverlaySession({});
  const diagnostics = [];
  session.on('diagnostic', (diagnostic) => diagnostics.push(diagnostic));

  for (let windowId = 1; windowId <= 40; windowId += 1) {
    session.publishProducerDiagnostic('producer-window-registered', {
      windowId,
    });
  }
  session.publishProducerDiagnostic('producer-window-registered', {
    windowId: 40,
  });
  await Promise.resolve();

  assert.equal(diagnostics.length, 32);
  assert.deepEqual(
    diagnostics.map(({ context }) => context.windowId),
    Array.from({ length: 32 }, (_value, index) => index + 9),
  );
});

test('input diagnostic cooldowns are isolated and retired per target PID', async () => {
  const session = createOverlaySession({});
  const diagnostics = [];
  session.on('diagnostic', (diagnostic) => diagnostics.push(diagnostic));
  const publish = (pid) =>
    session.publishProducerDiagnostic(
      'producer-input-forwarding-failed',
      { windowId: 7, stage: 'dispatch' },
      pid,
    );

  assert.equal(publish(5001), true);
  assert.equal(publish(5001), false);
  assert.equal(publish(5002), true);
  await Promise.resolve();
  assert.deepEqual(
    diagnostics.map(({ pid }) => pid),
    [5001, 5002],
  );

  session.handleEvent('game.process.disconnected', {
    pid: 5001,
    path: 'C:\\Games\\example.exe',
  });
  assert.equal(publish(5001), true);
  await Promise.resolve();
  assert.deepEqual(
    diagnostics.map(({ pid }) => pid),
    [5001, 5002, 5001],
  );
});

test('renderer invalidation failure is not mislabeled as bounds publication', async (t) => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });
  const harness = createProducerPublicationHarness();
  const diagnostics = [];
  harness.session.on('diagnostic', (diagnostic) =>
    diagnostics.push(diagnostic),
  );
  harness.session.registerWindow(harness.window);
  await Promise.resolve();
  diagnostics.length = 0;
  harness.window.browserWindow.webContents.invalidate = () => {
    throw Object.assign(new Error('renderer unavailable'), { code: 'EIO' });
  };

  harness.setContentBounds({ x: 0, y: 0, width: 800, height: 450 });
  assert.doesNotThrow(() => harness.session.syncWindowGeometry(harness.window));
  await Promise.resolve();

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    harness.session.windowScaleStates.get(7).desiredRasterBounds,
    { x: 0, y: 0, width: 800, height: 450 },
  );
  assert.equal(warnings.length, 1);
});

test('bounds publication failure keeps the last committed scale state', async (t) => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });
  let rejectBounds = false;
  const failure = Object.assign(new Error('secret bounds detail'), {
    code: 'EIO',
  });
  const harness = createProducerPublicationHarness({
    sendWindowBounds: () => {
      if (rejectBounds) {
        throw failure;
      }
    },
  });
  const diagnostics = [];
  harness.session.on('diagnostic', (diagnostic) =>
    diagnostics.push(diagnostic),
  );
  harness.session.registerWindow(harness.window);
  await Promise.resolve();
  diagnostics.length = 0;

  rejectBounds = true;
  harness.setContentBounds({ x: 20, y: 30, width: 640, height: 360 });
  assert.doesNotThrow(() => harness.session.syncWindowGeometry(harness.window));
  assert.deepEqual(
    harness.session.windowScaleStates.get(7).desiredRasterBounds,
    bounds,
  );
  await Promise.resolve();
  assert.deepEqual(
    diagnostics.map(({ code, context }) => ({ code, context })),
    [
      {
        code: 'producer-window-publication-failed',
        context: {
          windowId: 7,
          operation: 'bounds',
          errorCode: 'EIO',
        },
      },
    ],
  );
  assert.equal(warnings.length, 1);
});
