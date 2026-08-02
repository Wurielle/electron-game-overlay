import { app, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ElectronGameOverlay,
  ReShadeOverlayLauncher,
  parseReShadeLaunchConfig,
} from 'electron-game-overlay';

const STATUS_CHANNEL = 'multiple-windows:status';
const GET_STATUS_CHANNEL = 'multiple-windows:get-status';
const GOVERLAY_PROJECT_URL = 'https://github.com/hiitiger/goverlay';

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

launcher.onEvent((event) => {
  if (event.type === 'injector-watcher-ready') {
    console.log(`Injector watcher ready. Launch ${target.processName} now.`);
  }
});

ipcMain.handle(GET_STATUS_CHANNEL, () => status);

app.on('before-quit', () => {
  ipcMain.removeHandler(GET_STATUS_CHANNEL);
  launcher.dispose();
  session.close();
  overlay.dispose();
});

app.on('window-all-closed', () => app.quit());

void app.whenReady().then(async () => {
  session.start();

  const rendererFile = path.join(__dirname, '..', 'renderer', 'index.html');
  const controlsUrl = pathToFileURL(rendererFile);
  controlsUrl.searchParams.set('panel', 'controls');
  const telemetryUrl = pathToFileURL(rendererFile);
  telemetryUrl.searchParams.set('panel', 'telemetry');

  const sharedBrowserWindowOptions: Electron.BrowserWindowConstructorOptions = {
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
  const publishStatus = (nextStatus: string) => {
    status = nextStatus;
    for (const window of windows) {
      window.browserWindow.webContents.send(STATUS_CHANNEL, status);
    }
  };

  for (const window of windows) {
    routeProjectLinkExternally(window);
    window.show();
    window.browserWindow.webContents.once('did-finish-load', () =>
      window.browserWindow.webContents.send(STATUS_CHANNEL, status),
    );
  }

  try {
    const attached = await launcher.attach(session, target);
    publishStatus(`Connected to ${attached.processName} (PID ${attached.pid})`);
  } catch (error) {
    publishStatus(`Attachment failed: ${errorMessage(error)}`);
    console.error(error);
  }
});

function routeProjectLinkExternally(
  window: ReturnType<typeof session.windows.create>,
): void {
  window.browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === GOVERLAY_PROJECT_URL) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.browserWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url === GOVERLAY_PROJECT_URL) void shell.openExternal(url);
  });
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
  return argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
