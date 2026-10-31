// @ts-check
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { ElectronGameOverlay } = require('electron-game-overlay');

app.disableHardwareAcceleration();
/** @type {import('electron-game-overlay').ElectronGameOverlay | undefined} */
let overlay;
/** @type {ReturnType<import('electron-game-overlay').ElectronGameOverlay['createSession']> | undefined} */
let session;
/** @type {import('electron-game-overlay').ReShadeOverlayLauncher | undefined} */
let launcher;
let disposed = false;

function dispose() {
  if (disposed) return;
  disposed = true;
  try {
    launcher?.dispose();
  } finally {
    try {
      session?.close();
    } finally {
      overlay?.dispose();
    }
  }
}

/** @param {unknown} error */
function fail(error) {
  console.error(error instanceof Error ? error.message : String(error));
  try {
    dispose();
  } finally {
    app.exit(1);
  }
}

app.on('before-quit', dispose);
app.on('will-quit', dispose);
app.on('window-all-closed', () => app.quit());

/**
 * @param {readonly string[]} argv
 * @returns {{ smoke: true } | { smoke: false, processName: string }}
 */
function readMode(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === '--smoke') return { smoke: true };
  const targets = args.filter((arg) => arg.startsWith('--target-process='));
  const processName = targets[0]?.slice('--target-process='.length);
  if (
    targets.length !== 1 ||
    !processName ||
    processName.length > 260 ||
    processName !== processName.trim() ||
    processName.length <= 4 ||
    /[<>:"/\\\\|?*\u0000-\u001f]/.test(processName) ||
    !/\.exe$/i.test(processName) ||
    args.length !== 2 ||
    args.filter((arg) => arg === '--reshade-overlay').length !== 1
  ) {
    throw new Error(
      'Use --smoke alone, or --target-process=game.exe --reshade-overlay. Keep the game closed until the watcher is ready.',
    );
  }
  if (process.platform !== 'win32')
    throw new Error(
      'Game attachment requires Windows x64. Use --smoke for a noninjecting check.',
    );
  return { smoke: false, processName };
}

void app
  .whenReady()
  .then(async () => {
    const mode = readMode(process.argv);
    // Transport remains lazy in smoke mode: never start a session or launcher.
    overlay = new ElectronGameOverlay({ allowPrereleaseBroker: true });
    session = overlay.createSession();
    if (!mode.smoke) {
      const {
        parseReShadeLaunchConfig,
        ReShadeOverlayLauncher,
      } = require('electron-game-overlay');
      const config = parseReShadeLaunchConfig(process.argv);
      if (!config)
        throw new Error(
          'The explicit --reshade-overlay runtime opt-in is required.',
        );
      launcher = new ReShadeOverlayLauncher(config);
      launcher.onEvent((event) => {
        if (event.type === 'injector-watcher-ready')
          console.log(
            `Injector watcher ready. Launch ${mode.processName} now.`,
          );
      });
      session.start();
      const window = session.windows.create({
        id: 'basic-overlay',
        name: 'Basic overlay',
        bounds: { x: 60, y: 60, width: 440, height: 260 },
        file: path.join(__dirname, 'index.html'),
        browserWindow: {
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      });
      window.browserWindow.webContents.setWindowOpenHandler(() => ({
        action: 'deny',
      }));
      window.browserWindow.webContents.on('will-navigate', (event) =>
        event.preventDefault(),
      );
      window.show();
      const attached = await launcher.attach(session, {
        processName: mode.processName,
      });
      if (!disposed)
        console.log(
          `Connected to ${attached.processName} (PID ${attached.pid}).`,
        );
      return;
    }
    const window = new BrowserWindow({
      width: 480,
      height: 280,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const deadline = setTimeout(
      () => fail(new Error('Smoke timed out')),
      15000,
    );
    try {
      await window.loadFile(path.join(__dirname, 'index.html'));
      const ready = await window.webContents.executeJavaScript(
        "document.querySelector('h1')?.textContent === 'Basic overlay'",
      );
      if (ready !== true) throw new Error('Smoke DOM check failed');
      console.log(
        'SMOKE_OK: Electron window, DOM and lazy SDK session; no game attachment.',
      );
    } finally {
      clearTimeout(deadline);
    }
    app.quit();
  })
  .catch(fail);
