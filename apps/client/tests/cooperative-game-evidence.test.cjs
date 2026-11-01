'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const helperPath = path.resolve(__dirname, '../scripts/cooperative-game-evidence.cjs');
const { inspectPe, collectSdkEvidence, validateMappedModules, validateMappedSurvivor, main } = require(helperPath);
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const idA = '0123456789ABCDEF0123456789ABCDEF';
const idB = 'FEDCBA9876543210FEDCBA9876543210';

// Synthetic file-layout PE images; never executable native acceptance inputs.
function pe(entries = [], architecture = 'x64') {
  const image = Buffer.alloc(0x1200);
  image.write('MZ'); image.writeUInt32LE(128, 60); image.write('PE\0\0', 128);
  image.writeUInt16LE(architecture === 'x64' ? 0x8664 : 0x14c, 132);
  image.writeUInt16LE(1, 134);
  const optional = 152;
  const size = architecture === 'x64' ? 240 : 224;
  const directories = architecture === 'x64' ? 112 : 96;
  image.writeUInt16LE(size, 148);
  image.writeUInt16LE(architecture === 'x64' ? 0x20b : 0x10b, optional);
  image.writeUInt32LE(0x200, optional + 60);
  image.writeUInt32LE(16, optional + directories - 4);
  const section = optional + size;
  image.write('.rdata', section);
  image.writeUInt32LE(0x1000, section + 8);
  image.writeUInt32LE(0x1000, section + 12);
  image.writeUInt32LE(0x1000, section + 16);
  image.writeUInt32LE(0x200, section + 20);
  if (!entries.length) return image;
  image.writeUInt32LE(0x1000, optional + directories);
  image.writeUInt32LE(0x300, optional + directories + 4);
  image.writeUInt32LE(entries.length, 0x200 + 20);
  image.writeUInt32LE(entries.length, 0x200 + 24);
  image.writeUInt32LE(0x1040, 0x200 + 28);
  image.writeUInt32LE(0x1080, 0x200 + 32);
  image.writeUInt32LE(0x10c0, 0x200 + 36);
  let nameRva = 0x1100;
  entries.forEach((entry, index) => {
    const target = entry.forwarded ? 0x1280 : 0x1400 + index * 0x80;
    image.writeUInt32LE(target, 0x240 + index * 4);
    image.writeUInt32LE(nameRva, 0x280 + index * 4);
    image.writeUInt16LE(index, 0x2c0 + index * 2);
    image.write(entry.name + '\0', nameRva - 0xe00);
    if (entry.forwarded) image.write('KERNEL32.Forwarded\0', target - 0xe00);
    else if (entry.data) Buffer.from(entry.data).copy(image, target - 0xe00);
    nameRva += Buffer.byteLength(entry.name) + 1;
  });
  return image;
}

function addon(buildId = idA, architecture = 'x64', abi = 1) {
  const integer = Buffer.alloc(4); integer.writeUInt32LE(abi);
  return pe([
    { name: 'ElectronGameOverlayReShadeAddonBuildId', data: buildId + '\0' },
    { name: 'ElectronGameOverlayReShadeAddonAbi', data: integer },
  ], architecture);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-game-evidence-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  function sdk(name, native = addon(), version = '0.1.0-test') {
    const base = path.join(root, name);
    const dist = path.join(base, 'dist');
    const runtime = path.join(dist, 'runtime/win32-x64/reshade');
    fs.mkdirSync(runtime, { recursive: true });
    fs.mkdirSync(path.join(dist, 'lib'));
    fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'electron-game-overlay', version }));
    fs.writeFileSync(path.join(dist, 'index.js'), "module.exports = require('./lib/engine.js');\n");
    fs.writeFileSync(path.join(dist, 'lib/engine.js'), 'module.exports = { feature: true };\n');
    fs.writeFileSync(path.join(runtime, 'electron_game_overlay.addon64'), native);
    const buildId = inspectPe(native).addon.buildId;
    fs.writeFileSync(path.join(runtime, 'electron_game_overlay_runtime.build.json'), JSON.stringify({ schemaVersion: 4, kind: 'electron-game-overlay-runtime-build', platform: 'win32-x64', addonSha256: sha(native), addonBuildId: buildId, reshadeRuntimeSha256: sha(pe([{ name: 'ReShadeVersion', data: Buffer.alloc(8) }])), runtimeGeneration: 7, targetTransportMin: 1, targetTransportMax: 1 }));
    return { base, dist, runtime, native: path.join(runtime, 'electron_game_overlay.addon64'), manifest: path.join(runtime, 'electron_game_overlay_runtime.build.json') };
  }
  function mapped(a, b) {
    const directory = path.join(root, 'mapped-' + crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(directory);
    const runtime = path.join(directory, 'unrelated-name.dll');
    const appA = path.join(directory, 'engine-for-a.bin');
    const appB = path.join(directory, 'engine-for-b.bin');
    const osModule = path.join(directory, 'ordinary-system.dll');
    fs.writeFileSync(runtime, pe([{ name: 'ReShadeVersion', data: Buffer.alloc(8) }]));
    fs.copyFileSync(a.native, appA); fs.copyFileSync(b.native, appB);
    fs.writeFileSync(osModule, pe([{ name: 'OrdinaryFunction', data: Buffer.from([0xc3]) }]));
    return { runtime, appA, appB, osModule, records: [runtime, appA, appB, osModule].map((filename) => ({ FileName: filename })) };
  }
  return { root, sdk, mapped };
}

test('identifies runtime and exact add-on exports independently of filenames', () => {
  assert.equal(inspectPe(pe([{ name: 'ReShadeVersion', data: Buffer.alloc(8) }])).isReShade, true);
  assert.deepEqual(inspectPe(addon()).addon, { buildId: idA, abi: 1 });
  assert.equal(inspectPe(addon(idB, 'x86', 2)).architecture, 'x86');
  assert.equal(inspectPe(pe()).isReShade, false);
  assert.equal(inspectPe(pe([{ name: 'OrdinaryFunction', forwarded: true }])).exports[0].forwarded, true);
});

test('bounds malformed PE sections, export tables, ordinals, strings and EGO data', () => {
  const mutations = [
    (b) => b.writeUInt32LE(0xfffffff0, 60),
    (b) => b.writeUInt16LE(97, 134),
    (b) => b.writeUInt16LE(0xaa64, 132),
    (b) => b.writeUInt32LE(0x10000, 152 + 112 + 4),
    (b) => b.writeUInt32LE(65537, 0x200 + 20),
    (b) => b.writeUInt32LE(0xfffffff0, 0x200 + 32),
    (b) => b.writeUInt16LE(9, 0x2c0),
    (b) => b.writeUInt32LE(b.readUInt32LE(0x280), 0x284),
    (b) => b.writeUInt32LE(0x1fff, 0x280),
    (b) => b.write('not-an-exact-id', 0x600),
    (b) => b.writeUInt8(1, 0x620),
    (b) => b.writeUInt32LE(0, 0x680),
    (b) => { b.writeUInt32LE(0x1280, 0x240); b.write('KERNEL32.Forwarded\0', 0x480); },
  ];
  for (const mutate of mutations) { const candidate = addon(); mutate(candidate); assert.throws(() => inspectPe(candidate)); }
  assert.throws(() => inspectPe(pe([{ name: 'ElectronGameOverlayReShadeAddonAbi', data: Buffer.from([1, 0, 0, 0]) }])), /Incomplete/);
  assert.throws(() => inspectPe(Buffer.from('MZ')), /bounds/);
  assert.throws(() => inspectPe(pe([{ name: 'ReShadeVersion', forwarded: true }])), /Forwarded ReShade/);
});

test('allows valid aliases and zero-filled exported data without treating it as file-backed identity', () => {
  const candidate = pe([{ name: 'First' }, { name: 'Alias' }]);
  candidate.writeUInt32LE(1, 0x200 + 20);
  candidate.writeUInt16LE(0, 0x2c2);
  candidate.writeUInt32LE(0x2000, 392 + 8);
  candidate.writeUInt32LE(0x2800, 0x240);
  assert.equal(inspectPe(candidate).exports.length, 2);
  const zeroFilledIdentity = addon();
  zeroFilledIdentity.writeUInt32LE(0x2000, 392 + 8);
  zeroFilledIdentity.writeUInt32LE(0x2800, 0x240);
  assert.throws(() => inspectPe(zeroFilledIdentity), /RVA/);
});

test('collects source-sensitive JavaScript/native evidence without inventing release provenance', (t) => {
  const f = fixture(t), a = f.sdk('a');
  const first = collectSdkEvidence(a.dist, { sourceRevision: 'a'.repeat(40) });
  assert.equal(first.packageVersion, '0.1.0-test');
  assert.equal(first.addon.sha256, sha(fs.readFileSync(a.native)));
  assert.equal(first.addon.buildId, idA);
  assert.deepEqual(first.javascript.map((value) => value.path), ['index.js', 'lib/engine.js']);
  fs.writeFileSync(path.join(a.base, 'package.json'), JSON.stringify({ name: 'electron-game-overlay', version: '99.0.0' }));
  assert.equal(collectSdkEvidence(a.dist).javascriptGraphSha256, first.javascriptGraphSha256, 'Changing only version metadata does not create a different implementation.');
  fs.appendFileSync(path.join(a.dist, 'lib/engine.js'), '// independent implementation change\n');
  assert.notEqual(collectSdkEvidence(a.dist).javascriptGraphSha256, first.javascriptGraphSha256);
  assert.equal(collectSdkEvidence(a.dist).sourceRevision, null);
  assert.throws(() => collectSdkEvidence(a.dist, { sourceRevision: 'claimed-release' }), /40-character/);
  assert.throws(() => collectSdkEvidence('relative/dist'), /absolute/);
});

test('rejects SDK manifest/hash/build-ID/architecture mismatches and oversized native inputs', (t) => {
  const f = fixture(t), a = f.sdk('a');
  const original = JSON.parse(fs.readFileSync(a.manifest));
  for (const rewrite of [
    (m) => ({ ...m, schemaVersion: 3 }),
    (m) => ({ ...m, platform: 'win32-ia32' }),
    (m) => ({ ...m, addonSha256: '0'.repeat(64) }),
    (m) => ({ ...m, addonBuildId: idB }),
  ]) {
    fs.writeFileSync(a.manifest, JSON.stringify(rewrite(original)));
    assert.throws(() => collectSdkEvidence(a.dist));
  }
  fs.writeFileSync(a.manifest, JSON.stringify(original));
  const b = f.sdk('b', addon(idA, 'x86'));
  assert.throws(() => collectSdkEvidence(b.dist), /bytes or exported identity/);
  fs.truncateSync(a.native, 128 * 1024 * 1024 + 1);
  assert.throws(() => collectSdkEvidence(a.dist), /size is out of bounds/);
});

test('normalizes the valid runtime digest case and rejects malformed manifest digests', (t) => {
  const f = fixture(t), a = f.sdk('case-runtime');
  const manifest = JSON.parse(fs.readFileSync(a.manifest));
  fs.writeFileSync(a.manifest, JSON.stringify({ ...manifest, reshadeRuntimeSha256: manifest.reshadeRuntimeSha256.toUpperCase() }));
  assert.equal(collectSdkEvidence(a.dist).runtimeManifest.reshadeRuntimeSha256, manifest.reshadeRuntimeSha256);
  for (const digest of [null, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ['a'.repeat(64)]]) {
    fs.writeFileSync(a.manifest, JSON.stringify({ ...manifest, reshadeRuntimeSha256: digest }));
    assert.throws(() => collectSdkEvidence(a.dist), /Invalid x64 SDK runtime manifest/u);
  }
});

test('validates one runtime and two exact distinct mapped modules, including identical builds', (t) => {
  const f = fixture(t), a = f.sdk('a'), b = f.sdk('b', addon(idB));
  const ea = collectSdkEvidence(a.dist), eb = collectSdkEvidence(b.dist);
  const mapped = f.mapped(a, b);
  const report = validateMappedModules(mapped.records, ea, eb);
  assert.equal(report.runtimeCount, 1); assert.equal(report.addons.length, 2);
  assert.equal(report.runtime.path, fs.realpathSync(mapped.runtime));
  assert.deepEqual(report.addons.map((entry) => entry.buildId).sort(), [idA, idB].sort());
  const identical = f.mapped(a, a);
  assert.equal(validateMappedModules(identical.records, ea, ea).addons.length, 2);
});

test('rejects duplicate/missing/extra/changed modules and wrong expected SDK pairs', (t) => {
  const f = fixture(t), a = f.sdk('a'), b = f.sdk('b', addon(idB));
  const ea = collectSdkEvidence(a.dist), eb = collectSdkEvidence(b.dist);
  const mapped = f.mapped(a, b);
  assert.throws(() => validateMappedModules([...mapped.records, { path: mapped.appA }], ea, eb), /repeats/);
  assert.throws(() => validateMappedModules(mapped.records.filter((entry) => entry.FileName !== mapped.runtime), ea, eb), /exactly one/);
  assert.throws(() => validateMappedModules(mapped.records.filter((entry) => entry.FileName !== mapped.appB), ea, eb), /exactly two/);
  assert.throws(() => validateMappedModules(mapped.records, ea, ea), /do not match/);
  const another = path.join(path.dirname(mapped.runtime), 'another.dll');
  fs.copyFileSync(mapped.runtime, another);
  assert.throws(() => validateMappedModules([...mapped.records, { path: another }], ea, eb), /exactly one/);
  fs.copyFileSync(mapped.appA, another);
  assert.throws(() => validateMappedModules([...mapped.records, { path: another }], ea, eb), /exactly two/);
  fs.appendFileSync(mapped.appB, Buffer.from([0]));
  assert.throws(() => validateMappedModules(mapped.records, ea, eb), /do not match/);
  assert.throws(() => validateMappedModules([{ path: mapped.runtime, FileName: mapped.appA }], ea, eb), /ambiguous/);
  assert.throws(() => validateMappedModules([], ea, eb), /count/);
});

test('survivor snapshots permit safely retained peer code but require the survivor build', (t) => {
  const f = fixture(t), a = f.sdk('a'), b = f.sdk('b', addon(idB));
  const ea = collectSdkEvidence(a.dist), eb = collectSdkEvidence(b.dist);
  const mapped = f.mapped(a, b);
  const both = validateMappedSurvivor(mapped.records, eb, ea);
  assert.equal(both.survivorBuildMatchingModules, 1);
  assert.equal(both.retiredBuildStillMapped, true);
  const survivorOnly = mapped.records.filter((record) => record.FileName !== mapped.appA);
  assert.equal(validateMappedSurvivor(survivorOnly, eb, ea).retiredBuildStillMapped, false);
  assert.throws(() => validateMappedSurvivor(mapped.records.filter((record) => record.FileName !== mapped.appB), eb, ea), /Survivor SDK.*absent/);
  const unknown = path.join(path.dirname(mapped.runtime), 'unknown.dll');
  fs.writeFileSync(unknown, addon('A'.repeat(32)));
  assert.throws(() => validateMappedSurvivor([...survivorOnly, { path: unknown }], eb, ea), /unknown, changed or excess/);
  assert.throws(() => validateMappedSurvivor([...mapped.records, { path: unknown }], eb, ea), /at most one retired/);
  const changed = Buffer.from(fs.readFileSync(mapped.appB)); changed[changed.length - 1] = 1;
  fs.writeFileSync(mapped.appB, changed);
  assert.throws(() => validateMappedSurvivor(survivorOnly, eb, ea), /unknown, changed or excess/);
});

test('identical-build survivor evidence states its participant-identity limitation', (t) => {
  const f = fixture(t), a = f.sdk('a');
  const evidence = collectSdkEvidence(a.dist), mapped = f.mapped(a, a);
  const both = validateMappedSurvivor(mapped.records, evidence, evidence);
  assert.equal(both.survivorBuildMatchingModules, 2);
  assert.equal(both.retiredBuildStillMapped, null);
  assert.match(both.survivorIdentityScope, /scene\/input evidence/);
  assert.equal(validateMappedSurvivor(mapped.records.filter((entry) => entry.FileName !== mapped.appA), evidence, evidence).survivorBuildMatchingModules, 1);
});

test('CLI records observed identities and byte comparisons, and never overwrites existing output', (t) => {
  const f = fixture(t), a = f.sdk('a'), b = f.sdk('b', addon(idB));
  fs.appendFileSync(path.join(b.dist, 'lib/engine.js'), '// another implementation\n');
  const mapped = f.mapped(a, b);
  const snapshot = path.join(f.root, 'modules.json'), output = path.join(f.root, 'evidence.json');
  fs.writeFileSync(snapshot, JSON.stringify(mapped.records));
  const args = ['--sdk-a', a.dist, '--sdk-b', b.dist, '--modules-json', snapshot, '--output', output];
  const result = spawnSync(process.execPath, [helperPath, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(output));
  assert.equal(report.status, 'validated'); assert.equal(report.nativeExecuted, false);
  assert.deepEqual(report.implementationComparison, { sameJavascriptGraph: false, sameNativeAddon: false, independentlyReleasedPackagesVerified: false });
  assert.throws(() => main(args), /EEXIST/);
  assert.throws(() => main(['--sdk', a.dist, '--sdk-a', b.dist]), /cannot be combined/);
  assert.throws(() => main(['--unexpected', a.dist]), /Invalid evidence CLI/);
  assert.throws(() => main(['--sdk-a', a.dist]), /requires/);
  assert.throws(() => main(['--sdk-a', a.dist, '--sdk-b', b.dist, '--modules-json', snapshot, '--survivor', 'unknown']), /must name a or b/);
  const survivor = main(['--sdk-a', a.dist, '--sdk-b', b.dist, '--modules-json', snapshot, '--survivor', 'b']);
  assert.equal(survivor.phase, 'survivor'); assert.equal(survivor.survivor, 'b');
  assert.equal(survivor.mapped.retiredBuildStillMapped, true);
  const collected = main(['--sdk', a.dist]);
  assert.equal(collected.status, 'collected'); assert.equal(collected.sdk.sourceRevision, null);
});
