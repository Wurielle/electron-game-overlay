import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { createReShadeLaunchConfig } from './reshade-launcher.js';
import { isValidProcessCreationTime100ns } from './overlay-process-identity.js';

/** Exact process incarnation observed through retained Windows process handles. */
export type OverlayProcessIdentity = Readonly<{
  pid: number;
  executablePath: string;
  creationTime100ns: string;
}>;

/** Options for a read-only, future-only Windows process observation lifetime. */
export type OverlayProcessObserverOptions = Readonly<{
  /** Case-insensitive Windows path substring; defaults to every full path. */
  pathContains?: string;
  /** Optional complete SDK runtime directory, validated before execution. */
  runtimeDirectory?: string;
  /** A newly observed process with a proven creation identity and image. */
  onCreated: (process: OverlayProcessIdentity) => void;
  /** Only authoritative OS process exit; never emitted on observer failure. */
  onExited?: (process: OverlayProcessIdentity) => void;
  /** Terminal observation failure; does not imply any target exited. */
  onError?: (error: Error) => void;
  /** Cancels observation and rejects readiness if it has not completed. */
  signal?: AbortSignal;
}>;

/**
 * Observe future Windows processes without injecting. Await ready before
 * launching a target. Processes predating the native observer are baselined.
 * Policy decisions belong to the caller; exact-PID attachment can still be too
 * late for fast graphics initialization. Dispose stops observation only.
 */
export function observeOverlayProcesses(
  options: OverlayProcessObserverOptions,
) {
  if (process.platform !== 'win32')
    throw new Error('Process observation requires Windows');
  options.signal?.throwIfAborted();
  const fragment = options.pathContains ?? '\\';
  if (!fragment || fragment.includes('\0') || !/[\\/]/.test(fragment))
    throw new Error('pathContains must contain a path separator');
  const config = createReShadeLaunchConfig({
    ...(options.runtimeDirectory === undefined
      ? {}
      : { bundledRuntimeDirectory: options.runtimeDirectory }),
  });
  if (config.injectorFutureTargets === undefined)
    throw new Error(
      'Process observation requires validated future-target injector support',
    );
  const child = spawn(
    config.injectorPath,
    [
      '--observe-future-path-contains',
      fragment,
      '--parent-pid',
      String(process.pid),
    ],
    {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  let stopped = false,
    armed = false,
    pending = '';
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A subscriber may await ready after installing callbacks without an
  // intervening unhandled rejection if native startup fails immediately.
  void ready.catch(() => undefined);
  const tracked = new Map<number, OverlayProcessIdentity>();
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    child.kill();
    tracked.clear();
    if (!armed)
      rejectReady(new Error('Process observer disposed before readiness'));
  };
  const fail = (error: Error) => {
    if (stopped) return;
    rejectReady(error);
    dispose();
    try {
      options.onError?.(error);
    } catch {
      /* Observers cannot prevent teardown. */
    }
  };
  const abort = () => fail(new Error('Process observation cancelled'));
  const timer = setTimeout(
    () => fail(new Error('Process observer ready handshake timed out')),
    5000,
  );
  child.once('error', fail);
  child.once('exit', () =>
    fail(
      new Error(
        'Process observer exited unexpectedly; target exits are unknown',
      ),
    ),
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (stopped) return;
    pending += chunk;
    let index: number;
    while (!stopped && (index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      if (!armed && line === 'EGO_PROCESS_OBSERVER_READY_V2') {
        armed = true;
        clearTimeout(timer);
        resolveReady();
        continue;
      }
      const match =
        /^EGO_PROCESS_(CREATE|DELETE)_V2\t([1-9][0-9]*)\t([1-9][0-9]*)\t([^\t\r\n]+)$/.exec(
          line,
        );
      if (!armed || !match || line.length > 65536) {
        fail(new Error('Invalid process observer record'));
        return;
      }
      const pid = Number(match[2]);
      if (
        !Number.isInteger(pid) ||
        pid > 0xffffffff ||
        !isValidProcessCreationTime100ns(match[3]) ||
        !win32.isAbsolute(match[4])
      ) {
        fail(new Error('Invalid process observer identity'));
        return;
      }
      const identity = Object.freeze({
        pid,
        creationTime100ns: match[3],
        executablePath: match[4],
      });
      if (match[1] === 'CREATE') {
        if (tracked.has(pid)) {
          fail(new Error('Duplicate live process identity'));
          return;
        }
        tracked.set(pid, identity);
        try {
          options.onCreated(identity);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      } else {
        const prior = tracked.get(pid);
        if (
          !prior ||
          prior.creationTime100ns !== identity.creationTime100ns ||
          prior.executablePath !== identity.executablePath
        ) {
          fail(new Error('Process exit identity mismatch'));
          return;
        }
        tracked.delete(pid);
        try {
          options.onExited?.(prior);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    }
    if (pending.length > 65536)
      fail(new Error('Oversized process observer record'));
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  return Object.freeze({ ready, dispose });
}
