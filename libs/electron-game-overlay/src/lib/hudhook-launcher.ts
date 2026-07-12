import { execFile, type ChildProcess } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { OverlaySession } from './overlay-session.js';

const HUDHOOK_OPT_IN_FLAG = '--hudhook-overlay';
const HUDHOOK_BACKEND_OPTION = '--hudhook-backend';
const HUDHOOK_RUNTIME_DIRECTORY_OPTION = '--hudhook-runtime-dir';
const HUDHOOK_AUTO_TARGET_PROCESS_OPTION = '--hudhook-auto-target-process';
const HUDHOOK_EXPECTED_TARGET_PID_OPTION = '--hudhook-expected-target-pid';
const INJECTOR_FILE_NAME = 'hudhook_overlay_injector.exe';
const REQUEST_TIMEOUT_MS = 10_000;
const TARGET_PROOF_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

// Keep the existing proof markers stable while launcher ownership moves from
// the demo client into the SDK.
export const HUDHOOK_CONFIGURED_MARKER = 'HUDHOOK_CLIENT_HUDHOOK_CONFIGURED';
export const HUDHOOK_INJECTOR_STARTED_MARKER =
  'HUDHOOK_CLIENT_HUDHOOK_INJECTOR_STARTED';
export const HUDHOOK_INJECTOR_RETURNED_MARKER =
  'HUDHOOK_CLIENT_HUDHOOK_INJECTOR_RETURNED';
export const HUDHOOK_INJECTOR_FAILED_MARKER =
  'HUDHOOK_CLIENT_HUDHOOK_INJECTOR_FAILED';
export const HUDHOOK_TARGET_CONNECTED_MARKER =
  'HUDHOOK_CLIENT_HUDHOOK_TARGET_CONNECTED';

export type HudhookBackend = 'd3d11' | 'd3d12';

export type HudhookLaunchConfig = Readonly<{
  backend: HudhookBackend;
  runtimeDirectory: string;
  injectorPath: string;
  payloadPath: string;
  autoTargetProcess?: string;
  expectedTargetPid?: number;
}>;

export type HudhookLaunchConfigOptions = Readonly<{
  bundledRuntimeDirectory?: string;
}>;

export type HudhookTarget =
  | Readonly<{ processName: string }>
  | Readonly<{ windowTitle: string }>;

export type HudhookInvocation = Readonly<{
  executable: string;
  arguments: readonly string[];
  targetLabel: string;
}>;

export type HudhookAttachResult = Readonly<{
  backend: HudhookBackend;
  pid: number;
  targetLabel: string;
}>;

/** Returns the Windows x64 runtime directory staged by the SDK build. */
export function defaultHudhookRuntimeDirectory(): string {
  return path.resolve(__dirname, '..', 'runtime', 'win32-x64');
}

export function parseHudhookLaunchConfig(
  argv: readonly string[],
  options: HudhookLaunchConfigOptions = {},
): HudhookLaunchConfig | null {
  const optInCount = argv.filter(
    (argument) => argument === HUDHOOK_OPT_IN_FLAG,
  ).length;
  if (optInCount === 0) {
    return null;
  }
  if (optInCount !== 1) {
    throw new Error(`${HUDHOOK_OPT_IN_FLAG} must be provided exactly once`);
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('the hudhook overlay runtime requires Windows x64');
  }

  const backendValue = readRequiredOption(argv, HUDHOOK_BACKEND_OPTION);
  if (backendValue !== 'd3d11' && backendValue !== 'd3d12') {
    throw new Error(`${HUDHOOK_BACKEND_OPTION} must be either d3d11 or d3d12`);
  }
  const backend: HudhookBackend = backendValue;

  const runtimeDirectoryOverride = readOptionalOption(
    argv,
    HUDHOOK_RUNTIME_DIRECTORY_OPTION,
  );
  const requestedRuntimeDirectory =
    runtimeDirectoryOverride ??
    options.bundledRuntimeDirectory ??
    defaultHudhookRuntimeDirectory();
  if (!path.isAbsolute(requestedRuntimeDirectory)) {
    throw new Error(
      runtimeDirectoryOverride === undefined
        ? 'the SDK hudhook runtime directory must be absolute'
        : `${HUDHOOK_RUNTIME_DIRECTORY_OPTION} must be absolute`,
    );
  }

  const runtimeDirectory = canonicalDirectory(requestedRuntimeDirectory);
  const injectorPath = canonicalFile(
    path.join(runtimeDirectory, INJECTOR_FILE_NAME),
    'hudhook injector',
  );
  const payloadFileName =
    backend === 'd3d11'
      ? 'hudhook_imgui_overlay_dx11.dll'
      : 'hudhook_imgui_overlay_dx12.dll';
  const payloadPath = canonicalFile(
    path.join(runtimeDirectory, payloadFileName),
    `${backend} hudhook payload`,
  );
  assertDirectChild(runtimeDirectory, injectorPath, INJECTOR_FILE_NAME);
  assertDirectChild(runtimeDirectory, payloadPath, payloadFileName);

  const autoTargetProcess = readOptionalOption(
    argv,
    HUDHOOK_AUTO_TARGET_PROCESS_OPTION,
  );
  if (autoTargetProcess !== undefined) {
    validateProcessName(autoTargetProcess);
  }

  const expectedTargetPidValue = readOptionalOption(
    argv,
    HUDHOOK_EXPECTED_TARGET_PID_OPTION,
  );
  let expectedTargetPid: number | undefined;
  if (expectedTargetPidValue !== undefined) {
    if (autoTargetProcess === undefined) {
      throw new Error(
        `${HUDHOOK_EXPECTED_TARGET_PID_OPTION} requires ${HUDHOOK_AUTO_TARGET_PROCESS_OPTION}`,
      );
    }
    expectedTargetPid = Number(expectedTargetPidValue);
    if (!Number.isSafeInteger(expectedTargetPid) || expectedTargetPid <= 0) {
      throw new Error(
        `${HUDHOOK_EXPECTED_TARGET_PID_OPTION} must be a positive integer`,
      );
    }
  }

  return Object.freeze({
    backend,
    runtimeDirectory,
    injectorPath,
    payloadPath,
    ...(autoTargetProcess === undefined ? {} : { autoTargetProcess }),
    ...(expectedTargetPid === undefined ? {} : { expectedTargetPid }),
  });
}

export function buildHudhookInvocation(
  config: HudhookLaunchConfig,
  target: HudhookTarget,
): HudhookInvocation {
  let selector: readonly string[];
  let targetLabel: string;
  if ('processName' in target) {
    validateProcessName(target.processName);
    selector = ['--process', target.processName];
    targetLabel = `process:${target.processName}`;
  } else {
    const title = target.windowTitle.trim();
    if (
      title.length === 0 ||
      title.length > 512 ||
      title.includes('\0') ||
      title.includes('\r') ||
      title.includes('\n')
    ) {
      throw new Error('the hudhook target title is invalid');
    }
    selector = ['--title', title];
    targetLabel = `title:${title}`;
  }

  return Object.freeze({
    executable: config.injectorPath,
    arguments: Object.freeze([
      ...selector,
      '--backend',
      config.backend,
      '--dll',
      config.payloadPath,
    ]),
    targetLabel,
  });
}

export class HudhookOverlayLauncher {
  private activeChild: ChildProcess | null = null;
  private activeRequest: Promise<void> | null = null;
  private activeTargetLabel: string | null = null;
  private activeAttach: {
    targetLabel: string;
    promise: Promise<HudhookAttachResult>;
    cancel: (error: Error) => void;
  } | null = null;
  private injectionRequested = false;
  private awaitingTargetProof = false;
  private targetProofTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(public readonly config: HudhookLaunchConfig) {}

  public get hasRequestedInjection() {
    return this.injectionRequested;
  }

  /**
   * Correlates the first authenticated payload connection with the active
   * injection request. A configured expected PID is enforced here; it is not
   * an exact-PID selector for the upstream injector.
   */
  public acceptTargetConnection(pid: number) {
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
   * Waits for the SDK transport, invokes the injector, and proves that the
   * injected payload authenticated back to this Electron producer.
   */
  public attach(
    session: Pick<OverlaySession, 'on' | 'onClose' | 'whenReady'>,
    target: HudhookTarget,
  ): Promise<HudhookAttachResult> {
    if (this.disposed) {
      return Promise.reject(new Error('the hudhook launcher is disposed'));
    }

    const invocation = buildHudhookInvocation(this.config, target);
    if (this.activeAttach) {
      if (this.activeAttach.targetLabel === invocation.targetLabel) {
        return this.activeAttach.promise;
      }
      return Promise.reject(
        new Error('a different hudhook attachment is already active'),
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
      invocation,
      cancellation,
    );
    const activeAttach = {
      targetLabel: invocation.targetLabel,
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

  private async performAttach(
    session: Pick<OverlaySession, 'on' | 'onClose' | 'whenReady'>,
    target: HudhookTarget,
    invocation: HudhookInvocation,
    cancellation: Promise<never>,
  ): Promise<HudhookAttachResult> {
    await Promise.race([session.whenReady(), cancellation]);
    if (this.disposed) {
      throw new Error('the hudhook launcher is disposed');
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

    const connectionProof = new Promise<HudhookAttachResult>(
      (resolve, reject) => {
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
              `Ignored hudhook target connection from unexpected pid=${pid}; expected pid=${expectedTargetPid}`,
            );
            return;
          }
          if (!this.acceptTargetConnection(pid) || settled) {
            return;
          }

          settled = true;
          cleanup();
          console.log(`${HUDHOOK_TARGET_CONNECTED_MARKER} pid=${pid}`);
          resolve({
            backend: this.config.backend,
            pid,
            targetLabel: invocation.targetLabel,
          });
        });
        removeCloseHandler = session.onClose(() => {
          rejectProof(
            new Error(
              'the overlay session closed before the hudhook target connected',
            ),
          );
        });
        if (!settled) {
          proofTimer = setTimeout(() => {
            rejectProof(
              new Error(
                `the hudhook target did not connect within ${TARGET_PROOF_TIMEOUT_MS}ms`,
              ),
            );
          }, TARGET_PROOF_TIMEOUT_MS);
        }
      },
    );

    try {
      if (settled) {
        return await connectionProof;
      }
      const [, result] = await Promise.race([
        Promise.all([this.launch(target), connectionProof] as const),
        cancellation,
      ]);
      return result;
    } catch (error) {
      this.stopActiveChild();
      throw error;
    } finally {
      cleanup();
      this.closeTargetProofWindow();
    }
  }

  public launch(target: HudhookTarget): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('the hudhook launcher is disposed'));
    }

    const invocation = buildHudhookInvocation(this.config, target);
    if (this.activeRequest) {
      if (this.activeTargetLabel === invocation.targetLabel) {
        return this.activeRequest;
      }
      return Promise.reject(
        new Error('a different hudhook injection request is already active'),
      );
    }
    if (this.injectionRequested) {
      return Promise.reject(
        new Error(
          'a hudhook injection was already requested; automatic reinjection is disabled',
        ),
      );
    }

    this.injectionRequested = true;
    this.awaitingTargetProof = true;
    this.targetProofTimer = setTimeout(() => {
      this.awaitingTargetProof = false;
      this.targetProofTimer = null;
    }, TARGET_PROOF_TIMEOUT_MS);
    this.activeTargetLabel = invocation.targetLabel;
    console.log(
      `${HUDHOOK_INJECTOR_STARTED_MARKER} backend=${this.config.backend} target=${JSON.stringify(invocation.targetLabel)}`,
    );

    const request = new Promise<void>((resolve, reject) => {
      this.activeChild = execFile(
        invocation.executable,
        [...invocation.arguments],
        {
          cwd: this.config.runtimeDirectory,
          encoding: 'utf8',
          maxBuffer: MAX_OUTPUT_BYTES,
          shell: false,
          timeout: REQUEST_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          this.activeChild = null;
          if (error) {
            this.closeTargetProofWindow();
            const detail = formatLaunchError(error, stdout, stderr);
            console.error(
              `${HUDHOOK_INJECTOR_FAILED_MARKER} backend=${this.config.backend} target=${JSON.stringify(invocation.targetLabel)} detail=${JSON.stringify(detail)}`,
            );
            reject(new Error(detail));
            return;
          }

          console.log(
            `${HUDHOOK_INJECTOR_RETURNED_MARKER} backend=${this.config.backend} target=${JSON.stringify(invocation.targetLabel)}`,
          );
          resolve();
        },
      );
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

  public dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.activeAttach?.cancel(
      new Error(
        'the hudhook launcher was disposed before attachment completed',
      ),
    );
    this.closeTargetProofWindow();
    this.stopActiveChild();
  }

  private closeTargetProofWindow() {
    this.awaitingTargetProof = false;
    if (this.targetProofTimer) {
      clearTimeout(this.targetProofTimer);
      this.targetProofTimer = null;
    }
  }

  private stopActiveChild() {
    const child = this.activeChild;
    this.activeChild = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
}

function readRequiredOption(argv: readonly string[], name: string) {
  const value = readOptionalOption(argv, name);
  if (value === undefined) {
    throw new Error(`${name}=<value> is required with ${HUDHOOK_OPT_IN_FLAG}`);
  }
  return value;
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

function canonicalDirectory(directoryPath: string) {
  try {
    const canonicalPath = realpathSync(directoryPath);
    if (statSync(canonicalPath).isDirectory()) {
      return canonicalPath;
    }
  } catch {
    // Report a stable launch-configuration error below.
  }
  throw new Error(`hudhook runtime directory is unavailable: ${directoryPath}`);
}

function canonicalFile(filePath: string, label: string) {
  try {
    const canonicalPath = realpathSync(filePath);
    if (statSync(canonicalPath).isFile()) {
      return canonicalPath;
    }
  } catch {
    // Report a stable launch-configuration error below.
  }
  throw new Error(`${label} is unavailable: ${filePath}`);
}

function assertDirectChild(
  runtimeDirectory: string,
  artifactPath: string,
  expectedFileName: string,
) {
  if (
    path.dirname(artifactPath).toLowerCase() !==
      runtimeDirectory.toLowerCase() ||
    path.basename(artifactPath).toLowerCase() !== expectedFileName.toLowerCase()
  ) {
    throw new Error(
      `hudhook artifact escaped its runtime directory: ${artifactPath}`,
    );
  }
}

function validateProcessName(processName: string) {
  if (
    processName.length === 0 ||
    processName.length > 260 ||
    processName !== path.basename(processName) ||
    !/^[a-zA-Z0-9._-]+\.exe$/i.test(processName)
  ) {
    throw new Error('the hudhook target process must be an .exe basename');
  }
}

function formatLaunchError(error: Error, stdout: string, stderr: string) {
  const output = [
    error.message,
    stdout.trim() ? `stdout: ${stdout.trim()}` : '',
    stderr.trim() ? `stderr: ${stderr.trim()}` : '',
  ].filter(Boolean);
  return output.join(' | ');
}
