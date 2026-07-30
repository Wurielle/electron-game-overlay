import { execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME } from './overlay-loopback-transport.js';
import type { OverlaySession } from './overlay-session.js';

const RESHADE_OPT_IN_FLAG = '--reshade-overlay';
const RESHADE_RUNTIME_DIRECTORY_OPTION = '--reshade-runtime-dir';
const RESHADE_AUTO_TARGET_PROCESS_OPTION = '--reshade-auto-target-process';
const RESHADE_EXPECTED_TARGET_PID_OPTION = '--reshade-expected-target-pid';
const INJECTOR_FILE_NAME = 'inject.exe';
const RUNTIME_FILE_NAME = 'ReShade64.dll';
const BUILD_STAMP_FILE_NAME = 'ReShade64.build.json';
const ADDON_FILE_NAME = 'electron_game_overlay.addon64';
const CONFIG_FILE_NAME = 'ReShade.ini';
const INJECTOR_STDOUT_FILE_NAME = 'inject.stdout.log';
const INJECTOR_STDERR_FILE_NAME = 'inject.stderr.log';
const RESHADE_LOG_FILE_NAME = 'ReShade.log';
const RUNTIME_STARTUP_FILE_NAME = '.electron-game-overlay-runtime-startup.json';
const INJECTOR_SUCCESS_MARKER = 'Injecting ReShade ... Succeeded!';
const INJECTOR_NOT_STARTED_MARKER = 'ReShade injection not started.';
const INJECTOR_DIAGNOSTIC_PREFIX = 'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ';
const INJECTOR_RESULT_PREFIX = 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ';
const INJECTOR_TARGET_PATH_PATTERN = /^Matched executable path: (.+)$/m;
const REQUEST_TIMEOUT_MS = 120_000;
const TARGET_PROOF_TIMEOUT_MS = 120_000;
const PATH_TARGET_PROOF_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RUNTIME_STARTUP_RECORD_BYTES = 256;
const RUNTIME_STARTUP_OBSERVATION_TIMEOUT_MS = 250;
const RUN_OWNERSHIP_MARKER_FILE_NAME = '.electron-game-overlay-run.json';
const RUN_RECLAIMABLE_MARKER_FILE_NAME =
  '.electron-game-overlay-run-reclaimable.json';
const RUN_OWNERSHIP_MARKER_KIND = 'electron-game-overlay-reshade-run';
const RUN_RECLAIMABLE_MARKER_KIND =
  'electron-game-overlay-reshade-run-reclaimable';
const RUN_MARKER_SCHEMA_VERSION = 1;
const RUN_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const RUN_RETENTION_MAX_DIRECTORIES = 64;

const RUNTIME_STARTUP_RECORD_CODES = Object.freeze([
  'bridge-thread-create-failed',
  'bridge-thread-started',
  'bridge-window-create-failed',
  'bridge-window-ready',
  'discovery-not-ready',
  'discovery-document-invalid',
  'discovery-version-mismatch',
  'discovery-target-mismatch',
  'loopback-connect-failed',
  'loopback-configuration-failed',
  'process-hello-build-failed',
  'network-worker-start-failed',
  'network-worker-started',
  'network-connection-lost',
  'bridge-message-pump-failed',
] as const);

type ReShadeRuntimeStartupRecordCode =
  (typeof RUNTIME_STARTUP_RECORD_CODES)[number];

const runtimeStartupRecordCodes = new Set<string>(RUNTIME_STARTUP_RECORD_CODES);
const RUNTIME_STARTUP_RECORD_KEYS = Object.freeze([
  'schemaVersion',
  'source',
  'pid',
  'code',
] as const);

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
export const RESHADE_CLIENT_TARGET_RENDEZVOUS_AUTHORIZED_MARKER =
  'RESHADE_CLIENT_TARGET_RENDEZVOUS_AUTHORIZED';
const RESHADE_CLIENT_RUN_RETENTION_PRUNED_MARKER =
  'RESHADE_CLIENT_RUN_RETENTION_PRUNED';

const RUNTIME_ARTIFACTS = Object.freeze([
  INJECTOR_FILE_NAME,
  RUNTIME_FILE_NAME,
  BUILD_STAMP_FILE_NAME,
  ADDON_FILE_NAME,
  CONFIG_FILE_NAME,
] as const);

export type ReShadeProcessTarget = Readonly<{
  processName: string;
  pid?: number;
}>;

export type ReShadePathTarget = Readonly<{
  pathContains: string;
  excludedProcessNames?: readonly string[];
}>;

export type ReShadeTarget = ReShadeProcessTarget | ReShadePathTarget;

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
  arguments: readonly string[];
  targetLabel: string;
  workingDirectory: string;
}>;

export type ReShadeRuntimeMode = 'injected-runtime' | 'existing-runtime';

export type ReShadeRuntimeStartupCode =
  | ReShadeRuntimeStartupRecordCode
  | 'not-observed'
  | 'invalid-record'
  | 'pid-mismatch'
  | 'pid-unavailable';

export type ReShadeLaunchResult = Readonly<{
  processName: string;
  selectedPath?: string;
  targetLabel: string;
  injectorTargetPid: number;
  runtimeMode: ReShadeRuntimeMode;
  hostRuntimePath?: string;
  runDirectory: string;
  injectorStdoutPath: string;
  injectorStderrPath: string;
  reshadeLogPath: string;
  runtimeStartupPath?: string;
}>;

export type ReShadeAttachResult = ReShadeLaunchResult &
  Readonly<{
    pid: number;
  }>;

type StagedRuntime = Readonly<{
  runId: string;
  runsRootDirectory: string;
  runDirectory: string;
  injectorPath: string;
  injectorStdoutPath: string;
  injectorStderrPath: string;
  reshadeLogPath: string;
  runtimeStartupPath: string;
}>;

type CurrentRuntime = Readonly<{
  staged: StagedRuntime;
  targetLabel: string;
  launchGeneration: number;
}>;

type RunOwnershipMarker = Readonly<{
  schemaVersion: 1;
  kind: typeof RUN_OWNERSHIP_MARKER_KIND;
  runId: string;
  directoryName: string;
  createdAt: string;
}>;

type RunReclaimableMarker = Readonly<{
  schemaVersion: 1;
  kind: typeof RUN_RECLAIMABLE_MARKER_KIND;
  runId: string;
  directoryName: string;
  retiredAt: string;
}>;

type ReclaimableRunDirectory = Readonly<{
  runsRootDirectory: string;
  runDirectory: string;
  ownership: RunOwnershipMarker;
  reclaimable: RunReclaimableMarker;
  retiredAtMs: number;
}>;

type RunRetentionSweepState = {
  rescanRequested: boolean;
  promise: Promise<void>;
};

const runRetentionSweeps = new Map<string, RunRetentionSweepState>();

export type ReShadeAttachmentState =
  | 'idle'
  | 'attaching'
  | 'connected'
  | 'blocked';

/**
 * `definite-safe` means a retry cannot duplicate a loaded ReShade runtime or
 * add-on payload. It does not promise that no bounded remote coordination,
 * allocation, or loader thread was attempted.
 */
export type ReShadeRetrySafety = 'definite-safe' | 'indeterminate';

export type ReShadeDiagnosticStage =
  | 'runtime-staging'
  | 'target-preflight'
  | 'injector'
  | 'runtime-initialization'
  | 'lifecycle';

export type ReShadeDiagnosticCode =
  | 'runtime-staging-failed'
  | 'target-injection-already-claimed'
  | 'target-injection-claim-failed'
  | 'target-runtime-conflict'
  | 'target-runtime-incompatible'
  | 'target-runtime-reuse-too-late'
  | 'target-runtime-reuse-raced'
  | 'target-module-inspection-failed'
  | 'existing-runtime-addon-load-failed'
  | 'injector-start-failed'
  | 'injector-evidence-write-failed'
  | 'injector-failed'
  | 'injector-result-invalid'
  | 'runtime-initialization-timeout'
  | 'target-disconnected'
  | 'session-closed'
  | 'operation-cancelled';

export type ReShadeDiagnosticEvidence = Readonly<{
  runDirectory: string;
  injectorStdoutPath: string;
  injectorStderrPath: string;
  reshadeLogPath: string;
  runtimeStartupPath?: string;
}>;

export type ReShadeDiagnostic = Readonly<{
  schemaVersion: 1;
  source: 'electron-game-overlay';
  severity: 'error';
  stage: ReShadeDiagnosticStage;
  code: ReShadeDiagnosticCode;
  retrySafety: ReShadeRetrySafety;
  message: string;
  targetLabel?: string;
  pid?: number;
  modulePath?: string;
  windowsErrorCode?: number;
  runtimeStartupCode?: ReShadeRuntimeStartupCode;
  evidence?: ReShadeDiagnosticEvidence;
}>;

type ReShadeDiagnosticInput = Omit<
  ReShadeDiagnostic,
  'schemaVersion' | 'source' | 'severity'
>;

export class ReShadeOperationError extends Error {
  public readonly diagnostic: ReShadeDiagnostic;
  public readonly code: ReShadeDiagnosticCode;
  public readonly stage: ReShadeDiagnosticStage;
  public readonly retrySafety: ReShadeRetrySafety;

  constructor(input: ReShadeDiagnosticInput) {
    const diagnostic = createReShadeDiagnostic(input);
    super(diagnostic.message);
    this.name = 'ReShadeOperationError';
    this.diagnostic = diagnostic;
    this.code = diagnostic.code;
    this.stage = diagnostic.stage;
    this.retrySafety = diagnostic.retrySafety;
  }
}

export function isReShadeOperationError(
  error: unknown,
): error is ReShadeOperationError {
  return error instanceof ReShadeOperationError;
}

type InjectorPreflightDiagnostic = Readonly<{
  schemaVersion: 1;
  stage: 'target-preflight';
  code:
    | 'target-injection-already-claimed'
    | 'target-injection-claim-failed'
    | 'target-runtime-conflict'
    | 'target-runtime-incompatible'
    | 'target-runtime-reuse-too-late'
    | 'target-runtime-reuse-raced'
    | 'target-module-inspection-failed';
  pid: number;
  injectionStarted: false;
  modulePath?: string;
  windowsErrorCode?: number;
}>;

type InjectorExistingRuntimeAddonLoadDiagnostic = Readonly<{
  schemaVersion: 1;
  stage: 'existing-runtime-addon-load';
  code: 'existing-runtime-addon-load-failed';
  pid: number;
  injectionStarted: true;
  modulePath?: string;
  windowsErrorCode?: number;
}>;

type InjectorDiagnostic =
  | InjectorPreflightDiagnostic
  | InjectorExistingRuntimeAddonLoadDiagnostic;

type InjectorResult =
  | Readonly<{
      schemaVersion: 1;
      pid: number;
      runtimeMode: 'injected-runtime';
    }>
  | Readonly<{
      schemaVersion: 1;
      pid: number;
      runtimeMode: 'existing-runtime';
      runtimeModulePath: string;
      hostAbi: 1;
    }>;

type ReShadeTargetConnection = Readonly<{
  pid: number;
  path: string;
}>;

type ReShadeAttachmentSession = Pick<
  OverlaySession,
  'on' | 'onClose' | 'whenReady'
> &
  Partial<Pick<OverlaySession, 'authorizeTarget'>>;

type TargetRendezvousAuthorizer = (
  runDirectory: string,
  pid: number,
) => Promise<() => void>;

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

  const arguments_ = isPathTarget(target)
    ? [
        '--path-contains',
        target.pathContains,
        ...(target.excludedProcessNames ?? []).flatMap((processName) => [
          '--exclude-name',
          processName,
        ]),
      ]
    : target.pid === undefined
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
  private currentRuntime: CurrentRuntime | null = null;
  private preparedRuntime: Promise<StagedRuntime> | null = null;
  private releaseTargetAuthorization: (() => void) | null = null;
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
   * Stages an isolated runtime before a target is detected. The next launch
   * consumes it, keeping filesystem work out of latency-sensitive process
   * startup without changing the exact-PID injection contract.
   */
  public prepare(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('the ReShade launcher is disposed'));
    }
    if (!this.preparedRuntime) {
      const prepared = this.stageRuntime('prepared');
      this.preparedRuntime = prepared;
      void prepared.catch(() => {
        if (this.preparedRuntime === prepared) {
          this.preparedRuntime = null;
        }
      });
    }
    return this.preparedRuntime.then(() => undefined);
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
   * Applies an external, authoritative process-exit observation to a connected
   * attachment or an attaching exact-PID target. This closes the ordering gap
   * when a process watcher observes termination before the overlay transport.
   */
  public confirmTargetExited(pid: number): boolean {
    if (!isValidProcessPid(pid)) {
      return false;
    }
    const connectedTarget = this.connectedTarget;
    if (connectedTarget?.pid === pid) {
      this.disconnectConnectedTarget(connectedTarget);
      return true;
    }
    const targetLabel = this.attachmentTargetLabel;
    if (
      this.attachmentState !== 'attaching' ||
      this.attachmentExpectedTargetPid !== pid ||
      targetLabel === null
    ) {
      return false;
    }

    const current = this.currentRuntime;
    const error = new ReShadeOperationError({
      message: `the ReShade target pid=${pid} was confirmed exited before attachment completed`,
      code: 'target-disconnected',
      stage: 'lifecycle',
      retrySafety: 'definite-safe',
      targetLabel,
      pid,
      ...(current?.targetLabel !== targetLabel
        ? {}
        : { evidence: diagnosticEvidenceForStagedRuntime(current.staged) }),
    });
    console.log(`${RESHADE_CLIENT_TARGET_DISCONNECTED_MARKER} pid=${pid}`);
    this.activeAttach?.cancel(error);
    this.invalidateActiveLaunch();
    this.retireCurrentRuntime(targetLabel, current?.launchGeneration);
    this.resetTargetState(targetLabel);
    return true;
  }

  /**
   * Waits for transport discovery, arms the staged ReShade injector, and then
   * requires the injected add-on to authenticate back to this producer.
   */
  public attach(
    session: ReShadeAttachmentSession,
    target: ReShadeTarget,
  ): Promise<ReShadeAttachResult> {
    if (this.disposed) {
      return Promise.reject(new Error('the ReShade launcher is disposed'));
    }

    const [attachmentTarget, expectedTargetPid] = snapshotTarget(
      target,
      this.config.expectedTargetPid,
    );
    const targetLabel = targetLabelFor(attachmentTarget);
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

    this.attachmentState = 'attaching';
    this.attachmentTargetLabel = targetLabel;
    this.attachmentExpectedTargetPid = expectedTargetPid;
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
      attachmentTarget,
      expectedTargetPid,
      cancellation,
    ).catch((error) => {
      if (
        this.attachmentState === 'attaching' &&
        this.attachmentTargetLabel === targetLabel
      ) {
        this.applyFailureState(targetLabel, error);
      }
      throw error;
    });
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
    return this.requestLaunch(target);
  }

  private requestLaunch(
    target: ReShadeTarget,
    authorizeTarget?: TargetRendezvousAuthorizer,
    attachmentOwner = false,
  ): Promise<ReShadeLaunchResult> {
    if (this.disposed) {
      return Promise.reject(new Error('the ReShade launcher is disposed'));
    }

    const [launchTarget, expectedTargetPid] = snapshotTarget(
      target,
      this.config.expectedTargetPid,
    );
    const targetLabel = targetLabelFor(launchTarget);
    if (!attachmentOwner && this.activeAttach) {
      return Promise.reject(
        new Error('a ReShade attachment is already active'),
      );
    }
    if (this.activeRequest) {
      if (attachmentOwner) {
        return Promise.reject(
          new Error('the active ReShade attachment already owns a launch'),
        );
      }
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
    if (
      this.attachmentState === 'attaching' &&
      (!attachmentOwner ||
        this.activeAttach?.targetLabel !== targetLabel ||
        this.attachmentTargetLabel !== targetLabel)
    ) {
      return Promise.reject(
        new Error('a ReShade injection is already awaiting target connection'),
      );
    }

    this.attachmentState = 'attaching';
    this.attachmentTargetLabel = targetLabel;
    this.attachmentExpectedTargetPid = expectedTargetPid;
    this.awaitingTargetProof = !isPathTarget(launchTarget);
    if (this.awaitingTargetProof) {
      this.targetProofTimer = setTimeout(() => {
        this.closeTargetProofWindow();
      }, TARGET_PROOF_TIMEOUT_MS);
    }
    this.activeTargetLabel = targetLabel;

    const launchGeneration = ++this.launchGeneration;
    const request = this.performLaunch(
      launchTarget,
      targetLabel,
      expectedTargetPid,
      launchGeneration,
      authorizeTarget,
    )
      .then((result) => {
        if (
          isPathTarget(launchTarget) &&
          this.activeAttach === null &&
          !this.disposed &&
          this.attachmentState === 'attaching' &&
          this.attachmentTargetLabel === targetLabel
        ) {
          this.attachmentExpectedTargetPid = result.injectorTargetPid;
          this.awaitingTargetProof = true;
          this.targetProofTimer = setTimeout(() => {
            this.closeTargetProofWindow();
          }, PATH_TARGET_PROOF_TIMEOUT_MS);
        }
        return result;
      })
      .catch((error) => {
        this.applyFailureState(targetLabel, error, launchGeneration);
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
    const preparedRuntime = this.preparedRuntime;
    this.preparedRuntime = null;
    if (preparedRuntime) {
      void preparedRuntime
        .then(
          (staged) => removeStagedRuntime(staged),
          () => undefined,
        )
        .catch((error) => {
          console.error(
            `Unable to remove an unused prepared ReShade runtime: ${formatUnknownError(error)}`,
          );
        });
    }
    this.invalidateActiveLaunch();
    this.clearTargetAuthorization();
  }

  private async performAttach(
    session: ReShadeAttachmentSession,
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
    let launchResultForProof: ReShadeLaunchResult | undefined;
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
    const startProofTimer = () => {
      if (proofSettled || proofTimer) {
        return;
      }
      const proofTimeoutMs = isPathTarget(target)
        ? PATH_TARGET_PROOF_TIMEOUT_MS
        : TARGET_PROOF_TIMEOUT_MS;
      proofTimer = setTimeout(() => {
        proofTimer = undefined;
        void reportProofTimeout(proofTimeoutMs);
      }, proofTimeoutMs);
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
    const reportProofTimeout = async (proofTimeoutMs: number) => {
      if (proofSettled) {
        return;
      }
      const currentRuntime = this.currentRuntime;
      const initialEvidence =
        launchResultForProof === undefined
          ? currentRuntime?.targetLabel !== targetLabel
            ? undefined
            : diagnosticEvidenceForStagedRuntime(currentRuntime.staged)
          : diagnosticEvidenceForLaunchResult(launchResultForProof);
      const startupObservation = await readRuntimeStartupObservation(
        initialEvidence?.runtimeStartupPath,
      );
      if (proofSettled) {
        return;
      }

      const diagnosticPid = injectorTargetPid ?? expectedTargetPid;
      const runtimeStartupCode = runtimeStartupCodeForObservation(
        startupObservation,
        diagnosticPid,
      );
      const evidence =
        launchResultForProof === undefined
          ? this.currentRuntime?.targetLabel === targetLabel
            ? diagnosticEvidenceForStagedRuntime(this.currentRuntime.staged)
            : initialEvidence
          : diagnosticEvidenceForLaunchResult(launchResultForProof);
      proofSettled = true;
      removeListeners();
      this.blockTargetState(targetLabel);
      rejectConnectionProof(
        new ReShadeOperationError({
          message: `the ReShade target did not connect within ${proofTimeoutMs}ms; ${runtimeStartupDescription(runtimeStartupCode)}`,
          code: 'runtime-initialization-timeout',
          stage: 'runtime-initialization',
          retrySafety: 'indeterminate',
          targetLabel,
          ...(diagnosticPid === undefined ? {} : { pid: diagnosticPid }),
          runtimeStartupCode,
          ...(evidence === undefined ? {} : { evidence }),
        }),
      );
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
        this.retireCurrentRuntime(targetLabel);
        this.resetTargetState(targetLabel);
        rejectConnectionLost(
          new ReShadeOperationError({
            message: `the ReShade target pid=${disconnectedCandidate.pid} disconnected before attachment completed`,
            code: 'target-disconnected',
            stage: 'lifecycle',
            retrySafety: 'definite-safe',
            targetLabel,
            pid: disconnectedCandidate.pid,
          }),
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
          expectedTargetPid !== undefined &&
          connection.pid !== expectedTargetPid
        ) {
          return;
        }
        if (
          !recognizedCandidatePids.has(connection.pid) &&
          !targetPathMatches(connection.path, target)
        ) {
          console.warn(
            `Ignored ReShade target connection from unexpected path=${JSON.stringify(connection.path)}; expected ${targetPathExpectation(target)}`,
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
        this.retireCurrentRuntime(targetLabel);
        this.resetTargetState(targetLabel);
        rejectConnectionLost(
          new ReShadeOperationError({
            message: `the ReShade target pid=${connection.pid} disconnected before attachment completed`,
            code: 'target-disconnected',
            stage: 'lifecycle',
            retrySafety: 'definite-safe',
            targetLabel,
            pid: connection.pid,
          }),
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
          new ReShadeOperationError({
            message: `the ReShade target pid=${connection.pid} disconnected before attachment completed`,
            code: 'target-disconnected',
            stage: 'lifecycle',
            retrySafety: 'definite-safe',
            targetLabel,
            pid: connection.pid,
          }),
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
            new ReShadeOperationError({
              message:
                'the overlay session closed before the ReShade attachment completed',
              code: 'session-closed',
              stage: 'lifecycle',
              retrySafety: 'indeterminate',
              targetLabel,
              ...(expectedTargetPid === undefined
                ? {}
                : { pid: expectedTargetPid }),
            }),
          );
        }
        return;
      }
      if (!proofSettled) {
        proofSettled = true;
        removeListeners();
        this.blockTargetState(targetLabel);
        rejectConnectionProof(
          new ReShadeOperationError({
            message:
              'the overlay session closed before the ReShade target connected',
            code: 'session-closed',
            stage: 'lifecycle',
            retrySafety: 'indeterminate',
            targetLabel,
            ...(expectedTargetPid === undefined
              ? {}
              : { pid: expectedTargetPid }),
          }),
        );
      }
    });
    if (!isPathTarget(target)) {
      startProofTimer();
    }

    const authorizeTarget = session.authorizeTarget;
    const targetRendezvousAuthorizer: TargetRendezvousAuthorizer | undefined =
      authorizeTarget
        ? (runDirectory, pid) =>
            authorizeTarget.call(
              session,
              pid,
              path.join(runDirectory, OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME),
            )
        : undefined;
    let launch: Promise<ReShadeLaunchResult> | undefined;
    try {
      launch = this.requestLaunch(
        target,
        targetRendezvousAuthorizer,
        true,
      ).then((result) => {
        launchResultForProof = result;
        injectorTargetPid = result.injectorTargetPid;
        if (isPathTarget(target)) {
          startProofTimer();
        }
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
      proofSettled = true;
      this.invalidateActiveLaunch();
      if (launch && !this.disposed) {
        await launch.catch(() => undefined);
      }
      this.applyFailureState(targetLabel, error);
      throw error;
    } finally {
      proofSettled = true;
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
    authorizeTarget?: TargetRendezvousAuthorizer,
  ): Promise<ReShadeLaunchResult> {
    const targetDescription = targetDescriptionFor(target);
    const preparedRuntime = this.preparedRuntime;
    this.preparedRuntime = null;
    const staged = await (preparedRuntime ??
      this.stageRuntime(targetStageName(target)));
    let newTargetAuthorization: (() => void) | undefined;
    try {
      this.assertLaunchCanSpawn(targetLabel, launchGeneration);
      if (expectedTargetPid !== undefined && authorizeTarget) {
        newTargetAuthorization = await authorizeTarget(
          staged.runDirectory,
          expectedTargetPid,
        );
        this.assertLaunchCanSpawn(targetLabel, launchGeneration);
        if (this.releaseTargetAuthorization) {
          throw new Error('a ReShade target rendezvous is already authorized');
        }
        this.releaseTargetAuthorization = newTargetAuthorization;
        newTargetAuthorization = undefined;
        console.log(
          `${RESHADE_CLIENT_TARGET_RENDEZVOUS_AUTHORIZED_MARKER} pid=${expectedTargetPid} path=${JSON.stringify(
            path.join(
              staged.runDirectory,
              OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME,
            ),
          )}`,
        );
      }
    } catch (error) {
      newTargetAuthorization?.();
      await removeStagedRuntime(staged).catch(() => undefined);
      throw error;
    }
    const invocation = buildReShadeInvocation(target, staged.runDirectory);
    const invocationArguments = [...invocation.arguments];
    try {
      this.assertLaunchCanSpawn(targetLabel, launchGeneration);
    } catch (error) {
      this.clearTargetAuthorization();
      await removeStagedRuntime(staged).catch(() => undefined);
      throw error;
    }
    this.latestRunDirectory = staged.runDirectory;
    this.currentRuntime = Object.freeze({
      staged,
      targetLabel,
      launchGeneration,
    });
    console.log(
      `${RESHADE_CLIENT_INJECTOR_STARTED_MARKER} target=${JSON.stringify(targetDescription)} arguments=${JSON.stringify(invocationArguments)}`,
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
          timeout: isPathTarget(target) ? 0 : REQUEST_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (this.activeChild === child) {
            this.activeChild = null;
          }
          void this.finishInjector(
            target,
            targetLabel,
            expectedTargetPid,
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
    let runDirectory: string | undefined;
    try {
      await mkdir(this.config.runsRootDirectory, { recursive: true });
      const runsRootDirectory = await realpath(this.config.runsRootDirectory);
      const safeProcessName = processName.replace(/[^a-zA-Z0-9._-]/g, '-');
      const createdRunDirectory = await mkdtemp(
        path.join(runsRootDirectory, `${safeProcessName}-`),
      );
      runDirectory = createdRunDirectory;
      assertDirectChild(
        runsRootDirectory,
        createdRunDirectory,
        'ReShade run directory',
      );
      const runId = randomUUID();
      const ownership: RunOwnershipMarker = Object.freeze({
        schemaVersion: RUN_MARKER_SCHEMA_VERSION,
        kind: RUN_OWNERSHIP_MARKER_KIND,
        runId,
        directoryName: path.basename(createdRunDirectory),
        createdAt: new Date().toISOString(),
      });
      await writeFile(
        path.join(createdRunDirectory, RUN_OWNERSHIP_MARKER_FILE_NAME),
        `${JSON.stringify(ownership)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );

      const sourceByName = new Map<string, string>([
        [INJECTOR_FILE_NAME, this.config.injectorPath],
        [RUNTIME_FILE_NAME, this.config.runtimePath],
        [BUILD_STAMP_FILE_NAME, this.config.buildStampPath],
        [ADDON_FILE_NAME, this.config.addonPath],
        [CONFIG_FILE_NAME, this.config.configPath],
      ]);
      const stagingResults = await Promise.allSettled(
        RUNTIME_ARTIFACTS.map((fileName) =>
          stageRuntimeArtifact(
            sourceByName.get(fileName)!,
            path.join(createdRunDirectory, fileName),
            fileName === CONFIG_FILE_NAME ||
              fileName === RUNTIME_FILE_NAME ||
              fileName === ADDON_FILE_NAME,
          ),
        ),
      );
      const failedStaging = stagingResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failedStaging) {
        throw failedStaging.reason;
      }

      scheduleRunRetentionSweepAfterCurrentTurn(runsRootDirectory);
      console.log(
        `${RESHADE_CLIENT_RUNTIME_STAGED_MARKER} directory=${JSON.stringify(createdRunDirectory)}`,
      );
      return Object.freeze({
        runId,
        runsRootDirectory,
        runDirectory: createdRunDirectory,
        injectorPath: path.join(createdRunDirectory, INJECTOR_FILE_NAME),
        injectorStdoutPath: path.join(
          createdRunDirectory,
          INJECTOR_STDOUT_FILE_NAME,
        ),
        injectorStderrPath: path.join(
          createdRunDirectory,
          INJECTOR_STDERR_FILE_NAME,
        ),
        reshadeLogPath: path.join(createdRunDirectory, RESHADE_LOG_FILE_NAME),
        runtimeStartupPath: path.join(
          createdRunDirectory,
          RUNTIME_STARTUP_FILE_NAME,
        ),
      });
    } catch (error) {
      if (runDirectory !== undefined) {
        await rm(runDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      if (isReShadeOperationError(error)) {
        throw error;
      }
      throw new ReShadeOperationError({
        message: `unable to stage the isolated ReShade runtime: ${formatUnknownError(error)}`,
        code: 'runtime-staging-failed',
        stage: 'runtime-staging',
        retrySafety: 'definite-safe',
      });
    }
  }

  private async finishInjector(
    target: ReShadeTarget,
    targetLabel: string,
    expectedTargetPid: number | undefined,
    staged: StagedRuntime,
    error: Error | null,
    stdout: string,
    stderr: string,
    didSpawn: boolean,
  ): Promise<ReShadeLaunchResult> {
    const targetDescription = targetDescriptionFor(target);
    const retrySafeBeforeMutation =
      isPathTarget(target) || target.pid !== undefined;
    const hasSuccessMarker = stdout.includes(INJECTOR_SUCCESS_MARKER);
    const parsedResult = parseInjectorResult(stdout);
    const hasResultRecord = parsedResult.kind !== 'none';
    const hasNotStartedProof =
      retrySafeBeforeMutation &&
      !hasSuccessMarker &&
      !hasResultRecord &&
      injectorDidNotStart(stdout);
    const evidence = diagnosticEvidenceForStagedRuntime(staged);
    try {
      await Promise.all([
        writeFile(staged.injectorStdoutPath, stdout, 'utf8'),
        writeFile(staged.injectorStderrPath, stderr, 'utf8'),
      ]);
    } catch (evidenceError) {
      const detail = `ReShade injector completed but its evidence logs could not be preserved: ${formatUnknownError(evidenceError)}`;
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError({
        message: detail,
        code: 'injector-evidence-write-failed',
        stage: 'injector',
        retrySafety:
          hasNotStartedProof || (!didSpawn && error && !hasSuccessMarker)
            ? 'definite-safe'
            : 'indeterminate',
        targetLabel,
        ...(expectedTargetPid === undefined ? {} : { pid: expectedTargetPid }),
        evidence,
      });
    }

    if (this.disposed) {
      const detail =
        'the ReShade launcher was disposed before injector completion';
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError({
        message: detail,
        code: 'operation-cancelled',
        stage: 'lifecycle',
        retrySafety: 'indeterminate',
        targetLabel,
        ...(expectedTargetPid === undefined ? {} : { pid: expectedTargetPid }),
        evidence,
      });
    }

    const parsedDiagnostic = parseInjectorDiagnostic(stdout);
    if (parsedDiagnostic.kind === 'invalid') {
      const detail = `ReShade injector diagnostic protocol was invalid: ${parsedDiagnostic.detail}`;
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError({
        message: detail,
        code: 'injector-result-invalid',
        stage: 'injector',
        retrySafety: hasNotStartedProof ? 'definite-safe' : 'indeterminate',
        targetLabel,
        ...(expectedTargetPid === undefined ? {} : { pid: expectedTargetPid }),
        evidence,
      });
    }
    if (parsedDiagnostic.kind === 'valid') {
      const diagnostic = parsedDiagnostic.diagnostic;
      const diagnosticEvidence =
        diagnostic.modulePath !== undefined &&
        diagnosticReferencesHostRuntime(diagnostic)
          ? diagnosticEvidenceForHostRuntime(staged, diagnostic.modulePath)
          : evidence;
      const isContradictory =
        hasSuccessMarker ||
        hasResultRecord ||
        (diagnostic.stage === 'target-preflight'
          ? !injectorDidNotStart(stdout)
          : injectorDidNotStart(stdout)) ||
        (expectedTargetPid !== undefined &&
          diagnostic.pid !== expectedTargetPid);
      if (isContradictory) {
        const detail =
          'ReShade injector diagnostic contradicted its success, mutation-state, or exact-PID evidence';
        console.error(
          `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
        );
        throw new ReShadeOperationError({
          message: detail,
          code: 'injector-result-invalid',
          stage: 'injector',
          retrySafety: 'indeterminate',
          targetLabel,
          pid: diagnostic.pid,
          evidence,
        });
      }

      const windowsErrorDetail =
        diagnostic.windowsErrorCode === undefined
          ? ''
          : ` with Windows error ${diagnostic.windowsErrorCode}`;
      let detail: string;
      switch (diagnostic.code) {
        case 'target-injection-already-claimed':
          detail = `target pid=${diagnostic.pid} is already claimed by another ReShade injector${windowsErrorDetail}`;
          break;
        case 'target-injection-claim-failed':
          detail = `unable to establish exclusive ReShade injection ownership for target pid=${diagnostic.pid}${windowsErrorDetail}`;
          break;
        case 'target-runtime-conflict':
          detail = `target pid=${diagnostic.pid} already has a loaded ReShade runtime${
            diagnostic.modulePath
              ? ` at ${JSON.stringify(diagnostic.modulePath)}`
              : ''
          }`;
          break;
        case 'target-runtime-incompatible':
          detail = `target pid=${diagnostic.pid} has an incompatible ReShade runtime${
            diagnostic.modulePath
              ? ` at ${JSON.stringify(diagnostic.modulePath)}`
              : ''
          }`;
          break;
        case 'target-runtime-reuse-too-late':
          detail = `target pid=${diagnostic.pid} loaded ReShade too late for safe runtime reuse${
            diagnostic.modulePath
              ? ` at ${JSON.stringify(diagnostic.modulePath)}`
              : ''
          }`;
          break;
        case 'target-runtime-reuse-raced':
          detail = `the loaded ReShade runtime changed while preparing reuse for target pid=${diagnostic.pid}${
            diagnostic.modulePath
              ? ` at ${JSON.stringify(diagnostic.modulePath)}`
              : ''
          }`;
          break;
        case 'target-module-inspection-failed':
          detail = `loaded-module inspection failed for target pid=${diagnostic.pid}${windowsErrorDetail}`;
          break;
        case 'existing-runtime-addon-load-failed':
          detail = `the overlay add-on could not be loaded into the existing ReShade runtime for target pid=${diagnostic.pid}${
            diagnostic.modulePath
              ? ` at ${JSON.stringify(diagnostic.modulePath)}`
              : ''
          }${windowsErrorDetail}`;
          break;
      }
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError({
        message: detail,
        code: diagnostic.code,
        stage:
          diagnostic.stage === 'target-preflight'
            ? 'target-preflight'
            : 'runtime-initialization',
        retrySafety:
          diagnostic.stage === 'target-preflight'
            ? 'definite-safe'
            : 'indeterminate',
        targetLabel,
        pid: diagnostic.pid,
        ...(diagnostic.modulePath === undefined
          ? {}
          : { modulePath: diagnostic.modulePath }),
        ...(diagnostic.windowsErrorCode === undefined
          ? {}
          : { windowsErrorCode: diagnostic.windowsErrorCode }),
        evidence: diagnosticEvidence,
      });
    }

    if (parsedResult.kind === 'invalid') {
      const detail = `ReShade injector result protocol was invalid: ${parsedResult.detail}`;
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError({
        message: detail,
        code: 'injector-result-invalid',
        stage: 'injector',
        retrySafety: 'indeterminate',
        targetLabel,
        ...(expectedTargetPid === undefined ? {} : { pid: expectedTargetPid }),
        evidence,
      });
    }

    if (error) {
      if (parsedResult.kind === 'valid') {
        const detail =
          'ReShade injector reported a structured success result while the injector process failed';
        console.error(
          `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
        );
        throw new ReShadeOperationError({
          message: detail,
          code: 'injector-result-invalid',
          stage: 'injector',
          retrySafety: 'indeterminate',
          targetLabel,
          pid: parsedResult.result.pid,
          evidence,
        });
      }
      const detail = formatLaunchError(error, stdout, stderr);
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError({
        message: detail,
        code: didSpawn ? 'injector-failed' : 'injector-start-failed',
        stage: 'injector',
        retrySafety:
          hasNotStartedProof ||
          (!didSpawn && !hasSuccessMarker && !hasResultRecord)
            ? 'definite-safe'
            : 'indeterminate',
        targetLabel,
        ...(expectedTargetPid === undefined ? {} : { pid: expectedTargetPid }),
        evidence,
      });
    }
    if (parsedResult.kind === 'none') {
      const detail = `ReShade injector stdout did not contain exactly one ${JSON.stringify(INJECTOR_RESULT_PREFIX.trim())} record`;
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError({
        message: detail,
        code: 'injector-result-invalid',
        stage: 'injector',
        retrySafety: hasNotStartedProof ? 'definite-safe' : 'indeterminate',
        targetLabel,
        ...(expectedTargetPid === undefined ? {} : { pid: expectedTargetPid }),
        evidence,
      });
    }
    if (!didSpawn) {
      const detail =
        'ReShade injector reported a structured success result without a confirmed child-process spawn';
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError({
        message: detail,
        code: 'injector-result-invalid',
        stage: 'injector',
        retrySafety: 'indeterminate',
        targetLabel,
        ...(expectedTargetPid === undefined ? {} : { pid: expectedTargetPid }),
        evidence,
      });
    }

    const injectorResult = parsedResult.result;
    const injectorTargetPid = injectorResult.pid;
    if (
      expectedTargetPid !== undefined &&
      injectorTargetPid !== expectedTargetPid
    ) {
      const detail = `ReShade injector selected pid=${injectorTargetPid}; expected pid=${expectedTargetPid}`;
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
      );
      throw new ReShadeOperationError({
        message: detail,
        code: 'injector-result-invalid',
        stage: 'injector',
        retrySafety: 'indeterminate',
        targetLabel,
        pid: injectorTargetPid,
        evidence,
      });
    }

    let selectedPath: string | undefined;
    let processName: string;
    if (isPathTarget(target)) {
      try {
        selectedPath = parseInjectorTargetPath(stdout);
      } catch (parseError) {
        const detail =
          parseError instanceof Error ? parseError.message : String(parseError);
        console.error(
          `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
        );
        throw new ReShadeOperationError({
          message: detail,
          code: 'injector-result-invalid',
          stage: 'injector',
          retrySafety: 'indeterminate',
          targetLabel,
          pid: injectorTargetPid,
          evidence,
        });
      }
      if (!targetPathMatches(selectedPath, target)) {
        const detail = `ReShade injector selected unexpected path=${JSON.stringify(selectedPath)}; expected ${targetPathExpectation(target)}`;
        console.error(
          `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(targetDescription)} detail=${JSON.stringify(detail)}`,
        );
        throw new ReShadeOperationError({
          message: detail,
          code: 'injector-result-invalid',
          stage: 'injector',
          retrySafety: 'indeterminate',
          targetLabel,
          pid: injectorTargetPid,
          evidence,
        });
      }
      processName = path.win32.basename(selectedPath);
    } else {
      processName = target.processName;
    }

    console.log(
      `${RESHADE_CLIENT_INJECTOR_RETURNED_MARKER} target=${JSON.stringify(targetDescription)}`,
    );
    return Object.freeze({
      processName,
      ...(selectedPath === undefined ? {} : { selectedPath }),
      targetLabel,
      injectorTargetPid,
      runtimeMode: injectorResult.runtimeMode,
      ...(injectorResult.runtimeMode === 'existing-runtime'
        ? { hostRuntimePath: injectorResult.runtimeModulePath }
        : {}),
      runDirectory: staged.runDirectory,
      injectorStdoutPath: staged.injectorStdoutPath,
      injectorStderrPath: staged.injectorStderrPath,
      reshadeLogPath:
        injectorResult.runtimeMode === 'existing-runtime'
          ? hostRuntimeLogPath(injectorResult.runtimeModulePath)
          : staged.reshadeLogPath,
      runtimeStartupPath: staged.runtimeStartupPath,
    });
  }

  private disconnectConnectedTarget(target: ConnectedTarget): void {
    if (this.connectedTarget !== target) {
      return;
    }
    console.log(
      `${RESHADE_CLIENT_TARGET_DISCONNECTED_MARKER} pid=${target.pid}`,
    );
    this.retireCurrentRuntime(target.targetLabel);
    this.resetTargetState(target.targetLabel);
  }

  private applyFailureState(
    targetLabel: string,
    error: unknown,
    launchGeneration?: number,
  ): void {
    if (
      launchGeneration !== undefined &&
      error instanceof ReShadeOperationError &&
      error.retrySafety === 'definite-safe'
    ) {
      this.retireCurrentRuntime(targetLabel, launchGeneration);
    }
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

  private retireCurrentRuntime(
    targetLabel: string,
    launchGeneration?: number,
  ): void {
    const current = this.currentRuntime;
    if (
      !current ||
      current.targetLabel !== targetLabel ||
      (launchGeneration !== undefined &&
        current.launchGeneration !== launchGeneration)
    ) {
      return;
    }
    this.currentRuntime = null;
    const { staged } = current;
    void markRunDirectoryReclaimable(staged)
      .then(() => scheduleRunRetentionSweep(staged.runsRootDirectory))
      .catch(async (error) => {
        if (await pathIsMissing(staged.runDirectory)) {
          return;
        }
        console.warn(
          `Unable to retire a completed ReShade run directory: ${formatUnknownError(error)}`,
        );
      });
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
    this.clearTargetAuthorization();
  }

  private clearTargetAuthorization(): void {
    const release = this.releaseTargetAuthorization;
    this.releaseTargetAuthorization = null;
    release?.();
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
      throw new ReShadeOperationError({
        message:
          'the ReShade injection was canceled before the injector started',
        code: 'operation-cancelled',
        stage: 'lifecycle',
        retrySafety: 'definite-safe',
        targetLabel,
      });
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

function createReShadeDiagnostic(
  input: ReShadeDiagnosticInput,
): ReShadeDiagnostic {
  return Object.freeze({
    schemaVersion: 1,
    source: 'electron-game-overlay',
    severity: 'error',
    ...input,
    ...(input.evidence === undefined
      ? {}
      : { evidence: Object.freeze({ ...input.evidence }) }),
  });
}

function diagnosticEvidenceForStagedRuntime(
  staged: StagedRuntime,
): ReShadeDiagnosticEvidence {
  return Object.freeze({
    runDirectory: staged.runDirectory,
    injectorStdoutPath: staged.injectorStdoutPath,
    injectorStderrPath: staged.injectorStderrPath,
    reshadeLogPath: staged.reshadeLogPath,
    runtimeStartupPath: staged.runtimeStartupPath,
  });
}

function diagnosticEvidenceForHostRuntime(
  staged: StagedRuntime,
  runtimeModulePath: string,
): ReShadeDiagnosticEvidence {
  return Object.freeze({
    ...diagnosticEvidenceForStagedRuntime(staged),
    reshadeLogPath: hostRuntimeLogPath(runtimeModulePath),
  });
}

function diagnosticReferencesHostRuntime(
  diagnostic: InjectorDiagnostic,
): boolean {
  if (diagnostic.stage === 'existing-runtime-addon-load') {
    return true;
  }

  switch (diagnostic.code) {
    case 'target-runtime-conflict':
    case 'target-runtime-incompatible':
    case 'target-runtime-reuse-too-late':
    case 'target-runtime-reuse-raced':
      return true;
    default:
      return false;
  }
}

function hostRuntimeLogPath(runtimeModulePath: string): string {
  return path.win32.join(
    path.win32.dirname(runtimeModulePath),
    RESHADE_LOG_FILE_NAME,
  );
}

function diagnosticEvidenceForLaunchResult(
  result: ReShadeLaunchResult,
): ReShadeDiagnosticEvidence {
  return Object.freeze({
    runDirectory: result.runDirectory,
    injectorStdoutPath: result.injectorStdoutPath,
    injectorStderrPath: result.injectorStderrPath,
    reshadeLogPath: result.reshadeLogPath,
    ...(result.runtimeStartupPath === undefined
      ? {}
      : { runtimeStartupPath: result.runtimeStartupPath }),
  });
}

type RuntimeStartupObservation =
  | Readonly<{ kind: 'not-observed' }>
  | Readonly<{ kind: 'invalid-record' }>
  | Readonly<{
      kind: 'record';
      pid: number;
      code: ReShadeRuntimeStartupRecordCode;
    }>;

async function readRuntimeStartupObservation(
  startupPath: string | undefined,
): Promise<RuntimeStartupObservation> {
  if (startupPath === undefined) {
    return Object.freeze({ kind: 'not-observed' });
  }

  let startupFile: Awaited<ReturnType<typeof open>> | undefined;
  let closePromise: Promise<void> | undefined;
  let observationTimedOut = false;
  let observationTimer: ReturnType<typeof setTimeout> | undefined;
  const invalidObservation = Object.freeze({
    kind: 'invalid-record',
  } as const);
  const closeStartupFile = (): Promise<void> => {
    const file = startupFile;
    if (!file) {
      return Promise.resolve();
    }
    closePromise ??= Promise.resolve()
      .then(() => file.close())
      .catch(() => undefined);
    return closePromise;
  };

  const timeoutObservation = new Promise<RuntimeStartupObservation>(
    (resolve) => {
      observationTimer = setTimeout(() => {
        observationTimedOut = true;
        void closeStartupFile();
        resolve(invalidObservation);
      }, RUNTIME_STARTUP_OBSERVATION_TIMEOUT_MS);
    },
  );
  const fileObservation = (async (): Promise<RuntimeStartupObservation> => {
    try {
      startupFile = await open(startupPath, 'r');
      if (observationTimedOut) {
        await closeStartupFile();
        return invalidObservation;
      }

      try {
        const bytes = Buffer.alloc(MAX_RUNTIME_STARTUP_RECORD_BYTES + 1);
        const { bytesRead } = await startupFile.read(bytes, 0, bytes.length, 0);
        if (bytesRead === 0 || bytesRead > MAX_RUNTIME_STARTUP_RECORD_BYTES) {
          return invalidObservation;
        }

        const recordText = bytes.subarray(0, bytesRead).toString('utf8');
        if (!hasCanonicalRuntimeStartupFields(recordText)) {
          return invalidObservation;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(recordText);
        } catch {
          return invalidObservation;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return invalidObservation;
        }

        const candidate = parsed as Record<string, unknown>;
        if (
          !hasExactObjectKeys(candidate, RUNTIME_STARTUP_RECORD_KEYS) ||
          candidate.schemaVersion !== 1 ||
          candidate.source !== 'electron-game-overlay-runtime' ||
          !isValidProcessPid(candidate.pid) ||
          typeof candidate.code !== 'string' ||
          !runtimeStartupRecordCodes.has(candidate.code)
        ) {
          return invalidObservation;
        }

        return Object.freeze({
          kind: 'record',
          pid: candidate.pid,
          code: candidate.code as ReShadeRuntimeStartupRecordCode,
        });
      } catch {
        return invalidObservation;
      } finally {
        await closeStartupFile();
      }
    } catch (error) {
      if (observationTimedOut) {
        return invalidObservation;
      }
      return Object.freeze({
        kind: hasNodeErrorCode(error, 'ENOENT')
          ? 'not-observed'
          : 'invalid-record',
      });
    }
  })();

  try {
    return await Promise.race([fileObservation, timeoutObservation]);
  } finally {
    if (observationTimer !== undefined) {
      clearTimeout(observationTimer);
    }
  }
}

function hasCanonicalRuntimeStartupFields(recordText: string): boolean {
  if (recordText.includes('\\')) {
    return false;
  }
  return RUNTIME_STARTUP_RECORD_KEYS.every((key) => {
    const matches = recordText.match(new RegExp(`"${key}"\\s*:`, 'g'));
    return matches?.length === 1;
  });
}

function runtimeStartupCodeForObservation(
  observation: RuntimeStartupObservation,
  expectedPid: number | undefined,
): ReShadeRuntimeStartupCode {
  if (observation.kind !== 'record') {
    return observation.kind;
  }
  if (expectedPid === undefined) {
    return 'pid-unavailable';
  }
  if (observation.pid !== expectedPid) {
    return 'pid-mismatch';
  }
  return observation.code;
}

function runtimeStartupDescription(code: ReShadeRuntimeStartupCode): string {
  switch (code) {
    case 'bridge-thread-create-failed':
      return 'the runtime could not create its bridge thread';
    case 'bridge-thread-started':
      return 'the runtime bridge thread started, but target authentication was not observed';
    case 'bridge-window-create-failed':
      return 'the runtime could not create its bridge window';
    case 'bridge-window-ready':
      return 'the runtime bridge window was ready, but target authentication was not observed';
    case 'discovery-not-ready':
      return 'the overlay transport discovery document was not ready';
    case 'discovery-document-invalid':
      return 'the overlay transport discovery document was invalid';
    case 'discovery-version-mismatch':
      return 'the overlay transport discovery version did not match';
    case 'discovery-target-mismatch':
      return 'the overlay transport discovery document did not authorize the selected target';
    case 'loopback-connect-failed':
      return 'the runtime could not connect to the overlay transport';
    case 'loopback-configuration-failed':
      return 'the runtime could not configure its overlay transport connection';
    case 'process-hello-build-failed':
      return 'the runtime could not build its authenticated process greeting';
    case 'network-worker-start-failed':
      return 'the runtime could not start its network worker';
    case 'network-worker-started':
      return 'the runtime network worker started, but target authentication was not observed';
    case 'network-connection-lost':
      return 'the runtime lost its overlay transport connection before target authentication';
    case 'bridge-message-pump-failed':
      return 'the runtime bridge message pump failed';
    case 'not-observed':
      return 'no runtime startup record was observed';
    case 'invalid-record':
      return 'the runtime startup record was invalid';
    case 'pid-mismatch':
      return 'the runtime startup record did not belong to the selected target PID';
    case 'pid-unavailable':
      return 'the selected target PID was unavailable for startup-record validation';
  }
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

async function stageRuntimeArtifact(
  sourcePath: string,
  destinationPath: string,
  requiresPrivateCopy: boolean,
): Promise<void> {
  // ReShade.ini is mutable, while the injector adjusts the loaded payload's
  // ACL. The payload is ReShade64.dll for a new runtime and the add-on when
  // reusing a compatible runtime, so all three need a private file record.
  if (!requiresPrivateCopy) {
    try {
      await link(sourcePath, destinationPath);
      return;
    } catch {
      // Cross-volume and filesystems without hard-link support retain the
      // portable copy behavior. Each run still owns its directory and logs.
    }
  }
  await copyFile(sourcePath, destinationPath);
}

async function removeStagedRuntime(staged: StagedRuntime): Promise<void> {
  assertDirectChild(
    staged.runsRootDirectory,
    staged.runDirectory,
    'ReShade run directory',
  );
  await rm(staged.runDirectory, { recursive: true, force: true });
}

async function markRunDirectoryReclaimable(
  staged: StagedRuntime,
): Promise<void> {
  await assertCanonicalDirectChildDirectory(
    staged.runsRootDirectory,
    staged.runDirectory,
    'ReShade run directory',
  );
  const directoryName = path.basename(staged.runDirectory);
  const ownership = await readRunOwnershipMarker(
    staged.runDirectory,
    directoryName,
  );
  if (!ownership || ownership.runId !== staged.runId) {
    throw new Error(
      'the ReShade run ownership marker no longer matches the staged runtime',
    );
  }

  const reclaimable: RunReclaimableMarker = Object.freeze({
    schemaVersion: RUN_MARKER_SCHEMA_VERSION,
    kind: RUN_RECLAIMABLE_MARKER_KIND,
    runId: staged.runId,
    directoryName,
    retiredAt: new Date().toISOString(),
  });
  const markerPath = path.join(
    staged.runDirectory,
    RUN_RECLAIMABLE_MARKER_FILE_NAME,
  );
  try {
    await writeFile(markerPath, `${JSON.stringify(reclaimable)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (!isErrnoException(error, 'EEXIST')) {
      throw error;
    }
    const existing = await readRunReclaimableMarker(
      staged.runDirectory,
      directoryName,
    );
    if (!existing || existing.runId !== reclaimable.runId) {
      throw new Error(
        'the ReShade run reclaimable marker already exists with unexpected contents',
      );
    }
  }
}

function scheduleRunRetentionSweep(runsRootDirectory: string): Promise<void> {
  const retentionKey = path.resolve(runsRootDirectory).toLowerCase();
  const existing = runRetentionSweeps.get(retentionKey);
  if (existing) {
    existing.rescanRequested = true;
    return existing.promise;
  }

  const state: RunRetentionSweepState = {
    rescanRequested: false,
    promise: Promise.resolve(),
  };
  const sweep = (async () => {
    do {
      state.rescanRequested = false;
      try {
        await pruneReclaimableRunDirectories(runsRootDirectory);
      } catch (error) {
        if (!(await pathIsMissing(runsRootDirectory))) {
          console.warn(
            `Unable to scan completed ReShade run directories: ${formatUnknownError(error)}`,
          );
        }
      }
    } while (state.rescanRequested);
  })().finally(() => {
    if (runRetentionSweeps.get(retentionKey) === state) {
      runRetentionSweeps.delete(retentionKey);
    }
  });
  state.promise = sweep;
  runRetentionSweeps.set(retentionKey, state);
  return sweep;
}

function scheduleRunRetentionSweepAfterCurrentTurn(
  runsRootDirectory: string,
): void {
  const scheduledSweep = setImmediate(() => {
    void scheduleRunRetentionSweep(runsRootDirectory);
  });
  scheduledSweep.unref();
}

async function pruneReclaimableRunDirectories(
  runsRootDirectory: string,
): Promise<void> {
  const entries = await readdir(runsRootDirectory, { withFileTypes: true });
  const candidates: ReclaimableRunDirectory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const candidate = await readReclaimableRunDirectory(
      runsRootDirectory,
      entry.name,
    );
    if (candidate) {
      candidates.push(candidate);
    }
  }

  candidates.sort(
    (left, right) =>
      right.retiredAtMs - left.retiredAtMs ||
      right.reclaimable.directoryName.localeCompare(
        left.reclaimable.directoryName,
      ),
  );
  const now = Date.now();
  const directoriesToRemove = candidates.filter(
    (candidate, index) =>
      now - candidate.retiredAtMs >= RUN_RETENTION_MAX_AGE_MS ||
      index >= RUN_RETENTION_MAX_DIRECTORIES,
  );

  let removedCount = 0;
  for (const candidate of directoriesToRemove) {
    const quarantineDirectory = path.join(
      candidate.runsRootDirectory,
      `.electron-game-overlay-retired-${randomUUID()}`,
    );
    try {
      const verified = await readReclaimableRunDirectory(
        candidate.runsRootDirectory,
        candidate.reclaimable.directoryName,
      );
      if (
        !verified ||
        verified.ownership.runId !== candidate.ownership.runId ||
        verified.reclaimable.retiredAt !== candidate.reclaimable.retiredAt
      ) {
        continue;
      }
      assertDirectChild(
        candidate.runsRootDirectory,
        quarantineDirectory,
        'ReShade retention quarantine directory',
      );
      try {
        await rename(verified.runDirectory, quarantineDirectory);
      } catch (error) {
        if (isErrnoException(error, 'ENOENT')) {
          continue;
        }
        throw error;
      }
      const quarantined = await readReclaimableRunDirectoryAt(
        candidate.runsRootDirectory,
        quarantineDirectory,
        candidate.reclaimable.directoryName,
      );
      if (
        !quarantined ||
        quarantined.ownership.runId !== candidate.ownership.runId ||
        quarantined.reclaimable.retiredAt !== candidate.reclaimable.retiredAt
      ) {
        await restoreQuarantinedRunDirectory(
          quarantineDirectory,
          verified.runDirectory,
        );
        continue;
      }
      try {
        await rm(quarantined.runDirectory, { recursive: true, force: true });
      } catch (error) {
        await restoreQuarantinedRunDirectory(
          quarantineDirectory,
          verified.runDirectory,
        );
        throw error;
      }
      removedCount += 1;
    } catch (error) {
      console.warn(
        `Unable to remove completed ReShade run directory ${JSON.stringify(candidate.runDirectory)}: ${formatUnknownError(error)}`,
      );
    }
  }

  if (removedCount > 0) {
    console.log(
      `${RESHADE_CLIENT_RUN_RETENTION_PRUNED_MARKER} root=${JSON.stringify(runsRootDirectory)} count=${removedCount}`,
    );
  }
}

async function readReclaimableRunDirectory(
  runsRootDirectory: string,
  directoryName: string,
): Promise<ReclaimableRunDirectory | undefined> {
  return readReclaimableRunDirectoryAt(
    runsRootDirectory,
    path.join(runsRootDirectory, directoryName),
    directoryName,
  );
}

async function readReclaimableRunDirectoryAt(
  runsRootDirectory: string,
  runDirectory: string,
  markerDirectoryName: string,
): Promise<ReclaimableRunDirectory | undefined> {
  try {
    await assertCanonicalDirectChildDirectory(
      runsRootDirectory,
      runDirectory,
      'ReShade retained run directory',
    );
    const [ownership, reclaimable] = await Promise.all([
      readRunOwnershipMarker(runDirectory, markerDirectoryName),
      readRunReclaimableMarker(runDirectory, markerDirectoryName),
    ]);
    if (!ownership || !reclaimable || ownership.runId !== reclaimable.runId) {
      return undefined;
    }
    return Object.freeze({
      runsRootDirectory,
      runDirectory,
      ownership,
      reclaimable,
      retiredAtMs: Date.parse(reclaimable.retiredAt),
    });
  } catch {
    return undefined;
  }
}

async function restoreQuarantinedRunDirectory(
  quarantineDirectory: string,
  originalRunDirectory: string,
): Promise<void> {
  try {
    await rename(quarantineDirectory, originalRunDirectory);
  } catch (error) {
    console.warn(
      `Unable to restore a ReShade run directory after retention validation failed; preserved at ${JSON.stringify(quarantineDirectory)}: ${formatUnknownError(error)}`,
    );
  }
}

async function readRunOwnershipMarker(
  runDirectory: string,
  directoryName: string,
): Promise<RunOwnershipMarker | undefined> {
  const value = await readJsonFile(
    path.join(runDirectory, RUN_OWNERSHIP_MARKER_FILE_NAME),
  );
  if (
    !isJsonRecord(value) ||
    value.schemaVersion !== RUN_MARKER_SCHEMA_VERSION ||
    value.kind !== RUN_OWNERSHIP_MARKER_KIND ||
    !isRunId(value.runId) ||
    value.directoryName !== directoryName ||
    !isCanonicalIsoTimestamp(value.createdAt)
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: RUN_MARKER_SCHEMA_VERSION,
    kind: RUN_OWNERSHIP_MARKER_KIND,
    runId: value.runId,
    directoryName: value.directoryName,
    createdAt: value.createdAt,
  });
}

async function readRunReclaimableMarker(
  runDirectory: string,
  directoryName: string,
): Promise<RunReclaimableMarker | undefined> {
  const value = await readJsonFile(
    path.join(runDirectory, RUN_RECLAIMABLE_MARKER_FILE_NAME),
  );
  if (
    !isJsonRecord(value) ||
    value.schemaVersion !== RUN_MARKER_SCHEMA_VERSION ||
    value.kind !== RUN_RECLAIMABLE_MARKER_KIND ||
    !isRunId(value.runId) ||
    value.directoryName !== directoryName ||
    !isCanonicalIsoTimestamp(value.retiredAt)
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: RUN_MARKER_SCHEMA_VERSION,
    kind: RUN_RECLAIMABLE_MARKER_KIND,
    runId: value.runId,
    directoryName: value.directoryName,
    retiredAt: value.retiredAt,
  });
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isErrnoException(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

async function pathIsMissing(candidatePath: string): Promise<boolean> {
  try {
    await realpath(candidatePath);
    return false;
  } catch (error) {
    return isErrnoException(error, 'ENOENT');
  }
}

async function assertCanonicalDirectChildDirectory(
  parentDirectory: string,
  childPath: string,
  label: string,
): Promise<void> {
  assertDirectChild(parentDirectory, childPath, label);
  const resolvedChild = path.resolve(childPath);
  const canonicalChild = await realpath(resolvedChild);
  if (canonicalChild.toLowerCase() !== resolvedChild.toLowerCase()) {
    throw new Error(`${label} is not a canonical direct child`);
  }
  assertDirectChild(parentDirectory, canonicalChild, label);
}

function targetLabelFor(target: ReShadeTarget): string {
  validateTarget(target);
  if (isPathTarget(target)) {
    const exclusions = normalizedExcludedProcessNames(target);
    return [
      `path-contains:${normalizePathForMatch(target.pathContains)}`,
      ...(exclusions.length === 0 ? [] : [`exclude:${exclusions.join(',')}`]),
    ].join(':');
  }
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
  if (isPathTarget(target)) {
    if (configuredExpectedTargetPid !== undefined) {
      throw new Error(
        'a ReShade path watcher cannot use a configured expected target PID',
      );
    }
    return undefined;
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

function snapshotTarget(
  target: ReShadeTarget,
  configuredExpectedTargetPid: number | undefined,
): readonly [ReShadeTarget, number | undefined] {
  const expectedTargetPid = effectiveExpectedTargetPid(
    target,
    configuredExpectedTargetPid,
  );
  if (isPathTarget(target)) {
    return [
      Object.freeze({
        pathContains: target.pathContains,
        ...(target.excludedProcessNames === undefined
          ? {}
          : {
              excludedProcessNames: Object.freeze([
                ...target.excludedProcessNames,
              ]),
            }),
      }),
      undefined,
    ];
  }
  return [
    Object.freeze({
      processName: target.processName,
      ...(expectedTargetPid === undefined ? {} : { pid: expectedTargetPid }),
    }),
    expectedTargetPid,
  ];
}

function parseInjectorTargetPath(stdout: string): string {
  const match = INJECTOR_TARGET_PATH_PATTERN.exec(stdout);
  const selectedPath = match?.[1]?.trim();
  if (!selectedPath || !path.win32.isAbsolute(selectedPath)) {
    throw new Error(
      'ReShade injector stdout did not contain a valid matched executable path',
    );
  }
  return selectedPath;
}

function parseInjectorResult(
  stdout: string,
):
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'invalid'; detail: string }>
  | Readonly<{ kind: 'valid'; result: InjectorResult }> {
  const records = prefixedInjectorRecords(stdout, INJECTOR_RESULT_PREFIX);
  if (records.length === 0) {
    return Object.freeze({ kind: 'none' });
  }
  if (records.length !== 1) {
    return Object.freeze({
      kind: 'invalid',
      detail: `expected one result record, received ${records.length}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(records[0]);
  } catch {
    return Object.freeze({
      kind: 'invalid',
      detail: 'result record was not valid JSON',
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.freeze({
      kind: 'invalid',
      detail: 'result record was not an object',
    });
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    !isValidProcessPid(candidate.pid) ||
    (candidate.runtimeMode !== 'injected-runtime' &&
      candidate.runtimeMode !== 'existing-runtime')
  ) {
    return Object.freeze({
      kind: 'invalid',
      detail: 'result record did not match schema version 1',
    });
  }

  if (candidate.runtimeMode === 'injected-runtime') {
    if (
      !hasExactObjectKeys(candidate, ['schemaVersion', 'pid', 'runtimeMode'])
    ) {
      return Object.freeze({
        kind: 'invalid',
        detail:
          'injected-runtime result contained contradictory or unexpected fields',
      });
    }
    return Object.freeze({
      kind: 'valid',
      result: Object.freeze({
        schemaVersion: 1,
        pid: candidate.pid,
        runtimeMode: 'injected-runtime',
      }),
    });
  }

  if (
    !hasExactObjectKeys(candidate, [
      'hostAbi',
      'pid',
      'runtimeMode',
      'runtimeModulePath',
      'schemaVersion',
    ]) ||
    typeof candidate.runtimeModulePath !== 'string' ||
    !path.win32.isAbsolute(candidate.runtimeModulePath) ||
    candidate.runtimeModulePath.includes('\0') ||
    candidate.hostAbi !== 1
  ) {
    return Object.freeze({
      kind: 'invalid',
      detail:
        'existing-runtime result requires an absolute runtime module path and host ABI 1',
    });
  }
  return Object.freeze({
    kind: 'valid',
    result: Object.freeze({
      schemaVersion: 1,
      pid: candidate.pid,
      runtimeMode: 'existing-runtime',
      runtimeModulePath: candidate.runtimeModulePath,
      hostAbi: 1,
    }),
  });
}

function parseInjectorDiagnostic(
  stdout: string,
):
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'invalid'; detail: string }>
  | Readonly<{ kind: 'valid'; diagnostic: InjectorDiagnostic }> {
  const records = prefixedInjectorRecords(stdout, INJECTOR_DIAGNOSTIC_PREFIX);

  if (records.length === 0) {
    return Object.freeze({ kind: 'none' });
  }
  if (records.length !== 1) {
    return Object.freeze({
      kind: 'invalid',
      detail: `expected one diagnostic record, received ${records.length}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(records[0]);
  } catch {
    return Object.freeze({
      kind: 'invalid',
      detail: 'diagnostic record was not valid JSON',
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.freeze({
      kind: 'invalid',
      detail: 'diagnostic record was not an object',
    });
  }

  const candidate = parsed as Record<string, unknown>;
  const code = candidate.code;
  const modulePath = candidate.modulePath;
  const windowsErrorCode = candidate.windowsErrorCode;
  const isPreflightDiagnostic =
    candidate.stage === 'target-preflight' &&
    (code === 'target-injection-already-claimed' ||
      code === 'target-injection-claim-failed' ||
      code === 'target-runtime-conflict' ||
      code === 'target-runtime-incompatible' ||
      code === 'target-runtime-reuse-too-late' ||
      code === 'target-runtime-reuse-raced' ||
      code === 'target-module-inspection-failed') &&
    candidate.injectionStarted === false;
  const isExistingRuntimeAddonLoadDiagnostic =
    candidate.stage === 'existing-runtime-addon-load' &&
    code === 'existing-runtime-addon-load-failed' &&
    candidate.injectionStarted === true;
  if (
    candidate.schemaVersion !== 1 ||
    (!isPreflightDiagnostic && !isExistingRuntimeAddonLoadDiagnostic) ||
    !isValidProcessPid(candidate.pid) ||
    (modulePath !== undefined &&
      (typeof modulePath !== 'string' || modulePath.length === 0)) ||
    (windowsErrorCode !== undefined &&
      (!Number.isSafeInteger(windowsErrorCode) ||
        (windowsErrorCode as number) < 0 ||
        (windowsErrorCode as number) > 0xffffffff))
  ) {
    return Object.freeze({
      kind: 'invalid',
      detail: 'diagnostic record did not match schema version 1',
    });
  }

  if (isExistingRuntimeAddonLoadDiagnostic) {
    return Object.freeze({
      kind: 'valid',
      diagnostic: Object.freeze({
        schemaVersion: 1,
        stage: 'existing-runtime-addon-load',
        code: 'existing-runtime-addon-load-failed',
        pid: candidate.pid,
        injectionStarted: true,
        ...(modulePath === undefined ? {} : { modulePath }),
        ...(windowsErrorCode === undefined
          ? {}
          : { windowsErrorCode: windowsErrorCode as number }),
      }),
    });
  }

  return Object.freeze({
    kind: 'valid',
    diagnostic: Object.freeze({
      schemaVersion: 1,
      stage: 'target-preflight',
      code: code as InjectorPreflightDiagnostic['code'],
      pid: candidate.pid,
      injectionStarted: false,
      ...(modulePath === undefined ? {} : { modulePath }),
      ...(windowsErrorCode === undefined
        ? {}
        : { windowsErrorCode: windowsErrorCode as number }),
    }),
  });
}

function prefixedInjectorRecords(stdout: string, prefix: string): string[] {
  const records: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      records.push(line.slice(prefix.length));
    }
  }
  return records;
}

function hasExactObjectKeys(
  candidate: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(candidate).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
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

function targetPathMatches(targetPath: string, target: ReShadeTarget): boolean {
  if (isPathTarget(target)) {
    const normalizedName = path.win32.basename(targetPath).toLowerCase();
    return (
      normalizePathForMatch(targetPath).includes(
        normalizePathForMatch(target.pathContains),
      ) && !normalizedExcludedProcessNames(target).includes(normalizedName)
    );
  }
  return (
    path.win32.basename(targetPath).toLowerCase() ===
    target.processName.toLowerCase()
  );
}

function targetPathExpectation(target: ReShadeTarget): string {
  return isPathTarget(target)
    ? `path fragment=${JSON.stringify(target.pathContains)} excluding=${JSON.stringify(target.excludedProcessNames ?? [])}`
    : `basename=${JSON.stringify(target.processName)}`;
}

function targetDescriptionFor(target: ReShadeTarget): string {
  return isPathTarget(target)
    ? `path contains ${target.pathContains}${
        target.excludedProcessNames?.length
          ? ` excluding ${target.excludedProcessNames.join(', ')}`
          : ''
      }`
    : target.processName;
}

function targetStageName(target: ReShadeTarget): string {
  return isPathTarget(target) ? 'path-watch' : target.processName;
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\//g, '\\').toLowerCase();
}

function normalizedExcludedProcessNames(
  target: ReShadePathTarget,
): readonly string[] {
  return (target.excludedProcessNames ?? [])
    .map((processName) => processName.toLowerCase())
    .sort();
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
  if (isPathTarget(target)) {
    if (
      target.pathContains.length === 0 ||
      target.pathContains !== target.pathContains.trim() ||
      target.pathContains.includes('\0') ||
      !/[\\/]/.test(target.pathContains)
    ) {
      throw new Error(
        'the ReShade target path fragment must contain a path separator and no surrounding whitespace',
      );
    }
    const normalizedExclusions = new Set<string>();
    for (const processName of target.excludedProcessNames ?? []) {
      validateProcessName(processName);
      const normalizedName = processName.toLowerCase();
      if (normalizedExclusions.has(normalizedName)) {
        throw new Error(
          'the ReShade target path exclusions must not contain duplicate process names',
        );
      }
      normalizedExclusions.add(normalizedName);
    }
    return;
  }
  validateProcessName(target.processName);
  if (target.pid !== undefined && !isValidProcessPid(target.pid)) {
    throw new Error('the ReShade target PID must be a positive uint32 integer');
  }
}

function isPathTarget(target: ReShadeTarget): target is ReShadePathTarget {
  return 'pathContains' in target;
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
