import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  ForkedProcessWatcher,
  isSteamAppsProcessPath,
  resolveNodeExecutable,
  STEAM_AUTO_ATTACH_EXCLUDED_PROCESS_NAMES,
  SteamGameAutoAttacher,
  stripAutomaticTargeting,
} from '../src/main/electron/steam-game-auto-attacher.ts';

test('Node executable resolution avoids Electron and has a PATH fallback', () => {
  assert.equal(
    resolveNodeExecutable(
      ' C:\\portable-node\\node.exe ',
      { npm_node_execpath: 'C:\\npm\\node.exe' },
      'C:\\Electron\\electron.exe',
    ),
    'C:\\portable-node\\node.exe',
  );
  assert.equal(
    resolveNodeExecutable(
      undefined,
      { npm_node_execpath: 'C:\\npm\\node.exe' },
      'C:\\Electron\\electron.exe',
    ),
    'C:\\npm\\node.exe',
  );
  assert.equal(
    resolveNodeExecutable(
      undefined,
      { npm_node_execpath: 'C:\\Electron\\electron.exe' },
      'C:\\Program Files\\nodejs\\node.exe',
    ),
    'C:\\Program Files\\nodejs\\node.exe',
  );
  assert.equal(
    resolveNodeExecutable(
      undefined,
      { npm_node_execpath: 'C:\\Electron\\electron.exe' },
      'C:\\Electron\\electron.exe',
    ),
    'node',
  );
});

test('forked watcher uses real Node and preserves a detailed startup failure', () => {
  const child = createFakeChildProcess();
  const calls = [];
  const statuses = [];
  const watcher = new ForkedProcessWatcher(
    'C:\\client\\process-watcher\\index.cjs',
    (...args) => {
      calls.push(args);
      return child;
    },
    'C:\\Program Files\\nodejs\\node.exe',
  );

  watcher.start({
    onEvent: () => assert.fail('no process event was expected'),
    onStatus: (status, error) => statuses.push({ status, error }),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].execPath, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(Object.hasOwn(calls[0][2].env, 'ELECTRON_RUN_AS_NODE'), false);

  child.emit('message', {
    type: 'process-watcher-error',
    error: 'WMI startup failed with HRESULT 0x80041003',
  });
  child.emit('exit', 1, null);

  assert.deepEqual(statuses, [
    { status: 'starting', error: undefined },
    {
      status: 'failed',
      error: 'WMI startup failed with HRESULT 0x80041003',
    },
  ]);
});

test('Steam application paths match case-insensitively across Windows separators', () => {
  assert.equal(
    isSteamAppsProcessPath(
      'D:\\SteamLibrary\\STEAMAPPS\\common\\Example\\game.exe',
    ),
    true,
  );
  assert.equal(
    isSteamAppsProcessPath('E:/games/steamapps/common/Example/bin/helper.EXE'),
    true,
  );
  assert.equal(
    isSteamAppsProcessPath('C:\\games\\notsteamapps\\game.exe'),
    false,
  );
  assert.equal(isSteamAppsProcessPath(''), false);
  assert.equal(isSteamAppsProcessPath(undefined), false);
});

test('automatic targeting options are removed from per-PID launcher configs', () => {
  const source = createConfig({
    autoTargetProcess: 'Gun Frog.exe',
    expectedTargetPid: 42,
  });
  const stripped = stripAutomaticTargeting(source);

  assert.equal(Object.hasOwn(stripped, 'autoTargetProcess'), false);
  assert.equal(Object.hasOwn(stripped, 'expectedTargetPid'), false);
  assert.equal(stripped.runtimeDirectory, source.runtimeDirectory);
  assert.equal(stripped.runsRootDirectory, source.runsRootDirectory);
});

test('native path watchers rearm across sequential Steam process launches', async () => {
  const watcher = new FakeProcessWatcher();
  const session = new FakeOverlaySession();
  const launchers = [];
  const autoAttacher = new SteamGameAutoAttacher({
    session,
    reshadeConfig: createConfig(),
    watcherFactory: () => watcher,
    launcherFactory: (config) => {
      const launcher = new FakeLauncher(config);
      launchers.push(launcher);
      return launcher;
    },
  });

  autoAttacher.start();
  await flushMicrotasks();
  assert.equal(launchers.length, 1);
  assert.deepEqual(launchers[0].target, {
    pathContains: '\\steamapps\\',
    excludedProcessNames: STEAM_AUTO_ATTACH_EXCLUDED_PROCESS_NAMES,
  });

  watcher.ready();
  watcher.create(
    processInfo(1001, 'D:\\SteamLibrary\\steamapps\\common\\One\\one.exe'),
  );
  watcher.create(processInfo(1003, 'C:\\Windows\\System32\\notepad.exe'));
  await flushMicrotasks();

  assert.equal(launchers.length, 1, 'WMI must not start late injectors');
  assert.deepEqual(
    autoAttacher.targets.map(({ pid, phase }) => ({ pid, phase })),
    [{ pid: 1001, phase: 'attaching' }],
  );

  launchers[0].connect(
    1001,
    'D:\\SteamLibrary\\steamapps\\common\\One\\one.exe',
  );
  await flushMicrotasks();
  assert.equal(launchers.length, 2, 'the next path watcher rearms immediately');
  assert.deepEqual(launchers[1].target, {
    pathContains: '\\steamapps\\',
    excludedProcessNames: STEAM_AUTO_ATTACH_EXCLUDED_PROCESS_NAMES,
  });
  assert.deepEqual(
    autoAttacher.targets.map(({ pid, phase }) => ({ pid, phase })),
    [{ pid: 1001, phase: 'connected' }],
  );

  watcher.create(processInfo(1002, 'E:/Games/SteamApps/common/Two/two.exe'));
  watcher.create(processInfo(1002, 'E:/Games/SteamApps/common/Two/two.exe'));
  await flushMicrotasks();
  assert.equal(launchers.length, 2, 'WMI must remain status-only');
  assert.deepEqual(
    autoAttacher.targets.map(({ pid, phase }) => ({ pid, phase })),
    [
      { pid: 1001, phase: 'connected' },
      { pid: 1002, phase: 'attaching' },
    ],
  );

  launchers[1].connect(
    1002,
    'E:\\Games\\SteamApps\\common\\Two\\two.exe',
  );
  await flushMicrotasks();
  assert.equal(launchers.length, 3);
  assert.deepEqual(
    autoAttacher.targets.map(({ pid, phase }) => ({ pid, phase })),
    [
      { pid: 1001, phase: 'connected' },
      { pid: 1002, phase: 'connected' },
    ],
  );

  watcher.delete(processInfo(1001, ''));
  assert.equal(launchers[0].disposed, true);
  assert.deepEqual(
    autoAttacher.targets.map(({ pid }) => pid),
    [1002],
  );

  session.emitNative('game.process.disconnected', { pid: 1002 });
  await flushMicrotasks();
  assert.equal(launchers[1].disposed, true);
  assert.deepEqual(autoAttacher.targets, []);

  await autoAttacher.dispose();
  assert.equal(watcher.stopped, true);
  assert.equal(launchers[2].disposed, true);
});

test('WMI observations ignore excluded Steam helper names case-insensitively', async () => {
  const watcher = new FakeProcessWatcher();
  const session = new FakeOverlaySession();
  const launchers = [];
  const autoAttacher = new SteamGameAutoAttacher({
    session,
    reshadeConfig: createConfig(),
    watcherFactory: () => watcher,
    launcherFactory: (config) => {
      const launcher = new FakeLauncher(config);
      launchers.push(launcher);
      return launcher;
    },
  });

  autoAttacher.start();
  await flushMicrotasks();
  watcher.create(
    processInfo(
      1101,
      'D:\\SteamLibrary\\steamapps\\common\\One\\unitycrashhandler.EXE',
    ),
  );
  watcher.create(
    processInfo(
      1102,
      'D:\\SteamLibrary\\steamapps\\common\\One\\UNITYCRASHHANDLER32.exe',
    ),
  );
  watcher.create(
    processInfo(
      1103,
      'D:\\SteamLibrary\\steamapps\\common\\One\\UnityCrashHandler64.ExE',
    ),
  );
  watcher.create(
    processInfo(1104, 'D:\\SteamLibrary\\steamapps\\common\\One\\one.exe'),
  );

  assert.equal(launchers.length, 1);
  assert.deepEqual(
    autoAttacher.targets.map(({ pid, processName }) => ({ pid, processName })),
    [{ pid: 1104, processName: 'one.exe' }],
  );

  await autoAttacher.dispose();
});

test('native prearming continues when WMI watcher setup throws', async (t) => {
  const scenarios = [
    {
      name: 'watcher factory throws',
      watcherFactory: () => {
        throw new Error('watcher construction failed');
      },
      expectedError: 'watcher construction failed',
    },
    {
      name: 'watcher start throws',
      watcherFactory: () => ({
        start() {
          throw new Error('watcher startup failed');
        },
        stop() {
          return Promise.resolve();
        },
      }),
      expectedError: 'watcher startup failed',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const launchers = [];
      const autoAttacher = new SteamGameAutoAttacher({
        session: new FakeOverlaySession(),
        reshadeConfig: createConfig(),
        watcherFactory: scenario.watcherFactory,
        launcherFactory: (config) => {
          const launcher = new FakeLauncher(config);
          launchers.push(launcher);
          return launcher;
        },
      });

      autoAttacher.start();
      await flushMicrotasks();

      assert.equal(autoAttacher.watcherStatus, 'failed');
      assert.equal(autoAttacher.watcherError, scenario.expectedError);
      assert.equal(launchers.length, 1);
      assert.deepEqual(launchers[0].target, {
        pathContains: '\\steamapps\\',
        excludedProcessNames: STEAM_AUTO_ATTACH_EXCLUDED_PROCESS_NAMES,
      });

      await autoAttacher.dispose();
    });
  }
});

test('a failed prearm is replaced without asking WMI to inject a live PID', async () => {
  const watcher = new FakeProcessWatcher();
  const session = new FakeOverlaySession();
  const launchers = [];
  const autoAttacher = new SteamGameAutoAttacher({
    session,
    reshadeConfig: createConfig(),
    watcherFactory: () => watcher,
    launcherFactory: (config) => {
      const launcher = new FakeLauncher(config);
      launchers.push(launcher);
      return launcher;
    },
  });
  const info = processInfo(
    2001,
    'D:\\SteamLibrary\\steamapps\\common\\Failed\\failed.exe',
  );

  autoAttacher.start();
  watcher.create(info);
  await flushMicrotasks();
  launchers[0].fail(new Error('injection refused'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(launchers[0].disposed, true);
  assert.equal(launchers.length, 2);
  assert.equal(autoAttacher.targets[0].phase, 'attaching');
  assert.equal(autoAttacher.targets[0].error, null);

  watcher.create(info);
  assert.equal(launchers.length, 2);

  watcher.delete(info);
  assert.deepEqual(autoAttacher.targets, []);
  watcher.create(info);
  assert.equal(launchers.length, 2);

  await autoAttacher.dispose();
});

test('dispose stops the watcher before launchers and ignores late events', async () => {
  const order = [];
  const watcher = new FakeProcessWatcher(order);
  const session = new FakeOverlaySession();
  const launchers = [];
  const autoAttacher = new SteamGameAutoAttacher({
    session,
    reshadeConfig: createConfig(),
    watcherFactory: () => watcher,
    launcherFactory: (config) => {
      const launcher = new FakeLauncher(config, order);
      launchers.push(launcher);
      return launcher;
    },
  });

  autoAttacher.start();
  watcher.create(
    processInfo(3001, 'D:\\SteamLibrary\\steamapps\\common\\One\\one.exe'),
  );
  await autoAttacher.dispose();

  assert.deepEqual(order, ['watcher-stop', 'launcher-dispose']);
  watcher.create(
    processInfo(3002, 'D:\\SteamLibrary\\steamapps\\common\\Two\\two.exe'),
  );
  assert.equal(launchers.length, 1);
  assert.deepEqual(autoAttacher.targets, []);
});

class FakeProcessWatcher {
  handlers = null;
  stopped = false;

  constructor(order = []) {
    this.order = order;
  }

  start(handlers) {
    this.handlers = handlers;
    handlers.onStatus('starting');
  }

  ready() {
    this.handlers?.onStatus('running');
  }

  create(payload) {
    this.handlers?.onEvent({ type: 'process-creation', payload });
  }

  delete(payload) {
    this.handlers?.onEvent({ type: 'process-deletion', payload });
  }

  stop() {
    this.stopped = true;
    this.order.push('watcher-stop');
    return Promise.resolve();
  }
}

function createFakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = null;
  child.stderr = null;
  child.exitCode = null;
  child.signalCode = null;
  child.connected = true;
  child.disconnect = () => {
    child.connected = false;
  };
  child.kill = () => true;
  return child;
}

class FakeOverlaySession {
  handlers = new Set();

  on(event, handler) {
    assert.equal(event, 'nativeEvent');
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose() {
    return () => {};
  }

  whenReady() {
    return Promise.resolve();
  }

  emitNative(event, payload) {
    for (const handler of this.handlers) {
      handler({ event, payload });
    }
  }
}

class FakeLauncher {
  state = 'idle';
  target = null;
  disposed = false;

  constructor(config, order = []) {
    this.config = config;
    this.order = order;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  attach(session, target) {
    assert.ok(session);
    this.state = 'attaching';
    this.target = target;
    return this.promise;
  }

  connect(
    pid,
    selectedPath = `C:\\SteamLibrary\\steamapps\\common\\Game\\game.exe`,
  ) {
    this.state = 'connected';
    this.resolve({
      pid,
      processName: selectedPath.split(/[\\/]/).at(-1),
      selectedPath,
    });
  }

  fail(error) {
    this.state = 'blocked';
    this.reject(error);
  }

  dispose() {
    this.disposed = true;
    this.state = 'idle';
    this.order.push('launcher-dispose');
  }
}

function createConfig(overrides = {}) {
  return {
    runtimeDirectory: 'C:\\runtime',
    runsRootDirectory: 'C:\\runs',
    injectorPath: 'C:\\runtime\\inject.exe',
    runtimePath: 'C:\\runtime\\ReShade64.dll',
    buildStampPath: 'C:\\runtime\\ReShade64.build.json',
    addonPath: 'C:\\runtime\\electron_game_overlay.addon64',
    configPath: 'C:\\runtime\\ReShade.ini',
    ...overrides,
  };
}

function processInfo(pid, filepath) {
  return {
    process: filepath ? filepath.split(/[\\/]/).at(-1) : '',
    pid,
    filepath,
    user: 'tester',
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
