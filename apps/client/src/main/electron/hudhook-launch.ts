import { execFile, type ChildProcess } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';

const HUDHOOK_OPT_IN_FLAG = '--hudhook-overlay';
const HUDHOOK_BACKEND_OPTION = '--hudhook-backend';
const HUDHOOK_RUNTIME_DIRECTORY_OPTION = '--hudhook-runtime-dir';
const HUDHOOK_AUTO_TARGET_PROCESS_OPTION = '--hudhook-auto-target-process';
const HUDHOOK_EXPECTED_TARGET_PID_OPTION = '--hudhook-expected-target-pid';
const INJECTOR_FILE_NAME = 'hudhook_overlay_injector.exe';
const REQUEST_TIMEOUT_MS = 10_000;
const TARGET_PROOF_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

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

export type HudhookTarget =
  | Readonly<{ processName: string }>
  | Readonly<{ windowTitle: string }>;

export type HudhookInvocation = Readonly<{
  executable: string;
  arguments: readonly string[];
  targetLabel: string;
}>;

export function parseHudhookLaunchConfig(
  argv: readonly string[],
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
    throw new Error('the hudhook overlay POC requires Windows x64');
  }

  const backendValue = readRequiredOption(argv, HUDHOOK_BACKEND_OPTION);
  if (backendValue !== 'd3d11' && backendValue !== 'd3d12') {
    throw new Error(`${HUDHOOK_BACKEND_OPTION} must be either d3d11 or d3d12`);
  }
  const backend: HudhookBackend = backendValue;

  const requestedRuntimeDirectory = readRequiredOption(
    argv,
    HUDHOOK_RUNTIME_DIRECTORY_OPTION,
  );
  if (!path.isAbsolute(requestedRuntimeDirectory)) {
    throw new Error(`${HUDHOOK_RUNTIME_DIRECTORY_OPTION} must be absolute`);
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
  private injectionRequested = false;
  private awaitingTargetProof = false;
  private targetProofTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(public readonly config: HudhookLaunchConfig) {}

  public get hasRequestedInjection() {
    return this.injectionRequested;
  }

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
    this.closeTargetProofWindow();

    const child = this.activeChild;
    this.activeChild = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }

  private closeTargetProofWindow() {
    this.awaitingTargetProof = false;
    if (this.targetProofTimer) {
      clearTimeout(this.targetProofTimer);
      this.targetProofTimer = null;
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
  const canonicalPath = realpathSync(directoryPath);
  if (!statSync(canonicalPath).isDirectory()) {
    throw new Error(
      `hudhook runtime path is not a directory: ${directoryPath}`,
    );
  }
  return canonicalPath;
}

function canonicalFile(filePath: string, label: string) {
  const canonicalPath = realpathSync(filePath);
  if (!statSync(canonicalPath).isFile()) {
    throw new Error(`${label} is not a file: ${filePath}`);
  }
  return canonicalPath;
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
