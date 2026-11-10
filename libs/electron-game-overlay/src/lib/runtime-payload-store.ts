import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const markerName = '.electron-game-overlay-payload.json';
const kind = 'electron-game-overlay-payload-v1';

/** Cache snapshots, never package files. The INI and add-on image identities
 * are private per session. Windows merges hard-linked DLLs into one HMODULE,
 * so linking participant images would merge independent applications' globals.
 * Hard links preserve the canonical stage paths required by the native ownership
 * checks, while storing each immutable file once per verified payload. The SDK
 * never opens these links for writing or replaces a published cache entry.
 */
export async function stageRuntimePayload(
  sources: ReadonlyMap<string, string>,
  runsRoot: string,
  sessionDirectory: string,
  validate: (files: ReadonlyMap<string, string>) => Promise<unknown>,
  privateHighCopies = false,
): Promise<void> {
  const hashes = await Promise.all([...sources].map(async ([name, file]) =>
    [name, digest(await readFile(file))] as const));
  const identity = JSON.stringify(hashes);
  const payloadId = digest(Buffer.from(identity));
  // A sibling keeps the cache outside session retention and on the same volume.
  const store = `${runsRoot}.payloads-v1`;
  await mkdir(store, { recursive: true });
  await assertOrdinaryDirectory(store);
  const payload = path.join(store, payloadId);
  const filesAt = (directory: string) => new Map([...sources.keys()].map(name =>
    [name, path.join(directory, name)]));
  const verify = async () => {
    await assertOrdinaryDirectory(payload);
    const markerPath = path.join(payload, markerName);
    await assertOrdinaryFile(markerPath);
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (marker.kind !== kind || marker.payloadId !== payloadId || marker.identity !== identity) {
      throw new Error('the runtime payload cache ownership does not match its content identity');
    }
    await Promise.all(hashes.map(async ([name, hash]) => {
      const file = path.join(payload, name);
      await assertOrdinaryFile(file);
      if (digest(await readFile(file)) !== hash) {
        throw new Error(`the runtime payload cache hash does not match ${name}`);
      }
    }));
    await validate(filesAt(payload));
  };
  try {
    await lstat(payload);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    const temporary = path.join(store, `.publishing-${randomUUID()}`);
    await mkdir(temporary);
    try {
      // Wait for all copies before cleanup, including failures.
      await settled([...sources].map(async ([name, source]) => {
        const file = path.join(temporary, name);
        await copyFile(source, file);
        if (digest(await readFile(file)) !== new Map(hashes).get(name)) {
          throw new Error(`the runtime source changed while staging ${name}`);
        }
      }));
      await validate(filesAt(temporary));
      await writeFile(path.join(temporary, markerName), JSON.stringify({ kind, payloadId, identity }), { flag: 'wx' });
      // Read-only is also enforced by Windows for ordinary write opens. This is
      // protection against accidental writes, not a boundary against the owner.
      await settled([...sources.keys(), markerName].map(name => chmod(path.join(temporary, name), 0o444)));
      try {
        await rename(temporary, payload);
      } catch (error) {
        // Another app may have published the exact same snapshot concurrently.
        // Never overwrite it: the complete verification below must accept it.
        if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EPERM')) throw error;
      }
    } finally {
      // Only this call's unpublished UUID directory can be removed here.
      await rm(temporary, { recursive: true, force: true });
    }
  }
  await verify();
  await settled([...sources.keys()].map(async name => {
    const source = path.join(payload, name);
    const destination = path.join(sessionDirectory, name);
    if (privateHighCopies) {
      // A hard link would leave a medium-writable alias to a high executable.
      // Fill only the native helper's empty high file with explicit user
      // ownership at birth; copyFile may preserve snapshot security metadata.
      const bytes = await readFile(source);
      if (digest(bytes) !== new Map(hashes).get(name)) throw new Error(`the private payload changed while staging ${name}`);
      await assertOrdinaryFile(destination);
      const target = await open(destination, 'r+');
      try {
        const info = await target.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size !== 0) throw new Error(`the private payload reservation changed: ${name}`);
        await target.writeFile(bytes);
      } finally { await target.close(); }
    } else if (name === 'ReShade.ini' || name === 'electron_game_overlay.addon64' || name === 'electron_game_overlay.addon32') {
      await copyFile(source, destination);
      await chmod(destination, 0o600);
    } else {
      // No copy fallback: a filesystem without hard links must fail explicitly
      // instead of silently recreating the storage amplification.
      await link(source, destination);
    }
  }));
}

async function settled(work: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function assertOrdinaryDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (await realpath(directory)).toLowerCase() !== path.resolve(directory).toLowerCase()) {
    throw new Error('the runtime payload cache must be a canonical ordinary directory');
  }
}

async function assertOrdinaryFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('the runtime payload cache must contain ordinary files');
  }
}
