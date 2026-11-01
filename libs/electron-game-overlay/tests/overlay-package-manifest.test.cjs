'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { validatorSource } = require('./helpers/source-packaging-loader.cjs');
const {
  createOverlayDistributionManifestSync,
  validateOverlayDistributionSync,
} = require('../dist/lib/overlay-package-manifest.js');
const { writeCooperativeDistribution } = require('./helpers/cooperative-package-fixture.cjs');
const retainedGeneration15 = Object.freeze({ runtimeGeneration: 15, addonBuildId: 'BCE6C5C8746F4300861300B2BDA3594E' });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-direct-seal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const dist = path.join(root, 'dist');
  const payload = writeCooperativeDistribution(dist, options);
  return { root, dist, ...payload, payload };
}
function mutateStamp(f, name, mutate) {
  const relative = 'runtime/win32-x64/reshade/' + name;
  const stamp = JSON.parse(fs.readFileSync(path.join(f.dist, relative), 'utf8'));
  mutate(stamp);
  f.write(relative, JSON.stringify(stamp));
  if (name.startsWith('ReShade')) f.payload.bindNativeHashes();
  f.payload.seal();
}

test('direct SDK seal validates both native architectures without executing an SDK or broker', t => {
  const f = fixture(t);
  f.write('index.js', 'throw new Error("Packaging must never execute the supplied SDK");\n');
  f.write('lib/overlay-broker-protocol.js', fs.readFileSync(path.join(f.dist, 'lib/overlay-broker-protocol.js'), 'utf8') + 'throw new Error("Compiled generation must be read as text, never executed");\n');
  f.write('lib/overlay-package-manifest.js', fs.readFileSync(path.join(f.dist, 'lib/overlay-package-manifest.js'), 'utf8') + 'throw new Error("Incoming validator must be read as data, never executed");\n');
  f.payload.seal();
  const manifest = validateOverlayDistributionSync(f.dist, '0.1.0-rc.7');
  assert.equal(manifest.files.length, f.payload.files.length);
  assert.equal(fs.existsSync(path.join(f.dist, 'broker')), false);
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, manifest.packageVersion), manifest);
  for (const bits of [64, 32]) assert.equal(JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json'))).schemaVersion, 30);
});

for (const [name, mutate, error] of [
  ['compiled module tampering', f => f.write('lib/module.js', 'changed'), /hash|size/i],
  ['undeclared file', f => f.write('lib/undeclared.js', 'extra'), /undeclared/i],
  ['missing dependency notice', f => fs.unlinkSync(path.join(f.dist, 'node_modules/tslib/CopyrightNotice.txt')), /missing|undeclared/i],
  ['package version mismatch', f => { const manifest = f.payload.manifest; manifest.packageVersion = '0.1.0-rc.8'; fs.writeFileSync(f.manifestPath, JSON.stringify(manifest)); }, /manifest/i],
  ['escaping manifest path', f => { const manifest = f.payload.manifest; manifest.files[0].path = '../outside.js'; fs.writeFileSync(f.manifestPath, JSON.stringify(manifest)); }, /path/i],
  ['case-colliding manifest names', f => { const manifest = f.payload.manifest; manifest.files.push({ ...manifest.files[0], path: manifest.files[0].path.toUpperCase() }); manifest.files.sort((a,b) => a.path < b.path ? -1 : 1); fs.writeFileSync(f.manifestPath, JSON.stringify(manifest)); }, /path/i],
  ['oversized declared file', f => { const manifest = f.payload.manifest; manifest.files[0].size = 1024 * 1024 * 1024; fs.writeFileSync(f.manifestPath, JSON.stringify(manifest)); }, /size/i],
  ['standalone broker payload', f => { f.write('broker/win32-x64/old.exe', 'obsolete'); f.payload.seal(); }, /broker/i],
  ['native capability missing after reseal', f => mutateStamp(f, 'electron_game_overlay_runtime.build.json', stamp => { delete stamp.cooperativeAddonProtocol; }), /native.*manifest/i],
  ['native package disagrees with compiled launcher after reseal', f => mutateStamp(f, 'electron_game_overlay_runtime.build.json', stamp => { stamp.addonBuildId = 'F'.repeat(32); }), /native.*manifest/i],
  ['paired native generations disagree after reseal', f => mutateStamp(f, 'electron_game_overlay_runtime32.build.json', stamp => { stamp.runtimeGeneration++; }), /disagree/i],
  ['native generation differs from the sealed SDK literal', f => {
    for (const name of ['electron_game_overlay_runtime.build.json', 'electron_game_overlay_runtime32.build.json']) mutateStamp(f, name, stamp => { stamp.runtimeGeneration = 14; });
  }, /generation.*compiled SDK/i],
  ['compiled generation is missing', f => { f.write('lib/overlay-broker-protocol.js', 'exports.OVERLAY_BROKER_LEGACY_RUNTIME_GENERATION = 1;\n'); f.payload.seal(); }, /generation.*missing/i],
  ['compiled generation is ambiguous', f => { f.write('lib/overlay-broker-protocol.js', 'exports.OVERLAY_BROKER_RUNTIME_GENERATION = 15;\nexports.OVERLAY_BROKER_RUNTIME_GENERATION = 14;\n'); f.payload.seal(); }, /generation.*ambiguous/i],
  ['old ReShade capability after reseal', f => mutateStamp(f, 'ReShade32.build.json', stamp => { stamp.cooperativeAddonProtocol = 0; }), /ReShade.*manifest/i],
  ['wrong native architecture after rebinding all hashes', f => {
    const relative = 'runtime/win32-x64/reshade/inject32.exe';
    const bytes = fs.readFileSync(path.join(f.dist, relative)); bytes.writeUInt16LE(0x8664, 68);
    f.write(relative, bytes); f.payload.bindNativeHashes(); f.payload.seal();
  }, /architecture/i],
]) test('direct SDK verifier rejects ' + name, t => {
  const f = fixture(t);
  mutate(f);
  assert.throws(() => validateOverlayDistributionSync(f.dist, '0.1.0-rc.7'), error);
});

for (const [generation, addonBuildId] of [
  [8, 'A8E9DA12477741B9979D9B1B51994EF3'], [9, '3309FB779CFC4E39BA7681AA4A7F8A6B'],
  [10, '280C7D267CA94332834D85A075A453AE'], [11, 'E16461475E524DBA83398B19CDD95EBB'],
  [12, 'E975AA8639164AED979E9770674B9546'], [13, '4127FD92CC904E0AA75C7784189AE969'],
  [14, '412D57BEA49440738CC4C3903038F2E7'],
]) test('retained generation ' + generation + ' preserves its schema-29 provenance and exact sealed bytes', t => {
  const f = fixture(t, { runtimeGeneration: generation, addonBuildId });
  const before = fs.readFileSync(f.manifestPath);
  const manifest = validateOverlayDistributionSync(f.dist, '0.1.0-rc.7');
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, manifest.packageVersion), manifest);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  for (const bits of [64, 32]) {
    const stamp = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(stamp.schemaVersion, 29);
    assert.equal(stamp.ownedLateD3d11PatchSha256, undefined);
  }
});

for (const [name, value] of [['missing', undefined], ['wrong type', 1], ['malformed', 'not-a-digest'], ['wrong valid digest', '0'.repeat(64)]]) {
  test('schema-30 owned patch provenance rejects ' + name + ' after every native/SDK hash is rebound', t => {
    const f = fixture(t);
    for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => {
      if (value === undefined) delete stamp.ownedLateD3d11PatchSha256;
      else stamp.ownedLateD3d11PatchSha256 = value;
    });
    assert.throws(() => validateOverlayDistributionSync(f.dist), /owned late D3D11 patch provenance/i);
    assert.throws(() => createOverlayDistributionManifestSync(f.dist, '0.1.0-rc.7'), /owned late D3D11 patch provenance/i);
  });
}
test('current SDK cannot downgrade both ReShade stamps to legacy schema 29 after full rebinding', t => {
  const f = fixture(t);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.schemaVersion = 29; delete stamp.ownedLateD3d11PatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /ReShade build manifest/i);
});
test('paired ReShade architectures cannot mix schema 29 and 30', t => {
  const f = fixture(t);
  mutateStamp(f, 'ReShade32.build.json', stamp => { stamp.schemaVersion = 29; delete stamp.ownedLateD3d11PatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /ReShade build manifest/i);
});
test('an unknown future ReShade schema is rejected', t => {
  const f = fixture(t);
  mutateStamp(f, 'ReShade64.build.json', stamp => { stamp.schemaVersion = 31; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /ReShade build manifest/i);
});
test('retained schema 29 cannot silently advertise a new owned-late capability', t => {
  const f = fixture(t, { runtimeGeneration: 14, addonBuildId: '412D57BEA49440738CC4C3903038F2E7' });
  mutateStamp(f, 'ReShade64.build.json', stamp => { stamp.ownedLateD3d11PatchSha256 = '51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE'; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /requires ReShade schema 30/i);
});
for (const [name, declaration] of [
  ['zero', 'exports.OVERLAY_BROKER_RUNTIME_GENERATION = 0;\n'],
  ['uint32 overflow', 'exports.OVERLAY_BROKER_RUNTIME_GENERATION = 4294967296;\n'],
  ['computed expression', 'exports.OVERLAY_BROKER_RUNTIME_GENERATION = 14 + 1;\n'],
  ['header export chain only', 'exports.OTHER = exports.OVERLAY_BROKER_RUNTIME_GENERATION = void 0;\n'],
]) test('compiled SDK generation rejects ' + name + ' after resealing', t => {
  const f = fixture(t);
  f.write('lib/overlay-broker-protocol.js', declaration); f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /generation.*missing|generation.*ambiguous/i);
});

test('a retained original generation-15 schema-30 package needs no later first-host-result field', t => {
  const f = fixture(t, { ...retainedGeneration15, firstHostResultPatch: false });
  const before = fs.readFileSync(f.manifestPath);
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, '0.1.0-rc.7'), validateOverlayDistributionSync(f.dist));
  assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  for (const bits of [64, 32]) {
    const stamp = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(stamp.schemaVersion, 30);
    assert.equal(stamp.ownedLateD3d11PatchSha256, '51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE');
    assert.equal(stamp.injectorFirstHostResultPatchSha256, undefined);
  }
});
test('the retained generation-15 CLI-corrected package preserves its sealed implementation and B683 provenance', t => {
  const f = fixture(t, { ...retainedGeneration15, firstHostResultPatch: true });
  const before = fs.readFileSync(f.manifestPath);
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, '0.1.0-rc.7'), validateOverlayDistributionSync(f.dist));
  assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  for (const bits of [64, 32]) {
    const stamp = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(stamp.schemaVersion, 30);
    assert.equal(stamp.injectorFirstHostResultPatchSha256, 'B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554');
  }
});
for (const [name, value] of [['missing', undefined], ['null', null], ['wrong type', 1], ['malformed', 'not-a-digest'], ['wrong valid digest', '0'.repeat(64)]]) {
  test('sealed current CLI implementation rejects ' + name + ' first-host patch provenance after full rebinding', t => {
    const f = fixture(t);
    for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => {
      if (value === undefined) delete stamp.injectorFirstHostResultPatchSha256;
      else stamp.injectorFirstHostResultPatchSha256 = value;
    });
    assert.throws(() => validateOverlayDistributionSync(f.dist), /first-host result patch provenance mismatch/i);
    assert.throws(() => createOverlayDistributionManifestSync(f.dist, '0.1.0-rc.7'), /first-host result patch provenance mismatch/i);
  });
}
test('the paired architectures cannot differ in first-host-result provenance presence', t => {
  const f = fixture(t);
  mutateStamp(f, 'ReShade32.build.json', stamp => { delete stamp.injectorFirstHostResultPatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /first-host result patch provenance mismatch.*32/i);
});
test('a retained validator implementation cannot claim the later CLI patch through metadata alone', t => {
  const f = fixture(t, { ...retainedGeneration15, firstHostResultPatch: false });
  mutateStamp(f, 'ReShade64.build.json', stamp => { stamp.injectorFirstHostResultPatchSha256 = 'B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554'; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /requires the sealed SDK implementation pin/i);
});
for (const [name, text] of [
  ['nonliteral', "const INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256 = process.env.PATCH_HASH;\n"],
  ['malformed digest', "const INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256 = 'bad';\n"],
  ['uninitialized', 'const INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256;\n'],
  ['duplicate', "const INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256 = 'B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554';\nconst INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256 = 'B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554';\n"],
  ['unsupported valid digest', "const INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256 = '" + '0'.repeat(64) + "';\n"],
]) test('incoming compiled validator rejects a ' + name + ' first-host implementation pin without executing it', t => {
  const f = fixture(t, { ...retainedGeneration15, firstHostResultPatch: false });
  f.write('lib/overlay-package-manifest.js', text); f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /first-host result patch pin/i);
});
test('a post-legacy generation cannot silently omit the current injector implementation pin', t => {
  const f = fixture(t, { runtimeGeneration: 16, firstHostResultPatch: false });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /patch pin does not match its generation/i);
});
test('the incoming validator is a required sealed payload', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dist, 'lib/overlay-package-manifest.js')); f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /Required sealed SDK payload missing/i);
});

test('payload junctions cannot redirect integrity reads outside the SDK', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(f.dist, 'unsafe'), 'junction'); }
  catch (error) { if (['EPERM','EACCES'].includes(error.code)) { t.skip('Fixture junction unavailable'); return; } throw error; }
  assert.throws(() => validateOverlayDistributionSync(f.dist), /Symbolic link/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('actual seal script builds a self-contained SDK manifest on the supported build Node version', t => {
  const f = fixture(t);
  const scripts = path.join(f.root, 'scripts'); fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ name: 'electron-game-overlay', version: '0.1.0-rc.7' }));
  const dependencyOutput = path.join(f.dist, 'node_modules');
  assert.equal(path.dirname(dependencyOutput), f.dist);
  fs.rmSync(dependencyOutput, { recursive: true });
  const tslib = path.dirname(require.resolve('tslib/package.json'));
  fs.mkdirSync(path.join(f.root, 'node_modules'));
  fs.cpSync(tslib, path.join(f.root, 'node_modules/tslib'), { recursive: true });
  fs.writeFileSync(path.join(f.dist, 'lib/overlay-package-manifest.js'), validatorSource);
  const entry = path.join(scripts, 'seal-sdk-distribution.cjs');
  fs.copyFileSync(path.resolve(__dirname, '../scripts/seal-sdk-distribution.cjs'), entry);
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.match(result.stdout, /ELECTRON_GAME_OVERLAY_SDK_SEALED/);
  const manifest = validateOverlayDistributionSync(f.dist, '0.1.0-rc.7');
  assert.ok(manifest.files.some(file => file.path === 'node_modules/tslib/tslib.js'));
  assert.equal(fs.existsSync(path.join(f.dist, 'broker')), false);
});
