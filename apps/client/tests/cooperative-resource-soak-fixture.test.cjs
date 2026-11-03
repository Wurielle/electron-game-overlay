'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { parseOptions, parseCommand, collectPrivateRoute, collectInjectorBinding, collectInjectorSelection, createProducer, entryArguments, isMainEntrypoint, MAX_WINDOWS } = require('../scripts/cooperative-resource-soak-fixture.cjs');

const sha = value => createHash('sha256').update(value).digest('hex');
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-resource-soak-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function options(directory, overrides = {}) {
  return { member: 'churn', slot: 'churn', evidence: directory, sdkDist: directory, game: path.join(directory, 'owned-target.exe'), targetPid: 123, maxCycles: 3, ...overrides };
}
function sdkHarness() {
  const sessions = [], launchers = [];
  let disposed = 0, nextId = 1;
  class Session extends EventEmitter {
    constructor(owner) {
      super(); this.owner = owner; this.closed = false; this.created = [];
      this.input = { intercept: () => { this.requested = true; }, release: () => { this.requested = false; } };
      this.windows = { create: metadata => {
        const contents = new EventEmitter();
        contents.executeJavaScript = async script => script.includes('window.observed') ? { downs: 0, ups: 0, heldKeys: [], value: '' } : undefined;
        const window = {
          nativeId: nextId++, visible: false, closed: false, focused: false,
          browserWindow: { webContents: contents, loadURL: async () => {} },
          show() { this.visible = true; }, focus() { this.focused = true; },
          close() { this.closed = true; this.visible = false; }, metadata,
        };
        this.created.push(window); return window;
      } };
    }
    close() { this.closed = true; this.created.forEach(window => window.close()); this.owner.active = undefined; }
  }
  class Overlay {
    createSession() { assert.equal(this.active, undefined, 'Only one public session may be live'); const session = new Session(this); sessions.push(session); this.active = session; return session; }
    dispose() { disposed++; this.active?.close(); }
  }
  class Launcher {
    constructor(config) { this.config = config; launchers.push(this); this.events = new EventEmitter(); this.disposed = false; }
    onEvent(callback) { this.events.on('event', callback); }
    attach(session, target) {
      this.session = session; this.target = target;
      return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    }
    dispose() { this.disposed = true; }
  }
  return { sessions, launchers, get disposed() { return disposed; }, sdk: { ElectronGameOverlay: Overlay, ReShadeOverlayLauncher: Launcher, parseReShadeLaunchConfig: (_argv, config) => config } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Electron default-app entry executes when require.main names its bootstrap instead of the fixture', async t => {
  const directory = temporary(t);
  const filename = path.resolve(__dirname, '../scripts/cooperative-resource-soak-fixture.cjs');
  const imported = { exports: {} }, defaultApp = { filename: 'electron/default_app.asar/main.js' };
  const argv = ['electron.exe', '--force-device-scale-factor=1', '--require', path.join(directory, 'preload.cjs'), filename,
    '--member=churn', '--slot=churn', `--evidence=${directory}`, `--sdk-dist=${directory}`, `--game=${path.join(directory, 'target.exe')}`, '--pid=123'];
  const logs = [], errors = [], exits = [], paths = [];
  let sdkReads = 0;
  const electron = { app: { setPath: (...value) => paths.push(value), disableHardwareAcceleration() {}, exit: code => exits.push(code) } };
  const mockRequire = name => {
    if (name === 'electron') return electron;
    if (name === './cooperative-game-evidence.cjs') return { collectSdkEvidence() { sdkReads++; throw new Error('controlled SDK startup failure'); } };
    if (name === './cooperative-atomic-state.cjs') return require('../scripts/cooperative-atomic-state.cjs');
    return require(name);
  };
  mockRequire.main = defaultApp;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: mockRequire, module: imported, __filename: filename, __dirname: path.dirname(filename), Buffer,
    process: { argv, pid: process.pid, type: 'browser', defaultApp: true, versions: { electron: '39.0.0', node: process.versions.node } },
    console: { log: value => logs.push(value), error: value => errors.push(value) }, setInterval, clearInterval,
  }, { filename });
  await settle();
  assert.equal(sdkReads, 1, 'The explicit Electron browser entry must invoke main once');
  assert.equal(paths.length, 1);
  assert.deepEqual(exits, [1]);
  assert.match(errors[0], /controlled SDK startup failure/u);
  const entry = JSON.parse(logs[0].slice('EGO_RESOURCE_SOAK_ENTRY '.length));
  assert.equal(entry.requireMainMatches, false);
  assert.equal(entry.selected, true);
  const bootstrap = JSON.parse(fs.readFileSync(path.join(directory, 'churn-bootstrap.json'), 'utf8'));
  assert.equal(bootstrap.phase, 'failed');
  assert.equal(bootstrap.requireMainMatches, false);
  assert.deepEqual(bootstrap.argv, argv);
  assert.match(bootstrap.error, /controlled SDK startup failure/u);
});

test('entry guard keeps Node imports, renderer processes and unrelated Electron imports inactive', () => {
  const self = {}, other = {}, filename = path.resolve(__dirname, '../scripts/cooperative-resource-soak-fixture.cjs');
  assert.equal(isMainEntrypoint({ versions: {}, argv: [] }, self, self, filename), true);
  assert.equal(isMainEntrypoint({ versions: {}, argv: ['node', filename] }, other, self, filename), false);
  assert.equal(isMainEntrypoint({ versions: { electron: '39' }, type: 'renderer', argv: ['electron', filename] }, other, self, filename), false);
  assert.equal(isMainEntrypoint({ versions: { electron: '39' }, type: 'browser', argv: ['electron', path.join(path.dirname(filename), 'other.cjs')] }, other, self, filename), false);
  assert.equal(isMainEntrypoint({ versions: { electron: '39' }, type: 'browser', argv: [] }, other, self, filename), false);
  for (const leading of [[], ['--force-device-scale-factor=1'], ['--require', 'preload.cjs', '--no-help'], ['-r', 'preload.cjs', '--']]) {
    const argv = ['electron', ...leading, filename, '--member=churn'];
    assert.deepEqual(entryArguments({ argv }, filename), ['--member=churn']);
    assert.equal(isMainEntrypoint({ versions: { electron: '39' }, type: 'browser', argv }, other, self, filename), true);
  }
  assert.deepEqual(entryArguments({ argv: ['electron', `--app=${filename}`, '--member=churn'] }, filename), ['--member=churn']);
  assert.equal(entryArguments({ argv: ['electron', '--version', filename] }, filename), undefined);
  assert.equal(entryArguments({ argv: ['electron', '--require', filename] }, filename), undefined);
  assert.equal(entryArguments({ argv: ['electron', path.join(path.dirname(filename), 'other.cjs'), filename] }, filename), undefined);
});

test('soak CLI and command inputs bound exact target, names and lifecycle count', () => {
  const root = path.resolve(os.tmpdir());
  const argv = [`--member=churn`, `--evidence=${root}`, `--sdk-dist=${root}`, `--game=${path.join(root, 'target.exe')}`, '--pid=42', '--max-cycles=1024'];
  assert.equal(parseOptions(argv).targetPid, 42);
  assert.equal(parseOptions(argv).maxCycles, 1024);
  for (const extra of ['--pid=0', '--pid=4294967296', '--member=../escape', '--max-cycles=1025', '--max-cycles=01', '--unknown=yes']) {
    const key = extra.split('=')[0];
    assert.throws(() => parseOptions([...argv.filter(value => !value.startsWith(key + '=')), extra]));
  }
  assert.throws(() => parseOptions([...argv, '--pid=42']), /duplicate/u);
  assert.deepEqual(parseCommand({ sequence: 1, action: 'close-session' }), { sequence: 1, action: 'close-session', window: 'main' });
  for (const value of [{ sequence: 0, action: 'exit' }, { sequence: 1, action: 'unknown' }, { sequence: 1, action: 'create-window', window: '../bad' }, { sequence: 1, action: 'exit', targetPid: 7 }]) assert.throws(() => parseCommand(value));
});

test('private route evidence rejects foreign producer/target, changed bytes and escaped stages without exposing credentials', t => {
  const directory = temporary(t), cycleRoot = path.join(directory, 'cycle-1'), stage = path.join(cycleRoot, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  const addon = Buffer.from('controlled inert native bytes');
  const addonPath = path.join(stage, 'electron_game_overlay.addon64');
  fs.writeFileSync(addonPath, addon);
  const token = 'ab'.repeat(32);
  const discoveryPath = path.join(stage, 'electron-overlay-transport-v1.json');
  const discovery = { version: 1, pid: process.pid, targetPid: 123, port: 4567, token };
  const writeDiscovery = value => fs.writeFileSync(discoveryPath, JSON.stringify(value));
  writeDiscovery(discovery);
  const result = { pid: 123, injectorTargetPid: 123, runDirectory: stage };
  const evidence = { addon: { bytes: addon.length, sha256: sha(addon), abi: 1, buildId: 'A'.repeat(32) } };
  const observed = collectPrivateRoute(result, options(directory), evidence, cycleRoot);
  assert.equal(observed.native.path, fs.realpathSync(addonPath));
  assert.equal(observed.transport.tokenFingerprint, sha(token));
  assert.ok(!JSON.stringify(observed).includes(token));
  for (const change of [{ pid: process.pid + 1 }, { targetPid: 124 }, { targetPid: undefined }, { port: 0 }]) {
    writeDiscovery({ ...discovery, ...change });
    assert.throws(() => collectPrivateRoute(result, options(directory), evidence, cycleRoot), /private target route/u);
  }
  writeDiscovery(discovery);
  fs.writeFileSync(addonPath, Buffer.alloc(addon.length));
  assert.throws(() => collectPrivateRoute(result, options(directory), evidence, cycleRoot), /changed/u);
  fs.writeFileSync(addonPath, addon);
  assert.throws(() => collectPrivateRoute({ ...result, runDirectory: directory }, options(directory), evidence, cycleRoot), /escaped/u);
  assert.throws(() => collectPrivateRoute({ ...result, pid: 124 }, options(directory), evidence, cycleRoot), /exact/u);
});

test('session close keeps Electron alive and stale attachment/events cannot contaminate a recreated cycle', async t => {
  const directory = temporary(t), harness = sdkHarness(), exits = [], snapshots = [];
  const producer = createProducer({
    app: { exit: code => exits.push(code) }, sdk: harness.sdk, sdkEvidence: { sdkDist: directory, addon: {} }, options: options(directory),
    publish: (_filename, state) => snapshots.push(structuredClone(state)),
    collectRoute: result => ({ runDirectory: result.runDirectory, transport: { tokenFingerprint: result.token }, native: { path: result.nativePath } }),
    collectSelection: () => ({ pid: 123, executablePath: options(directory).game, creationTime100ns: '132000000000000001' }),
  });
  await producer.start();
  assert.equal(producer.state.cycle, 1);
  assert.equal(harness.launchers[0].target.pid, 123);
  harness.launchers[0].events.emit('event', { type: 'target-selected', pid: 123, executablePath: options(directory).game, creationTime100ns: '132000000000000001' });
  const staged = path.join(directory, 'stage-1');
  harness.launchers[0].events.emit('event', { type: 'injector-returned', result: { injectorTargetPid: 123, runtimeMode: 'participant-addon', runDirectory: staged,
    targetExecutablePath: options(directory).game, injectorStdoutPath: path.join(staged, 'inject.stdout.log'),
    hostRuntimePath: path.join(staged, 'ReShade64.dll'), addonModulePath: path.join(staged, 'electron_game_overlay.addon64'), token: 'RAW-TOKEN-MUST-NOT-BE-RECORDED' } });
  assert.equal(producer.state.injectorReturned, true);
  assert.equal(producer.state.injectorProof.runtimeMode, 'participant-addon');
  assert.equal(producer.state.injectorProof.hostRuntimePath, path.join(staged, 'ReShade64.dll'));
  assert.equal(producer.state.injectorProof.addonModulePath, path.join(staged, 'electron_game_overlay.addon64'));
  assert.equal(producer.state.injectorProof.injectorStdoutPath, path.join(staged, 'inject.stdout.log'));
  assert.equal(producer.state.selectedTarget.creationTime100ns, '132000000000000001');
  assert.ok(!JSON.stringify(producer.state).includes('RAW-TOKEN-MUST-NOT-BE-RECORDED'));
  await producer.command({ sequence: 1, action: 'close-session' });
  assert.equal(producer.state.activeSession, false);
  assert.equal(producer.state.injectorReturned, false);
  assert.equal(producer.state.selectedTarget, null);
  assert.equal(producer.state.windowsClosed, 1);
  assert.equal(harness.sessions[0].closed, true);
  assert.equal(harness.launchers[0].disposed, true);
  assert.deepEqual(exits, []);
  await producer.command({ sequence: 2, action: 'recreate-session' });
  assert.equal(producer.state.cycle, 2);
  assert.notEqual(harness.launchers[0].config.runsRootDirectory, harness.launchers[1].config.runsRootDirectory);
  harness.launchers[0].resolve({ runDirectory: 'old-stage', token: 'old-token', nativePath: 'old-module' });
  harness.sessions[0].emit('windowFocused', { windowId: 999 });
  harness.sessions[0].emit('diagnostic', { code: 'runtime-input-router-reset', severity: 'error' });
  await settle();
  assert.equal(producer.state.attached, false);
  assert.equal(producer.state.focusedWindowId, 0);
  assert.equal(producer.state.error, undefined);
  harness.launchers[1].resolve({ runDirectory: 'new-stage', token: 'new-token', nativePath: 'new-module' });
  harness.sessions[1].emit('diagnostic', { code: 'runtime-scene-rendering-started', severity: 'info' });
  await settle();
  assert.equal(producer.state.attached, true);
  assert.equal(producer.state.rendering, true);
  assert.equal(producer.state.transport.tokenFingerprint, 'new-token');
  harness.sessions[1].emit('targetSurfaceChanged', { pid: 123, hwnd: '7' });
  harness.sessions[1].emit('windowFocused', { windowId: 42 });
  harness.sessions[1].emit('inputInterceptionChanged', { intercepting: true });
  harness.sessions[1].emit('targetTransportLost', { pid: 123 });
  assert.equal(producer.state.attached, false);
  assert.equal(producer.state.rendering, false);
  assert.equal(producer.state.intercepting, false);
  assert.equal(producer.state.focusedWindowId, 0);
  assert.equal(producer.state.surface, undefined);
  harness.sessions[1].emit('targetSurfaceChanged', { pid: 123, hwnd: '8' });
  harness.sessions[1].emit('targetSurfaceRemoved', { pid: 123, hwnd: '8' });
  assert.equal(producer.state.surface, undefined);
  await producer.command({ sequence: 3, action: 'intercept' });
  assert.equal(harness.sessions[1].requested, true);
  assert.equal(producer.state.requestedInterception, true);
  assert.equal(await producer.command({ sequence: 3, action: 'recreate-session' }), false);
  assert.equal(producer.state.cycle, 2);
  await producer.command({ sequence: 4, action: 'exit' });
  assert.deepEqual(exits, [0]);
  assert.equal(harness.disposed, 1);
  assert.equal(producer.state.commandSequence, 4);
  assert.equal(snapshots.at(-1).activeSession, false);
});

test('exact-PID startup proof parses one owned native selection without retaining raw stdout', t => {
  const directory = temporary(t), stage = path.join(directory, 'stage');
  fs.mkdirSync(stage);
  const filename = path.join(stage, 'injector.stdout.log');
  const result = { runDirectory: stage, injectorStdoutPath: filename, injectorTargetPid: 123, targetExecutablePath: options(directory).game };
  const line = `EGO_TARGET_SELECTED_V2\t123\t132000000000000001\t${options(directory).game}\r\n`;
  fs.writeFileSync(filename, 'private log material must not be copied\n' + line);
  assert.deepEqual(collectInjectorSelection(result, options(directory)), { pid: 123, creationTime100ns: '132000000000000001', executablePath: options(directory).game });
  fs.writeFileSync(filename, line + line);
  assert.throws(() => collectInjectorSelection(result, options(directory)), /one exact/u);
  fs.writeFileSync(filename, line.replace('\t123\t', '\t124\t'));
  assert.throws(() => collectInjectorSelection(result, options(directory)), /one exact/u);
  fs.writeFileSync(filename, 'x'.repeat(1024 * 1024 + 1));
  assert.throws(() => collectInjectorSelection(result, options(directory)), /size/u);
  const foreign = path.join(directory, 'foreign.log'); fs.writeFileSync(foreign, line);
  assert.throws(() => collectInjectorSelection({ ...result, injectorStdoutPath: foreign }, options(directory)), /escaped/u);
});

test('production exact-PID V1 selection retains native-enforced creation binding and rejects mismatches', t => {
  const directory = temporary(t), stage = path.join(directory, 'stage');
  fs.mkdirSync(stage);
  const executable = path.join(stage, 'inject.exe'); fs.writeFileSync(executable, 'inert parser fixture');
  const filename = path.join(stage, 'inject.stdout.log');
  const target = options(directory), created = '132000000000000001';
  const invocation = { executable, workingDirectory: stage, arguments: [target.game, '--pid', '123', '--expected-creation-time-100ns', created] };
  const binding = collectInjectorBinding(invocation, target);
  const result = { runDirectory: stage, injectorStdoutPath: filename, injectorTargetPid: 123, targetExecutablePath: target.game, runtimeMode: 'injected-runtime' };
  const nativeResult = { schemaVersion: 1, pid: 123, targetExecutablePath: target.game, runtimeMode: 'injected-runtime' };
  const line = 'EGO_TARGET_SELECTED\t123\r\n';
  fs.writeFileSync(filename, line + 'Found a matching process with PID 123! Injecting ReShade ... Succeeded!\r\n' + 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ' + JSON.stringify(nativeResult) + '\r\n');
  assert.deepEqual(collectInjectorSelection(result, target, binding), {
    pid: 123, creationTime100ns: created, executablePath: target.game, identitySource: 'native-expected-creation-binding',
  });
  assert.throws(() => collectInjectorSelection(result, target), /creation-bound/u);
  assert.throws(() => collectInjectorSelection({ ...result, injectorTargetPid: 124 }, target, binding), /target image or PID/u);
  assert.throws(() => collectInjectorSelection({ ...result, targetExecutablePath: path.join(directory, 'other.exe') }, target, binding), /target image or PID/u);
  for (const args of [invocation.arguments.slice(0, 3), [...invocation.arguments, '--pid', '123'], [target.game, '--pid', '123', '--expected-creation-time-100ns', '18446744073709551616'], [target.game, '--pid', '124', '--expected-creation-time-100ns', created]]) {
    assert.throws(() => collectInjectorBinding({ ...invocation, arguments: args }, target));
  }
  assert.equal(collectInjectorBinding({ ...invocation, arguments: [...invocation.arguments, '--addon-only'] }, target).creationTime100ns, created);
  fs.writeFileSync(filename, line + line);
  assert.throws(() => collectInjectorSelection(result, target, binding), /one exact/u);
  fs.writeFileSync(filename, line.replace('123', '124'));
  assert.throws(() => collectInjectorSelection(result, target, binding), /one exact/u);
  fs.writeFileSync(filename, line + `EGO_TARGET_SELECTED_V2\t123\t132000000000000002\t${target.game}\r\n`);
  assert.throws(() => collectInjectorSelection(result, target, binding), /one exact/u);
});

test('bounded window/session churn and active failures fail closed', async t => {
  const directory = temporary(t), harness = sdkHarness(), exits = [];
  const producer = createProducer({ app: { exit: code => exits.push(code) }, sdk: harness.sdk, sdkEvidence: { addon: {} }, options: options(directory, { maxCycles: 2 }), publish: () => {} });
  await producer.start();
  let sequence = 0;
  for (let index = 1; index < MAX_WINDOWS; index++) await producer.command({ sequence: ++sequence, action: 'create-window', window: `w-${index}` });
  await assert.rejects(producer.command({ sequence: ++sequence, action: 'create-window', window: 'overflow' }), /window bound/u);
  await producer.command({ sequence: ++sequence, action: 'close-session' });
  assert.equal(producer.state.windowsCreated, MAX_WINDOWS);
  assert.equal(producer.state.windowsClosed, MAX_WINDOWS);
  await producer.command({ sequence: ++sequence, action: 'recreate-session' });
  await producer.command({ sequence: ++sequence, action: 'close-session' });
  await assert.rejects(producer.command({ sequence: ++sequence, action: 'recreate-session' }), /cycle bound/u);
  producer.fail(new Error('controlled active failure'));
  assert.deepEqual(exits, [1]);
  assert.match(producer.state.error, /controlled active failure/u);
  assert.equal(producer.state.activeSession, false);
});

test('teardown failure still exits unsuccessfully after cleanup has marked the producer done', async t => {
  const directory = temporary(t), harness = sdkHarness(), exits = [];
  const producer = createProducer({ app: { exit: code => exits.push(code) }, sdk: harness.sdk, sdkEvidence: { addon: {} }, options: options(directory), publish: () => {} });
  await producer.start();
  harness.launchers[0].dispose = () => { throw new Error('controlled dispose failure'); };
  let failure;
  try { await producer.command({ sequence: 1, action: 'exit' }); } catch (error) { failure = error; }
  assert.match(failure?.message || '', /controlled dispose failure/u);
  assert.equal(producer.done, true);
  producer.fail(failure); // Matches the actual polling loop's error path.
  assert.deepEqual(exits, [1]);
  assert.match(producer.state.error, /controlled dispose failure/u);
});
