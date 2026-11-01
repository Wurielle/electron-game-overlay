'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { collectSdkEvidence } = require('../scripts/cooperative-game-evidence.cjs');
const helper = require('../scripts/cooperative-resource-soak-evidence.cjs');
const helperPath = path.resolve(__dirname, '../scripts/cooperative-resource-soak-evidence.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const buildId = '0123456789ABCDEF0123456789ABCDEF';

// Inert file-layout PE records for parser checks. These bytes are never loaded
// or executed and do not establish SDK/native process acceptance.
function pe(entries = [], architecture = 'x64') {
  const image = Buffer.alloc(0x1200);
  image.write('MZ'); image.writeUInt32LE(128, 60); image.write('PE\0\0', 128);
  image.writeUInt16LE(architecture === 'x64' ? 0x8664 : 0x14c, 132); image.writeUInt16LE(1, 134);
  const optional = 152, size = architecture === 'x64' ? 240 : 224, directories = architecture === 'x64' ? 112 : 96;
  image.writeUInt16LE(size, 148); image.writeUInt16LE(architecture === 'x64' ? 0x20b : 0x10b, optional);
  image.writeUInt32LE(0x200, optional + 60); image.writeUInt32LE(16, optional + directories - 4);
  const section = optional + size;
  image.write('.rdata', section); image.writeUInt32LE(0x1000, section + 8); image.writeUInt32LE(0x1000, section + 12); image.writeUInt32LE(0x1000, section + 16); image.writeUInt32LE(0x200, section + 20);
  if (!entries.length) return image;
  image.writeUInt32LE(0x1000, optional + directories); image.writeUInt32LE(0x300, optional + directories + 4);
  image.writeUInt32LE(entries.length, 0x200 + 20); image.writeUInt32LE(entries.length, 0x200 + 24);
  image.writeUInt32LE(0x1040, 0x200 + 28); image.writeUInt32LE(0x1080, 0x200 + 32); image.writeUInt32LE(0x10c0, 0x200 + 36);
  let nameRva = 0x1100;
  entries.forEach((entry, index) => {
    const target = 0x1400 + index * 0x80;
    image.writeUInt32LE(target, 0x240 + index * 4); image.writeUInt32LE(nameRva, 0x280 + index * 4); image.writeUInt16LE(index, 0x2c0 + index * 2);
    image.write(entry.name + '\0', nameRva - 0xe00);
    if (entry.data) Buffer.from(entry.data).copy(image, target - 0xe00);
    nameRva += Buffer.byteLength(entry.name) + 1;
  });
  return image;
}
function addon() {
  const integer = Buffer.alloc(4); integer.writeUInt32LE(1);
  return pe([{ name: 'ElectronGameOverlayReShadeAddonBuildId', data: buildId + '\0' }, { name: 'ElectronGameOverlayReShadeAddonAbi', data: integer }]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-soak-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'package', 'dist'), runtimeDirectory = path.join(dist, 'runtime', 'win32-x64', 'reshade');
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, 'package', 'package.json'), JSON.stringify({ name: 'electron-game-overlay', version: '0.1.0-unreleased-fixture' }));
  fs.writeFileSync(path.join(dist, 'index.js'), 'module.exports = {};\n');
  const addonBytes = addon(), runtimeBytes = pe([{ name: 'ReShadeVersion', data: Buffer.alloc(8) }]);
  fs.writeFileSync(path.join(runtimeDirectory, 'electron_game_overlay.addon64'), addonBytes);
  fs.writeFileSync(path.join(runtimeDirectory, 'electron_game_overlay_runtime.build.json'), JSON.stringify({ schemaVersion: 4, kind: 'electron-game-overlay-runtime-build', platform: 'win32-x64', addonSha256: sha(addonBytes), addonBuildId: buildId, reshadeRuntimeSha256: sha(runtimeBytes), runtimeGeneration: 11, targetTransportMin: 1, targetTransportMax: 1 }));
  const mapped = path.join(root, 'mapped'); fs.mkdirSync(mapped);
  const runtime = path.join(mapped, 'host.dll'); fs.writeFileSync(runtime, runtimeBytes);
  const ordinary = path.join(mapped, 'ordinary.dll'); fs.writeFileSync(ordinary, pe([{ name: 'OrdinaryFunction' }]));
  const stages = [];
  for (let cycle = 1; cycle <= 3; cycle++) {
    const stage = path.join(mapped, `cycle-${cycle}`); fs.mkdirSync(stage);
    const filename = path.join(stage, 'electron_game_overlay.addon64'); fs.writeFileSync(filename, addonBytes);
    stages.push({ path: filename, sha256: sha(addonBytes), bytes: addonBytes.length, abi: 1, buildId });
  }
  const records = [runtime, ordinary, ...stages.map(value => value.path)].map(FileName => ({ FileName }));
  return { root, dist, runtime, runtimeBytes, ordinary, stages, records, evidence: collectSdkEvidence(dist) };
}

test('validates cumulative pinned fresh-stage identities and one exact SDK runtime without package-version admission', t => {
  const f = fixture(t);
  const report = helper.validatePinnedAddons(f.records, f.stages, f.evidence);
  assert.equal(report.runtimeCount, 1);
  assert.equal(report.expectedPinnedAddonCount, 3);
  assert.equal(report.addons.length, 3);
  assert.equal(report.exactPinnedStageIdentities, true);
  assert.equal(report.runtime.sha256, f.evidence.runtimeManifest.reshadeRuntimeSha256);
  assert.match(report.scope, /no remote-memory or historical injection-count proof/u);
  assert.doesNotThrow(() => helper.validatePinnedAddons(f.records, f.stages, { ...f.evidence, packageVersion: '99.0.0-informational-only' }));
  assert.doesNotThrow(() => helper.validatePinnedAddons(f.records, f.stages.map(value => ({ ...value, sha256: value.sha256.toUpperCase(), buildId: value.buildId.toLowerCase() })), f.evidence));
});

test('rejects missing, unknown, duplicate and excess modules even when all native bytes are identical', t => {
  const f = fixture(t);
  assert.throws(() => helper.validatePinnedAddons(f.records.slice(0, -1), f.stages, f.evidence), /exactly 3/u);
  const unknown = path.join(f.root, 'unknown-stage.addon64'); fs.copyFileSync(f.stages[2].path, unknown);
  assert.throws(() => helper.validatePinnedAddons([...f.records.slice(0, -1), unknown], f.stages, f.evidence), /expected pinned stage/u);
  assert.throws(() => helper.validatePinnedAddons([...f.records, unknown], f.stages, f.evidence), /exactly 3/u);
  assert.throws(() => helper.validatePinnedAddons([...f.records, f.records[0]], f.stages, f.evidence), /repeats/u);
  assert.throws(() => helper.validatePinnedAddons(f.records, [f.stages[0], { ...f.stages[0], path: path.join(path.dirname(f.stages[0].path), '.', path.basename(f.stages[0].path)) }], f.evidence), /repeat/u);
  assert.throws(() => helper.validatePinnedAddons(f.records, f.stages.map((value, index) => index ? value : { ...value, sha256: '0'.repeat(64) }), f.evidence), /supplied SDK/u);
  assert.throws(() => helper.validatePinnedAddons(f.records, f.stages.map((value, index) => index ? value : { ...value, abi: 2 }), f.evidence), /supplied SDK/u);
});

test('rejects changed backing files, runtime mismatch and ambiguous or nonregular snapshot paths', t => {
  const f = fixture(t);
  const changed = fs.readFileSync(f.stages[0].path); changed[changed.length - 1] = 1; fs.writeFileSync(f.stages[0].path, changed);
  assert.throws(() => helper.validatePinnedAddons(f.records, f.stages, f.evidence), /bytes or exported identity/u);
  fs.writeFileSync(f.stages[0].path, addon());
  fs.appendFileSync(f.runtime, Buffer.from([1]));
  assert.throws(() => helper.validatePinnedAddons(f.records, f.stages, f.evidence), /runtime hash/u);
  fs.writeFileSync(f.runtime, f.runtimeBytes);
  const secondRuntime = path.join(f.root, 'other-host.dll'); fs.writeFileSync(secondRuntime, f.runtimeBytes);
  assert.throws(() => helper.validatePinnedAddons([...f.records, secondRuntime], f.stages, f.evidence), /exactly one/u);
  assert.throws(() => helper.validatePinnedAddons(f.records.slice(1), f.stages, f.evidence), /exactly one/u);
  assert.throws(() => helper.inspectModuleSnapshot([{ path: f.runtime, FileName: f.ordinary }]), /ambiguous/u);
  assert.throws(() => helper.inspectModuleSnapshot(['relative.dll']), /absolute/u);
  assert.throws(() => helper.inspectModuleSnapshot([f.root]), /regular/u);
});

test('bounds module/file counts and rejects malformed or non-x64 images', t => {
  const f = fixture(t);
  assert.throws(() => helper.inspectModuleSnapshot([]), /count/u);
  assert.throws(() => helper.inspectModuleSnapshot(Array(helper.MAX_MODULES + 1).fill(f.runtime)), /count/u);
  assert.throws(() => helper.validatePinnedAddons(f.records, [], f.evidence), /count/u);
  const image = path.join(f.root, 'invalid.dll'); fs.writeFileSync(image, 'not a PE');
  assert.throws(() => helper.inspectModuleSnapshot([image]));
  fs.writeFileSync(image, pe([], 'x86'));
  assert.throws(() => helper.inspectModuleSnapshot([image]), /x64/u);
  fs.truncateSync(image, 128 * 1024 * 1024 + 1);
  assert.throws(() => helper.inspectModuleSnapshot([image]), /size/u);
});

test('CLI validates current files into a new report and rejects partial, relative or duplicate options', t => {
  const f = fixture(t);
  const modulesPath = path.join(f.root, 'modules.json'), expectedPath = path.join(f.root, 'expected.json'), output = path.join(f.root, 'report.json');
  fs.writeFileSync(modulesPath, '\uFEFF' + JSON.stringify(f.records)); fs.writeFileSync(expectedPath, JSON.stringify(f.stages));
  const argv = ['--sdk', f.dist, '--modules-json', modulesPath, '--expected-json', expectedPath, '--output', output];
  const result = spawnSync(process.execPath, [helperPath, ...argv], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(output));
  assert.equal(report.status, 'validated'); assert.equal(report.nativeExecuted, false); assert.equal(report.mapped.expectedPinnedAddonCount, 3);
  assert.match(report.scope, /Current caller-supplied OS module snapshot/u);
  assert.throws(() => helper.main(argv), /EEXIST/u);
  assert.throws(() => helper.main(argv.slice(0, -2)), /requires/u);
  assert.throws(() => helper.main([...argv, '--sdk', f.dist]), /unique/u);
  assert.throws(() => helper.main(['--sdk', 'relative', ...argv.slice(2)]), /absolute/u);
});
