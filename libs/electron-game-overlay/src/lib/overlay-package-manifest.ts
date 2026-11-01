import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** @internal Build artifact integrity, not publisher authentication. */
export const OVERLAY_DISTRIBUTION_MANIFEST_FILE_NAME = 'overlay-manifest.json';
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 8192;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST = /^[0-9a-f]{64}$/;
const NATIVE_DIGEST = /^[0-9a-fA-F]{64}$/;

/** @internal */
export interface OverlayDistributionManifest {
  schema: 1;
  kind: 'electron-game-overlay-sdk-distribution';
  packageVersion: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function relativeName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !/[\\:\x00-\x1f\x7f]/.test(value) &&
    !value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part));
}

function readRegular(file: string, maximum = MAX_FILE_BYTES): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('Symbolic link inside SDK payload refused: ' + file);
  if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid SDK payload size/type: ' + file);
  const bytes = fs.readFileSync(file);
  if (bytes.length !== stat.size || bytes.length > maximum) throw new Error('SDK payload changed while reading: ' + file);
  return bytes;
}

function directory(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('Symbolic link inside SDK payload refused: ' + file);
  if (!stat.isDirectory()) throw new Error('SDK distribution must be a regular directory: ' + file);
}

function inventory(dist: string): string[] {
  directory(dist);
  const files: string[] = [];
  const folded = new Set<string>();
  function visit(base: string, prefix: string): void {
    for (const name of fs.readdirSync(base).sort()) {
      const relative = prefix + name;
      if (!prefix && name === OVERLAY_DISTRIBUTION_MANIFEST_FILE_NAME) continue;
      if (!relativeName(relative)) throw new Error('Unsafe SDK payload path: ' + relative);
      if (relative === 'broker' || relative.startsWith('broker/')) {
        throw new Error('Standalone broker payload is not part of the cooperative SDK');
      }
      const key = relative.toLowerCase();
      if (folded.has(key)) throw new Error('Case-colliding SDK payload path: ' + relative);
      folded.add(key);
      const file = path.join(base, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Symbolic link inside SDK payload refused: ' + relative);
      if (stat.isDirectory()) visit(file, relative + '/');
      else if (stat.isFile()) {
        files.push(relative);
        if (files.length > MAX_FILES) throw new Error('Too many SDK payload files');
      } else throw new Error('Nonregular SDK payload refused: ' + relative);
    }
  }
  visit(dist, '');
  return files.sort();
}

function json(file: string, maximum = 32 * 1024): Record<string, unknown> {
  const bytes = readRegular(file, maximum);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid SDK JSON payload: ' + file); }
  if (!object(value)) throw new Error('SDK JSON payload must be an object: ' + file);
  return value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0xffffffff;
}

function nativeMachine(file: string, expected: number): void {
  const bytes = readRegular(file);
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length;
  if (bytes.length < 70 || bytes.toString('ascii', 0, 2) !== 'MZ' || offset > bytes.length - 6 ||
      bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== expected) {
    throw new Error('Invalid native PE architecture: ' + file);
  }
}

function verifyHash(root: string, file: string, expected: unknown): void {
  if (typeof expected !== 'string' || !NATIVE_DIGEST.test(expected) ||
      digest(readRegular(path.join(root, file))) !== expected.toLowerCase()) {
    throw new Error('Native SHA-256 integrity mismatch: ' + file);
  }
}

function validateNative(dist: string, files: ReadonlySet<string>): void {
  for (const entry of ['index.js', 'index.d.ts', 'packaging.js', 'packaging.d.ts',
    'lib/reshade-launcher.js',
    'node_modules/tslib/package.json', 'node_modules/tslib/tslib.js',
    'node_modules/tslib/LICENSE.txt', 'node_modules/tslib/CopyrightNotice.txt']) {
    if (!files.has(entry) || readRegular(path.join(dist, entry)).length === 0) {
      throw new Error('Required sealed SDK payload missing: ' + entry);
    }
  }
  const dependency = json(path.join(dist, 'node_modules/tslib/package.json'));
  if (dependency.name !== 'tslib' || typeof dependency.version !== 'string' || !VERSION.test(dependency.version)) {
    throw new Error('Invalid sealed tslib dependency metadata');
  }
  // Bind the native payloads to the compiled launcher's exact identity without
  // importing or executing an incoming SDK implementation during packaging.
  const launcher = readRegular(path.join(dist, 'lib/reshade-launcher.js')).toString('utf8');
  const identities = [...launcher.matchAll(/\b(?:const|let|var)\s+OFFICIAL_ADDON_BUILD_ID\s*=\s*['"]([0-9A-F]{32})['"]/g)];
  if (identities.length !== 1) throw new Error('Compiled SDK exact native add-on identity is missing or ambiguous');
  const expectedBuildId = identities[0][1];
  const native = path.join(dist, 'runtime/win32-x64/reshade');
  let paired: Record<string, unknown> | undefined;
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const stampName = `electron_game_overlay_runtime${suffix}.build.json`;
    const stamp = json(path.join(native, stampName));
    if (stamp.schemaVersion !== 4 || stamp.kind !== 'electron-game-overlay-runtime-build' ||
        stamp.platform !== (bits === 64 ? 'win32-x64' : 'win32-ia32') || stamp.configuration !== 'RelWithDebInfo' ||
        stamp.cooperativeAddonProtocol !== 1 || stamp.injectorProcessInstanceBinding !== 1 || stamp.injectorFutureTargets !== 2 ||
        stamp.managerProtocolSchemaVersion !== 1 || stamp.addonBuildId !== expectedBuildId ||
        !positiveInteger(stamp.runtimeGeneration) || !positiveInteger(stamp.targetTransportMin) ||
        !positiveInteger(stamp.targetTransportMax) || stamp.targetTransportMin !== 1 || stamp.targetTransportMax < stamp.targetTransportMin ||
        typeof stamp.managerSourceSha256 !== 'string' || !NATIVE_DIGEST.test(stamp.managerSourceSha256)) {
      throw new Error('Unsupported cooperative native runtime manifest: ' + stampName);
    }
    if (paired && ['addonBuildId', 'runtimeGeneration', 'targetTransportMin', 'targetTransportMax', 'cooperativeAddonProtocol']
      .some((key) => stamp[key] !== paired![key])) throw new Error('Native architecture manifests disagree');
    paired = stamp;
    const assets: Record<string, string> = {
      addonSha256: `electron_game_overlay.addon${bits}`,
      managerSha256: `electron_game_overlay_reshade_manager${suffix}.exe`,
      injectorSha256: `inject${suffix}.exe`,
      reshadeRuntimeSha256: `ReShade${bits}.dll`,
      reshadeConfigSha256: 'ReShade.ini',
      reshadeBuildStampSha256: `ReShade${bits}.build.json`,
    };
    for (const [field, file] of Object.entries(assets)) {
      if (!files.has('runtime/win32-x64/reshade/' + file)) throw new Error('Required native payload missing: ' + file);
      verifyHash(native, file, stamp[field]);
    }
    for (const file of [`electron_game_overlay.addon${bits}`, `electron_game_overlay_reshade_manager${suffix}.exe`, `inject${suffix}.exe`, `ReShade${bits}.dll`]) {
      nativeMachine(path.join(native, file), bits === 64 ? 0x8664 : 0x14c);
    }
    const reshade = json(path.join(native, `ReShade${bits}.build.json`));
    if (reshade.schemaVersion !== 29 || reshade.cooperativeAddonProtocol !== 1 || reshade.injectorProcessInstanceBinding !== 1 ||
        reshade.injectorFutureTargets !== 2 || reshade.configuration !== 'Release' || reshade.addonLevel !== 2 ||
        reshade.platform !== (bits === 64 ? '64-bit' : '32-bit') || typeof reshade.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(reshade.commit)) {
      throw new Error('Unsupported pinned ReShade build manifest: ' + bits);
    }
    verifyHash(native, `ReShade${bits}.dll`, reshade.runtimeSha256);
    verifyHash(native, `inject${suffix}.exe`, reshade.injectorSha256);
  }
}

/** @internal Creates integrity metadata only after validating native identities. */
export function createOverlayDistributionManifestSync(dist: string, packageVersion: string): OverlayDistributionManifest {
  if (!VERSION.test(packageVersion)) throw new Error('Invalid SDK package version');
  const root = path.resolve(dist);
  const names = inventory(root);
  validateNative(root, new Set(names));
  let total = 0;
  const files = names.map((name) => {
    const bytes = readRegular(path.join(root, name));
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('SDK distribution exceeds its aggregate byte bound');
    return { path: name, size: bytes.length, sha256: digest(bytes) };
  });
  return { schema: 1, kind: 'electron-game-overlay-sdk-distribution', packageVersion, files };
}

/** @internal All payloads are sealed directly; no broker or SDK code executes. */
export function validateOverlayDistributionSync(dist: string, expectedPackageVersion?: string): OverlayDistributionManifest {
  const root = path.resolve(dist);
  directory(root);
  const manifest = json(path.join(root, OVERLAY_DISTRIBUTION_MANIFEST_FILE_NAME), MAX_MANIFEST_BYTES);
  if (manifest.schema !== 1 || manifest.kind !== 'electron-game-overlay-sdk-distribution' ||
      typeof manifest.packageVersion !== 'string' || !VERSION.test(manifest.packageVersion) ||
      (expectedPackageVersion !== undefined && manifest.packageVersion !== expectedPackageVersion) ||
      !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILES) {
    throw new Error('Invalid cooperative SDK distribution manifest');
  }
  const declared = new Set<string>();
  const folded = new Set<string>();
  let previous = '', total = 0;
  for (const entry of manifest.files) {
    if (!object(entry) || !relativeName(entry.path) || entry.path === OVERLAY_DISTRIBUTION_MANIFEST_FILE_NAME ||
        entry.path <= previous || folded.has(entry.path.toLowerCase()) ||
        !Number.isSafeInteger(entry.size) || (entry.size as number) < 0 || (entry.size as number) > MAX_FILE_BYTES ||
        typeof entry.sha256 !== 'string' || !DIGEST.test(entry.sha256)) {
      throw new Error('Invalid SDK manifest payload path/size/hash');
    }
    previous = entry.path;
    declared.add(entry.path);
    folded.add(entry.path.toLowerCase());
    total += entry.size as number;
    if (total > MAX_TOTAL_BYTES) throw new Error('SDK distribution exceeds its aggregate byte bound');
  }
  const names = inventory(root);
  if (names.length !== declared.size || names.some((name) => !declared.has(name))) {
    throw new Error('SDK distribution contains undeclared or missing payload files');
  }
  for (const entry of manifest.files as OverlayDistributionManifest['files']) {
    const bytes = readRegular(path.join(root, entry.path));
    if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) throw new Error('SDK sealed payload hash/size mismatch: ' + entry.path);
  }
  validateNative(root, declared);
  return manifest as unknown as OverlayDistributionManifest;
}
