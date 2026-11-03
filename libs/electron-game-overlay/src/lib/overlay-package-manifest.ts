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
const OWNED_LATE_D3D11_FIRST_RUNTIME_GENERATION = 15;
const OWNED_LATE_D3D11_PATCH_SHA256 =
  '51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE';
const INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256 =
  'B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554';
const INJECTOR_ADDON_PRELOAD_PATCH_SHA256 =
  'E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D';
const INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256 =
  'A8C494EF02E08E5084D7EDC27ABCB73639C18D23469F244F99F090A27DB46309';
const INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256 =
  'FFFF684D2E60D36F1CEC4D073B91A014B7F497A50C4F5B00F7B7F2A57714397B';
const OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256 =
  'BCC0F0CD455B80DB3ED6D850B63600116B1D9881F1C85602CF76CEF7B23C35A6';
const INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256 =
  '5E9E7D2C8A2EE66F9A478CA193B5962C4F635943D040B121593AD70A3177D8A7';

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
    'lib/reshade-launcher.js', 'lib/overlay-broker-protocol.js', 'lib/overlay-package-manifest.js',
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
  // Read the sealed compiled constant, never execute an incoming SDK. Binding
  // the generation also prevents a current implementation's native manifests
  // from being downgraded to the retained pre-owned-late provenance schema.
  const protocol = readRegular(path.join(dist, 'lib/overlay-broker-protocol.js')).toString('utf8');
  const generations = [...protocol.matchAll(/^exports\.OVERLAY_BROKER_RUNTIME_GENERATION\s*=\s*([1-9][0-9]*);\s*$/gm)];
  const expectedGeneration = generations.length === 1 ? Number(generations[0][1]) : undefined;
  if (!positiveInteger(expectedGeneration)) throw new Error('Compiled SDK runtime generation is missing or ambiguous');
  const expectedReShadeSchema = expectedGeneration >= OWNED_LATE_D3D11_FIRST_RUNTIME_GENERATION ? 30 : 29;
  // Earlier generation-15 snapshots predate the first-host CLI correction.
  // Its explicit sealed implementation pin distinguishes them without trusting
  // mutable native metadata or importing the supplied validator implementation.
  const validator = readRegular(path.join(dist, 'lib/overlay-package-manifest.js')).toString('utf8');
  const firstHostDeclarations = [...validator.matchAll(/\b(?:const|let|var)\s+INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256\b/g)];
  const firstHostPins = [...validator.matchAll(/\bconst\s+INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]\s*;/g)];
  if (firstHostDeclarations.length !== firstHostPins.length || firstHostDeclarations.length > 1) {
    throw new Error('Compiled SDK first-host result patch pin is malformed or ambiguous');
  }
  const requiresFirstHostResultPatch = firstHostPins.length === 1;
  if (requiresFirstHostResultPatch && firstHostPins[0][1].toUpperCase() !== INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256) {
    throw new Error('Unsupported compiled SDK first-host result patch pin');
  }
  if ((!requiresFirstHostResultPatch && expectedGeneration > 15) ||
      (requiresFirstHostResultPatch && expectedReShadeSchema !== 30)) {
    throw new Error('Compiled SDK first-host result patch pin does not match its generation');
  }
  const preloadDeclarations = [...validator.matchAll(/\b(?:const|let|var)\s+INJECTOR_ADDON_PRELOAD_PATCH_SHA256\b/g)];
  const preloadPins = [...validator.matchAll(/\bconst\s+INJECTOR_ADDON_PRELOAD_PATCH_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]\s*;/g)];
  if (preloadDeclarations.length !== preloadPins.length || preloadDeclarations.length > 1) {
    throw new Error('Compiled SDK add-on preload patch pin is malformed or ambiguous');
  }
  const requiresAddonPreloadPatch = preloadPins.length === 1;
  if (requiresAddonPreloadPatch && preloadPins[0][1].toUpperCase() !== INJECTOR_ADDON_PRELOAD_PATCH_SHA256) {
    throw new Error('Unsupported compiled SDK add-on preload patch pin');
  }
  if ((!requiresAddonPreloadPatch && expectedGeneration > 16) ||
      (requiresAddonPreloadPatch && expectedGeneration < 17)) {
    throw new Error('Compiled SDK add-on preload patch pin does not match its generation');
  }
  // Generation 17/18 packages retain the original preload implementation.
  // Bind the later fresh-owner ordering correction to its sealed code marker,
  // rather than letting mutable source-stamp metadata claim or remove it.
  const preloadedFirstHostDeclarations = [...validator.matchAll(/\b(?:const|let|var)\s+INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256\b/g)];
  const preloadedFirstHostPins = [...validator.matchAll(/\bconst\s+INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]\s*;/g)];
  if (preloadedFirstHostDeclarations.length !== preloadedFirstHostPins.length || preloadedFirstHostDeclarations.length > 1) {
    throw new Error('Compiled SDK preloaded first-host patch pin is malformed or ambiguous');
  }
  const requiresPreloadedFirstHostPatch = preloadedFirstHostPins.length === 1;
  if (requiresPreloadedFirstHostPatch && preloadedFirstHostPins[0][1].toUpperCase() !== INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256) {
    throw new Error('Unsupported compiled SDK preloaded first-host patch pin');
  }
  if ((!requiresPreloadedFirstHostPatch && expectedGeneration > 18) ||
      (requiresPreloadedFirstHostPatch && expectedGeneration < 19)) {
    throw new Error('Compiled SDK preloaded first-host patch pin does not match its generation');
  }
  // Long registered DLL paths require both the private INI and injector load
  // spelling correction. Keep generation-19 payloads valid without advertising
  // the new tool implementation through mutable metadata alone.
  const preloadLongPathDeclarations = [...validator.matchAll(/\b(?:const|let|var)\s+INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256\b/g)];
  const preloadLongPathPins = [...validator.matchAll(/\bconst\s+INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]\s*;/g)];
  if (preloadLongPathDeclarations.length !== preloadLongPathPins.length || preloadLongPathDeclarations.length > 1) {
    throw new Error('Compiled SDK preload long-path patch pin is malformed or ambiguous');
  }
  const requiresPreloadLongPathPatch = preloadLongPathPins.length === 1;
  if (requiresPreloadLongPathPatch && preloadLongPathPins[0][1].toUpperCase() !== INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256) {
    throw new Error('Unsupported compiled SDK preload long-path patch pin');
  }
  if ((!requiresPreloadLongPathPatch && expectedGeneration > 19) ||
      (requiresPreloadLongPathPatch && expectedGeneration < 20)) {
    throw new Error('Compiled SDK preload long-path patch pin does not match its generation');
  }
  // The owned host's adapter-ready enumeration is separate from the injector's
  // long-path loader correction. Retained generation-20 packages keep the
  // injector pin while omitting this later host implementation marker.
  const adapterReadyLongPathDeclarations = [...validator.matchAll(/\b(?:const|let|var)\s+OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256\b/g)];
  const adapterReadyLongPathPins = [...validator.matchAll(/\bconst\s+OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]\s*;/g)];
  if (adapterReadyLongPathDeclarations.length !== adapterReadyLongPathPins.length || adapterReadyLongPathDeclarations.length > 1) {
    throw new Error('Compiled SDK adapter-ready long-path patch pin is malformed or ambiguous');
  }
  const requiresAdapterReadyLongPathPatch = adapterReadyLongPathPins.length === 1;
  if (requiresAdapterReadyLongPathPatch && adapterReadyLongPathPins[0][1].toUpperCase() !== OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256) {
    throw new Error('Unsupported compiled SDK adapter-ready long-path patch pin');
  }
  if ((!requiresAdapterReadyLongPathPatch && expectedGeneration > 20) ||
      (requiresAdapterReadyLongPathPatch && expectedGeneration < 21)) {
    throw new Error('Compiled SDK adapter-ready long-path patch pin does not match its generation');
  }
  // Bind the bounded initial-inspection recovery implementation independently
  // of the retained injector and owned-host long-path corrections.
  const initialInspectionRecoveryDeclarations = [...validator.matchAll(/\b(?:const|let|var)\s+INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256\b/g)];
  const initialInspectionRecoveryPins = [...validator.matchAll(/\bconst\s+INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]\s*;/g)];
  if (initialInspectionRecoveryDeclarations.length !== initialInspectionRecoveryPins.length || initialInspectionRecoveryDeclarations.length > 1) {
    throw new Error('Compiled SDK initial inspection recovery patch pin is malformed or ambiguous');
  }
  const requiresInitialInspectionRecoveryPatch = initialInspectionRecoveryPins.length === 1;
  if (requiresInitialInspectionRecoveryPatch && initialInspectionRecoveryPins[0][1].toUpperCase() !== INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256) {
    throw new Error('Unsupported compiled SDK initial inspection recovery patch pin');
  }
  if ((!requiresInitialInspectionRecoveryPatch && expectedGeneration > 21) ||
      (requiresInitialInspectionRecoveryPatch && expectedGeneration < 22)) {
    throw new Error('Compiled SDK initial inspection recovery patch pin does not match its generation');
  }
  const native = path.join(dist, 'runtime/win32-x64/reshade');
  let paired: Record<string, unknown> | undefined;
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const stampName = `electron_game_overlay_runtime${suffix}.build.json`;
    const stamp = json(path.join(native, stampName));
    if (stamp.schemaVersion !== 4 || stamp.kind !== 'electron-game-overlay-runtime-build' ||
        stamp.platform !== (bits === 64 ? 'win32-x64' : 'win32-ia32') || stamp.configuration !== 'RelWithDebInfo' ||
        stamp.cooperativeAddonProtocol !== 1 || stamp.injectorProcessInstanceBinding !== 1 || stamp.injectorFutureTargets !== 2 ||
        (stamp.addonPreloadProtocol !== undefined && stamp.addonPreloadProtocol !== 1) ||
        stamp.managerProtocolSchemaVersion !== 1 || stamp.addonBuildId !== expectedBuildId ||
        !positiveInteger(stamp.runtimeGeneration) || !positiveInteger(stamp.targetTransportMin) ||
        !positiveInteger(stamp.targetTransportMax) || stamp.targetTransportMin !== 1 || stamp.targetTransportMax < stamp.targetTransportMin ||
        typeof stamp.managerSourceSha256 !== 'string' || !NATIVE_DIGEST.test(stamp.managerSourceSha256)) {
      throw new Error('Unsupported cooperative native runtime manifest: ' + stampName);
    }
    if (paired && ['addonBuildId', 'runtimeGeneration', 'targetTransportMin', 'targetTransportMax', 'cooperativeAddonProtocol', 'addonPreloadProtocol']
      .some((key) => stamp[key] !== paired![key])) throw new Error('Native architecture manifests disagree');
    if (stamp.runtimeGeneration !== expectedGeneration) throw new Error('Native runtime generation disagrees with the compiled SDK');
    if (requiresAddonPreloadPatch ? stamp.addonPreloadProtocol !== 1 : stamp.addonPreloadProtocol !== undefined) {
      throw new Error('Native add-on preload capability does not match the sealed SDK implementation: ' + bits);
    }
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
    if (reshade.schemaVersion !== expectedReShadeSchema || reshade.cooperativeAddonProtocol !== 1 || reshade.injectorProcessInstanceBinding !== 1 ||
        reshade.injectorFutureTargets !== 2 || reshade.configuration !== 'Release' || reshade.addonLevel !== 2 ||
        reshade.platform !== (bits === 64 ? '64-bit' : '32-bit') || typeof reshade.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(reshade.commit)) {
      throw new Error('Unsupported pinned ReShade build manifest: ' + bits);
    }
    if (expectedReShadeSchema === 30) {
      if (typeof reshade.ownedLateD3d11PatchSha256 !== 'string' ||
          !NATIVE_DIGEST.test(reshade.ownedLateD3d11PatchSha256) ||
          reshade.ownedLateD3d11PatchSha256.toUpperCase() !== OWNED_LATE_D3D11_PATCH_SHA256) {
        throw new Error('Pinned owned late D3D11 patch provenance mismatch: ' + bits);
      }
    } else if (reshade.ownedLateD3d11PatchSha256 !== undefined) {
      throw new Error('Owned late D3D11 patch provenance requires ReShade schema 30: ' + bits);
    }
    if (requiresFirstHostResultPatch) {
      if (typeof reshade.injectorFirstHostResultPatchSha256 !== 'string' ||
          !NATIVE_DIGEST.test(reshade.injectorFirstHostResultPatchSha256) ||
          reshade.injectorFirstHostResultPatchSha256.toUpperCase() !== INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256) {
        throw new Error('Pinned injector first-host result patch provenance mismatch: ' + bits);
      }
    } else if (reshade.injectorFirstHostResultPatchSha256 !== undefined) {
      throw new Error('Injector first-host result patch provenance requires the sealed SDK implementation pin: ' + bits);
    }
    if (reshade.addonPreloadProtocol !== stamp.addonPreloadProtocol) {
      throw new Error('ReShade and native add-on preload capabilities disagree: ' + bits);
    }
    if (requiresAddonPreloadPatch) {
      if (typeof reshade.injectorAddonPreloadPatchSha256 !== 'string' ||
          !NATIVE_DIGEST.test(reshade.injectorAddonPreloadPatchSha256) ||
          reshade.injectorAddonPreloadPatchSha256.toUpperCase() !== INJECTOR_ADDON_PRELOAD_PATCH_SHA256) {
        throw new Error('Pinned injector add-on preload patch provenance mismatch: ' + bits);
      }
    } else if (reshade.injectorAddonPreloadPatchSha256 !== undefined) {
      throw new Error('Injector add-on preload patch provenance requires the sealed SDK implementation pin: ' + bits);
    }
    if (requiresPreloadedFirstHostPatch) {
      if (typeof reshade.injectorPreloadedFirstHostPatchSha256 !== 'string' ||
          !NATIVE_DIGEST.test(reshade.injectorPreloadedFirstHostPatchSha256) ||
          reshade.injectorPreloadedFirstHostPatchSha256.toUpperCase() !== INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256) {
        throw new Error('Pinned injector preloaded first-host patch provenance mismatch: ' + bits);
      }
    } else if (reshade.injectorPreloadedFirstHostPatchSha256 !== undefined) {
      throw new Error('Injector preloaded first-host patch provenance requires the sealed SDK implementation pin: ' + bits);
    }
    if (requiresPreloadLongPathPatch) {
      if (typeof reshade.injectorPreloadLongPathPatchSha256 !== 'string' ||
          !NATIVE_DIGEST.test(reshade.injectorPreloadLongPathPatchSha256) ||
          reshade.injectorPreloadLongPathPatchSha256.toUpperCase() !== INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256) {
        throw new Error('Pinned injector preload long-path patch provenance mismatch: ' + bits);
      }
    } else if (reshade.injectorPreloadLongPathPatchSha256 !== undefined) {
      throw new Error('Injector preload long-path patch provenance requires the sealed SDK implementation pin: ' + bits);
    }
    if (requiresAdapterReadyLongPathPatch) {
      if (typeof reshade.ownedLateD3d11AdapterReadyLongPathPatchSha256 !== 'string' ||
          !NATIVE_DIGEST.test(reshade.ownedLateD3d11AdapterReadyLongPathPatchSha256) ||
          reshade.ownedLateD3d11AdapterReadyLongPathPatchSha256.toUpperCase() !== OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256) {
        throw new Error('Pinned owned late D3D11 adapter-ready long-path patch provenance mismatch: ' + bits);
      }
    } else if (reshade.ownedLateD3d11AdapterReadyLongPathPatchSha256 !== undefined) {
      throw new Error('Owned late D3D11 adapter-ready long-path patch provenance requires the sealed SDK implementation pin: ' + bits);
    }
    if (requiresInitialInspectionRecoveryPatch) {
      if (typeof reshade.injectorInitialInspectionRecoveryPatchSha256 !== 'string' ||
          !NATIVE_DIGEST.test(reshade.injectorInitialInspectionRecoveryPatchSha256) ||
          reshade.injectorInitialInspectionRecoveryPatchSha256.toUpperCase() !== INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256) {
        throw new Error('Pinned injector initial inspection recovery patch provenance mismatch: ' + bits);
      }
    } else if (reshade.injectorInitialInspectionRecoveryPatchSha256 !== undefined) {
      throw new Error('Injector initial inspection recovery patch provenance requires the sealed SDK implementation pin: ' + bits);
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
