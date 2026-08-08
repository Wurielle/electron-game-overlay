import * as path from 'node:path';
import { app, ipcMain } from 'electron';
import {
  ElectronGameOverlay,
  isReShadeOperationError,
  parseReShadeLaunchConfig,
  ReShadeOverlayLauncher,
  type ElectronOverlayWindow,
} from 'electron-game-overlay';
import { markDemoSmokeWatcherReady } from '../demo-smoke';
import { observeRenderer } from '../runtime-diagnostics';

type DemoState = Readonly<{
  phase: 'starting' | 'attaching' | 'connected' | 'failed';
  target: string;
  detail: string;
  intercepting: boolean;
}>;
const processName = requiredArgument('--target-process');
const pidArgument = optionalArgument('--target-pid');
const pid = pidArgument ? positivePid(pidArgument) : undefined;
const executablePath = optionalArgument('--target-path');
if (executablePath && !pid) {
  console.warn(
    '--target-path is ignored unless --target-pid is also supplied.',
  );
}
const reshadeConfig = parseReShadeLaunchConfig(process.argv);

if (!reshadeConfig) {
  throw new Error('This demo must be launched with --reshade-overlay.');
}

app.disableHardwareAcceleration();

const overlay = new ElectronGameOverlay();
const session = overlay.createSession();
const launcher = new ReShadeOverlayLauncher(reshadeConfig);
let overlayWindow: ElectronOverlayWindow | null = null;
let disposed = false;
let state: DemoState = {
  phase: 'starting',
  target: pid ? `${processName} (pid ${pid})` : `${processName} (name watcher)`,
  detail: 'Starting the authenticated overlay transport',
  intercepting: false,
};

launcher.onEvent((event) => {
  console.log('[launcher]', event);
  if (event.type === 'injector-watcher-ready') {
    if (!pid) console.log(`Injector watcher ready. Launch ${processName} now.`);
    markDemoSmokeWatcherReady();
  }
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
    if (disposed) return;
    console.error(error);
    process.exitCode = 1;
    app.quit();
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
        backgroundThrottling: false,
      },
    },
  });
  observeRenderer(overlayWindow.browserWindow, 'exact-process-attachment');
  blockRendererNavigation(overlayWindow);
  overlayWindow.show();

  updateState({
    phase: 'attaching',
    detail: 'Transport ready; injecting and waiting for target authentication',
  });
  await Promise.all([session.whenReady(), launcher.prepare()]);
  if (disposed) return;

  try {
    const result = await launcher.attach(session, {
      processName,
      ...(pid ? { pid } : {}),
      ...(pid && executablePath ? { executablePath } : {}),
    });
    if (disposed) return;
    console.log(
      `Demo connected to ${result.processName} (PID ${result.pid}) through ${result.runtimeMode}.`,
    );
    updateState({
      phase: 'connected',
      detail: `Connected through ${result.runtimeMode}`,
    });
  } catch (error) {
    if (disposed) return;
    const detail = isReShadeOperationError(error)
      ? `${error.diagnostic.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
    updateState({ phase: 'failed', detail });
    console.error(error);
  }
}

function blockRendererNavigation(window: ElectronOverlayWindow): void {
  window.browserWindow.webContents.setWindowOpenHandler(() => ({
    action: 'deny',
  }));
  window.browserWindow.webContents.on('will-navigate', (event) =>
    event.preventDefault(),
  );
}

function updateState(changes: Partial<DemoState>): void {
  state = Object.freeze({ ...state, ...changes });
  const browserWindow = overlayWindow?.browserWindow;
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const webContents = browserWindow.webContents;
  if (!webContents.isDestroyed()) {
    webContents.send('demo:state', state);
  }
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  if (state.intercepting) session.input.release();
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
