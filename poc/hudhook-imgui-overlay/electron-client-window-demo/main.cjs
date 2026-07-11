const fs = require('node:fs');
const path = require('node:path');

const { app } = require('electron');

const WINDOW_NAME = 'ExampleMainOverlay';
const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 360;
const INITIAL_BOUNDS = {
  x: 64,
  y: 72,
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
};
const MOVED_BOUNDS = {
  x: 176,
  y: 128,
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
};
const FRAME_RATE = 30;
const INITIAL_LIFECYCLE_DELAY_MS = 2500;
const LIFECYCLE_STEP_DELAY_MS = 750;
const TARGET_CONNECTION_TIMEOUT_MS = 30000;
const READY_MARKER = 'HUDHOOK_CLIENT_WINDOW_READY';
const TARGET_CONNECTED_MARKER = 'HUDHOOK_CLIENT_WINDOW_TARGET_CONNECTED';
const EXIT_AFTER_LIFECYCLE = process.argv.includes('--exit-after-lifecycle');
const AUTOMATED_INPUT_PROOF = process.argv.includes(
  '--hudhook-client-input-runner',
);
const MANUAL_INPUT_PROOF = process.argv.includes(
  '--hudhook-client-input-manual',
);
const INPUT_PROOF = AUTOMATED_INPUT_PROOF || MANUAL_INPUT_PROOF;
const INPUT_CONTROL_ARGUMENT = '--input-control-file=';
const inputControlArgument = process.argv.find((argument) =>
  argument.startsWith(INPUT_CONTROL_ARGUMENT),
);
const INPUT_CONTROL_FILE = inputControlArgument
  ? path.resolve(inputControlArgument.slice(INPUT_CONTROL_ARGUMENT.length))
  : null;
const OVERLAY_FILE = path.resolve(
  __dirname,
  '../../../apps/client/public/index/example-main-overlay.html',
);

// Keep Electron's physical bitmap at the same fixed size as the SDK window
// metadata, including on displays configured above 100% scaling.
app.setPath(
  'userData',
  path.join(app.getPath('temp'), `hudhook-client-window-${process.pid}`),
);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

let overlay = null;
let session = null;
let overlayWindow = null;
let disposeNativeEvent = null;
let cleanupStarted = false;
let pageLoaded = false;
let readyLogged = false;
let targetConnected = false;
let lifecycleStarted = false;
let observedFrames = 0;
let targetConnectionTimeout = null;
let inputInterceptRequested = false;
let inputInterceptEnabled = false;
let inputReleaseRequested = false;
let inputReleaseAcknowledged = false;
let manualInputReadyLogged = false;
const lifecycleTimers = new Set();

function log(message) {
  console.log(`[hudhook-client-window-demo] ${message}`);
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function schedule(callback, delayMs = LIFECYCLE_STEP_DELAY_MS) {
  const timer = setTimeout(() => {
    lifecycleTimers.delete(timer);

    if (!cleanupStarted) {
      callback();
    }
  }, delayMs);

  lifecycleTimers.add(timer);
  return timer;
}

function cleanup(reason) {
  if (cleanupStarted) {
    return;
  }

  targetConnectionTimeout = null;

  if (disposeNativeEvent) {
    disposeNativeEvent();
    disposeNativeEvent = null;
  }

  cleanupStarted = true;
  log(`stopping reason=${reason} frames=${observedFrames}`);

  for (const timer of lifecycleTimers) {
    clearTimeout(timer);
  }
  lifecycleTimers.clear();

  if (overlayWindow) {
    try {
      overlayWindow.destroy();
    } catch (error) {
      console.error(
        `[hudhook-client-window-demo] failed to destroy overlay window: ${formatError(error)}`,
      );
    }
    overlayWindow = null;
  }

  if (session) {
    try {
      session.close();
    } catch (error) {
      console.error(
        `[hudhook-client-window-demo] failed to close overlay session: ${formatError(error)}`,
      );
    }
    session = null;
  }

  if (overlay) {
    try {
      overlay.dispose();
    } catch (error) {
      console.error(
        `[hudhook-client-window-demo] failed to dispose overlay SDK: ${formatError(error)}`,
      );
    }
    overlay = null;
  }

  log('stopped');
}
function clearTargetConnectionTimeout() {
  if (!targetConnectionTimeout) {
    return;
  }

  clearTimeout(targetConnectionTimeout);
  lifecycleTimers.delete(targetConnectionTimeout);
  targetConnectionTimeout = null;
}

function armTargetConnectionTimeout() {
  if (targetConnected || targetConnectionTimeout) {
    return;
  }

  targetConnectionTimeout = schedule(() => {
    targetConnectionTimeout = null;
    fail(
      'target-connection-timeout',
      new Error(
        `no game.process event within ${TARGET_CONNECTION_TIMEOUT_MS} ms`,
      ),
    );
  }, TARGET_CONNECTION_TIMEOUT_MS);
}

function maybeStartLifecycleSequence() {
  if (!readyLogged || !targetConnected || lifecycleStarted) {
    return;
  }

  lifecycleStarted = true;
  clearTargetConnectionTimeout();
  if (INPUT_PROOF) {
    startInputProofSequence().catch((error) => {
      fail('input-proof-start', error);
    });
  } else {
    startLifecycleSequence();
  }
}

function handleNativeEvent({ event, payload }) {
  if (event === 'game.process' && !targetConnected) {
    targetConnected = true;
    clearTargetConnectionTimeout();
    const targetPid = Number.isInteger(payload?.pid) ? payload.pid : 'unknown';
    console.log(`${TARGET_CONNECTED_MARKER} pid=${targetPid}`);
    maybeStartLifecycleSequence();
    return;
  }

  if (!INPUT_PROOF || event !== 'game.input.intercept') {
    return;
  }

  if (
    payload?.intercepting === true &&
    inputInterceptRequested &&
    !inputInterceptEnabled
  ) {
    inputInterceptEnabled = true;
    console.log('HUDHOOK_CLIENT_INPUT_INTERCEPT_ENABLED');
    if (MANUAL_INPUT_PROOF && !manualInputReadyLogged) {
      manualInputReadyLogged = true;
      console.log('HUDHOOK_CLIENT_INPUT_MANUAL_READY');
    } else if (MANUAL_INPUT_PROOF) {
      console.log('HUDHOOK_CLIENT_INPUT_MANUAL_RESUMED');
    }
    return;
  }

  if (
    payload?.intercepting === false &&
    MANUAL_INPUT_PROOF &&
    inputInterceptRequested &&
    inputInterceptEnabled
  ) {
    inputInterceptEnabled = false;
    console.log('HUDHOOK_CLIENT_INPUT_MANUAL_SUSPENDED');
    return;
  }

  if (
    payload?.intercepting === false &&
    inputReleaseRequested &&
    !inputReleaseAcknowledged
  ) {
    inputInterceptEnabled = false;
    inputReleaseAcknowledged = true;
    console.log('HUDHOOK_CLIENT_INPUT_INTERCEPT_DISABLED');
    console.log('HUDHOOK_CLIENT_INPUT_LIFECYCLE_COMPLETE');
  }
}

function terminate(reason, exitCode) {
  cleanup(reason);
  app.exit(exitCode);
}

function fail(reason, error) {
  console.error(
    `[hudhook-client-window-demo] HUDHOOK_CLIENT_WINDOW_ERROR reason=${reason}\n${formatError(error)}`,
  );
  terminate(reason, 1);
}

function startLifecycleSequence() {
  schedule(() => {
    overlayWindow.setBounds(MOVED_BOUNDS);
    console.log(
      `HUDHOOK_CLIENT_WINDOW_MOVED x=${MOVED_BOUNDS.x} y=${MOVED_BOUNDS.y}`,
    );

    schedule(() => {
      // hide() keeps the BrowserWindow alive but sends the native SDK's
      // window.close message, allowing the same window to be registered again.
      overlayWindow.hide();
      console.log('HUDHOOK_CLIENT_WINDOW_HIDDEN event=window.close');

      schedule(() => {
        overlayWindow.show();
        overlayWindow.browserWindow.webContents.invalidate();
        console.log('HUDHOOK_CLIENT_WINDOW_RESHOWN');
        console.log('HUDHOOK_CLIENT_WINDOW_LIFECYCLE_COMPLETE');

        if (EXIT_AFTER_LIFECYCLE) {
          schedule(() => terminate('lifecycle-complete', 0));
        }
      });
    });
  }, INITIAL_LIFECYCLE_DELAY_MS);
}

function formatRectValue(value) {
  return Number(value.toFixed(2));
}

function validateNativeInputTranslation(overlayInstance) {
  const nativeOverlay = overlayInstance?.nativeOverlay;
  if (
    !nativeOverlay ||
    typeof nativeOverlay.translateInputEvent !== 'function'
  ) {
    throw new Error('native input translator is unavailable');
  }

  const translate = (msg, wparam = 0, lparam = 0) =>
    nativeOverlay.translateInputEvent({
      windowId: 1,
      msg,
      wparam,
      lparam,
    });

  const signedPoint = ((-10 & 0xffff) | ((-20 & 0xffff) << 16)) >>> 0;
  const move = translate(0x0200, 0, signedPoint);
  const wheel = translate(0x020a, (120 << 16) >>> 0);
  const horizontalWheel = translate(0x020e, (120 << 16) >>> 0);
  const sysChar = translate(0x0106, 'A'.codePointAt(0), 1 << 29);
  const pendingSurrogate = translate(0x0102, 0xd83d);
  const surrogatePair = translate(0x0102, 0xde42);
  const unicodeChar = translate(0x0109, 0x1f642);
  const rejectedTranslations = [
    ['xButtonDown', translate(0x020b, 1 << 16)],
    ['xButtonUp', translate(0x020c, 1 << 16)],
    ['xButtonDoubleClick', translate(0x020d, 1 << 16)],
    ['deadChar', translate(0x0103, 0x005e)],
    ['sysDeadChar', translate(0x0107, 0x005e)],
    ['reservedKeyboardMessage', translate(0x0108)],
    ['unicodeNoChar', translate(0x0109, 0xffff)],
    ['unicodeSurrogate', translate(0x0109, 0xd800)],
    ['unicodeOutOfRange', translate(0x0109, 0x110000)],
    ['unhandled', translate(0x0000)],
  ].filter(([, value]) => value !== undefined);

  if (
    move?.x !== -10 ||
    move?.y !== -20 ||
    wheel?.canScroll !== true ||
    Object.prototype.hasOwnProperty.call(wheel, 'canScroll ') ||
    horizontalWheel?.type !== 'mouseWheel' ||
    horizontalWheel?.deltaX !== -120 ||
    horizontalWheel?.canScroll !== true ||
    sysChar?.type !== 'char' ||
    sysChar?.keyCode !== 'A' ||
    !sysChar?.modifiers?.includes('alt') ||
    pendingSurrogate !== undefined ||
    surrogatePair?.type !== 'char' ||
    surrogatePair?.keyCode !== String.fromCodePoint(0x1f642) ||
    unicodeChar?.type !== 'char' ||
    unicodeChar?.keyCode !== String.fromCodePoint(0x1f642) ||
    rejectedTranslations.length !== 0
  ) {
    throw new Error(
      `native input translation contract failed: ${JSON.stringify({
        move,
        wheel,
        horizontalWheel,
        sysChar,
        pendingSurrogate,
        surrogatePair,
        unicodeChar,
        rejectedTranslations,
      })}`,
    );
  }

  console.log('HUDHOOK_CLIENT_INPUT_TRANSLATION_READY');
}

function pollInputControlFile() {
  if (cleanupStarted || inputReleaseRequested) {
    return;
  }

  let command = '';
  try {
    if (fs.existsSync(INPUT_CONTROL_FILE)) {
      command = fs.readFileSync(INPUT_CONTROL_FILE, 'utf8').trim();
    }
  } catch (error) {
    log(`input control file temporarily unavailable: ${formatError(error)}`);
  }

  if (command === 'release') {
    inputReleaseRequested = true;
    session.input.release();
    console.log('HUDHOOK_CLIENT_INPUT_RELEASE_REQUESTED');
    return;
  }

  schedule(pollInputControlFile, 50);
}

async function startInputProofSequence() {
  if (AUTOMATED_INPUT_PROOF && !INPUT_CONTROL_FILE) {
    throw new Error(
      `${INPUT_CONTROL_ARGUMENT}<path> is required for the input proof`,
    );
  }

  const browserWindow = overlayWindow.browserWindow;
  const targetRect = await browserWindow.webContents.executeJavaScript(
    `(() => {
      const proof = window.hudhookInputProof;
      if (!proof || typeof proof.getTargetRect !== 'function') {
        return null;
      }
      if (typeof proof.enable !== 'function') {
        return null;
      }
      proof.enable();
      return proof.getTargetRect();
    })()`,
    true,
  );

  if (
    !targetRect ||
    !Number.isFinite(targetRect.x) ||
    !Number.isFinite(targetRect.y) ||
    !Number.isFinite(targetRect.width) ||
    !Number.isFinite(targetRect.height) ||
    targetRect.width <= 0 ||
    targetRect.height <= 0
  ) {
    throw new Error(`invalid input target rect: ${JSON.stringify(targetRect)}`);
  }

  const windowBounds = browserWindow.getBounds();
  console.log(
    'HUDHOOK_CLIENT_INPUT_TARGET ' +
      `x=${formatRectValue(targetRect.x)} ` +
      `y=${formatRectValue(targetRect.y)} ` +
      `width=${formatRectValue(targetRect.width)} ` +
      `height=${formatRectValue(targetRect.height)} ` +
      `windowX=${windowBounds.x} windowY=${windowBounds.y}`,
  );

  inputInterceptRequested = true;
  session.input.intercept();
  console.log('HUDHOOK_CLIENT_INPUT_INTERCEPT_REQUESTED');
  if (AUTOMATED_INPUT_PROOF) {
    pollInputControlFile();
  }
}

async function createDemo() {
  const { ElectronGameOverlay } = require('electron-game-overlay');

  overlay = new ElectronGameOverlay();
  if (INPUT_PROOF) {
    validateNativeInputTranslation(overlay);
  }
  session = overlay.createSession();
  disposeNativeEvent = session.on('nativeEvent', handleNativeEvent);
  session.start();

  overlayWindow = session.windows.create({
    id: WINDOW_NAME,
    name: WINDOW_NAME,
    bounds: INITIAL_BOUNDS,
    dragBorder: 10,
    captionHeight: 40,
    transparent: true,
    browserWindow: {
      title: WINDOW_NAME,
      frame: false,
      show: false,
      transparent: true,
      resizable: false,
      useContentSize: true,
      backgroundColor: '#00000000',
      webPreferences: {
        offscreen: true,
        paintWhenInitiallyHidden: true,
        backgroundThrottling: false,
        // The existing page calls window.require('electron'), matching the
        // real client's BrowserWindow configuration.
        nodeIntegration: true,
        contextIsolation: false,
      },
    },
    file: OVERLAY_FILE,
  });

  const browserWindow = overlayWindow.browserWindow;
  browserWindow.webContents.setFrameRate(FRAME_RATE);

  browserWindow.webContents.on('console-message', (event, level, message) => {
    if (
      INPUT_PROOF &&
      typeof message === 'string' &&
      message.startsWith('HUDHOOK_CLIENT_INPUT_')
    ) {
      console.log(message);
    }
  });

  browserWindow.webContents.on('did-finish-load', () => {
    pageLoaded = true;
    browserWindow.webContents.invalidate();
  });

  browserWindow.webContents.on('did-fail-load', (event, code, description) => {
    fail('page-load', new Error(`load failed (${code}): ${description}`));
  });

  browserWindow.webContents.on('render-process-gone', (event, details) => {
    fail(
      'renderer-gone',
      new Error(`renderer exited: ${JSON.stringify(details)}`),
    );
  });

  // The SDK's own paint listener runs first and synchronously publishes this
  // same NativeImage through node-game-overlay before this observer validates
  // the complete physical bitmap.
  browserWindow.webContents.on('paint', (event, dirtyRect, image) => {
    const size = image.getSize();
    const byteLength = image.getBitmap().length;
    const expectedByteLength = WINDOW_WIDTH * WINDOW_HEIGHT * 4;

    if (size.width === 0 && size.height === 0 && byteLength === 0) {
      return;
    }

    if (
      size.width !== WINDOW_WIDTH ||
      size.height !== WINDOW_HEIGHT ||
      byteLength !== expectedByteLength
    ) {
      fail(
        'unexpected-frame',
        new Error(
          `expected ${WINDOW_WIDTH}x${WINDOW_HEIGHT}/${expectedByteLength} bytes, ` +
            `received ${size.width}x${size.height}/${byteLength} bytes`,
        ),
      );
      return;
    }

    observedFrames += 1;

    if (!pageLoaded || readyLogged) {
      return;
    }

    readyLogged = true;
    console.log(READY_MARKER);
    log(
      `frame-ready name=${WINDOW_NAME} windowId=${browserWindow.id} ` +
        `position=${INITIAL_BOUNDS.x},${INITIAL_BOUNDS.y} ` +
        `size=${size.width}x${size.height} bytes=${byteLength}`,
    );
    armTargetConnectionTimeout();
    maybeStartLifecycleSequence();
  });

  browserWindow.on('closed', () => {
    if (!cleanupStarted) {
      terminate('window-closed', 0);
    }
  });

  overlayWindow.show();
  log(
    `started name=${WINDOW_NAME} file=${OVERLAY_FILE} ` +
      `position=${INITIAL_BOUNDS.x},${INITIAL_BOUNDS.y} ` +
      `size=${WINDOW_WIDTH}x${WINDOW_HEIGHT} fps=${FRAME_RATE}`,
  );
}

app.on('before-quit', () => {
  cleanup('before-quit');
});

app.on('window-all-closed', () => {
  if (!cleanupStarted) {
    app.quit();
  }
});

process.once('SIGINT', () => terminate('SIGINT', 0));
process.once('SIGTERM', () => terminate('SIGTERM', 0));

process.on('uncaughtException', (error) => {
  fail('uncaught-exception', error);
});

process.on('unhandledRejection', (error) => {
  fail('unhandled-rejection', error);
});

app
  .whenReady()
  .then(createDemo)
  .catch((error) => {
    fail('startup', error);
  });
