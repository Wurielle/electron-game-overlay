const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyProductionGraph, validateClientAssets, validatePayloads } = require('../scripts/package-demo.cjs');

function sdkFixture(root) {
  const write = (name, data) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  const binary = Buffer.alloc(68); binary.write('MZ'); binary.writeUInt32LE(64, 60); binary.write('PE\0\0', 64);
  write('package.json', JSON.stringify({ name: 'electron-game-overlay', version: '0.0.1', main: './dist/index.js' }));
  for (const name of ['index.js', 'broker.js']) write(`dist/${name}`, 'throw new Error("must not execute SDK while packaging")');
  const runtime = 'dist/runtime/win32-x64/reshade';
  write(`${runtime}/ReShade.ini`, 'fixture');
  for (const bits of [32, 64]) {
    const suffix = bits === 64 ? '' : '32';
    for (const name of [`electron_game_overlay.addon${bits}`, `electron_game_overlay_reshade_manager${suffix}.exe`, `inject${suffix}.exe`, `ReShade${bits}.dll`]) write(`${runtime}/${name}`, binary);
    for (const name of [`electron_game_overlay_runtime${suffix}.build.json`, `ReShade${bits}.build.json`]) write(`${runtime}/${name}`, '{}');
  }
  const files = [];
  for (const [name, bytes] of [['electron-game-overlay-broker.exe', binary], ['node_modules/tslib/tslib.js', Buffer.from('sealed dependency')], ['licenses/node.txt', Buffer.from('license')]]) {
    write(`dist/broker/win32-x64/${name}`, bytes);
    files.push({ path: name, size: bytes.length, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') });
  }
  write('dist/broker/win32-x64/broker-manifest.json', JSON.stringify({ schema: 1, platform: 'win32', arch: 'x64', executable: 'electron-game-overlay-broker.exe', files }));
}

test('explicit SDK replaces only the embedded SDK preserving its metadata, bytes and sealed dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-sdk-revision-'));
  try {
    const source = path.join(root, 'revision'), installed = path.join(root, 'node_modules/electron-game-overlay'), output = path.join(root, 'out');
    sdkFixture(source); sdkFixture(installed);
    fs.writeFileSync(path.join(source, 'dist/index.js'), 'module.exports="different compiled revision"');
    const other = path.join(root, 'node_modules/tslib'); fs.mkdirSync(other, { recursive: true }); fs.writeFileSync(path.join(other, 'package.json'), '{"version":"2.8.1"}');
    copyProductionGraph(root, output, { dependencies: { 'electron-game-overlay': { path: installed }, tslib: { path: other } } }, source);
    const embedded = path.join(output, 'node_modules/electron-game-overlay');
    for (const name of ['package.json', 'dist/index.js', 'dist/broker/win32-x64/node_modules/tslib/tslib.js', 'dist/runtime/win32-x64/reshade/electron_game_overlay.addon64']) assert.deepEqual(fs.readFileSync(path.join(embedded, name)), fs.readFileSync(path.join(source, name)));
    assert.equal(fs.readFileSync(path.join(output, 'node_modules/tslib/package.json'), 'utf8'), '{"version":"2.8.1"}');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit SDK rejects invalid metadata, output overlap, native payload and broken seals before copying', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-sdk-invalid-'));
  try {
    const source = path.join(root, 'revision'), output = path.join(root, 'out');
    const graph = { dependencies: { 'electron-game-overlay': { path: path.join(root, 'node_modules/electron-game-overlay') } } };
    for (const mutate of [
      () => fs.writeFileSync(path.join(source, 'package.json'), '{"name":"wrong","version":"0.0.1"}'),
      () => fs.writeFileSync(path.join(source, 'package.json'), '{"name":"electron-game-overlay","version":"fake"}'),
      () => fs.writeFileSync(path.join(source, 'package.json'), '{"name":"electron-game-overlay","version":"0.0.1","main":"../outside.js"}'),
      () => fs.unlinkSync(path.join(source, 'dist/runtime/win32-x64/reshade/electron_game_overlay.addon64')),
      () => fs.writeFileSync(path.join(source, 'dist/broker/win32-x64/node_modules/tslib/tslib.js'), 'tampered'),
      () => fs.unlinkSync(path.join(source, 'dist/index.js')),
    ]) {
      sdkFixture(source); mutate();
      assert.throws(() => copyProductionGraph(root, output, graph, source), /SDK|seal|ENOENT|missing|PE/i);
      assert.equal(fs.existsSync(output), false);
    }
    sdkFixture(source);
    assert.throws(() => copyProductionGraph(root, source, graph, source), /overlap/i);
    assert.throws(() => copyProductionGraph(root, output, graph, path.join(root, 'absent')), /ENOENT|SDK/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('broker launcher isolates profiles and uses only exact-PID Steam attachment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-broker-launcher-'));
  try {
    fs.mkdirSync(path.join(root, 'resources/app'), { recursive: true });
    require('../scripts/package-demo.cjs').writeLaunchers(root);
    const file = path.join(root, 'Start Broker Test.cmd');
    assert.equal(fs.existsSync(file), true, 'missing exact-PID broker test launcher');
    const launcher = fs.readFileSync(file, 'utf8');
    for (const flag of ['--manual-test-profile', '--reshade-overlay', '--steam-auto-attach', '--steam-exact-pid-only', '--demo-presentation']) assert.equal(launcher.includes(flag), true, flag);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manual launcher executes path setup before main while ordinary launch leaves Electron paths alone', () => {
  const { writeLaunchers } = require('../scripts/package-demo.cjs');
  assert.equal(typeof writeLaunchers, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-launchers-'));
  const Module = require('node:module'), original = Module._load, argv = process.argv;
  try {
    const observed = [];
    for (const name of ['app-A', 'app-B']) {
      const output = path.join(root, name), app = path.join(output, 'resources/app');
      fs.mkdirSync(path.join(app, 'dist/main'), { recursive: true });
      fs.writeFileSync(path.join(app, 'dist/main/main.js'), 'module.exports = "actual-main-imported"');
      writeLaunchers(output);
      assert.match(fs.readFileSync(path.join(output, 'Start Demo.cmd'), 'utf8'), /--steam-auto-attach/);
      const manual = fs.readFileSync(path.join(output, 'Start Manual Test.cmd'), 'utf8');
      assert.match(manual, /--manual-test-profile/); assert.doesNotMatch(manual, /steam|auto-target/i);
      const entry = path.join(app, 'portable-entry.cjs');
      for (const manualMode of [true, false]) {
        const events = [];
        Module._load = function(id, parent, isMain) {
          if (id === 'electron') return { app: { setName: name => events.push(['name', name]), setPath: (name, value) => events.push([name, value]), setAppLogsPath: value => events.push(['logs', value]) } };
          if (id === './dist/main/main.js') events.push(['main']);
          return original.call(this, id, parent, isMain);
        };
        process.argv = ['electron', ...(manualMode ? ['--manual-test-profile'] : [])];
        delete require.cache[entry]; require(entry);
        if (manualMode) {
          assert.deepEqual(events, [['name', name], ['userData', path.join(output, 'profile')], ['sessionData', path.join(output, 'profile')], ['logs', path.join(output, 'logs')], ['main']]);
          assert.equal(fs.statSync(path.join(output, 'profile')).isDirectory(), true);
          observed.push(events[1][1]);
        } else assert.deepEqual(events, [['main']]);
      }
    }
    assert.notEqual(observed[0], observed[1]);
  } finally { Module._load = original; process.argv = argv; fs.rmSync(root, { recursive: true, force: true }); }
});

test('packager CLI accepts explicit SDK option without changing platform safety', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/package-demo.cjs'), '--output', path.join(os.tmpdir(), 'unused-demo'), '--sdk-package', path.join(os.tmpdir(), 'sdk')], { encoding: 'utf8' });
  assert.doesNotMatch(result.stderr, /Unknown option/);
  assert.equal(result.status, 1);
});

test('complete packaging fixture wires explicit revision and entry while default SDK stays unchanged (not Windows execution)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-complete-package-'));
  const Module = require('node:module'), original = Module._load;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'), execPath = Object.getOwnPropertyDescriptor(process, 'execPath');
  try {
    const write = (name, data) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
    const binary = Buffer.alloc(68); binary.write('MZ'); binary.writeUInt32LE(64, 60); binary.write('PE\0\0', 64);
    const installed = path.join(root, 'node_modules/electron-game-overlay'), revision = path.join(root, 'revision');
    sdkFixture(installed); sdkFixture(revision);
    fs.writeFileSync(path.join(revision, 'dist/index.js'), 'module.exports="independent compiled bytes"');
    const graph = { dependencies: {} };
    for (const name of ['electron-game-overlay', 'koffi', 'wql-process-monitor']) graph.dependencies[name] = { version: name === 'electron-game-overlay' ? '0.0.1' : '1.0.0', path: path.join(root, 'node_modules', name) };
    write('package.json', JSON.stringify({ version: '1.0.0', dependencies: Object.fromEntries(Object.keys(graph.dependencies).map(name => [name, '*'])) }));
    write('LICENSE', 'license'); write('node.exe', binary); write('node_modules/electron/dist/electron.exe', binary);
    write('node_modules/koffi/build/koffi/win32_x64/koffi.node', binary);
    write('node_modules/wql-process-monitor/lib/dist/processMonitor.x64.dll', binary);
    for (const name of ['main/main.js', 'process-watcher/index.cjs']) write(`apps/client/dist/${name}`, '//fixture');
    write('apps/client/dist/index/index.html', '<html></html>');
    for (const name of ['broker-recovery-diagnostic.cjs', 'windows-broker-identity.cjs']) write(`apps/client/scripts/${name}`, `throw new Error('copy-only fixture: ${name}');`);
    write('libs/electron-game-overlay-runtime/scripts/test-cases/broker-recovery-diagnostic.cmd', fs.readFileSync(path.resolve(__dirname, '../../..', 'libs/electron-game-overlay-runtime/scripts/test-cases/broker-recovery-diagnostic.cmd')));
    Module._load = function(id, parent, isMain) {
      if (id === 'node:child_process') return { execFileSync: () => JSON.stringify(graph) };
      return original.call(this, id, parent, isMain);
    };
    const filename = path.join(root, 'apps/client/scripts/package-demo.cjs');
    const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(fs.readFileSync(path.resolve(__dirname, '../scripts/package-demo.cjs'), 'utf8'), filename);
    Object.defineProperty(process, 'platform', { value: 'win32' }); Object.defineProperty(process, 'execPath', { value: path.join(root, 'node.exe') });
    for (const [name, sdk] of [['default', undefined], ['explicit', revision]]) {
      const output = path.join(root, 'artifacts', name);
      loaded.exports.packageDemo(output, sdk);
      const app = path.join(output, 'resources/app'), metadata = JSON.parse(fs.readFileSync(path.join(app, 'package.json')));
      assert.equal(metadata.main, 'portable-entry.cjs'); assert.equal(metadata.dependencies['electron-game-overlay'], '0.0.1');
      assert.equal(fs.existsSync(path.join(app, metadata.main)), true);
      for (const name of ['broker-recovery-diagnostic.cjs', 'windows-broker-identity.cjs']) {
        assert.equal(fs.existsSync(path.join(app, 'scripts', name)), true, `package must ship ${name}`);
        assert.deepEqual(fs.readFileSync(path.join(app, 'scripts', name)), fs.readFileSync(path.join(root, 'apps/client/scripts', name)));
      }
      assert.deepEqual(fs.readFileSync(path.join(app, 'node_modules/electron-game-overlay/dist/index.js')), fs.readFileSync(path.join(sdk || installed, 'dist/index.js')));
      assert.equal(fs.readFileSync(path.join(output, 'Start Manual Test.cmd'), 'utf8').includes('--steam-auto-attach'), false);
    }
  } finally { Module._load = original; Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'execPath', execPath); fs.rmSync(root, { recursive: true, force: true }); }
});

test('packaging fixture copies real runtime bytes and license, not Windows execution', () => {
  const { copyNodeRuntime } = require('../scripts/package-demo.cjs');
  assert.equal(typeof copyNodeRuntime, 'function', 'portable package lacks a Node runtime copier');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-node-copy-'));
  try {
    const binary = Buffer.alloc(68); binary.write('MZ'); binary.writeUInt32LE(64, 60); binary.write('PE\0\0', 64);
    const source = path.join(root, 'node.exe'), license = path.join(root, 'node.txt');
    fs.writeFileSync(source, binary); fs.writeFileSync(license, 'fixture Node license');
    copyNodeRuntime(root, source, license);
    assert.deepEqual(fs.readFileSync(path.join(root, 'resources/node/node.exe')), binary);
    assert.equal(fs.readFileSync(path.join(root, 'resources/node/LICENSE'), 'utf8'), 'fixture Node license');
    fs.writeFileSync(source, 'not PE');
    assert.throws(() => copyNodeRuntime(root, source, license), /PE/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('watcher smoke orchestration fixture awaits ready IPC and clean child exit (not native execution)', async () => {
  const { probeWatcher } = require('../scripts/smoke-packaged-demo.cjs');
  assert.equal(typeof probeWatcher, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-watcher-probe-'));
  try {
    fs.mkdirSync(path.join(root, 'dist/process-watcher'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/process-watcher/index.cjs'), `
      if (process.env.PATH !== '' || Object.keys(process.env).some(k => /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|npm_node_execpath|NODE_ENV|EGO_PROCESS_WATCHER_TEST_WMI_MODULE)$/i.test(k))) process.exit(3);
      process.on('disconnect', () => process.exit(0));
      process.send({type:'process-watcher-ready'});
    `);
    assert.deepEqual(await probeWatcher(root, process.execPath), { readyIPC: true, exitCode: 0, pathEmpty: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('packaged manifest has concrete installed versions, not workspace install paths', () => {
  const { createAppManifest } = require('../scripts/package-demo.cjs');
  assert.equal(typeof createAppManifest, 'function');
  const manifest = createAppManifest({ version: '1.0.1', dependencies: { sdk: 'file:libs/sdk', monitor: '^3' } }, {
    dependencies: { sdk: { version: '0.0.1' }, monitor: { version: '3.0.2' } },
  });
  assert.deepEqual(manifest.dependencies, { sdk: '0.0.1', monitor: '3.0.2' });
  assert.equal(manifest.main, 'dist/main/main.js');
});

test('package output cannot overlap source or dependency trees', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const { packageDemo } = require('../scripts/package-demo.cjs');
  const root = path.resolve(__dirname, '../../..');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const parent of ['node_modules/electron/dist', 'apps/client/dist', 'libs/electron-game-overlay']) {
      assert.throws(() => packageDemo(path.join(root, parent, 'not-a-package-output')), /output.*artifacts/i);
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('file URL assets resolve; absolute URLs and missing support files fail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-assets-test-'));
  try {
    for (const name of ['index', 'main', 'process-watcher']) fs.mkdirSync(path.join(root, name));
    for (const name of ['renderer.js', 'main/main.js', 'process-watcher/index.cjs']) fs.writeFileSync(path.join(root, name), '// fixture');
    fs.writeFileSync(path.join(root, 'index/index.html'), '<script src="../renderer.js"></script>');
    validateClientAssets(root);
    fs.writeFileSync(path.join(root, 'index/index.html'), '<script src="/renderer.js"></script>');
    assert.throws(() => validateClientAssets(root), /relative/);
    fs.writeFileSync(path.join(root, 'index/index.html'), '<script src="../missing.js"></script>');
    assert.throws(() => validateClientAssets(root), /missing|ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing genuine native payload is an explicit packaging failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-payload-test-'));
  try { assert.throws(() => validatePayloads(root), /ENOENT|missing/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows runtime harness refuses Linux rather than fabricating execution', { skip: process.platform === 'win32' }, () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/smoke-packaged-demo.cjs'), '--package', path.join(os.tmpdir(), 'unused-demo')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires Windows x64/);
});

test('production closure dereferences workspace, preserves nested versions, excludes Electron and dev trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-package-test-'));
  try {
    const write = (p, value) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value); };
    const sdk = path.join(root, 'sdk');
    write(path.join(sdk, 'package.json'), '{"name":"sdk"}');
    write(path.join(sdk, 'dist/index.js'), 'module.exports=1');
    write(path.join(sdk, 'dist/broker/win32-x64/node_modules/tslib/tslib.js'), 'sealed broker dependency');
    write(path.join(sdk, 'src/dev.ts'), 'not shipped');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.symlinkSync(sdk, path.join(root, 'node_modules/sdk'), process.platform === 'win32' ? 'junction' : 'dir');
    const a = path.join(root, 'node_modules/a');
    const nested = path.join(a, 'node_modules/b');
    write(path.join(a, 'package.json'), '{"name":"a"}');
    write(path.join(nested, 'package.json'), '{"name":"b","version":"2"}');
    write(path.join(a, 'node_modules/dev/package.json'), '{}');
    const output = path.join(root, 'out');
    copyProductionGraph(root, output, { dependencies: { sdk: { path: path.join(root, 'node_modules/sdk'), dependencies: { electron: { path: '/not/copied' } } }, a: { path: a, dependencies: { b: { path: nested } } } } });
    assert.equal(fs.lstatSync(path.join(output, 'node_modules/sdk')).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(output, 'node_modules/sdk/src')), false);
    assert.equal(fs.existsSync(path.join(output, 'node_modules/sdk/dist/index.js')), true);
    assert.equal(fs.existsSync(path.join(output, 'node_modules/sdk/dist/broker/win32-x64/node_modules/tslib/tslib.js')), true, 'sealed broker dependencies must survive production-tree filtering');
    assert.equal(fs.readFileSync(path.join(output, 'node_modules/sdk/dist/broker/win32-x64/node_modules/tslib/tslib.js'), 'utf8'), 'sealed broker dependency');
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'node_modules/a/node_modules/b/package.json'))).version, '2');
    assert.equal(fs.existsSync(path.join(output, 'node_modules/a/node_modules/dev')), false);
    assert.equal(fs.existsSync(path.join(output, 'node_modules/electron')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
