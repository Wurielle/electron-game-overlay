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

const RUNTIME_ARTIFACTS = Object.freeze([
  INJECTOR_FILE_NAME,
  RUNTIME_FILE_NAME,
  BUILD_STAMP_FILE_NAME,
  ADDON_FILE_NAME,
  CONFIG_FILE_NAME,
] as const);

export type ReShadeTarget = Readonly<{ processName: string }>;

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
  arguments: readonly [string];
  targetLabel: string;
  workingDirectory: string;
}>;

export type ReShadeLaunchResult = Readonly<{
  processName: string;
  targetLabel: string;
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
    if (!Number.isSafeInteger(expectedTargetPid) || expectedTargetPid <= 0) {
      throw new Error(
        `${RESHADE_EXPECTED_TARGET_PID_OPTION} must be a positive integer`,
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
  validateProcessName(target.processName);
  if (!path.isAbsolute(runDirectory)) {
    throw new Error('the ReShade run directory must be absolute');
  }

  return Object.freeze({
    executable: path.join(runDirectory, INJECTOR_FILE_NAME),
    arguments: Object.freeze([target.processName] as [string]),
    targetLabel: `process:${target.processName}`,
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
  private injectionRequested = false;
  private awaitingTargetProof = false;
  private targetProofTimer: ReturnType<typeof setTimeout> | null = null;
  private latestRunDirectory: string | null = null;
  private disposed = false;

  constructor(public readonly config: ReShadeLaunchConfig) {}

  public get hasRequestedInjection(): boolean {
    return this.injectionRequested;
  }

  public get runDirectory(): string | null {
    return this.latestRunDirectory;
  }

  public acceptTargetConnection(pid: number): boolean {
    if (!this.awaitingTargetProof) {
      return false;
    }
    const expectedTargetPid = this.config.expectedTargetPid;
    if (expectedTargetPid !== undefined && pid !== expectedTargetPid) {
      return false;
    }

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
    if (this.activeAttach) {
      if (this.activeAttach.targetLabel === targetLabel) {
        return this.activeAttach.promise;
      }
      return Promise.reject(
        new Error('a different ReShade attachment is already active'),
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
    const promise = this.performAttach(session, target, cancellation);
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

  public launch(target: ReShadeTarget): Promise<ReShadeLaunchResult> {
    if (this.disposed) {
      return Promise.reject(new Error('the ReShade launcher is disposed'));
    }

    const targetLabel = targetLabelFor(target);
    if (this.activeRequest) {
      if (this.activeTargetLabel === targetLabel) {
        return this.activeRequest;
      }
      return Promise.reject(
        new Error('a different ReShade injection request is already active'),
      );
    }
    if (this.injectionRequested) {
      return Promise.reject(
        new Error(
          'a ReShade injection was already requested; automatic reinjection is disabled',
        ),
      );
    }

    this.injectionRequested = true;
    this.awaitingTargetProof = true;
    this.targetProofTimer = setTimeout(() => {
      this.awaitingTargetProof = false;
      this.targetProofTimer = null;
    }, TARGET_PROOF_TIMEOUT_MS);
    this.activeTargetLabel = targetLabel;

    const request = this.performLaunch(target, targetLabel).catch((error) => {
      this.closeTargetProofWindow();
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
    this.closeTargetProofWindow();
    this.stopActiveChild();
  }

  private async performAttach(
    session: Pick<OverlaySession, 'on' | 'onClose' | 'whenReady'>,
    target: ReShadeTarget,
    cancellation: Promise<never>,
  ): Promise<ReShadeAttachResult> {
    await Promise.race([session.whenReady(), cancellation]);
    if (this.disposed) {
      throw new Error('the ReShade launcher is disposed');
    }

    let removeNativeEvent: (() => void) | undefined;
    let removeCloseHandler: (() => void) | undefined;
    let proofTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      removeNativeEvent?.();
      removeNativeEvent = undefined;
      removeCloseHandler?.();
      removeCloseHandler = undefined;
      if (proofTimer) {
        clearTimeout(proofTimer);
        proofTimer = undefined;
      }
    };

    const connectionProof = new Promise<number>((resolve, reject) => {
      const rejectProof = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      removeNativeEvent = session.on('nativeEvent', ({ event, payload }) => {
        if (event !== 'game.process' || !this.hasRequestedInjection) {
          return;
        }

        const pid = payload?.pid;
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          return;
        }
        const expectedTargetPid = this.config.expectedTargetPid;
        if (expectedTargetPid !== undefined && pid !== expectedTargetPid) {
          console.warn(
            `Ignored ReShade target connection from unexpected pid=${pid}; expected pid=${expectedTargetPid}`,
          );
          return;
        }
        if (!this.acceptTargetConnection(pid) || settled) {
          return;
        }

        settled = true;
        cleanup();
        console.log(`${RESHADE_CLIENT_TARGET_CONNECTED_MARKER} pid=${pid}`);
        resolve(pid);
      });
      removeCloseHandler = session.onClose(() => {
        rejectProof(
          new Error(
            'the overlay session closed before the ReShade target connected',
          ),
        );
      });
      if (!settled) {
        proofTimer = setTimeout(() => {
          rejectProof(
            new Error(
              `the ReShade target did not connect within ${TARGET_PROOF_TIMEOUT_MS}ms`,
            ),
          );
        }, TARGET_PROOF_TIMEOUT_MS);
      }
    });

    try {
      const outcome = await Promise.race([
        Promise.all([this.launch(target), connectionProof] as const),
        cancellation,
      ]);
      const [launchResult, pid] = outcome;
      return Object.freeze({ ...launchResult, pid });
    } catch (error) {
      this.stopActiveChild();
      throw error;
    } finally {
      cleanup();
      this.closeTargetProofWindow();
    }
  }

  private async performLaunch(
    target: ReShadeTarget,
    targetLabel: string,
  ): Promise<ReShadeLaunchResult> {
    const staged = await this.stageRuntime(target.processName);
    this.latestRunDirectory = staged.runDirectory;
    const invocation = buildReShadeInvocation(target, staged.runDirectory);
    console.log(
      `${RESHADE_CLIENT_INJECTOR_STARTED_MARKER} target=${JSON.stringify(target.processName)}`,
    );

    return new Promise<ReShadeLaunchResult>((resolve, reject) => {
      const child = execFile(
        invocation.executable,
        [...invocation.arguments],
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
            staged,
            error,
            stdout,
            stderr,
          ).then(resolve, reject);
        },
      );
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
    staged: StagedRuntime,
    error: Error | null,
    stdout: string,
    stderr: string,
  ): Promise<ReShadeLaunchResult> {
    await Promise.all([
      writeFile(staged.injectorStdoutPath, stdout, 'utf8'),
      writeFile(staged.injectorStderrPath, stderr, 'utf8'),
    ]);

    if (this.disposed) {
      const detail =
        'the ReShade launcher was disposed before injector completion';
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(processName)} detail=${JSON.stringify(detail)}`,
      );
      throw new Error(detail);
    }

    if (error || !stdout.includes(INJECTOR_SUCCESS_MARKER)) {
      const detail = error
        ? formatLaunchError(error, stdout, stderr)
        : `ReShade injector stdout did not contain ${JSON.stringify(INJECTOR_SUCCESS_MARKER)}`;
      console.error(
        `${RESHADE_CLIENT_INJECTOR_FAILED_MARKER} target=${JSON.stringify(processName)} detail=${JSON.stringify(detail)}`,
      );
      throw new Error(detail);
    }

    console.log(
      `${RESHADE_CLIENT_INJECTOR_RETURNED_MARKER} target=${JSON.stringify(processName)}`,
    );
    return Object.freeze({
      processName,
      targetLabel,
      runDirectory: staged.runDirectory,
      injectorStdoutPath: staged.injectorStdoutPath,
      injectorStderrPath: staged.injectorStderrPath,
      reshadeLogPath: staged.reshadeLogPath,
    });
  }

  private closeTargetProofWindow(): void {
    this.awaitingTargetProof = false;
    if (this.targetProofTimer) {
      clearTimeout(this.targetProofTimer);
      this.targetProofTimer = null;
    }
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
  validateProcessName(target.processName);
  return `process:${target.processName}`;
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
