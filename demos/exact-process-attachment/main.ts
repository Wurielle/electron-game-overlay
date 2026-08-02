import * as path from 'node:path';
import { app, ipcMain, shell } from 'electron';
import {
  ElectronGameOverlay,
  isReShadeOperationError,
  parseReShadeLaunchConfig,
  ReShadeOverlayLauncher,
  type ElectronOverlayWindow,
} from 'electron-game-overlay';

type DemoState = Readonly<{
  phase: 'starting' | 'attaching' | 'connected' | 'failed';
  target: string;
  detail: string;
  intercepting: boolean;
}>;
const GOVERLAY_PROJECT_URL = 'https://github.com/hiitiger/goverlay';

const processName = requiredArgument('--target-process');
const pid = positivePid(requiredArgument('--target-pid'));
const executablePath = optionalArgument('--target-path');
const reshadeConfig = parseReShadeLaunchConfig(process.argv);

if (!reshadeConfig) {
  throw new Error('This demo must be launched with --reshade-overlay.');
}

app.disableHardwareAcceleration();

const overlay = new ElectronGameOverlay();
const session = overlay.createSession();
const launcher = new ReShadeOverlayLauncher(reshadeConfig);
const preparedRuntime = launcher.prepare();
let overlayWindow: ElectronOverlayWindow | null = null;
let state: DemoState = {
  phase: 'starting',
  target: `${processName} (pid ${pid})`,
  detail: 'Starting the authenticated overlay transport',
  intercepting: false,
};

launcher.onEvent((event) => {
  console.log('[launcher]', event);
});
session.on('diagnostic', (diagnostic) => {
  console.log('[session]', diagnostic);
});

ipcMain.handle('demo:get-state', () => state);
ipcMain.handle('demo:set-intercepting', (_event, intercepting: unknown) => {
  const requested = intercepting === true;
  requested ? session.input.intercept() : session.input.release();
  updateState({ intercepting: requested });
  return state;
});

app.on('before-quit', dispose);
app.on('window-all-closed', () => app.quit());

void app
  .whenReady()
  .then(start)
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

async function start(): Promise<void> {
  overlayWindow = session.windows.create({
    id: 'exact-process-status',
    name: 'Exact process attachment',
    file: path.join(__dirname, '..', 'renderer', 'index.html'),
    bounds: { x: 40, y: 40, width: 460, height: 330 },
    focusOnReady: true,
    dragBorder: 12,
    captionHeight: 44,
    transparent: true,
    browserWindow: {
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
  });
  routeProjectLinkExternally(overlayWindow);
  overlayWindow.show();

  updateState({
    phase: 'attaching',
    detail: 'Transport ready; injecting and waiting for target authentication',
  });
  await Promise.all([session.whenReady(), preparedRuntime]);

  try {
    const result = await launcher.attach(session, {
      processName,
      pid,
      ...(executablePath ? { executablePath } : {}),
    });
    updateState({
      phase: 'connected',
      detail: `Connected through ${result.runtimeMode}`,
    });
  } catch (error) {
    const detail = isReShadeOperationError(error)
      ? `${error.diagnostic.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
    updateState({ phase: 'failed', detail });
    console.error(error);
  }
}

function routeProjectLinkExternally(window: ElectronOverlayWindow): void {
  window.browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === GOVERLAY_PROJECT_URL) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.browserWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url === GOVERLAY_PROJECT_URL) void shell.openExternal(url);
  });
}

function updateState(changes: Partial<DemoState>): void {
  state = Object.freeze({ ...state, ...changes });
  overlayWindow?.browserWindow.webContents.send('demo:state', state);
}

function dispose(): void {
  session.input.release();
  launcher.dispose();
  session.close();
  overlay.dispose();
  ipcMain.removeHandler('demo:get-state');
  ipcMain.removeHandler('demo:set-intercepting');
}

function optionalArgument(name: string): string | undefined {
  const inline = process.argv.find((argument) =>
    argument.startsWith(`${name}=`),
  );
  if (inline) {
    const value = inline.slice(name.length + 1).trim();
    return value || undefined;
  }
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1]?.trim();
  return value && !value.startsWith('--') ? value : undefined;
}

function requiredArgument(name: string): string {
  const value = optionalArgument(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positivePid(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 0xffffffff) {
    throw new Error('--target-pid must be a positive uint32 integer.');
  }
  return parsed;
}
