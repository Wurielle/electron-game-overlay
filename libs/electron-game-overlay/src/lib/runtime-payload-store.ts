import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';

const markerName = '.electron-game-overlay-payload.json';
const kind = 'electron-game-overlay-payload-v2';
const collectionMarkerName = '.electron-game-overlay-payload-collection.json';
const publicationMarkerName = '.electron-game-overlay-publishing.json';
export const RUNTIME_PUBLISHING_LEASE_NAME =
  '.electron-game-overlay-publishing-lease';
export const RUNTIME_PAYLOAD_NAMES = Object.freeze([
  'inject.exe',
  'inject32.exe',
  'electron_game_overlay_reshade_manager.exe',
  'electron_game_overlay_reshade_manager32.exe',
  'ReShade64.dll',
  'ReShade32.dll',
  'ReShade64.build.json',
  'ReShade32.build.json',
  'electron_game_overlay_runtime.build.json',
  'electron_game_overlay_runtime32.build.json',
  'electron_game_overlay.addon64',
  'electron_game_overlay.addon32',
  'ReShade.ini',
]);
export const RUNTIME_PAYLOAD_LEASE_NAME =
  '.electron-game-overlay-payload-lease';
export type RuntimePayloadStage = Readonly<{
  artifacts: readonly (readonly [string, string])[];
  payloadId?: string;
}>;
const maxUnusedPayloadVersions = 2;

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
  runId = randomUUID(),
): Promise<RuntimePayloadStage> {
  if (
    sources.size !== RUNTIME_PAYLOAD_NAMES.length ||
    [...sources.keys()].some((name) => !RUNTIME_PAYLOAD_NAMES.includes(name))
  ) {
    throw new Error(
      'the runtime payload must contain exactly the fixed thirteen artifacts',
    );
  }
  const hashes = await Promise.all(
    RUNTIME_PAYLOAD_NAMES.map(
      async (name) =>
        [name, digest(await readFile(sources.get(name)!))] as const,
    ),
  );
  if (privateHighCopies) {
    // The native helper reserved these explicit-owner high files at birth.
    // Do not publish or read a redundant medium snapshot for this lane.
    await validate(sources);
    await settled(
      hashes.map(async ([name, expected]) => {
        const bytes = await readFile(sources.get(name)!);
        if (digest(bytes) !== expected)
          throw new Error(`the private payload changed while staging ${name}`);
        const destination = path.join(sessionDirectory, name);
        await assertOrdinaryFile(destination);
        const target = await open(destination, 'r+');
        try {
          const info = await target.stat();
          if (!info.isFile() || info.nlink !== 1 || info.size !== 0)
            throw new Error(`the private payload reservation changed: ${name}`);
          await target.writeFile(bytes);
        } finally {
          await target.close();
        }
      }),
    );
    return Object.freeze({ artifacts: hashes });
  }
  const identity = JSON.stringify(hashes);
  const payloadId = digest(Buffer.from(identity));
  // A sibling keeps the cache outside session retention and on the same volume.
  const store = `${runsRoot}.payloads-v2`;
  await mkdir(store, { recursive: true });
  await assertOrdinaryDirectory(store);
  const payload = path.join(store, payloadId);
  const filesAt = (directory: string) =>
    new Map(
      [...sources.keys()].map((name) => [name, path.join(directory, name)]),
    );
  const verify = async () => {
    await assertOrdinaryDirectory(payload);
    const markerPath = path.join(payload, markerName);
    await assertOrdinaryFile(markerPath);
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (
      marker.kind !== kind ||
      marker.payloadId !== payloadId ||
      marker.identity !== identity
    ) {
      throw new Error(
        'the runtime payload cache ownership does not match its content identity',
      );
    }
    await Promise.all(
      hashes.map(async ([name, hash]) => {
        const file = path.join(payload, name);
        await assertOrdinaryFile(file);
        if (digest(await readFile(file)) !== hash) {
          throw new Error(
            `the runtime payload cache hash does not match ${name}`,
          );
        }
      }),
    );
    await validate(filesAt(payload));
  };
  const publish = async () => {
    try {
      await lstat(payload);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      const temporary = path.join(store, `.publishing-${randomUUID()}`);
      const publisherLease = path.join(
        sessionDirectory,
        RUNTIME_PUBLISHING_LEASE_NAME,
      );
      let leaseCreated = false,
        published = false;
      try {
        // The receipt is born as a hard link to the stage's lease. There is
        // never an unleased partial publication while its producer is writing.
        await writeFile(
          publisherLease,
          JSON.stringify({
            schemaVersion: 1,
            kind: 'electron-game-overlay-publishing-v1',
            payloadId,
            identity,
            runId,
            temporaryName: path.basename(temporary),
            sessionDirectoryName: path.basename(sessionDirectory),
          }),
          { flag: 'wx' },
        );
        leaseCreated = true;
        await mkdir(temporary);
        await link(publisherLease, path.join(temporary, publicationMarkerName));
        // Wait for all copies before cleanup, including failures.
        await settled(
          [...sources].map(async ([name, source]) => {
            const file = path.join(temporary, name);
            await copyFile(source, file);
            if (digest(await readFile(file)) !== new Map(hashes).get(name)) {
              throw new Error(
                `the runtime source changed while staging ${name}`,
              );
            }
          }),
        );
        await validate(filesAt(temporary));
        await writeFile(
          path.join(temporary, markerName),
          JSON.stringify({ kind, payloadId, identity }),
          { flag: 'wx' },
        );
        // Read-only is also enforced by Windows for ordinary write opens. This is
        // protection against accidental writes, not a boundary against the owner.
        await settled(
          [...sources.keys(), markerName].map((name) =>
            chmod(path.join(temporary, name), 0o444),
          ),
        );
        try {
          await rename(temporary, payload);
          published = true;
        } catch (error) {
          // Another app may have published the exact same snapshot concurrently.
          // Never overwrite it: the complete verification below must accept it.
          if (
            !hasCode(error, 'EEXIST') &&
            !hasCode(error, 'ENOTEMPTY') &&
            !hasCode(error, 'EPERM')
          )
            throw error;
        }
      } finally {
        try {
          if (published)
            await unlink(path.join(payload, publicationMarkerName));
          // Only this call's unpublished UUID directory can be removed here.
          await rm(temporary, { recursive: true, force: true });
        } finally {
          if (leaseCreated) await unlink(publisherLease);
        }
      }
    }
  };
  // A marker hard link leases a snapshot while its individual stage links are
  // being established. It survives a producer crash; collection never treats
  // app shutdown or a timeout as permission to remove that lease.
  const lease = path.join(sessionDirectory, RUNTIME_PAYLOAD_LEASE_NAME);
  for (let attempt = 0; attempt < 8; ++attempt) {
    const created: string[] = [];
    let leased = false;
    try {
      await publish();
      await link(path.join(payload, markerName), lease);
      leased = true;
      await verify();
      await settled(
        [...sources.keys()].map(async (name) => {
          const source = path.join(payload, name);
          const destination = path.join(sessionDirectory, name);
          if (
            name === 'ReShade.ini' ||
            name === 'electron_game_overlay.addon64' ||
            name === 'electron_game_overlay.addon32'
          ) {
            await copyFile(source, destination, constants.COPYFILE_EXCL);
            created.push(destination);
            await chmod(destination, 0o600);
          } else {
            // No copy fallback: a filesystem without hard links must fail explicitly
            // instead of silently recreating the storage amplification.
            await link(source, destination);
            created.push(destination);
          }
        }),
      );
      return Object.freeze({ artifacts: hashes, payloadId });
    } catch (error) {
      // A concurrent collector may have quarantined an unused snapshot just
      // before the lease was linked. Roll back only this attempt's fresh links
      // and retry publication; no target or payload has executed here.
      await settled(created.map((file) => unlink(file)));
      if (!hasCode(error, 'ENOENT') || attempt === 7) throw error;
    } finally {
      if (leased)
        try {
          await unlink(lease);
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error;
        }
    }
  }
  throw new Error('the runtime payload snapshot remained busy');
}

/** @internal Collect only complete verified snapshots with no stage aliases or
 * preparation leases. Never modifies published bytes or their attributes. */
export async function pruneRuntimePayloadCache(
  runsRoot: string,
  keepPayloadId?: string,
): Promise<void> {
  const store = `${runsRoot}.payloads-v2`;
  try {
    await assertOrdinaryDirectory(store);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  const candidates: Array<{
    directory: string;
    id: string;
    time: number;
    quarantined: boolean;
  }> = [];
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      /^\.publishing-[a-f0-9-]{36}$/u.test(entry.name)
    ) {
      await collectUnpublishedSnapshot(path.join(store, entry.name));
      continue;
    }
    const match = /^([a-f0-9]{64})$/u.exec(entry.name),
      pending = /^\.collecting-([a-f0-9]{64})-[a-f0-9-]{36}$/u.exec(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (!match && !pending))
      continue;
    const directory = path.join(store, entry.name),
      id = (match ?? pending)![1];
    try {
      if (match) {
        const publisher = await readUnleasedPublisher(directory);
        if (publisher?.payloadId === id)
          await unlink(path.join(directory, publicationMarkerName));
      }
      const state = await inspectSnapshot(directory, id, false);
      if (state.unused)
        candidates.push({
          directory,
          id,
          time: state.time,
          quarantined: !!pending,
        });
    } catch {
      /* Unknown, incomplete or corrupt entries are preserved. */
    }
  }
  candidates.sort(
    (a, b) =>
      Number(b.id === keepPayloadId) - Number(a.id === keepPayloadId) ||
      b.time - a.time ||
      a.id.localeCompare(b.id),
  );
  let retained = 0;
  for (const candidate of candidates) {
    if (!candidate.quarantined && retained++ < maxUnusedPayloadVersions)
      continue;
    const quarantine = candidate.quarantined
      ? candidate.directory
      : path.join(store, `.collecting-${candidate.id}-${randomUUID()}`);
    let collectionStarted = candidate.quarantined;
    try {
      if (!candidate.quarantined) await rename(candidate.directory, quarantine);
      const state = await inspectSnapshot(quarantine, candidate.id, true);
      if (!state.unused) {
        if (!candidate.quarantined)
          await rename(quarantine, candidate.directory).catch(() => undefined);
        continue;
      }
      const collectionMarker = path.join(quarantine, collectionMarkerName);
      try {
        await writeFile(
          collectionMarker,
          JSON.stringify({
            kind: 'electron-game-overlay-payload-collection-v1',
            payloadId: candidate.id,
            identity: state.identity,
            directoryName: path.basename(quarantine),
          }),
          { flag: 'wx' },
        );
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
      collectionStarted = true;
      // Quarantine removes the publication path before the final alias check.
      // New preparations can no longer link these objects by that path. Do
      // not use recursive/force deletion or chmod on potentially shared files.
      for (const name of [...RUNTIME_PAYLOAD_NAMES, markerName]) {
        try {
          await unlink(path.join(quarantine, name));
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error;
        }
      }
      await unlink(collectionMarker);
      await rmdir(quarantine);
    } catch {
      if (!collectionStarted && !candidate.quarantined)
        await rename(quarantine, candidate.directory).catch(() => undefined);
      // Contention, foreign entries, aliases and denied access retain storage.
    }
  }
}

async function readUnleasedPublisher(
  directory: string,
): Promise<
  { payloadId: string; identity: string; temporaryName: string } | undefined
> {
  const file = path.join(directory, publicationMarkerName);
  try {
    await assertOrdinaryFile(file);
    const info = await lstat(file);
    if (info.nlink !== 1 || info.size > 16384) return;
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (
      record.schemaVersion !== 1 ||
      record.kind !== 'electron-game-overlay-publishing-v1' ||
      typeof record.payloadId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(record.payloadId) ||
      typeof record.identity !== 'string' ||
      digest(Buffer.from(record.identity)) !== record.payloadId ||
      typeof record.runId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        record.runId,
      ) ||
      typeof record.temporaryName !== 'string' ||
      !/^\.publishing-[a-f0-9-]{36}$/u.test(record.temporaryName) ||
      typeof record.sessionDirectoryName !== 'string' ||
      path.win32.basename(record.sessionDirectoryName) !==
        record.sessionDirectoryName
    )
      return;
    const hashes: unknown = JSON.parse(record.identity);
    if (!Array.isArray(hashes) || hashes.length !== 13) return;
    const seen = new Set();
    for (const pair of hashes) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !RUNTIME_PAYLOAD_NAMES.includes(pair[0]) ||
        seen.has(pair[0]) ||
        typeof pair[1] !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(pair[1])
      )
        return;
      seen.add(pair[0]);
    }
    return record;
  } catch {
    return;
  }
}

async function collectUnpublishedSnapshot(directory: string): Promise<void> {
  try {
    await assertOrdinaryDirectory(directory);
    const publisher = await readUnleasedPublisher(directory);
    if (!publisher || publisher.temporaryName !== path.basename(directory))
      return;
    const names = await readdir(directory),
      allowed = [...RUNTIME_PAYLOAD_NAMES, markerName, publicationMarkerName];
    if (names.some((name) => !allowed.includes(name))) return;
    for (const name of names) {
      const file = path.join(directory, name);
      await assertOrdinaryFile(file);
      if ((await lstat(file)).nlink !== 1) return;
    }
    // These copies were never published, and their producer lease is gone.
    // Their data may be partial; do not execute, repair or relabel it.
    for (const name of names.filter((n) => n !== publicationMarkerName)) {
      try {
        await unlink(path.join(directory, name));
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    }
    await unlink(path.join(directory, publicationMarkerName));
    await rmdir(directory);
  } catch {
    /* Live leases, unknown contents and sharing failures preserve data. */
  }
}

async function inspectSnapshot(
  directory: string,
  id: string,
  verifyBytes: boolean,
): Promise<{ unused: boolean; time: number; identity: string }> {
  await assertOrdinaryDirectory(directory);
  const names = await readdir(directory);
  if (
    names.some(
      (name) =>
        name !== markerName &&
        name !== collectionMarkerName &&
        !RUNTIME_PAYLOAD_NAMES.includes(name),
    )
  )
    throw new Error('foreign snapshot entry');
  const marker = path.join(directory, markerName),
    collection = path.join(directory, collectionMarkerName);
  const partial = names.includes(collectionMarkerName);
  const recordPath = partial ? collection : marker;
  await assertOrdinaryFile(recordPath);
  const info = await lstat(recordPath);
  if (info.size > 16384 || info.nlink !== 1)
    throw new Error('invalid payload marker');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (
    record.kind !==
      (partial ? 'electron-game-overlay-payload-collection-v1' : kind) ||
    record.payloadId !== id ||
    typeof record.identity !== 'string' ||
    digest(Buffer.from(record.identity)) !== id ||
    (partial &&
      (record.directoryName !== path.basename(directory) ||
        !path.basename(directory).startsWith(`.collecting-${id}-`)))
  )
    throw new Error('invalid snapshot identity');
  if (!partial && names.length !== RUNTIME_PAYLOAD_NAMES.length + 1)
    throw new Error('incomplete snapshot');
  const hashes: unknown = JSON.parse(record.identity);
  if (!Array.isArray(hashes) || hashes.length !== RUNTIME_PAYLOAD_NAMES.length)
    throw new Error('invalid snapshot inventory');
  const seen = new Set<string>();
  let unused = info.nlink === 1;
  if (partial && names.includes(markerName)) {
    await assertOrdinaryFile(marker);
    unused &&= (await lstat(marker)).nlink === 1;
  }
  for (const pair of hashes) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !RUNTIME_PAYLOAD_NAMES.includes(pair[0]) ||
      seen.has(pair[0]) ||
      typeof pair[1] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(pair[1])
    )
      throw new Error('invalid snapshot artifact');
    seen.add(pair[0]);
    if (partial && !names.includes(pair[0])) continue;
    const file = path.join(directory, pair[0]);
    await assertOrdinaryFile(file);
    unused &&= (await lstat(file)).nlink === 1;
    if (verifyBytes && digest(await readFile(file)) !== pair[1])
      throw new Error('changed snapshot artifact');
  }
  return { unused, time: info.mtimeMs, identity: record.identity };
}

async function settled(work: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

async function assertOrdinaryDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(directory)).toLowerCase() !==
      path.resolve(directory).toLowerCase()
  ) {
    throw new Error(
      'the runtime payload cache must be a canonical ordinary directory',
    );
  }
}

async function assertOrdinaryFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('the runtime payload cache must contain ordinary files');
  }
}
