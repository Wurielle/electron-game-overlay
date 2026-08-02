import { app, globalShortcut, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import {
  ElectronGameOverlay,
  ReShadeOverlayLauncher,
  parseReShadeLaunchConfig,
} from 'electron-game-overlay';

const SHORTCUT = 'Control+I';
const STATE_CHANNEL = 'input-interception:state';
const GET_STATE_CHANNEL = 'input-interception:get-state';
const TOGGLE_CHANNEL = 'input-interception:toggle';
const GOVERLAY_PROJECT_URL = 'https://github.com/hiitiger/goverlay';

type DemoState = Readonly<{
  attachment: string;
  intercepting: boolean;
  shortcut: string;
}>;

app.disableHardwareAcceleration();

const target = readTarget(process.argv);
const launchConfig = parseReShadeLaunchConfig(process.argv);

if (!launchConfig) {
  throw new Error('Run this demo with --reshade-overlay enabled.');
}

const overlay = new ElectronGameOverlay();
const session = overlay.createSession();
const launcher = new ReShadeOverlayLauncher(launchConfig);
let overlayWindow: ReturnType<typeof session.windows.create> | null = null;
let state: DemoState = {
  attachment: `Waiting to attach to ${target.processName}`,
  intercepting: false,
  shortcut: 'Ctrl+I',
};

launcher.onEvent((event) => {
  if (event.type === 'injector-watcher-ready') {
    console.log(`Injector watcher ready. Launch ${target.processName} now.`);
  }
});

const publishState = (change: Partial<DemoState>) => {
  state = Object.freeze({ ...state, ...change });
  overlayWindow?.browserWindow.webContents.send(STATE_CHANNEL, state);
};

const toggleInterception = () => {
  if (state.intercepting) {
    session.input.release();
  } else {
    session.input.intercept();
  }
  publishState({ intercepting: !state.intercepting });
  return state;
};

ipcMain.handle(GET_STATE_CHANNEL, () => state);
ipcMain.handle(TOGGLE_CHANNEL, () => toggleInterception());

app.on('before-quit', () => {
  if (state.intercepting) {
    session.input.release();
  }
  globalShortcut.unregister(SHORTCUT);
  ipcMain.removeHandler(GET_STATE_CHANNEL);
  ipcMain.removeHandler(TOGGLE_CHANNEL);
  launcher.dispose();
  session.close();
  overlay.dispose();
});

app.on('window-all-closed', () => app.quit());

void app.whenReady().then(async () => {
  session.start();

  overlayWindow = session.windows.create({
    id: 'input-interception',
    name: 'Input interception',
    bounds: { x: 64, y: 64, width: 480, height: 290 },
    captionHeight: 54,
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
  overlayWindow.show();
  overlayWindow.browserWindow.webContents.once('did-finish-load', () =>
    publishState({}),
  );

  if (!globalShortcut.register(SHORTCUT, toggleInterception)) {
    publishState({
      attachment: `Could not register ${state.shortcut}; another app may own it`,
    });
    console.warn(`Could not register global shortcut ${SHORTCUT}`);
  }

  try {
    const attached = await launcher.attach(session, target);
    publishState({
      attachment: `Connected to ${attached.processName} (PID ${attached.pid})`,
    });
  } catch (error) {
    publishState({ attachment: `Attachment failed: ${errorMessage(error)}` });
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
