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
const retainedGeneration16 = Object.freeze({ runtimeGeneration: 16, addonBuildId: 'E8FE3783F29E4FB297D8B006D0087725' });
const retainedGeneration18 = Object.freeze({ runtimeGeneration: 18, addonBuildId: '17E16E01C9A243E18EE19D814420E519' });
const retainedGeneration19 = Object.freeze({ runtimeGeneration: 19 });
const retainedGeneration20 = Object.freeze({ runtimeGeneration: 20 });
const retainedGeneration21 = Object.freeze({ runtimeGeneration: 21 });
const retainedGeneration22 = Object.freeze({ runtimeGeneration: 22 });
const preloadedFirstHostPatchSha256 = 'A8C494EF02E08E5084D7EDC27ABCB73639C18D23469F244F99F090A27DB46309';
const preloadLongPathPatchSha256 = 'FFFF684D2E60D36F1CEC4D073B91A014B7F497A50C4F5B00F7B7F2A57714397B';
const adapterReadyLongPathPatchSha256 = 'BCC0F0CD455B80DB3ED6D850B63600116B1D9881F1C85602CF76CEF7B23C35A6';
const initialInspectionRecoveryPatchSha256 = '5E9E7D2C8A2EE66F9A478CA193B5962C4F635943D040B121593AD70A3177D8A7';
const sharedAddonDirectoryPatchSha256 = '54AE1F9ABCE02CBB66481C7C2AB30E4D3E7925CD83F27F31D8551D76DEF85125';
const foreignAddonIsolationPatchSha256 = '2A1FF13D7F76258ECF9D5CFB565D68C2522BEE772053A5373A3645823D310F99';

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

test('the retained generation-16 package remains valid without preload capability or patch provenance', t => {
  const f = fixture(t, retainedGeneration16), before = fs.readFileSync(f.manifestPath);
  const manifest = validateOverlayDistributionSync(f.dist);
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, manifest.packageVersion), manifest);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const native = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/electron_game_overlay_runtime' + suffix + '.build.json')));
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(native.addonPreloadProtocol, undefined);
    assert.equal(reshade.addonPreloadProtocol, undefined);
    assert.equal(reshade.injectorAddonPreloadPatchSha256, undefined);
  }
});
test('current preload implementation binds capability 1 and the exact injector patch in both architectures', t => {
  const f = fixture(t);
  validateOverlayDistributionSync(f.dist);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const native = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/electron_game_overlay_runtime' + suffix + '.build.json')));
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(native.runtimeGeneration, 23);
    assert.equal(native.addonPreloadProtocol, 1);
    assert.equal(reshade.addonPreloadProtocol, 1);
    assert.equal(reshade.injectorAddonPreloadPatchSha256, 'E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D');
  }
});
for (const [name, value] of [['missing', undefined], ['null', null], ['zero', 0], ['future protocol', 2], ['string', '1'], ['boolean', true], ['fraction', 1.5]]) {
  for (const target of ['native', 'ReShade']) test('current preload ' + target + ' capability rejects ' + name + ' after full hash rebinding', t => {
    const f = fixture(t);
    const stamp = target === 'native' ? 'electron_game_overlay_runtime32.build.json' : 'ReShade32.build.json';
    mutateStamp(f, stamp, data => {
      if (value === undefined) delete data.addonPreloadProtocol;
      else data.addonPreloadProtocol = value;
    });
    assert.throws(() => validateOverlayDistributionSync(f.dist), /preload|Native architecture manifests disagree|native runtime manifest/i);
  });
}
for (const [name, value] of [['missing', undefined], ['wrong type', 1], ['malformed', 'bad'], ['wrong valid digest', '0'.repeat(64)]]) test('current preload patch rejects ' + name + ' provenance after full hash rebinding', t => {
  const f = fixture(t);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => {
    if (value === undefined) delete stamp.injectorAddonPreloadPatchSha256;
    else stamp.injectorAddonPreloadPatchSha256 = value;
  });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload patch provenance mismatch/i);
  assert.throws(() => createOverlayDistributionManifestSync(f.dist, '0.1.0-rc.7'), /preload patch provenance mismatch/i);
});
for (const value of [undefined, '0'.repeat(64)]) test('x86 preload patch provenance is independently required: ' + (value === undefined ? 'missing' : 'wrong digest'), t => {
  const f = fixture(t);
  mutateStamp(f, 'ReShade32.build.json', stamp => {
    if (value === undefined) delete stamp.injectorAddonPreloadPatchSha256;
    else stamp.injectorAddonPreloadPatchSha256 = value;
  });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload patch provenance mismatch.*32/i);
});
test('removing every preload metadata field cannot downgrade the current sealed implementation', t => {
  const f = fixture(t);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    mutateStamp(f, 'electron_game_overlay_runtime' + suffix + '.build.json', stamp => { delete stamp.addonPreloadProtocol; });
    mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { delete stamp.addonPreloadProtocol; delete stamp.injectorAddonPreloadPatchSha256; });
  }
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload capability does not match the sealed SDK implementation/i);
});
test('a legacy generation-16 implementation cannot advertise preload capability through metadata alone', t => {
  const f = fixture(t, retainedGeneration16);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    mutateStamp(f, 'electron_game_overlay_runtime' + suffix + '.build.json', stamp => { stamp.addonPreloadProtocol = 1; });
    mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.addonPreloadProtocol = 1; stamp.injectorAddonPreloadPatchSha256 = 'E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D'; });
  }
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload capability does not match the sealed SDK implementation/i);
});
test('a valid preload implementation marker cannot relabel a generation-16 package as preload-capable', t => {
  const f = fixture(t, retainedGeneration16), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + "const INJECTOR_ADDON_PRELOAD_PATCH_SHA256 = 'E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D';\n");
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    mutateStamp(f, 'electron_game_overlay_runtime' + suffix + '.build.json', stamp => { stamp.addonPreloadProtocol = 1; });
    mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.addonPreloadProtocol = 1; stamp.injectorAddonPreloadPatchSha256 = 'E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D'; });
  }
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload patch pin does not match its generation/i);
});
for (const [name, text] of [
  ['nonliteral', 'const INJECTOR_ADDON_PRELOAD_PATCH_SHA256 = process.env.PATCH_HASH;\n'],
  ['uninitialized', 'const INJECTOR_ADDON_PRELOAD_PATCH_SHA256;\n'],
  ['malformed digest', "const INJECTOR_ADDON_PRELOAD_PATCH_SHA256 = 'bad';\n"],
  ['duplicate', "const INJECTOR_ADDON_PRELOAD_PATCH_SHA256 = 'E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D';\nconst INJECTOR_ADDON_PRELOAD_PATCH_SHA256 = 'E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D';\n"],
  ['wrong valid digest', "const INJECTOR_ADDON_PRELOAD_PATCH_SHA256 = '" + '0'.repeat(64) + "';\n"],
]) test('incoming SDK data rejects a ' + name + ' preload implementation pin', t => {
  const f = fixture(t, retainedGeneration16);
  const modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + text); f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload patch pin/i);
});
test('a current SDK cannot omit its preload implementation marker', t => {
  const f = fixture(t), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8').replace(/^const INJECTOR_ADDON_PRELOAD_PATCH_SHA256[^\n]*\n/gm, ''));
  f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload patch pin does not match its generation/i);
});

test('retained generation-18 preload packages remain valid without the later fresh-owner ordering patch', t => {
  const f = fixture(t, retainedGeneration18), before = fs.readFileSync(f.manifestPath);
  const manifest = validateOverlayDistributionSync(f.dist);
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, manifest.packageVersion), manifest);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  assert.doesNotMatch(fs.readFileSync(path.join(f.dist, 'lib/overlay-package-manifest.js'), 'utf8'), /INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256/);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const native = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/electron_game_overlay_runtime' + suffix + '.build.json')));
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(native.addonPreloadProtocol, 1);
    assert.equal(reshade.addonPreloadProtocol, 1);
    assert.equal(reshade.injectorAddonPreloadPatchSha256, 'E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D');
    assert.equal(reshade.injectorPreloadedFirstHostPatchSha256, undefined);
  }
});

test('current code binds the exact fresh-owner ordering patch in both architectures', t => {
  const f = fixture(t);
  validateOverlayDistributionSync(f.dist);
  for (const bits of [64, 32]) {
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(reshade.schemaVersion, 30);
    assert.equal(reshade.addonPreloadProtocol, 1);
    assert.equal(reshade.injectorPreloadedFirstHostPatchSha256, preloadedFirstHostPatchSha256);
  }
});

for (const [name, value] of [['missing', undefined], ['null', null], ['wrong type', 1], ['malformed', 'bad'], ['wrong valid digest', '0'.repeat(64)]]) test('current fresh-owner ordering patch rejects ' + name + ' provenance after full hash rebinding', t => {
  const f = fixture(t);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => {
    if (value === undefined) delete stamp.injectorPreloadedFirstHostPatchSha256;
    else stamp.injectorPreloadedFirstHostPatchSha256 = value;
  });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preloaded first-host patch provenance mismatch/i);
  assert.throws(() => createOverlayDistributionManifestSync(f.dist, '0.1.0-rc.7'), /preloaded first-host patch provenance mismatch/i);
});
for (const value of [undefined, '0'.repeat(64)]) test('x86 fresh-owner ordering provenance is independently required: ' + (value === undefined ? 'missing' : 'wrong digest'), t => {
  const f = fixture(t);
  mutateStamp(f, 'ReShade32.build.json', stamp => {
    if (value === undefined) delete stamp.injectorPreloadedFirstHostPatchSha256;
    else stamp.injectorPreloadedFirstHostPatchSha256 = value;
  });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preloaded first-host patch provenance mismatch.*32/i);
});

test('generation-18 code cannot claim the later ordering correction through source-stamp metadata alone', t => {
  const f = fixture(t, retainedGeneration18);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.injectorPreloadedFirstHostPatchSha256 = preloadedFirstHostPatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preloaded first-host patch provenance requires the sealed SDK implementation pin/i);
});
test('a valid fresh-owner ordering marker cannot relabel a generation-18 implementation', t => {
  const f = fixture(t, retainedGeneration18), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + `const INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256 = '${preloadedFirstHostPatchSha256}';\n`);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.injectorPreloadedFirstHostPatchSha256 = preloadedFirstHostPatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preloaded first-host patch pin does not match its generation/i);
});

for (const [name, text] of [
  ['nonliteral', 'const INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256 = process.env.PATCH_HASH;\n'],
  ['mutable literal', `let INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256 = '${preloadedFirstHostPatchSha256}';\n`],
  ['uninitialized', 'const INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256;\n'],
  ['malformed digest', "const INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256 = 'bad';\n"],
  ['duplicate', `const INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256 = '${preloadedFirstHostPatchSha256}';\nconst INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256 = '${preloadedFirstHostPatchSha256}';\n`],
  ['wrong valid digest', "const INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256 = '" + '0'.repeat(64) + "';\n"],
]) test('incoming SDK data rejects a ' + name + ' fresh-owner ordering implementation pin', t => {
  const f = fixture(t, retainedGeneration18), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + text + 'throw new Error("Incoming validator must never execute");\n'); f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preloaded first-host patch pin/i);
});

for (const removeProvenance of [false, true]) test('current code cannot omit its fresh-owner ordering marker' + (removeProvenance ? ' and source provenance' : ''), t => {
  const f = fixture(t), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8').replace(/^const INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256[^\n]*\n/gm, ''));
  if (removeProvenance) for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { delete stamp.injectorPreloadedFirstHostPatchSha256; });
  f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preloaded first-host patch pin does not match its generation/i);
});

test('retained generation-19 preloading remains valid without long-path patch metadata or code markers', t => {
  const f = fixture(t, retainedGeneration19), before = fs.readFileSync(f.manifestPath);
  const manifest = validateOverlayDistributionSync(f.dist);
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, manifest.packageVersion), manifest);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  assert.doesNotMatch(fs.readFileSync(path.join(f.dist, 'lib/overlay-package-manifest.js'), 'utf8'), /INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256/);
  for (const bits of [64, 32]) {
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(reshade.injectorPreloadedFirstHostPatchSha256, preloadedFirstHostPatchSha256);
    assert.equal(reshade.injectorPreloadLongPathPatchSha256, undefined);
  }
});

test('retained generation-20 payloads preserve the injector correction without claiming the later host readiness correction', t => {
  const f = fixture(t, retainedGeneration20), before = fs.readFileSync(f.manifestPath);
  const manifest = validateOverlayDistributionSync(f.dist);
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, manifest.packageVersion), manifest);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  assert.doesNotMatch(fs.readFileSync(path.join(f.dist, 'lib/overlay-package-manifest.js'), 'utf8'), /OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256/);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const native = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/electron_game_overlay_runtime' + suffix + '.build.json')));
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(native.runtimeGeneration, 20);
    assert.equal(reshade.injectorPreloadLongPathPatchSha256, preloadLongPathPatchSha256);
    assert.equal(reshade.ownedLateD3d11AdapterReadyLongPathPatchSha256, undefined);
  }
});

test('current preloading binds the exact injector long-path patch independently for both architectures', t => {
  const f = fixture(t);
  validateOverlayDistributionSync(f.dist);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const native = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/electron_game_overlay_runtime' + suffix + '.build.json')));
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(native.runtimeGeneration, 23);
    assert.equal(reshade.schemaVersion, 30);
    assert.equal(reshade.injectorPreloadLongPathPatchSha256, preloadLongPathPatchSha256);
  }
});

for (const [name, value] of [['missing', undefined], ['null', null], ['wrong type', 1], ['malformed', 'bad'], ['wrong valid digest', '0'.repeat(64)]]) test('long-path patch rejects ' + name + ' provenance after full hash rebinding', t => {
  const f = fixture(t);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => {
    if (value === undefined) delete stamp.injectorPreloadLongPathPatchSha256;
    else stamp.injectorPreloadLongPathPatchSha256 = value;
  });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload long-path patch provenance mismatch/i);
  assert.throws(() => createOverlayDistributionManifestSync(f.dist, '0.1.0-rc.7'), /preload long-path patch provenance mismatch/i);
});

for (const value of [undefined, '0'.repeat(64)]) test('x86 long-path provenance is independently required: ' + (value === undefined ? 'missing' : 'wrong digest'), t => {
  const f = fixture(t);
  mutateStamp(f, 'ReShade32.build.json', stamp => {
    if (value === undefined) delete stamp.injectorPreloadLongPathPatchSha256;
    else stamp.injectorPreloadLongPathPatchSha256 = value;
  });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload long-path patch provenance mismatch.*32/i);
});

test('generation-19 code cannot claim the long-path correction through source-stamp metadata alone', t => {
  const f = fixture(t, retainedGeneration19);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.injectorPreloadLongPathPatchSha256 = preloadLongPathPatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload long-path patch provenance requires the sealed SDK implementation pin/i);
});

test('a valid long-path marker cannot relabel a generation-19 implementation', t => {
  const f = fixture(t, retainedGeneration19), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + `const INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256 = '${preloadLongPathPatchSha256}';\n`);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.injectorPreloadLongPathPatchSha256 = preloadLongPathPatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload long-path patch pin does not match its generation/i);
});

for (const [name, text] of [
  ['nonliteral', 'const INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256 = process.env.PATCH_HASH;\n'],
  ['mutable literal', `let INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256 = '${preloadLongPathPatchSha256}';\n`],
  ['uninitialized', 'const INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256;\n'],
  ['malformed digest', "const INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256 = 'bad';\n"],
  ['duplicate', `const INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256 = '${preloadLongPathPatchSha256}';\nconst INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256 = '${preloadLongPathPatchSha256}';\n`],
  ['wrong valid digest', "const INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256 = '" + '0'.repeat(64) + "';\n"],
]) test('incoming SDK data rejects a ' + name + ' long-path implementation pin', t => {
  const f = fixture(t, retainedGeneration19), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + text + 'throw new Error("Incoming validator must never execute");\n'); f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload long-path patch pin/i);
});

for (const removeProvenance of [false, true]) test('current code cannot omit its long-path marker' + (removeProvenance ? ' and source provenance' : ''), t => {
  const f = fixture(t), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8').replace(/^const INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256[^\n]*\n/gm, ''));
  if (removeProvenance) for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { delete stamp.injectorPreloadLongPathPatchSha256; });
  f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /preload long-path patch pin does not match its generation/i);
});

test('retained generation-21 payloads preserve both long-path corrections without claiming later inspection recovery', t => {
  const f = fixture(t, retainedGeneration21), before = fs.readFileSync(f.manifestPath);
  const manifest = validateOverlayDistributionSync(f.dist);
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, manifest.packageVersion), manifest);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  assert.doesNotMatch(fs.readFileSync(path.join(f.dist, 'lib/overlay-package-manifest.js'), 'utf8'), /INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256/);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const native = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/electron_game_overlay_runtime' + suffix + '.build.json')));
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(native.runtimeGeneration, 21);
    assert.equal(reshade.injectorPreloadLongPathPatchSha256, preloadLongPathPatchSha256);
    assert.equal(reshade.ownedLateD3d11AdapterReadyLongPathPatchSha256, adapterReadyLongPathPatchSha256);
    assert.equal(reshade.injectorInitialInspectionRecoveryPatchSha256, undefined);
  }
});

test('current preloading binds both injector and owned-host long-path patches for both architectures', t => {
  const f = fixture(t);
  validateOverlayDistributionSync(f.dist);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const native = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/electron_game_overlay_runtime' + suffix + '.build.json')));
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(native.runtimeGeneration, 23);
    assert.equal(reshade.schemaVersion, 30);
    assert.equal(reshade.injectorPreloadLongPathPatchSha256, preloadLongPathPatchSha256);
    assert.equal(reshade.ownedLateD3d11AdapterReadyLongPathPatchSha256, adapterReadyLongPathPatchSha256);
  }
});

for (const [name, value] of [['missing', undefined], ['null', null], ['wrong type', 1], ['malformed', 'bad'], ['wrong valid digest', '0'.repeat(64)]]) test('host adapter-ready long-path patch rejects ' + name + ' provenance after full hash rebinding', t => {
  const f = fixture(t);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => {
    if (value === undefined) delete stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256;
    else stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256 = value;
  });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /adapter-ready long-path patch provenance mismatch/i);
  assert.throws(() => createOverlayDistributionManifestSync(f.dist, '0.1.0-rc.7'), /adapter-ready long-path patch provenance mismatch/i);
});

for (const value of [undefined, '0'.repeat(64)]) test('x86 host adapter-ready long-path provenance is independently required: ' + (value === undefined ? 'missing' : 'wrong digest'), t => {
  const f = fixture(t);
  mutateStamp(f, 'ReShade32.build.json', stamp => {
    if (value === undefined) delete stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256;
    else stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256 = value;
  });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /adapter-ready long-path patch provenance mismatch.*32/i);
});

test('generation-20 code cannot claim the host readiness correction through source-stamp metadata alone', t => {
  const f = fixture(t, retainedGeneration20);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256 = adapterReadyLongPathPatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /adapter-ready long-path patch provenance requires the sealed SDK implementation pin/i);
});

test('a valid host readiness marker cannot relabel a generation-20 implementation', t => {
  const f = fixture(t, retainedGeneration20), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + `const OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256 = '${adapterReadyLongPathPatchSha256}';\n`);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256 = adapterReadyLongPathPatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /adapter-ready long-path patch pin does not match its generation/i);
});

for (const [name, text] of [
  ['nonliteral', 'const OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256 = process.env.PATCH_HASH;\n'],
  ['mutable literal', `let OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256 = '${adapterReadyLongPathPatchSha256}';\n`],
  ['uninitialized', 'const OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256;\n'],
  ['malformed digest', "const OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256 = 'bad';\n"],
  ['duplicate', `const OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256 = '${adapterReadyLongPathPatchSha256}';\nconst OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256 = '${adapterReadyLongPathPatchSha256}';\n`],
  ['wrong valid digest', "const OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256 = '" + '0'.repeat(64) + "';\n"],
]) test('incoming SDK data rejects a ' + name + ' host adapter-ready long-path implementation pin', t => {
  const f = fixture(t, retainedGeneration20), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + text + 'throw new Error("Incoming validator must never execute");\n'); f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /adapter-ready long-path patch pin/i);
});

for (const removeProvenance of [false, true]) test('current code cannot omit its host readiness marker' + (removeProvenance ? ' and source provenance' : ''), t => {
  const f = fixture(t), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8').replace(/^const OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256[^\n]*\n/gm, ''));
  if (removeProvenance) for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { delete stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256; });
  f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /adapter-ready long-path patch pin does not match its generation/i);
});

test('generation-22 packages bind initial inspection recovery and retain both long-path patches', t => {
  const f = fixture(t, retainedGeneration22);
  validateOverlayDistributionSync(f.dist);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const native = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/electron_game_overlay_runtime' + suffix + '.build.json')));
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(native.runtimeGeneration, 22);
    assert.equal(reshade.schemaVersion, 30);
    assert.equal(reshade.injectorPreloadLongPathPatchSha256, preloadLongPathPatchSha256);
    assert.equal(reshade.ownedLateD3d11AdapterReadyLongPathPatchSha256, adapterReadyLongPathPatchSha256);
    assert.equal(reshade.injectorInitialInspectionRecoveryPatchSha256, initialInspectionRecoveryPatchSha256);
  }
});

test('retained generation-22 packages keep their exact seal and do not claim the shared-folder implementation', t => {
  const f = fixture(t, retainedGeneration22), before = fs.readFileSync(f.manifestPath);
  const manifest = validateOverlayDistributionSync(f.dist);
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, manifest.packageVersion), manifest);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  const validator = fs.readFileSync(path.join(f.dist, 'lib/overlay-package-manifest.js'), 'utf8');
  assert.doesNotMatch(validator, /INJECTOR_SHARED_ADDON_DIRECTORY_PATCH_SHA256|OWNED_LATE_D3D11_FOREIGN_ADDON_ISOLATION_PATCH_SHA256/);
  for (const bits of [64, 32]) {
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(reshade.injectorInitialInspectionRecoveryPatchSha256, initialInspectionRecoveryPatchSha256);
    assert.equal(reshade.injectorSharedAddonDirectoryPatchSha256, undefined);
    assert.equal(reshade.ownedLateD3d11ForeignAddonIsolationPatchSha256, undefined);
  }
});

test('generation-23 packages bind shared-folder selection and foreign add-on failure isolation independently', t => {
  const f = fixture(t);
  validateOverlayDistributionSync(f.dist);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const native = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/electron_game_overlay_runtime' + suffix + '.build.json')));
    const reshade = JSON.parse(fs.readFileSync(path.join(f.dist, 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(native.runtimeGeneration, 23);
    assert.equal(native.addonBuildId, 'CCE20935ADD44EF6A5A7973014B2E07F');
    assert.equal(reshade.injectorSharedAddonDirectoryPatchSha256, sharedAddonDirectoryPatchSha256);
    assert.equal(reshade.ownedLateD3d11ForeignAddonIsolationPatchSha256, foreignAddonIsolationPatchSha256);
    assert.equal(reshade.injectorInitialInspectionRecoveryPatchSha256, initialInspectionRecoveryPatchSha256);
  }
});

for (const [label, field, constant, expected] of [
  ['shared add-on directory', 'injectorSharedAddonDirectoryPatchSha256', 'INJECTOR_SHARED_ADDON_DIRECTORY_PATCH_SHA256', sharedAddonDirectoryPatchSha256],
  ['foreign add-on isolation', 'ownedLateD3d11ForeignAddonIsolationPatchSha256', 'OWNED_LATE_D3D11_FOREIGN_ADDON_ISOLATION_PATCH_SHA256', foreignAddonIsolationPatchSha256],
]) {
  const pinError = new RegExp(label + ' patch pin', 'i');
  const provenanceError = new RegExp(label + ' patch provenance mismatch', 'i');
  for (const [name, value] of [['missing', undefined], ['null', null], ['wrong type', 1], ['malformed', 'bad'], ['wrong valid digest', '0'.repeat(64)]]) test(label + ' rejects ' + name + ' provenance after full hash rebinding', t => {
    const f = fixture(t);
    for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => {
      if (value === undefined) delete stamp[field]; else stamp[field] = value;
    });
    assert.throws(() => validateOverlayDistributionSync(f.dist), provenanceError);
    assert.throws(() => createOverlayDistributionManifestSync(f.dist, '0.1.0-rc.7'), provenanceError);
  });
  for (const value of [undefined, '0'.repeat(64)]) test('x86 ' + label + ' provenance is independently required: ' + (value === undefined ? 'missing' : 'wrong digest'), t => {
    const f = fixture(t);
    mutateStamp(f, 'ReShade32.build.json', stamp => {
      if (value === undefined) delete stamp[field]; else stamp[field] = value;
    });
    assert.throws(() => validateOverlayDistributionSync(f.dist), new RegExp(label + ' patch provenance mismatch.*32', 'i'));
  });
  test('generation-22 metadata alone cannot claim ' + label, t => {
    const f = fixture(t, retainedGeneration22);
    for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp[field] = expected; });
    assert.throws(() => validateOverlayDistributionSync(f.dist), new RegExp(label + ' patch provenance requires the sealed SDK implementation pin', 'i'));
  });
  test('a valid ' + label + ' marker cannot relabel a generation-22 implementation', t => {
    const f = fixture(t, retainedGeneration22), modulePath = 'lib/overlay-package-manifest.js';
    f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + `const ${constant} = '${expected}';\n`);
    f.payload.seal();
    assert.throws(() => validateOverlayDistributionSync(f.dist), new RegExp(label + ' patch pin does not match its generation', 'i'));
  });
  for (const [name, text] of [
    ['nonliteral', `const ${constant} = process.env.PATCH_HASH;\n`],
    ['mutable literal', `let ${constant} = '${expected}';\n`],
    ['uninitialized', `const ${constant};\n`],
    ['malformed digest', `const ${constant} = 'bad';\n`],
    ['duplicate', `const ${constant} = '${expected}';\nconst ${constant} = '${expected}';\n`],
    ['wrong valid digest', `const ${constant} = '${'0'.repeat(64)}';\n`],
  ]) test('incoming SDK data rejects a ' + name + ' ' + label + ' implementation pin', t => {
    const f = fixture(t, retainedGeneration22), modulePath = 'lib/overlay-package-manifest.js';
    f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + text + 'throw new Error("Incoming validator must never execute");\n');
    f.payload.seal();
    assert.throws(() => validateOverlayDistributionSync(f.dist), pinError);
  });
  for (const removeProvenance of [false, true]) test('current code cannot omit its ' + label + ' marker' + (removeProvenance ? ' and source provenance' : ''), t => {
    const f = fixture(t), modulePath = 'lib/overlay-package-manifest.js';
    f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8').replace(new RegExp('^const ' + constant + '[^\\n]*\\n', 'gm'), ''));
    if (removeProvenance) for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { delete stamp[field]; });
    f.payload.seal();
    assert.throws(() => validateOverlayDistributionSync(f.dist), new RegExp(label + ' patch pin does not match its generation', 'i'));
  });
}

for (const [name, value] of [['missing', undefined], ['null', null], ['wrong type', 1], ['malformed', 'bad'], ['wrong valid digest', '0'.repeat(64)]]) test('initial inspection recovery patch rejects ' + name + ' provenance after full hash rebinding', t => {
  const f = fixture(t);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => {
    if (value === undefined) delete stamp.injectorInitialInspectionRecoveryPatchSha256;
    else stamp.injectorInitialInspectionRecoveryPatchSha256 = value;
  });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /initial inspection recovery patch provenance mismatch/i);
  assert.throws(() => createOverlayDistributionManifestSync(f.dist, '0.1.0-rc.7'), /initial inspection recovery patch provenance mismatch/i);
});

for (const value of [undefined, '0'.repeat(64)]) test('x86 initial inspection recovery provenance is independently required: ' + (value === undefined ? 'missing' : 'wrong digest'), t => {
  const f = fixture(t);
  mutateStamp(f, 'ReShade32.build.json', stamp => {
    if (value === undefined) delete stamp.injectorInitialInspectionRecoveryPatchSha256;
    else stamp.injectorInitialInspectionRecoveryPatchSha256 = value;
  });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /initial inspection recovery patch provenance mismatch.*32/i);
});

test('generation-21 code cannot claim initial inspection recovery through source-stamp metadata alone', t => {
  const f = fixture(t, retainedGeneration21);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.injectorInitialInspectionRecoveryPatchSha256 = initialInspectionRecoveryPatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /initial inspection recovery patch provenance requires the sealed SDK implementation pin/i);
});

test('a valid initial inspection recovery marker cannot relabel a generation-21 implementation', t => {
  const f = fixture(t, retainedGeneration21), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + `const INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256 = '${initialInspectionRecoveryPatchSha256}';\n`);
  for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { stamp.injectorInitialInspectionRecoveryPatchSha256 = initialInspectionRecoveryPatchSha256; });
  assert.throws(() => validateOverlayDistributionSync(f.dist), /initial inspection recovery patch pin does not match its generation/i);
});

for (const [name, text] of [
  ['nonliteral', 'const INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256 = process.env.PATCH_HASH;\n'],
  ['mutable literal', `let INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256 = '${initialInspectionRecoveryPatchSha256}';\n`],
  ['uninitialized', 'const INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256;\n'],
  ['malformed digest', "const INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256 = 'bad';\n"],
  ['duplicate', `const INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256 = '${initialInspectionRecoveryPatchSha256}';\nconst INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256 = '${initialInspectionRecoveryPatchSha256}';\n`],
  ['wrong valid digest', "const INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256 = '" + '0'.repeat(64) + "';\n"],
]) test('incoming SDK data rejects a ' + name + ' initial inspection recovery implementation pin', t => {
  const f = fixture(t, retainedGeneration21), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8') + text + 'throw new Error("Incoming validator must never execute");\n'); f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /initial inspection recovery patch pin/i);
});

for (const removeProvenance of [false, true]) test('current code cannot omit its initial inspection recovery marker' + (removeProvenance ? ' and source provenance' : ''), t => {
  const f = fixture(t), modulePath = 'lib/overlay-package-manifest.js';
  f.write(modulePath, fs.readFileSync(path.join(f.dist, modulePath), 'utf8').replace(/^const INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256[^\n]*\n/gm, ''));
  if (removeProvenance) for (const bits of [64, 32]) mutateStamp(f, 'ReShade' + bits + '.build.json', stamp => { delete stamp.injectorInitialInspectionRecoveryPatchSha256; });
  f.payload.seal();
  assert.throws(() => validateOverlayDistributionSync(f.dist), /initial inspection recovery patch pin does not match its generation/i);
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
