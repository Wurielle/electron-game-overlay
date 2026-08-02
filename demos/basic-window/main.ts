import { app, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import {
  ElectronGameOverlay,
  ReShadeOverlayLauncher,
  parseReShadeLaunchConfig,
} from 'electron-game-overlay';

const STATUS_CHANNEL = 'basic-window:status';
const GET_STATUS_CHANNEL = 'basic-window:get-status';
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
  routeProjectLinkExternally(overlayWindow);

  const publishStatus = (nextStatus: string) => {
    status = nextStatus;
    overlayWindow.browserWindow.webContents.send(STATUS_CHANNEL, status);
  };

  overlayWindow.show();
  overlayWindow.browserWindow.webContents.once('did-finish-load', () =>
    publishStatus(status),
  );

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
