'use strict';

// Read-only candidate/module evidence for the controlled game acceptance runner.
// This never loads a DLL and cannot establish historical injection count.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function readFile(filename, maximum = MAX_IMAGE_BYTES) {
  if (!path.isAbsolute(filename)) throw new Error('Evidence paths must be absolute.');
  if (!fs.lstatSync(filename).isFile()) throw new Error(`Evidence input is not a regular file: ${filename}`);
  const canonical = fs.realpathSync(filename);
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximum) throw new Error(`Evidence input size is out of bounds: ${filename}`);
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
      if (!count) throw new Error(`Evidence input changed while reading: ${filename}`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || fs.realpathSync(filename) !== canonical) {
      throw new Error(`Evidence input changed while reading: ${filename}`);
    }
    return { path: canonical, data };
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspectPe(image) {
  if (!Buffer.isBuffer(image) || image.length > MAX_IMAGE_BYTES) throw new Error('PE image size is out of bounds.');
  const bounds = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > image.length) throw new Error('Malformed PE file bounds.');
  };
  const u16 = (offset) => { bounds(offset, 2); return image.readUInt16LE(offset); };
  const u32 = (offset) => { bounds(offset, 4); return image.readUInt32LE(offset); };
  bounds(0, 64);
  if (image.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid MZ header.');
  const pe = u32(60);
  bounds(pe, 24);
  if (pe < 64 || image.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid PE header.');
  const machine = u16(pe + 4);
  const architecture = machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : undefined;
  if (!architecture) throw new Error('Unsupported PE machine.');
  const optional = pe + 24;
  const optionalSize = u16(pe + 20);
  const directoryOffset = architecture === 'x64' ? 112 : 96;
  bounds(optional, optionalSize);
  if (optionalSize < directoryOffset || u16(optional) !== (architecture === 'x64' ? 0x20b : 0x10b)) throw new Error('Invalid PE optional header.');
  const directories = u32(optional + directoryOffset - 4);
  if (directories > 16 || directoryOffset + directories * 8 > optionalSize) throw new Error('Malformed PE data directories.');
  const sectionCount = u16(pe + 6);
  if (!sectionCount || sectionCount > 96) throw new Error('Invalid PE section count.');
  const sectionsOffset = optional + optionalSize;
  bounds(sectionsOffset, sectionCount * 40);
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const section = sectionsOffset + index * 40;
    const virtualSize = u32(section + 8);
    const virtualAddress = u32(section + 12);
    const rawSize = u32(section + 16);
    const rawOffset = u32(section + 20);
    bounds(rawOffset, rawSize);
    if (virtualAddress + Math.max(virtualSize, rawSize) > 0x100000000) throw new Error('Malformed PE section range.');
    sections.push({ virtualAddress, virtualSize, rawSize, rawOffset });
  }
  const headersSize = u32(optional + 60);
  if (headersSize > image.length || headersSize < sectionsOffset + sectionCount * 40) throw new Error('Malformed PE header size.');
  const rva = (address, length) => {
    if (!Number.isSafeInteger(address) || !Number.isSafeInteger(length) || address < 0 || length < 0 || address + length > 0x100000000) throw new Error('Malformed PE RVA range.');
    if (address < headersSize && address + length <= headersSize) { bounds(address, length); return address; }
    const candidates = sections.filter((section) => address >= section.virtualAddress && address + length <= section.virtualAddress + section.rawSize);
    if (candidates.length !== 1) throw new Error('Malformed or ambiguous PE RVA.');
    const result = candidates[0].rawOffset + address - candidates[0].virtualAddress;
    bounds(result, length);
    return result;
  };
  const mappedRva = (address) => address < headersSize || sections.filter((section) => address >= section.virtualAddress && address < section.virtualAddress + Math.max(section.virtualSize, section.rawSize)).length === 1;
  const string = (address, maximum = 1024) => {
    let value = '';
    for (let index = 0; index < maximum; index++) {
      const byte = image[rva(address + index, 1)];
      if (byte === 0) return value;
      if (byte < 0x21 || byte > 0x7e) throw new Error('Malformed PE export string.');
      value += String.fromCharCode(byte);
    }
    throw new Error('Unterminated PE export string.');
  };
  const exports = [];
  let exportRva = 0;
  let exportSize = 0;
  if (directories) {
    exportRva = u32(optional + directoryOffset);
    exportSize = u32(optional + directoryOffset + 4);
    if (Boolean(exportRva) !== Boolean(exportSize) || exportRva + exportSize > 0x100000000) throw new Error('Malformed PE export directory.');
    if (exportRva) {
      if (exportSize < 40 || exportSize > 16 * 1024 * 1024) throw new Error('PE export directory size is out of bounds.');
      const table = rva(exportRva, exportSize);
      const functionCount = u32(table + 20);
      const nameCount = u32(table + 24);
      if (functionCount > 65536 || nameCount > 65536 || (nameCount && !functionCount)) throw new Error('PE export count is out of bounds.');
      const functions = rva(u32(table + 28), functionCount * 4);
      const names = rva(u32(table + 32), nameCount * 4);
      const ordinals = rva(u32(table + 36), nameCount * 2);
      const seen = new Set();
      for (let index = 0; index < nameCount; index++) {
        const name = string(u32(names + index * 4));
        const ordinal = u16(ordinals + index * 2);
        if (!name || seen.has(name) || ordinal >= functionCount) throw new Error('Invalid PE export identity or ordinal.');
        seen.add(name);
        const address = u32(functions + ordinal * 4);
        if (!address) throw new Error('Named PE export has no target.');
        const forwarded = address >= exportRva && address < exportRva + exportSize;
        if (!mappedRva(address)) throw new Error('PE export target is outside the image.');
        if (forwarded) string(address);
        exports.push({ name, rva: address, forwarded });
      }
    }
  }
  const byName = new Map(exports.map((entry) => [entry.name, entry]));
  const buildIdExport = byName.get('ElectronGameOverlayReShadeAddonBuildId');
  const abiExport = byName.get('ElectronGameOverlayReShadeAddonAbi');
  let addon;
  if (buildIdExport || abiExport) {
    if (!buildIdExport || !abiExport || buildIdExport.forwarded || abiExport.forwarded) throw new Error('Incomplete or forwarded EGO add-on identity.');
    const buildIdOffset = rva(buildIdExport.rva, 33);
    const buildId = image.toString('ascii', buildIdOffset, buildIdOffset + 32);
    const abi = u32(rva(abiExport.rva, 4));
    if (!/^[0-9A-Fa-f]{32}$/.test(buildId) || image[buildIdOffset + 32] !== 0 || abi === 0) throw new Error('Invalid EGO add-on build ID or ABI.');
    addon = { buildId, abi };
  }
  const reshade = byName.get('ReShadeVersion');
  if (reshade?.forwarded) throw new Error('Forwarded ReShade identity cannot establish a runtime module.');
  return { machine, architecture, exports: exports.sort((a, b) => compare(a.name, b.name)), addon, isReShade: Boolean(reshade) };
}

function jsonFile(filename) {
  return JSON.parse(readFile(filename, MAX_JSON_BYTES).data.toString('utf8').replace(/^\uFEFF/u, ''));
}

function collectSdkEvidence(sdkDist, options = {}) {
  if (typeof sdkDist !== 'string' || !path.isAbsolute(sdkDist)) throw new Error('SDK dist must be an absolute directory.');
  const canonical = fs.realpathSync(sdkDist);
  if (!fs.statSync(canonical).isDirectory()) throw new Error('SDK dist must be a directory.');
  const entry = readFile(path.join(canonical, 'index.js'));
  const packageJson = jsonFile(path.join(path.dirname(canonical), 'package.json'));
  if (packageJson.name !== 'electron-game-overlay' || typeof packageJson.version !== 'string' || !packageJson.version) throw new Error('Unexpected SDK package identity.');
  const runtimeDirectory = path.join(canonical, 'runtime', 'win32-x64', 'reshade');
  const manifestPath = path.join(runtimeDirectory, 'electron_game_overlay_runtime.build.json');
  const manifest = jsonFile(manifestPath);
  if (manifest.schemaVersion !== 4 || manifest.kind !== 'electron-game-overlay-runtime-build' || manifest.platform !== 'win32-x64' || !/^[A-Fa-f0-9]{64}$/.test(manifest.addonSha256 || '') || !/^[A-Fa-f0-9]{32}$/.test(manifest.addonBuildId || '') || typeof manifest.reshadeRuntimeSha256 !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(manifest.reshadeRuntimeSha256)) throw new Error('Invalid x64 SDK runtime manifest.');
  const native = readFile(path.join(runtimeDirectory, 'electron_game_overlay.addon64'));
  const nativeHash = hash(native.data);
  const image = inspectPe(native.data);
  if (image.architecture !== 'x64' || !image.addon || image.isReShade || nativeHash !== manifest.addonSha256.toLowerCase() || image.addon.buildId !== manifest.addonBuildId) throw new Error('SDK add-on bytes or exported identity do not match its manifest.');
  const javascript = [];
  let totalBytes = 0;
  function walk(directory, depth = 0) {
    if (depth > 24) throw new Error('SDK JavaScript graph depth is out of bounds.');
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      const filename = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('SDK JavaScript graph contains a symbolic link.');
      if (item.isDirectory()) walk(filename, depth + 1);
      else if (item.isFile() && item.name.endsWith('.js')) {
        const source = readFile(filename, 32 * 1024 * 1024);
        totalBytes += source.data.length;
        if (javascript.length >= 10000 || totalBytes > 128 * 1024 * 1024) throw new Error('SDK JavaScript graph size is out of bounds.');
        javascript.push({ path: path.relative(canonical, source.path).split(path.sep).join('/'), bytes: source.data.length, sha256: hash(source.data) });
      }
    }
  }
  walk(canonical);
  javascript.sort((a, b) => compare(a.path, b.path));
  if (options.sourceRevision !== undefined && !/^[0-9A-Fa-f]{40}$/.test(options.sourceRevision)) throw new Error('Source revision must be a 40-character informational commit ID.');
  return {
    sdkDist: canonical,
    packageVersion: packageJson.version,
    sourceRevision: options.sourceRevision || null,
    sourceRevisionMeaning: 'Informational caller claim; hashes identify observed bytes, not released-package provenance.',
    entrySha256: hash(entry.data),
    javascriptGraphSha256: hash(JSON.stringify(javascript)),
    javascript,
    addon: { path: native.path, sha256: nativeHash, bytes: native.data.length, ...image.addon },
    runtimeManifest: { path: fs.realpathSync(manifestPath), sha256: hash(readFile(manifestPath, MAX_JSON_BYTES).data), schemaVersion: manifest.schemaVersion, runtimeGeneration: manifest.runtimeGeneration, targetTransportMin: manifest.targetTransportMin, targetTransportMax: manifest.targetTransportMax, reshadeRuntimeSha256: manifest.reshadeRuntimeSha256.toLowerCase() },
  };
}

function inspectMappedModules(moduleRecords) {
  if (!Array.isArray(moduleRecords) || moduleRecords.length === 0 || moduleRecords.length > 2048) throw new Error('OS module snapshot count is out of bounds.');
  const seen = new Set();
  const runtimes = [];
  const addons = [];
  for (const record of moduleRecords) {
    const filename = typeof record === 'string' ? record : record?.path || record?.FileName;
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('OS module snapshot requires absolute file paths.');
    const file = readFile(filename);
    const identity = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (seen.has(identity)) throw new Error('OS module snapshot repeats a canonical module path.');
    seen.add(identity);
    if (record?.path && record?.FileName && fs.realpathSync(record.path) !== fs.realpathSync(record.FileName)) throw new Error('OS module snapshot has ambiguous path fields.');
    const image = inspectPe(file.data);
    if (image.architecture !== 'x64') throw new Error('Game acceptance module snapshot contains a non-x64 image.');
    if (image.isReShade && image.addon) throw new Error('A module cannot establish both ReShade and EGO add-on identities.');
    const evidence = { path: file.path, sha256: hash(file.data), bytes: file.data.length, machine: image.machine };
    if (image.isReShade) runtimes.push(evidence);
    if (image.addon) addons.push({ ...evidence, ...image.addon });
  }
  if (runtimes.length !== 1) throw new Error(`Expected exactly one mapped ReShade runtime; found ${runtimes.length}.`);
  return { scope: 'Current caller-supplied OS module snapshot plus module-file hashes; not remote-memory or historical injection-count proof.', runtimeCount: 1, runtime: runtimes[0], addons: addons.sort((a, b) => compare(a.path, b.path)) };
}

function expectedAddonKey(candidate) {
  if (!candidate?.addon || !/^[a-f0-9]{64}$/.test(candidate.addon.sha256) || !/^[A-Fa-f0-9]{32}$/.test(candidate.addon.buildId) || !Number.isInteger(candidate.addon.abi) || candidate.addon.abi <= 0) throw new Error('Expected SDK add-on evidence is invalid.');
  return addonKey(candidate.addon);
}

function addonKey(value) {
  return `${value.sha256}:${value.buildId}:${value.abi}`;
}

function validateMappedModules(moduleRecords, sdkEvidenceA, sdkEvidenceB) {
  const expected = [expectedAddonKey(sdkEvidenceA), expectedAddonKey(sdkEvidenceB)].sort();
  const report = inspectMappedModules(moduleRecords);
  const addons = report.addons;
  if (addons.length !== 2) throw new Error(`Expected exactly two mapped EGO add-on modules; found ${addons.length}.`);
  const actual = addons.map(addonKey).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Mapped EGO add-on bytes/identities do not match the two supplied SDKs.');
  return report;
}

function validateMappedSurvivor(moduleRecords, survivorEvidence, retiredEvidence) {
  const survivor = expectedAddonKey(survivorEvidence);
  const retired = expectedAddonKey(retiredEvidence);
  const report = inspectMappedModules(moduleRecords);
  if (report.addons.length < 1 || report.addons.length > 2) throw new Error(`Expected one surviving and at most one retired EGO module; found ${report.addons.length}.`);
  const remaining = new Map();
  for (const key of [survivor, retired]) remaining.set(key, (remaining.get(key) || 0) + 1);
  let survivors = 0;
  for (const entry of report.addons) {
    const key = addonKey(entry);
    if (!remaining.get(key)) throw new Error('Survivor snapshot contains an unknown, changed or excess EGO add-on module.');
    remaining.set(key, remaining.get(key) - 1);
    if (key === survivor) survivors++;
  }
  if (!survivors) throw new Error('Survivor SDK add-on identity is absent from the module snapshot.');
  return { ...report, survivorBuildMatchingModules: survivors, retiredBuildStillMapped: survivor === retired ? null : report.addons.some((entry) => addonKey(entry) === retired), survivorIdentityScope: 'Build identity only. When both apps use identical native bytes, scene/input evidence must establish the live participant; retired code may remain mapped safely.' };
}

function main(args) {
  const allowed = new Set(['--sdk', '--sdk-a', '--sdk-b', '--modules-json', '--output', '--source-revision', '--source-revision-a', '--source-revision-b', '--survivor']);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || Object.hasOwn(options, args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Invalid evidence CLI arguments.');
    options[args[index]] = args[index + 1];
  }
  let report;
  if (options['--sdk']) {
    if (options['--sdk-a'] || options['--sdk-b'] || options['--modules-json'] || options['--source-revision-a'] || options['--source-revision-b'] || options['--survivor']) throw new Error('SDK collection and module validation modes cannot be combined.');
    report = { schemaVersion: 1, status: 'collected', nativeExecuted: false, sdk: collectSdkEvidence(options['--sdk'], { sourceRevision: options['--source-revision'] }) };
  } else {
    if (!options['--sdk-a'] || !options['--sdk-b'] || !options['--modules-json'] || options['--source-revision']) throw new Error('Module validation requires --sdk-a, --sdk-b and --modules-json.');
    if (options['--survivor'] && !['a', 'b'].includes(options['--survivor'])) throw new Error('--survivor must name a or b.');
    const a = collectSdkEvidence(options['--sdk-a'], { sourceRevision: options['--source-revision-a'] });
    const b = collectSdkEvidence(options['--sdk-b'], { sourceRevision: options['--source-revision-b'] });
    const modules = jsonFile(path.resolve(options['--modules-json']));
    const mapped = options['--survivor'] ? validateMappedSurvivor(modules, options['--survivor'] === 'a' ? a : b, options['--survivor'] === 'a' ? b : a) : validateMappedModules(modules, a, b);
    report = { schemaVersion: 1, status: 'validated', nativeExecuted: false, phase: options['--survivor'] ? 'survivor' : 'both-apps', survivor: options['--survivor'] || null, sdkA: a, sdkB: b, implementationComparison: { sameJavascriptGraph: a.javascriptGraphSha256 === b.javascriptGraphSha256, sameNativeAddon: a.addon.sha256 === b.addon.sha256, independentlyReleasedPackagesVerified: false }, mapped };
  }
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options['--output']) fs.writeFileSync(path.resolve(options['--output']), json, { flag: 'wx' });
  return report;
}

module.exports = { inspectPe, collectSdkEvidence, validateMappedModules, validateMappedSurvivor, main };
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
