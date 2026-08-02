import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { app, ipcMain, shell } from 'electron';
import {
  ElectronGameOverlay,
  isReShadeOperationError,
  parseReShadeLaunchConfig,
  ReShadeOverlayLauncher,
  type ElectronOverlayWindow,
  type ReShadeLaunchConfig,
} from 'electron-game-overlay';

type TargetPhase = 'attaching' | 'connected' | 'failed';
type TargetState = Readonly<{
  pid: number;
  processName: string;
  executablePath: string;
  phase: TargetPhase;
  detail: string;
}>;
type LiveTarget = {
  state: TargetState;
  launcher: ReShadeOverlayLauncher;
};
type WatcherMessage =
  | { type: 'ready' }
  | { type: 'creation' | 'deletion'; values: unknown[] }
  | { type: 'error'; detail: string };
const GOVERLAY_PROJECT_URL = 'https://github.com/hiitiger/goverlay';

const parsedConfig = parseReShadeLaunchConfig(process.argv);
if (!parsedConfig) {
  throw new Error('This demo must be launched with --reshade-overlay.');
}
const reshadeConfig = withoutAutomaticTarget(parsedConfig);

app.disableHardwareAcceleration();

const overlay = new ElectronGameOverlay();
const session = overlay.createSession();
const liveTargets = new Map<number, LiveTarget>();
let overlayWindow: ElectronOverlayWindow | null = null;
let watcher: ChildProcess | null = null;
let watcherStatus = 'starting';

session.on('diagnostic', (diagnostic) => console.log('[session]', diagnostic));
ipcMain.handle('demo:get-state', () => snapshot());
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
    id: 'steam-auto-attach-status',
    name: 'Steam auto-attach status',
    file: path.join(__dirname, '..', 'renderer', 'index.html'),
    bounds: { x: 36, y: 36, width: 540, height: 430 },
    transparent: true,
    dragBorder: 12,
    captionHeight: 48,
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
  await session.whenReady();
  startProcessWatcher();
  publishState();
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

function startProcessWatcher(): void {
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  watcher = spawn(
    process.execPath,
    ['--input-type=module', '--eval', PROCESS_WATCHER_SOURCE],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );
  watcher.stdout?.on('data', (data) =>
    console.log(`[watcher] ${String(data).trimEnd()}`),
  );
  watcher.stderr?.on('data', (data) =>
    console.error(`[watcher] ${String(data).trimEnd()}`),
  );
  watcher.on('message', (message) => handleWatcherMessage(message));
  watcher.on('error', (error) => {
    watcherStatus = `failed: ${error.message}`;
    publishState();
  });
  watcher.on('exit', (code) => {
    if (watcher) {
      watcherStatus = `stopped (exit ${code ?? 'unknown'})`;
      watcher = null;
      publishState();
    }
  });
}

function handleWatcherMessage(message: unknown): void {
  if (!isWatcherMessage(message)) return;
  if (message.type === 'ready') {
    watcherStatus = 'watching creation and deletion events';
    publishState();
    return;
  }
  if (message.type === 'error') {
    watcherStatus = `failed: ${message.detail}`;
    publishState();
    return;
  }

  const [, rawPid, rawPath] = message.values;
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return;
  if (message.type === 'deletion') {
    releaseTarget(pid);
    return;
  }

  const executablePath = typeof rawPath === 'string' ? rawPath : '';
  const normalizedPath = path.win32.normalize(executablePath).toLowerCase();
  if (
    !normalizedPath.includes('\\steamapps\\') ||
    !normalizedPath.endsWith('.exe')
  ) {
    console.log(`Ignored pid=${pid}: path does not match **/steamapps/**.exe`);
    return;
  }
  attachTarget(pid, path.win32.basename(executablePath), executablePath);
}

function attachTarget(
  pid: number,
  processName: string,
  executablePath: string,
): void {
  // A PID is the only deduplication key. Every distinct live Steam executable
  // receives an independent launcher and attachment attempt.
  if (liveTargets.has(pid)) return;

  const launcher = new ReShadeOverlayLauncher(reshadeConfig);
  const target: LiveTarget = {
    launcher,
    state: Object.freeze({
      pid,
      processName,
      executablePath,
      phase: 'attaching',
      detail: 'Waiting for target authentication',
    }),
  };
  liveTargets.set(pid, target);
  launcher.onEvent((event) => console.log(`[pid ${pid}]`, event));
  publishState();

  void launcher
    .attach(session, { processName, pid, executablePath })
    .then((result) => {
      if (liveTargets.get(pid) !== target) return;
      target.state = Object.freeze({
        ...target.state,
        phase: 'connected',
        detail: `Connected through ${result.runtimeMode}`,
      });
      publishState();
    })
    .catch((error) => {
      if (liveTargets.get(pid) !== target) return;
      const detail = isReShadeOperationError(error)
        ? `${error.diagnostic.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      target.state = Object.freeze({
        ...target.state,
        phase: 'failed',
        detail,
      });
      console.error(`[pid ${pid}]`, error);
      publishState();
    });
}

function releaseTarget(pid: number): void {
  const target = liveTargets.get(pid);
  if (!target) return;
  target.launcher.confirmTargetExited(pid);
  target.launcher.dispose();
  liveTargets.delete(pid);
  console.log(`Released pid=${pid}`);
  publishState();
}

function publishState(): void {
  overlayWindow?.browserWindow.webContents.send('demo:state', snapshot());
}

function snapshot(): Readonly<{
  watcherStatus: string;
  targets: readonly TargetState[];
}> {
  return Object.freeze({
    watcherStatus,
    targets: Object.freeze(
      Array.from(liveTargets.values(), ({ state }) => state).sort(
        (left, right) => left.pid - right.pid,
      ),
    ),
  });
}

function dispose(): void {
  const child = watcher;
  watcher = null;
  if (child?.connected) child.send({ type: 'shutdown' });
  const forceStop = setTimeout(() => child?.kill(), 1_500);
  forceStop.unref();
  for (const pid of Array.from(liveTargets.keys())) releaseTarget(pid);
  session.close();
  overlay.dispose();
  ipcMain.removeHandler('demo:get-state');
}

function withoutAutomaticTarget(
  config: ReShadeLaunchConfig,
): ReShadeLaunchConfig {
  const {
    autoTargetProcess: _process,
    expectedTargetPid: _pid,
    ...base
  } = config;
  void _process;
  void _pid;
  return Object.freeze(base);
}

function isWatcherMessage(value: unknown): value is WatcherMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  if (type === 'ready') return true;
  if (type === 'error')
    return typeof (value as { detail?: unknown }).detail === 'string';
  return (
    (type === 'creation' || type === 'deletion') &&
    Array.isArray((value as { values?: unknown }).values)
  );
}

const PROCESS_WATCHER_SOURCE = String.raw`
  import { closeEventSink, subscribe } from 'wql-process-monitor';

  const monitor = await subscribe({ creation: true, deletion: true });
  monitor.on('creation', (values) => process.send?.({ type: 'creation', values }));
  monitor.on('deletion', (values) => process.send?.({ type: 'deletion', values }));
  process.send?.({ type: 'ready' });

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try { await closeEventSink(); } finally { process.exit(0); }
  }
  process.on('message', (message) => {
    if (message?.type === 'shutdown') void close();
  });
  process.on('disconnect', () => void close());
  process.on('uncaughtException', (error) => {
    process.send?.({ type: 'error', detail: error?.stack ?? String(error) });
  });
  process.on('unhandledRejection', (error) => {
    process.send?.({ type: 'error', detail: error?.stack ?? String(error) });
  });
`;
