'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  createOverlayDistributionManifestSync,
  validateOverlayDistributionSync,
} = require('../dist/lib/overlay-package-manifest.js');
const { writeCooperativeDistribution } = require('./helpers/cooperative-package-fixture.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-direct-seal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const dist = path.join(root, 'dist');
  const payload = writeCooperativeDistribution(dist);
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
  f.payload.seal();
  const manifest = validateOverlayDistributionSync(f.dist, '0.1.0-rc.7');
  assert.equal(manifest.files.length, f.payload.files.length);
  assert.equal(fs.existsSync(path.join(f.dist, 'broker')), false);
  assert.deepEqual(createOverlayDistributionManifestSync(f.dist, manifest.packageVersion), manifest);
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
  fs.copyFileSync(path.resolve(__dirname, '../dist/lib/overlay-package-manifest.js'), path.join(f.dist, 'lib/overlay-package-manifest.js'));
  const entry = path.join(scripts, 'seal-sdk-distribution.cjs');
  fs.copyFileSync(path.resolve(__dirname, '../scripts/seal-sdk-distribution.cjs'), entry);
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.match(result.stdout, /ELECTRON_GAME_OVERLAY_SDK_SEALED/);
  const manifest = validateOverlayDistributionSync(f.dist, '0.1.0-rc.7');
  assert.ok(manifest.files.some(file => file.path === 'node_modules/tslib/tslib.js'));
  assert.equal(fs.existsSync(path.join(f.dist, 'broker')), false);
});
