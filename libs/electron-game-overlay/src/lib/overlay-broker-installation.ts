import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { userInfo } from 'node:os';
import { createServer } from 'node:net';
import * as path from 'node:path';

/** @internal Standalone distribution contract shared with the packager. */
export interface OverlayBrokerManifest {
  schema: 1;
  version: string;
  protocolMin: number;
  protocolMax: number;
  platform: string;
  arch: string;
  executable: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

/**
 * Optional advance-discovery registration settings. Ordinary SDK startup does
 * not require registration. Prereleases require explicit opt-in.
 * @example
 * ```ts
 * import type { OverlayBrokerInstallationOptions } from 'electron-game-overlay/broker';
 * const options: OverlayBrokerInstallationOptions = { allowPrerelease: true };
 * ```
 */
export interface OverlayBrokerInstallationOptions {
  /** Absolute directory containing the standalone broker manifest and payloads. Defaults to this SDK's bundled distribution. */
  distributionPath?: string;
  /** Permit prerelease broker versions. Stable releases are the default. */
  allowPrerelease?: boolean;
  /** @internal Isolated filesystem fixture root. */
  storageRoot?: string;
}

/** @internal Validated independent cached distribution. */
export interface OverlayBrokerInstallation {
  id: string;
  directory: string;
  executablePath: string;
  manifest: OverlayBrokerManifest;
}

/** @internal Uses account-token home, not environment-derived home paths. */
export function overlayBrokerStorageRoot(): string {
  return path.join(
    userInfo({ encoding: 'utf8' }).homedir,
    '.electron-game-overlay',
    'broker-v1',
  );
}

/** @internal Physical packaged broker location; executable assets inside app.asar must be asarUnpacked. */
export function bundledOverlayBrokerDistributionPath(): string {
  return path
    .resolve(__dirname, '..', 'broker', `${process.platform}-${process.arch}`)
    .replace(/([\\/])([^\\/]+\.asar)(?=[\\/])/i, '$1$2.unpacked');
}

/**
 * Copies this SDK's standalone broker into the per-user immutable cache and
 * opts it into advance discovery. Does not start an app or broker. The returned
 * registration identity belongs to the canonical source directory, so repeated
 * registration there is idempotent. Other apps retain independent registrations
 * even when identical payloads share one cached content identity.
 * @param options - Bundled-distribution override and explicit prerelease opt-in.
 * @returns A 64-character lowercase SHA-256 registration identity of the canonical
 * source directory, not the shared cached content identity.
 * @example
 * ```ts
 * import { registerOverlayBrokerInstallation } from 'electron-game-overlay/broker';
 * const registrationId = await registerOverlayBrokerInstallation();
 * // Preview channels must explicitly use { allowPrerelease: true }.
 * ```
 */
export async function registerOverlayBrokerInstallation(
  options: OverlayBrokerInstallationOptions = {},
): Promise<string> {
  const root = options.storageRoot ?? overlayBrokerStorageRoot();
  const source =
    options.distributionPath ?? bundledOverlayBrokerDistributionPath();
  const candidate = await cacheDistribution(source, root);
  if (
    !options.allowPrerelease &&
    parseVersion(candidate.manifest.version)!.prerelease.length
  )
    throw new Error('Prerelease registration requires allowPrerelease: true');
  const canonical = await fs.realpath(source);
  const registrationId = createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex');
  const release = await acquireOverlayBrokerLock(
    `catalog:${path.resolve(root)}`,
    Date.now() + 15_000,
  );
  try {
    const catalog = await readCatalogForMutation(root);
    const entries = catalog.entries.filter(
      (entry) => (entry.registrationId ?? entry.id) !== registrationId,
    );
    entries.push({
      id: candidate.id,
      registrationId,
      rankingVersion: candidate.manifest.version,
    });
    await writeCatalog(root, { ...catalog, entries });
  } finally {
    await release();
  }
  return registrationId;
}

/**
 * Removes an optional advance-discovery registration. Cached files are retained
 * so existing brokers and their dependencies survive application uninstall.
 * Never stops a broker or removes durable target ownership claims.
 * @param registrationId - Identity returned for this source directory; other
 * directories' registrations are preserved even when their content is identical.
 * @param options - Per-user storage settings; normally omitted.
 * @returns A promise fulfilled after the catalog update is atomically published.
 * @example
 * ```ts
 * import { registerOverlayBrokerInstallation, unregisterOverlayBrokerInstallation } from 'electron-game-overlay/broker';
 * const id = await registerOverlayBrokerInstallation();
 * await unregisterOverlayBrokerInstallation(id);
 * ```
 */
export async function unregisterOverlayBrokerInstallation(
  registrationId: string,
  options: OverlayBrokerInstallationOptions = {},
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(registrationId))
    throw new TypeError('Invalid broker registration identity');
  const root = options.storageRoot ?? overlayBrokerStorageRoot();
  const release = await acquireOverlayBrokerLock(
    `catalog:${path.resolve(root)}`,
    Date.now() + 15_000,
  );
  try {
    const catalog = await readCatalogForMutation(root);
    catalog.entries = catalog.entries.filter(
      (entry) => (entry.registrationId ?? entry.id) !== registrationId,
    );
    await writeCatalog(root, catalog);
  } finally {
    await release();
  }
}

/** @internal Collect validated installations for diagnostics; startup uses the lazy iterator. */
export async function discoverOverlayBrokerInstallations(
  options: OverlayBrokerInstallationOptions = {},
): Promise<OverlayBrokerInstallation[]> {
  const candidates: OverlayBrokerInstallation[] = [];
  for await (const candidate of iterateOverlayBrokerInstallations(options))
    candidates.push(candidate);
  return candidates;
}

/** @internal Order eligible metadata first; hash/copy only the candidate needed next. */
export async function* iterateOverlayBrokerInstallations(
  options: OverlayBrokerInstallationOptions = {},
  deadline = Infinity,
): AsyncGenerator<OverlayBrokerInstallation> {
  const root = options.storageRoot ?? overlayBrokerStorageRoot();
  const source =
    options.distributionPath ?? bundledOverlayBrokerDistributionPath();
  const candidates = new Map<
    string,
    { id: string; version: string; installation?: OverlayBrokerInstallation }
  >();
  const optionalDeadline = Number.isFinite(deadline)
    ? Date.now() + Math.min(1000, (deadline - Date.now()) / 2)
    : Infinity;
  try {
    const manifest = await beforeDeadline(deadline, () =>
      readManifest(source, deadline),
    );
    const id = createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex');
    candidates.set('own', {
      id,
      version: manifest.version,
      installation: {
        id,
        directory: source,
        executablePath: path.join(source, manifest.executable),
        manifest,
      },
    });
  } catch {
    /* An independently registered distribution may still be usable. */
  }
  const metadataDeadline = Number.isFinite(deadline)
    ? Math.min(
        deadline,
        Date.now() + Math.min(250, (deadline - Date.now()) / 4),
      )
    : Infinity;
  try {
    await beforeDeadline(metadataDeadline, async () => {
      // Rank every admitted content identity, not a prefix of registration owners.
      // Hints come from registration-time validation but remain untrusted: resolve
      // the actual cached manifest and hash its payload before yielding anything.
      const entries = new Map<string, CatalogEntry>();
      for (const entry of await readCatalog(root, metadataDeadline)) {
        if (!entries.has(entry.id) || entry.rankingVersion)
          entries.set(entry.id, entry);
      }
      const legacy: string[] = [];
      for (const entry of entries.values()) {
        if (entry.rankingVersion)
          candidates.set(entry.id, {
            id: entry.id,
            version: entry.rankingVersion,
          });
        else legacy.push(entry.id);
      }
      // Legacy catalogs have no hints. Bound concurrent metadata I/O rather than
      // serially spending the whole optional window on its first few entries.
      const pending = legacy.values();
      await Promise.all(
        Array.from({ length: Math.min(16, legacy.length) }, async () => {
          for (const id of pending) {
            checkDeadline(metadataDeadline);
            const installation = await findCachedDistribution(
              root,
              id,
              true,
              metadataDeadline,
            );
            checkDeadline(metadataDeadline);
            if (installation)
              candidates.set(id, {
                id,
                version: installation.manifest.version,
                installation,
              });
          }
        }),
      );
    });
  } catch {
    /* Optional discovery must leave ordinary own startup time. */
  }
  const ordered = [...candidates.values()]
    .filter(
      (candidate) =>
        options.allowPrerelease ||
        !parseVersion(candidate.version)!.prerelease.length,
    )
    .sort(
      (a, b) =>
        compareVersions(b.version, a.version) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
        Number(a.installation?.directory === source) -
          Number(b.installation?.directory === source),
    );
  const validated = new Set<string>();
  for (const ranked of ordered) {
    if (validated.has(ranked.id)) continue;
    try {
      const candidate =
        ranked.installation ??
        (await beforeDeadline(optionalDeadline, () =>
          findCachedDistribution(root, ranked.id, true, optionalDeadline),
        ));
      if (!candidate || candidate.manifest.version !== ranked.version) continue;
      if (candidate.directory === source) {
        const cached = await beforeDeadline(deadline, () =>
          cacheDistribution(source, root, deadline),
        );
        validated.add(cached.id);
        yield cached;
      } else {
        const manifest = await beforeDeadline(optionalDeadline, () =>
          validateDistribution(candidate.directory, optionalDeadline),
        );
        if (JSON.stringify(manifest) !== JSON.stringify(candidate.manifest))
          continue;
        validated.add(candidate.id);
        yield candidate;
      }
    } catch {
      /* Optional damaged payloads do not suppress a later usable candidate. */
    }
  }
}

// Schema 1 keeps `id` as the content identity for older readers. The additive
// owner identity separates unregistration from cache deduplication; legacy
// entries without it retain their original content-ID unregistration handle.
interface CatalogEntry {
  id: string;
  registrationId: string;
  rankingVersion?: string;
}

async function readCatalog(
  root: string,
  deadline = Infinity,
): Promise<CatalogEntry[]> {
  try {
    const value = await readBoundedJson(
      path.join(root, 'catalog.json'),
      deadline,
    );
    if (
      !record(value) ||
      value.schema !== 1 ||
      !Array.isArray(value.entries) ||
      value.entries.length > MAX_FILES
    )
      return [];
    const entries = new Map<string, CatalogEntry>();
    for (const entry of value.entries) {
      if (
        !record(entry) ||
        typeof entry.id !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.id)
      )
        continue;
      const registrationId = entry.registrationId ?? entry.id;
      if (
        typeof registrationId !== 'string' ||
        !/^[0-9a-f]{64}$/.test(registrationId)
      )
        continue;
      entries.set(registrationId, {
        id: entry.id,
        registrationId,
        ...(parseVersion(entry.rankingVersion)
          ? { rankingVersion: entry.rankingVersion as string }
          : {}),
      });
    }
    return [...entries.values()];
  } catch {
    return [];
  }
}

interface CatalogDocument extends Record<string, unknown> {
  schema: 1;
  entries: Array<
    Record<string, unknown> & { id: string; registrationId?: string }
  >;
}

async function readCatalogForMutation(root: string): Promise<CatalogDocument> {
  const filename = path.join(root, 'catalog.json');
  try {
    await fs.lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schema: 1, entries: [] };
    throw error;
  }
  const value = await readBoundedJson(filename);
  if (
    !record(value) ||
    value.schema !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_FILES
  )
    throw new Error('Unsupported or malformed broker catalog');
  if (
    value.entries.some(
      (entry) =>
        !record(entry) ||
        typeof entry.id !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.id) ||
        (entry.registrationId !== undefined &&
          (typeof entry.registrationId !== 'string' ||
            !/^[0-9a-f]{64}$/.test(entry.registrationId))),
    )
  )
    throw new Error('Malformed broker catalog entry');
  return value as CatalogDocument;
}

async function writeCatalog(
  root: string,
  catalog: CatalogDocument,
): Promise<void> {
  if (catalog.entries.length > MAX_FILES)
    throw new Error('Broker catalog entry limit reached');
  const text = JSON.stringify(catalog);
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES)
    throw new Error('Broker catalog exceeds metadata size limit');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectoryChain(root);
  const temporary = path.join(root, `.catalog-${randomUUID()}.json`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path.join(root, 'catalog.json'));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)!;
  const right = parseVersion(b)!;
  for (let index = 0; index < 3; index++) {
    const x = BigInt(left.core[index]);
    const y = BigInt(right.core[index]);
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length)
    return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index++
  ) {
    const x = left.prerelease[index];
    const y = right.prerelease[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^[0-9]+$/.test(x);
    const yn = /^[0-9]+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

async function findCachedDistribution(
  root: string,
  id: string,
  metadataOnly = false,
  deadline = Infinity,
): Promise<OverlayBrokerInstallation | undefined> {
  const group = path.join(root, 'cache', id);
  try {
    await assertDirectoryChain(group, deadline);
    const copies: string[] = [];
    let visited = 0;
    for await (const entry of await fs.opendir(group)) {
      checkDeadline(deadline);
      visited++;
      if (entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name))
        copies.push(entry.name);
      if (visited >= 64) break;
    }
    for (const copy of copies.sort()) {
      checkDeadline(deadline);
      try {
        const directory = path.join(group, copy);
        const manifest = await (metadataOnly
          ? readManifest(directory, deadline)
          : validateDistribution(directory, deadline));
        if (
          createHash('sha256')
            .update(JSON.stringify(manifest))
            .digest('hex') === id
        ) {
          return {
            id,
            directory,
            executablePath: path.join(directory, manifest.executable),
            manifest,
          };
        }
      } catch {
        /* Retain damaged copies; an active process may still need them. */
      }
    }
  } catch {
    /* Missing optional cache group. */
  }
  return undefined;
}

async function cacheDistribution(
  source: string,
  root: string,
  deadline = Infinity,
): Promise<OverlayBrokerInstallation> {
  const manifest = await validateDistribution(source, deadline);
  const text = JSON.stringify(manifest);
  const id = createHash('sha256').update(text).digest('hex');
  const existing = await findCachedDistribution(root, id, false, deadline);
  if (existing) return existing;
  const group = path.join(root, 'cache', id);
  await fs.mkdir(group, { recursive: true, mode: 0o700 });
  await assertDirectoryChain(group, deadline);
  const directory = path.join(group, randomUUID());
  const staging = path.join(root, 'cache', `.staging-${randomUUID()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const file of manifest.files) {
      checkDeadline(deadline);
      const destination = path.join(staging, file.path);
      await fs.mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      await fs.copyFile(
        path.join(source, file.path),
        destination,
        fs.constants.COPYFILE_EXCL,
      );
      await fs.chmod(
        destination,
        file.path === manifest.executable ? 0o500 : 0o400,
      );
    }
    await fs.writeFile(path.join(staging, 'broker-manifest.json'), text, {
      mode: 0o400,
      flag: 'wx',
    });
    await validateDistribution(staging, deadline);
    // Publish a new independent copy, never repair or rename a possibly active
    // copy: native artifacts and lazy JS dependencies retain their exact paths.
    checkDeadline(deadline);
    await fs.rename(staging, directory);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  const cached = await validateDistribution(directory, deadline);
  if (JSON.stringify(cached) !== text)
    throw new Error('Cached broker identity changed');
  return {
    id,
    directory,
    executablePath: path.join(directory, manifest.executable),
    manifest,
  };
}

/** @internal OS-owned mutex; Windows named pipes and Linux abstract test sockets leave no stale lock files. */
export async function acquireOverlayBrokerLock(
  key: string,
  deadline: number,
): Promise<() => Promise<void>> {
  const normalized =
    process.platform === 'win32' ? key.normalize('NFKC').toLowerCase() : key;
  const identity = createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 40);
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ego-bootstrap-v1-${identity}`
      : `\0ego-bootstrap-v1-${identity}`;
  if (process.platform !== 'win32' && process.platform !== 'linux')
    throw new Error(
      'Overlay broker bootstrap requires Windows (Linux sockets are test-only)',
    );
  for (;;) {
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ path: endpoint, exclusive: true }, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      server.on('error', () => undefined);
      server.unref();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      };
    } catch (error) {
      server.close();
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for overlay broker arbitration');
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))),
      );
    }
  }
}

function checkDeadline(deadline: number): void {
  if (Date.now() >= deadline)
    throw new Error('Overlay broker discovery deadline exceeded');
}

async function beforeDeadline<T>(
  deadline: number,
  work: () => Promise<T>,
): Promise<T> {
  checkDeadline(deadline);
  if (!Number.isFinite(deadline)) return work();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Overlay broker discovery deadline exceeded')),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_FILES = 4096;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MANIFEST_NAME = 'broker-manifest.json';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function portablePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    value.split('/').length <= 32 &&
    value
      .split('/')
      .every(
        (segment) =>
          /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) &&
          !segment.endsWith('.') &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment),
      )
  );
}

function parseVersion(
  value: unknown,
): { core: string[]; prerelease: string[] } | undefined {
  if (typeof value !== 'string' || value.length > 128) return;
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) return;
  const prerelease = match[4]?.split('.') ?? [];
  if (
    prerelease.some(
      (part) =>
        /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith('0'),
    )
  )
    return;
  return { core: match.slice(1, 4), prerelease };
}

async function assertDirectoryChain(
  directory: string,
  deadline = Infinity,
): Promise<void> {
  checkDeadline(deadline);
  if (!path.isAbsolute(directory))
    throw new Error('Broker directory must be absolute');
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    checkDeadline(deadline);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Broker directory must not contain symlinks');
  }
}

/** @internal Bounded regular-file metadata reader. */
export async function readBoundedJson(
  filename: string,
  deadline = Infinity,
): Promise<unknown> {
  await assertDirectoryChain(path.dirname(filename), deadline);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA_BYTES)
    throw new Error('Invalid broker metadata file');
  const handle = await fs.open(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_METADATA_BYTES)
      throw new Error('Invalid broker metadata size');
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      checkDeadline(deadline);
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_METADATA_BYTES)
      throw new Error('Broker metadata exceeds limit');
    checkDeadline(deadline);
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally {
    await handle.close();
  }
}

async function hashRegularFile(
  filename: string,
  expectedSize: number,
  deadline = Infinity,
): Promise<string> {
  checkDeadline(deadline);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize)
    throw new Error('Invalid broker payload file');
  const handle = await fs.open(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== expectedSize)
      throw new Error('Broker payload size changed');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      checkDeadline(deadline);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > expectedSize) throw new Error('Broker payload grew');
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (size !== expectedSize) throw new Error('Broker payload changed');
    checkDeadline(deadline);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function readManifest(
  directory: string,
  deadline = Infinity,
): Promise<OverlayBrokerManifest> {
  const value = await readBoundedJson(
    path.join(directory, MANIFEST_NAME),
    deadline,
  );
  const executable =
    process.platform === 'win32'
      ? 'electron-game-overlay-broker.exe'
      : 'electron-game-overlay-broker';
  if (
    !record(value) ||
    value.schema !== 1 ||
    !parseVersion(value.version) ||
    value.platform !== process.platform ||
    value.arch !== process.arch ||
    value.executable !== executable ||
    !Number.isSafeInteger(value.protocolMin) ||
    !Number.isSafeInteger(value.protocolMax) ||
    (value.protocolMin as number) < 1 ||
    (value.protocolMin as number) > 1 ||
    (value.protocolMax as number) < 1 ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > MAX_FILES
  )
    throw new Error('Invalid broker manifest');
  const files: OverlayBrokerManifest['files'] = [];
  const names = new Set<string>();
  let total = 0;
  for (const file of value.files) {
    if (
      !record(file) ||
      !portablePath(file.path) ||
      file.path.toLowerCase() === MANIFEST_NAME ||
      names.has(file.path.toLowerCase()) ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      throw new Error('Invalid broker payload declaration');
    total += file.size as number;
    if (total > MAX_PAYLOAD_BYTES)
      throw new Error('Broker payload exceeds limit');
    names.add(file.path.toLowerCase());
    files.push({
      path: file.path,
      size: file.size as number,
      sha256: file.sha256,
    });
  }
  if (!files.some((file) => file.path === executable))
    throw new Error('Broker executable is not declared');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    schema: 1,
    version: value.version as string,
    protocolMin: value.protocolMin as number,
    protocolMax: value.protocolMax as number,
    platform: value.platform as string,
    arch: value.arch as string,
    executable,
    files,
  };
}

async function validateDistribution(
  directory: string,
  deadline = Infinity,
): Promise<OverlayBrokerManifest> {
  const manifest = await readManifest(directory, deadline);
  const { files, executable } = manifest;
  let visited = 0;
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 32) throw new Error('Broker payload nesting exceeds limit');
    for await (const entry of await fs.opendir(
      path.join(directory, relative),
    )) {
      checkDeadline(deadline);
      if (++visited > MAX_FILES * 2)
        throw new Error('Broker directory exceeds limit');
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (!portablePath(child)) throw new Error('Invalid broker payload path');
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (
        !entry.isFile() ||
        (child !== MANIFEST_NAME && !files.some((file) => file.path === child))
      )
        throw new Error('Undeclared or unsafe broker payload');
    }
  }
  await walk('', 0);
  for (const file of files) {
    await assertDirectoryChain(
      path.dirname(path.join(directory, file.path)),
      deadline,
    );
    if (
      (await hashRegularFile(
        path.join(directory, file.path),
        file.size,
        deadline,
      )) !== file.sha256
    )
      throw new Error('Broker payload hash mismatch');
  }
  if (process.platform !== 'win32')
    await fs.access(path.join(directory, executable), fs.constants.X_OK);
  return manifest;
}
