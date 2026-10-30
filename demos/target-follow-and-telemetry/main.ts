import * as path from 'node:path';
import { app, ipcMain } from 'electron';
import {
  ElectronGameOverlay,
  isReShadeOperationError,
  parseReShadeLaunchConfig,
  ReShadeOverlayLauncher,
  type ElectronOverlayWindow,
  type OverlayTargetFollowArea,
  type OverlayTargetSurface,
} from 'electron-game-overlay';
import { markDemoSmokeWatcherReady } from '../demo-smoke';
import { observeRenderer } from '../runtime-diagnostics';

type FollowMode = OverlayTargetFollowArea | 'stopped';
type DemoState = {
  phase: 'starting' | 'attaching' | 'connected' | 'failed';
  target: string;
  detail: string;
  followMode: FollowMode;
  fps: number | null;
  surface: OverlayTargetSurface | null;
  events: string[];
};
const processName = requiredArgument('--target-process');
const pidArgument = optionalArgument('--target-pid');
let targetPid = pidArgument ? positivePid(pidArgument) : null;
const executablePath = optionalArgument('--target-path');
if (executablePath && !targetPid) {
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
  target: targetPid
    ? `${processName} (pid ${targetPid})`
    : `${processName} (name watcher)`,
  detail: 'Starting the authenticated overlay transport',
  followMode: targetPid ? 'render' : 'stopped',
  fps: null,
  surface: null,
  events: [],
};

launcher.onEvent((event) => {
  recordEvent(`launcher: ${event.type}`);
  if (event.type === 'injector-watcher-ready') {
    if (!targetPid) {
      console.log(`Injector watcher ready. Launch ${processName} now.`);
    }
    markDemoSmokeWatcherReady();
  }
});
session.on('fps', (sample) => {
  if (sample.pid === targetPid) updateState({ fps: sample.fps });
});
session.on('targetSurfaceChanged', (surface) => {
  if (surface.pid === targetPid) {
    updateState({ surface });
    recordEvent(
      `surface revision ${surface.revision} (${surface.graphicsApi})`,
    );
  }
});
session.on('targetSurfaceRemoved', (removed) => {
  if (removed.pid === targetPid) {
    updateState({ surface: null });
    recordEvent(`surface ${removed.surfaceId} removed`);
  }
});
session.on('windowFocused', ({ windowId }) =>
  recordEvent(
    windowId === 0
      ? 'overlay focus cleared'
      : `overlay window ${windowId} focused`,
  ),
);
session.on('diagnostic', (diagnostic) =>
  recordEvent(`${diagnostic.source}: ${diagnostic.code}`),
);

ipcMain.handle('demo:get-state', () => snapshot());
ipcMain.handle('demo:set-follow-mode', (_event, value: unknown) => {
  if (!overlayWindow || !targetPid) return snapshot();
  if (value === 'stopped') {
    overlayWindow.stopFollowingTarget();
    updateState({ followMode: 'stopped' });
  } else if (value === 'render' || value === 'client') {
    overlayWindow.followTarget({ pid: targetPid, area: value });
    updateState({ followMode: value });
  }
  return snapshot();
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
    id: 'target-follow',
    name: 'Target follow and telemetry',
    file: path.join(__dirname, '..', 'renderer', 'index.html'),
    bounds: { x: 0, y: 0, width: 960, height: 540 },
    focusOnReady: true,
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
  observeRenderer(overlayWindow.browserWindow, 'target-follow-and-telemetry');
  blockRendererNavigation(overlayWindow);
  if (targetPid) {
    overlayWindow.followTarget({ pid: targetPid, area: 'render' });
  }
  overlayWindow.show();

  updateState({
    phase: 'attaching',
    detail: 'Injecting and waiting for the exact target to authenticate',
  });
  await Promise.all([session.whenReady(), launcher.prepare()]);
  if (disposed) return;

  try {
    const result = await launcher.attach(session, {
      processName,
      ...(targetPid ? { pid: targetPid } : {}),
      ...(targetPid && executablePath ? { executablePath } : {}),
    });
    if (disposed) return;
    console.log(
      `Demo connected to ${result.processName} (PID ${result.pid}) through ${result.runtimeMode}.`,
    );
    targetPid = result.pid;
    overlayWindow.followTarget({ pid: targetPid, area: 'render' });
    const surface = session.targets.list().find(({ pid }) => pid === targetPid);
    updateState({
      phase: 'connected',
      target: `${processName} (pid ${targetPid})`,
      detail: `Connected through ${result.runtimeMode}; following render bounds`,
      followMode: 'render',
      surface: surface ?? null,
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

function recordEvent(message: string): void {
  console.log(message);
  updateState({ events: [message, ...state.events].slice(0, 7) });
}

function updateState(changes: Partial<DemoState>): void {
  state = { ...state, ...changes };
  const browserWindow = overlayWindow?.browserWindow;
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const webContents = browserWindow.webContents;
  if (!webContents.isDestroyed()) {
    webContents.send('demo:state', snapshot());
  }
}

function snapshot(): DemoState {
  return { ...state, events: [...state.events] };
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  launcher.dispose();
  session.close();
  overlay.dispose();
  ipcMain.removeHandler('demo:get-state');
  ipcMain.removeHandler('demo:set-follow-mode');
}

function optionalArgument(name: string): string | undefined {
  const inline = process.argv.find((argument) =>
    argument.startsWith(`${name}=`),
  );
  if (inline) return inline.slice(name.length + 1).trim() || undefined;
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1]?.trim();
  return value && !value.startsWith('--') ? value : undefined;
}

function requiredArgument(name: string): string {
  const value = optionalArgument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positivePid(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 0xffffffff) {
    throw new Error('--target-pid must be a positive uint32 integer.');
  }
  return parsed;
}
