import * as path from 'node:path';
import {
  registerOverlayBrokerInstallation,
  unregisterOverlayBrokerInstallation,
  type OverlayBrokerInstallationOptions,
} from './overlay-broker-installation.js';

/** @internal Handles fixed setup flags without starting the broker service. */
export async function runOverlayBrokerSetup(
  args: readonly string[],
  options: OverlayBrokerInstallationOptions = {},
): Promise<boolean> {
  if (
    args[0] === '--register' &&
    (args.length === 1 ||
      (args.length === 2 && args[1] === '--allow-prerelease'))
  ) {
    const id = await registerOverlayBrokerInstallation({
      ...options,
      distributionPath:
        options.distributionPath ?? path.dirname(process.execPath),
      allowPrerelease: args.length === 2,
    });
    console.log(id);
    return true;
  }
  if (
    args.length === 2 &&
    args[0] === '--unregister' &&
    /^[0-9a-f]{64}$/.test(args[1])
  ) {
    await unregisterOverlayBrokerInstallation(args[1], options);
    return true;
  }
  if (args.length === 1 && args[0] === '--help') {
    console.log(`Electron Game Overlay broker
Usage:
  electron-game-overlay-broker
  electron-game-overlay-broker --register [--allow-prerelease]
  electron-game-overlay-broker --unregister <registration-id>
  electron-game-overlay-broker --help

No arguments starts the broker service.
Register copies this executable directory's distribution and prints its registration ID.
--allow-prerelease permits preview registration; it does not opt clients into previews.
Setup only updates the current OS user's optional catalog/cache; it never starts a broker.
Run setup as the intended user, not SYSTEM or a different administrator account.
Elevated setup writes for its current account only; it does not bypass the service's privilege guard.
Unregister retains cached files needed by active brokers.
`);
    return true;
  }
  if (args.length === 0) return false;
  throw new TypeError('Invalid broker setup arguments; use --help for usage.');
}
