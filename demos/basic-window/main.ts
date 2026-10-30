import { app, ipcMain } from 'electron';
import * as path from 'node:path';
import {
  ElectronGameOverlay,
  ReShadeOverlayLauncher,
  parseReShadeLaunchConfig,
} from 'electron-game-overlay';
import { markDemoSmokeWatcherReady } from '../demo-smoke';
import { observeRenderer } from '../runtime-diagnostics';

const STATUS_CHANNEL = 'basic-window:status';
const GET_STATUS_CHANNEL = 'basic-window:get-status';
app.disableHardwareAcceleration();

const target = readTarget(process.argv);
const launchConfig = parseReShadeLaunchConfig(process.argv);

if (!launchConfig) {
  throw new Error('Run this demo with --reshade-overlay enabled.');
}

const overlay = new ElectronGameOverlay();
const session = overlay.createSession();
const launcher = new ReShadeOverlayLauncher(launchConfig);
let status = `Waiting to attach to ${target.processName}`;
let disposed = false;

launcher.onEvent((event) => {
  if (event.type === 'injector-watcher-ready') {
    console.log(`Injector watcher ready. Launch ${target.processName} now.`);
    markDemoSmokeWatcherReady();
  }
});

ipcMain.handle(GET_STATUS_CHANNEL, () => status);

app.on('before-quit', dispose);

function dispose(): void {
  if (disposed) return;
  disposed = true;
  ipcMain.removeHandler(GET_STATUS_CHANNEL);
  launcher.dispose();
  session.close();
  overlay.dispose();
}

app.on('window-all-closed', () => app.quit());

void app
  .whenReady()
  .then(async () => {
    session.start();

    const overlayWindow = session.windows.create({
      id: 'basic-window',
      name: 'Basic window',
      bounds: { x: 60, y: 60, width: 440, height: 260 },
      captionHeight: 52,
      dragBorder: 8,
      transparent: true,
      focusOnReady: true,
      file: path.join(__dirname, '..', 'renderer', 'index.html'),
      browserWindow: {
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload', 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      },
    });
    observeRenderer(overlayWindow.browserWindow, 'basic-window');
    blockRendererNavigation(overlayWindow);

    const publishStatus = (nextStatus: string) => {
      status = nextStatus;
      const browserWindow = overlayWindow.browserWindow;
      if (browserWindow.isDestroyed()) return;
      const webContents = browserWindow.webContents;
      if (!webContents.isDestroyed()) webContents.send(STATUS_CHANNEL, status);
    };

    overlayWindow.show();
    overlayWindow.browserWindow.webContents.once('did-finish-load', () =>
      publishStatus(status),
    );

    try {
      const attached = await launcher.attach(session, target);
      if (disposed) return;
      console.log(
        `Demo connected to ${attached.processName} (PID ${attached.pid}).`,
      );
      publishStatus(
        `Connected to ${attached.processName} (PID ${attached.pid})`,
      );
    } catch (error) {
      if (disposed) return;
      publishStatus(`Attachment failed: ${errorMessage(error)}`);
      console.error(error);
    }
  })
  .catch((error) => {
    if (disposed) return;
    console.error(error);
    process.exitCode = 1;
    app.quit();
  });

function blockRendererNavigation(
  window: ReturnType<typeof session.windows.create>,
): void {
  window.browserWindow.webContents.setWindowOpenHandler(() => ({
    action: 'deny',
  }));
  window.browserWindow.webContents.on('will-navigate', (event) =>
    event.preventDefault(),
  );
}

function readTarget(argv: readonly string[]) {
  const processName = readOption(argv, '--target-process');
  if (!processName) {
    throw new Error('Pass the target executable as --target-process=game.exe');
  }
  return { processName };
}

function readOption(argv: readonly string[], name: string) {
  const prefix = `${name}=`;
  const inline = argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
  if (inline) return inline;
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1]?.trim();
  return value && !value.startsWith('--') ? value : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
