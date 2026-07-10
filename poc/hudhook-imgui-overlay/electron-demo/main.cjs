const path = require('node:path');

const { app } = require('electron');

const DEMO_NAME = 'HudhookElectronDemo';
const DEMO_WIDTH = 640;
const DEMO_HEIGHT = 360;
const DEMO_FRAME_RATE = 30;
const READY_MARKER = 'HUDHOOK_ELECTRON_DEMO_READY';

// Keep the POC's Electron bitmap and the fixed hudhook texture at exactly the
// same physical size on displays configured above 100% scaling.
app.setPath(
  'userData',
  path.join(app.getPath('temp'), `hudhook-electron-demo-${process.pid}`),
);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

let overlay = null;
let session = null;
let overlayWindow = null;
let cleanupStarted = false;
let readyLogged = false;
let pageLoaded = false;
let observedFrames = 0;

function log(message) {
  console.log(`[hudhook-electron-demo] ${message}`);
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function cleanup(reason) {
  if (cleanupStarted) {
    return;
  }

  cleanupStarted = true;
  log(`stopping reason=${reason} frames=${observedFrames}`);

  if (overlayWindow) {
    try {
      overlayWindow.destroy();
    } catch (error) {
      console.error(
        `[hudhook-electron-demo] failed to destroy overlay window: ${formatError(error)}`,
      );
    }
    overlayWindow = null;
  }

  if (session) {
    try {
      session.close();
    } catch (error) {
      console.error(
        `[hudhook-electron-demo] failed to close overlay session: ${formatError(error)}`,
      );
    }
    session = null;
  }

  if (overlay) {
    try {
      overlay.dispose();
    } catch (error) {
      console.error(
        `[hudhook-electron-demo] failed to dispose overlay SDK: ${formatError(error)}`,
      );
    }
    overlay = null;
  }

  log('stopped');
}

function terminate(reason, exitCode) {
  cleanup(reason);
  app.exit(exitCode);
}

function fail(reason, error) {
  console.error(
    `[hudhook-electron-demo] HUDHOOK_ELECTRON_DEMO_ERROR reason=${reason}\n${formatError(error)}`,
  );
  terminate(reason, 1);
}

async function createDemo() {
  // Load the public SDK after Electron is ready. Its native adapter resolves
  // the existing node-game-overlay workspace package and native addon.
  const { ElectronGameOverlay } = require('electron-game-overlay');

  overlay = new ElectronGameOverlay();
  session = overlay.createSession();
  session.start();

  overlayWindow = session.windows.create({
    id: DEMO_NAME,
    name: DEMO_NAME,
    bounds: {
      x: 32,
      y: 32,
      width: DEMO_WIDTH,
      height: DEMO_HEIGHT,
    },
    transparent: false,
    browserWindow: {
      title: DEMO_NAME,
      frame: false,
      show: false,
      transparent: false,
      resizable: false,
      useContentSize: true,
      backgroundColor: '#10171f',
      webPreferences: {
        offscreen: true,
        paintWhenInitiallyHidden: true,
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    },
    file: path.join(__dirname, 'overlay.html'),
  });

  const browserWindow = overlayWindow.browserWindow;
  browserWindow.webContents.setFrameRate(DEMO_FRAME_RATE);

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

  // ElectronOverlayWindow installed its paint listener before returning from
  // session.windows.create(). Therefore this observer runs after the public
  // SDK has synchronously forwarded the whole-frame bitmap to the native
  // addon's sendFrameBuffer() call.
  browserWindow.webContents.on('paint', (event, dirtyRect, image) => {
    const size = image.getSize();
    const byteLength = image.getBitmap().length;
    const expectedByteLength = DEMO_WIDTH * DEMO_HEIGHT * 4;

    // Electron can emit an empty bootstrap paint while the offscreen renderer
    // is being attached. The SDK safely forwards it, but it is not a frame that
    // proves the diagnostic page is ready.
    if (size.width === 0 && size.height === 0 && byteLength === 0) {
      return;
    }

    if (
      size.width !== DEMO_WIDTH ||
      size.height !== DEMO_HEIGHT ||
      byteLength !== expectedByteLength
    ) {
      fail(
        'unexpected-frame',
        new Error(
          `expected ${DEMO_WIDTH}x${DEMO_HEIGHT}/${expectedByteLength} bytes, ` +
            `received ${size.width}x${size.height}/${byteLength} bytes`,
        ),
      );
      return;
    }

    observedFrames += 1;

    if (!pageLoaded) {
      return;
    }

    if (!readyLogged) {
      readyLogged = true;
      console.log(
        `${READY_MARKER} name=${DEMO_NAME} windowId=${browserWindow.id} ` +
          `width=${size.width} height=${size.height} bytes=${byteLength}`,
      );
    } else if (observedFrames % 300 === 0) {
      log(`frames-forwarded=${observedFrames}`);
    }
  });

  browserWindow.on('closed', () => {
    if (!cleanupStarted) {
      terminate('window-closed', 0);
    }
  });

  // ElectronOverlayWindow.show() registers the BrowserWindow with the native
  // overlay after session.start() has initialized node-game-overlay.
  overlayWindow.show();

  log(
    `started name=${DEMO_NAME} size=${DEMO_WIDTH}x${DEMO_HEIGHT} fps=${DEMO_FRAME_RATE}`,
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
