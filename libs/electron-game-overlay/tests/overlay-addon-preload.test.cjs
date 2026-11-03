'use strict';
// Controlled filesystem/parser coverage; inert PE records do not establish game acceptance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
require('./helpers/source-packaging-loader.cjs');
const { writeCooperativeDistribution } = require('./helpers/cooperative-package-fixture.cjs');
const trustedValidator = require('../dist/lib/overlay-package-manifest.js');

function loadSource(relative, compiledOverride) {
  const source = path.resolve(__dirname, '../src', relative + '.ts');
  const compiled = compiledOverride ?? path.resolve(__dirname, '../dist', relative + '.js');
  const result = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    fileName: source,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const loaded = new Module(compiled, module);
  loaded.filename = compiled;
  loaded.paths = Module._nodeModulePaths(path.dirname(compiled));
  const originalLoad = Module._load;
  Module._load = function(request, parent, ...args) {
    if (parent?.filename === compiled && request === './overlay-package-manifest.js') return trustedValidator;
    return originalLoad.call(this, request, parent, ...args);
  };
  try { loaded._compile(result.outputText, compiled); }
  finally { Module._load = originalLoad; }
  loaded.loaded = true;
  require.cache[compiled] = loaded;
  return loaded.exports;
}
const api = loadSource('lib/overlay-addon-preload');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-addon-preload-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const storageRoot = path.join(directory, 'registry');
  const packageRoot = path.join(directory, 'sdk');
  const payload = writeCooperativeDistribution(path.join(packageRoot, 'dist'));
  enablePreload(payload);
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'electron-game-overlay', version: '0.1.0-rc.7' }));
  const register = applicationId => api.registerOverlayAddonInstallation({ applicationId, packageRoot, storageRoot });
  const select = (applicationId, installation) => api.resolveAddonPreloadSelection({ applicationId, storageRoot }, installation);
  return { directory, storageRoot, packageRoot, payload, register, select };
}

function enablePreload(payload) {
  for (const suffix of ['', '32']) {
    const file = `runtime/win32-x64/reshade/electron_game_overlay_runtime${suffix}.build.json`;
    const stamp = JSON.parse(fs.readFileSync(path.join(payload.dist, file), 'utf8'));
    stamp.addonPreloadProtocol = 1;
    payload.write(file, JSON.stringify(stamp));
  }
  payload.seal();
}

test('preload installer entrypoint uses no Electron runtime and exports installer functions', () => {
  const original = Module._load;
  Module._load = function(request, ...args) {
    assert.notEqual(request, 'electron');
    if (request === './lib/overlay-addon-preload.js') return api;
    return original.call(this, request, ...args);
  };
  try {
    const exported = loadSource('preload');
    assert.equal(exported.defaultReShadeAddonDirectory, api.defaultReShadeAddonDirectory);
    assert.equal(exported.registerOverlayAddonInstallation, api.registerOverlayAddonInstallation);
    assert.equal(exported.unregisterOverlayAddonInstallation, api.unregisterOverlayAddonInstallation);
  } finally { Module._load = original; }
});

test('default shared directory belongs to the current account and ignores application environment overrides', () => {
  const previous = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = path.join(os.tmpdir(), 'untrusted-electron-environment');
    const expected = path.join(os.userInfo().homedir, 'AppData', 'Local', 'ReShade', 'Addons');
    assert.equal(api.defaultReShadeAddonDirectory(), expected);
    assert.equal(api.defaultOverlayAddonStorageRoot(), expected);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
});

test('addonDirectory and its storageRoot alias select one catalog and cannot be combined', async t => {
  const f = fixture(t);
  const a = await api.registerOverlayAddonInstallation({ applicationId: 'com.example.a', packageRoot: f.packageRoot, addonDirectory: f.storageRoot });
  assert.equal(a.addonDirectory, fs.realpathSync(f.storageRoot));
  assert.deepEqual(await f.register('com.example.a'), a);
  assert.equal(api.resolveAddonPreloadSelection({ applicationId: 'com.example.a', addonDirectory: f.storageRoot }, a).directory, a.addonDirectory);
  await assert.rejects(api.registerOverlayAddonInstallation({ applicationId: 'com.example.a', packageRoot: f.packageRoot,
    addonDirectory: f.storageRoot, storageRoot: f.storageRoot }), /not both/);
  await assert.rejects(api.unregisterOverlayAddonInstallation({ applicationId: 'com.example.a', addonDirectory: f.storageRoot,
    storageRoot: f.storageRoot }), /not both/);
  assert.throws(() => api.resolveAddonPreloadSelection({ applicationId: 'com.example.a', addonDirectory: f.storageRoot,
    storageRoot: f.storageRoot }, a), /not both/);
  for (const invalid of ['relative', path.join(f.directory, 'bad\npath')]) {
    await assert.rejects(api.registerOverlayAddonInstallation({ applicationId: 'com.example.a', packageRoot: f.packageRoot,
      addonDirectory: invalid }), /absolute INI-safe/);
  }
});

test('default registration from ASAR uses the complete SDK restored by the existing afterPack hook', async t => {
  const f = fixture(t);
  const resources = path.join(f.directory, 'app', 'resources');
  const physical = path.join(resources, 'app.asar.unpacked', 'node_modules', 'electron-game-overlay');
  fs.mkdirSync(path.dirname(physical), { recursive: true });
  fs.cpSync(f.packageRoot, physical, { recursive: true });
  const virtualFilename = path.join(resources, 'app.asar', 'node_modules', 'electron-game-overlay', 'dist', 'lib', 'overlay-addon-preload.js');
  const packagedApi = loadSource('lib/overlay-addon-preload', virtualFilename);
  const registration = await packagedApi.registerOverlayAddonInstallation({ applicationId: 'com.example.packaged', storageRoot: f.storageRoot });
  assert.ok(fs.existsSync(registration.addonPath));
  assert.deepEqual(fs.readFileSync(registration.addonPath), fs.readFileSync(path.join(physical, 'dist', 'runtime', 'win32-x64', 'reshade', 'electron_game_overlay.addon64')));
});

test('stripped public declarations expose the preload descriptor without implementation inventory', t => {
  const temporary = fs.mkdtempSync(path.resolve(__dirname, '../.preload-types-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }));
  const compiler = require.resolve('typescript/bin/tsc');
  const out = path.join(temporary, 'types');
  const emitted = spawnSync(process.execPath, [compiler, '--project', path.resolve(__dirname, '../tsconfig.lib.json'),
    '--emitDeclarationOnly', '--declaration', 'true', '--declarationMap', 'false', '--composite', 'false',
    '--incremental', 'false', '--outDir', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
  const declarations = fs.readFileSync(path.join(out, 'lib', 'overlay-addon-preload.d.ts'), 'utf8');
  assert.doesNotMatch(declarations, /export interface OverlayAddonPreloadSelection/);
  assert.doesNotMatch(fs.readFileSync(path.join(out, 'lib', 'reshade-launcher.d.ts'), 'utf8'), /OverlayAddonPreloadSelection/);
  const consumer = path.join(temporary, 'consumer.ts');
  fs.writeFileSync(consumer, `import type {} from 'electron';\nimport type { ReShadeLaunchConfig } from './types/lib/reshade-launcher.js';\n` +
    `import type { OverlayAddonPreloadOptions } from './types/preload.js';\n` +
    `declare const config: ReShadeLaunchConfig;\n` +
    `const options: OverlayAddonPreloadOptions = { applicationId: 'com.example.consumer' };\n` +
    `if (config.addonPreload) {\n const app: string = config.addonPreload.applicationId;\n` +
    ` const storage: string | undefined = config.addonPreload.storageRoot;\n const directory: string | undefined = config.addonPreload.addonDirectory;\n void app; void storage; void directory;\n}\nvoid options;\n`);
  const consumerConfig = path.join(temporary, 'tsconfig.consumer.json');
  fs.writeFileSync(consumerConfig, JSON.stringify({ compilerOptions: { noEmit: true, strict: true,
    skipLibCheck: false, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'] }, files: ['consumer.ts'] }));
  const checked = spawnSync(process.execPath, [compiler, '--project', consumerConfig],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test('registration is idempotent per application/native content and separate apps retain distinct immutable DLLs', async t => {
  const f = fixture(t);
  f.payload.write('index.js', 'throw new Error("Never execute an installer source SDK");\n');
  f.payload.seal();
  const a = await f.register('com.example.a');
  const again = await f.register('com.example.a');
  const b = await f.register('com.example.b');
  assert.deepEqual(again, a);
  assert.notEqual(a.registrationId, b.registrationId);
  assert.notEqual(a.addonPath, b.addonPath);
  assert.match(path.basename(a.addonPath), /^ego-preload-[0-9a-f]{32}-[0-9A-F]{32}-[0-9a-f]{16}\.addon64$/);
  assert.match(path.basename(a.x86AddonPath), /\.addon32$/);
  assert.ok(Object.isFrozen(a));
  assert.equal(path.dirname(a.addonPath), a.addonDirectory);
  assert.equal(path.dirname(b.addonPath), a.addonDirectory);
  assert.equal(fs.readdirSync(f.storageRoot).filter(name => /\.addon(?:32|64)$/.test(name)).length, 4);
  assert.equal(fs.readdirSync(f.storageRoot).some(name => name.startsWith('.ego-preload-')), false);
  assert.equal(fs.existsSync(path.join(f.storageRoot, 'payloads')), false);
});

test('concurrent installers publish every independent registration without lost updates', async t => {
  const f = fixture(t);
  const registrations = await Promise.all(Array.from({ length: 8 }, (_, i) => f.register('com.example.app' + i)));
  const selected = f.select('com.example.app0', registrations[0]);
  assert.equal(selected.payloads.length, 16);
  assert.equal(new Set(registrations.map(item => item.registrationId)).size, 8);
});

test('stable shared files cover both architectures and offline apps; unregister disables future owned hosts', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  const b = await f.register('com.example.b');
  const selected = f.select('com.example.a', a);
  assert.ok(Object.isFrozen(selected));
  assert.equal(selected.directory, fs.realpathSync(f.storageRoot));
  assert.ok(Object.isFrozen(selected.payloads));
  assert.equal(selected.addonPath, a.addonPath);
  assert.equal(selected.x86AddonPath, a.x86AddonPath);
  assert.deepEqual(selected.inactiveFileNames, []);
  const before = new Map([a.addonPath, a.x86AddonPath, b.addonPath, b.x86AddonPath].map(file => [file, {
    bytes: fs.readFileSync(file), stat: fs.statSync(file),
  }]));
  await api.unregisterOverlayAddonInstallation({ applicationId: 'com.example.b', registrationId: b.registrationId, storageRoot: f.storageRoot });
  const next = f.select('com.example.a', a);
  assert.equal(next.directory, selected.directory);
  assert.equal(next.payloads.length, 2);
  assert.deepEqual(next.inactiveFileNames, [path.basename(b.addonPath), path.basename(b.x86AddonPath)].sort());
  assert.ok(Object.isFrozen(next.inactiveFileNames));
  assert.deepEqual(selected.inactiveFileNames, [], 'earlier host configuration selection remains unchanged');
  for (const [file, original] of before) {
    assert.deepEqual(fs.readFileSync(file), original.bytes);
    const now = fs.statSync(file);
    assert.equal(now.ino, original.stat.ino);
    assert.equal(now.mtimeMs, original.stat.mtimeMs);
  }
  assert.throws(() => f.select('com.example.b', b), /not registered/);
  assert.deepEqual(await f.register('com.example.b'), b, 'reinstall reuses retained immutable files');
  assert.deepEqual(f.select('com.example.a', a).inactiveFileNames, []);
});

test('ordinary foreign add-ons and their data coexist without registration or mutation', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.storageRoot);
  const names = ['another-library.addon64', 'another-library.addon32', 'portable.addon', 'readme.txt'];
  for (const name of names) fs.writeFileSync(path.join(f.storageRoot, name), 'foreign:' + name);
  fs.mkdirSync(path.join(f.storageRoot, 'other-library-data'));
  const before = new Map(names.map(name => [name, fs.readFileSync(path.join(f.storageRoot, name))]));
  const a = await f.register('com.example.a');
  const selection = f.select('com.example.a', a);
  assert.equal(selection.directory, fs.realpathSync(f.storageRoot));
  assert.equal(selection.payloads.length, 2, 'only EGO-owned registrations enter the verified inventory');
  assert.deepEqual(selection.inactiveFileNames, [], 'ordinary foreign add-ons retain normal ReShade loading');
  await api.unregisterOverlayAddonInstallation({ applicationId: 'com.example.a', addonDirectory: f.storageRoot });
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.storageRoot, name)), bytes);
  assert.ok(fs.statSync(path.join(f.storageRoot, 'other-library-data')).isDirectory());
});

test('orphaned reserved filenames are disabled without deleting them or ordinary foreign add-ons', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  const orphan = `ego-preload-${'b'.repeat(32)}-${'F'.repeat(32)}-${'a'.repeat(16)}.addon64`;
  fs.writeFileSync(path.join(f.storageRoot, orphan), 'incomplete registration retained on disk');
  fs.writeFileSync(path.join(f.storageRoot, 'foreign.addon64'), 'ordinary library');
  assert.deepEqual(f.select('com.example.a', a).inactiveFileNames, [orphan]);
  assert.equal(fs.readFileSync(path.join(f.storageRoot, orphan), 'utf8'), 'incomplete registration retained on disk');
});

test('registration never overwrites a pre-existing conflicting filename', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  const otherDirectory = path.join(f.directory, 'other-shared-directory');
  fs.mkdirSync(otherDirectory);
  const occupied = path.join(otherDirectory, path.basename(a.addonPath));
  fs.writeFileSync(occupied, 'pre-existing conflicting bytes');
  const before = fs.statSync(occupied);
  await assert.rejects(api.registerOverlayAddonInstallation({ applicationId: 'com.example.a', packageRoot: f.packageRoot,
    addonDirectory: otherDirectory }), /hash\/size/);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'pre-existing conflicting bytes');
  assert.equal(fs.statSync(occupied).ino, before.ino);
  assert.equal(fs.readdirSync(otherDirectory).some(name => name.startsWith('.ego-preload-')), false);
});

test('unregister scopes an explicit registration identity to its owning application', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  const b = await f.register('com.example.b');
  await api.unregisterOverlayAddonInstallation({ applicationId: 'com.example.a', registrationId: b.registrationId, storageRoot: f.storageRoot });
  assert.equal(f.select('com.example.a', a).payloads.length, 4);
  await api.unregisterOverlayAddonInstallation({ applicationId: 'com.example.a', storageRoot: f.storageRoot });
  assert.throws(() => f.select('com.example.a', a), /not registered/);
  assert.equal(f.select('com.example.b', b).payloads.length, 2);
});

test('same app can register distinct builds without matching package-version strings', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  const second = path.join(f.directory, 'sdk-next');
  enablePreload(writeCooperativeDistribution(path.join(second, 'dist'), { addonBuildId: 'A'.repeat(32), packageVersion: '0.1.0-rc.8' }));
  fs.writeFileSync(path.join(second, 'package.json'), JSON.stringify({ name: 'electron-game-overlay', version: '0.1.0-rc.8' }));
  const next = await api.registerOverlayAddonInstallation({ applicationId: 'com.example.a', packageRoot: second, storageRoot: f.storageRoot });
  assert.notEqual(a.registrationId, next.registrationId);
  assert.equal(f.select('com.example.a', a).payloads.length, 4);
  assert.equal(f.select('com.example.a', next).registrationId, next.registrationId);
  const wrong = { ...next, addonBuildId: 'B'.repeat(32) };
  assert.throws(() => f.select('com.example.a', wrong), /not registered/);
});

test('registration validates the complete sealed source before publishing any native payload', async t => {
  const f = fixture(t);
  f.payload.write('lib/module.js', 'tampered SDK');
  await assert.rejects(f.register('com.example.a'), /hash|size/i);
  assert.equal(fs.existsSync(f.storageRoot), false);
});

for (const bits of [64, 32]) test('registration rejects a sealed architecture without preload support: ' + bits, async t => {
  const f = fixture(t);
  const relative = `runtime/win32-x64/reshade/electron_game_overlay_runtime${bits === 64 ? '' : '32'}.build.json`;
  const stamp = JSON.parse(fs.readFileSync(path.join(f.payload.dist, relative), 'utf8'));
  delete stamp.addonPreloadProtocol;
  f.payload.write(relative, JSON.stringify(stamp));
  f.payload.seal();
  const expected = bits === 64
    ? /^Native add-on preload capability does not match the sealed SDK implementation: 64$/
    : /^Native architecture manifests disagree$/;
  await assert.rejects(f.register('com.example.a'), error => expected.test(error.message));
  assert.equal(fs.existsSync(f.storageRoot), false);
});

test('registration rejects disagreeing architecture build identities after resealing', async t => {
  const f = fixture(t);
  const relative = 'runtime/win32-x64/reshade/electron_game_overlay_runtime32.build.json';
  const stamp = JSON.parse(fs.readFileSync(path.join(f.payload.dist, relative), 'utf8'));
  stamp.addonBuildId = 'F'.repeat(32);
  f.payload.write(relative, JSON.stringify(stamp));
  f.payload.seal();
  await assert.rejects(f.register('com.example.a'), /native.*manifest|architectures|build identity/i);
  assert.equal(fs.existsSync(f.storageRoot), false);
});

test('selection compares full native payload hashes even when build identity is unchanged', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  const changed = path.join(f.directory, 'changed-native.addon64');
  fs.writeFileSync(changed, Buffer.concat([fs.readFileSync(a.addonPath), Buffer.from('different native body')]));
  assert.throws(() => f.select('com.example.a', { ...a, addonPath: changed }), /not registered/);
});

test('shared EGO payload tampering fails closed for idempotent install and future selection', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  fs.chmodSync(a.addonPath, 0o644);
  fs.appendFileSync(a.addonPath, 'tampered');
  await assert.rejects(f.register('com.example.a'), /hash|size/i);
  assert.throws(() => f.select('com.example.a', a), /not registered|hash|size/i);
  assert.equal(fs.readdirSync(f.storageRoot).some(name => name.startsWith('.ego-preload-')), false);
});

test('registry refuses unknown schema fields and never repairs or overwrites its immutable payloads', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  const file = path.join(f.storageRoot, '.electron-game-overlay', 'registrations.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.unknown = true;
  fs.writeFileSync(file, JSON.stringify(registry));
  await assert.rejects(f.register('com.example.a'), /registry/);
  await assert.rejects(api.unregisterOverlayAddonInstallation({ applicationId: 'com.example.a', storageRoot: f.storageRoot }), /registry/);
  assert.ok(fs.existsSync(a.addonPath));
});

test('directory junctions or symlinks cannot redirect the shared directory or metadata', async t => {
  const f = fixture(t);
  const target = path.join(f.directory, 'foreign');
  fs.mkdirSync(target);
  const redirected = path.join(f.directory, 'redirected');
  try { fs.symlinkSync(target, redirected, 'junction'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Directory links unavailable'); return; } throw error; }
  await assert.rejects(api.registerOverlayAddonInstallation({ applicationId: 'com.example.a', packageRoot: f.packageRoot, storageRoot: redirected }), /reparse|non-directory/);
  const a = await f.register('com.example.a');
  assert.throws(() => api.resolveAddonPreloadSelection({ applicationId: 'com.example.a', addonDirectory: redirected }, a), /reparse|non-directory/);
  const second = path.join(f.directory, 'second');
  fs.mkdirSync(second);
  fs.symlinkSync(target, path.join(second, '.electron-game-overlay'), 'junction');
  await assert.rejects(api.registerOverlayAddonInstallation({ applicationId: 'com.example.a', packageRoot: f.packageRoot,
    addonDirectory: second }), /reparse|non-directory/);
  assert.deepEqual(fs.readdirSync(target), []);
});
