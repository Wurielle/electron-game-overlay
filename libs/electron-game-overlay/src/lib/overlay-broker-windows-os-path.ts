import { realpath } from 'node:fs';
import { win32 } from 'node:path';

/** @internal Resolve the OS-owned Object Manager link, never environment/app paths.
 * libuv's native Windows realpath uses GetFinalPathNameByHandleW (VOLUME_NAME_DOS).
 * CreateProcess needs a Win32 current directory, not a GLOBALROOT device path.
 */
export async function resolveOverlayBrokerSystemDirectory(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('Trusted OS system directory resolution timed out'));
    }, 2000);
    try {
      realpath.native(
        '\\\\?\\GLOBALROOT\\SystemRoot\\System32',
        (error, path) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else if (
            !/^[a-z]:\\/i.test(path) ||
            path.length > 240 ||
            /[\x00-\x1f<>:"|?*]/.test(path.slice(2)) ||
            win32.normalize(path) !== path
          ) {
            reject(
              new Error(
                'OS system directory did not resolve to a canonical Win32 DOS path',
              ),
            );
          } else resolve(path);
        },
      );
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}
