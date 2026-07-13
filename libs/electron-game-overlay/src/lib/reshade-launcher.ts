import { execFile, type ChildProcess } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { OverlaySession } from './overlay-session.js';

const RESHADE_OPT_IN_FLAG = '--reshade-overlay';
const RESHADE_RUNTIME_DIRECTORY_OPTION = '--reshade-runtime-dir';
const RESHADE_AUTO_TARGET_PROCESS_OPTION = '--reshade-auto-target-process';
const RESHADE_EXPECTED_TARGET_PID_OPTION = '--reshade-expected-target-pid';
const INJECTOR_FILE_NAME = 'inject.exe';
const RUNTIME_FILE_NAME = 'ReShade64.dll';
const BUILD_STAMP_FILE_NAME = 'ReShade64.build.json';
const ADDON_FILE_NAME = 'electron_reshade_overlay_poc.addon64';
const CONFIG_FILE_NAME = 'ReShade.ini';
const INJECTOR_STDOUT_FILE_NAME = 'inject.stdout.log';
const INJECTOR_STDERR_FILE_NAME = 'inject.stderr.log';
const RESHADE_LOG_FILE_NAME = 'ReShade.log';
const INJECTOR_SUCCESS_MARKER = 'Injecting ReShade ... Succeeded!';
const INJECTOR_NOT_STARTED_MARKER = 'ReShade injection not started.';
const INJECTOR_TARGET_PID_PATTERN =
  /^Found a matching process with PID ([1-9][0-9]*)!/m;
const REQUEST_TIMEOUT_MS = 120_000;
const TARGET_PROOF_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export const RESHADE_CLIENT_RUNTIME_STAGED_MARKER =
  'RESHADE_CLIENT_RUNTIME_STAGED';
export const RESHADE_CLIENT_INJECTOR_STARTED_MARKER =
  'RESHADE_CLIENT_INJECTOR_STARTED';
export const RESHADE_CLIENT_INJECTOR_RETURNED_MARKER =
  'RESHADE_CLIENT_INJECTOR_RETURNED';
export const RESHADE_CLIENT_INJECTOR_FAILED_MARKER =
  'RESHADE_CLIENT_INJECTOR_FAILED';
export const RESHADE_CLIENT_TARGET_CONNECTED_MARKER =
  'RESHADE_CLIENT_TARGET_CONNECTED';
export const RESHADE_CLIENT_TARGET_DISCONNECTED_MARKER =
  'RESHADE_CLIENT_TARGET_DISCONNECTED';

const RUNTIME_ARTIFACTS = Object.freeze([
  INJECTOR_FILE_NAME,
  RUNTIME_FILE_NAME,
  BUILD_STAMP_FILE_NAME,
  ADDON_FILE_NAME,
  CONFIG_FILE_NAME,
] as const);

export type ReShadeTarget = Readonly<{
  processName: string;
  pid?: number;
}>;

export type ReShadeLaunchConfig = Readonly<{
  runtimeDirectory: string;
  runsRootDirectory: string;
  injectorPath: string;
  runtimePath: string;
  buildStampPath: string;
  addonPath: string;
  configPath: string;
  autoTargetProcess?: string;
  expectedTargetPid?: number;
}>;

export type ReShadeLaunchConfigOptions = Readonly<{
  bundledRuntimeDirectory?: string;
  runsRootDirectory?: string;
}>;

export type ReShadeInvocation = Readonly<{
  executable: string;
  arguments:
    | readonly [processName: string]
    | readonly [processName: string, pidOption: '--pid', pid: string];
  targetLabel: string;
  workingDirectory: string;
}>;

export type ReShadeLaunchResult = Readonly<{
  processName: string;
  targetLabel: string;
  injectorTargetPid: number;
  runDirectory: string;
  injectorStdoutPath: string;
  injectorStderrPath: string;
  reshadeLogPath: string;
}>;

export type ReShadeAttachResult = ReShadeLaunchResult &
  Readonly<{
    pid: number;
  }>;

type StagedRuntime = Readonly<{
  runDirectory: string;
  injectorPath: string;
  injectorStdoutPath: string;
  injectorStderrPath: string;
  reshadeLogPath: string;
}>;

export type ReShadeAttachmentState =
  | 'idle'
  | 'attaching'
  | 'connected'
  | 'blocked';

type ReShadeRetrySafety = 'definite-safe' | 'indeterminate';

class ReShadeOperationError extends Error {
  constructor(
    message: string,
    public readonly retrySafety: ReShadeRetrySafety,
  ) {
    super(message);
    this.name = 'ReShadeOperationError';
  }
}

type ReShadeTargetConnection = Readonly<{
  pid: number;
  path: string;
}>;

type ConnectedTarget = ReShadeTargetConnection &
  Readonly<{
    targetLabel: string;
    removeListeners: () => void;
  }>;

/** Returns the patched ReShade runtime directory staged by the SDK build. */
export function defaultReShadeRuntimeDirectory(): string {
  return path.resolve(__dirname, '..', 'runtime', 'win32-x64', 'reshade');
}

/** Returns the writable root used for preserved per-attachment runtime copies. */
export function defaultReShadeRunsRootDirectory(): string {
  return path.join(tmpdir(), 'electron-game-overlay', 'reshade-runs');
}

export function parseReShadeLaunchConfig(
  argv: readonly string[],
  options: ReShadeLaunchConfigOptions = {},
): ReShadeLaunchConfig | null {
  const optInCount = argv.filter(
    (argument) => argument === RESHADE_OPT_IN_FLAG,
  ).length;
  if (optInCount === 0) {
    return null;
  }
  if (optInCount !== 1) {
    throw new Error(`${RESHADE_OPT_IN_FLAG} must be provided exactly once`);
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('the ReShade overlay runtime requires Windows x64');
  }

  const runtimeDirectoryOverride = readOptionalOption(
    argv,
    RESHADE_RUNTIME_DIRECTORY_OPTION,
  );
  const requestedRuntimeDirectory =
    runtimeDirectoryOverride ??
    options.bundledRuntimeDirectory ??
    defaultReShadeRuntimeDirectory();
  if (!path.isAbsolute(requestedRuntimeDirectory)) {
    throw new Error(
      runtimeDirectoryOverride === undefined
        ? 'the SDK ReShade runtime directory must be absolute'
        : `${RESHADE_RUNTIME_DIRECTORY_OPTION} must be absolute`,
    );
  }

  const requestedRunsRoot =
    options.runsRootDirectory ?? defaultReShadeRunsRootDirectory();
  if (!path.isAbsolute(requestedRunsRoot)) {
    throw new Error('the ReShade runs root directory must be absolute');
  }

  const runtimeDirectory = canonicalDirectory(requestedRuntimeDirectory);
  const injectorPath = canonicalArtifact(
    runtimeDirectory,
    INJECTOR_FILE_NAME,
    'ReShade injector',
  );
  const runtimePath = canonicalArtifact(
    runtimeDirectory,
    RUNTIME_FILE_NAME,
    'ReShade runtime',
  );
  const buildStampPath = canonicalArtifact(
    runtimeDirectory,
    BUILD_STAMP_FILE_NAME,
    'ReShade runtime build stamp',
  );
  const addonPath = canonicalArtifact(
    runtimeDirectory,
    ADDON_FILE_NAME,
    'Electron ReShade add-on',
  );
  const configPath = canonicalArtifact(
    runtimeDirectory,
    CONFIG_FILE_NAME,
    'ReShade configuration',
  );

  const autoTargetProcess = readOptionalOption(
    argv,
    RESHADE_AUTO_TARGET_PROCESS_OPTION,
  );
  if (autoTargetProcess !== undefined) {
    validateProcessName(autoTargetProcess);
  }

  const expectedTargetPidValue = readOptionalOption(
    argv,
    RESHADE_EXPECTED_TARGET_PID_OPTION,
  );
  let expectedTargetPid: number | undefined;
  if (expectedTargetPidValue !== undefined) {
    if (autoTargetProcess === undefined) {
      throw new Error(
        `${RESHADE_EXPECTED_TARGET_PID_OPTION} requires ${RESHADE_AUTO_TARGET_PROCESS_OPTION}`,
      );
    }
    expectedTargetPid = Number(expectedTargetPidValue);
    if (!isValidProcessPid(expectedTargetPid)) {
      throw new Error(
        `${RESHADE_EXPECTED_TARGET_PID_OPTION} must be a positive uint32 integer`,
      );
    }
  }

  return Object.freeze({
    runtimeDirectory,
    runsRootDirectory: path.resolve(requestedRunsRoot),
    injectorPath,
    runtimePath,
    buildStampPath,
    addonPath,
    configPath,
    ...(autoTargetProcess === undefined ? {} : { autoTargetProcess }),
    ...(expectedTargetPid === undefined ? {} : { expectedTargetPid }),
  });
}

export function buildReShadeInvocation(
  target: ReShadeTarget,
  runDirectory: string,
): ReShadeInvocation {
  validateTarget(target);
  if (!path.isAbsolute(runDirectory)) {
    throw new Error('the ReShade run directory must be absolute');
  }

  const arguments_ =
    target.pid === undefined
      ? ([target.processName] as const)
      : ([target.processName, '--pid', String(target.pid)] as const);

  return Object.freeze({
    executable: path.join(runDirectory, INJECTOR_FILE_NAME),
    arguments: Object.freeze(arguments_),
    targetLabel: targetLabelFor(target),
    workingDirectory: runDirectory,
  });
}

export class ReShadeOverlayLauncher {
  private activeChild: ChildProcess | null = null;
  private activeRequest: Promise<ReShadeLaunchResult> | null = null;
  private activeTargetLabel: string | null = null;
  private activeAttach: {
    targetLabel: string;
    promise: Promise<ReShadeAttachResult>;
    cancel: (error: Error) => void;
  } | null = null;
  private attachmentState: ReShadeAttachmentState = 'idle';
  private attachmentTargetLabel: string | null = null;
  private attachmentExpectedTargetPid: number | undefined;
  private connectedTarget: ConnectedTarget | null = null;
  private awaitingTargetProof = false;
  private targetProofTimer: ReturnType<typeof setTimeout> | null = null;
  private latestRunDirectory: string | null = null;
  private launchGeneration = 0;
  private disposed = false;

  constructor(public readonly config: ReShadeLaunchConfig) {}

  public get hasRequestedInjection(): boolean {
    return this.attachmentState !== 'idle';
  }

  public get state(): ReShadeAttachmentState {
    return this.attachmentState;
  }

  public get runDirectory(): string | null {
    return this.latestRunDirectory;
  }

  /**
   * Completes the proof window opened by the low-level {@link launch} API.
   * A successful proof deliberately remains connected until disposal because
   * this API has no OverlaySession from which to observe target disconnects.
   * Use {@link attach} when automatic reuse after target exit is required.
   */
  public acceptTargetConnection(pid: number): boolean {
    if (
      !this.awaitingTargetProof ||
      this.attachmentState !== 'attaching' ||
      this.activeAttach !== null ||
      !isValidProcessPid(pid)
    ) {
      return false;
    }
    const expectedTargetPid = this.attachmentExpectedTargetPid;
    if (expectedTargetPid !== undefined && pid !== expectedTargetPid) {
      return false;
    }

    this.attachmentState = 'connected';
    this.closeTargetProofWindow();
    return true;
  }

  /**
   * Waits for transport discovery, arms the staged ReShade injector, and then
   * requires the injected add-on to authenticate back to this producer.
   */
  public attach(
    session: Pick<OverlaySession, 'on' | 'onClose' | 'whenReady'>,
    target: ReShadeTarget,
  ): Promise<ReShadeAttachResult> {
    if (this.disposed) {
      return Promise.reject(new Error('the ReShade launcher is disposed'));
    }

    const targetLabel = targetLabelFor(target);
    const expectedTargetPid = effectiveExpectedTargetPid(
      target,
      this.config.expectedTargetPid,
    );
    if (this.activeAttach) {
      if (this.activeAttach.targetLabel === targetLabel) {
        return this.activeAttach.promise;
      }
      return Promise.reject(
        new Error('a different ReShade attachment is already active'),
      );
    }
    if (this.attachmentState === 'connected') {
      return Promise.reject(
        new Error(
          this.attachmentTargetLabel === targetLabel
            ? 'the ReShade target is already connected'
            : 'a different ReShade target is already connected',
        ),
      );
    }
    if (this.attachmentState === 'blocked') {
      return Promise.reject(
        new Error(
          'the prior ReShade injection outcome is indeterminate; dispose the launcher before retrying',
        ),
      );
    }
    if (this.attachmentState === 'attaching') {
      return Promise.reject(
        new Error('a ReShade injection is already awaiting target connection'),
      );
    }

    let cancelled = false;
    let cancelAttach: (error: Error) => void = () => undefined;
    const cancellation = new Promise<never>((resolve, reject) => {
      void resolve;
      cancelAttach = (error) => {
        if (!cancelled) {
          cancelled = true;
          reject(error);
        }
      };
    });
    const promise = this.performAttach(
      session,
      target,
      expectedTargetPid,
      cancellation,
    );
    const activeAttach = {
      targetLabel,
      promise,
      cancel: cancelAttach,
    };
    this.activeAttach = activeAttach;

    const clearActiveAttach = () => {
      if (this.activeAttach === activeAttach) {
        this.activeAttach = null;
      }
    };
    promise.then(clearActiveAttach, clearActiveAttach);
    return promise;
  }

  /**
   * Starts one low-level injection and opens a bounded connection-proof window.
   * Missing that proof remains conservatively latched: without a session event
   * source, the launcher cannot establish that reinjection would be safe.
   * Prefer {@link attach} for reusable process lifecycle management.
   */
  public launch(target: ReShadeTarget): Promise<ReShadeLaunchResult> {
    if (this.disposed) {
      return Promise.reject(new Error('the ReShade launcher is disposed'));
    }

    const targetLabel = targetLabelFor(target);
    const expectedTargetPid = effectiveExpectedTargetPid(
      target,
      this.config.expectedTargetPid,
    );
    if (this.activeRequest) {
      if (this.activeTargetLabel === targetLabel) {
        return this.activeRequest;
      }
      return Promise.reject(
        new Error('a different ReShade injection request is already active'),
      );
    }
    if (this.attachmentState === 'connected') {
      return Promise.reject(
        new Error(
          this.attachmentTargetLabel === targetLabel
            ? 'the ReShade target is already connected'
            : 'a different ReShade target is already connected',
        ),
      );
    }
    if (this.attachmentState === 'blocked') {
      return Promise.reject(
        new Error(
          'the prior ReShade injection outcome is indeterminate; dispose the launcher before retrying',
        ),
      );
    }
    if (this.attachmentState === 'attaching') {
      return Promise.reject(
        new Error('a ReShade injection is already awaiting target connection'),
      );
    }

    this.attachmentState = 'attaching';
    this.attachmentTargetLabel = targetLabel;
    this.attachmentExpectedTargetPid = expectedTargetPid;
    this.awaitingTargetProof = true;
    this.targetProofTimer = setTimeout(() => {
      this.closeTargetProofWindow();
    }, TARGET_PROOF_TIMEOUT_MS);
    this.activeTargetLabel = targetLabel;

    const launchGeneration = ++this.launchGeneration;
    const request = this.performLaunch(
      target,
      targetLabel,
      expectedTargetPid,
      launchGeneration,
    ).catch((error) => {
      this.applyFailureState(targetLabel, error);
      throw error;
    });
    this.activeRequest = request;
    const clearActiveRequest = () => {
      if (this.activeRequest === request) {
        this.activeRequest = null;
        this.activeTargetLabel = null;
      }
    };
    request.then(clearActiveRequest, clearActiveRequest);
    return request;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.activeAttach?.cancel(
      new Error(
        'the ReShade launcher was disposed before attachment completed',
      ),
    );
    if (this.attachmentTargetLabel) {
      this.resetTargetState(this.attachmentTargetLabel);
    } else {
      this.closeTargetProofWindow();
    }
    this.invalidateActiveLaunch();
  }

  private async performAttach(
    session: Pick<OverlaySession, 'on' | 'onClose' | 'whenReady'>,
    target: ReShadeTarget,
    expectedTargetPid: number | undefined,
    cancellation: Promise<never>,
  ): Promise<ReShadeAttachResult> {
    await Promise.race([session.whenReady(), cancellation]);
    if (this.disposed) {
      throw new Error('the ReShade launcher is disposed');
    }

    const targetLabel = targetLabelFor(target);
    let removeNativeEvent: (() => void) | undefined;
    let removeCloseHandler: (() => void) | undefined;
    let proofTimer: ReturnType<typeof setTimeout> | undefined;
    let proofSettled = false;
    let attachmentCompleted = false;
    let injectorTargetPid: number | undefined;
    let resolveConnectionProof: (
      connection: ReShadeTargetConnection,
    ) => void = () => undefined;
    let rejectConnectionProof: (error: Error) => void = () => undefined;
    let rejectConnectionLost: (error: Error) => void = () => undefined;
    const candidatesByPid = new Map<number, ReShadeTargetConnection>();
    const disconnectedCandidatesByPid = new Map<
      number,
      ReShadeTargetConnection
    >();
    const recognizedCandidatePids = new Set<number>();

    const clearProofTimer = () => {
      if (proofTimer) {
        clearTimeout(proofTimer);
        proofTimer = undefined;
      }
    };
    let listenersRemoved = false;
    const removeListeners = () => {
      if (listenersRemoved) {
        return;
      }
      listenersRemoved = true;
      removeNativeEvent?.();
      removeNativeEvent = undefined;
      removeCloseHandler?.();
      removeCloseHandler = undefined;
      clearProofTimer();
    };

    const tryAcceptCandidate = () => {
      if (
        proofSettled ||
        injectorTargetPid === undefined ||
        this.attachmentState !== 'attaching' ||
        this.attachmentTargetLabel !== targetLabel
      ) {
        return;
      }
      const disconnectedCandidate =
        disconnectedCandidatesByPid.get(injectorTargetPid);
      if (disconnectedCandidate) {
        proofSettled = true;
        removeListeners();
        this.resetTargetState(targetLabel);
        rejectConnectionLost(
          new ReShadeOperationError(
            `the ReShade target pid=${disconnectedCandidate.pid} disconnected before attachment completed`,
            'definite-safe',
          ),
        );
        return;
      }
      const connection = candidatesByPid.get(injectorTargetPid);
      if (!connection) {
        return;
      }

      proofSettled = true;
      clearProofTimer();
      this.closeTargetProofWindow();
      this.attachmentState = 'connected';
      const connectedTarget: ConnectedTarget = Object.freeze({
        ...connection,
        targetLabel,
        removeListeners,
      });
      this.connectedTarget = connectedTarget;
      console.log(
        `${RESHADE_CLIENT_TARGET_CONNECTED_MARKER} pid=${connection.pid}`,
      );
      resolveConnectionProof(connection);
    };

    const connectionProof = new Promise<ReShadeTargetConnection>(
      (resolve, reject) => {
        resolveConnectionProof = resolve;
        rejectConnectionProof = reject;
      },
    );
    const connectionLost = new Promise<never>((resolve, reject) => {
      void resolve;
      rejectConnectionLost = reject;
    });

    removeNativeEvent = session.on('nativeEvent', ({ event, payload }) => {
      if (event === 'game.process') {
        const connection = readTargetConnection(payload);
        if (!connection || !this.hasRequestedInjection) {
          return;
        }
        if (
          !recognizedCandidatePids.has(connection.pid) &&
          !targetPathMatchesProcessName(connection.path, target.processName)
        ) {
          console.warn(
            `Ignored ReShade target connection from unexpected path=${JSON.stringify(connection.path)}; expected basename=${JSON.stringify(target.processName)}`,
          );
          return;
        }
        if (
          expectedTargetPid !== undefined &&
          connection.pid !== expectedTargetPid
        ) {
          console.warn(
            `Ignored ReShade target connection from unexpected pid=${connection.pid}; expected pid=${expectedTargetPid}`,
          );
          return;
        }
        recognizedCandidatePids.add(connection.pid);
        disconnectedCandidatesByPid.delete(connection.pid);
        candidatesByPid.set(connection.pid, connection);
        tryAcceptCandidate();
        return;
      }

      if (event === 'game.process.transport-lost') {
        const connection = readTargetConnection(payload);
        if (connection && recognizedCandidatePids.has(connection.pid)) {
          candidatesByPid.delete(connection.pid);
        }
        return;
      }

      if (event !== 'game.process.disconnected') {
        return;
      }
      const connection = readTargetConnection(payload);
      if (!connection) {
        return;
      }
      const candidate = candidatesByPid.get(connection.pid);
      if (candidate) {
        candidatesByPid.delete(connection.pid);
      }
      if (!proofSettled && recognizedCandidatePids.has(connection.pid)) {
        disconnectedCandidatesByPid.set(connection.pid, connection);
      }
      if (
        !proofSettled &&
        (injectorTargetPid === connection.pid ||
          expectedTargetPid === connection.pid)
      ) {
        proofSettled = true;
        removeListeners();
        this.resetTargetState(targetLabel);
        rejectConnectionLost(
          new ReShadeOperationError(
            `the ReShade target pid=${connection.pid} disconnected before attachment completed`,
            'definite-safe',
          ),
        );
        return;
      }
      const connectedTarget = this.connectedTarget;
      if (
        !connectedTarget ||
        connectedTarget.targetLabel !== targetLabel ||
        connectedTarget.pid !== connection.pid
      ) {
        return;
      }

      const wasAttachmentCompleted = attachmentCompleted;
      this.disconnectConnectedTarget(connectedTarget);
      if (!wasAttachmentCompleted) {
        rejectConnectionLost(
          new ReShadeOperationError(
            `the ReShade target pid=${connection.pid} disconnected before attachment completed`,
            'definite-safe',
          ),
        );
      }
    });
    removeCloseHandler = session.onClose(() => {
      const connectedTarget = this.connectedTarget;
      if (connectedTarget?.targetLabel === targetLabel) {
        const wasAttachmentCompleted = attachmentCompleted;
        this.blockTargetState(targetLabel);
        if (!wasAttachmentCompleted) {
          rejectConnectionLost(
            new ReShadeOperationError(
              'the overlay session closed before the ReShade attachment completed',
              'indeterminate',
            ),
          );
        }
        return;
      }
      if (!proofSettled) {
        proofSettled = true;
        removeListeners();
        this.blockTargetState(targetLabel);
        rejectConnectionProof(
          new ReShadeOperationError(
            'the overlay session closed before the ReShade target connected',
            'indeterminate',
          ),
        );
      }
    });
    if (!proofSettled) {
      proofTimer = setTimeout(() => {
        if (proofSettled) {
          return;
        }
        proofSettled = true;
        removeListeners();
        this.blockTargetState(targetLabel);
        rejectConnectionProof(
          new ReShadeOperationError(
            `the ReShade target did not connect within ${TARGET_PROOF_TIMEOUT_MS}ms`,
            'indeterminate',
          ),
        );
      }, TARGET_PROOF_TIMEOUT_MS);
    }

    let launch: Promise<ReShadeLaunchResult> | undefined;
    try {
      launch = this.launch(target).then((result) => {
        injectorTargetPid = result.injectorTargetPid;
        tryAcceptCandidate();
        return result;
      });
      const outcome = await Promise.race([
        Promise.all([launch, connectionProof] as const),
        cancellation,
        connectionLost,
      ]);
      const [launchResult, connection] = outcome;
      attachmentCompleted = true;
      return Object.freeze({ ...launchResult, pid: connection.pid });
    } catch (error) {
      this.invalidateActiveLaunch();
      if (launch && !this.disposed) {
        await launch.catch(() => undefined);
      }
      this.applyFailureState(targetLabel, error);
      throw error;
    } finally {
      clearProofTimer();
      if (
        !attachmentCompleted ||
        this.connectedTarget?.targetLabel !== targetLabel
      ) {
        removeListeners();
        if (this.attachmentState !== 'blocked') {
          this.resetTargetState(targetLabel);
        }
      }
    }
  }

  private async performLaunch(
    target: ReShadeTarget,
    targetLabel: string,
    expectedTargetPid: number | undefined,
    launchGeneration: number,
  ): Promise<ReShadeLaunchResult> {
    const staged = await this.stageRuntime(target.processName);
    this.assertLaunchCanSpawn(targetLabel, launchGeneration);
    this.latestRunDirectory = staged.runDirectory;
    const invocation = buildReShadeInvocation(target, staged.runDirectory);
    const invocationArguments = [...invocation.arguments];
    this.assertLaunchCanSpawn(targetLabel, launchGeneration);
    console.log(
      `${RESHADE_CLIENT_INJECTOR_STARTED_MARKER} target=${JSON.stringify(target.processName)} arguments=${JSON.stringify(invocationArguments)}`,
    );

    return new Promise<ReShadeLaunchResult>((resolve, reject) => {
      let didSpawn = false;
      const child = execFile(
        invocation.executable,
        invocationArguments,
        {
          cwd: invocation.workingDirectory,
          encoding: 'utf8',
          maxBuffer: MAX_OUTPUT_BYTES,
          shell: false,
          timeout: REQUEST_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (this.activeChild === child) {
            this.activeChild = null;
          }
          void this.finishInjector(
            target.processName,
            targetLabel,
            expectedTargetPid,
            target.pid !== undefined,
            staged,
            error,
            stdout,
            stderr,
            didSpawn,
          ).then(resolve, reject);
        },
      );
      child.once('spawn', () => {
        didSpawn = true;
      });
      this.activeChild = child;
    });
  }

  private async stageRuntime(processName: string): Promise<StagedRuntime> {
    await mkdir(this.config.runsRootDirectory, { recursive: true });
    const runsRootDirectory = await realpath(this.config.runsRootDirectory);
    const safeProcessName = processName.replace(/[^a-zA-Z0-9._-]/g, '-');
    const runDirectory = await mkdtemp(
      path.join(runsRootDirectory, `${safeProcessName}-`),
    );
    assertDirectChild(runsRootDirectory, runDirectory, 'ReShade run directory');

    const sourceByName = new Map<string, string>([
      [INJECTOR_FILE_NAME, this.config.injectorPath],
      [RUNTIME_FILE_NAME, this.config.runtimePath],
      [BUILD_STAMP_FILE_NAME, this.config.buildStampPath],
      [ADDON_FILE_NAME, this.config.addonPath],
      [CONFIG_FILE_NAME, this.config.configPath],
    ]);
    await Promise.all(
      RUNTIME_ARTIFACTS.map((fileName) =>
        copyFile(
          sourceByName.get(fileName)!,
          path.join(runDirectory, fileName),
        ),
      ),
    );

    console.log(
      `${RESHADE_CLIENT_RUNTIME_STAGED_MARKER} directory=${JSON.stringify(runDirectory)}`,
    );
    return Object.freeze({
      runDirectory,
      injectorPath: path.join(runDirectory, INJECTOR_FILE_NAME),
      injectorStdoutPath: path.join(runDirectory, INJECTOR_STDOUT_FILE_NAME),
      injectorStderrPath: path.join(runDirectory, INJECTOR_STDERR_FILE_NAME),
      reshadeLogPath: path.join(runDirectory, RESHADE_LOG_FILE_NAME),
    });
  }

  private async finishInjector(
    processName: string,
    targetLabel: string,
    expectedTargetPid: number | undefined,
    exactPidMode: boolean,
    staged: StagedRuntime,
    error: Error | null,
    stdout: string,
    stderr: string,
    didSpawn: boolean,
  ): Promise<ReShadeLaunchResult> {
    const hasSuccessMarker = stdout.includes(INJECTOR_SUCCESS_MARKER);
    const hasNotStartedProof =
      exactPidMode && !hasSuccessMarker && injectorDidNotStart(stdout);
    try {
      await Promise.all([
        writeFile(staged.injectorStdoutPath, stdout, 'utf8'),
        writeFile(staged.injectorStderrPath, stderr, 'utf8'),
      ]);
    } catch (evidenceError) {
      const detail = `ReShade injector completed but its evidence logs could not be preserved: ${formatUnknownError(evidenceError)}`;
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(processName)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError(
        detail,
        hasNotStartedProof ||
        (!didSpawn && error && !stdout.includes(INJECTOR_SUCCESS_MARKER))
          ? 'definite-safe'
          : 'indeterminate',
      );
    }

    if (this.disposed) {
      const detail =
        'the ReShade launcher was disposed before injector completion';
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(processName)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError(detail, 'indeterminate');
    }

    if (error) {
      const detail = formatLaunchError(error, stdout, stderr);
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(processName)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError(
        detail,
        hasNotStartedProof || (!didSpawn && !hasSuccessMarker)
          ? 'definite-safe'
          : 'indeterminate',
      );
    }
    if (!hasSuccessMarker) {
      const detail = `ReShade injector stdout did not contain ${JSON.stringify(INJECTOR_SUCCESS_MARKER)}`;
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(processName)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError(
        detail,
        hasNotStartedProof ? 'definite-safe' : 'indeterminate',
      );
    }
    if (!didSpawn) {
      const detail =
        'ReShade injector reported success without a confirmed child-process spawn';
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(processName)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError(detail, 'indeterminate');
    }

    let injectorTargetPid: number;
    try {
      injectorTargetPid = parseInjectorTargetPid(stdout);
    } catch (parseError) {
      const detail =
        parseError instanceof Error ? parseError.message : String(parseError);
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(processName)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError(detail, 'indeterminate');
    }
    if (
      expectedTargetPid !== undefined &&
      injectorTargetPid !== expectedTargetPid
    ) {
      const detail = `ReShade injector selected pid=${injectorTargetPid}; expected pid=${expectedTargetPid}`;
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(processName)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError(detail, 'indeterminate');
    }

    console.log(
      `${RESHADE_CLIENT_INJECTOR_RETURNED_MARKER} target=${JSON.stringify(processName)}`,
    );
    return Object.freeze({
      processName,
      targetLabel,
      injectorTargetPid,
      runDirectory: staged.runDirectory,
      injectorStdoutPath: staged.injectorStdoutPath,
      injectorStderrPath: staged.injectorStderrPath,
      reshadeLogPath: staged.reshadeLogPath,
    });
  }

  private disconnectConnectedTarget(target: ConnectedTarget): void {
    if (this.connectedTarget !== target) {
      return;
    }
    console.log(
      `${RESHADE_CLIENT_TARGET_DISCONNECTED_MARKER} pid=${target.pid}`,
    );
    this.resetTargetState(target.targetLabel);
  }

  private applyFailureState(targetLabel: string, error: unknown): void {
    if (
      this.attachmentState === 'blocked' ||
      (error instanceof ReShadeOperationError &&
        error.retrySafety === 'indeterminate')
    ) {
      this.blockTargetState(targetLabel);
      return;
    }
    this.resetTargetState(targetLabel);
  }

  private blockTargetState(targetLabel: string): void {
    if (this.attachmentTargetLabel !== targetLabel) {
      return;
    }
    const connectedTarget = this.connectedTarget;
    if (connectedTarget?.targetLabel === targetLabel) {
      this.connectedTarget = null;
      connectedTarget.removeListeners();
    }
    this.attachmentState = 'blocked';
    this.closeTargetProofWindow();
  }

  private resetTargetState(targetLabel: string): void {
    if (this.attachmentTargetLabel !== targetLabel) {
      return;
    }
    const connectedTarget = this.connectedTarget;
    if (connectedTarget?.targetLabel === targetLabel) {
      this.connectedTarget = null;
      connectedTarget.removeListeners();
    }
    this.attachmentState = 'idle';
    this.attachmentTargetLabel = null;
    this.attachmentExpectedTargetPid = undefined;
    this.closeTargetProofWindow();
  }

  private closeTargetProofWindow(): void {
    this.awaitingTargetProof = false;
    if (this.targetProofTimer) {
      clearTimeout(this.targetProofTimer);
      this.targetProofTimer = null;
    }
  }

  private assertLaunchCanSpawn(
    targetLabel: string,
    launchGeneration: number,
  ): void {
    if (
      this.disposed ||
      this.launchGeneration !== launchGeneration ||
      this.attachmentTargetLabel !== targetLabel ||
      this.attachmentState === 'idle' ||
      this.attachmentState === 'blocked'
    ) {
      throw new ReShadeOperationError(
        'the ReShade injection was canceled before the injector started',
        'definite-safe',
      );
    }
  }

  private invalidateActiveLaunch(): void {
    this.launchGeneration += 1;
    this.stopActiveChild();
  }

  private stopActiveChild(): void {
    const child = this.activeChild;
    this.activeChild = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
}

function targetLabelFor(target: ReShadeTarget): string {
  validateTarget(target);
  return target.pid === undefined
    ? `process:${target.processName}`
    : `process:${target.processName}:pid:${target.pid}`;
}

function effectiveExpectedTargetPid(
  target: ReShadeTarget,
  configuredExpectedTargetPid: number | undefined,
): number | undefined {
  validateTarget(target);
  if (
    configuredExpectedTargetPid !== undefined &&
    !isValidProcessPid(configuredExpectedTargetPid)
  ) {
    throw new Error(
      'the configured ReShade expected target PID must be a positive uint32 integer',
    );
  }
  if (
    target.pid !== undefined &&
    configuredExpectedTargetPid !== undefined &&
    target.pid !== configuredExpectedTargetPid
  ) {
    throw new Error(
      `ReShade target pid=${target.pid} conflicts with configured expected target pid=${configuredExpectedTargetPid}`,
    );
  }
  return target.pid ?? configuredExpectedTargetPid;
}

function parseInjectorTargetPid(stdout: string): number {
  const match = INJECTOR_TARGET_PID_PATTERN.exec(stdout);
  const pid = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    throw new Error(
      'ReShade injector stdout did not contain a valid matched process PID',
    );
  }
  return pid;
}

function injectorDidNotStart(stdout: string): boolean {
  return stdout
    .split(/\r?\n/)
    .some((line) => line.trim() === INJECTOR_NOT_STARTED_MARKER);
}

function readTargetConnection(
  payload: unknown,
): ReShadeTargetConnection | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as { pid?: unknown; path?: unknown };
  if (
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) <= 0 ||
    (candidate.pid as number) > 0xffffffff ||
    typeof candidate.path !== 'string' ||
    candidate.path.length === 0
  ) {
    return null;
  }
  return Object.freeze({ pid: candidate.pid as number, path: candidate.path });
}

function targetPathMatchesProcessName(
  targetPath: string,
  processName: string,
): boolean {
  return (
    path.win32.basename(targetPath).toLowerCase() === processName.toLowerCase()
  );
}

function readOptionalOption(argv: readonly string[], name: string) {
  const prefix = `${name}=`;
  const matches = argv.filter(
    (argument) => argument === name || argument.startsWith(prefix),
  );
  if (matches.length > 1) {
    throw new Error(`${name} must not be provided more than once`);
  }
  if (matches.length === 0) {
    return undefined;
  }

  const match = matches[0];
  if (match === name) {
    throw new Error(`${name} must use the ${name}=<value> form`);
  }
  const value = match.slice(prefix.length);
  if (value.length === 0 || value.includes('\0')) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

function canonicalDirectory(directoryPath: string): string {
  try {
    const canonicalPath = realpathSync(directoryPath);
    if (statSync(canonicalPath).isDirectory()) {
      return canonicalPath;
    }
  } catch {
    // Report a stable launch-configuration error below.
  }
  throw new Error(`ReShade runtime directory is unavailable: ${directoryPath}`);
}

function canonicalArtifact(
  runtimeDirectory: string,
  fileName: string,
  label: string,
): string {
  const filePath = path.join(runtimeDirectory, fileName);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(filePath);
    if (!statSync(canonicalPath).isFile()) {
      throw new Error('not a file');
    }
  } catch {
    throw new Error(`${label} is unavailable: ${filePath}`);
  }
  assertDirectChild(runtimeDirectory, canonicalPath, label);
  return canonicalPath;
}

function assertDirectChild(
  parentDirectory: string,
  childPath: string,
  label: string,
): void {
  if (
    path.dirname(path.resolve(childPath)).toLowerCase() !==
    path.resolve(parentDirectory).toLowerCase()
  ) {
    throw new Error(`${label} is not co-located under ${parentDirectory}`);
  }
}

function validateProcessName(processName: string): void {
  const invalidWindowsBasename = /[<>:"/\\|?*\u0000-\u001f]/;
  if (
    processName.length === 0 ||
    processName.length <= '.exe'.length ||
    processName.length > 260 ||
    processName !== processName.trim() ||
    path.win32.basename(processName) !== processName ||
    invalidWindowsBasename.test(processName) ||
    !processName.toLowerCase().endsWith('.exe')
  ) {
    throw new Error('the ReShade target process must be a valid .exe basename');
  }
}

function validateTarget(target: ReShadeTarget): void {
  validateProcessName(target.processName);
  if (target.pid !== undefined && !isValidProcessPid(target.pid)) {
    throw new Error('the ReShade target PID must be a positive uint32 integer');
  }
}

function isValidProcessPid(pid: unknown): pid is number {
  return (
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    pid <= 0xffffffff
  );
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatLaunchError(
  error: Error,
  stdout: string,
  stderr: string,
): string {
  return [
    error.message,
    stdout.trim() ? `stdout: ${stdout.trim()}` : '',
    stderr.trim() ? `stderr: ${stderr.trim()}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}
