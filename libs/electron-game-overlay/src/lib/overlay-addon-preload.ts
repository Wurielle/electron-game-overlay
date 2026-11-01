import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import * as path from 'node:path';
import { validateOverlayDistributionSync } from './overlay-package-manifest.js';

/** Selects an application's optional installed add-on registration. */
export interface OverlayAddonPreloadOptions {
  /** Stable application identity, shared by its installer and runtime. */
  applicationId: string;
  /** Absolute registry directory. Normally omitted to use the current account. */
  storageRoot?: string;
}

/** Installer settings. Registration does not start an application or ReShade. */
export interface OverlayAddonInstallationOptions extends OverlayAddonPreloadOptions {
  /** Installed SDK package root. Defaults to this SDK. Use createOverlayAfterPack() to restore the complete sealed SDK beside ASAR. */
  packageRoot?: string;
}

/** Removes one installed build, or all builds belonging to this application. */
export interface OverlayAddonUninstallationOptions extends OverlayAddonPreloadOptions {
  registrationId?: string;
}

/** Immutable installed native payload identity. Existing games retain their snapshots. */
export interface OverlayAddonInstallation {
  readonly applicationId: string;
  readonly registrationId: string;
  readonly addonBuildId: string;
  readonly addonPath: string;
  readonly x86AddonPath: string;
}

interface Payload {
  fileName: string;
  size: number;
  sha256: string;
}
interface Registration {
  addonPreloadProtocol: 1;
  applicationId: string;
  registrationId: string;
  addonBuildId: string;
  cacheDirectory: string;
  addon: Payload;
  x86Addon: Payload;
}
interface Registry {
  schemaVersion: 1;
  kind: 'electron-game-overlay-addon-preload-registry';
  registrations: Registration[];
}

/** @internal The source runtime has already passed its native package validation. */
export interface OverlayAddonPreloadCurrentRuntime {
  addonBuildId: string;
  addonPath: string;
  x86AddonPath: string;
}

/** Frozen, validated inventory for one future owned host. */
export interface OverlayAddonPreloadSelection {
  readonly applicationId: string;
  readonly registrationId: string;
  readonly addonBuildId: string;
  readonly addonFileName: string;
  readonly x86AddonFileName: string;
  readonly payloads: readonly Readonly<Payload & { sourcePath: string }>[];
}

/** @internal Paths selected from a newly published host snapshot. */
export interface OverlayAddonPreloadSnapshot {
  readonly directory: string;
  readonly addonPath: string;
  readonly x86AddonPath: string;
}

const REGISTRY_NAME = 'registrations.json';
const REGISTRY_KIND = 'electron-game-overlay-addon-preload-registry' as const;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ADDON_BYTES = 512 * 1024 * 1024;
const MAX_REGISTRATIONS = 4096;
const DIGEST = /^[0-9a-f]{64}$/;
const BUILD_ID = /^[0-9A-F]{32}$/;
const CACHE_LEAF = /^[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APPLICATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const NATIVE_DIRECTORY = 'runtime/win32-x64/reshade';

/** Account-token home is authoritative; Electron environment variables are not used. */
export function defaultOverlayAddonStorageRoot(): string {
  return path.join(userInfo({ encoding: 'utf8' }).homedir, '.electron-game-overlay', 'addon-preload-v1');
}

/**
 * Registers both architectures from a directly sealed SDK in the per-user
 * immutable cache. Repeating the same application/build is idempotent. Different
 * builds coexist; unregister an obsolete build after installing its replacement.
 * @example
 * ```ts
 * import { registerOverlayAddonInstallation } from 'electron-game-overlay/preload';
 * const installation = await registerOverlayAddonInstallation({ applicationId: 'com.example.app' });
 * ```
 */
export async function registerOverlayAddonInstallation(
  options: OverlayAddonInstallationOptions,
): Promise<OverlayAddonInstallation> {
  validateApplicationId(options.applicationId);
  const source = fs.realpathSync(options.packageRoot ?? bundledPackageRoot());
  assertDirectoryChain(source);
  const metadata = parseObject(readRegular(path.join(source, 'package.json'), MAX_JSON_BYTES));
  if (metadata.name !== 'electron-game-overlay' || typeof metadata.version !== 'string')
    throw new Error('Expected an electron-game-overlay package');
  const dist = path.join(source, 'dist');
  assertDirectoryChain(dist);
  const manifest = validateOverlayDistributionSync(dist, metadata.version);
  const sealedStamp = (bits: 64 | 32): Record<string, unknown> => {
    const relative = `${NATIVE_DIRECTORY}/electron_game_overlay_runtime${bits === 64 ? '' : '32'}.build.json`;
    const entry = manifest.files.find(item => item.path === relative);
    if (!entry) throw new Error('Sealed native build stamp is missing');
    return parseObject(verifyPayload(path.join(dist, relative), entry));
  };
  const stamp = sealedStamp(64), x86Stamp = sealedStamp(32);
  const addonBuildId = stamp.addonBuildId;
  if (typeof addonBuildId !== 'string' || !BUILD_ID.test(addonBuildId))
    throw new Error('Invalid sealed native add-on build identity');
  if (stamp.addonPreloadProtocol !== 1 || x86Stamp.addonPreloadProtocol !== 1 || x86Stamp.addonBuildId !== addonBuildId)
    throw new Error('Both sealed native architectures must support add-on preload protocol 1');
  const payload = (bits: 64 | 32): Payload & { sourcePath: string } => {
    const relative = `${NATIVE_DIRECTORY}/electron_game_overlay.addon${bits}`;
    const declared = manifest.files.find(entry => entry.path === relative);
    if (!declared) throw new Error('Sealed native add-on is missing');
    const declaredHash = (bits === 64 ? stamp : x86Stamp).addonSha256;
    if (typeof declaredHash !== 'string' || declaredHash.toLowerCase() !== declared.sha256)
      throw new Error('Sealed native add-on preload hash mismatch');
    const sourcePath = path.join(dist, relative);
    verifyPayload(sourcePath, declared);
    return { fileName: addonFileName(options.applicationId, addonBuildId, declared.sha256, bits),
      sha256: declared.sha256, size: declared.size, sourcePath };
  };
  const addon = payload(64), x86Addon = payload(32);
  const registrationId = registrationIdentity(options.applicationId, addonBuildId, addon.sha256, x86Addon.sha256);
  const root = await prepareStorageRoot(options.storageRoot);
  const release = await acquireRegistryLock(root);
  try {
    const registry = readRegistry(root);
    const existing = registry.registrations.find(entry => entry.registrationId === registrationId);
    if (existing) {
      verifyRegistration(root, existing);
      return installation(root, existing);
    }
    if (registry.registrations.length >= MAX_REGISTRATIONS) throw new Error('Add-on registration limit exceeded');
    const cache = path.join(root, 'payloads');
    await fsp.mkdir(cache, { recursive: true });
    assertDirectoryChain(cache);
    const cacheDirectory = `${registrationId}-${randomUUID()}`;
    const temporary = await fsp.mkdtemp(path.join(cache, '.pending-'));
    const published = path.join(cache, cacheDirectory);
    let renamed = false;
    try {
      await copyPayload(addon.sourcePath, path.join(temporary, addon.fileName), addon);
      await copyPayload(x86Addon.sourcePath, path.join(temporary, x86Addon.fileName), x86Addon);
      await fsp.rename(temporary, published);
      renamed = true;
      const entry: Registration = { addonPreloadProtocol: 1, applicationId: options.applicationId, registrationId, addonBuildId, cacheDirectory,
        addon: payloadMetadata(addon), x86Addon: payloadMetadata(x86Addon) };
      verifyRegistration(root, entry);
      registry.registrations.push(entry);
      registry.registrations.sort((a, b) => a.registrationId.localeCompare(b.registrationId));
      await writeRegistry(root, registry);
      return installation(root, entry);
    } finally {
      // Published immutable payloads are retained even if metadata publication fails.
      if (!renamed) await removeUnpublishedDirectory(temporary, cache);
    }
  } finally { await release(); }
}

/**
 * Removes this application's registration from future host snapshots. Native
 * payload caches and already running games remain intact. Other apps are untouched.
 */
export async function unregisterOverlayAddonInstallation(
  options: OverlayAddonUninstallationOptions,
): Promise<void> {
  validateApplicationId(options.applicationId);
  if (options.registrationId !== undefined && !DIGEST.test(options.registrationId))
    throw new TypeError('Invalid add-on registration identity');
  const root = await prepareStorageRoot(options.storageRoot);
  const release = await acquireRegistryLock(root);
  try {
    const registry = readRegistry(root);
    registry.registrations = registry.registrations.filter(entry =>
      entry.applicationId !== options.applicationId ||
      (options.registrationId !== undefined && entry.registrationId !== options.registrationId));
    await writeRegistry(root, registry);
  } finally { await release(); }
}

/** @internal Resolves a complete atomic catalog snapshot without executing registered code. */
export function resolveAddonPreloadSelection(
  options: OverlayAddonPreloadOptions,
  current: OverlayAddonPreloadCurrentRuntime,
): OverlayAddonPreloadSelection {
  validateApplicationId(options.applicationId);
  if (!BUILD_ID.test(current.addonBuildId)) throw new TypeError('Invalid current native add-on build identity');
  const root = storageRoot(options.storageRoot);
  assertDirectoryChain(root);
  const registry = readRegistry(root);
  assertDirectoryChain(path.dirname(current.addonPath));
  assertDirectoryChain(path.dirname(current.x86AddonPath));
  const addonHash = digest(readRegular(current.addonPath));
  const x86Hash = digest(readRegular(current.x86AddonPath));
  const registrationId = registrationIdentity(options.applicationId, current.addonBuildId, addonHash, x86Hash);
  const selected = registry.registrations.find(entry => entry.registrationId === registrationId);
  if (!selected) throw new Error('This application/native build is not registered for add-on preloading');
  const payloads = new Map<string, Readonly<Payload & { sourcePath: string }>>();
  for (const entry of registry.registrations) {
    verifyRegistration(root, entry);
    for (const payload of [entry.addon, entry.x86Addon]) {
      const previous = payloads.get(payload.fileName);
      if (previous && (previous.sha256 !== payload.sha256 || previous.size !== payload.size))
        throw new Error('Registered add-on filenames collide');
      payloads.set(payload.fileName, Object.freeze({ ...payload,
        sourcePath: path.join(root, 'payloads', entry.cacheDirectory, payload.fileName) }));
    }
  }
  return Object.freeze({ applicationId: options.applicationId, registrationId, addonBuildId: selected.addonBuildId,
    addonFileName: selected.addon.fileName, x86AddonFileName: selected.x86Addon.fileName,
    payloads: Object.freeze([...payloads.values()].sort((a, b) => a.fileName.localeCompare(b.fileName))) });
}

/** @internal Publishes a new flat, immutable AddonPath directory for an owned host. */
export async function createOverlayAddonPreloadSnapshot(
  destination: string,
  selection: OverlayAddonPreloadSelection,
): Promise<OverlayAddonPreloadSnapshot> {
  if (!path.isAbsolute(destination)) throw new TypeError('Add-on snapshot directory must be absolute');
  const parent = path.dirname(destination);
  assertDirectoryChain(parent);
  try { await fsp.lstat(destination); throw new Error('Add-on snapshot destination already exists'); }
  catch (error) { if (!isMissing(error)) throw error; }
  const temporary = await fsp.mkdtemp(path.join(parent, '.ego-preload-'));
  let published = false;
  try {
    const names = new Set<string>();
    for (const payload of selection.payloads) {
      if (!/^ego-preload-[0-9a-f]{32}-[0-9A-F]{32}-[0-9a-f]{16}\.addon(?:64|32)$/.test(payload.fileName) ||
          names.has(payload.fileName.toLowerCase())) throw new Error('Invalid add-on snapshot inventory');
      names.add(payload.fileName.toLowerCase());
      await copyPayload(payload.sourcePath, path.join(temporary, payload.fileName), payload);
    }
    if (!names.has(selection.addonFileName.toLowerCase()) || !names.has(selection.x86AddonFileName.toLowerCase()))
      throw new Error('Selected application add-ons are missing from the snapshot');
    assertDirectoryChain(parent);
    await fsp.rename(temporary, destination);
    published = true;
    return Object.freeze({ directory: destination, addonPath: path.join(destination, selection.addonFileName),
      x86AddonPath: path.join(destination, selection.x86AddonFileName) });
  } finally { if (!published) await removeUnpublishedDirectory(temporary, parent); }
}

function bundledPackageRoot(): string {
  return path.resolve(__dirname, '..', '..').replace(/([\\/])([^\\/]+\.asar)(?=[\\/]|$)/i, '$1$2.unpacked');
}
function storageRoot(value?: string): string {
  const root = value ?? defaultOverlayAddonStorageRoot();
  if (!path.isAbsolute(root)) throw new TypeError('Add-on storage root must be absolute');
  return path.resolve(root);
}
async function prepareStorageRoot(value?: string): Promise<string> {
  const root = storageRoot(value);
  assertDirectoryChain(root, true);
  await fsp.mkdir(root, { recursive: true });
  assertDirectoryChain(root);
  return fs.realpathSync(root);
}
function validateApplicationId(value: string): void {
  if (typeof value !== 'string' || !APPLICATION_ID.test(value))
    throw new TypeError('applicationId must be 1-200 ASCII letters, digits, dots, underscores, colons or hyphens');
}
function digest(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
function registrationIdentity(applicationId: string, addonBuildId: string, addonHash: string, x86Hash: string): string {
  return digest(JSON.stringify([applicationId, addonBuildId, addonHash, x86Hash]));
}
function addonFileName(applicationId: string, buildId: string, hash: string, bits: 64 | 32): string {
  return `ego-preload-${digest(applicationId).slice(0, 32)}-${buildId}-${hash.slice(0, 16)}.addon${bits}`;
}
function payloadMetadata(payload: Payload): Payload {
  return { fileName: payload.fileName, size: payload.size, sha256: payload.sha256 };
}
function installation(root: string, entry: Registration): OverlayAddonInstallation {
  return Object.freeze({ applicationId: entry.applicationId, registrationId: entry.registrationId, addonBuildId: entry.addonBuildId,
    addonPath: path.join(root, 'payloads', entry.cacheDirectory, entry.addon.fileName),
    x86AddonPath: path.join(root, 'payloads', entry.cacheDirectory, entry.x86Addon.fileName) });
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function parseObject(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid add-on registration JSON'); }
  if (!object(value)) throw new Error('Add-on registration JSON must be an object');
  return value;
}
function readRegistry(root: string): Registry {
  assertDirectoryChain(root);
  let bytes: Buffer;
  try { bytes = readRegular(path.join(root, REGISTRY_NAME), MAX_JSON_BYTES); }
  catch (error) { if (isMissing(error)) return { schemaVersion: 1, kind: REGISTRY_KIND, registrations: [] }; throw error; }
  const value = parseObject(bytes);
  if (!exactKeys(value, ['schemaVersion', 'kind', 'registrations']) || value.schemaVersion !== 1 || value.kind !== REGISTRY_KIND ||
      !Array.isArray(value.registrations) || value.registrations.length > MAX_REGISTRATIONS)
    throw new Error('Invalid add-on registration registry');
  const ids = new Set<string>();
  for (const entry of value.registrations) {
    if (!object(entry) || !exactKeys(entry, ['addonPreloadProtocol', 'applicationId', 'registrationId', 'addonBuildId', 'cacheDirectory', 'addon', 'x86Addon']) ||
        entry.addonPreloadProtocol !== 1 ||
        typeof entry.applicationId !== 'string' || !APPLICATION_ID.test(entry.applicationId) ||
        typeof entry.registrationId !== 'string' || !DIGEST.test(entry.registrationId) || ids.has(entry.registrationId) ||
        typeof entry.addonBuildId !== 'string' || !BUILD_ID.test(entry.addonBuildId) ||
        typeof entry.cacheDirectory !== 'string' || !CACHE_LEAF.test(entry.cacheDirectory) ||
        !entry.cacheDirectory.startsWith(entry.registrationId + '-')) throw new Error('Invalid add-on registration entry');
    for (const [key, bits] of [['addon', 64], ['x86Addon', 32]] as const) {
      const payload = entry[key];
      if (!object(payload) || !exactKeys(payload, ['fileName', 'size', 'sha256']) ||
          typeof payload.sha256 !== 'string' || !DIGEST.test(payload.sha256) ||
          !Number.isSafeInteger(payload.size) || (payload.size as number) <= 0 || (payload.size as number) > MAX_ADDON_BYTES ||
          payload.fileName !== addonFileName(entry.applicationId, entry.addonBuildId, payload.sha256, bits))
        throw new Error('Invalid registered add-on payload');
    }
    const addon = entry.addon as unknown as Payload, x86Addon = entry.x86Addon as unknown as Payload;
    if (registrationIdentity(entry.applicationId, entry.addonBuildId, addon.sha256, x86Addon.sha256) !== entry.registrationId)
      throw new Error('Add-on registration identity mismatch');
    ids.add(entry.registrationId);
  }
  return value as unknown as Registry;
}
function verifyRegistration(root: string, entry: Registration): void {
  const directory = path.join(root, 'payloads', entry.cacheDirectory);
  assertDirectoryChain(directory);
  const names = fs.readdirSync(directory).sort();
  const expected = [entry.addon.fileName, entry.x86Addon.fileName].sort();
  if (names.length !== expected.length || names.some((name, i) => name !== expected[i]))
    throw new Error('Registered add-on cache inventory mismatch');
  verifyPayload(path.join(directory, entry.addon.fileName), entry.addon);
  verifyPayload(path.join(directory, entry.x86Addon.fileName), entry.x86Addon);
}
function verifyPayload(file: string, payload: Pick<Payload, 'size' | 'sha256'>): Buffer {
  const bytes = readRegular(file);
  if (bytes.length !== payload.size || digest(bytes) !== payload.sha256) throw new Error('Registered add-on payload hash/size mismatch');
  return bytes;
}
async function copyPayload(source: string, destination: string, payload: Payload): Promise<void> {
  assertDirectoryChain(path.dirname(source));
  assertDirectoryChain(path.dirname(destination));
  const bytes = verifyPayload(source, payload);
  const file = await fsp.open(destination, 'wx', 0o444);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  verifyPayload(destination, payload);
}
function readRegular(file: string, maximum = MAX_ADDON_BYTES): Buffer {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0 || before.size > maximum)
    throw new Error('Add-on metadata/payload must be a bounded regular file: ' + file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new Error('Add-on file changed while opening');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs)
      throw new Error('Add-on file changed while reading');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function assertDirectoryChain(directory: string, allowMissing = false): void {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Add-on path contains a non-directory or reparse point: ' + current);
    } catch (error) { if (allowMissing && isMissing(error)) return; throw error; }
  }
}
async function writeRegistry(root: string, registry: Registry): Promise<void> {
  assertDirectoryChain(root);
  const bytes = JSON.stringify(registry) + '\n';
  if (Buffer.byteLength(bytes) > MAX_JSON_BYTES) throw new Error('Add-on registry exceeds its metadata byte limit');
  const temporary = path.join(root, `.registrations-${randomUUID()}.tmp`);
  const file = await fsp.open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  try { await fsp.rename(temporary, path.join(root, REGISTRY_NAME)); }
  finally { await fsp.unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
}
async function removeUnpublishedDirectory(directory: string, parent: string): Promise<void> {
  // Only fresh mkdtemp directories are passed here; never a registered cache or host snapshot.
  assertDirectoryChain(directory);
  if (path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(parent))
    throw new Error('Unpublished add-on directory escaped its intended parent');
  await fsp.rm(directory, { recursive: true, force: true });
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
async function acquireRegistryLock(root: string): Promise<() => Promise<void>> {
  const key = digest(process.platform === 'win32' ? root.toLowerCase() : root).slice(0, 40);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\ego-addon-preload-v1-${key}` : `\0ego-addon-preload-v1-${key}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const server = createServer(socket => socket.destroy());
    server.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, () => { server.removeListener('error', reject); resolve(); });
      });
      return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } catch (error) {
      server.close();
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}
