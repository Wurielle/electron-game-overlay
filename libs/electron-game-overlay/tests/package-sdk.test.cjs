'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
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
  for (const name of ['index.js', 'broker.js']) write(path.join(dist, name), 'module.exports = {};\n');
  for (const name of ['index.d.ts', 'broker.d.ts']) write(path.join(dist, name), 'export {};\n');
  // Parser-only headers, never executable or evidence of genuine Windows/native execution.
  const pe = machine => { const bytes = Buffer.alloc(128); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(machine, 68); return bytes; };
  const leaf = path.join(dist, 'broker/win32-x64');
  write(path.join(leaf, 'electron-game-overlay-broker.exe'), pe(0x8664));
  for (const [name, machine] of [['electron_game_overlay_reshade_manager.exe', 0x8664], ['electron_game_overlay_reshade_manager32.exe', 0x14c], ['inject.exe', 0x8664], ['inject32.exe', 0x14c], ['electron_game_overlay.addon64', 0x8664], ['electron_game_overlay.addon32', 0x14c], ['ReShade64.dll', 0x8664], ['ReShade32.dll', 0x14c]]) {
    for (const base of [dist, leaf]) write(path.join(base, 'runtime/win32-x64/reshade', name), pe(machine));
  }
  for (const base of [dist, leaf]) write(path.join(base, 'runtime/THIRD-PARTY-NOTICES.txt'), 'Controlled native notice');
  write(path.join(leaf, 'node_modules/tslib/package.json'), JSON.stringify({ name: 'tslib', version: '2.8.1', main: 'tslib.js' }));
  write(path.join(leaf, 'node_modules/tslib/tslib.js'), '// controlled dependency');
  write(path.join(leaf, 'node_modules/tslib/LICENSE.txt'), 'controlled dependency notice');
  const files = [];
  function walk(dir, prefix = '') { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const relative = prefix + entry.name; if (entry.isDirectory()) walk(path.join(dir, entry.name), relative + '/'); else { const bytes = fs.readFileSync(path.join(dir, entry.name)); files.push({ path: relative, size: bytes.length, sha256: hash(bytes) }); } } }
  walk(leaf);
  const manifest = { schema: 1, version: '0.0.1', protocolMin: 1, protocolMax: 1, platform: 'win32', arch: 'x64', executable: 'electron-game-overlay-broker.exe', files };
  const manifestPath = path.join(leaf, 'broker-manifest.json');
  write(manifestPath, JSON.stringify(manifest));
  return { root, pkg, dist, leaf, manifest, manifestPath, write, output: path.join(root, 'output') };
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
  ['missing sealed payload', f => fs.unlinkSync(path.join(f.leaf, f.manifest.files[0].path)), /ENOENT|sealed/i],
  ['tampered sealed payload', f => f.write(path.join(f.leaf, f.manifest.files[0].path), 'tamper'), /sealed/i],
  ['escaping sealed path', f => { f.manifest.files[0].path = '../escape'; f.write(f.manifestPath, JSON.stringify(f.manifest)); }, /path/i],
  ['symlink payload', f => { const target = path.join(f.leaf, f.manifest.files[0].path); fs.unlinkSync(target); fs.symlinkSync(path.join(f.dist, 'index.js'), target); }, /symbolic/i],
  ['undeclared broker file', f => f.write(path.join(f.leaf, 'old.exe'), 'old'), /undeclared/i],
  ['broken export', f => { const metadata = JSON.parse(fs.readFileSync(path.join(f.pkg, 'package.json'))); metadata.exports['./broker'].types = './dist/missing.d.ts'; f.write(path.join(f.pkg, 'package.json'), JSON.stringify(metadata)); }, /export/i],
  ['wrong native architecture', f => { const file = 'runtime/win32-x64/reshade/inject32.exe'; const bytes = fs.readFileSync(path.join(f.leaf, file)); bytes.writeUInt16LE(0x8664, 68); for (const base of [f.dist, f.leaf]) f.write(path.join(base, file), bytes); const entry = f.manifest.files.find(e => e.path === file); entry.sha256 = hash(bytes); f.write(f.manifestPath, JSON.stringify(f.manifest)); }, /architecture/i],
  ['root native identity differs', f => f.write(path.join(f.dist, 'runtime/win32-x64/reshade/inject.exe'), 'different'), /identity/i],
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
  f.write(path.join(f.dist, 'old.exe'), 'obsolete');
  f.write(path.join(f.dist, 'tests/leak.js'), 'not distributable');
  const before = fs.readFileSync(path.join(f.pkg, 'package.json'));
  const manifest = fs.readFileSync(f.manifestPath);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.status, 'passed');
  assert.equal(result.report.nativeExecuted, false);
  assert.equal(result.report.version, '0.1.0-rc.1');
  assert.ok(fs.statSync(result.report.tarball).size > 0);
  const stage = result.report.stageRoot;
  const metadata = JSON.parse(fs.readFileSync(path.join(stage, 'package.json')));
  assert.equal(metadata.private, false);
  assert.equal(metadata.version, '0.1.0-rc.1');
  assert.equal(metadata.exports['.'].gelectron, undefined);
  assert.equal(metadata.types, './dist/index.d.ts');
  assert.equal(metadata.scripts, undefined);
  assert.deepEqual(fs.readFileSync(path.join(f.pkg, 'package.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(stage, 'dist/broker/win32-x64/broker-manifest.json')), manifest);
  const listing = spawnSync('tar', ['-tzf', result.report.tarball], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const files = listing.stdout.trim().split(/\r?\n/).sort();
  assert.deepEqual(files, result.report.packFiles.map(file => 'package/' + file).sort());
  for (const entry of f.manifest.files) assert.ok(files.includes('package/dist/broker/win32-x64/' + entry.path), entry.path);
  assert.ok(files.includes('package/LICENSE'));
  assert.ok(files.includes('package/README.md'));
  assert.ok(files.includes('package/dist/runtime/THIRD-PARTY-NOTICES.txt'));
  assert.ok(!files.some(file => /secret|postinstall|old\.exe|\/tests\//.test(file)));
});
