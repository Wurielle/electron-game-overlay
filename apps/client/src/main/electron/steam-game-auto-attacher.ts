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
    private readonly nativeObserverPath: string,
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
    if (!path.isAbsolute(this.nativeObserverPath)) {
      throw new Error('the native process observer path must be absolute');
    }

    this.stopping = false;
    handlers.onStatus('starting');
    const childEnvironment = { ...process.env };
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    const child = this.forkProcess(this.entryPath, [this.nativeObserverPath], {
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
> &
  Partial<Pick<OverlaySession, 'authorizeTarget'>>;

export type ReShadeLauncherForSteamTarget = Readonly<{
  prepare(): Promise<void>;
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
  preparedLauncherPoolSize?: number;
  preparedLauncherRetryBaseDelayMs?: number;
  preparedLauncherRetryMaxDelayMs?: number;
}>;

type TargetEntry = {
  launcher: ReShadeLauncherForSteamTarget | null;
  state: SteamGameTargetState;
};

const PREPARED_LAUNCHER_POOL_SIZE = 4;
const PREPARED_LAUNCHER_RETRY_BASE_DELAY_MS = 100;
const PREPARED_LAUNCHER_RETRY_MAX_DELAY_MS = 2_000;

export class SteamGameAutoAttacher {
  private readonly launchConfig: ReShadeLaunchConfig;
  private readonly preparedLauncherPoolSize: number;
  private readonly preparedLauncherRetryBaseDelayMs: number;
  private readonly preparedLauncherRetryMaxDelayMs: number;
  private readonly stateHandlers = new Set<
    (state: SteamGameAutoAttachState) => void
  >();
  private readonly targetEntries = new Map<number, TargetEntry>();
  private readonly pendingTargetEntries: TargetEntry[] = [];
  private readonly preparedLaunchers: ReShadeLauncherForSteamTarget[] = [];
  private readonly preparingLaunchers =
    new Set<ReShadeLauncherForSteamTarget>();
  private preparedLauncherRetryTimer: ReturnType<typeof setTimeout> | null =
    null;
  private preparedLauncherFailureCount = 0;
  private watcher: ProcessWatcher | null = null;
  private removeSessionListener: (() => void) | null = null;
  private watcherStatusValue: ProcessWatcherStatus = 'stopped';
  private watcherErrorValue: string | null = null;
  private started = false;
  private disposed = false;

  constructor(private readonly options: SteamGameAutoAttacherOptions) {
    this.launchConfig = stripAutomaticTargeting(options.reshadeConfig);
    this.preparedLauncherPoolSize =
      options.preparedLauncherPoolSize ??
      (options.launcherFactory ? 0 : PREPARED_LAUNCHER_POOL_SIZE);
    this.preparedLauncherRetryBaseDelayMs =
      options.preparedLauncherRetryBaseDelayMs ??
      PREPARED_LAUNCHER_RETRY_BASE_DELAY_MS;
    this.preparedLauncherRetryMaxDelayMs =
      options.preparedLauncherRetryMaxDelayMs ??
      PREPARED_LAUNCHER_RETRY_MAX_DELAY_MS;
    if (
      !Number.isSafeInteger(this.preparedLauncherPoolSize) ||
      this.preparedLauncherPoolSize < 0 ||
      this.preparedLauncherPoolSize > 32
    ) {
      throw new Error(
        'the prepared ReShade launcher pool size must be an integer between 0 and 32',
      );
    }
    if (
      !Number.isSafeInteger(this.preparedLauncherRetryBaseDelayMs) ||
      this.preparedLauncherRetryBaseDelayMs <= 0
    ) {
      throw new Error(
        'the prepared ReShade launcher retry base delay must be a positive integer',
      );
    }
    if (
      !Number.isSafeInteger(this.preparedLauncherRetryMaxDelayMs) ||
      this.preparedLauncherRetryMaxDelayMs <
        this.preparedLauncherRetryBaseDelayMs
    ) {
      throw new Error(
        'the prepared ReShade launcher retry maximum delay must be an integer greater than or equal to its base delay',
      );
    }
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
        if (!isRecord(payload) || !isValidPid(payload.pid)) {
          return;
        }
        const pid = payload.pid;
        if (event === 'game.process') {
          const entry = this.targetEntries.get(pid);
          if (entry) {
            this.connectTarget(
              entry,
              typeof payload.path === 'string' ? payload.path : '',
            );
          }
          return;
        }
        if (event === 'game.process.disconnected') {
          queueMicrotask(() => this.removeTarget(pid));
        }
      },
    );
    this.publishState();

    // Observation must be live before staging starts. Creation events that
    // arrive during prewarming stay queued until a prepared launcher is ready.
    this.startWatcher();
    this.fillPreparedLauncherPool();
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
    if (this.preparedLauncherRetryTimer) {
      clearTimeout(this.preparedLauncherRetryTimer);
      this.preparedLauncherRetryTimer = null;
    }

    for (const entry of this.targetEntries.values()) {
      entry.launcher?.dispose();
    }
    for (const launcher of this.preparedLaunchers) {
      launcher.dispose();
    }
    this.preparedLaunchers.length = 0;
    for (const launcher of this.preparingLaunchers) {
      launcher.dispose();
    }
    this.preparingLaunchers.clear();
    this.pendingTargetEntries.length = 0;
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
    this.observeTarget(event.payload);
  }

  private observeTarget(info: ProcessInfo): void {
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

    const entry: TargetEntry = {
      launcher: null,
      state: Object.freeze({
        pid: info.pid,
        processName,
        filepath: info.filepath,
        phase: 'attaching',
        error: null,
      }),
    };
    this.targetEntries.set(info.pid, entry);
    this.pendingTargetEntries.push(entry);
    console.log(
      `STEAM_GAME_AUTO_ATTACH_DETECTED pid=${info.pid} path=${JSON.stringify(info.filepath)}`,
    );
    this.publishState();
    this.drainPendingTargets();
  }

  private attachTarget(
    entry: TargetEntry,
    launcher: ReShadeLauncherForSteamTarget,
  ): void {
    entry.launcher = launcher;
    const { pid, processName } = entry.state;
    console.log(
      `STEAM_GAME_AUTO_ATTACH_INJECTING pid=${pid} processName=${JSON.stringify(processName)}`,
    );

    void Promise.resolve()
      .then(() => launcher.attach(this.options.session, { processName, pid }))
      .then((result) => {
        if (
          this.disposed ||
          this.targetEntries.get(pid) !== entry ||
          entry.launcher !== launcher
        ) {
          launcher.dispose();
          return;
        }
        this.connectTarget(
          entry,
          result.selectedPath ?? '',
          result.processName,
        );
      })
      .catch((error) => {
        if (
          this.disposed ||
          this.targetEntries.get(pid) !== entry ||
          entry.launcher !== launcher
        ) {
          return;
        }
        if (entry.state.phase === 'connected') {
          return;
        }
        launcher.dispose();
        entry.launcher = null;
        this.failTarget(entry, getErrorMessage(error));
      });
  }

  private createLauncher(): ReShadeLauncherForSteamTarget {
    const launcherFactory =
      this.options.launcherFactory ??
      ((config: ReShadeLaunchConfig) => new ReShadeOverlayLauncher(config));
    return launcherFactory(this.launchConfig);
  }

  private drainPendingTargets(): void {
    if (this.disposed || !this.started) {
      return;
    }
    while (this.pendingTargetEntries.length > 0) {
      const entry = this.pendingTargetEntries[0];
      const { pid } = entry.state;
      if (
        this.targetEntries.get(pid) !== entry ||
        entry.launcher ||
        entry.state.phase !== 'attaching'
      ) {
        this.pendingTargetEntries.shift();
        continue;
      }

      let launcher: ReShadeLauncherForSteamTarget;
      if (this.preparedLauncherPoolSize === 0) {
        try {
          launcher = this.createLauncher();
        } catch (error) {
          this.pendingTargetEntries.shift();
          this.failTarget(entry, getErrorMessage(error));
          continue;
        }
      } else {
        const preparedLauncher = this.preparedLaunchers.shift();
        if (!preparedLauncher) {
          break;
        }
        launcher = preparedLauncher;
      }

      this.pendingTargetEntries.shift();
      this.attachTarget(entry, launcher);
    }
    this.fillPreparedLauncherPool();
  }

  private startWatcher(): void {
    if (this.disposed || !this.started || this.watcher) {
      return;
    }
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

  private fillPreparedLauncherPool(): void {
    if (this.disposed || this.preparedLauncherPoolSize === 0) {
      return;
    }
    const missing =
      this.preparedLauncherPoolSize -
      this.preparedLaunchers.length -
      this.preparingLaunchers.size;
    if (missing <= 0) {
      return;
    }
    for (let index = 0; index < missing; index += 1) {
      void this.prepareLauncher();
    }
  }

  private async prepareLauncher(): Promise<void> {
    let launcher: ReShadeLauncherForSteamTarget;
    try {
      launcher = this.createLauncher();
    } catch (error) {
      if (!this.disposed) {
        console.error(
          `STEAM_GAME_RUNTIME_PREPARE_FAILED detail=${JSON.stringify(getErrorMessage(error))}`,
        );
        this.recordPreparedLauncherFailure();
      }
      return;
    }
    this.preparingLaunchers.add(launcher);
    let prepared = false;
    try {
      await launcher.prepare();
      if (this.disposed) {
        launcher.dispose();
      } else {
        this.preparedLaunchers.push(launcher);
        prepared = true;
      }
    } catch (error) {
      launcher.dispose();
      if (!this.disposed) {
        console.error(
          `STEAM_GAME_RUNTIME_PREPARE_FAILED detail=${JSON.stringify(getErrorMessage(error))}`,
        );
        this.recordPreparedLauncherFailure();
      }
    } finally {
      this.preparingLaunchers.delete(launcher);
      if (prepared && !this.disposed) {
        this.preparedLauncherFailureCount = 0;
        if (this.preparedLauncherRetryTimer) {
          clearTimeout(this.preparedLauncherRetryTimer);
          this.preparedLauncherRetryTimer = null;
        }
        this.drainPendingTargets();
      }
    }
  }

  private recordPreparedLauncherFailure(): void {
    this.preparedLauncherFailureCount += 1;
    this.schedulePreparedLauncherPoolRetry();
  }

  private schedulePreparedLauncherPoolRetry(): void {
    if (
      this.disposed ||
      this.preparedLauncherPoolSize === 0 ||
      this.preparedLauncherRetryTimer
    ) {
      return;
    }
    const exponent = Math.min(
      Math.max(this.preparedLauncherFailureCount - 1, 0),
      30,
    );
    const delayMs = Math.min(
      this.preparedLauncherRetryMaxDelayMs,
      this.preparedLauncherRetryBaseDelayMs * 2 ** exponent,
    );
    this.preparedLauncherRetryTimer = setTimeout(() => {
      this.preparedLauncherRetryTimer = null;
      this.fillPreparedLauncherPool();
    }, delayMs);
    this.preparedLauncherRetryTimer.unref();
  }

  private connectTarget(
    entry: TargetEntry,
    filepath: string,
    reportedProcessName = '',
  ): void {
    const { pid } = entry.state;
    if (this.disposed || this.targetEntries.get(pid) !== entry) {
      return;
    }
    const wasConnected = entry.state.phase === 'connected';
    const processName =
      reportedProcessName ||
      (filepath ? path.win32.basename(filepath) : '') ||
      entry.state.processName;
    entry.state = Object.freeze({
      ...entry.state,
      processName,
      filepath: filepath || entry.state.filepath,
      phase: 'connected',
      error: null,
    });
    if (!wasConnected) {
      console.log(
        `STEAM_GAME_AUTO_ATTACH_CONNECTED pid=${pid} processName=${JSON.stringify(processName)}`,
      );
    }
    this.publishState();
  }

  private failTarget(entry: TargetEntry, error: string): void {
    const { pid } = entry.state;
    if (this.disposed || this.targetEntries.get(pid) !== entry) {
      return;
    }
    entry.state = Object.freeze({
      ...entry.state,
      phase: 'failed',
      error,
    });
    console.error(
      `STEAM_GAME_AUTO_ATTACH_FAILED pid=${pid} detail=${JSON.stringify(error)}`,
    );
    this.publishState();
  }

  private removeTarget(pid: number): void {
    const entry = this.targetEntries.get(pid);
    if (!entry) {
      return;
    }
    this.targetEntries.delete(pid);
    const pendingIndex = this.pendingTargetEntries.indexOf(entry);
    if (pendingIndex >= 0) {
      this.pendingTargetEntries.splice(pendingIndex, 1);
    }
    entry.launcher?.dispose();
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
