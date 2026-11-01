'use strict';
// Offline npm/JSON/passive-PE fixtures only. No SDK/native/Electron code runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { inspectSdk, packageInstalledCooperativePair, verifyInstalledParticipant, main } = require('../scripts/package-installed-cooperative-pair.cjs');
const { writeCooperativeDistribution } = require('../../../libs/electron-game-overlay/tests/helpers/cooperative-package-fixture.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const cli = path.resolve(__dirname, '../scripts/package-installed-cooperative-pair.cjs');
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function snapshot(root) {
  function visit(directory, prefix = '') {
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1).flatMap(entry => {
      const relative = prefix + entry.name;
      return entry.isDirectory() ? visit(path.join(directory, entry.name), relative + '/') : [{ path: relative, sha256: hash(fs.readFileSync(path.join(directory, entry.name))) }];
    });
  }
  return hash(JSON.stringify(visit(root)));
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cooperative-npm-pair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = {};
  for (const [id, build, generation] of [['a', 'A8E9DA12477741B9979D9B1B51994EF3', 8], ['b', 'E16461475E524DBA83398B19CDD95EBB', 11]]) {
    const sdk = path.join(root, 'source-' + id);
    const metadata = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../libs/electron-game-overlay/package.json'), 'utf8'));
    metadata.scripts = { prepack: 'node must-never-run.cjs', install: 'node must-never-run.cjs' };
    write(path.join(sdk, 'package.json'), JSON.stringify(metadata));
    write(path.join(sdk, 'LICENSE'), 'NON-NATIVE CONTROLLED GPL FIXTURE');
    write(path.join(sdk, 'README.md'), '# Controlled development packaging fixture');
    const distribution = writeCooperativeDistribution(path.join(sdk, 'dist'), { addonBuildId: build, runtimeGeneration: generation });
    distribution.write('index.js', "throw new Error('INCOMING SDK MUST NEVER EXECUTE');\n");
    for (const bits of [64, 32]) {
      const relative = 'runtime/win32-x64/reshade/electron_game_overlay.addon' + bits;
      distribution.write(relative, Buffer.concat([fs.readFileSync(path.join(sdk, 'dist', relative)), Buffer.from('PASSIVE FIXTURE ' + build)]));
    }
    distribution.bindNativeHashes(); distribution.seal();
    sources[id] = { sdk, ...distribution };
  }
  return { root, ...sources, options: { sdkA: sources.a.sdk, sdkB: sources.b.dist, versionA: '0.1.0-development.gen8.fixture', versionB: '0.1.0-development.gen11.fixture', output: path.join(root, 'new-output') } };
}

test('real offline npm pack/install yields two valid independent DEVELOPMENT packages with exact original payloads', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const beforeA = snapshot(f.a.sdk), beforeB = snapshot(f.b.sdk);
  const report = await packageInstalledCooperativePair(f.options);
  assert.equal(report.status, 'passed');
  assert.equal(report.developmentOnly, true);
  assert.equal(report.independentlyReleasedPackagesVerified, false);
  assert.equal(report.nativeExecuted, false);
  assert.equal(report.commands.length, 4);
  assert.deepEqual(report.commands.map(command => command.args[1]), ['pack', 'install', 'pack', 'install']);
  assert.ok(report.commands.every(command => command.exit === 0 && command.args.includes('--offline') && command.args.includes('--ignore-scripts')));
  assert.notEqual(report.participants.a.packageRoot, report.participants.b.packageRoot);
  assert.notEqual(report.participants.a.packageLock, report.participants.b.packageLock);
  for (const [id, source] of [['a', f.a], ['b', f.b]]) {
    const participant = report.participants[id];
    const installed = participant.packageRoot;
    assert.equal(participant.resolvedMain, path.join(installed, 'dist/index.js'));
    assert.equal(participant.installedManifestSha256, participant.stagedManifestSha256);
    assert.notEqual(participant.sourceManifestSha256, participant.stagedManifestSha256);
    assert.equal(participant.tarballSha256, hash(fs.readFileSync(participant.tarball)));
    assert.deepEqual(fs.readFileSync(path.join(installed, 'SOURCE_OVERLAY_MANIFEST.json')), fs.readFileSync(source.manifestPath));
    assert.deepEqual(fs.readFileSync(path.join(installed, 'SOURCE_PACKAGE.json')), fs.readFileSync(path.join(source.sdk, 'package.json')));
    const original = JSON.parse(fs.readFileSync(source.manifestPath));
    const graph = original.files.filter(entry => entry.path.endsWith('.js')).map(entry => ({ path: entry.path, bytes: entry.size, sha256: entry.sha256 }));
    assert.equal(participant.javascriptGraphSha256, hash(JSON.stringify(graph)), 'uses the same graph representation as game evidence, including dependencies');
    const derived = JSON.parse(fs.readFileSync(path.join(installed, 'dist/overlay-manifest.json')));
    assert.deepEqual({ ...derived, packageVersion: original.packageVersion }, original, 'copied seal changes only the package version field');
    for (const entry of original.files) assert.deepEqual(fs.readFileSync(path.join(installed, 'dist', entry.path)), fs.readFileSync(path.join(source.dist, entry.path)), entry.path);
    const metadata = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')));
    assert.equal(metadata.version, participant.version);
    assert.equal(metadata.dependencies.tslib, '^2.8.1');
    assert.equal(metadata.scripts, undefined);
    assert.equal(metadata.exports['.'].gelectron, undefined);
    assert.equal(fs.existsSync(path.join(participant.consumerRoot, 'node_modules/electron')), false);
    const provenance = JSON.parse(fs.readFileSync(path.join(installed, 'SDK_PROVENANCE.json')));
    assert.equal(provenance.source.overlayManifestSha256, participant.sourceManifestSha256);
    assert.equal(provenance.transform.sealedPayloadBytesChanged, false);
    assert.equal(provenance.independentlyReleasedPackage, false);
  }
  assert.equal(snapshot(f.a.sdk), beforeA);
  assert.equal(snapshot(f.b.sdk), beforeB);
  assert.equal(JSON.parse(fs.readFileSync(report.reportPath)).status, 'passed');

  for (const [name, relative, expected] of [
    ['installed implementation', 'dist/index.js', /hash\/size|sealed/i],
    ['retained source seal', 'SOURCE_OVERLAY_MANIFEST.json', /source evidence/i],
    ['provenance', 'SDK_PROVENANCE.json', /provenance/i],
    ['bundled dependency', 'node_modules/tslib/tslib.js', /bundled dependency/i],
    ['package license', 'LICENSE', /differs from npm stage/i],
  ]) await t.test('rejects substituted ' + name, async () => {
    const file = path.join(report.participants.a.packageRoot, relative), bytes = fs.readFileSync(file);
    fs.writeFileSync(file, 'tampered fixture bytes');
    try { await assert.rejects(verifyInstalledParticipant(report.participants.a, inspectSdk(f.a.sdk)), expected); }
    finally { fs.writeFileSync(file, bytes); }
  });
  await t.test('lockfile version/integrity must identify its own archive', async () => {
    const file = report.participants.a.packageLock, bytes = fs.readFileSync(file), lock = JSON.parse(bytes);
    lock.packages['node_modules/electron-game-overlay'].integrity = 'sha512-fake';
    fs.writeFileSync(file, JSON.stringify(lock));
    try { await assert.rejects(verifyInstalledParticipant(report.participants.a, inspectSdk(f.a.sdk)), /lockfile/); }
    finally { fs.writeFileSync(file, bytes); }
  });
  await t.test('lockfile cannot redirect to a peer archive with a claimed matching integrity', async () => {
    const file = report.participants.a.packageLock, bytes = fs.readFileSync(file), lock = JSON.parse(bytes);
    lock.packages['node_modules/electron-game-overlay'].resolved = 'file:../archives/b/peer.tgz';
    fs.writeFileSync(file, JSON.stringify(lock));
    try { await assert.rejects(verifyInstalledParticipant(report.participants.a, inspectSdk(f.a.sdk)), /archive path/); }
    finally { fs.writeFileSync(file, bytes); }
  });
  await t.test('installed packages reject unlisted files even outside sealed dist', async () => {
    const file = path.join(report.participants.a.packageRoot, 'outside-dist.cjs');
    fs.writeFileSync(file, 'throw new Error("never execute")');
    try { await assert.rejects(verifyInstalledParticipant(report.participants.a, inspectSdk(f.a.sdk)), /file inventory/); }
    finally { fs.unlinkSync(file); }
  });
});

test('versions must be distinct explicit development prereleases', async t => {
  const f = fixture(t);
  for (const versions of [['0.1.0', f.options.versionB], ['0.1.0-rc.8', f.options.versionB], [f.options.versionA, f.options.versionA]]) {
    await assert.rejects(packageInstalledCooperativePair({ ...f.options, versionA: versions[0], versionB: versions[1] }), /development/);
    assert.equal(fs.existsSync(f.options.output), false);
  }
});
test('different labels cannot disguise the same implementation', async t => {
  const f = fixture(t);
  fs.rmSync(f.b.sdk, { recursive: true }); fs.cpSync(f.a.sdk, f.b.sdk, { recursive: true });
  await assert.rejects(packageInstalledCooperativePair(f.options), /Distinct JavaScript and native/);
  assert.equal(fs.existsSync(f.options.output), false);
});
test('source escape, missing exports and tampered sealed bytes fail before any output writes', async t => {
  const f = fixture(t);
  const file = path.join(f.a.sdk, 'package.json'), original = fs.readFileSync(file), metadata = JSON.parse(original);
  metadata.exports['.'].require = '../outside.cjs'; fs.writeFileSync(file, JSON.stringify(metadata));
  await assert.rejects(packageInstalledCooperativePair(f.options), /export/);
  fs.writeFileSync(file, original);
  f.a.write('index.js', 'tampered source');
  await assert.rejects(packageInstalledCooperativePair(f.options), /hash\/size|sealed/i);
  assert.equal(fs.existsSync(f.options.output), false);
});
test('output overlap and an existing output preserve all input and prior evidence', async t => {
  const f = fixture(t), before = snapshot(f.a.sdk);
  for (const output of [f.a.sdk, path.join(f.a.dist, 'child'), f.root]) await assert.rejects(packageInstalledCooperativePair({ ...f.options, output }), /overlap/);
  assert.equal(snapshot(f.a.sdk), before);
  fs.mkdirSync(f.options.output); write(path.join(f.options.output, 'report.json'), '{"status":"retained"}');
  await assert.rejects(packageInstalledCooperativePair(f.options), /new and absent/);
  assert.equal(fs.readFileSync(path.join(f.options.output, 'report.json'), 'utf8'), '{"status":"retained"}');
});
test('junction inputs and output ancestors cannot redirect packaging writes', async t => {
  const f = fixture(t), link = path.join(f.root, 'source-alias');
  try { fs.symlinkSync(f.a.sdk, link, 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Owned junction creation unavailable'); return; } throw error; }
  await assert.rejects(packageInstalledCooperativePair({ ...f.options, sdkA: link }), /Symbolic|junction/);
  await assert.rejects(packageInstalledCooperativePair({ ...f.options, output: path.join(link, 'outside') }), /Symbolic|junction/);
  assert.equal(fs.existsSync(path.join(f.a.sdk, 'outside')), false);
});
test('strict CLI rejects unknown, missing and positional arguments before writes', async t => {
  const f = fixture(t);
  await assert.rejects(main(['--sdk-a', f.a.sdk]), /required/);
  for (const extra of [['--unknown-option'], ['unexpected-positional']]) {
    const result = spawnSync(process.execPath, [cli, '--sdk-a', f.a.sdk, '--sdk-b', f.b.sdk, '--version-a', f.options.versionA, '--version-b', f.options.versionB, '--output', f.options.output, ...extra], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option|Unexpected argument/);
    assert.equal(fs.existsSync(f.options.output), false);
  }
});
