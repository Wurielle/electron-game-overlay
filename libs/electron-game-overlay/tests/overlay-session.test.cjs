const assert = require('node:assert/strict');
const test = require('node:test');

const { OverlaySession } = require('../dist/lib/overlay-session.js');
const { createWindowScaleState } = require('../dist/lib/window-scale-state.js');

const display = {
  id: 1,
  scaleFactor: 1,
  width: 1920,
  height: 1080,
};
const bounds = { x: 0, y: 0, width: 640, height: 360 };

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
  assert.deepEqual(harness.nativeWindowCalls, [
    'BrowserWindow.focusOnWebView',
  ]);
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
