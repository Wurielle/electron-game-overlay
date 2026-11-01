'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writeCooperativeDistribution } = require('./helpers/cooperative-package-fixture.cjs');
const cli = path.resolve(__dirname, '../scripts/package-sdk.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-pack-nonnative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'repo/libs/sdk');
  const dist = path.join(pkg, 'dist');
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const metadata = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json')));
  write(path.join(pkg, 'package.json'), JSON.stringify(metadata));
  write(path.join(root, 'repo/LICENSE'), 'GPL fixture license: NON-NATIVE CONTROLLED FIXTURE');
  write(path.join(pkg, 'README.md'), '# NON-NATIVE CONTROLLED SDK FIXTURE');
  const distribution = writeCooperativeDistribution(dist, { packageVersion: metadata.version });
  return {
    root, pkg, dist, leaf: dist, manifestPath: distribution.manifestPath,
    get manifest() { return distribution.manifest; },
    seal: distribution.seal, bindNativeHashes: distribution.bindNativeHashes,
    write, output: path.join(root, 'output'),
  };
}
function run(f, extra = []) {
  const result = spawnSync(process.execPath, [cli, '--package-root', f.pkg, '--built-dist', f.dist, '--output', f.output, ...extra], { encoding: 'utf8', timeout: 30000 });
  return { ...result, report: fs.existsSync(path.join(f.output, 'sdk-preview-report.json')) ? JSON.parse(fs.readFileSync(path.join(f.output, 'sdk-preview-report.json'))) : null };
}
test('rejects non-preview versions before staging and invalidates stale success', t => {
  const f = fixture(t);
  fs.mkdirSync(f.output);
  f.write(path.join(f.output, 'sdk-preview-report.json'), JSON.stringify({ status: 'passed', tarball: 'stale' }));
  const result = run(f, ['--version', '1.0.0']);
  assert.equal(result.status, 1);
  assert.equal(result.report.status, 'failed');
  assert.match(result.report.error, /version/i);
  assert.equal(result.report.tarball, null);
  assert.equal(result.report.stageRoot, null);
  assert.deepEqual(fs.readdirSync(f.output), ['sdk-preview-report.json']);
});
for (const extra of [['--unknown-option'], ['unexpected-positional']]) test('strict CLI rejection retains safe-destination failure evidence: ' + extra[0], t => {
  const f = fixture(t);
  f.write(path.join(f.output, 'sdk-preview-report.json'), JSON.stringify({ status: 'passed', tarball: 'stale' }));
  const result = run(f, extra);
  assert.equal(result.status, 1);
  assert.equal(result.report.status, 'failed');
  assert.match(result.report.error, /Unknown option|Unexpected argument/);
  assert.equal(result.report.stageRoot, null);
  assert.equal(result.report.tarball, null);
  assert.deepEqual(fs.readdirSync(f.output), ['sdk-preview-report.json']);
});
for (const [name, mutate, expected] of [
  ['missing sealed payload', f => fs.unlinkSync(path.join(f.leaf, f.manifest.files[0].path)), /ENOENT|sealed|missing payload/i],
  ['tampered sealed payload', f => f.write(path.join(f.leaf, f.manifest.files[0].path), 'tamper'), /sealed/i],
  ['escaping sealed path', f => { f.manifest.files[0].path = '../escape'; f.write(f.manifestPath, JSON.stringify(f.manifest)); }, /path/i],
  ['symlink payload', f => { const target = path.join(f.leaf, f.manifest.files[0].path); fs.unlinkSync(target); fs.symlinkSync(path.join(f.dist, 'index.js'), target); }, /symbolic/i],
  ['undeclared SDK file', f => f.write(path.join(f.dist, 'old.exe'), 'old'), /undeclared|inventory|unexpected|path/i],
  ['broken export', f => { const metadata = JSON.parse(fs.readFileSync(path.join(f.pkg, 'package.json'))); metadata.exports['./broker'].types = './dist/missing.d.ts'; f.write(path.join(f.pkg, 'package.json'), JSON.stringify(metadata)); }, /export/i],
  ['wrong native architecture', f => { const file = 'runtime/win32-x64/reshade/inject32.exe'; const bytes = fs.readFileSync(path.join(f.dist, file)); bytes.writeUInt16LE(0x8664, 68); f.write(path.join(f.dist, file), bytes); f.bindNativeHashes(); f.seal(); }, /architecture/i],
  ['native bytes differ from sealed identity', f => f.write(path.join(f.dist, 'runtime/win32-x64/reshade/inject.exe'), 'different'), /integrity|hash|payload/i],
  ['unsupported cooperative native capability', f => {
    const name = 'runtime/win32-x64/reshade/electron_game_overlay_runtime.build.json';
    const stamp = JSON.parse(fs.readFileSync(path.join(f.dist, name)));
    delete stamp.cooperativeAddonProtocol;
    f.write(path.join(f.dist, name), JSON.stringify(stamp)); f.seal();
  }, /cooperative|manifest/i],
  ['distribution version differs from its package', f => {
    f.manifest.packageVersion = '0.1.0-rc.999';
    f.write(f.manifestPath, JSON.stringify(f.manifest));
  }, /version|manifest/i],
]) test('rejects ' + name + ' before candidate creation', t => {
  const f = fixture(t);
  try { mutate(f); } catch (error) { if (name === 'symlink payload' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit owned fixture symlinks'); return; } throw error; }
  const result = run(f);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.report.status, 'failed');
  assert.match(result.report.error, expected);
  assert.equal(result.report.stageRoot, null);
  assert.equal(result.report.tarball, null);
});
test('refuses output inside built dist without changing the source tree', t => {
  const f = fixture(t);
  const before = fs.readdirSync(f.dist).sort();
  f.output = path.join(f.dist, 'candidate');
  const result = run(f);
  assert.equal(result.status, 1);
  assert.deepEqual(fs.readdirSync(f.dist).sort(), before);
});
for (const [name, argumentsFor] of [
  ['equals-form source options', f => ['--package-root=' + f.pkg, '--built-dist=' + f.dist, '--output', path.join(f.dist, 'candidate')]],
  ['repeated package-root option', f => ['--package-root', path.join(f.root, 'decoy'), '--package-root', f.pkg, '--built-dist', f.dist, '--output', path.join(f.pkg, 'candidate')]],
  ['repeated built-dist option', f => {
    const dist = path.join(f.root, 'built-dist');
    fs.renameSync(f.dist, dist);
    return ['--package-root', f.pkg, '--built-dist', path.join(f.root, 'decoy'), '--built-dist', dist, '--output', path.join(dist, 'candidate')];
  }],
]) test('refuses overlap through ' + name + ' without any input writes', t => {
  const f = fixture(t);
  const args = argumentsFor(f);
  function snapshot(root) {
    return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [entry.name, entry.isDirectory() ? snapshot(path.join(root, entry.name)) : hash(fs.readFileSync(path.join(root, entry.name)))]);
  }
  const before = hash(JSON.stringify(snapshot(f.root)));
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(hash(JSON.stringify(snapshot(f.root))), before, 'input directory layout and every file byte must remain unchanged');
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.match(report.error, /overlap/i);
  assert.equal(report.stageRoot, null);
  assert.equal(report.tarball, null);
});
test('packs a non-native controlled fixture with real npm and staged public metadata only', t => {
  const f = fixture(t);
  f.write(path.join(f.pkg, 'secret.txt'), 'not distributable');
  f.write(path.join(f.pkg, 'scripts/postinstall.js'), 'throw Error()');
  const before = fs.readFileSync(path.join(f.pkg, 'package.json'));
  const manifest = fs.readFileSync(f.manifestPath);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.status, 'passed');
  assert.equal(result.report.nativeExecuted, false);
  assert.equal(result.report.version, '0.1.0-rc.7');
  assert.ok(fs.statSync(result.report.tarball).size > 0);
  const stage = result.report.stageRoot;
  const metadata = JSON.parse(fs.readFileSync(path.join(stage, 'package.json')));
  assert.equal(metadata.private, false);
  assert.equal(metadata.version, '0.1.0-rc.7');
  assert.equal(metadata.exports['.'].gelectron, undefined);
  assert.equal(metadata.types, './dist/index.d.ts');
  assert.equal(metadata.scripts, undefined);
  assert.deepEqual(fs.readFileSync(path.join(f.pkg, 'package.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(stage, 'dist/overlay-manifest.json')), manifest);
  const listing = spawnSync('tar', ['-tzf', result.report.tarball], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const files = listing.stdout.trim().split(/\r?\n/).sort();
  assert.deepEqual(files, result.report.packFiles.map(file => 'package/' + file).sort());
  for (const entry of f.manifest.files) assert.ok(files.includes('package/dist/' + entry.path), entry.path);
  assert.ok(files.includes('package/LICENSE'));
  assert.ok(files.includes('package/README.md'));
  assert.ok(files.includes('package/dist/runtime/THIRD-PARTY-NOTICES.txt'));
  assert.ok(files.includes('package/dist/node_modules/tslib/CopyrightNotice.txt'));
  assert.ok(!files.some(file => file.startsWith('package/dist/broker/')));
  assert.ok(!files.some(file => /secret|postinstall|old\.exe|\/tests\//.test(file)));
});

test('candidate version override changes only staged package and seal metadata', t => {
  const f = fixture(t);
  const sourceMetadata = fs.readFileSync(path.join(f.pkg, 'package.json'));
  const sourceManifest = fs.readFileSync(f.manifestPath);
  const result = run(f, ['--version', '0.1.0-rc.8']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const stage = result.report.stageRoot;
  assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'package.json'))).version, '0.1.0-rc.8');
  const stagedManifest = JSON.parse(fs.readFileSync(path.join(stage, 'dist/overlay-manifest.json')));
  assert.equal(stagedManifest.packageVersion, '0.1.0-rc.8');
  assert.deepEqual(stagedManifest.files, f.manifest.files);
  assert.deepEqual(fs.readFileSync(path.join(f.pkg, 'package.json')), sourceMetadata);
  assert.deepEqual(fs.readFileSync(f.manifestPath), sourceManifest);
  assert.equal(result.report.sourceManifestSha256, hash(sourceManifest));
  assert.equal(result.report.manifestSha256, hash(fs.readFileSync(path.join(stage, 'dist/overlay-manifest.json'))));
});

test('source snapshot provenance rejects substituted artifacts before distribution', t => {
  const f=fixture(t),file=path.join(f.root,'provenance.json');
  const prov={schemaVersion:2,version:'0.1.0-rc.7',baseCommit:'1'.repeat(40),workingTreeDirty:true,
    sourceSnapshot:{file:'source.zip',sha256:'0'.repeat(64)},sourceManifest:{file:'sources.json',sha256:'0'.repeat(64)}};
  f.write(file,JSON.stringify(prov));f.write(path.join(f.root,'source.zip'),'substituted bytes');
  const result=run(f,['--source-provenance',file]);
  assert.equal(result.status,1);assert.match(result.report.error,/source provenance.*SHA-256/i);
  assert.equal(result.report.stageRoot,null);
});
test('source provenance cannot label a dirty snapshot as a committed source', t => {
  const f=fixture(t),file=path.join(f.root,'provenance.json');f.write(file,'{}');
  const result=run(f,['--source-provenance',file,'--source-commit','1'.repeat(40)]);
  assert.equal(result.status,1);assert.match(result.report.error,/not both/);
});


test('dirty-source provenance is included in the actual npm archive', t => {
  const f=fixture(t), file=path.join(f.root,'provenance.json');
  const snapshot=Buffer.from('controlled source archive fixture'), manifest=Buffer.from('controlled manifest fixture');
  f.write(path.join(f.root,'source.zip'),snapshot);f.write(path.join(f.root,'sources.json'),manifest);
  const provenance={schemaVersion:2,version:'0.1.0-rc.7',baseCommit:'1'.repeat(40),workingTreeDirty:true,
    sourceSnapshot:{file:'source.zip',sha256:hash(snapshot)},sourceManifest:{file:'sources.json',sha256:hash(manifest)}};
  f.write(file,JSON.stringify(provenance));
  const result=run(f,['--source-provenance',file]);assert.equal(result.status,0,result.stdout);
  assert.ok(result.report.packFiles.includes('SDK_PROVENANCE.json'));
  const actual=JSON.parse(spawnSync('tar',['-xOzf',result.report.tarball,'package/SDK_PROVENANCE.json'],{encoding:'utf8'}).stdout);
  assert.deepEqual(actual.sourceSnapshot,provenance.sourceSnapshot);assert.equal(actual.workingTreeDirty,true);
  assert.equal(actual.sourceCommit,undefined);assert.equal(actual.native.length,2);
});
