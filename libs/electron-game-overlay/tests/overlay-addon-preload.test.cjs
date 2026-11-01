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
    assert.equal(exported.registerOverlayAddonInstallation, api.registerOverlayAddonInstallation);
    assert.equal(exported.unregisterOverlayAddonInstallation, api.unregisterOverlayAddonInstallation);
  } finally { Module._load = original; }
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

test('stripped public declarations retain the preload inventory type for downstream consumers', t => {
  const temporary = fs.mkdtempSync(path.resolve(__dirname, '../.preload-types-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }));
  const compiler = require.resolve('typescript/bin/tsc');
  const out = path.join(temporary, 'types');
  const emitted = spawnSync(process.execPath, [compiler, '--project', path.resolve(__dirname, '../tsconfig.lib.json'),
    '--emitDeclarationOnly', '--declaration', 'true', '--declarationMap', 'false', '--composite', 'false',
    '--incremental', 'false', '--outDir', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
  const declarations = fs.readFileSync(path.join(out, 'lib', 'overlay-addon-preload.d.ts'), 'utf8');
  assert.match(declarations, /export interface OverlayAddonPreloadSelection/);
  const consumer = path.join(temporary, 'consumer.ts');
  fs.writeFileSync(consumer, `import type {} from 'electron';\nimport type { ReShadeLaunchConfig } from './types/lib/reshade-launcher.js';\n` +
    `declare const config: ReShadeLaunchConfig;\nif (config.addonPreload) {\n` +
    ` const leaf: string = config.addonPreload.addonFileName;\n` +
    ` const hashes: string[] = config.addonPreload.payloads.map(item => item.sha256);\n` +
    ` void leaf; void hashes;\n}\n`);
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
  assert.equal(fs.readdirSync(path.join(f.storageRoot, 'payloads')).length, 2);
});

test('concurrent installers publish every independent registration without lost updates', async t => {
  const f = fixture(t);
  const registrations = await Promise.all(Array.from({ length: 8 }, (_, i) => f.register('com.example.app' + i)));
  const selected = f.select('com.example.app0', registrations[0]);
  assert.equal(selected.payloads.length, 16);
  assert.equal(new Set(registrations.map(item => item.registrationId)).size, 8);
});

test('snapshot freezes both architectures and offline apps; unregister only affects future hosts', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  const b = await f.register('com.example.b');
  const selected = f.select('com.example.a', a);
  assert.ok(Object.isFrozen(selected));
  assert.ok(Object.isFrozen(selected.payloads));
  await api.unregisterOverlayAddonInstallation({ applicationId: 'com.example.b', registrationId: b.registrationId, storageRoot: f.storageRoot });
  const snapshot = await api.createOverlayAddonPreloadSnapshot(path.join(f.directory, 'host-addons'), selected);
  assert.equal(fs.readdirSync(snapshot.directory).length, 4);
  assert.equal(f.select('com.example.a', a).payloads.length, 2);
  assert.deepEqual(fs.readFileSync(snapshot.addonPath), fs.readFileSync(a.addonPath));
  assert.deepEqual(fs.readFileSync(snapshot.x86AddonPath), fs.readFileSync(a.x86AddonPath));
  assert.ok(fs.existsSync(b.addonPath));
  assert.throws(() => f.select('com.example.b', b), /not registered/);
  await assert.rejects(api.createOverlayAddonPreloadSnapshot(snapshot.directory, selected), /already exists/);
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
  await assert.rejects(f.register('com.example.a'), /preload protocol/);
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

test('cache tampering fails closed for idempotent install, selection and a frozen snapshot', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  const selected = f.select('com.example.a', a);
  fs.chmodSync(a.addonPath, 0o644);
  fs.appendFileSync(a.addonPath, 'tampered');
  await assert.rejects(f.register('com.example.a'), /hash|size/i);
  assert.throws(() => f.select('com.example.a', a), /not registered|hash|size/i);
  await assert.rejects(api.createOverlayAddonPreloadSnapshot(path.join(f.directory, 'failed-host'), selected), /hash|size/i);
  assert.equal(fs.existsSync(path.join(f.directory, 'failed-host')), false);
  assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('.ego-preload-')), false);
});

test('registry refuses unknown schema fields and never repairs or overwrites its immutable payloads', async t => {
  const f = fixture(t);
  const a = await f.register('com.example.a');
  const file = path.join(f.storageRoot, 'registrations.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.unknown = true;
  fs.writeFileSync(file, JSON.stringify(registry));
  await assert.rejects(f.register('com.example.a'), /registry/);
  await assert.rejects(api.unregisterOverlayAddonInstallation({ applicationId: 'com.example.a', storageRoot: f.storageRoot }), /registry/);
  assert.ok(fs.existsSync(a.addonPath));
});

test('directory junctions or symlinks cannot redirect the registry or host snapshot', async t => {
  const f = fixture(t);
  const target = path.join(f.directory, 'foreign');
  fs.mkdirSync(target);
  const redirected = path.join(f.directory, 'redirected');
  try { fs.symlinkSync(target, redirected, 'junction'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Directory links unavailable'); return; } throw error; }
  await assert.rejects(api.registerOverlayAddonInstallation({ applicationId: 'com.example.a', packageRoot: f.packageRoot, storageRoot: redirected }), /reparse|non-directory/);
  const a = await f.register('com.example.a');
  await assert.rejects(api.createOverlayAddonPreloadSnapshot(path.join(redirected, 'host'), f.select('com.example.a', a)), /reparse|non-directory/);
  assert.deepEqual(fs.readdirSync(target), []);
});
