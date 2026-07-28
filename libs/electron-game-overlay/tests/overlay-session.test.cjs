const assert = require('node:assert/strict');
const test = require('node:test');

const { OverlaySession } = require('../dist/lib/overlay-session.js');
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
  const session = new OverlaySession(nativeOverlay);
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
    windowId: 7,
    scaleFactorMicros: 1_000_000,
  });
}

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

test('retains immutable target surfaces and typed FPS until confirmed process exit', () => {
  const session = new OverlaySession({});
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

  session.handleEvent('game.process.transport-lost', { pid: 4321 });
  assert.equal(
    session.targets.get(4321, '0x1234'),
    retained,
    'transient socket loss must retain the last authoritative surface',
  );

  session.handleEvent('game.process.disconnected', { pid: 4321 });
  assert.equal(session.targets.get(4321, '0x1234'), null);
  assert.deepEqual(removed, [{ pid: 4321, surfaceId: '0x1234', revision: 1 }]);
  assert.ok(Object.isFrozen(removed[0]));
});

test('consumer event failures cannot corrupt telemetry or interrupt internal updates', (t) => {
  const session = new OverlaySession({});
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
  session.on('nativeEvent', ({ payload }) => {
    payload.revision = 999;
    throw new Error('native listener failure');
  });

  assert.doesNotThrow(() => {
    session.handleEvent('game.target.surface', targetSurface());
  });
  assert.equal(followerUpdates, 1);
  assert.equal(session.targets.get(4321, '0x1234').revision, 1);
  assert.deepEqual(typedRevisions, [1]);
  assert.equal(warnings.length, 2);
});

test('surface removal honors revisions and causes the default selector to fall back', () => {
  const session = new OverlaySession({});
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
    authorizeTarget: async (pid, discoveryPath) => {
      calls.push(['authorize', pid, discoveryPath]);
      return () => calls.push('release');
    },
  };
  const session = new OverlaySession(overlay);
  session.electronScreen = {
    on() {},
    removeListener() {},
  };

  const release = await session.authorizeTarget(
    4321,
    'C:\\overlay-runs\\target\\electron-overlay-transport-v1.json',
  );
  assert.deepEqual(calls, [
    'start',
    'ready',
    [
      'authorize',
      4321,
      'C:\\overlay-runs\\target\\electron-overlay-transport-v1.json',
    ],
  ]);
  release();
  assert.equal(calls.at(-1), 'release');

  const legacySession = new OverlaySession({
    start() {},
    stop() {},
    setEventCallback() {},
    whenReady: () => Promise.resolve(),
  });
  legacySession.electronScreen = session.electronScreen;
  const legacyRelease = await legacySession.authorizeTarget(
    4322,
    'C:\\overlay-runs\\legacy\\electron-overlay-transport-v1.json',
  );
  assert.equal(typeof legacyRelease, 'function');
  legacyRelease();
});

test('session close revokes active and late target authorizations', async () => {
  const activeCalls = [];
  const activeSession = new OverlaySession({
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
  const activeRelease = await activeSession.authorizeTarget(
    5001,
    'C:\\overlay-runs\\active\\electron-overlay-transport-v1.json',
  );
  activeSession.close();
  activeRelease();
  assert.deepEqual(activeCalls, ['release']);

  const readiness = deferred();
  let readinessAuthorizationCalled = false;
  const readinessSession = new OverlaySession({
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
  const readinessAuthorization = readinessSession.authorizeTarget(
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
  const backendSession = new OverlaySession({
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
  const backendAuthorization = backendSession.authorizeTarget(
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
    isResizable: () => true,
    getContentBounds: () => ({ ...contentBounds }),
    setContentBounds: (next) => {
      contentBounds = { ...next };
      setContentBoundsCalls.push({ ...next });
    },
    getNativeWindowHandle: () => Buffer.from([123, 0, 0, 0]),
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
  const session = new OverlaySession(overlay);
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
  assert.equal(boundsUpdates.at(-1).details.dragBorderWidth, 0);
  assert.equal(boundsUpdates.at(-1).details.minWidth, 640);
  assert.equal(boundsUpdates.at(-1).details.maxWidth, 640);
  assert.equal(boundsUpdates.at(-1).details.minHeight, 360);
  assert.equal(boundsUpdates.at(-1).details.maxHeight, 360);
  assert.equal(
    boundsUpdates.at(-1).details.rasterChanged,
    undefined,
    'old pixels remain labeled with the active raster during resize',
  );

  session.sendFrame(window, {
    getSize: () => ({ width: 1920, height: 1080 }),
    getBitmap: () => Buffer.from([1, 2, 3, 4]),
  });
  assert.deepEqual(boundsUpdates.at(-1), {
    id: 7,
    details: {
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      maxWidth: 1920,
      maxHeight: 1080,
      minWidth: 1920,
      minHeight: 1080,
      caption: { left: 0, right: 0, top: 0, height: 0 },
      dragBorderWidth: 0,
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
    getBitmap: () => Buffer.from([5, 6, 7, 8]),
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
