import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateDistribution } from './overlay-broker-installation.js';

/** Structural electron-builder context; no electron-builder runtime dependency. */
export type OverlayAfterPackContext = Readonly<{
  appOutDir: string;
  electronPlatformName: string;
}>;
export type OverlayPackagingOptions = Readonly<{
  /** Installed SDK root override, e.g. dirname(require.resolve('electron-game-overlay/package.json')). pnpm package-root symlinks are supported. */
  packageRoot?: string;
}>;
export type OverlayPackagingResult = Readonly<{
  packageDirectory: string;
  files: number;
  sealedPayloads: number;
}>;

/**
 * Verifies all sealed payloads and their root runtime/module mirrors, without
 * caching, registering, executing or starting any broker/native code.
 */
export async function verifyOverlayPackage(
  packageRoot: string,
): Promise<Readonly<{ sealedPayloads: number }>> {
  const root = await fs.realpath(packageRoot);
  const metadata = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8'),
  );
  if (metadata.name !== 'electron-game-overlay')
    throw new Error('Expected electron-game-overlay package');
  const dist = path.join(root, 'dist');
  const manifest = await validateDistribution(
    path.join(dist, 'broker', 'win32-x64'),
  );
  for (const file of manifest.files) {
    if (!/^(lib|runtime)\//.test(file.path)) continue;
    const bytes = await fs.readFile(path.join(dist, file.path));
    if (bytes.length !== file.size || digest(bytes) !== file.sha256)
      throw new Error('SDK/provider mirror mismatch: ' + file.path);
  }
  return Object.freeze({ sealedPayloads: manifest.files.length });
}

/**
 * Restores the complete SDK distribution after electron-builder dependency
 * pruning and ASAR creation, before signing. Copies only SDK package metadata,
 * legal/provenance documents and dist, including sealed nested node_modules.
 * Top-level peer dependencies/.bin are not package payload and are not copied.
 * Replaces only this package under the supplied build output; never an install.
 */
export async function packageOverlayForElectronBuilder(
  context: OverlayAfterPackContext,
  options: OverlayPackagingOptions = {},
): Promise<OverlayPackagingResult | undefined> {
  if (context.electronPlatformName !== 'win32') return undefined;
  if (!path.isAbsolute(context.appOutDir))
    throw new Error('appOutDir must be absolute');
  const appOut = await fs.realpath(context.appOutDir);
  const source = await fs.realpath(
    options.packageRoot ?? path.resolve(__dirname, '..', '..'),
  );
  const verified = await verifyOverlayPackage(source);
  const parent = path.join(
    appOut,
    'resources',
    'app.asar.unpacked',
    'node_modules',
  );
  // Resolve existing ancestors before mkdir/copy. A junction must not redirect
  // writes outside this explicit build output.
  await assertWithinOutput(appOut, parent);
  await fs.mkdir(parent, { recursive: true });
  const destination = path.join(parent, 'electron-game-overlay');
  if (inside(source, destination) || inside(destination, source))
    throw new Error('SDK source and packaging output must not overlap');
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('SDK output must be a regular directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staging = await fs.mkdtemp(path.join(parent, '.ego-package-'));
  const backup = path.join(parent, '.ego-previous-' + randomUUID());
  let moved = false;
  let installed = false;
  let files = 0;
  try {
    for (const name of [
      'package.json',
      'README.md',
      'LICENSE',
      'SDK_PROVENANCE.json',
      'dist',
    ]) {
      try {
        await fs.lstat(path.join(source, name));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' &&
          ['README.md', 'SDK_PROVENANCE.json'].includes(name)
        )
          continue;
        throw error;
      }
      files += await copyVerified(
        path.join(source, name),
        path.join(staging, name),
      );
    }
    await verifyOverlayPackage(staging);
    try {
      await fs.rename(destination, backup);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rename(staging, destination);
    installed = true;
    // Verify the actual final output, rather than trusting copy completion.
    await verifyOverlayPackage(destination);
    if (moved) await fs.rm(backup, { recursive: true });
    return Object.freeze({
      packageDirectory: destination,
      files,
      sealedPayloads: verified.sealedPayloads,
    });
  } catch (error) {
    if (installed) await fs.rm(destination, { recursive: true });
    if (moved) await fs.rename(backup, destination);
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** SDK-owned electron-builder afterPack hook; compose with other application hooks. */
export function createOverlayAfterPack(
  options: OverlayPackagingOptions = {},
): (context: OverlayAfterPackContext) => Promise<void> {
  const snapshot = Object.freeze({ ...options });
  return async (context) => {
    await packageOverlayForElectronBuilder(context, snapshot);
  };
}
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith('..' + path.sep))
  );
}
async function assertWithinOutput(
  root: string,
  candidate: string,
): Promise<void> {
  let existing = candidate;
  for (;;) {
    try {
      if (!inside(root, await fs.realpath(existing)))
        throw new Error('SDK packaging output escapes appOutDir');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing)
        throw new Error('SDK packaging output is invalid');
      existing = parent;
    }
  }
}
async function copyVerified(
  source: string,
  destination: string,
): Promise<number> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink())
    throw new Error('Symbolic link inside SDK payload refused');
  if (stat.isDirectory()) {
    await fs.mkdir(destination);
    let count = 0;
    for (const name of await fs.readdir(source))
      count += await copyVerified(
        path.join(source, name),
        path.join(destination, name),
      );
    return count;
  }
  if (!stat.isFile()) throw new Error('Nonregular SDK payload refused');
  const bytes = await fs.readFile(source);
  await fs.writeFile(destination, bytes, { flag: 'wx' });
  if (digest(await fs.readFile(destination)) !== digest(bytes))
    throw new Error('SDK package copy verification failed');
  return 1;
}
