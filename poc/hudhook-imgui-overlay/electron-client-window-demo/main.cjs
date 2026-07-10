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
  startLifecycleSequence();
}

function handleNativeEvent({ event, payload }) {
  if (event !== 'game.process' || targetConnected) {
    return;
  }

  targetConnected = true;
  clearTargetConnectionTimeout();
  const targetPid = Number.isInteger(payload?.pid) ? payload.pid : 'unknown';
  console.log(`${TARGET_CONNECTED_MARKER} pid=${targetPid}`);
  maybeStartLifecycleSequence();
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

async function createDemo() {
  const { ElectronGameOverlay } = require('electron-game-overlay');

  overlay = new ElectronGameOverlay();
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
