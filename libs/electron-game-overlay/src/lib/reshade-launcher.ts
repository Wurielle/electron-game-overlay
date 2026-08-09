import { execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import {
  copyFile,
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
import {
  ExistingReShadeInstallationError,
  inspectLoadedOfficialReShadeAddon,
  prepareExistingReShadeAddon,
  type PrepareExistingReShadeAddonOptions,
  type PrepareExistingReShadeAddonResult,
} from './existing-reshade-installation.js';
import { OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME } from './overlay-loopback-transport.js';
import {
  authorizeOverlaySessionGlobalTarget,
  authorizeOverlaySessionTarget,
  type OverlaySessionTargetAuthorization,
  type OverlaySession,
} from './overlay-session.js';
import type { NativeRuntimeProviderMetadata } from './native.js';

const RESHADE_OPT_IN_FLAG = '--reshade-overlay';
const RESHADE_RUNTIME_DIRECTORY_OPTION = '--reshade-runtime-dir';
const RESHADE_AUTO_TARGET_PROCESS_OPTION = '--reshade-auto-target-process';
const RESHADE_EXPECTED_TARGET_PID_OPTION = '--reshade-expected-target-pid';
const INJECTOR_FILE_NAME = 'inject.exe';
const X86_INJECTOR_FILE_NAME = 'inject32.exe';
const ADDON_MANAGER_FILE_NAME = 'electron_game_overlay_reshade_manager.exe';
const X86_ADDON_MANAGER_FILE_NAME =
  'electron_game_overlay_reshade_manager32.exe';
const RUNTIME_FILE_NAME = 'ReShade64.dll';
const X86_RUNTIME_FILE_NAME = 'ReShade32.dll';
const BUILD_STAMP_FILE_NAME = 'ReShade64.build.json';
const X86_BUILD_STAMP_FILE_NAME = 'ReShade32.build.json';
const PACKAGE_BUILD_STAMP_FILE_NAME =
  'electron_game_overlay_runtime.build.json';
const X86_PACKAGE_BUILD_STAMP_FILE_NAME =
  'electron_game_overlay_runtime32.build.json';
const ADDON_FILE_NAME = 'electron_game_overlay.addon64';
const X86_ADDON_FILE_NAME = 'electron_game_overlay.addon32';
const CONFIG_FILE_NAME = 'ReShade.ini';
const INJECTOR_STDOUT_FILE_NAME = 'inject.stdout.log';
const INJECTOR_STDERR_FILE_NAME = 'inject.stderr.log';
const RESHADE_LOG_FILE_NAME = 'ReShade.log';
const RUNTIME_STARTUP_FILE_NAME = '.electron-game-overlay-runtime-startup.json';
const INJECTOR_SUCCESS_MARKER = 'Injecting ReShade ... Succeeded!';
const INJECTOR_NOT_STARTED_MARKER = 'ReShade injection not started.';
const PATH_WATCHER_READY_MARKER = 'ReShade path watcher armed.';
const PROCESS_WATCHER_READY_MARKER = 'ReShade process watcher armed.';
const INJECTOR_DIAGNOSTIC_PREFIX = 'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ';
const INJECTOR_RESULT_PREFIX = 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ';
const WINDOWS_ERROR_IMAGE_MACHINE_TYPE_MISMATCH = 706;
const OFFICIAL_ADDON_BUILD_ID = 'F2A88AD705204DBB8E18D86E7147A13C';
const RUNTIME_PACKAGE_BUILD_STAMP_SCHEMA_VERSION = 3;
// Schema 2 shipped before provider metadata. Keep accepting it permanently as
// generation 1 / target transport 1 so copied runtime-directory overrides do
// not acquire the version of the SDK process that happens to load them.
const LEGACY_RUNTIME_PACKAGE_BUILD_STAMP_SCHEMA_VERSION = 2;
const RUNTIME_PACKAGE_BUILD_STAMP_KIND = 'electron-game-overlay-runtime-build';
const RUNTIME_PACKAGE_BUILD_CONFIGURATION = 'RelWithDebInfo';
const RUNTIME_PACKAGE_MANAGER_PROTOCOL_SCHEMA_VERSION = 1;
const MAX_RUNTIME_PACKAGE_BUILD_STAMP_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const TARGET_PROOF_TIMEOUT_MS = 120_000;
const PATH_TARGET_PROOF_TIMEOUT_MS = 10_000;
const OFFICIAL_ADDON_STARTUP_GRACE_MS = 30_000;
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

const RUNTIME_ARTIFACTS = Object.freeze([
  INJECTOR_FILE_NAME,
  X86_INJECTOR_FILE_NAME,
  ADDON_MANAGER_FILE_NAME,
  X86_ADDON_MANAGER_FILE_NAME,
  RUNTIME_FILE_NAME,
  X86_RUNTIME_FILE_NAME,
  BUILD_STAMP_FILE_NAME,
  X86_BUILD_STAMP_FILE_NAME,
  PACKAGE_BUILD_STAMP_FILE_NAME,
  X86_PACKAGE_BUILD_STAMP_FILE_NAME,
  ADDON_FILE_NAME,
  X86_ADDON_FILE_NAME,
  CONFIG_FILE_NAME,
] as const);

const LEGACY_RUNTIME_PACKAGE_BUILD_STAMP_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'platform',
  'configuration',
  'addonBuildId',
  'managerProtocolSchemaVersion',
  'managerSourceSha256',
  'managerSha256',
  'addonSha256',
  'injectorSha256',
  'reshadeRuntimeSha256',
  'reshadeConfigSha256',
  'reshadeBuildStampSha256',
] as const);

const RUNTIME_PACKAGE_BUILD_STAMP_KEYS = Object.freeze([
  ...LEGACY_RUNTIME_PACKAGE_BUILD_STAMP_KEYS,
  'runtimeGeneration',
  'targetTransportMin',
  'targetTransportMax',
] as const);

const LEGACY_RUNTIME_PROVIDER_METADATA: NativeRuntimeProviderMetadata =
  Object.freeze({
    runtimeGeneration: 1,
    targetTransportMin: 1,
    targetTransportMax: 1,
  });

type RuntimePackageBuildStampHashKey =
  | 'managerSha256'
  | 'addonSha256'
  | 'injectorSha256'
  | 'reshadeRuntimeSha256'
  | 'reshadeConfigSha256'
  | 'reshadeBuildStampSha256';

type RuntimePackageBuildStampCommon = Readonly<{
  kind: typeof RUNTIME_PACKAGE_BUILD_STAMP_KIND;
  platform: 'win32-x64' | 'win32-ia32';
  configuration: typeof RUNTIME_PACKAGE_BUILD_CONFIGURATION;
  addonBuildId: string;
  managerProtocolSchemaVersion: 1;
  managerSourceSha256: string;
  managerSha256: string;
  addonSha256: string;
  injectorSha256: string;
  reshadeRuntimeSha256: string;
  reshadeConfigSha256: string;
  reshadeBuildStampSha256: string;
}>;

type RuntimePackageBuildStamp =
  | (RuntimePackageBuildStampCommon &
      Readonly<{
        schemaVersion: 2;
      }>)
  | (RuntimePackageBuildStampCommon &
      Readonly<{
        schemaVersion: 3;
        runtimeGeneration: number;
        targetTransportMin: number;
        targetTransportMax: number;
      }>);

type RuntimePackageBuildStampSpec = Readonly<{
  label: string;
  manifestFileName: string;
  platform: RuntimePackageBuildStamp['platform'];
  artifacts: readonly Readonly<{
    hashKey: RuntimePackageBuildStampHashKey;
    fileName: string;
  }>[];
}>;

const RUNTIME_PACKAGE_BUILD_STAMP_SPECS: readonly RuntimePackageBuildStampSpec[] =
  Object.freeze([
    Object.freeze({
      label: 'x64 Electron Game Overlay runtime package build stamp',
      manifestFileName: PACKAGE_BUILD_STAMP_FILE_NAME,
      platform: 'win32-x64',
      artifacts: Object.freeze([
        Object.freeze({
          hashKey: 'managerSha256',
          fileName: ADDON_MANAGER_FILE_NAME,
        }),
        Object.freeze({ hashKey: 'addonSha256', fileName: ADDON_FILE_NAME }),
        Object.freeze({
          hashKey: 'injectorSha256',
          fileName: INJECTOR_FILE_NAME,
        }),
        Object.freeze({
          hashKey: 'reshadeRuntimeSha256',
          fileName: RUNTIME_FILE_NAME,
        }),
        Object.freeze({
          hashKey: 'reshadeConfigSha256',
          fileName: CONFIG_FILE_NAME,
        }),
        Object.freeze({
          hashKey: 'reshadeBuildStampSha256',
          fileName: BUILD_STAMP_FILE_NAME,
        }),
      ]),
    }),
    Object.freeze({
      label: 'x86 Electron Game Overlay runtime package build stamp',
      manifestFileName: X86_PACKAGE_BUILD_STAMP_FILE_NAME,
      platform: 'win32-ia32',
      artifacts: Object.freeze([
        Object.freeze({
          hashKey: 'managerSha256',
          fileName: X86_ADDON_MANAGER_FILE_NAME,
        }),
        Object.freeze({
          hashKey: 'addonSha256',
          fileName: X86_ADDON_FILE_NAME,
        }),
        Object.freeze({
          hashKey: 'injectorSha256',
          fileName: X86_INJECTOR_FILE_NAME,
        }),
        Object.freeze({
          hashKey: 'reshadeRuntimeSha256',
          fileName: X86_RUNTIME_FILE_NAME,
        }),
        Object.freeze({
          hashKey: 'reshadeConfigSha256',
          fileName: CONFIG_FILE_NAME,
        }),
        Object.freeze({
          hashKey: 'reshadeBuildStampSha256',
          fileName: X86_BUILD_STAMP_FILE_NAME,
        }),
      ]),
    }),
  ]);

/** Selects a target by executable name, optionally with an exact identity. */
export type ReShadeProcessTarget = Readonly<{
  /** Windows executable basename, including the `.exe` extension. */
  processName: string;
  /**
   * Exact process identifier supplied near process creation. When omitted, the
   * launcher arms a name watcher and must be started before the target.
   */
  pid?: number;
  /**
   * Canonical executable path observed by a trusted process watcher. When
   * supplied, the launcher can safely prepare its uniquely named add-on for a
   * recognized official ReShade installation without guessing target paths.
   * This is accepted only together with an exact PID.
   */
  executablePath?: string;
}>;

/** Selects the first newly created executable whose full path contains a fragment. */
export type ReShadePathTarget = Readonly<{
  /** Case-insensitive path fragment containing at least one path separator. */
  pathContains: string;
  /** Executable basenames ignored by this watcher. */
  excludedProcessNames?: readonly string[];
}>;

/** Target selector accepted by {@link ReShadeOverlayLauncher.attach}. */
export type ReShadeTarget = ReShadeProcessTarget | ReShadePathTarget;

type ExactReShadeProcessTarget = ReShadeProcessTarget &
  Readonly<{
    pid: number;
    executablePath: string;
  }>;

/** Validated runtime paths and optional startup hints used by a launcher. */
export type ReShadeLaunchConfig = Readonly<{
  /** Canonical directory containing the packaged runtime artifacts. */
  runtimeDirectory: string;
  /** Writable parent directory for isolated per-attachment runs. */
  runsRootDirectory: string;
  /** Canonical x64 injector path. */
  injectorPath: string;
  /** Canonical x86 injector path. */
  x86InjectorPath: string;
  /** Canonical x64 official-ReShade add-on manager path. */
  addonManagerPath: string;
  /** Canonical x86 official-ReShade add-on manager path. */
  x86AddonManagerPath: string;
  /** Canonical packaged x64 ReShade runtime path. */
  runtimePath: string;
  /** Canonical packaged x86 ReShade runtime path. */
  x86RuntimePath: string;
  /** Canonical x64 runtime build-stamp path. */
  buildStampPath: string;
  /** Canonical x86 runtime build-stamp path. */
  x86BuildStampPath: string;
  /** Canonical x64 package-manifest path. */
  packageBuildStampPath: string;
  /** Canonical x86 package-manifest path. */
  x86PackageBuildStampPath: string;
  /** Canonical x64 Electron Game Overlay add-on path. */
  addonPath: string;
  /** Canonical x86 Electron Game Overlay add-on path. */
  x86AddonPath: string;
  /** Canonical packaged ReShade configuration path. */
  configPath: string;
  /** Process name parsed from `--reshade-auto-target-process`, if supplied. */
  autoTargetProcess?: string;
  /** Exact PID parsed from `--reshade-expected-target-pid`, if supplied. */
  expectedTargetPid?: number;
}>;

/** Programmatic overrides for {@link parseReShadeLaunchConfig}. */
export type ReShadeLaunchConfigOptions = Readonly<{
  /** Absolute packaged-runtime directory used when argv has no override. */
  bundledRuntimeDirectory?: string;
  /** Absolute writable directory used for isolated attachment runs. */
  runsRootDirectory?: string;
}>;

/** Injector child-process command exposed by launcher lifecycle events. */
export type ReShadeInvocation = Readonly<{
  /** Absolute injector executable path. */
  executable: string;
  /** Validated command-line arguments passed to the injector. */
  arguments: readonly string[];
  /** Stable description of the selected target. */
  targetLabel: string;
  /** Isolated run directory used as the child-process working directory. */
  workingDirectory: string;
}>;

/** Describes how the overlay code was hosted inside a target. */
export type ReShadeRuntimeMode =
  /** The packaged isolated ReShade runtime was injected into a clean target. */
  | 'injected-runtime'
  /** An already-loaded compatible project runtime accepted the add-on. */
  | 'existing-runtime'
  /** A compatible official ReShade installation loaded the public add-on. */
  | 'official-addon'
  /** An already-running broker-owned target joined without another injection. */
  | 'shared-runtime';

/** Runtime startup observation attached to initialization diagnostics. */
export type ReShadeRuntimeStartupCode =
  | ReShadeRuntimeStartupRecordCode
  | 'not-observed'
  | 'invalid-record'
  | 'pid-mismatch'
  | 'pid-unavailable';

/** Evidence and target identity returned after an injector operation. */
export type ReShadeLaunchResult = Readonly<{
  /** Selected executable basename. */
  processName: string;
  /** Canonical path of the executable selected by the injector. */
  targetExecutablePath: string;
  /** Path reported by a watcher before canonical target inspection, if any. */
  selectedPath?: string;
  /** Stable description of the requested target selector. */
  targetLabel: string;
  /** Exact process identifier selected by the injector. */
  injectorTargetPid: number;
  /** Mechanism that hosts this application's overlay add-on. */
  runtimeMode: ReShadeRuntimeMode;
  /** Existing ReShade host module used for integration, when applicable. */
  hostRuntimePath?: string;
  /** Add-on module loaded by an existing ReShade host, when applicable. */
  addonModulePath?: string;
  /** Isolated attachment run directory. */
  runDirectory: string;
  /** Preserved injector standard-output log. */
  injectorStdoutPath: string;
  /** Preserved injector standard-error log. */
  injectorStderrPath: string;
  /** ReShade log path associated with this run. */
  reshadeLogPath: string;
  /** Fixed startup-observation record path, when available. */
  runtimeStartupPath?: string;
}>;

/** Successful authenticated attachment, including the connected target PID. */
export type ReShadeAttachResult = ReShadeLaunchResult &
  Readonly<{
    /** Authenticated target process identifier. */
    pid: number;
  }>;

type StagedRuntime = Readonly<{
  runId: string;
  runsRootDirectory: string;
  runDirectory: string;
  runtimeProvider: NativeRuntimeProviderMetadata;
  injectorPath: string;
  addonManagerPath: string;
  injectorStdoutPath: string;
  injectorStderrPath: string;
  reshadeLogPath: string;
  runtimeStartupPath: string;
}>;

type InjectorCompletion = Readonly<{
  error: Error | null;
  stdout: string;
  stderr: string;
  didSpawn: boolean;
}>;

type PriorInjectorEvidence = Readonly<{
  stdout: string;
  stderr: string;
}>;

type CurrentRuntime = Readonly<{
  staged: StagedRuntime;
  targetLabel: string;
  launchGeneration: number;
}>;

type PendingExistingReShadeMaintenance = Readonly<{
  pid: number;
  targetLabel: string;
  staged: StagedRuntime;
  options: PrepareExistingReShadeAddonOptions;
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
const existingReShadeMaintenanceByTarget = new Map<string, Promise<void>>();
const officialAddonStartupGraceByTarget = new Map<string, object>();

const existingReShadeMaintenanceTargetKey = (
  targetExecutablePath: string,
): string =>
  path.win32
    .normalize(path.resolve(targetExecutablePath))
    .toLocaleLowerCase('en-US');

const scheduleExistingReShadeMaintenance = (
  targetExecutablePath: string,
  operation: () => Promise<void>,
): Promise<void> => {
  const targetKey = existingReShadeMaintenanceTargetKey(targetExecutablePath);
  const previous = existingReShadeMaintenanceByTarget.get(targetKey);
  const maintenance = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(operation);
  existingReShadeMaintenanceByTarget.set(targetKey, maintenance);
  void maintenance
    .finally(() => {
      if (existingReShadeMaintenanceByTarget.get(targetKey) === maintenance) {
        existingReShadeMaintenanceByTarget.delete(targetKey);
      }
    })
    .catch(() => undefined);
  return maintenance;
};

const waitForExistingReShadeMaintenance = async (
  target: ReShadeTarget,
): Promise<void> => {
  const targetExecutablePath = isPathTarget(target)
    ? undefined
    : target.executablePath;
  const pending =
    targetExecutablePath === undefined
      ? [...existingReShadeMaintenanceByTarget.values()]
      : [
          existingReShadeMaintenanceByTarget.get(
            existingReShadeMaintenanceTargetKey(targetExecutablePath),
          ),
        ].filter((maintenance): maintenance is Promise<void> =>
          Boolean(maintenance),
        );
  if (pending.length === 0) {
    return;
  }
  await Promise.allSettled(pending);
};

const shouldDeferExistingReShadeMaintenance = (
  error: unknown,
): error is ExistingReShadeInstallationError =>
  error instanceof ExistingReShadeInstallationError &&
  (error.code === 'manager-failed' ||
    error.code === 'manager-timeout' ||
    error.code === 'write-race');

const isExistingReShadeOwnershipConflict = (
  error: unknown,
): error is ExistingReShadeInstallationError =>
  error instanceof ExistingReShadeInstallationError &&
  (error.code === 'foreign-addon-collision' ||
    error.code === 'owned-addon-tampered' ||
    error.code === 'ownership-marker-invalid' ||
    error.code === 'file-changed');

/** Current lifecycle state of a {@link ReShadeOverlayLauncher}. */
export type ReShadeAttachmentState =
  /** No attachment is active and a new target may be requested. */
  | 'idle'
  /** Runtime staging, injection, or target authentication is in progress. */
  | 'attaching'
  /** The requested target authenticated and remains connected. */
  | 'connected'
  /** A result was indeterminate, so this launcher cannot safely retry. */
  | 'blocked';

/**
 * `definite-safe` means a retry cannot duplicate a loaded ReShade runtime or
 * add-on payload. It does not promise that no bounded remote coordination,
 * allocation, or loader thread was attempted.
 */
export type ReShadeRetrySafety =
  /** The launcher proved that another attempt cannot duplicate target code. */
  | 'definite-safe'
  /** The launcher cannot prove that another attempt is safe. */
  | 'indeterminate';

/** Launcher stage in which an attachment failure occurred. */
export type ReShadeDiagnosticStage =
  | 'runtime-staging'
  | 'target-preflight'
  | 'injector'
  | 'runtime-initialization'
  | 'lifecycle';

/** Stable machine-readable attachment failure code. */
export type ReShadeDiagnosticCode =
  | 'runtime-staging-failed'
  | 'official-addon-startup-grace-coordinated'
  | 'target-injection-already-claimed'
  | 'target-injection-claim-failed'
  | 'target-official-addon-wait-expired'
  | 'target-existing-reshade-installation'
  | 'target-existing-reshade-global-layer'
  | 'target-global-reshade-layer-inspection-failed'
  | 'existing-reshade-addon-preparation-failed'
  | 'existing-reshade-addon-conflict'
  | 'existing-reshade-addon-disabled'
  | 'existing-reshade-addon-host-incompatible'
  | 'existing-reshade-addon-maintenance-deferred'
  | 'existing-reshade-addon-restart-required'
  | 'target-runtime-conflict'
  | 'target-architecture-mismatch'
  | 'target-runtime-incompatible'
  | 'target-runtime-reuse-too-late'
  | 'target-runtime-reuse-raced'
  | 'target-module-inspection-failed'
  | 'existing-runtime-addon-load-failed'
  | 'injector-start-failed'
  | 'injector-evidence-write-failed'
  | 'injector-failed'
  | 'injector-result-invalid'
  | 'target-rendezvous-authorization-failed'
  | 'runtime-initialization-timeout'
  | 'target-disconnected'
  | 'session-closed'
  | 'operation-cancelled';

/** Preserved files useful for diagnosing an attachment failure. */
export type ReShadeDiagnosticEvidence = Readonly<{
  /** Isolated attachment run directory. */
  runDirectory: string;
  /** Preserved injector standard-output log. */
  injectorStdoutPath: string;
  /** Preserved injector standard-error log. */
  injectorStderrPath: string;
  /** ReShade log path associated with the failed operation. */
  reshadeLogPath: string;
  /** Fixed startup-observation record path, when available. */
  runtimeStartupPath?: string;
}>;

/** Immutable structured failure produced by a launcher operation. */
export type ReShadeDiagnostic = Readonly<{
  /** Diagnostic schema version. */
  schemaVersion: 1;
  /** Package that produced the diagnostic. */
  source: 'electron-game-overlay';
  /** Launcher failures are always errors. */
  severity: 'error';
  /** Lifecycle stage that failed. */
  stage: ReShadeDiagnosticStage;
  /** Stable code intended for programmatic handling. */
  code: ReShadeDiagnosticCode;
  /** Whether another injection attempt is known not to duplicate target code. */
  retrySafety: ReShadeRetrySafety;
  /** Human-readable description intended for logs and diagnostics UI. */
  message: string;
  /** Stable description of the requested target selector, when known. */
  targetLabel?: string;
  /** Exact target process identifier, when known. */
  pid?: number;
  /** Canonical target executable path, when known. */
  targetExecutablePath?: string;
  /** Conflicting or inspected ReShade module path, when applicable. */
  modulePath?: string;
  /** Project add-on path involved in the failure, when applicable. */
  addonPath?: string;
  /** Native Windows error code, when an operating-system operation failed. */
  windowsErrorCode?: number;
  /** Last bounded runtime startup observation, when available. */
  runtimeStartupCode?: ReShadeRuntimeStartupCode;
  /** Preserved filesystem evidence for the operation, when available. */
  evidence?: ReShadeDiagnosticEvidence;
}>;

/** Immutable lifecycle event emitted by {@link ReShadeOverlayLauncher.onEvent}. */
export type ReShadeLauncherEvent =
  | Readonly<{
      /** An isolated runtime is ready for an attachment attempt. */
      type: 'runtime-staged';
      /** Isolated run directory. */
      runDirectory: string;
    }>
  | Readonly<{
      /** An exact target was authorized to authenticate to the session. */
      type: 'target-rendezvous-authorized';
      /** Stable description of the requested target selector. */
      targetLabel: string;
      /** Authorized target process identifier. */
      pid: number;
      /** Private discovery document used by the target runtime. */
      discoveryPath: string;
    }>
  | Readonly<{
      /** The injector child process was created. */
      type: 'injector-started';
      /** Command used to start the injector. */
      invocation: ReShadeInvocation;
    }>
  | Readonly<{
      /** A name or path watcher is armed and the target may now be launched. */
      type: 'injector-watcher-ready';
      /** Command used to start the watcher. */
      invocation: ReShadeInvocation;
    }>
  | Readonly<{
      /** The injector completed and supplied validated target evidence. */
      type: 'injector-returned';
      /** Validated injector result. */
      result: ReShadeLaunchResult;
    }>
  | Readonly<{
      /** The injector or its preflight failed. */
      type: 'injector-failed';
      /** Structured failure details. */
      diagnostic: ReShadeDiagnostic;
    }>
  | Readonly<{
      /** The selected target authenticated to the overlay session. */
      type: 'target-connected';
      /** Stable description of the requested target selector. */
      targetLabel: string;
      /** Authenticated target process identifier. */
      pid: number;
      /** Canonical authenticated executable path. */
      path: string;
    }>
  | Readonly<{
      /** The selected exact target was confirmed to have exited. */
      type: 'target-disconnected';
      /** Stable description of the requested target selector. */
      targetLabel: string;
      /** Disconnected target process identifier. */
      pid: number;
      /** Last authenticated executable path, when available. */
      path?: string;
    }>;

/** Observer accepted by {@link ReShadeOverlayLauncher.onEvent}. */
export type ReShadeLauncherEventHandler = (event: ReShadeLauncherEvent) => void;

type ReShadeDiagnosticInput = Omit<
  ReShadeDiagnostic,
  'schemaVersion' | 'source' | 'severity'
>;

const RESHADE_OPERATION_ERROR_CONSTRUCTION_TOKEN = Symbol(
  'ReShadeOperationError construction token',
);

let constructReShadeOperationError:
  ((input: ReShadeDiagnosticInput) => ReShadeOperationError) | undefined;

/** @internal */
export function createReShadeOperationError(
  input: ReShadeDiagnosticInput,
): ReShadeOperationError {
  if (!constructReShadeOperationError) {
    throw new Error('ReShadeOperationError construction is not initialized');
  }
  return constructReShadeOperationError(input);
}

/**
 * Structured error returned for attachment failures with stable diagnostics.
 * Instances are created by launcher operations and can be narrowed with
 * {@link isReShadeOperationError}.
 */
export class ReShadeOperationError extends Error {
  static {
    constructReShadeOperationError = (input) =>
      new ReShadeOperationError(
        RESHADE_OPERATION_ERROR_CONSTRUCTION_TOKEN,
        input,
      );
  }

  /** Complete immutable diagnostic for the failed operation. */
  public readonly diagnostic: ReShadeDiagnostic;
  /** Stable failure code mirrored from {@link diagnostic}. */
  public readonly code: ReShadeDiagnosticCode;
  /** Failed lifecycle stage mirrored from {@link diagnostic}. */
  public readonly stage: ReShadeDiagnosticStage;
  /** Retry classification mirrored from {@link diagnostic}. */
  public readonly retrySafety: ReShadeRetrySafety;

  private constructor(
    constructionToken: symbol,
    input: ReShadeDiagnosticInput,
  ) {
    if (constructionToken !== RESHADE_OPERATION_ERROR_CONSTRUCTION_TOKEN) {
      throw new TypeError(
        'ReShadeOperationError instances are created by ReShade overlay operations',
      );
    }
    const diagnostic = createReShadeDiagnostic(input);
    super(diagnostic.message);
    this.name = 'ReShadeOperationError';
    this.diagnostic = diagnostic;
    this.code = diagnostic.code;
    this.stage = diagnostic.stage;
    this.retrySafety = diagnostic.retrySafety;
  }
}

/** Narrows an unknown value to a launcher-produced operation error. */
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
    | 'target-official-addon-wait-expired'
    | 'target-existing-reshade-installation'
    | 'target-existing-reshade-global-layer'
    | 'target-global-reshade-layer-inspection-failed'
    | 'target-runtime-conflict'
    | 'target-architecture-mismatch'
    | 'target-runtime-incompatible'
    | 'target-runtime-reuse-too-late'
    | 'target-runtime-reuse-raced'
    | 'target-module-inspection-failed';
  pid: number;
  targetExecutablePath: string;
  injectionStarted: false;
  modulePath?: string;
  reshadeBasePath?: string;
  addonDirectoryPath?: string;
  electronGameOverlayAddonDisabled?: boolean;
  windowsErrorCode?: number;
}>;

type InjectorExistingRuntimeAddonLoadDiagnostic = Readonly<{
  schemaVersion: 1;
  stage: 'existing-runtime-addon-load';
  code: 'existing-runtime-addon-load-failed';
  pid: number;
  targetExecutablePath: string;
  injectionStarted: true;
  modulePath?: string;
  windowsErrorCode?: number;
}>;

type InjectorDiagnostic =
  InjectorPreflightDiagnostic | InjectorExistingRuntimeAddonLoadDiagnostic;

type InjectorResult =
  | Readonly<{
      schemaVersion: 1;
      pid: number;
      targetExecutablePath: string;
      runtimeMode: 'injected-runtime';
    }>
  | Readonly<{
      schemaVersion: 1;
      pid: number;
      targetExecutablePath: string;
      runtimeMode: 'existing-runtime';
      runtimeModulePath: string;
      hostAbi: 1;
    }>
  | Readonly<{
      schemaVersion: 1;
      pid: number;
      targetExecutablePath: string;
      runtimeMode: 'official-addon';
      runtimeModulePath: string;
      addonModulePath: string;
      addonAbi: 1;
      addonBuildId: string;
      reshadeBasePath: string;
      addonDirectoryPath: string;
      electronGameOverlayAddonDisabled: boolean;
    }>;

type ReShadeTargetConnection = Readonly<{
  pid: number;
  path: string;
}>;

type TargetRendezvousAuthorizer = (
  runDirectory: string,
  pid: number,
  expectedExecutablePath: string | undefined,
  runtimeProvider: NativeRuntimeProviderMetadata,
  signal: AbortSignal,
) => Promise<OverlaySessionTargetAuthorization>;

type ConnectedTarget = ReShadeTargetConnection &
  Readonly<{
    targetLabel: string;
    removeListeners: () => void;
  }>;

/** Returns the packaged runtime-artifact directory staged by the SDK build. */
export function defaultReShadeRuntimeDirectory(): string {
  return path.resolve(__dirname, '..', 'runtime', 'win32-x64', 'reshade');
}

/** Returns the writable root used for isolated per-attachment runtime copies. */
export function defaultReShadeRunsRootDirectory(): string {
  return path.join(tmpdir(), 'electron-game-overlay', 'reshade-runs');
}

/**
 * Parses and validates the SDK's explicit `--reshade-overlay` startup opt-in,
 * runtime overrides, and optional target hints.
 *
 * Returns `null` when the opt-in flag is absent. A returned configuration has
 * canonical artifact paths and verified package manifests and can be passed to
 * {@link ReShadeOverlayLauncher}.
 *
 * Recognized arguments are `--reshade-overlay`,
 * `--reshade-runtime-dir=<absolute-path>`,
 * `--reshade-auto-target-process=<name.exe>`, and
 * `--reshade-expected-target-pid=<positive uint32>`. The PID hint requires the
 * process-name hint. Parsing configuration never starts an attachment.
 */
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
  const x86InjectorPath = canonicalArtifact(
    runtimeDirectory,
    X86_INJECTOR_FILE_NAME,
    'x86 ReShade injector',
  );
  const addonManagerPath = canonicalArtifact(
    runtimeDirectory,
    ADDON_MANAGER_FILE_NAME,
    'Electron Game Overlay ReShade add-on manager',
  );
  const x86AddonManagerPath = canonicalArtifact(
    runtimeDirectory,
    X86_ADDON_MANAGER_FILE_NAME,
    'x86 Electron Game Overlay ReShade add-on manager',
  );
  const runtimePath = canonicalArtifact(
    runtimeDirectory,
    RUNTIME_FILE_NAME,
    'ReShade runtime',
  );
  const x86RuntimePath = canonicalArtifact(
    runtimeDirectory,
    X86_RUNTIME_FILE_NAME,
    'x86 ReShade runtime',
  );
  const buildStampPath = canonicalArtifact(
    runtimeDirectory,
    BUILD_STAMP_FILE_NAME,
    'ReShade runtime build stamp',
  );
  const x86BuildStampPath = canonicalArtifact(
    runtimeDirectory,
    X86_BUILD_STAMP_FILE_NAME,
    'x86 ReShade runtime build stamp',
  );
  const packageBuildStampPath = canonicalArtifact(
    runtimeDirectory,
    PACKAGE_BUILD_STAMP_FILE_NAME,
    'Electron Game Overlay runtime package build stamp',
  );
  const x86PackageBuildStampPath = canonicalArtifact(
    runtimeDirectory,
    X86_PACKAGE_BUILD_STAMP_FILE_NAME,
    'x86 Electron Game Overlay runtime package build stamp',
  );
  const addonPath = canonicalArtifact(
    runtimeDirectory,
    ADDON_FILE_NAME,
    'Electron ReShade add-on',
  );
  const x86AddonPath = canonicalArtifact(
    runtimeDirectory,
    X86_ADDON_FILE_NAME,
    'x86 Electron ReShade add-on',
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

  validateRuntimePackageBuildStampsSync(
    new Map<string, string>([
      [INJECTOR_FILE_NAME, injectorPath],
      [X86_INJECTOR_FILE_NAME, x86InjectorPath],
      [ADDON_MANAGER_FILE_NAME, addonManagerPath],
      [X86_ADDON_MANAGER_FILE_NAME, x86AddonManagerPath],
      [RUNTIME_FILE_NAME, runtimePath],
      [X86_RUNTIME_FILE_NAME, x86RuntimePath],
      [BUILD_STAMP_FILE_NAME, buildStampPath],
      [X86_BUILD_STAMP_FILE_NAME, x86BuildStampPath],
      [PACKAGE_BUILD_STAMP_FILE_NAME, packageBuildStampPath],
      [X86_PACKAGE_BUILD_STAMP_FILE_NAME, x86PackageBuildStampPath],
      [ADDON_FILE_NAME, addonPath],
      [X86_ADDON_FILE_NAME, x86AddonPath],
      [CONFIG_FILE_NAME, configPath],
    ]),
  );

  return Object.freeze({
    runtimeDirectory,
    runsRootDirectory: path.resolve(requestedRunsRoot),
    injectorPath,
    x86InjectorPath,
    addonManagerPath,
    x86AddonManagerPath,
    runtimePath,
    x86RuntimePath,
    buildStampPath,
    x86BuildStampPath,
    packageBuildStampPath,
    x86PackageBuildStampPath,
    addonPath,
    x86AddonPath,
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
      : ([
          target.executablePath === undefined
            ? target.processName
            : normalizeExecutablePathForNativeInvocation(target.executablePath),
          '--pid',
          String(target.pid),
        ] as const);

  return Object.freeze({
    executable: path.join(runDirectory, INJECTOR_FILE_NAME),
    arguments: Object.freeze(arguments_),
    targetLabel: targetLabelFor(target),
    workingDirectory: runDirectory,
  });
}

let requestReShadeOverlayLaunch:
  | ((
      launcher: ReShadeOverlayLauncher,
      target: ReShadeTarget,
    ) => Promise<ReShadeLaunchResult>)
  | undefined;
let proveReShadeTargetConnection:
  ((launcher: ReShadeOverlayLauncher, pid: number) => boolean) | undefined;

/** @internal */
export function launchReShadeOverlay(
  launcher: ReShadeOverlayLauncher,
  target: ReShadeTarget,
): Promise<ReShadeLaunchResult> {
  if (!requestReShadeOverlayLaunch) {
    return Promise.reject(
      new Error('ReShadeOverlayLauncher launch plumbing is not initialized'),
    );
  }
  return requestReShadeOverlayLaunch(launcher, target);
}

/** @internal */
export function acceptReShadeTargetConnection(
  launcher: ReShadeOverlayLauncher,
  pid: number,
): boolean {
  if (!proveReShadeTargetConnection) {
    throw new Error(
      'ReShadeOverlayLauncher connection plumbing is not initialized',
    );
  }
  return proveReShadeTargetConnection(launcher, pid);
}

/**
 * Stages the overlay runtime and manages one target attachment lifecycle.
 * Create a separate launcher for each concurrently targeted process while
 * sharing the application's {@link OverlaySession}.
 */
export class ReShadeOverlayLauncher {
  static {
    requestReShadeOverlayLaunch = (launcher, target) =>
      launcher.#requestLaunch(target);
    proveReShadeTargetConnection = (launcher, pid) =>
      launcher.#acceptTargetConnection(pid);
  }

  private readonly eventHandlers = new Set<ReShadeLauncherEventHandler>();
  private activeChild: ChildProcess | null = null;
  private activeRequest: Promise<ReShadeLaunchResult> | null = null;
  private activeLaunchAbortController: AbortController | null = null;
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
  private readonly pendingExistingReShadeMaintenanceByPid = new Map<
    number,
    PendingExistingReShadeMaintenance
  >();
  private readonly confirmedTargetExitRuntimeByPid = new Map<
    number,
    StagedRuntime
  >();
  private releaseTargetAuthorization: (() => void) | null = null;
  private releaseGlobalTargetAuthorization: (() => void) | null = null;
  private launchGeneration = 0;
  private disposed = false;

  /** Creates a launcher from a validated runtime configuration. */
  constructor(
    /** Validated runtime configuration used for every operation. */
    public readonly config: ReShadeLaunchConfig,
  ) {}

  /** Whether this launcher currently has a non-idle target lifecycle. */
  public get hasRequestedInjection(): boolean {
    return this.attachmentState !== 'idle';
  }

  /** Current attachment lifecycle state. */
  public get state(): ReShadeAttachmentState {
    return this.attachmentState;
  }

  /** Most recently staged isolated run directory, or `null` before staging. */
  public get runDirectory(): string | null {
    return this.latestRunDirectory;
  }

  /**
   * Subscribes to immutable launcher lifecycle events. Observer failures are
   * isolated from attachment state and operation results. The returned
   * function removes the subscription.
   */
  public onEvent(handler: ReShadeLauncherEventHandler): () => void {
    if (typeof handler !== 'function') {
      throw new TypeError(
        'the ReShade launcher event handler must be a function',
      );
    }
    this.eventHandlers.add(handler);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Stages an isolated runtime before a target is detected. The next launch
   * consumes it, keeping filesystem work out of latency-sensitive process
   * startup without changing the exact-PID injection contract. Concurrent
   * calls share the same preparation operation.
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

  #acceptTargetConnection(pid: number): boolean {
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
   * Returns whether the observation changed launcher or deferred-maintenance
   * state.
   */
  public confirmTargetExited(pid: number): boolean {
    if (!isValidProcessPid(pid)) {
      return false;
    }
    const current = this.currentRuntime;
    if (
      current !== null &&
      this.attachmentExpectedTargetPid === pid &&
      current.targetLabel === this.attachmentTargetLabel
    ) {
      this.confirmedTargetExitRuntimeByPid.set(pid, current.staged);
    }
    const maintenanceStarted = this.startPendingExistingReShadeMaintenance(pid);
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
      return maintenanceStarted;
    }

    const error = createReShadeOperationError({
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
    this.emitEvent(
      Object.freeze({
        type: 'target-disconnected',
        targetLabel,
        pid,
      }),
    );
    this.activeAttach?.cancel(error);
    this.invalidateActiveLaunch();
    this.retireCurrentRuntime(targetLabel, current?.launchGeneration);
    this.resetTargetState(targetLabel);
    return true;
  }

  /**
   * Waits for transport discovery, arms the staged ReShade injector, and then
   * requires the injected add-on to authenticate back to this producer. The
   * promise resolves only after the exact selected target authenticates.
   */
  public attach(
    session: OverlaySession,
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

  #requestLaunch(
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
    if (
      expectedTargetPid !== undefined &&
      this.pendingExistingReShadeMaintenanceByPid.has(expectedTargetPid)
    ) {
      return Promise.reject(
        new Error(
          `target pid=${expectedTargetPid} must exit before its pending ReShade add-on maintenance can run`,
        ),
      );
    }
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
    const launchAbortController = new AbortController();
    this.activeLaunchAbortController = launchAbortController;
    const request = this.performLaunch(
      launchTarget,
      targetLabel,
      expectedTargetPid,
      launchGeneration,
      launchAbortController.signal,
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
      if (this.activeLaunchAbortController === launchAbortController) {
        this.activeLaunchAbortController = null;
      }
    };
    request.then(clearActiveRequest, clearActiveRequest);
    return request;
  }

  /**
   * Cancels pending work, releases target authorization, and removes unused
   * staged files. Repeated calls have no effect.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    const requestAtDisposal = this.activeRequest;
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
    this.abandonPendingExistingReShadeMaintenance();
    if (
      requestAtDisposal !== null &&
      this.confirmedTargetExitRuntimeByPid.size > 0
    ) {
      void requestAtDisposal
        .finally(() => {
          this.confirmedTargetExitRuntimeByPid.clear();
        })
        .catch(() => undefined);
    } else {
      this.confirmedTargetExitRuntimeByPid.clear();
    }
  }

  private async performAttach(
    session: OverlaySession,
    target: ReShadeTarget,
    expectedTargetPid: number | undefined,
    cancellation: Promise<never>,
  ): Promise<ReShadeAttachResult> {
    await Promise.race([session.whenReady(), cancellation]);
    if (this.disposed) {
      throw new Error('the ReShade launcher is disposed');
    }

    const targetLabel = targetLabelFor(target);
    const removeSessionEventHandlers: Array<() => void> = [];
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
      for (const removeHandler of removeSessionEventHandlers.splice(0)) {
        removeHandler();
      }
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
        createReShadeOperationError({
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
          createReShadeOperationError({
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
      this.emitEvent(
        Object.freeze({
          type: 'target-connected',
          targetLabel,
          pid: connection.pid,
          path: connection.path,
        }),
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

    removeSessionEventHandlers.push(
      session.on('targetConnected', ({ pid, executablePath }) => {
        const connection = Object.freeze({ pid, path: executablePath });
        if (!this.hasRequestedInjection) {
          return;
        }
        if (
          expectedTargetPid !== undefined &&
          connection.pid !== expectedTargetPid
        ) {
          return;
        }
        if (!targetPathMatches(connection.path, target)) {
          console.warn(
            `Ignored ReShade target connection from unexpected path=${JSON.stringify(connection.path)}; expected ${targetPathExpectation(target)}`,
          );
          return;
        }
        recognizedCandidatePids.add(connection.pid);
        disconnectedCandidatesByPid.delete(connection.pid);
        candidatesByPid.set(connection.pid, connection);
        tryAcceptCandidate();
      }),
      session.on('targetTransportLost', ({ pid }) => {
        if (recognizedCandidatePids.has(pid)) {
          candidatesByPid.delete(pid);
        }
      }),
      session.on('targetDisconnected', ({ pid, executablePath }) => {
        const connection = Object.freeze({ pid, path: executablePath });
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
            createReShadeOperationError({
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
            createReShadeOperationError({
              message: `the ReShade target pid=${connection.pid} disconnected before attachment completed`,
              code: 'target-disconnected',
              stage: 'lifecycle',
              retrySafety: 'definite-safe',
              targetLabel,
              pid: connection.pid,
            }),
          );
        }
      }),
    );
    removeCloseHandler = session.onClose(() => {
      const connectedTarget = this.connectedTarget;
      if (connectedTarget?.targetLabel === targetLabel) {
        const wasAttachmentCompleted = attachmentCompleted;
        this.blockTargetState(targetLabel);
        if (!wasAttachmentCompleted) {
          rejectConnectionLost(
            createReShadeOperationError({
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
          createReShadeOperationError({
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

    if (expectedTargetPid === undefined) {
      const releaseGlobalTarget =
        await authorizeOverlaySessionGlobalTarget(session);
      if (
        this.disposed ||
        this.attachmentState !== 'attaching' ||
        this.attachmentTargetLabel !== targetLabel
      ) {
        releaseGlobalTarget();
        throw new Error(
          'the ReShade attachment stopped before its untargeted rendezvous was ready',
        );
      }
      if (this.releaseGlobalTargetAuthorization) {
        releaseGlobalTarget();
        throw new Error(
          'an untargeted ReShade rendezvous is already authorized',
        );
      }
      this.releaseGlobalTargetAuthorization = releaseGlobalTarget;
    }

    const targetRendezvousAuthorizer: TargetRendezvousAuthorizer = (
      runDirectory,
      pid,
      expectedExecutablePath,
      runtimeProvider,
      signal,
    ) =>
      authorizeOverlaySessionTarget(
        session,
        pid,
        path.join(runDirectory, OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME),
        expectedExecutablePath,
        runtimeProvider,
        signal,
      );
    let launch: Promise<ReShadeLaunchResult> | undefined;
    try {
      launch = this.#requestLaunch(
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
      return Object.freeze({
        ...launchResult,
        pid: connection.pid,
      });
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
    authorizationSignal: AbortSignal,
    authorizeTarget?: TargetRendezvousAuthorizer,
  ): Promise<ReShadeLaunchResult> {
    await waitForExistingReShadeMaintenance(target);
    this.assertLaunchCanSpawn(targetLabel, launchGeneration);
    const preparedRuntime = this.preparedRuntime;
    this.preparedRuntime = null;
    const staged = await (preparedRuntime ??
      this.stageRuntime(targetStageName(target)));
    let newTargetAuthorization: OverlaySessionTargetAuthorization | undefined;
    let installedTargetAuthorization = false;
    try {
      this.assertLaunchCanSpawn(targetLabel, launchGeneration);
      if (expectedTargetPid !== undefined && authorizeTarget) {
        newTargetAuthorization = await authorizeTarget(
          staged.runDirectory,
          expectedTargetPid,
          isPathTarget(target) ? undefined : target.executablePath,
          staged.runtimeProvider,
          authorizationSignal,
        );
        this.assertLaunchCanSpawn(targetLabel, launchGeneration);
        if (this.releaseTargetAuthorization) {
          throw new Error('a ReShade target rendezvous is already authorized');
        }
        this.releaseTargetAuthorization = newTargetAuthorization;
        installedTargetAuthorization = true;
        const targetAuthorization = newTargetAuthorization;
        newTargetAuthorization = undefined;
        const authorizedDiscoveryPath =
          targetAuthorization.target?.discoveryPath ??
          path.join(staged.runDirectory, OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME);
        this.emitEvent(
          Object.freeze({
            type: 'target-rendezvous-authorized',
            targetLabel,
            pid: expectedTargetPid,
            discoveryPath: authorizedDiscoveryPath,
          }),
        );
        if (targetAuthorization.disposition === 'joined-existing') {
          const connectedTarget = targetAuthorization.target;
          if (
            !connectedTarget ||
            connectedTarget.pid !== expectedTargetPid ||
            !connectedTarget.discoveryPath
          ) {
            throw new Error(
              'the broker joined an existing target without its authenticated runtime rendezvous',
            );
          }
          if (!targetPathMatches(connectedTarget.executablePath, target)) {
            throw new Error(
              'the broker joined an existing target with an unexpected executable path',
            );
          }
          const result = sharedRuntimeLaunchResult(
            target,
            targetLabel,
            connectedTarget,
          );
          await removeStagedRuntime(staged);
          return result;
        }
      }
    } catch (error) {
      newTargetAuthorization?.();
      if (installedTargetAuthorization) {
        this.clearTargetAuthorization();
      }
      await removeStagedRuntime(staged).catch(() => undefined);
      throw error;
    }
    const invocation = buildReShadeInvocation(target, staged.runDirectory);
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

    return new Promise<ReShadeLaunchResult>((resolve, reject) => {
      const finishLaunch = (completion: Promise<ReShadeLaunchResult>) => {
        void completion
          .then(async (result) => {
            if (
              isPathTarget(target) &&
              result.runtimeMode === 'official-addon' &&
              authorizeTarget
            ) {
              let selectedTargetAuthorization: (() => void) | undefined;
              try {
                selectedTargetAuthorization = await authorizeTarget(
                  staged.runDirectory,
                  result.injectorTargetPid,
                  result.selectedPath,
                  staged.runtimeProvider,
                  authorizationSignal,
                );
                this.assertLaunchCanSpawn(targetLabel, launchGeneration);
                if (this.releaseTargetAuthorization) {
                  throw new Error(
                    'a ReShade target rendezvous is already authorized',
                  );
                }
                this.releaseTargetAuthorization = selectedTargetAuthorization;
                selectedTargetAuthorization = undefined;
                this.clearGlobalTargetAuthorization();
                this.emitEvent(
                  Object.freeze({
                    type: 'target-rendezvous-authorized',
                    targetLabel,
                    pid: result.injectorTargetPid,
                    discoveryPath: path.join(
                      staged.runDirectory,
                      OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME,
                    ),
                  }),
                );
              } catch (authorizationError) {
                selectedTargetAuthorization?.();
                if (isReShadeOperationError(authorizationError)) {
                  throw authorizationError;
                }
                throw this.createInjectorFailure({
                  message: `the official ReShade add-on was detected for target pid=${result.injectorTargetPid}, but its target-specific transport rendezvous could not be authorized: ${formatUnknownError(authorizationError)}`,
                  code: 'target-rendezvous-authorization-failed',
                  stage: 'runtime-initialization',
                  retrySafety: 'definite-safe',
                  targetLabel,
                  pid: result.injectorTargetPid,
                  ...(result.hostRuntimePath === undefined
                    ? {}
                    : { modulePath: result.hostRuntimePath }),
                  ...(result.addonModulePath === undefined
                    ? {}
                    : { addonPath: result.addonModulePath }),
                  evidence: diagnosticEvidenceForLaunchResult(result),
                });
              }
            }
            return result;
          })
          .then(resolve, reject);
      };

      const executeInvocation = (
        currentInvocation: ReShadeInvocation,
        executionTarget: ReShadeTarget,
        currentExpectedTargetPid: number | undefined,
        isX86Fallback: boolean,
        priorEvidence?: PriorInjectorEvidence,
        x86FallbackTarget?: ExactReShadeProcessTarget,
      ) => {
        const currentArguments = [...currentInvocation.arguments];
        let didSpawn = false;
        let detachWatcherReadyObserver = () => undefined;
        const child = execFile(
          currentInvocation.executable,
          currentArguments,
          {
            cwd: currentInvocation.workingDirectory,
            encoding: 'utf8',
            maxBuffer: MAX_OUTPUT_BYTES,
            shell: false,
            timeout: isPathTarget(executionTarget) ? 0 : REQUEST_TIMEOUT_MS,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            detachWatcherReadyObserver();
            if (this.activeChild === child) {
              this.activeChild = null;
            }

            const fallbackTarget = isX86Fallback
              ? null
              : x86FallbackTargetFor(
                  target,
                  currentExpectedTargetPid,
                  error,
                  stdout,
                  didSpawn,
                );
            if (fallbackTarget !== null) {
              try {
                this.assertLaunchCanSpawn(targetLabel, launchGeneration);
                this.attachmentExpectedTargetPid = fallbackTarget.pid;
              } catch (handoffError) {
                reject(handoffError);
                return;
              }
              void Promise.all([
                writeFile(staged.injectorStdoutPath, stdout, 'utf8'),
                writeFile(staged.injectorStderrPath, stderr, 'utf8'),
              ])
                .then(() => {
                  this.assertLaunchCanSpawn(targetLabel, launchGeneration);
                  const fallbackInvocation = buildReShadeInvocation(
                    fallbackTarget,
                    staged.runDirectory,
                  );
                  executeInvocation(
                    Object.freeze({
                      ...fallbackInvocation,
                      executable: path.join(
                        staged.runDirectory,
                        X86_INJECTOR_FILE_NAME,
                      ),
                    }),
                    fallbackTarget,
                    fallbackTarget.pid,
                    true,
                    Object.freeze({ stdout, stderr }),
                    fallbackTarget,
                  );
                })
                .catch((fallbackError) => {
                  if (isReShadeOperationError(fallbackError)) {
                    reject(fallbackError);
                    return;
                  }
                  reject(
                    this.createInjectorFailure({
                      message: `the x64 ReShade injector selected the x86 handoff, but its evidence could not be preserved: ${formatUnknownError(fallbackError)}`,
                      code: 'injector-evidence-write-failed',
                      stage: 'injector',
                      retrySafety: 'definite-safe',
                      targetLabel,
                      pid: fallbackTarget.pid,
                      targetExecutablePath: fallbackTarget.executablePath,
                      evidence: diagnosticEvidenceForStagedRuntime(staged),
                    }),
                  );
                });
              return;
            }

            finishLaunch(
              this.finishInjector(
                target,
                targetLabel,
                launchGeneration,
                currentExpectedTargetPid,
                staged,
                error,
                stdout,
                stderr,
                didSpawn,
                false,
                priorEvidence,
                isX86Fallback,
                x86FallbackTarget,
              ),
            );
          },
        );
        child.once('spawn', () => {
          didSpawn = true;
          this.emitEvent(
            Object.freeze({
              type: 'injector-started',
              invocation: currentInvocation,
            }),
          );
        });
        const watcherReadyMarker = watcherReadyMarkerFor(executionTarget);
        if (watcherReadyMarker !== null && child.stdout !== null) {
          let trailingOutput = '';
          let emitted = false;
          const stdout = child.stdout;
          const onData = (chunk: unknown) => {
            if (emitted) {
              return;
            }
            const output =
              typeof chunk === 'string'
                ? chunk
                : Buffer.isBuffer(chunk)
                  ? chunk.toString('utf8')
                  : String(chunk);
            const candidate = trailingOutput + output;
            if (!candidate.includes(watcherReadyMarker)) {
              trailingOutput = candidate.slice(
                -(watcherReadyMarker.length - 1),
              );
              return;
            }
            emitted = true;
            stdout.removeListener('data', onData);
            if (
              this.activeChild === child &&
              !this.disposed &&
              this.launchGeneration === launchGeneration
            ) {
              this.emitEvent(
                Object.freeze({
                  type: 'injector-watcher-ready',
                  invocation: currentInvocation,
                }),
              );
            }
          };
          stdout.on('data', onData);
          detachWatcherReadyObserver = () => {
            stdout.removeListener('data', onData);
          };
        }
        this.activeChild = child;
      };

      executeInvocation(invocation, target, expectedTargetPid, false);
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
        [X86_INJECTOR_FILE_NAME, this.config.x86InjectorPath],
        [ADDON_MANAGER_FILE_NAME, this.config.addonManagerPath],
        [X86_ADDON_MANAGER_FILE_NAME, this.config.x86AddonManagerPath],
        [RUNTIME_FILE_NAME, this.config.runtimePath],
        [X86_RUNTIME_FILE_NAME, this.config.x86RuntimePath],
        [BUILD_STAMP_FILE_NAME, this.config.buildStampPath],
        [X86_BUILD_STAMP_FILE_NAME, this.config.x86BuildStampPath],
        [PACKAGE_BUILD_STAMP_FILE_NAME, this.config.packageBuildStampPath],
        [
          X86_PACKAGE_BUILD_STAMP_FILE_NAME,
          this.config.x86PackageBuildStampPath,
        ],
        [ADDON_FILE_NAME, this.config.addonPath],
        [X86_ADDON_FILE_NAME, this.config.x86AddonPath],
        [CONFIG_FILE_NAME, this.config.configPath],
      ]);
      const stagingResults = await Promise.allSettled(
        RUNTIME_ARTIFACTS.map((fileName) =>
          stageRuntimeArtifact(
            sourceByName.get(fileName)!,
            path.join(createdRunDirectory, fileName),
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

      const runtimeProvider = await validateRuntimePackageBuildStamps(
        new Map<string, string>(
          RUNTIME_ARTIFACTS.map((fileName) => [
            fileName,
            path.join(createdRunDirectory, fileName),
          ]),
        ),
      );

      scheduleRunRetentionSweepAfterCurrentTurn(runsRootDirectory);
      this.emitEvent(
        Object.freeze({
          type: 'runtime-staged',
          runDirectory: createdRunDirectory,
        }),
      );
      return Object.freeze({
        runId,
        runsRootDirectory,
        runDirectory: createdRunDirectory,
        runtimeProvider,
        injectorPath: path.join(createdRunDirectory, INJECTOR_FILE_NAME),
        addonManagerPath: path.join(
          createdRunDirectory,
          ADDON_MANAGER_FILE_NAME,
        ),
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
      throw createReShadeOperationError({
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
    launchGeneration: number,
    expectedTargetPid: number | undefined,
    staged: StagedRuntime,
    error: Error | null,
    stdout: string,
    stderr: string,
    didSpawn: boolean,
    officialAddonStartupGraceAttempted = false,
    priorEvidence?: PriorInjectorEvidence,
    isX86Fallback = false,
    x86FallbackTarget?: ExactReShadeProcessTarget,
  ): Promise<ReShadeLaunchResult> {
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
    const preservedStdout =
      priorEvidence === undefined
        ? stdout
        : formatArchitectureHandoffEvidence(
            'stdout',
            priorEvidence.stdout,
            stdout,
          );
    const preservedStderr =
      priorEvidence === undefined
        ? stderr
        : formatArchitectureHandoffEvidence(
            'stderr',
            priorEvidence.stderr,
            stderr,
          );
    try {
      await Promise.all([
        writeFile(staged.injectorStdoutPath, preservedStdout, 'utf8'),
        writeFile(staged.injectorStderrPath, preservedStderr, 'utf8'),
      ]);
    } catch (evidenceError) {
      const detail = `ReShade injector completed but its evidence logs could not be preserved: ${formatUnknownError(evidenceError)}`;
      throw this.createInjectorFailure({
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
      throw this.createInjectorFailure({
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
      throw this.createInjectorFailure({
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
      const hasTargetPreflightProof =
        injectorDidNotStart(stdout) ||
        diagnostic.code === 'target-architecture-mismatch';
      const isContradictory =
        hasSuccessMarker ||
        hasResultRecord ||
        !injectorDiagnosticExitMatches(error, didSpawn, diagnostic) ||
        (diagnostic.stage === 'target-preflight'
          ? !hasTargetPreflightProof
          : injectorDidNotStart(stdout)) ||
        (expectedTargetPid !== undefined &&
          diagnostic.pid !== expectedTargetPid) ||
        !targetPathMatches(
          diagnostic.targetExecutablePath,
          x86FallbackTarget ?? target,
        );
      if (isContradictory) {
        const detail =
          'ReShade injector diagnostic contradicted its success, mutation-state, or exact-PID evidence';
        throw this.createInjectorFailure({
          message: detail,
          code: 'injector-result-invalid',
          stage: 'injector',
          retrySafety: 'indeterminate',
          targetLabel,
          pid: diagnostic.pid,
          evidence,
        });
      }

      const existingInstallationDiagnostic =
        didSpawn &&
        !isX86Fallback &&
        diagnostic.stage === 'target-preflight' &&
        diagnostic.modulePath !== undefined &&
        (diagnostic.code === 'target-existing-reshade-installation' ||
          diagnostic.code === 'target-runtime-incompatible')
          ? diagnostic
          : undefined;
      const existingInstallationTarget =
        existingInstallationDiagnostic === undefined
          ? undefined
          : existingInstallationTargetFor(
              target,
              existingInstallationDiagnostic,
            );
      if (
        existingInstallationTarget !== undefined &&
        existingInstallationDiagnostic !== undefined
      ) {
        const preflightTargetExecutablePath =
          existingInstallationDiagnostic.targetExecutablePath;
        const preparationOptions: PrepareExistingReShadeAddonOptions =
          Object.freeze({
            targetExecutablePath: existingInstallationTarget.executablePath,
            reshadeModulePath: existingInstallationDiagnostic.modulePath!,
            addonSourcePath: path.join(staged.runDirectory, ADDON_FILE_NAME),
            managerExecutablePath: staged.addonManagerPath,
            targetEffectiveSettings: Object.freeze({
              reshadeBasePath: existingInstallationDiagnostic.reshadeBasePath!,
              addonDirectoryPath:
                existingInstallationDiagnostic.addonDirectoryPath!,
              electronGameOverlayAddonDisabled:
                existingInstallationDiagnostic.electronGameOverlayAddonDisabled!,
            }),
          });
        let prepared: PrepareExistingReShadeAddonResult;
        try {
          prepared = await prepareExistingReShadeAddon(preparationOptions);
        } catch (preparationError) {
          const maintenanceQueued =
            shouldDeferExistingReShadeMaintenance(preparationError) &&
            this.queuePendingExistingReShadeMaintenance(
              diagnostic.pid,
              targetLabel,
              staged,
              preparationOptions,
            );
          const preparationCode =
            preparationError instanceof ExistingReShadeInstallationError
              ? ` (${preparationError.code})`
              : '';
          const detail =
            `the existing ReShade installation at ${JSON.stringify(existingInstallationDiagnostic.modulePath)} was preserved, but its overlay add-on could not be prepared${preparationCode}: ` +
            formatUnknownError(preparationError) +
            (maintenanceQueued
              ? '; maintenance is deferred until the exact target exit is confirmed'
              : '');
          throw this.createInjectorFailure({
            message: detail,
            code: maintenanceQueued
              ? 'existing-reshade-addon-maintenance-deferred'
              : isExistingReShadeOwnershipConflict(preparationError)
                ? 'existing-reshade-addon-conflict'
                : 'existing-reshade-addon-preparation-failed',
            stage: 'target-preflight',
            retrySafety: 'definite-safe',
            targetLabel,
            pid: diagnostic.pid,
            ...(preflightTargetExecutablePath === undefined
              ? {}
              : { targetExecutablePath: preflightTargetExecutablePath }),
            modulePath: existingInstallationDiagnostic.modulePath,
            evidence: diagnosticEvidence,
          });
        }

        if (prepared.status === 'disabled-by-user') {
          const detail =
            `the existing ReShade installation at ${JSON.stringify(prepared.reshadeModulePath)} was preserved, ` +
            `but the user has disabled ${JSON.stringify('Electron Game Overlay Runtime')} in ${JSON.stringify(prepared.reshadeConfigPath)}; ` +
            'enable that add-on in ReShade before attaching';
          throw this.createInjectorFailure({
            message: detail,
            code: 'existing-reshade-addon-disabled',
            stage: 'target-preflight',
            retrySafety: 'definite-safe',
            targetLabel,
            pid: diagnostic.pid,
            ...(preflightTargetExecutablePath === undefined
              ? {}
              : { targetExecutablePath: preflightTargetExecutablePath }),
            modulePath: prepared.reshadeModulePath,
            evidence: Object.freeze({
              ...diagnosticEvidence,
              reshadeLogPath: path.join(
                prepared.reshadeBaseDirectoryPath,
                RESHADE_LOG_FILE_NAME,
              ),
            }),
          });
        }

        if (prepared.status === 'already-current') {
          if (!officialAddonStartupGraceAttempted) {
            this.assertLaunchCanSpawn(targetLabel, launchGeneration);
            const retry = await this.waitForOfficialAddonStartup(
              existingInstallationTarget,
              targetLabel,
              launchGeneration,
              diagnostic.pid,
              staged,
            );
            return this.finishInjector(
              target,
              targetLabel,
              launchGeneration,
              diagnostic.pid,
              staged,
              retry.error,
              retry.stdout,
              retry.stderr,
              retry.didSpawn,
              true,
              priorEvidence,
              isX86Fallback,
              x86FallbackTarget,
            );
          }
          throw this.createInjectorFailure({
            message:
              `the existing ReShade host at ${JSON.stringify(prepared.reshadeModulePath)} started with the current Electron Game Overlay add-on at ${JSON.stringify(prepared.addonDestinationPath)}, but did not load it; ` +
              'the host must support public add-on API 18 and the required Dear ImGui function table',
            code: 'existing-reshade-addon-host-incompatible',
            stage: 'target-preflight',
            retrySafety: 'definite-safe',
            targetLabel,
            pid: diagnostic.pid,
            ...(preflightTargetExecutablePath === undefined
              ? {}
              : { targetExecutablePath: preflightTargetExecutablePath }),
            modulePath: prepared.reshadeModulePath,
            addonPath: prepared.addonDestinationPath,
            evidence: Object.freeze({
              ...diagnosticEvidence,
              reshadeLogPath: path.join(
                prepared.reshadeBaseDirectoryPath,
                RESHADE_LOG_FILE_NAME,
              ),
            }),
          });
        }

        if (prepared.status === 'installed' || prepared.status === 'updated') {
          const action =
            prepared.status === 'installed' ? 'installed' : 'updated';
          const detail =
            `the existing ReShade installation at ${JSON.stringify(prepared.reshadeModulePath)} was preserved; ` +
            `the Electron Game Overlay add-on was ${action} at ${JSON.stringify(prepared.addonDestinationPath)}, so the target must be restarted before attachment`;
          throw this.createInjectorFailure({
            message: detail,
            code: 'existing-reshade-addon-restart-required',
            stage: 'target-preflight',
            retrySafety: 'definite-safe',
            targetLabel,
            pid: diagnostic.pid,
            ...(preflightTargetExecutablePath === undefined
              ? {}
              : { targetExecutablePath: preflightTargetExecutablePath }),
            modulePath: prepared.reshadeModulePath,
            addonPath: prepared.addonDestinationPath,
            evidence: Object.freeze({
              ...diagnosticEvidence,
              reshadeLogPath: path.join(
                prepared.reshadeBaseDirectoryPath,
                RESHADE_LOG_FILE_NAME,
              ),
            }),
          });
        }
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
        case 'target-official-addon-wait-expired':
          detail = `the bounded official ReShade add-on startup wait ended for target pid=${diagnostic.pid}${windowsErrorDetail}; project runtime and add-on injection were refused`;
          break;
        case 'target-existing-reshade-installation':
          detail = `target pid=${diagnostic.pid} has an existing ReShade installation${
            diagnostic.modulePath
              ? ` at ${JSON.stringify(diagnostic.modulePath)}`
              : ''
          }; the installation was preserved and the project runtime was not injected`;
          break;
        case 'target-existing-reshade-global-layer':
          detail = `target pid=${diagnostic.pid} is configured for an existing global ReShade layer${
            diagnostic.modulePath
              ? ` at ${JSON.stringify(diagnostic.modulePath)}`
              : ''
          }; the installation was preserved and the project runtime was not injected`;
          break;
        case 'target-global-reshade-layer-inspection-failed':
          detail = `global ReShade layer inspection failed for target pid=${diagnostic.pid}${windowsErrorDetail}; project runtime injection was refused`;
          break;
        case 'target-runtime-conflict':
          detail = `target pid=${diagnostic.pid} already has a loaded ReShade runtime${
            diagnostic.modulePath
              ? ` at ${JSON.stringify(diagnostic.modulePath)}`
              : ''
          }`;
          break;
        case 'target-architecture-mismatch':
          detail = `target pid=${diagnostic.pid} cannot be handled by the selected ReShade injector architecture${windowsErrorDetail}`;
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
      throw this.createInjectorFailure({
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
        targetExecutablePath: diagnostic.targetExecutablePath,
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
      throw this.createInjectorFailure({
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
        throw this.createInjectorFailure({
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
      throw this.createInjectorFailure({
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
      throw this.createInjectorFailure({
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
      throw this.createInjectorFailure({
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
      officialAddonStartupGraceAttempted &&
      injectorResult.runtimeMode !== 'official-addon'
    ) {
      throw this.createInjectorFailure({
        message:
          'the official ReShade add-on startup wait returned a mutating runtime mode; the result was rejected',
        code: 'injector-result-invalid',
        stage: 'injector',
        retrySafety: 'indeterminate',
        targetLabel,
        pid: injectorTargetPid,
        evidence,
      });
    }
    if (
      expectedTargetPid !== undefined &&
      injectorTargetPid !== expectedTargetPid
    ) {
      const detail = `ReShade injector selected pid=${injectorTargetPid}; expected pid=${expectedTargetPid}`;
      throw this.createInjectorFailure({
        message: detail,
        code: 'injector-result-invalid',
        stage: 'injector',
        retrySafety: 'indeterminate',
        targetLabel,
        pid: injectorTargetPid,
        evidence,
      });
    }

    const selectedTargetExecutablePath = injectorResult.targetExecutablePath;
    if (
      !targetPathMatches(
        selectedTargetExecutablePath,
        x86FallbackTarget ?? target,
      )
    ) {
      const detail = `ReShade injector selected unexpected path=${JSON.stringify(selectedTargetExecutablePath)}; expected ${targetPathExpectation(x86FallbackTarget ?? target)}`;
      throw this.createInjectorFailure({
        message: detail,
        code: 'injector-result-invalid',
        stage: 'injector',
        retrySafety: 'indeterminate',
        targetLabel,
        pid: injectorTargetPid,
        targetExecutablePath: selectedTargetExecutablePath,
        evidence,
      });
    }
    if (isX86Fallback && injectorResult.runtimeMode === 'official-addon') {
      throw this.createInjectorFailure({
        message:
          'the x86 injector selected an official ReShade add-on; x86 official-installation management is not enabled, so the installation was preserved',
        code: 'target-runtime-incompatible',
        stage: 'target-preflight',
        retrySafety: 'definite-safe',
        targetLabel,
        pid: injectorTargetPid,
        targetExecutablePath: selectedTargetExecutablePath,
        modulePath: injectorResult.runtimeModulePath,
        evidence: diagnosticEvidenceForHostRuntime(
          staged,
          injectorResult.runtimeModulePath,
        ),
      });
    }
    const selectedPath = isPathTarget(target)
      ? selectedTargetExecutablePath
      : undefined;
    const processName = isPathTarget(target)
      ? path.win32.basename(selectedTargetExecutablePath)
      : target.processName;

    if (injectorResult.runtimeMode === 'official-addon') {
      if (injectorResult.electronGameOverlayAddonDisabled) {
        throw this.createInjectorFailure({
          message:
            'the loaded official ReShade host reports that Electron Game Overlay is disabled by the user; the installation was preserved',
          code: 'existing-reshade-addon-disabled',
          stage: 'target-preflight',
          retrySafety: 'definite-safe',
          targetLabel,
          pid: injectorTargetPid,
          targetExecutablePath: selectedTargetExecutablePath,
          modulePath: injectorResult.runtimeModulePath,
          addonPath: injectorResult.addonModulePath,
          evidence: diagnosticEvidenceForHostRuntime(
            staged,
            injectorResult.runtimeModulePath,
          ),
        });
      }
      const officialAddonPreparationOptions: PrepareExistingReShadeAddonOptions =
        Object.freeze({
          targetExecutablePath: selectedTargetExecutablePath,
          reshadeModulePath: injectorResult.runtimeModulePath,
          addonSourcePath: path.join(staged.runDirectory, ADDON_FILE_NAME),
          managerExecutablePath: staged.addonManagerPath,
          targetEffectiveSettings: Object.freeze({
            reshadeBasePath: injectorResult.reshadeBasePath,
            addonDirectoryPath: injectorResult.addonDirectoryPath,
            electronGameOverlayAddonDisabled:
              injectorResult.electronGameOverlayAddonDisabled,
          }),
        });
      let inspection: Awaited<
        ReturnType<typeof inspectLoadedOfficialReShadeAddon>
      >;
      try {
        inspection = await inspectLoadedOfficialReShadeAddon({
          targetExecutablePath:
            officialAddonPreparationOptions.targetExecutablePath,
          reshadeModulePath: officialAddonPreparationOptions.reshadeModulePath,
          loadedAddonModulePath: injectorResult.addonModulePath,
          addonSourcePath: officialAddonPreparationOptions.addonSourcePath,
          managerExecutablePath:
            officialAddonPreparationOptions.managerExecutablePath,
          targetEffectiveSettings:
            officialAddonPreparationOptions.targetEffectiveSettings,
        });
      } catch (inspectionError) {
        const maintenanceQueued =
          shouldDeferExistingReShadeMaintenance(inspectionError) &&
          this.queuePendingExistingReShadeMaintenance(
            injectorTargetPid,
            targetLabel,
            staged,
            officialAddonPreparationOptions,
          );
        const inspectionCode =
          inspectionError instanceof ExistingReShadeInstallationError
            ? ` (${inspectionError.code})`
            : '';
        throw this.createInjectorFailure({
          message:
            `the loaded official ReShade add-on could not be verified as the current managed generation${inspectionCode}: ` +
            formatUnknownError(inspectionError) +
            (maintenanceQueued
              ? '; maintenance is deferred until the exact target exit is confirmed'
              : ''),
          code: maintenanceQueued
            ? 'existing-reshade-addon-maintenance-deferred'
            : isExistingReShadeOwnershipConflict(inspectionError)
              ? 'existing-reshade-addon-conflict'
              : 'existing-reshade-addon-preparation-failed',
          stage: 'target-preflight',
          retrySafety: 'definite-safe',
          targetLabel,
          pid: injectorTargetPid,
          targetExecutablePath: selectedTargetExecutablePath,
          modulePath: injectorResult.runtimeModulePath,
          addonPath: injectorResult.addonModulePath,
          evidence: diagnosticEvidenceForHostRuntime(
            staged,
            injectorResult.runtimeModulePath,
          ),
        });
      }
      if (inspection.status !== 'already-current') {
        const canMaintainAfterTargetExit =
          inspection.status === 'not-installed' ||
          inspection.status === 'update-required' ||
          inspection.status === 'transaction-pending';
        const maintenanceQueued =
          canMaintainAfterTargetExit &&
          this.queuePendingExistingReShadeMaintenance(
            injectorTargetPid,
            targetLabel,
            staged,
            officialAddonPreparationOptions,
          );
        throw this.createInjectorFailure({
          message: maintenanceQueued
            ? `the official ReShade host loaded a non-current managed add-on (${inspection.status}); the target must exit before the add-on can be updated and then restarted`
            : canMaintainAfterTargetExit
              ? `the official ReShade host loaded a non-current managed add-on (${inspection.status}); the existing installation was preserved, but target-exit maintenance was not scheduled because the launcher is no longer active`
              : `the official ReShade host add-on cannot be accepted (${inspection.status}); the existing installation was preserved and no automatic update was scheduled`,
          code: maintenanceQueued
            ? 'existing-reshade-addon-maintenance-deferred'
            : canMaintainAfterTargetExit
              ? 'existing-reshade-addon-preparation-failed'
              : 'existing-reshade-addon-conflict',
          stage: 'target-preflight',
          retrySafety: 'definite-safe',
          targetLabel,
          pid: injectorTargetPid,
          targetExecutablePath: selectedTargetExecutablePath,
          modulePath: injectorResult.runtimeModulePath,
          addonPath: injectorResult.addonModulePath,
          evidence: diagnosticEvidenceForHostRuntime(
            staged,
            injectorResult.runtimeModulePath,
          ),
        });
      }
    }

    const result: ReShadeLaunchResult = Object.freeze({
      processName,
      targetExecutablePath: selectedTargetExecutablePath,
      ...(selectedPath === undefined ? {} : { selectedPath }),
      targetLabel,
      injectorTargetPid,
      runtimeMode: injectorResult.runtimeMode,
      ...(injectorResult.runtimeMode !== 'injected-runtime'
        ? { hostRuntimePath: injectorResult.runtimeModulePath }
        : {}),
      ...(injectorResult.runtimeMode === 'official-addon'
        ? { addonModulePath: injectorResult.addonModulePath }
        : {}),
      runDirectory: staged.runDirectory,
      injectorStdoutPath: staged.injectorStdoutPath,
      injectorStderrPath: staged.injectorStderrPath,
      reshadeLogPath:
        injectorResult.runtimeMode !== 'injected-runtime'
          ? hostRuntimeLogPath(injectorResult.runtimeModulePath)
          : staged.reshadeLogPath,
      ...(injectorResult.runtimeMode === 'official-addon'
        ? {}
        : { runtimeStartupPath: staged.runtimeStartupPath }),
    });
    this.emitEvent(
      Object.freeze({
        type: 'injector-returned',
        result,
      }),
    );
    return result;
  }

  private waitForOfficialAddonStartup(
    target: ExistingInstallationTarget,
    targetLabel: string,
    launchGeneration: number,
    pid: number,
    staged: StagedRuntime,
  ): Promise<InjectorCompletion> {
    this.assertLaunchCanSpawn(targetLabel, launchGeneration);
    const coordinationKey = `${existingReShadeMaintenanceTargetKey(
      target.executablePath,
    )}\0${pid}`;
    if (officialAddonStartupGraceByTarget.has(coordinationKey)) {
      return Promise.reject(
        this.createInjectorFailure({
          message: `another launcher in this process is already waiting for the official ReShade add-on in target pid=${pid}`,
          code: 'official-addon-startup-grace-coordinated',
          stage: 'target-preflight',
          retrySafety: 'definite-safe',
          targetLabel,
          pid,
          targetExecutablePath: target.executablePath,
          evidence: diagnosticEvidenceForStagedRuntime(staged),
        }),
      );
    }

    const invocation = buildReShadeInvocation(
      Object.freeze({
        processName: target.processName,
        pid,
        executablePath: target.executablePath,
      }),
      staged.runDirectory,
    );
    const retryInvocation: ReShadeInvocation = Object.freeze({
      ...invocation,
      arguments: Object.freeze([
        ...invocation.arguments,
        '--wait-for-official-addon',
        String(OFFICIAL_ADDON_STARTUP_GRACE_MS),
      ]),
    });
    let resolveCompletion!: (completion: InjectorCompletion) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<InjectorCompletion>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const coordination = {};
    officialAddonStartupGraceByTarget.set(coordinationKey, coordination);
    void completion
      .finally(() => {
        if (
          officialAddonStartupGraceByTarget.get(coordinationKey) ===
          coordination
        ) {
          officialAddonStartupGraceByTarget.delete(coordinationKey);
        }
      })
      .catch(() => undefined);

    try {
      this.assertLaunchCanSpawn(targetLabel, launchGeneration);
      let didSpawn = false;
      const child = execFile(
        retryInvocation.executable,
        [...retryInvocation.arguments],
        {
          cwd: retryInvocation.workingDirectory,
          encoding: 'utf8',
          maxBuffer: MAX_OUTPUT_BYTES,
          shell: false,
          timeout: OFFICIAL_ADDON_STARTUP_GRACE_MS + 5_000,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (this.activeChild === child) {
            this.activeChild = null;
          }
          resolveCompletion(
            Object.freeze({
              error,
              stdout,
              stderr,
              didSpawn,
            }),
          );
        },
      );
      child.once('spawn', () => {
        didSpawn = true;
        this.emitEvent(
          Object.freeze({
            type: 'injector-started',
            invocation: retryInvocation,
          }),
        );
      });
      this.activeChild = child;
    } catch (error) {
      rejectCompletion(error);
    }
    return completion;
  }

  private queuePendingExistingReShadeMaintenance(
    pid: number,
    targetLabel: string,
    staged: StagedRuntime,
    options: PrepareExistingReShadeAddonOptions,
  ): boolean {
    const targetExitAlreadyConfirmed =
      this.confirmedTargetExitRuntimeByPid.get(pid) === staged;
    if (this.disposed && !targetExitAlreadyConfirmed) {
      return false;
    }
    const existing = this.pendingExistingReShadeMaintenanceByPid.get(pid);
    if (existing !== undefined) {
      return existing.staged === staged;
    }
    this.pendingExistingReShadeMaintenanceByPid.set(
      pid,
      Object.freeze({
        pid,
        targetLabel,
        staged,
        options: Object.freeze({
          ...options,
          targetEffectiveSettings: Object.freeze({
            ...options.targetEffectiveSettings,
          }),
        }),
      }),
    );
    if (this.confirmedTargetExitRuntimeByPid.get(pid) === staged) {
      this.startPendingExistingReShadeMaintenance(pid);
    }
    return true;
  }

  private startPendingExistingReShadeMaintenance(pid: number): boolean {
    const pending = this.pendingExistingReShadeMaintenanceByPid.get(pid);
    if (pending === undefined) {
      return false;
    }
    this.pendingExistingReShadeMaintenanceByPid.delete(pid);
    this.confirmedTargetExitRuntimeByPid.delete(pid);
    if (this.currentRuntime?.staged === pending.staged) {
      this.currentRuntime = null;
    }

    let completedStatus: string | undefined;
    const maintenance = scheduleExistingReShadeMaintenance(
      pending.options.targetExecutablePath,
      async () => {
        const prepared = await prepareExistingReShadeAddon(pending.options);
        if (
          prepared.status !== 'installed' &&
          prepared.status !== 'updated' &&
          prepared.status !== 'already-current'
        ) {
          throw new Error(
            `deferred ReShade add-on maintenance was refused with status=${prepared.status}`,
          );
        }
        completedStatus = prepared.status;
      },
    );
    void (async () => {
      try {
        await maintenance;
        if (completedStatus === undefined) {
          throw new Error(
            'deferred ReShade add-on maintenance completed without a result status',
          );
        }
        console.log(
          `ELECTRON_GAME_OVERLAY_RESHADE_MAINTENANCE_COMPLETED pid=${pending.pid} operation=prepare status=${completedStatus} target=${JSON.stringify(pending.options.targetExecutablePath)}`,
        );
      } catch (error) {
        console.error(
          `ELECTRON_GAME_OVERLAY_RESHADE_MAINTENANCE_FAILED pid=${pending.pid} operation=prepare target=${JSON.stringify(pending.options.targetExecutablePath)} detail=${JSON.stringify(formatUnknownError(error))}`,
        );
      } finally {
        try {
          await markRunDirectoryReclaimable(pending.staged);
          scheduleRunRetentionSweep(pending.staged.runsRootDirectory);
        } catch (error) {
          if (!(await pathIsMissing(pending.staged.runDirectory))) {
            console.warn(
              `Unable to retire a deferred ReShade maintenance run directory: ${formatUnknownError(error)}`,
            );
          }
        }
      }
    })();
    return true;
  }

  private abandonPendingExistingReShadeMaintenance(): void {
    const stagedRuntimes = new Set(
      [...this.pendingExistingReShadeMaintenanceByPid.values()].map(
        ({ staged }) => staged,
      ),
    );
    this.pendingExistingReShadeMaintenanceByPid.clear();
    if (
      this.currentRuntime !== null &&
      stagedRuntimes.has(this.currentRuntime.staged)
    ) {
      this.currentRuntime = null;
    }
    for (const staged of stagedRuntimes) {
      void markRunDirectoryReclaimable(staged)
        .then(() => scheduleRunRetentionSweep(staged.runsRootDirectory))
        .catch(async (error) => {
          if (!(await pathIsMissing(staged.runDirectory))) {
            console.warn(
              `Unable to retire an abandoned ReShade maintenance run directory: ${formatUnknownError(error)}`,
            );
          }
        });
    }
  }

  private currentRuntimeHasPendingExistingReShadeMaintenance(
    targetLabel: string,
    launchGeneration: number,
  ): boolean {
    const current = this.currentRuntime;
    if (
      current === null ||
      current.targetLabel !== targetLabel ||
      current.launchGeneration !== launchGeneration
    ) {
      return false;
    }
    return [...this.pendingExistingReShadeMaintenanceByPid.values()].some(
      (pending) => pending.staged === current.staged,
    );
  }

  private disconnectConnectedTarget(target: ConnectedTarget): void {
    if (this.connectedTarget !== target) {
      return;
    }
    this.emitEvent(
      Object.freeze({
        type: 'target-disconnected',
        targetLabel: target.targetLabel,
        pid: target.pid,
        path: target.path,
      }),
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
      error.retrySafety === 'definite-safe' &&
      !this.currentRuntimeHasPendingExistingReShadeMaintenance(
        targetLabel,
        launchGeneration,
      )
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
    this.clearGlobalTargetAuthorization();
  }

  private clearGlobalTargetAuthorization(): void {
    const release = this.releaseGlobalTargetAuthorization;
    this.releaseGlobalTargetAuthorization = null;
    release?.();
  }

  private closeTargetProofWindow(): void {
    this.awaitingTargetProof = false;
    if (this.targetProofTimer) {
      clearTimeout(this.targetProofTimer);
      this.targetProofTimer = null;
    }
  }

  private createInjectorFailure(
    input: ReShadeDiagnosticInput,
  ): ReShadeOperationError {
    const error = createReShadeOperationError(input);
    this.emitEvent(
      Object.freeze({
        type: 'injector-failed',
        diagnostic: error.diagnostic,
      }),
    );
    return error;
  }

  private emitEvent(event: ReShadeLauncherEvent): void {
    for (const handler of [...this.eventHandlers]) {
      try {
        handler(event);
      } catch {
        // Lifecycle observation must not alter launcher state or error results.
      }
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
      throw createReShadeOperationError({
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
    this.activeLaunchAbortController?.abort(
      new Error('the ReShade target authorization was canceled'),
    );
    this.activeLaunchAbortController = null;
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
    case 'target-existing-reshade-installation':
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

function validateRuntimePackageBuildStampsSync(
  artifactPaths: ReadonlyMap<string, string>,
): NativeRuntimeProviderMetadata {
  const runtimeProviders = RUNTIME_PACKAGE_BUILD_STAMP_SPECS.map((spec) => {
    const manifestPath = runtimeArtifactPath(
      artifactPaths,
      spec.manifestFileName,
    );
    const manifestBytes = readFileSync(manifestPath);
    const manifest = parseRuntimePackageBuildStamp(manifestBytes, spec);
    for (const artifact of spec.artifacts) {
      const artifactPath = runtimeArtifactPath(
        artifactPaths,
        artifact.fileName,
      );
      assertRuntimePackageArtifactHash(
        manifest,
        artifact,
        sha256(readFileSync(artifactPath)),
        spec,
      );
    }
    return runtimeProviderForBuildStamp(manifest);
  });
  return commonRuntimeProviderMetadata(runtimeProviders);
}

async function validateRuntimePackageBuildStamps(
  artifactPaths: ReadonlyMap<string, string>,
): Promise<NativeRuntimeProviderMetadata> {
  const runtimeProviders = await Promise.all(
    RUNTIME_PACKAGE_BUILD_STAMP_SPECS.map(async (spec) => {
      const manifestPath = runtimeArtifactPath(
        artifactPaths,
        spec.manifestFileName,
      );
      const manifest = parseRuntimePackageBuildStamp(
        await readFile(manifestPath),
        spec,
      );
      await Promise.all(
        spec.artifacts.map(async (artifact) => {
          const artifactPath = runtimeArtifactPath(
            artifactPaths,
            artifact.fileName,
          );
          assertRuntimePackageArtifactHash(
            manifest,
            artifact,
            sha256(await readFile(artifactPath)),
            spec,
          );
        }),
      );
      return runtimeProviderForBuildStamp(manifest);
    }),
  );
  return commonRuntimeProviderMetadata(runtimeProviders);
}

function runtimeProviderForBuildStamp(
  manifest: RuntimePackageBuildStamp,
): NativeRuntimeProviderMetadata {
  return manifest.schemaVersion ===
    LEGACY_RUNTIME_PACKAGE_BUILD_STAMP_SCHEMA_VERSION
    ? LEGACY_RUNTIME_PROVIDER_METADATA
    : Object.freeze({
        runtimeGeneration: manifest.runtimeGeneration,
        targetTransportMin: manifest.targetTransportMin,
        targetTransportMax: manifest.targetTransportMax,
      });
}

function commonRuntimeProviderMetadata(
  providers: readonly NativeRuntimeProviderMetadata[],
): NativeRuntimeProviderMetadata {
  const first = providers[0];
  if (!first) {
    throw new Error('runtime package provider metadata is unavailable');
  }
  if (
    providers.some(
      (provider) =>
        provider.runtimeGeneration !== first.runtimeGeneration ||
        provider.targetTransportMin !== first.targetTransportMin ||
        provider.targetTransportMax !== first.targetTransportMax,
    )
  ) {
    throw new Error(
      'x64 and x86 runtime package build stamps declare different runtime provider metadata',
    );
  }
  return Object.freeze({ ...first });
}

function runtimeArtifactPath(
  artifactPaths: ReadonlyMap<string, string>,
  fileName: string,
): string {
  const artifactPath = artifactPaths.get(fileName);
  if (artifactPath === undefined) {
    throw new Error(`runtime package mapping is missing ${fileName}`);
  }
  return artifactPath;
}

function parseRuntimePackageBuildStamp(
  bytes: Uint8Array,
  spec: RuntimePackageBuildStampSpec,
): RuntimePackageBuildStamp {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_RUNTIME_PACKAGE_BUILD_STAMP_BYTES
  ) {
    throw new Error(
      `${spec.label} must be a non-empty JSON document no larger than ${MAX_RUNTIME_PACKAGE_BUILD_STAMP_BYTES} bytes`,
    );
  }

  const decodedText = Buffer.from(bytes).toString('utf8');
  const text =
    decodedText.charCodeAt(0) === 0xfeff ? decodedText.slice(1) : decodedText;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${spec.label} is not valid JSON`);
  }
  if (!isJsonRecord(parsed)) {
    throw new Error(`${spec.label} does not match schema version 2 or 3`);
  }
  const candidate = parsed as Record<string, unknown>;
  const expectedKeys =
    candidate.schemaVersion ===
    LEGACY_RUNTIME_PACKAGE_BUILD_STAMP_SCHEMA_VERSION
      ? LEGACY_RUNTIME_PACKAGE_BUILD_STAMP_KEYS
      : candidate.schemaVersion === RUNTIME_PACKAGE_BUILD_STAMP_SCHEMA_VERSION
        ? RUNTIME_PACKAGE_BUILD_STAMP_KEYS
        : undefined;
  if (
    !expectedKeys ||
    !hasCanonicalRuntimePackageBuildStampKeys(text, expectedKeys) ||
    !hasExactObjectKeys(candidate, expectedKeys)
  ) {
    throw new Error(`${spec.label} does not match schema version 2 or 3`);
  }
  if (candidate.platform !== spec.platform) {
    throw new Error(
      `${spec.label} declares platform ${JSON.stringify(candidate.platform)}; expected ${spec.platform}`,
    );
  }

  const hashKeys = [
    'managerSourceSha256',
    ...spec.artifacts.map((artifact) => artifact.hashKey),
  ];
  if (
    candidate.kind !== RUNTIME_PACKAGE_BUILD_STAMP_KIND ||
    candidate.configuration !== RUNTIME_PACKAGE_BUILD_CONFIGURATION ||
    candidate.addonBuildId !== OFFICIAL_ADDON_BUILD_ID ||
    candidate.managerProtocolSchemaVersion !==
      RUNTIME_PACKAGE_MANAGER_PROTOCOL_SCHEMA_VERSION ||
    (candidate.schemaVersion === RUNTIME_PACKAGE_BUILD_STAMP_SCHEMA_VERSION &&
      (!isPositiveUint32(candidate.runtimeGeneration) ||
        !isPositiveUint32(candidate.targetTransportMin) ||
        !isPositiveUint32(candidate.targetTransportMax) ||
        candidate.targetTransportMin > candidate.targetTransportMax)) ||
    typeof candidate.addonBuildId !== 'string' ||
    !/^[0-9A-F]{32}$/.test(candidate.addonBuildId) ||
    hashKeys.some(
      (key) =>
        typeof candidate[key] !== 'string' ||
        !/^[0-9A-F]{64}$/.test(candidate[key] as string),
    )
  ) {
    throw new Error(`${spec.label} has unexpected provenance`);
  }

  return candidate as RuntimePackageBuildStamp;
}

function hasCanonicalRuntimePackageBuildStampKeys(
  text: string,
  keys: readonly string[],
): boolean {
  // Production manifests contain only fixed ASCII strings and hexadecimal
  // values, so no JSON escape is necessary. Reject escapes before parsing to
  // prevent an encoded property name from aliasing a literal schema key.
  if (text.includes('\\')) {
    return false;
  }
  const rawKeys = [...text.matchAll(/"([^"]*)"\s*:/g)]
    .map((match) => match[1])
    .sort();
  const expectedKeys = [...keys].sort();
  return (
    rawKeys.length === expectedKeys.length &&
    rawKeys.every((key, index) => key === expectedKeys[index])
  );
}

function isPositiveUint32(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 0xffffffff
  );
}

function assertRuntimePackageArtifactHash(
  manifest: RuntimePackageBuildStamp,
  artifact: Readonly<{
    hashKey: RuntimePackageBuildStampHashKey;
    fileName: string;
  }>,
  actualSha256: string,
  spec: RuntimePackageBuildStampSpec,
): void {
  if (manifest[artifact.hashKey] !== actualSha256) {
    throw new Error(
      `${spec.label} ${artifact.hashKey} does not match ${artifact.fileName}`,
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

async function stageRuntimeArtifact(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  // Every validated artifact is an isolated snapshot. In particular, the
  // executables and manifests must not remain hard-linked to a mutable package
  // source after their hashes have been accepted.
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
    } catch (error) {
      console.warn(
        `Unable to remove completed ReShade run directory ${JSON.stringify(candidate.runDirectory)}: ${formatUnknownError(error)}`,
      );
    }
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
    : [
        `process:${target.processName}:pid:${target.pid}`,
        ...(target.executablePath === undefined
          ? []
          : [`path:${normalizeExecutablePathIdentity(target.executablePath)}`]),
      ].join(':');
}

function sharedRuntimeLaunchResult(
  target: ReShadeTarget,
  targetLabel: string,
  connection: NonNullable<OverlaySessionTargetAuthorization['target']>,
): ReShadeLaunchResult {
  const discoveryPath = connection.discoveryPath;
  if (!discoveryPath) {
    throw new Error('the shared target rendezvous path is unavailable');
  }
  const runDirectory = path.dirname(discoveryPath);
  const targetExecutablePath = connection.executablePath;
  return Object.freeze({
    processName: isPathTarget(target)
      ? path.win32.basename(targetExecutablePath)
      : target.processName,
    targetExecutablePath,
    targetLabel,
    injectorTargetPid: connection.pid,
    runtimeMode: 'shared-runtime',
    runDirectory,
    injectorStdoutPath: path.join(runDirectory, INJECTOR_STDOUT_FILE_NAME),
    injectorStderrPath: path.join(runDirectory, INJECTOR_STDERR_FILE_NAME),
    reshadeLogPath: path.join(runDirectory, RESHADE_LOG_FILE_NAME),
    runtimeStartupPath: path.join(runDirectory, RUNTIME_STARTUP_FILE_NAME),
  });
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
      ...(target.executablePath === undefined
        ? {}
        : { executablePath: target.executablePath }),
    }),
    expectedTargetPid,
  ];
}

type ExistingInstallationTarget = Readonly<{
  executablePath: string;
  processName: string;
  selectedPath?: string;
}>;

function existingInstallationTargetFor(
  target: ReShadeTarget,
  diagnostic: InjectorPreflightDiagnostic,
): ExistingInstallationTarget | undefined {
  const selectedPath = diagnostic.targetExecutablePath;
  if (!targetPathMatches(selectedPath, target)) {
    return undefined;
  }
  if (!isPathTarget(target)) {
    if (target.executablePath === undefined) {
      return undefined;
    }
    return Object.freeze({
      executablePath: selectedPath,
      processName: target.processName,
    });
  }
  return Object.freeze({
    executablePath: selectedPath,
    processName: path.win32.basename(selectedPath),
    selectedPath,
  });
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
    typeof candidate.targetExecutablePath !== 'string' ||
    !path.win32.isAbsolute(candidate.targetExecutablePath) ||
    candidate.targetExecutablePath.includes('\0') ||
    (candidate.runtimeMode !== 'injected-runtime' &&
      candidate.runtimeMode !== 'existing-runtime' &&
      candidate.runtimeMode !== 'official-addon')
  ) {
    return Object.freeze({
      kind: 'invalid',
      detail: 'result record did not match schema version 1',
    });
  }

  if (candidate.runtimeMode === 'injected-runtime') {
    if (
      !hasExactObjectKeys(candidate, [
        'pid',
        'runtimeMode',
        'schemaVersion',
        'targetExecutablePath',
      ])
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
        targetExecutablePath: candidate.targetExecutablePath,
        runtimeMode: 'injected-runtime',
      }),
    });
  }

  if (candidate.runtimeMode === 'official-addon') {
    if (
      !hasExactObjectKeys(candidate, [
        'addonAbi',
        'addonBuildId',
        'addonDirectoryPath',
        'addonModulePath',
        'electronGameOverlayAddonDisabled',
        'pid',
        'reshadeBasePath',
        'runtimeMode',
        'runtimeModulePath',
        'schemaVersion',
        'targetExecutablePath',
      ]) ||
      typeof candidate.runtimeModulePath !== 'string' ||
      !path.win32.isAbsolute(candidate.runtimeModulePath) ||
      candidate.runtimeModulePath.includes('\0') ||
      typeof candidate.addonModulePath !== 'string' ||
      !path.win32.isAbsolute(candidate.addonModulePath) ||
      candidate.addonModulePath.includes('\0') ||
      candidate.addonAbi !== 1 ||
      candidate.addonBuildId !== OFFICIAL_ADDON_BUILD_ID ||
      typeof candidate.reshadeBasePath !== 'string' ||
      !path.win32.isAbsolute(candidate.reshadeBasePath) ||
      candidate.reshadeBasePath.includes('\0') ||
      typeof candidate.addonDirectoryPath !== 'string' ||
      !path.win32.isAbsolute(candidate.addonDirectoryPath) ||
      candidate.addonDirectoryPath.includes('\0') ||
      typeof candidate.electronGameOverlayAddonDisabled !== 'boolean'
    ) {
      return Object.freeze({
        kind: 'invalid',
        detail:
          'official-addon result requires absolute runtime and add-on module paths and add-on ABI 1, the current build identity, and target-effective ReShade settings',
      });
    }
    return Object.freeze({
      kind: 'valid',
      result: Object.freeze({
        schemaVersion: 1,
        pid: candidate.pid,
        targetExecutablePath: candidate.targetExecutablePath,
        runtimeMode: 'official-addon',
        runtimeModulePath: candidate.runtimeModulePath,
        addonModulePath: candidate.addonModulePath,
        addonAbi: 1,
        addonBuildId: candidate.addonBuildId,
        reshadeBasePath: candidate.reshadeBasePath,
        addonDirectoryPath: candidate.addonDirectoryPath,
        electronGameOverlayAddonDisabled:
          candidate.electronGameOverlayAddonDisabled,
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
      'targetExecutablePath',
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
      targetExecutablePath: candidate.targetExecutablePath,
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
  const targetExecutablePath = candidate.targetExecutablePath;
  const modulePath = candidate.modulePath;
  const reshadeBasePath = candidate.reshadeBasePath;
  const addonDirectoryPath = candidate.addonDirectoryPath;
  const electronGameOverlayAddonDisabled =
    candidate.electronGameOverlayAddonDisabled;
  const windowsErrorCode = candidate.windowsErrorCode;
  const isPreflightDiagnostic =
    candidate.stage === 'target-preflight' &&
    (code === 'target-injection-already-claimed' ||
      code === 'target-injection-claim-failed' ||
      code === 'target-official-addon-wait-expired' ||
      code === 'target-existing-reshade-installation' ||
      code === 'target-existing-reshade-global-layer' ||
      code === 'target-global-reshade-layer-inspection-failed' ||
      code === 'target-runtime-conflict' ||
      code === 'target-architecture-mismatch' ||
      code === 'target-runtime-incompatible' ||
      code === 'target-runtime-reuse-too-late' ||
      code === 'target-runtime-reuse-raced' ||
      code === 'target-module-inspection-failed') &&
    candidate.injectionStarted === false;
  const isExistingRuntimeAddonLoadDiagnostic =
    candidate.stage === 'existing-runtime-addon-load' &&
    code === 'existing-runtime-addon-load-failed' &&
    candidate.injectionStarted === true;
  const exactKeys = [
    'schemaVersion',
    'stage',
    'code',
    'pid',
    'injectionStarted',
    'targetExecutablePath',
    ...(modulePath === undefined ? [] : ['modulePath']),
    ...(reshadeBasePath === undefined ? [] : ['reshadeBasePath']),
    ...(addonDirectoryPath === undefined ? [] : ['addonDirectoryPath']),
    ...(electronGameOverlayAddonDisabled === undefined
      ? []
      : ['electronGameOverlayAddonDisabled']),
    ...(windowsErrorCode === undefined ? [] : ['windowsErrorCode']),
  ];
  const preflightRequiresModule =
    code === 'target-existing-reshade-installation' ||
    code === 'target-existing-reshade-global-layer' ||
    code === 'target-runtime-conflict' ||
    code === 'target-runtime-incompatible' ||
    code === 'target-runtime-reuse-too-late' ||
    code === 'target-runtime-reuse-raced';
  const preflightRequiresWindowsError =
    code === 'target-injection-already-claimed' ||
    code === 'target-injection-claim-failed' ||
    code === 'target-official-addon-wait-expired' ||
    code === 'target-global-reshade-layer-inspection-failed' ||
    code === 'target-runtime-conflict' ||
    code === 'target-architecture-mismatch' ||
    code === 'target-runtime-incompatible' ||
    code === 'target-runtime-reuse-too-late' ||
    code === 'target-runtime-reuse-raced' ||
    code === 'target-module-inspection-failed';
  const preflightRequiresEffectiveSettings =
    code === 'target-existing-reshade-installation' ||
    code === 'target-existing-reshade-global-layer' ||
    code === 'target-runtime-incompatible';
  const hasAnyEffectiveSetting =
    reshadeBasePath !== undefined ||
    addonDirectoryPath !== undefined ||
    electronGameOverlayAddonDisabled !== undefined;
  if (
    candidate.schemaVersion !== 1 ||
    (!isPreflightDiagnostic && !isExistingRuntimeAddonLoadDiagnostic) ||
    !hasExactObjectKeys(candidate, exactKeys) ||
    !isValidProcessPid(candidate.pid) ||
    typeof targetExecutablePath !== 'string' ||
    !path.win32.isAbsolute(targetExecutablePath) ||
    targetExecutablePath.includes('\0') ||
    (modulePath !== undefined &&
      (typeof modulePath !== 'string' ||
        !path.win32.isAbsolute(modulePath) ||
        modulePath.includes('\0'))) ||
    (hasAnyEffectiveSetting &&
      (typeof reshadeBasePath !== 'string' ||
        !path.win32.isAbsolute(reshadeBasePath) ||
        reshadeBasePath.includes('\0') ||
        typeof addonDirectoryPath !== 'string' ||
        !path.win32.isAbsolute(addonDirectoryPath) ||
        addonDirectoryPath.includes('\0') ||
        typeof electronGameOverlayAddonDisabled !== 'boolean')) ||
    (windowsErrorCode !== undefined &&
      (!Number.isSafeInteger(windowsErrorCode) ||
        (windowsErrorCode as number) <= 0 ||
        (windowsErrorCode as number) > 0xffffffff)) ||
    (isPreflightDiagnostic &&
      ((preflightRequiresModule && modulePath === undefined) ||
        (preflightRequiresWindowsError && windowsErrorCode === undefined) ||
        (code === 'target-architecture-mismatch' &&
          windowsErrorCode !== WINDOWS_ERROR_IMAGE_MACHINE_TYPE_MISMATCH) ||
        preflightRequiresEffectiveSettings !== hasAnyEffectiveSetting)) ||
    (isExistingRuntimeAddonLoadDiagnostic &&
      (modulePath === undefined ||
        windowsErrorCode === undefined ||
        hasAnyEffectiveSetting))
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
        targetExecutablePath,
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
      targetExecutablePath: targetExecutablePath as string,
      injectionStarted: false,
      ...(modulePath === undefined ? {} : { modulePath }),
      ...(reshadeBasePath === undefined ? {} : { reshadeBasePath }),
      ...(addonDirectoryPath === undefined ? {} : { addonDirectoryPath }),
      ...(electronGameOverlayAddonDisabled === undefined
        ? {}
        : { electronGameOverlayAddonDisabled }),
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

function x86FallbackTargetFor(
  target: ReShadeTarget,
  expectedTargetPid: number | undefined,
  error: Error | null,
  stdout: string,
  didSpawn: boolean,
): ExactReShadeProcessTarget | null {
  if (
    stdout.includes(INJECTOR_SUCCESS_MARKER) ||
    parseInjectorResult(stdout).kind !== 'none'
  ) {
    return null;
  }

  const parsed = parseInjectorDiagnostic(stdout);
  if (parsed.kind !== 'valid') {
    return null;
  }
  const diagnostic = parsed.diagnostic;
  if (
    diagnostic.stage !== 'target-preflight' ||
    diagnostic.code !== 'target-architecture-mismatch' ||
    diagnostic.injectionStarted !== false ||
    diagnostic.windowsErrorCode !== WINDOWS_ERROR_IMAGE_MACHINE_TYPE_MISMATCH ||
    diagnostic.modulePath !== undefined ||
    diagnostic.reshadeBasePath !== undefined ||
    diagnostic.addonDirectoryPath !== undefined ||
    diagnostic.electronGameOverlayAddonDisabled !== undefined ||
    !injectorDiagnosticExitMatches(error, didSpawn, diagnostic) ||
    (expectedTargetPid !== undefined && diagnostic.pid !== expectedTargetPid) ||
    !targetPathMatches(diagnostic.targetExecutablePath, target)
  ) {
    return null;
  }

  const fallbackTarget: ExactReShadeProcessTarget = Object.freeze({
    processName: path.win32.basename(diagnostic.targetExecutablePath),
    pid: diagnostic.pid,
    executablePath: diagnostic.targetExecutablePath,
  });
  try {
    validateTarget(fallbackTarget);
  } catch {
    return null;
  }
  return fallbackTarget;
}

function formatArchitectureHandoffEvidence(
  stream: 'stdout' | 'stderr',
  x64Output: string,
  x86Output: string,
): string {
  const withTrailingNewline = (value: string) =>
    value.length === 0 || value.endsWith('\n') ? value : `${value}\n`;
  return (
    `=== x64 injector ${stream} ===\n` +
    withTrailingNewline(x64Output) +
    `=== x86 injector ${stream} ===\n` +
    x86Output
  );
}

function injectorDiagnosticExitMatches(
  error: Error | null,
  didSpawn: boolean,
  diagnostic: InjectorDiagnostic,
): boolean {
  if (!didSpawn || error === null) {
    return false;
  }
  const candidate = error as Error & {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  if (candidate.killed === true || candidate.signal != null) {
    return false;
  }
  const expectedExitCode = (() => {
    switch (diagnostic.code) {
      case 'target-existing-reshade-installation':
      case 'target-existing-reshade-global-layer':
      case 'target-runtime-conflict':
        return 183;
      case 'target-runtime-incompatible':
        return 50;
      case 'target-architecture-mismatch':
        return WINDOWS_ERROR_IMAGE_MACHINE_TYPE_MISMATCH;
      case 'target-injection-already-claimed':
      case 'target-runtime-reuse-too-late':
        return 170;
      case 'target-runtime-reuse-raced':
        return 1237;
      case 'target-injection-claim-failed':
      case 'target-official-addon-wait-expired':
      case 'target-module-inspection-failed':
      case 'target-global-reshade-layer-inspection-failed':
      case 'existing-runtime-addon-load-failed':
        return diagnostic.windowsErrorCode;
    }
  })();
  return (
    typeof expectedExitCode === 'number' &&
    expectedExitCode > 0 &&
    candidate.code === expectedExitCode
  );
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
  if (target.executablePath !== undefined) {
    return (
      normalizeExecutablePathIdentity(targetPath) ===
      normalizeExecutablePathIdentity(target.executablePath)
    );
  }
  return (
    path.win32.basename(targetPath).toLowerCase() ===
    target.processName.toLowerCase()
  );
}

function targetPathExpectation(target: ReShadeTarget): string {
  if (isPathTarget(target)) {
    return `path fragment=${JSON.stringify(target.pathContains)} excluding=${JSON.stringify(target.excludedProcessNames ?? [])}`;
  }
  return target.executablePath === undefined
    ? `basename=${JSON.stringify(target.processName)}`
    : `exact path=${JSON.stringify(target.executablePath)}`;
}

function targetStageName(target: ReShadeTarget): string {
  return isPathTarget(target) ? 'path-watch' : target.processName;
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\//g, '\\').toLowerCase();
}

function normalizeExecutablePathIdentity(value: string): string {
  return normalizeExecutablePathForNativeInvocation(value).toLowerCase();
}

function normalizeExecutablePathForNativeInvocation(value: string): string {
  const normalized = path.win32.normalize(value);
  const normalizedLower = normalized.toLowerCase();
  const extendedUncPrefix = '\\\\?\\unc\\';
  const extendedDosPrefix = '\\\\?\\';
  if (normalizedLower.startsWith(extendedUncPrefix)) {
    return `\\\\${normalized.slice(extendedUncPrefix.length)}`;
  }
  if (normalizedLower.startsWith(extendedDosPrefix)) {
    return normalized.slice(extendedDosPrefix.length);
  }
  return normalized;
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
  if (
    target.executablePath !== undefined &&
    (target.pid === undefined ||
      !path.win32.isAbsolute(target.executablePath) ||
      target.executablePath.includes('\0') ||
      path.win32.basename(target.executablePath).toLowerCase() !==
        target.processName.toLowerCase())
  ) {
    throw new Error(
      'the ReShade target executable path requires an exact PID, must be absolute, and must match its process basename',
    );
  }
}

function isPathTarget(target: ReShadeTarget): target is ReShadePathTarget {
  return 'pathContains' in target;
}

function watcherReadyMarkerFor(target: ReShadeTarget): string | null {
  if (isPathTarget(target)) {
    return PATH_WATCHER_READY_MARKER;
  }
  return target.pid === undefined ? PROCESS_WATCHER_READY_MARKER : null;
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
