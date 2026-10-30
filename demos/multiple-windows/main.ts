import { app, ipcMain } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ElectronGameOverlay,
  ReShadeOverlayLauncher,
  parseReShadeLaunchConfig,
} from 'electron-game-overlay';
import { markDemoSmokeWatcherReady } from '../demo-smoke';
import { observeRenderer } from '../runtime-diagnostics';

const STATUS_CHANNEL = 'multiple-windows:status';
const GET_STATUS_CHANNEL = 'multiple-windows:get-status';
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

    const rendererFile = path.join(__dirname, '..', 'renderer', 'index.html');
    const controlsUrl = pathToFileURL(rendererFile);
    controlsUrl.searchParams.set('panel', 'controls');
    const telemetryUrl = pathToFileURL(rendererFile);
    telemetryUrl.searchParams.set('panel', 'telemetry');

    const sharedBrowserWindowOptions: Electron.BrowserWindowConstructorOptions =
      {
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
      };

    const controlsWindow = session.windows.create({
      id: 'controls',
      name: 'Controls panel',
      bounds: { x: 50, y: 56, width: 390, height: 235 },
      captionHeight: 52,
      dragBorder: 8,
      transparent: true,
      focusOnReady: true,
      url: controlsUrl.toString(),
      browserWindow: sharedBrowserWindowOptions,
    });

    const telemetryWindow = session.windows.create({
      id: 'telemetry',
      name: 'Telemetry panel',
      bounds: { x: 470, y: 56, width: 320, height: 205 },
      captionHeight: 52,
      dragBorder: 8,
      transparent: true,
      url: telemetryUrl.toString(),
      browserWindow: sharedBrowserWindowOptions,
    });

    const windows = [controlsWindow, telemetryWindow];
    observeRenderer(controlsWindow.browserWindow, 'multiple-windows:controls');
    observeRenderer(
      telemetryWindow.browserWindow,
      'multiple-windows:telemetry',
    );
    const publishStatus = (nextStatus: string) => {
      status = nextStatus;
      for (const window of windows) {
        const browserWindow = window.browserWindow;
        if (browserWindow.isDestroyed()) continue;
        const webContents = browserWindow.webContents;
        if (!webContents.isDestroyed())
          webContents.send(STATUS_CHANNEL, status);
      }
    };

    for (const window of windows) {
      blockRendererNavigation(window);
      window.show();
      window.browserWindow.webContents.once('did-finish-load', () => {
        const browserWindow = window.browserWindow;
        if (browserWindow.isDestroyed()) return;
        const webContents = browserWindow.webContents;
        if (!webContents.isDestroyed())
          webContents.send(STATUS_CHANNEL, status);
      });
    }

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
