'use strict';
// Source-backed filesystem acceptance only. Passive text payloads are staged by
// prepare(); no SDK build output is written and no injector/native code runs.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const markerName = 'electron-game-overlay-owned-runtime-v1.marker';
const markerBytes = Buffer.from('ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1\n', 'ascii');
const sourcePath = path.resolve(__dirname, '../src/lib/reshade-launcher.ts');
const compiledPath = path.resolve(__dirname, '../dist/lib/reshade-launcher.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const buildId = source.match(/const OFFICIAL_ADDON_BUILD_ID = '([0-9A-F]{32})';/)?.[1];
assert.ok(buildId, 'The production launcher must declare one exact current native identity');
const artifacts = [
  'inject.exe', 'inject32.exe',
  'electron_game_overlay_reshade_manager.exe', 'electron_game_overlay_reshade_manager32.exe',
  'ReShade64.dll', 'ReShade32.dll', 'ReShade64.build.json', 'ReShade32.build.json',
  'electron_game_overlay_runtime.build.json', 'electron_game_overlay_runtime32.build.json',
  'electron_game_overlay.addon64', 'electron_game_overlay.addon32', 'ReShade.ini',
];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function tree(root) {
  function walk(directory, prefix = '') {
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1).flatMap(entry => {
      const name = prefix + entry.name;
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) return walk(path.join(directory, entry.name), name + '/');
      const file = path.join(directory, entry.name), stat = fs.statSync(file);
      // Hard-link creation/removal can legitimately change ctime/link count;
      // source/foreign bytes, write time and file attributes must stay exact.
      return [{ path: name, sha256: sha(fs.readFileSync(file)), mtimeMs: stat.mtimeMs, mode: stat.mode }];
    });
  }
  return walk(root);
}
function loadLauncher(overrides = {}) {
  // Only this module receives controlled fs seams; all imported SDK dependencies
  // resolve from the existing compiled location and are left unchanged.
  const loaded = new Module(compiledPath, module);
  loaded.filename = compiledPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(compiledPath));
  const payloadCompiled = path.resolve(__dirname, '../dist/lib/runtime-payload-store.js');
  const payload = new Module(payloadCompiled, module);
  payload.filename = payloadCompiled;
  payload.paths = loaded.paths;
  payload.require = id => id === 'node:fs/promises'
    ? { ...fsp, ...overrides }
    : Module.prototype.require.call(payload, id);
  payload._compile(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/lib/runtime-payload-store.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, payloadCompiled);
  loaded.require = id => {
    if (id === './runtime-payload-store.js') return payload.exports;
    if (id === 'node:fs/promises') return { ...fsp, ...overrides };
    if (id === 'node:child_process') return { ...require(id), execFile() { throw new Error('prepare() must never execute an injector'); } };
    return Module.prototype.require.call(loaded, id);
  };
  const transformed = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    reportDiagnostics: true,
  });
  assert.deepEqual(transformed.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), []);
  loaded._compile(transformed.outputText, compiledPath);
  return loaded.exports;
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Owned fixture operation did not settle');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
function fixture(t, hooks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-owned-stage-marker-'));
  const runtime = path.join(root, 'source-runtime'), runs = path.join(root, 'private-runs');
  const foreign = path.join(root, 'foreign-reshade'), game = path.join(root, 'game');
  for (const directory of [runtime, runs, foreign, game]) fs.mkdirSync(directory);
  for (const name of artifacts.filter(name => !name.startsWith('electron_game_overlay_runtime'))) write(path.join(runtime, name), 'PASSIVE NONEXECUTABLE FIXTURE ' + name);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const digest = name => sha(fs.readFileSync(path.join(runtime, name)));
    write(path.join(runtime, 'electron_game_overlay_runtime' + suffix + '.build.json'), JSON.stringify({
      schemaVersion: 3, kind: 'electron-game-overlay-runtime-build', platform: bits === 64 ? 'win32-x64' : 'win32-ia32',
      configuration: 'RelWithDebInfo', addonBuildId: buildId, managerProtocolSchemaVersion: 1,
      runtimeGeneration: 1, targetTransportMin: 1, targetTransportMax: 1, managerSourceSha256: 'A'.repeat(64),
      managerSha256: digest('electron_game_overlay_reshade_manager' + suffix + '.exe'),
      addonSha256: digest('electron_game_overlay.addon' + bits), injectorSha256: digest('inject' + suffix + '.exe'),
      reshadeRuntimeSha256: digest('ReShade' + bits + '.dll'), reshadeConfigSha256: digest('ReShade.ini'),
      reshadeBuildStampSha256: digest('ReShade' + bits + '.build.json'),
    }));
  }
  for (const [name, bytes] of [['dxgi.dll', 'foreign runtime'], ['ReShade.ini', 'foreign configuration'], ['effects/example.fx', 'foreign effect'], ['addons/foreign.addon64', 'foreign add-on'], [markerName, 'FOREIGN MARKER MUST NOT CHANGE']]) write(path.join(foreign, name), bytes);
  write(path.join(game, 'game.exe'), 'PASSIVE GAME PATH FIXTURE');
  write(path.join(game, 'ReShade.ini'), 'game configuration must remain exact');
  const before = { runtime: tree(runtime), foreign: tree(foreign), game: tree(game) };
  const copied = new Set(), validated = new Set(), markerWrites = [], created = [], events = [];
  const loader = loadLauncher({
    async mkdtemp(prefix, options) {
      const directory = await fsp.mkdtemp(prefix, options);
      created.push(directory);
      if (hooks.afterMkdtemp) await hooks.afterMkdtemp(directory, { foreign, game, runtime });
      return directory;
    },
    async copyFile(from, to, flags) {
      if (hooks.beforeCopy) await hooks.beforeCopy(from, to);
      await fsp.copyFile(from, to, flags);
      if (hooks.afterCopy) await hooks.afterCopy(from, to);
      copied.add(path.basename(to));
    },
    async readFile(file, options) {
      const bytes = await fsp.readFile(file, options);
      if (created.some(directory => path.dirname(file) === directory) && artifacts.includes(path.basename(file))) validated.add(path.basename(file));
      return bytes;
    },
    async writeFile(file, data, options) {
      if (path.basename(file) !== markerName) return fsp.writeFile(file, data, options);
      const attempt = { file, data: Buffer.from(data, options?.encoding), options: { ...options }, copied: [...copied].sort(), validated: [...validated].sort() };
      markerWrites.push(attempt);
      if (hooks.beforeMarkerWrite) await hooks.beforeMarkerWrite(file, data, options, attempt);
      try { return await fsp.writeFile(file, data, options); }
      catch (error) {
        attempt.errorCode = error.code;
        if (fs.existsSync(file)) attempt.preservedBytes = fs.readFileSync(file);
        throw error;
      }
    },
  });
  const config = loader.createReShadeLaunchConfig({ bundledRuntimeDirectory: runtime, runsRootDirectory: runs });
  const launcher = new loader.ReShadeOverlayLauncher(config);
  launcher.onEvent(event => {
    if (event.type === 'runtime-staged') events.push({ ...event, markerAtPublication: fs.existsSync(path.join(event.runDirectory, markerName)) ? fs.readFileSync(path.join(event.runDirectory, markerName)) : null });
  });
  t.after(async () => {
    launcher.dispose();
    await until(() => !fs.existsSync(runs) || fs.readdirSync(runs).length === 0);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    assert.ok(path.basename(root).startsWith('ego-owned-stage-marker-'));
    await fsp.rm(root, { recursive: true, force: true });
  });
  const assertSourcesUnchanged = () => {
    assert.deepEqual(tree(runtime), before.runtime);
    assert.deepEqual(tree(foreign), before.foreign);
    assert.deepEqual(tree(game), before.game);
  };
  return { root, runtime, runs, foreign, game, launcher, copied, validated, markerWrites, created, events, assertSourcesUnchanged };
}
function stagingError(error) {
  assert.equal(error.code, 'runtime-staging-failed');
  assert.equal(error.retrySafety, 'definite-safe');
  return true;
}
function assertMarker(f, index = 0) {
  const attempt = f.markerWrites[index];
  assert.deepEqual(attempt.data, markerBytes);
  assert.deepEqual(attempt.options, { encoding: 'ascii', flag: 'wx' });
  assert.deepEqual(attempt.copied, artifacts.slice().sort());
  assert.deepEqual(attempt.validated, artifacts.slice().sort());
  return attempt;
}

test('current source writes an exact regular marker only in a fresh private stage after every copy/hash read and before publication', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = fixture(t, { async beforeCopy(_from, to) {
    if (path.basename(to) === 'electron_game_overlay.addon32') { entered.resolve(); await release.promise; }
  } });
  const first = f.launcher.prepare(), second = f.launcher.prepare();
  await entered.promise;
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.markerWrites, []);
  assert.deepEqual(f.events, []);
  assert.equal(fs.existsSync(path.join(f.created[0], markerName)), false);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(f.markerWrites.length, 1);
  const attempt = assertMarker(f);
  assert.equal(path.dirname(attempt.file), f.created[0]);
  assert.equal(path.dirname(f.created[0]), fs.realpathSync(f.runs));
  assert.match(path.basename(f.created[0]), /^prepared-/);
  const stat = fs.lstatSync(attempt.file);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.nlink, 1);
  assert.deepEqual(fs.readFileSync(attempt.file), markerBytes);
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.events[0].markerAtPublication, markerBytes);
  assert.equal(fs.existsSync(path.join(f.runtime, markerName)), false);
  f.assertSourcesUnchanged();
});

test('corrupting only a staged copy rejects hash validation before any marker write or publication', async t => {
  const f = fixture(t, { async afterCopy(_from, to) {
    if (path.basename(to) === 'inject32.exe') await fsp.writeFile(to, 'corrupted isolated copy');
  } });
  await assert.rejects(f.launcher.prepare(), stagingError);
  assert.deepEqual(f.markerWrites, []);
  assert.deepEqual(f.events, []);
  assert.deepEqual(fs.readdirSync(f.runs), []);
  f.assertSourcesUnchanged();
});

test('a failed copy waits for the other copies to settle before cleanup and never publishes a marker', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = fixture(t, { async beforeCopy(_from, to) {
    if (path.basename(to) === 'inject.exe') throw Object.assign(new Error('controlled owned copy failure'), { code: 'EACCES' });
    if (path.basename(to) === 'electron_game_overlay.addon32') { entered.resolve(); await release.promise; }
  } });
  let settled = false;
  const preparation = f.launcher.prepare();
  const rejection = assert.rejects(preparation, stagingError).finally(() => { settled = true; });
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(fs.existsSync(f.created[0]), true);
  assert.deepEqual(f.markerWrites, []);
  release.resolve();
  await rejection;
  assert.deepEqual(fs.readdirSync(f.runs), []);
  assert.deepEqual(f.events, []);
  f.assertSourcesUnchanged();
});

test('exclusive marker-write failure cleans the private stage and permits a fresh successful prepare retry', async t => {
  let fail = true;
  const f = fixture(t, { async beforeMarkerWrite() {
    if (fail) throw Object.assign(new Error('controlled owned marker-write denial'), { code: 'EACCES' });
  } });
  await assert.rejects(f.launcher.prepare(), stagingError);
  assert.equal(f.markerWrites.length, 1);
  assertMarker(f);
  assert.deepEqual(f.events, []);
  assert.deepEqual(fs.readdirSync(f.runs), []);
  fail = false;
  await f.launcher.prepare();
  assert.equal(f.created.length, 2);
  assert.notEqual(f.created[0], f.created[1]);
  assert.equal(fs.existsSync(f.created[0]), false);
  const retried = assertMarker(f, 1);
  assert.deepEqual(fs.readFileSync(retried.file), markerBytes);
  assert.equal(f.events.length, 1);
  f.assertSourcesUnchanged();
});

for (const hardlinked of [false, true]) test('an injected ' + (hardlinked ? 'hard-linked' : 'existing regular') + ' marker is never overwritten or treated as an owned publication', async t => {
  const sentinel = Buffer.from('FOREIGN MARKER MUST NOT CHANGE');
  const f = fixture(t, { async afterMkdtemp(directory, context) {
    const marker = path.join(directory, markerName);
    if (hardlinked) await fsp.link(path.join(context.foreign, markerName), marker);
    else await fsp.writeFile(marker, sentinel, { flag: 'wx' });
  } });
  await assert.rejects(f.launcher.prepare(), stagingError);
  assert.equal(f.markerWrites.length, 1);
  const attempt = assertMarker(f);
  assert.equal(attempt.errorCode, 'EEXIST');
  assert.deepEqual(attempt.preservedBytes, sentinel);
  assert.deepEqual(f.events, []);
  assert.deepEqual(fs.readdirSync(f.runs), []);
  assert.deepEqual(fs.readFileSync(path.join(f.foreign, markerName)), sentinel);
  f.assertSourcesUnchanged();
});
