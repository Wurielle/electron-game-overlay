import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import {
  ReShadeOverlayLauncher,
  type OverlaySession,
  type ReShadeAttachResult,
  type ReShadeAttachmentState,
  type ReShadeLaunchConfig,
  type ReShadeTarget,
} from 'electron-game-overlay';

export const STEAM_APPS_PROCESS_PATTERN = '**/steamapps/**';

export type ProcessInfo = Readonly<{
  process: string;
  pid: number;
  filepath: string;
  user: string;
}>;

export type ProcessWatcherEvent = Readonly<{
  type: 'process-creation' | 'process-deletion';
  payload: ProcessInfo;
}>;

export type ProcessWatcherStatus =
  | 'starting'
  | 'running'
  | 'failed'
  | 'stopped';

export type ProcessWatcherHandlers = Readonly<{
  onEvent: (event: ProcessWatcherEvent) => void;
  onStatus: (status: ProcessWatcherStatus, error?: string) => void;
}>;

export interface ProcessWatcher {
  start(handlers: ProcessWatcherHandlers): void;
  stop(): Promise<void>;
}

type ForkProcess = typeof fork;

export class ForkedProcessWatcher implements ProcessWatcher {
  private child: ChildProcess | null = null;
  private stopping = false;

  constructor(
    private readonly entryPath: string,
    private readonly forkProcess: ForkProcess = fork,
    private readonly nodeExecutable?: string,
  ) {}

  public start(handlers: ProcessWatcherHandlers): void {
    if (this.child) {
      throw new Error('the process watcher is already running');
    }
    if (!path.isAbsolute(this.entryPath)) {
      throw new Error('the process watcher entry path must be absolute');
    }

    this.stopping = false;
    handlers.onStatus('starting');
    const childEnvironment = { ...process.env };
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    const child = this.forkProcess(this.entryPath, [], {
      env: childEnvironment,
      execPath: resolveNodeExecutable(this.nodeExecutable),
      serialization: 'json',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    let reportedFailure: string | null = null;

    const reportFailure = (error: string) => {
      if (reportedFailure !== null) {
        return;
      }
      reportedFailure = error;
      handlers.onStatus('failed', error);
    };

    child.stdout?.on('data', (data) => {
      console.log(`[process-watcher] ${String(data).trimEnd()}`);
    });
    child.stderr?.on('data', (data) => {
      console.error(`[process-watcher] ${String(data).trimEnd()}`);
    });
    child.on('message', (message) => {
      if (this.child !== child || this.stopping) {
        return;
      }
      if (isProcessWatcherEvent(message)) {
        handlers.onEvent(message);
        return;
      }
      if (isRecord(message) && message.type === 'process-watcher-ready') {
        handlers.onStatus('running');
        return;
      }
      if (
        isRecord(message) &&
        message.type === 'process-watcher-error' &&
        typeof message.error === 'string'
      ) {
        reportFailure(message.error);
      }
    });
    child.on('error', (error) => {
      if (this.child === child && !this.stopping) {
        reportFailure(getErrorMessage(error));
      }
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (!this.stopping && reportedFailure === null) {
        reportFailure(
          `process watcher exited unexpectedly (code=${code ?? 'none'}, signal=${signal ?? 'none'})`,
        );
      }
    });
  }

  public stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.stopping = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(forceKillTimer);
        resolve();
      };
      child.once('exit', finish);
      const forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
        finish();
      }, 2_500);
      forceKillTimer.unref();

      if (child.connected) {
        child.disconnect();
      } else {
        child.kill();
      }
    });
  }
}

export function resolveNodeExecutable(
  explicitNodeExecutable?: string,
  environment: NodeJS.ProcessEnv = process.env,
  currentExecutable: string = process.execPath,
): string {
  const explicit = normalizeExecutableCandidate(explicitNodeExecutable);
  if (explicit) {
    return explicit;
  }

  const npmNodeExecutable = normalizeExecutableCandidate(
    environment.npm_node_execpath,
  );
  if (
    npmNodeExecutable &&
    !path.win32.basename(npmNodeExecutable).toLowerCase().includes('electron')
  ) {
    return npmNodeExecutable;
  }

  if (/^node(?:\.exe)?$/i.test(path.win32.basename(currentExecutable))) {
    return currentExecutable;
  }

  // Development normally inherits npm_node_execpath. A directly launched
  // demo can still resolve the real Node runtime through PATH.
  return 'node';
}

export type SteamGameTargetPhase = 'attaching' | 'connected' | 'failed';

export type SteamGameTargetState = Readonly<{
  pid: number;
  processName: string;
  filepath: string;
  phase: SteamGameTargetPhase;
  error: string | null;
}>;

export type SteamGameAutoAttachState = Readonly<{
  enabled: true;
  pattern: typeof STEAM_APPS_PROCESS_PATTERN;
  watcherStatus: ProcessWatcherStatus;
  watcherError: string | null;
  targets: readonly SteamGameTargetState[];
}>;

type OverlaySessionForAttachment = Pick<
  OverlaySession,
  'on' | 'onClose' | 'whenReady'
>;

export type ReShadeLauncherForSteamTarget = Readonly<{
  attach(
    session: OverlaySessionForAttachment,
    target: ReShadeTarget,
  ): Promise<ReShadeAttachResult>;
  dispose(): void;
  readonly state: ReShadeAttachmentState;
}>;

export type ProcessWatcherFactory = () => ProcessWatcher;
export type ReShadeLauncherFactory = (
  config: ReShadeLaunchConfig,
) => ReShadeLauncherForSteamTarget;

type SteamGameAutoAttacherOptions = Readonly<{
  session: OverlaySessionForAttachment;
  reshadeConfig: ReShadeLaunchConfig;
  watcherFactory: ProcessWatcherFactory;
  launcherFactory?: ReShadeLauncherFactory;
}>;

type TargetEntry = {
  launcher: ReShadeLauncherForSteamTarget;
  state: SteamGameTargetState;
};

export class SteamGameAutoAttacher {
  private readonly launchConfig: ReShadeLaunchConfig;
  private readonly stateHandlers = new Set<
    (state: SteamGameAutoAttachState) => void
  >();
  private readonly targetEntries = new Map<number, TargetEntry>();
  private watcher: ProcessWatcher | null = null;
  private removeSessionListener: (() => void) | null = null;
  private watcherStatusValue: ProcessWatcherStatus = 'stopped';
  private watcherErrorValue: string | null = null;
  private started = false;
  private disposed = false;

  constructor(private readonly options: SteamGameAutoAttacherOptions) {
    this.launchConfig = stripAutomaticTargeting(options.reshadeConfig);
  }

  public get state(): SteamGameAutoAttachState {
    return Object.freeze({
      enabled: true,
      pattern: STEAM_APPS_PROCESS_PATTERN,
      watcherStatus: this.watcherStatusValue,
      watcherError: this.watcherErrorValue,
      targets: Object.freeze(
        Array.from(this.targetEntries.values(), ({ state }) =>
          Object.freeze({ ...state }),
        ).sort((left, right) => left.pid - right.pid),
      ),
    });
  }

  public get watcherStatus(): ProcessWatcherStatus {
    return this.watcherStatusValue;
  }

  public get watcherError(): string | null {
    return this.watcherErrorValue;
  }

  public get targets(): readonly SteamGameTargetState[] {
    return this.state.targets;
  }

  public onStateChange(
    handler: (state: SteamGameAutoAttachState) => void,
  ): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  public start(): void {
    if (this.disposed) {
      throw new Error('the Steam game auto-attacher is disposed');
    }
    if (this.started) {
      return;
    }
    this.started = true;
    this.watcherStatusValue = 'starting';
    this.watcherErrorValue = null;
    this.removeSessionListener = this.options.session.on(
      'nativeEvent',
      ({ event, payload }) => {
        if (
          event === 'game.process.disconnected' &&
          isRecord(payload) &&
          isValidPid(payload.pid)
        ) {
          const pid = payload.pid;
          queueMicrotask(() => this.removeTarget(pid));
        }
      },
    );
    this.publishState();

    try {
      const watcher = this.options.watcherFactory();
      this.watcher = watcher;
      watcher.start({
        onEvent: (event) => this.handleProcessEvent(event),
        onStatus: (status, error) => this.handleWatcherStatus(status, error),
      });
    } catch (error) {
      this.handleWatcherStatus('failed', getErrorMessage(error));
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.started = false;
    this.removeSessionListener?.();
    this.removeSessionListener = null;

    const watcher = this.watcher;
    this.watcher = null;
    const watcherStop = watcher?.stop() ?? Promise.resolve();

    for (const entry of this.targetEntries.values()) {
      entry.launcher.dispose();
    }
    this.targetEntries.clear();
    this.watcherStatusValue = 'stopped';
    this.watcherErrorValue = null;
    this.publishState();
    this.stateHandlers.clear();
    await watcherStop;
  }

  private handleProcessEvent(event: ProcessWatcherEvent): void {
    if (this.disposed || !this.started) {
      return;
    }
    if (event.type === 'process-deletion') {
      this.removeTarget(event.payload.pid);
      return;
    }
    this.attachTarget(event.payload);
  }

  private attachTarget(info: ProcessInfo): void {
    if (
      !isValidPid(info.pid) ||
      this.targetEntries.has(info.pid) ||
      !isSteamAppsProcessPath(info.filepath)
    ) {
      return;
    }
    const processName = path.win32.basename(info.filepath);
    if (!processName.toLowerCase().endsWith('.exe')) {
      return;
    }

    const launcherFactory =
      this.options.launcherFactory ??
      ((config: ReShadeLaunchConfig) => new ReShadeOverlayLauncher(config));
    const launcher = launcherFactory(this.launchConfig);
    const entry: TargetEntry = {
      launcher,
      state: Object.freeze({
        pid: info.pid,
        processName,
        filepath: info.filepath,
        phase: 'attaching',
        error: null,
      }),
    };
    this.targetEntries.set(info.pid, entry);
    console.log(
      `STEAM_GAME_AUTO_ATTACH_DETECTED pid=${info.pid} path=${JSON.stringify(info.filepath)}`,
    );
    this.publishState();

    void Promise.resolve()
      .then(() =>
        launcher.attach(this.options.session, {
          processName,
          pid: info.pid,
        }),
      )
      .then((result) => {
        if (this.targetEntries.get(info.pid) !== entry || this.disposed) {
          return;
        }
        entry.state = Object.freeze({
          ...entry.state,
          pid: result.pid,
          phase: 'connected',
          error: null,
        });
        console.log(
          `STEAM_GAME_AUTO_ATTACH_CONNECTED pid=${result.pid} processName=${JSON.stringify(processName)}`,
        );
        this.publishState();
      })
      .catch((error) => {
        if (this.targetEntries.get(info.pid) !== entry || this.disposed) {
          return;
        }
        const message = getErrorMessage(error);
        entry.state = Object.freeze({
          ...entry.state,
          phase: 'failed',
          error: message,
        });
        console.error(
          `STEAM_GAME_AUTO_ATTACH_FAILED pid=${info.pid} processName=${JSON.stringify(processName)} detail=${JSON.stringify(message)}`,
        );
        // Keep the PID registered until deletion. Even a definitely-safe
        // injector failure should not become a hot retry loop for a live game.
        this.publishState();
      });
  }

  private removeTarget(pid: number): void {
    const entry = this.targetEntries.get(pid);
    if (!entry) {
      return;
    }
    this.targetEntries.delete(pid);
    entry.launcher.dispose();
    console.log(`STEAM_GAME_AUTO_ATTACH_RELEASED pid=${pid}`);
    this.publishState();
  }

  private handleWatcherStatus(
    status: ProcessWatcherStatus,
    error?: string,
  ): void {
    if (this.disposed) {
      return;
    }
    this.watcherStatusValue = status;
    this.watcherErrorValue =
      status === 'failed' ? error || 'unknown error' : null;
    if (status === 'failed') {
      console.error(
        `STEAM_GAME_PROCESS_WATCHER_FAILED detail=${JSON.stringify(this.watcherErrorValue)}`,
      );
    } else if (status === 'running') {
      console.log(
        `STEAM_GAME_PROCESS_WATCHER_READY pattern=${JSON.stringify(STEAM_APPS_PROCESS_PATTERN)}`,
      );
    }
    this.publishState();
  }

  private publishState(): void {
    const state = this.state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }
}

export function isSteamAppsProcessPath(filepath: unknown): boolean {
  if (typeof filepath !== 'string' || filepath.length === 0) {
    return false;
  }
  const normalized = filepath.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/steamapps/');
}

export function stripAutomaticTargeting(
  config: ReShadeLaunchConfig,
): ReShadeLaunchConfig {
  const {
    autoTargetProcess: ignoredAutoTargetProcess,
    expectedTargetPid: ignoredExpectedTargetPid,
    ...baseConfig
  } = config;
  void ignoredAutoTargetProcess;
  void ignoredExpectedTargetPid;
  return Object.freeze(baseConfig);
}

function isProcessWatcherEvent(value: unknown): value is ProcessWatcherEvent {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type !== 'process-creation' && value.type !== 'process-deletion') {
    return false;
  }
  const payload = value.payload;
  return (
    isRecord(payload) &&
    typeof payload.process === 'string' &&
    isValidPid(payload.pid) &&
    typeof payload.filepath === 'string' &&
    typeof payload.user === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isValidPid(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 0xffffffff
  );
}

function normalizeExecutableCandidate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const candidate = value.trim();
  return candidate.length > 0 ? candidate : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
