import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { isValidProcessCreationTime100ns } from './overlay-process-identity.js';
import {
  RUNTIME_PAYLOAD_NAMES,
  RUNTIME_PAYLOAD_LEASE_NAME,
  RUNTIME_PUBLISHING_LEASE_NAME,
  type RuntimePayloadStage,
} from './runtime-payload-store.js';

export const RUNTIME_STORAGE_MARKER_NAME =
  '.electron-game-overlay-storage-v1.json';
const ownershipName = '.electron-game-overlay-run.json',
  retirementName = '.electron-game-overlay-run-reclaimable.json';
const storageKind = 'electron-game-overlay-runtime-storage';
const maxRecordBytes = 16384;
export const MAX_RETIRED_DIAGNOSTIC_BYTES = 64 * 1024;
const diagnostics = [
  'inject.stdout.log',
  'inject.stderr.log',
  'ReShade.log',
  '.electron-game-overlay-runtime-startup.json',
];
/** @internal Fixed stage-owned metadata; leases intentionally alias cache receipts. */
export const RUNTIME_STORAGE_TRANSIENT_NAMES = Object.freeze([
  RUNTIME_PAYLOAD_LEASE_NAME,
  RUNTIME_PUBLISHING_LEASE_NAME,
  'electron-game-overlay-owned-runtime-v1.marker',
  'ego-process-policy.txt',
  'electron-overlay-transport-v1.json',
]);
const imageRules = [
  ['electron_game_overlay.addon64', 64, 'addonSha256'],
  ['electron_game_overlay.addon32', 32, 'addonSha256'],
  ['inject.exe', 64, 'injectorSha256'],
  ['inject32.exe', 32, 'injectorSha256'],
  ['electron_game_overlay_reshade_manager.exe', 64, 'managerSha256'],
  ['electron_game_overlay_reshade_manager32.exe', 32, 'managerSha256'],
  ['ReShade64.dll', 64, 'reshadeRuntimeSha256'],
  ['ReShade32.dll', 32, 'reshadeRuntimeSha256'],
] as const;
export type RuntimeStorageProcessIdentity = Readonly<{
  pid: number;
  creationTime100ns: string;
}>;
type StorageRecord = {
  schemaVersion: 1;
  kind: typeof storageKind;
  runId: string;
  directoryName: string;
  consumer: RuntimeStorageProcessIdentity | null;
  phase: 'prepared' | 'attempted';
  target: RuntimeStorageProcessIdentity | null;
  artifacts: readonly (readonly [string, string])[];
  payloadId?: string;
};
const recordTransactions = new Map<string, Promise<void>>();
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex').toUpperCase();
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const identity = (v: unknown): v is RuntimeStorageProcessIdentity =>
  object(v) &&
  Number.isInteger(v.pid) &&
  Number(v.pid) > 0 &&
  Number(v.pid) <= 0xffffffff &&
  isValidProcessCreationTime100ns(v.creationTime100ns);
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-F0-9]{64}$/u.test(v);
const code = (e: unknown, c: string) => object(e) && e.code === c;
const validRunId = (v: unknown) =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
    v,
  );

async function readRecord(
  file: string,
): Promise<Record<string, unknown> | undefined> {
  let handle;
  try {
    const before = await lstat(file, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > BigInt(maxRecordBytes)
    )
      return;
    handle = await open(file, 'r');
    const actual = await handle.stat({ bigint: true });
    if (actual.dev !== before.dev || actual.ino !== before.ino) return;
    const buffer = Buffer.alloc(maxRecordBytes + 1),
      read = await handle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead > maxRecordBytes) return;
    const value: unknown = JSON.parse(
      buffer
        .subarray(0, read.bytesRead)
        .toString('utf8')
        .replace(/^\uFEFF/u, ''),
    );
    const after = await lstat(file, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.size !== after.size ||
      !object(value)
    )
      return;
    return value;
  } catch {
    return;
  } finally {
    await handle?.close();
  }
}
async function atomicRecord(
  directory: string,
  name: string,
  record: unknown,
): Promise<void> {
  if (!object(record) || !validRunId(record.runId))
    throw new Error('Invalid owned storage record');
  const temporary = path.join(
    directory,
    `.storage-${record.runId}-${randomUUID()}.json`,
  );
  try {
    await writeFile(temporary, JSON.stringify(record) + '\n', { flag: 'wx' });
    await rename(temporary, path.join(directory, name));
  } finally {
    await unlink(temporary).catch((e) => {
      if (!code(e, 'ENOENT')) throw e;
    });
  }
}
async function readStorage(
  directory: string,
  runId: string,
): Promise<StorageRecord | undefined> {
  const v = await readRecord(path.join(directory, RUNTIME_STORAGE_MARKER_NAME));
  if (
    !v ||
    v.schemaVersion !== 1 ||
    v.kind !== storageKind ||
    v.runId !== runId ||
    v.directoryName !== path.basename(directory) ||
    !(v.consumer === null || identity(v.consumer)) ||
    !['prepared', 'attempted'].includes(String(v.phase)) ||
    !(v.target === null || identity(v.target)) ||
    !Array.isArray(v.artifacts) ||
    v.artifacts.length > 13
  )
    return;
  const seen = new Set<string>();
  for (const pair of v.artifacts) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !RUNTIME_PAYLOAD_NAMES.includes(pair[0]) ||
      seen.has(pair[0]) ||
      !hash(pair[1])
    )
      return;
    seen.add(pair[0]);
  }
  return v as unknown as StorageRecord;
}

/** @internal This journal records preparation/attempt facts, never ownership
 * release. The attempted state is durable before native execution is allowed. */
export async function createRuntimeStorageRecord(
  directory: string,
  runId: string,
  consumer: RuntimeStorageProcessIdentity | null,
): Promise<void> {
  const record: StorageRecord = {
    schemaVersion: 1,
    kind: storageKind,
    runId,
    directoryName: path.basename(directory),
    consumer,
    phase: 'prepared',
    target: null,
    artifacts: [],
  };
  await writeFile(
    path.join(directory, RUNTIME_STORAGE_MARKER_NAME),
    JSON.stringify(record) + '\n',
    { flag: 'wx' },
  );
}
async function updateStorage(
  directory: string,
  runId: string,
  update: (record: StorageRecord) => StorageRecord,
): Promise<void> {
  const previous = recordTransactions.get(directory) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(async () => {
      const record = await readStorage(directory, runId);
      if (!record)
        throw new Error(
          'The runtime storage journal no longer matches this run',
        );
      await atomicRecord(
        directory,
        RUNTIME_STORAGE_MARKER_NAME,
        update(record),
      );
    });
  recordTransactions.set(directory, pending);
  try {
    await pending;
  } finally {
    if (recordTransactions.get(directory) === pending)
      recordTransactions.delete(directory);
  }
}
export async function recordRuntimeStorageArtifacts(
  directory: string,
  runId: string,
  stage: RuntimePayloadStage,
): Promise<void> {
  await updateStorage(directory, runId, (r) => ({
    ...r,
    artifacts: stage.artifacts.map(
      ([name, sha]) => [name, sha.toUpperCase()] as const,
    ),
    ...(stage.payloadId ? { payloadId: stage.payloadId } : {}),
  }));
}
export async function recordRuntimeStorageAttempt(
  directory: string,
  runId: string,
  target: RuntimeStorageProcessIdentity | null,
): Promise<void> {
  if (target !== null && !identity(target))
    throw new Error('Invalid runtime storage target identity');
  await updateStorage(directory, runId, (r) => ({
    ...r,
    phase: 'attempted',
    target,
  }));
}

export async function inspectRuntimeStorageRun(directory: string): Promise<
  | Readonly<{
      runId: string;
      unmapped: boolean;
      storage?: StorageRecord;
      legacyTarget?: RuntimeStorageProcessIdentity;
    }>
  | undefined
> {
  try {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(directory)).toLowerCase() !==
        path.resolve(directory).toLowerCase()
    )
      return;
    const owned = await readRecord(path.join(directory, ownershipName));
    if (
      !owned ||
      owned.schemaVersion !== 1 ||
      owned.kind !== 'electron-game-overlay-reshade-run' ||
      !validRunId(owned.runId) ||
      owned.directoryName !== path.basename(directory) ||
      typeof owned.createdAt !== 'string' ||
      new Date(owned.createdAt).toISOString() !== owned.createdAt
    )
      return;
    const runId = String(owned.runId),
      retired = await readRecord(path.join(directory, retirementName));
    const unmapped =
      !!retired &&
      retired.schemaVersion === 1 &&
      retired.kind === 'electron-game-overlay-reshade-run-reclaimable' &&
      retired.runId === runId &&
      retired.directoryName === path.basename(directory) &&
      retired.privateImagesUnmapped === true &&
      typeof retired.retiredAt === 'string' &&
      new Date(retired.retiredAt).toISOString() === retired.retiredAt;
    const storage = await readStorage(directory, runId);
    let legacyTarget: RuntimeStorageProcessIdentity | undefined;
    if (!storage || (storage.phase === 'attempted' && !storage.target)) {
      const file = path.join(directory, 'inject.stdout.log'),
        info = await lstat(file).catch(() => undefined);
      if (
        info?.isFile() &&
        !info.isSymbolicLink() &&
        info.nlink === 1 &&
        info.size <= MAX_RETIRED_DIAGNOSTIC_BYTES
      ) {
        const matches = [
          ...(await readFile(file, 'utf8')).matchAll(
            /(?:^|\n)EGO_TARGET_SELECTED_V2\t([1-9][0-9]*)\t([1-9][0-9]*)\t([^\t\r\n]+)\r?\n/gu,
          ),
        ];
        if (matches.length === 1) {
          const candidate = {
            pid: Number(matches[0][1]),
            creationTime100ns: matches[0][2],
          };
          if (identity(candidate) && path.win32.isAbsolute(matches[0][3]))
            legacyTarget = candidate;
        }
      }
    }
    return {
      runId,
      unmapped,
      ...(storage ? { storage } : {}),
      ...(legacyTarget ? { legacyTarget } : {}),
    };
  } catch {
    return;
  }
}

/** @internal The callback must return only authoritative OS incarnation exit
 * evidence; an unavailable/denied query is unknown, never process exit. */
export async function recoverRuntimeStorageRun(
  directory: string,
  probe: (identity: RuntimeStorageProcessIdentity) => Promise<boolean>,
): Promise<boolean> {
  const state = await inspectRuntimeStorageRun(directory);
  if (!state) return false;
  if (state.unmapped) return true;
  const target =
    state.storage?.phase === 'prepared'
      ? state.storage.consumer
      : (state.storage?.target ?? state.legacyTarget);
  if (!target || !(await probe(target))) return false;
  const again = await inspectRuntimeStorageRun(directory);
  if (
    !again ||
    again.runId !== state.runId ||
    JSON.stringify(again.storage) !== JSON.stringify(state.storage) ||
    JSON.stringify(again.legacyTarget) !== JSON.stringify(state.legacyTarget)
  )
    return false;
  // Prepared + exited exact producer is positive non-execution proof because
  // attempted was persisted before spawning. Other states need target exit.
  const old = await readRecord(path.join(directory, retirementName));
  await atomicRecord(directory, retirementName, {
    schemaVersion: 1,
    kind: 'electron-game-overlay-reshade-run-reclaimable',
    runId: state.runId,
    directoryName: path.basename(directory),
    retiredAt:
      typeof old?.retiredAt === 'string'
        ? old.retiredAt
        : new Date().toISOString(),
    privateImagesUnmapped: true,
  });
  return true;
}

/** @internal Compact only a run with persisted positive unmapping proof.
 * Unlink stage aliases; never chmod, relabel or rewrite shared image bytes. */
export async function compactRuntimeStorageRun(
  directory: string,
): Promise<void> {
  const state = await inspectRuntimeStorageRun(directory);
  if (!state?.unmapped) return;
  // Retire controls before the payload checkpoint. Consumers may stop Electron
  // as soon as all payload entries disappear; no asynchronous control cleanup
  // may remain after that observation. A denied/shared control keeps this run
  // incomplete and available for a later authorized sweep, without new proof.
  for (const name of RUNTIME_STORAGE_TRANSIENT_NAMES) {
    try {
      const file = path.join(directory, name),
        info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (name !== RUNTIME_PAYLOAD_LEASE_NAME &&
          name !== RUNTIME_PUBLISHING_LEASE_NAME &&
          info.nlink !== 1)
      )
        return;
      await unlink(file);
    } catch (error) {
      if (!code(error, 'ENOENT')) throw error;
    }
  }
  const privateHigh =
    (state.storage?.artifacts.length === 13 && !state.storage.payloadId) ||
    /-[a-f0-9]{32}$/u.test(path.basename(directory));
  const digests = new Map(state.storage?.artifacts ?? []);
  for (const bits of [64, 32]) {
    const stampName = `electron_game_overlay_runtime${bits === 64 ? '' : '32'}.build.json`,
      file = path.join(directory, stampName);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxRecordBytes)
        continue;
      const stamp: unknown = JSON.parse(
        (await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''),
      );
      if (
        !object(stamp) ||
        stamp.kind !== 'electron-game-overlay-runtime-build'
      )
        continue;
      for (const [name, architecture, key] of imageRules)
        if (architecture === bits && hash(stamp[key]) && !digests.has(name))
          digests.set(name, stamp[key]);
      const build = `ReShade${bits}.build.json`;
      if (hash(stamp.reshadeBuildStampSha256) && !digests.has(build))
        digests.set(build, stamp.reshadeBuildStampSha256);
    } catch {
      /* Partial legacy evidence does not authorize deleting unknown code. */
    }
  }
  let codeRemains = false;
  for (const [name] of imageRules) {
    const file = path.join(directory, name);
    try {
      const info = await lstat(file),
        expected = digests.get(name);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        ((name.startsWith('electron_game_overlay.addon') || privateHigh) &&
          info.nlink !== 1) ||
        (!expected && state.storage?.phase !== 'prepared') ||
        (expected && digest(await readFile(file)) !== expected)
      ) {
        codeRemains = true;
        continue;
      }
      await unlink(file);
    } catch (error) {
      if (!code(error, 'ENOENT')) codeRemains = true;
    }
  }
  if (!codeRemains) {
    for (const name of RUNTIME_PAYLOAD_NAMES.filter(
      (n) => !imageRules.some(([image]) => image === n),
    )) {
      const file = path.join(directory, name);
      try {
        const info = await lstat(file);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          (name === 'ReShade.ini'
            ? info.nlink !== 1
            : info.size > maxRecordBytes)
        )
          continue;
        const expected = digests.get(name);
        if (
          expected &&
          name !== 'ReShade.ini' &&
          digest(await readFile(file)) !== expected
        )
          continue;
        await unlink(file);
      } catch (error) {
        if (!code(error, 'ENOENT')) throw error;
      }
    }
    for (const name of await readdir(directory)) {
      const ownTemporary =
        name.startsWith(`.storage-${state.runId}-`) ||
        name.startsWith(`.retiring-${state.runId}-`);
      const legacyTemporary =
        /^\.(storage|retiring)-[a-f0-9-]{36}\.json$/u.test(name);
      if (!ownTemporary && !legacyTemporary) continue;
      const file = path.join(directory, name),
        info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > maxRecordBytes
      )
        continue;
      const record = ownTemporary ? undefined : await readRecord(file);
      if (
        ownTemporary ||
        (record?.runId === state.runId &&
          record.directoryName === path.basename(directory) &&
          [
            storageKind,
            'electron-game-overlay-reshade-run-reclaimable',
          ].includes(String(record.kind)))
      )
        await unlink(file);
    }
  }
  for (const name of diagnostics)
    await boundDiagnostic(
      path.join(directory, name),
      name.endsWith('startup.json') ? 256 : MAX_RETIRED_DIAGNOSTIC_BYTES,
    );
}

async function boundDiagnostic(file: string, limit: number): Promise<void> {
  let handle;
  try {
    const before = await lstat(file, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size <= BigInt(limit)
    )
      return;
    handle = await open(file, 'r+');
    const actual = await handle.stat({ bigint: true });
    if (
      !actual.isFile() ||
      actual.nlink !== 1n ||
      actual.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino
    )
      return;
    const bytes = Buffer.alloc(limit),
      read = await handle.read(
        bytes,
        0,
        limit,
        Math.max(0, Number(actual.size) - limit),
      );
    await handle.truncate(0);
    await handle.write(bytes.subarray(0, read.bytesRead), 0, read.bytesRead, 0);
  } catch (error) {
    if (
      !code(error, 'ENOENT') &&
      !code(error, 'EACCES') &&
      !code(error, 'EPERM')
    )
      throw error;
  } finally {
    await handle?.close();
  }
}

/** Only a compact SDK-owned diagnostic bundle is eligible for recursive age,
 * count or byte-budget pruning. Unknown entries always prevent whole-run GC. */
export async function runtimeStorageDiagnosticBytes(
  directory: string,
): Promise<number | undefined> {
  const allowed = [
    ...diagnostics,
    ownershipName,
    retirementName,
    RUNTIME_STORAGE_MARKER_NAME,
  ];
  let bytes = 0;
  for (const name of await readdir(directory)) {
    if (!allowed.includes(name)) return;
    const info = await lstat(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return;
    bytes += info.size;
  }
  return bytes;
}
