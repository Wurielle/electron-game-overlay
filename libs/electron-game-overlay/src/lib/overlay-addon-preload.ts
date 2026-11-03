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
  /** Absolute shared ReShade add-on directory. Normally omitted to use the current account. */
  addonDirectory?: string;
  /** @deprecated Alias for addonDirectory. Do not supply both options. */
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

/** Immutable installed native payload identity. Existing games retain their mapped modules. */
export interface OverlayAddonInstallation {
  readonly applicationId: string;
  readonly registrationId: string;
  readonly addonBuildId: string;
  readonly addonDirectory: string;
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
  addon: Payload;
  x86Addon: Payload;
}
interface Registry {
  schemaVersion: 2;
  kind: 'electron-game-overlay-addon-preload-registry';
  registrations: Registration[];
}

/** @internal The source runtime has already passed its native package validation. */
export interface OverlayAddonPreloadCurrentRuntime {
  addonBuildId: string;
  addonPath: string;
  x86AddonPath: string;
}

/** @internal Validated registered inventory and shared directory for one future owned host. */
export interface OverlayAddonPreloadSelection {
  readonly applicationId: string;
  readonly directory: string;
  readonly registrationId: string;
  readonly addonBuildId: string;
  readonly addonFileName: string;
  readonly x86AddonFileName: string;
  readonly addonPath: string;
  readonly x86AddonPath: string;
  readonly inactiveFileNames: readonly string[];
  readonly payloads: readonly Readonly<Payload & { sourcePath: string }>[];
}

const REGISTRY_NAME = 'registrations.json';
const METADATA_DIRECTORY = '.electron-game-overlay';
const REGISTRY_KIND = 'electron-game-overlay-addon-preload-registry' as const;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ADDON_BYTES = 512 * 1024 * 1024;
const MAX_REGISTRATIONS = 4096;
const DIGEST = /^[0-9a-f]{64}$/;
const BUILD_ID = /^[0-9A-F]{32}$/;
const RESERVED_ADDON_FILE_NAME = /^ego-preload-[0-9a-f]{32}-[0-9A-F]{32}-[0-9a-f]{16}\.addon(?:64|32)$/i;
const APPLICATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const NATIVE_DIRECTORY = 'runtime/win32-x64/reshade';

/** Account-token home is authoritative; Electron environment variables are not used. */
export function defaultReShadeAddonDirectory(): string {
  return path.join(userInfo({ encoding: 'utf8' }).homedir, 'AppData', 'Local', 'ReShade', 'Addons');
}

/**
 * Returns the default shared ReShade add-on directory.
 * @deprecated Alias for defaultReShadeAddonDirectory().
 */
export function defaultOverlayAddonStorageRoot(): string { return defaultReShadeAddonDirectory(); }

/**
 * Registers both architectures from a directly sealed SDK in the per-user
 * shared ReShade directory. Repeating the same application/build is idempotent. Different
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
  const root = await prepareAddonDirectory(options);
  const release = await acquireRegistryLock(root);
  try {
    const registry = readRegistry(root);
    const existing = registry.registrations.find(entry => entry.registrationId === registrationId);
    if (existing) {
      verifyRegistration(root, existing);
      return installation(root, existing);
    }
    if (registry.registrations.length >= MAX_REGISTRATIONS) throw new Error('Add-on registration limit exceeded');
    await publishPayload(addon.sourcePath, path.join(root, addon.fileName), addon);
    await publishPayload(x86Addon.sourcePath, path.join(root, x86Addon.fileName), x86Addon);
    const entry: Registration = { addonPreloadProtocol: 1, applicationId: options.applicationId, registrationId, addonBuildId,
      addon: payloadMetadata(addon), x86Addon: payloadMetadata(x86Addon) };
    verifyRegistration(root, entry);
    registry.registrations.push(entry);
    registry.registrations.sort((a, b) => a.registrationId.localeCompare(b.registrationId));
    await writeRegistry(root, registry);
    return installation(root, entry);
  } finally { await release(); }
}

/**
 * Removes this application's registration from future owned hosts. Native
 * files remain in place because games may still have them mapped. Future owned
 * hosts disable these retired EGO filenames; other libraries' add-ons are untouched.
 */
export async function unregisterOverlayAddonInstallation(
  options: OverlayAddonUninstallationOptions,
): Promise<void> {
  validateApplicationId(options.applicationId);
  if (options.registrationId !== undefined && !DIGEST.test(options.registrationId))
    throw new TypeError('Invalid add-on registration identity');
  const root = await prepareAddonDirectory(options);
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
  const requestedRoot = addonDirectory(options);
  assertDirectoryChain(requestedRoot);
  const root = fs.realpathSync(requestedRoot);
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
        sourcePath: path.join(root, payload.fileName) }));
    }
  }
  const activeNames = new Set([...payloads.keys()].map(name => name.toLowerCase()));
  const inactiveFileNames = fs.readdirSync(root).filter(name =>
    RESERVED_ADDON_FILE_NAME.test(name) && !activeNames.has(name.toLowerCase())).sort();
  return Object.freeze({ applicationId: options.applicationId, directory: root, registrationId, addonBuildId: selected.addonBuildId,
    addonFileName: selected.addon.fileName, x86AddonFileName: selected.x86Addon.fileName,
    addonPath: path.join(root, selected.addon.fileName), x86AddonPath: path.join(root, selected.x86Addon.fileName),
    inactiveFileNames: Object.freeze(inactiveFileNames),
    payloads: Object.freeze([...payloads.values()].sort((a, b) => a.fileName.localeCompare(b.fileName))) });
}

function bundledPackageRoot(): string {
  return path.resolve(__dirname, '..', '..').replace(/([\\/])([^\\/]+\.asar)(?=[\\/]|$)/i, '$1$2.unpacked');
}
function addonDirectory(options: Pick<OverlayAddonPreloadOptions, 'addonDirectory' | 'storageRoot'>): string {
  if (options.addonDirectory !== undefined && options.storageRoot !== undefined)
    throw new TypeError('Use addonDirectory or its deprecated storageRoot alias, not both');
  const root = options.addonDirectory ?? options.storageRoot ?? defaultReShadeAddonDirectory();
  if (!path.isAbsolute(root) || /[\r\n\0]/.test(root)) throw new TypeError('Add-on directory must be an absolute INI-safe path');
  return path.resolve(root);
}
function metadataDirectory(root: string): string { return path.join(root, METADATA_DIRECTORY); }
async function prepareAddonDirectory(options: OverlayAddonPreloadOptions): Promise<string> {
  const root = addonDirectory(options);
  assertDirectoryChain(root, true);
  await fsp.mkdir(root, { recursive: true });
  assertDirectoryChain(root);
  const canonical = fs.realpathSync(root);
  const metadata = metadataDirectory(canonical);
  assertDirectoryChain(metadata, true);
  await fsp.mkdir(metadata, { recursive: true });
  assertDirectoryChain(metadata);
  return canonical;
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
    addonDirectory: root, addonPath: path.join(root, entry.addon.fileName),
    x86AddonPath: path.join(root, entry.x86Addon.fileName) });
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
  assertDirectoryChain(metadataDirectory(root));
  try { bytes = readRegular(path.join(metadataDirectory(root), REGISTRY_NAME), MAX_JSON_BYTES); }
  catch (error) { if (isMissing(error)) return { schemaVersion: 2, kind: REGISTRY_KIND, registrations: [] }; throw error; }
  const value = parseObject(bytes);
  if (!exactKeys(value, ['schemaVersion', 'kind', 'registrations']) || value.schemaVersion !== 2 || value.kind !== REGISTRY_KIND ||
      !Array.isArray(value.registrations) || value.registrations.length > MAX_REGISTRATIONS)
    throw new Error('Invalid add-on registration registry');
  const ids = new Set<string>();
  for (const entry of value.registrations) {
    if (!object(entry) || !exactKeys(entry, ['addonPreloadProtocol', 'applicationId', 'registrationId', 'addonBuildId', 'addon', 'x86Addon']) ||
        entry.addonPreloadProtocol !== 1 ||
        typeof entry.applicationId !== 'string' || !APPLICATION_ID.test(entry.applicationId) ||
        typeof entry.registrationId !== 'string' || !DIGEST.test(entry.registrationId) || ids.has(entry.registrationId) ||
        typeof entry.addonBuildId !== 'string' || !BUILD_ID.test(entry.addonBuildId)) throw new Error('Invalid add-on registration entry');
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
  assertDirectoryChain(root);
  verifyPayload(path.join(root, entry.addon.fileName), entry.addon);
  verifyPayload(path.join(root, entry.x86Addon.fileName), entry.x86Addon);
}
function verifyPayload(file: string, payload: Pick<Payload, 'size' | 'sha256'>): Buffer {
  const bytes = readRegular(file);
  if (bytes.length !== payload.size || digest(bytes) !== payload.sha256) throw new Error('Registered add-on payload hash/size mismatch');
  return bytes;
}
async function publishPayload(source: string, destination: string, payload: Payload): Promise<void> {
  assertDirectoryChain(path.dirname(source));
  assertDirectoryChain(path.dirname(destination));
  const bytes = verifyPayload(source, payload);
  try { verifyPayload(destination, payload); return; }
  catch (error) { if (!isMissing(error)) throw error; }
  // A temporary non-add-on filename prevents a concurrent ReShade scan from
  // loading a partial write. Linking publishes complete bytes atomically and
  // fails if a foreign/existing file already occupies the immutable final name.
  const temporary = path.join(path.dirname(destination), `.ego-preload-${randomUUID()}.tmp`);
  const file = await fsp.open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    assertDirectoryChain(path.dirname(destination));
    try { await fsp.link(temporary, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    verifyPayload(destination, payload);
  } finally {
    await file.close();
    await fsp.unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
  }
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
  const metadata = metadataDirectory(root);
  assertDirectoryChain(metadata);
  const bytes = JSON.stringify(registry) + '\n';
  if (Buffer.byteLength(bytes) > MAX_JSON_BYTES) throw new Error('Add-on registry exceeds its metadata byte limit');
  const temporary = path.join(metadata, `.registrations-${randomUUID()}.tmp`);
  const file = await fsp.open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  try { await fsp.rename(temporary, path.join(metadata, REGISTRY_NAME)); }
  finally { await fsp.unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
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
