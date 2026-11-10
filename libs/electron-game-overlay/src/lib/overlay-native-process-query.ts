import { execFile } from 'node:child_process';
import { dirname, isAbsolute, win32 } from 'node:path';
import {
  isValidProcessCreationTime100ns,
  type OverlayBrokerProcessIdentity,
} from './overlay-process-identity.js';

/** @internal Query the exact recorded incarnation. Denied, malformed or
 * otherwise unavailable evidence is unknown. Only a different OS creation
 * identity or the native OpenProcess ERROR_INVALID_PARAMETER proves exit. */
export async function overlayProcessIncarnationExited(
  identity: Readonly<{ pid: number; creationTime100ns: string }>,
  addonManagerPath: string,
): Promise<boolean> {
  if (
    !Number.isInteger(identity.pid) ||
    identity.pid < 1 ||
    identity.pid > 0xffffffff ||
    !isValidProcessCreationTime100ns(identity.creationTime100ns) ||
    !isAbsolute(addonManagerPath)
  )
    return false;
  return new Promise((resolve) =>
    execFile(
      addonManagerPath,
      ['--query-process-image', String(identity.pid)],
      {
        shell: false,
        windowsHide: true,
        cwd: dirname(addonManagerPath),
        timeout: 2000,
        maxBuffer: 16384,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        try {
          if (stderr.trim() || /[\r\n]/u.test(stdout.trim()))
            return resolve(false);
          const r = JSON.parse(stdout);
          if (!r || typeof r !== 'object' || Array.isArray(r))
            return resolve(false);
          if (error)
            return resolve(
              error.code === 5 &&
                Object.keys(r).sort().join(',') ===
                  'code,kind,message,operation,schemaVersion,status,windowsError' &&
                r.schemaVersion === 1 &&
                r.kind ===
                  'electron-game-overlay-reshade-addon-manager-result' &&
                r.operation === 'query-process-image' &&
                r.status === 'error' &&
                r.code === 'process-query-failed' &&
                r.windowsError === 87 &&
                r.message ===
                  'Unable to open the process for read-only identity inspection.',
            );
          resolve(
            Object.keys(r).sort().join(',') ===
              'creationTime100ns,executablePath,kind,pid,schemaVersion' &&
              r.schemaVersion === 1 &&
              r.kind === 'electron-game-overlay-process-image' &&
              r.pid === identity.pid &&
              typeof r.executablePath === 'string' &&
              win32.isAbsolute(r.executablePath) &&
              isValidProcessCreationTime100ns(r.creationTime100ns) &&
              r.creationTime100ns !== identity.creationTime100ns,
          );
        } catch {
          resolve(false);
        }
      },
    ),
  );
}

/** @internal Read-only OS identity query through the already validated native manager. */
export async function resolveOverlayNativeProcessIdentity(
  pid: number,
  addonManagerPath: string,
): Promise<OverlayBrokerProcessIdentity> {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0xffffffff) {
    throw new RangeError('Target PID must be a positive uint32');
  }
  if (typeof addonManagerPath !== 'string' || !isAbsolute(addonManagerPath)) {
    throw new Error('A validated absolute native manager path is required');
  }
  let output: string;
  try {
    output = await new Promise<string>((resolve, reject) => {
      execFile(
        addonManagerPath,
        ['--query-process-image', String(pid)],
        {
          shell: false,
          windowsHide: true,
          cwd: dirname(addonManagerPath),
          timeout: 2000,
          maxBuffer: 128 * 1024,
          encoding: 'utf8',
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  } catch (error) {
    throw new Error(
      `Unable to query OS executable identity for PID ${pid}; validated native probe failed`,
      { cause: error },
    );
  }
  let record: unknown;
  try {
    if (/[\r\n]/.test(output.replace(/\r?\n$/, '')))
      throw new Error('Expected one JSON line');
    record = JSON.parse(output);
  } catch (error) {
    throw new Error(`OS executable identity unavailable for PID ${pid}`, {
      cause: error,
    });
  }
  if (
    typeof record !== 'object' ||
    record === null ||
    !('schemaVersion' in record) ||
    record.schemaVersion !== 1 ||
    !('kind' in record) ||
    record.kind !== 'electron-game-overlay-process-image' ||
    !('pid' in record) ||
    record.pid !== pid ||
    !('executablePath' in record) ||
    typeof record.executablePath !== 'string'
  ) {
    throw new Error(`OS executable identity unavailable for PID ${pid}`);
  }
  const executablePath = record.executablePath;
  if (
    !win32.isAbsolute(executablePath) ||
    !/^([a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(executablePath) ||
    executablePath.length > 32767 ||
    /[\x00-\x1f]/.test(executablePath)
  ) {
    throw new Error(`OS executable identity unavailable for PID ${pid}`);
  }
  if (
    'creationTime100ns' in record &&
    !isValidProcessCreationTime100ns(record.creationTime100ns)
  ) {
    throw new Error(`OS executable identity unavailable for PID ${pid}`);
  }
  return {
    pid,
    executablePath,
    ...('creationTime100ns' in record
      ? { creationTime100ns: record.creationTime100ns as string }
      : {}),
  };
}
