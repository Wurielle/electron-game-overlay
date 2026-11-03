'use strict';

// Read-only proof of one current caller-supplied OS module snapshot and its
// backing files. This neither loads native code nor reads target memory.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inspectPe, collectSdkEvidence } = require('./cooperative-game-evidence.cjs');

const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_MODULES = 2048;
const SCOPE = 'Current caller-supplied OS module snapshot and backing-file hashes only; no remote-memory or historical injection-count proof.';
const sha = value => createHash('sha256').update(value).digest('hex');
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

function readFile(filename, maximum = MAX_IMAGE_BYTES) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')) throw new Error('Resource-soak evidence paths must be absolute.');
  if (!fs.lstatSync(filename).isFile()) throw new Error('Resource-soak evidence input must be a regular file.');
  const canonical = fs.realpathSync(filename);
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximum) throw new Error('Resource-soak evidence file size is out of bounds.');
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
      if (!count) throw new Error('Resource-soak evidence file changed while reading.');
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || fs.realpathSync(filename) !== canonical) throw new Error('Resource-soak evidence file changed while reading.');
    return { path: canonical, data };
  } finally { fs.closeSync(descriptor); }
}

function readJson(filename) {
  return JSON.parse(readFile(filename, MAX_JSON_BYTES).data.toString('utf8').replace(/^\uFEFF/u, ''));
}

function inspectModuleSnapshot(records) {
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_MODULES) throw new Error('Resource-soak OS module snapshot count is out of bounds.');
  const seen = new Set(), runtimes = [], addons = [];
  for (const record of records) {
    const filename = typeof record === 'string' ? record : record?.path || record?.FileName;
    const file = readFile(filename);
    const identity = pathKey(file.path);
    if (seen.has(identity)) throw new Error('Resource-soak OS module snapshot repeats a canonical path.');
    seen.add(identity);
    if (record?.path && record?.FileName && pathKey(fs.realpathSync(record.path)) !== pathKey(fs.realpathSync(record.FileName))) throw new Error('Resource-soak OS module snapshot has ambiguous path fields.');
    const image = inspectPe(file.data);
    if (image.architecture !== 'x64') throw new Error('Resource-soak SDK acceptance requires an x64 module snapshot.');
    if (image.isReShade && image.addon) throw new Error('One module cannot establish both ReShade and EGO identities.');
    if (!image.isReShade && !image.addon) continue;
    const evidence = { path: file.path, sha256: sha(file.data), bytes: file.data.length, machine: image.machine };
    if (image.isReShade) runtimes.push(evidence);
    if (image.addon) addons.push({ ...evidence, ...image.addon });
  }
  if (runtimes.length !== 1) throw new Error(`Expected exactly one mapped ReShade runtime; found ${runtimes.length}.`);
  return { scope: SCOPE, moduleCount: records.length, runtimeCount: 1, runtime: runtimes[0], addons: addons.sort((a, b) => pathKey(a.path).localeCompare(pathKey(b.path))) };
}

function validatePinnedAddons(moduleRecords, expected, sdkEvidence) {
  if (!Array.isArray(expected) || expected.length < 1 || expected.length > MAX_MODULES) throw new Error('Expected pinned add-on count is out of bounds.');
  if (!sdkEvidence?.addon || !/^[a-f0-9]{64}$/u.test(sdkEvidence.addon.sha256 || '') || !/^[a-f0-9]{64}$/u.test(sdkEvidence.runtimeManifest?.reshadeRuntimeSha256 || '')) throw new Error('Supplied SDK evidence is invalid.');
  const expectedByPath = new Map();
  for (const value of expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.path !== 'string' || !path.isAbsolute(value.path) || value.path.includes('\0') || !/^[a-f0-9]{64}$/iu.test(value.sha256 || '') || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_IMAGE_BYTES || !Number.isInteger(value.abi) || value.abi < 1 || value.abi > 0xffffffff || !/^[a-f0-9]{32}$/iu.test(value.buildId || '')) throw new Error('Expected pinned add-on identity is malformed.');
    if (!fs.lstatSync(value.path).isFile()) throw new Error('Expected pinned add-on must be a regular file.');
    const canonical = fs.realpathSync(value.path), key = pathKey(canonical);
    if (expectedByPath.has(key)) throw new Error('Expected pinned add-ons repeat a canonical path.');
    if (value.sha256.toLowerCase() !== sdkEvidence.addon.sha256 || value.bytes !== sdkEvidence.addon.bytes || value.abi !== sdkEvidence.addon.abi || value.buildId.toUpperCase() !== sdkEvidence.addon.buildId.toUpperCase()) throw new Error('Expected pinned add-on does not match the supplied SDK bytes and identity.');
    expectedByPath.set(key, { path: canonical, sha256: value.sha256.toLowerCase(), bytes: value.bytes, abi: value.abi, buildId: value.buildId.toUpperCase() });
  }
  const mapped = inspectModuleSnapshot(moduleRecords);
  if (mapped.runtime.sha256 !== sdkEvidence.runtimeManifest.reshadeRuntimeSha256) throw new Error('The mapped ReShade runtime hash differs from the supplied SDK manifest.');
  if (mapped.addons.length !== expected.length) throw new Error(`Expected exactly ${expected.length} mapped pinned EGO add-ons; found ${mapped.addons.length}.`);
  for (const addon of mapped.addons) {
    const identity = expectedByPath.get(pathKey(addon.path));
    if (!identity || addon.sha256 !== identity.sha256 || addon.bytes !== identity.bytes || addon.abi !== identity.abi || addon.buildId.toUpperCase() !== identity.buildId) throw new Error('Mapped EGO add-on path, bytes or exported identity differs from the expected pinned stage.');
    expectedByPath.delete(pathKey(addon.path));
  }
  if (expectedByPath.size !== 0) throw new Error('An expected pinned EGO stage is absent from the current module snapshot.');
  return { ...mapped, expectedPinnedAddonCount: expected.length, exactPinnedStageIdentities: true, expectedIdentityMeaning: 'Each fresh stage matches the supplied SDK native bytes; package-version equality is not an admission rule.' };
}

function main(argv) {
  const allowed = new Set(['--sdk', '--modules-json', '--expected-json', '--output']);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowed.has(key) || Object.hasOwn(options, key) || typeof value !== 'string' || value.startsWith('--') || !path.isAbsolute(value) || value.includes('\0')) throw new Error('Resource-soak evidence CLI requires unique options with absolute paths.');
    options[key] = value;
  }
  if (Object.keys(options).length !== allowed.size) throw new Error('Resource-soak evidence requires --sdk, --modules-json, --expected-json and --output.');
  const sdkEvidence = collectSdkEvidence(options['--sdk']);
  const mapped = validatePinnedAddons(readJson(options['--modules-json']), readJson(options['--expected-json']), sdkEvidence);
  const report = {
    schemaVersion: 1, status: 'validated', nativeExecuted: false, scope: SCOPE,
    sdk: { sdkDist: sdkEvidence.sdkDist, packageVersion: sdkEvidence.packageVersion, javascriptGraphSha256: sdkEvidence.javascriptGraphSha256, addon: sdkEvidence.addon, runtimeManifest: sdkEvidence.runtimeManifest },
    mapped,
  };
  fs.writeFileSync(options['--output'], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

module.exports = { MAX_MODULES, inspectModuleSnapshot, validatePinnedAddons, main };
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
