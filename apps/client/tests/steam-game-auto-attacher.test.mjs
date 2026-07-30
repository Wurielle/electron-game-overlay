import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ReShadeOperationError } from 'electron-game-overlay';
import {
  ForkedProcessWatcher,
  isSteamAppsProcessPath,
  resolveNodeExecutable,
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
    'C:\\runtime\\inject.exe',
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
  assert.deepEqual(calls[0][1], ['C:\\runtime\\inject.exe']);
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

test('the prearmed Steam path lane has no exclusions while every observed executable keeps an exact attempt', async () => {
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
    prearmedPathInjection: true,
    preparedLauncherPoolSize: 0,
  });
  const processes = [
    processInfo(
      8801,
      'D:\\SteamLibrary\\steamapps\\common\\Gun Frog\\Gun Frog.exe',
    ),
    processInfo(
      8802,
      'D:\\SteamLibrary\\steamapps\\common\\Gun Frog\\UnityCrashHandler64.exe',
    ),
    processInfo(
      8803,
      'D:\\SteamLibrary\\steamapps\\common\\Steamworks Shared\\_CommonRedist\\VC_redist.x64.exe',
    ),
  ];

  autoAttacher.start();
  watcher.ready();
  await flushMicrotasks();
  assert.equal(launchers.length, 1);
  assert.deepEqual(launchers[0].target, {
    pathContains: '\\steamapps\\',
  });

  for (const info of processes) {
    watcher.create(info);
  }
  await flushMicrotasks();
  assert.equal(launchers.length, 4);
  assert.deepEqual(
    launchers.slice(1).map(({ target }) => target),
    processes.map(({ pid, process }) => ({ processName: process, pid })),
  );

  launchers[0].connect(processes[0].pid, processes[0].filepath);
  await flushMicrotasks();
  assert.equal(
    launchers[1].disposed,
    true,
    'the exact loser must be released when the prearmed path wins',
  );
  assert.deepEqual(
    autoAttacher.targets.map(({ pid, phase }) => ({ pid, phase })),
    [
      { pid: 8801, phase: 'connected' },
      { pid: 8802, phase: 'attaching' },
      { pid: 8803, phase: 'attaching' },
    ],
  );
  assert.equal(launchers.length, 5);
  assert.deepEqual(launchers[4].target, {
    pathContains: '\\steamapps\\',
  });

  await autoAttacher.dispose();
});

test('an exact-PID winner keeps the target connected when the prearmed attempt loses its native claim', async () => {
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
    prearmedPathInjection: true,
    preparedLauncherPoolSize: 0,
  });
  const info = processInfo(
    8811,
    'D:\\SteamLibrary\\steamapps\\common\\Race\\race.exe',
  );

  autoAttacher.start();
  watcher.ready();
  watcher.create(info);
  await flushMicrotasks();
  assert.equal(launchers.length, 2);

  launchers[1].connect(info.pid, info.filepath);
  await flushMicrotasks();
  launchers[0].fail(
    new ReShadeOperationError({
      stage: 'target-preflight',
      code: 'target-injection-already-claimed',
      retrySafety: 'definite-safe',
      message: 'another injector owns the target claim',
      targetLabel: 'path:\\steamapps\\',
      pid: info.pid,
    }),
  );
  await flushMicrotasks();

  assert.deepEqual(autoAttacher.targets, [
    {
      pid: info.pid,
      processName: 'race.exe',
      filepath: info.filepath,
      phase: 'connected',
      error: null,
      diagnostic: null,
    },
  ]);
  assert.equal(launchers[0].disposed, true);
  assert.equal(launchers[1].disposed, false);
  assert.equal(launchers.length, 3);
  assert.deepEqual(launchers[2].target, {
    pathContains: '\\steamapps\\',
  });

  await autoAttacher.dispose();
});

test('a path-first target still receives its independent exact-PID attempt when observation arrives', async () => {
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
    prearmedPathInjection: true,
    preparedLauncherPoolSize: 0,
  });
  const info = processInfo(
    8821,
    'D:\\SteamLibrary\\steamapps\\common\\Path First\\path-first.exe',
  );

  autoAttacher.start();
  watcher.ready();
  await flushMicrotasks();
  launchers[0].connect(info.pid, info.filepath);
  await flushMicrotasks();
  assert.equal(autoAttacher.targets[0].phase, 'connected');
  assert.deepEqual(launchers[1].target, {
    pathContains: '\\steamapps\\',
  });

  watcher.create(info);
  await flushMicrotasks();
  assert.equal(launchers.length, 3);
  assert.deepEqual(launchers[2].target, {
    processName: 'path-first.exe',
    pid: info.pid,
  });

  launchers[2].fail(
    new ReShadeOperationError({
      stage: 'target-preflight',
      code: 'target-runtime-conflict',
      retrySafety: 'definite-safe',
      message: 'the prearmed lane already initialized the runtime',
      targetLabel: 'process:path-first.exe:pid:8821',
      pid: info.pid,
    }),
  );
  await flushMicrotasks();
  assert.equal(autoAttacher.targets[0].phase, 'connected');

  await autoAttacher.dispose();
});

test('an exact claim loser cannot stay attaching if its prearmed owner later fails', async () => {
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
    prearmedPathInjection: true,
    preparedLauncherPoolSize: 0,
  });
  const info = processInfo(
    8831,
    'D:\\SteamLibrary\\steamapps\\common\\Claim Failure\\claim-failure.exe',
  );

  autoAttacher.start();
  watcher.ready();
  watcher.create(info);
  await flushMicrotasks();
  assert.equal(launchers.length, 2);

  launchers[1].fail(
    new ReShadeOperationError({
      stage: 'target-preflight',
      code: 'target-injection-already-claimed',
      retrySafety: 'definite-safe',
      message: 'the prearmed lane owns the process claim',
      targetLabel: 'process:claim-failure.exe:pid:8831',
      pid: info.pid,
    }),
  );
  await flushMicrotasks();
  assert.equal(autoAttacher.targets[0].phase, 'failed');

  launchers[0].fail(new Error('the path injector failed after selection'));
  await flushMicrotasks();
  assert.equal(
    autoAttacher.targets[0].phase,
    'failed',
    'the coordinated target must not remain permanently attaching',
  );

  await autoAttacher.dispose();
});

test('the watcher starts before prewarm and queued targets consume immediately replenished slots', async () => {
  const watcher = new FakeProcessWatcher();
  const session = new FakeOverlaySession();
  const initialPreparations = [createDeferred(), createDeferred()];
  const launchers = [];
  const autoAttacher = new SteamGameAutoAttacher({
    session,
    reshadeConfig: createConfig(),
    watcherFactory: () => watcher,
    launcherFactory: (config) => {
      const index = launchers.length;
      const launcher = new FakeLauncher(
        config,
        [],
        index < initialPreparations.length
          ? () => initialPreparations[index].promise
          : undefined,
      );
      launchers.push(launcher);
      return launcher;
    },
    preparedLauncherPoolSize: 2,
  });

  autoAttacher.start();
  assert.equal(launchers.length, 2);
  assert.notEqual(
    watcher.handlers,
    null,
    'native observation must not wait for every runtime copy to finish',
  );
  assert.equal(autoAttacher.watcherStatus, 'starting');

  watcher.create(
    processInfo(
      9010,
      'D:\\SteamLibrary\\steamapps\\common\\Prepared\\first.exe',
    ),
  );
  watcher.create(
    processInfo(
      9011,
      'D:\\SteamLibrary\\steamapps\\common\\Prepared\\second.exe',
    ),
  );
  await flushMicrotasks();
  assert.equal(launchers[0].target, null);
  assert.equal(launchers[1].target, null);

  initialPreparations[0].resolve();
  await flushMicrotasks();
  await flushMicrotasks();
  assert.deepEqual(launchers[0].target, {
    processName: 'first.exe',
    pid: 9010,
  });
  assert.equal(
    launchers.length,
    4,
    'each consumed slot should begin one bounded replacement immediately',
  );
  assert.deepEqual(launchers[2].target, {
    processName: 'second.exe',
    pid: 9011,
  });
  assert.equal(launchers[1].target, null);
  assert.equal(launchers[3].prepared, true);
  assert.equal(launchers[3].target, null);

  initialPreparations[1].resolve();
  await flushMicrotasks();
  await autoAttacher.dispose();
});

test('failed pool preparation backs off without delaying watcher startup or exceeding the pool bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watcher = new FakeProcessWatcher();
  const session = new FakeOverlaySession();
  const launchers = [];
  const autoAttacher = new SteamGameAutoAttacher({
    session,
    reshadeConfig: createConfig(),
    watcherFactory: () => watcher,
    launcherFactory: (config) => {
      const launcher = new FakeLauncher(config, [], () =>
        Promise.reject(new Error('runtime staging failed')),
      );
      launchers.push(launcher);
      return launcher;
    },
    preparedLauncherPoolSize: 2,
    preparedLauncherRetryBaseDelayMs: 50,
    preparedLauncherRetryMaxDelayMs: 200,
  });

  autoAttacher.start();
  await flushMicrotasks();

  assert.notEqual(
    watcher.handlers,
    null,
    'a failed pool member must not prevent the watcher from starting',
  );
  assert.equal(launchers.length, 2);
  assert.equal(launchers[0].disposed, true);
  assert.equal(launchers[1].disposed, true);
  assert.equal(launchers[0].prepared, false);

  t.mock.timers.tick(49);
  await flushMicrotasks();
  assert.equal(launchers.length, 2);
  t.mock.timers.tick(1);
  await flushMicrotasks();
  assert.equal(
    launchers.length,
    4,
    'one retry pass should remain bounded by the configured pool size',
  );

  t.mock.timers.tick(199);
  await flushMicrotasks();
  assert.equal(launchers.length, 4);
  t.mock.timers.tick(1);
  await flushMicrotasks();
  assert.equal(launchers.length, 6);

  await autoAttacher.dispose();
});

test('dispose releases both unused and still-preparing pool launchers', async () => {
  const watcher = new FakeProcessWatcher();
  const pendingPreparation = createDeferred();
  const launchers = [];
  const autoAttacher = new SteamGameAutoAttacher({
    session: new FakeOverlaySession(),
    reshadeConfig: createConfig(),
    watcherFactory: () => watcher,
    launcherFactory: (config) => {
      const index = launchers.length;
      const launcher = new FakeLauncher(
        config,
        [],
        index === 1 ? () => pendingPreparation.promise : undefined,
      );
      launchers.push(launcher);
      return launcher;
    },
    preparedLauncherPoolSize: 2,
  });

  autoAttacher.start();
  await flushMicrotasks();
  assert.equal(launchers[0].prepared, true);
  assert.equal(launchers[1].prepared, false);
  assert.notEqual(watcher.handlers, null);

  await autoAttacher.dispose();
  assert.equal(launchers[0].disposed, true);
  assert.equal(launchers[1].disposed, true);
  assert.equal(watcher.stopped, true);
  assert.equal(autoAttacher.watcherStatus, 'stopped');

  pendingPreparation.resolve();
  await flushMicrotasks();
  assert.equal(launchers.length, 2);
});

test('a process deleted while queued is never attached after preparation finishes', async () => {
  const watcher = new FakeProcessWatcher();
  const pendingPreparation = createDeferred();
  const launchers = [];
  const autoAttacher = new SteamGameAutoAttacher({
    session: new FakeOverlaySession(),
    reshadeConfig: createConfig(),
    watcherFactory: () => watcher,
    launcherFactory: (config) => {
      const launcher = new FakeLauncher(
        config,
        [],
        () => pendingPreparation.promise,
      );
      launchers.push(launcher);
      return launcher;
    },
    preparedLauncherPoolSize: 1,
  });
  const info = processInfo(
    9030,
    'D:\\SteamLibrary\\steamapps\\common\\Gone\\gone.exe',
  );

  autoAttacher.start();
  watcher.create(info);
  watcher.delete(info);
  pendingPreparation.resolve();
  await flushMicrotasks();

  assert.equal(launchers.length, 1);
  assert.equal(launchers[0].target, null);
  assert.deepEqual(autoAttacher.targets, []);
  await autoAttacher.dispose();
});

test('connected and attaching target deletion is confirmed before launcher disposal', async () => {
  const watcher = new FakeProcessWatcher();
  const session = new FakeOverlaySession();
  const order = [];
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
    preparedLauncherPoolSize: 0,
  });
  const watcherDeleted = processInfo(
    9040,
    'D:\\SteamLibrary\\steamapps\\common\\Deleted\\deleted.exe',
  );
  const sessionDisconnected = processInfo(
    9041,
    'D:\\SteamLibrary\\steamapps\\common\\Disconnected\\disconnected.exe',
  );
  const attachingDeleted = processInfo(
    9042,
    'D:\\SteamLibrary\\steamapps\\common\\Attaching\\attaching.exe',
  );

  autoAttacher.start();
  watcher.create(watcherDeleted);
  await flushMicrotasks();
  launchers[0].connect(watcherDeleted.pid, watcherDeleted.filepath);
  await flushMicrotasks();

  watcher.delete(watcherDeleted);

  assert.deepEqual(launchers[0].exitConfirmations, [
    { pid: watcherDeleted.pid, confirmed: true },
  ]);
  assert.deepEqual(order, [
    `launcher-confirm-exit:${watcherDeleted.pid}:true`,
    'launcher-dispose',
  ]);
  assert.deepEqual(autoAttacher.targets, []);

  order.length = 0;
  watcher.create(sessionDisconnected);
  await flushMicrotasks();
  launchers[1].connect(sessionDisconnected.pid, sessionDisconnected.filepath);
  await flushMicrotasks();

  session.emitNative('game.process.disconnected', {
    pid: sessionDisconnected.pid,
  });
  await flushMicrotasks();

  assert.deepEqual(launchers[1].exitConfirmations, [
    { pid: sessionDisconnected.pid, confirmed: false },
  ]);
  assert.deepEqual(order, [
    `launcher-confirm-exit:${sessionDisconnected.pid}:false`,
    'launcher-dispose',
  ]);
  assert.deepEqual(autoAttacher.targets, []);

  order.length = 0;
  watcher.create(attachingDeleted);
  await flushMicrotasks();
  watcher.delete(attachingDeleted);

  assert.deepEqual(launchers[2].exitConfirmations, [
    { pid: attachingDeleted.pid, confirmed: true },
  ]);
  assert.deepEqual(order, [
    `launcher-confirm-exit:${attachingDeleted.pid}:true`,
    'launcher-dispose',
  ]);
  assert.deepEqual(autoAttacher.targets, []);

  await autoAttacher.dispose();
});

test('every detected Steam executable starts an independent exact-PID injection', async () => {
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
  assert.equal(launchers.length, 0);

  watcher.ready();
  watcher.create(
    processInfo(1001, 'D:\\SteamLibrary\\steamapps\\common\\One\\one.exe'),
  );
  watcher.create(processInfo(1003, 'C:\\Windows\\System32\\notepad.exe'));
  await flushMicrotasks();

  assert.equal(launchers.length, 1);
  assert.deepEqual(launchers[0].target, {
    processName: 'one.exe',
    pid: 1001,
  });
  assert.deepEqual(
    autoAttacher.targets.map(({ pid, phase }) => ({ pid, phase })),
    [{ pid: 1001, phase: 'attaching' }],
  );

  launchers[0].connect(
    1001,
    'D:\\SteamLibrary\\steamapps\\common\\One\\one.exe',
  );
  await flushMicrotasks();
  assert.equal(launchers.length, 1);
  assert.deepEqual(
    autoAttacher.targets.map(({ pid, phase }) => ({ pid, phase })),
    [{ pid: 1001, phase: 'connected' }],
  );

  watcher.create(processInfo(1002, 'E:/Games/SteamApps/common/Two/two.exe'));
  watcher.create(processInfo(1002, 'E:/Games/SteamApps/common/Two/two.exe'));
  await flushMicrotasks();
  assert.equal(launchers.length, 2, 'a live PID is attempted exactly once');
  assert.deepEqual(launchers[1].target, {
    processName: 'two.exe',
    pid: 1002,
  });
  assert.deepEqual(
    autoAttacher.targets.map(({ pid, phase }) => ({ pid, phase })),
    [
      { pid: 1001, phase: 'connected' },
      { pid: 1002, phase: 'attaching' },
    ],
  );

  launchers[1].connect(1002, 'E:\\Games\\SteamApps\\common\\Two\\two.exe');
  await flushMicrotasks();
  assert.equal(launchers.length, 2);
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
});

test('launcher, renderer, helpers, and redistributables are all attempted', async () => {
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
  const processes = [
    processInfo(
      1101,
      'D:\\SteamLibrary\\steamapps\\common\\LORT\\LortGame.exe',
    ),
    processInfo(
      1102,
      'D:\\SteamLibrary\\steamapps\\common\\LORT\\BW\\Binaries\\Win64\\LortGame-Win64-Shipping.exe',
    ),
    processInfo(
      1103,
      'D:\\SteamLibrary\\steamapps\\common\\One\\UnityCrashHandler64.exe',
    ),
    processInfo(
      1104,
      'D:\\SteamLibrary\\steamapps\\common\\Steamworks Shared\\_CommonRedist\\VC_redist.x64.exe',
    ),
  ];
  for (const info of processes) {
    watcher.create(info);
  }
  await flushMicrotasks();

  assert.equal(launchers.length, processes.length);
  assert.deepEqual(
    launchers.map(({ target }) => target),
    processes.map(({ pid, process }) => ({ processName: process, pid })),
  );

  launchers[0].fail(new Error('bootstrap did not initialize graphics'));
  launchers[1].connect(1102, processes[1].filepath);
  await flushMicrotasks();
  assert.deepEqual(
    autoAttacher.targets.slice(0, 2).map(({ pid, phase }) => ({ pid, phase })),
    [
      { pid: 1101, phase: 'failed' },
      { pid: 1102, phase: 'connected' },
    ],
  );

  await autoAttacher.dispose();
});

test('no injection starts when the process watcher cannot start', async (t) => {
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
        prearmedPathInjection: true,
      });

      autoAttacher.start();
      await flushMicrotasks();

      assert.equal(autoAttacher.watcherStatus, 'failed');
      assert.equal(autoAttacher.watcherError, scenario.expectedError);
      assert.equal(launchers.length, 0);

      await autoAttacher.dispose();
    });
  }
});

test('no prearmed injection starts before asynchronous watcher readiness', async () => {
  const watcher = new FakeProcessWatcher();
  const launchers = [];
  const autoAttacher = new SteamGameAutoAttacher({
    session: new FakeOverlaySession(),
    reshadeConfig: createConfig(),
    watcherFactory: () => watcher,
    launcherFactory: (config) => {
      const launcher = new FakeLauncher(config);
      launchers.push(launcher);
      return launcher;
    },
    prearmedPathInjection: true,
    preparedLauncherPoolSize: 0,
  });

  autoAttacher.start();
  await flushMicrotasks();
  assert.equal(autoAttacher.watcherStatus, 'starting');
  assert.equal(launchers.length, 0);

  watcher.fail('native observer failed before ready');
  await flushMicrotasks();
  assert.equal(autoAttacher.watcherStatus, 'failed');
  assert.equal(launchers.length, 0);

  await autoAttacher.dispose();
});

test('a failed PID is not retried until deletion proves a new process lifetime', async () => {
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
  await flushMicrotasks();
  assert.equal(launchers[0].disposed, true);
  assert.equal(launchers.length, 1);
  assert.equal(autoAttacher.targets[0].phase, 'failed');
  assert.equal(autoAttacher.targets[0].error, 'injection refused');
  assert.equal(autoAttacher.targets[0].diagnostic, null);

  watcher.create(info);
  assert.equal(launchers.length, 1);

  watcher.delete(info);
  assert.deepEqual(autoAttacher.targets, []);
  watcher.create(info);
  await flushMicrotasks();
  assert.equal(launchers.length, 2);
  assert.deepEqual(launchers[1].target, {
    processName: 'failed.exe',
    pid: 2001,
  });

  await autoAttacher.dispose();
});

test('a late overlay handshake promotes an already attempted PID', async () => {
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
  const filepath =
    'D:\\SteamLibrary\\steamapps\\common\\Slow Game\\slow-game.exe';

  autoAttacher.start();
  watcher.create(processInfo(2501, filepath));
  await flushMicrotasks();
  const initializationFailure = new ReShadeOperationError({
    stage: 'runtime-initialization',
    code: 'runtime-initialization-timeout',
    retrySafety: 'indeterminate',
    message: 'graphics initialization proof timed out',
    targetLabel: 'process:slow-game.exe:pid:2501',
    pid: 2501,
  });
  launchers[0].fail(initializationFailure);
  await flushMicrotasks();
  assert.equal(autoAttacher.targets[0].phase, 'failed');
  assert.equal(
    autoAttacher.targets[0].diagnostic,
    initializationFailure.diagnostic,
  );

  session.emitNative('game.process', { pid: 2501, path: filepath });
  await flushMicrotasks();
  assert.equal(launchers.length, 1, 'late initialization must not reinject');
  assert.deepEqual(autoAttacher.targets[0], {
    pid: 2501,
    processName: 'slow-game.exe',
    filepath,
    phase: 'connected',
    error: null,
    diagnostic: null,
  });

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

  fail(error) {
    this.handlers?.onStatus('failed', error);
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
  connectedPid = null;
  exitConfirmations = [];
  prepareCalls = 0;
  prepared = false;

  constructor(config, order = [], prepareOperation = undefined) {
    this.config = config;
    this.order = order;
    this.prepareOperation = prepareOperation ?? (() => Promise.resolve());
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  prepare() {
    this.prepareCalls += 1;
    return Promise.resolve()
      .then(() => this.prepareOperation())
      .then(() => {
        this.prepared = true;
      });
  }

  attach(session, target) {
    assert.ok(session);
    this.state = 'attaching';
    this.target = target;
    this.removeSessionListener = session.on(
      'nativeEvent',
      ({ event, payload }) => {
        if (
          event !== 'game.process.disconnected' ||
          payload?.pid !== this.connectedPid
        ) {
          return;
        }
        this.state = 'idle';
        this.connectedPid = null;
        this.removeSessionListener?.();
        this.removeSessionListener = undefined;
      },
    );
    return this.promise;
  }

  connect(
    pid,
    selectedPath = `C:\\SteamLibrary\\steamapps\\common\\Game\\game.exe`,
  ) {
    this.state = 'connected';
    this.connectedPid = pid;
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

  confirmTargetExited(pid) {
    const confirmed =
      (this.state === 'connected' && this.connectedPid === pid) ||
      (this.state === 'attaching' && this.target?.pid === pid);
    this.exitConfirmations.push({ pid, confirmed });
    this.order.push(`launcher-confirm-exit:${pid}:${confirmed}`);
    if (confirmed) {
      this.state = 'idle';
      this.connectedPid = null;
      this.removeSessionListener?.();
      this.removeSessionListener = undefined;
    }
    return confirmed;
  }

  dispose() {
    this.disposed = true;
    this.state = 'idle';
    this.connectedPid = null;
    this.removeSessionListener?.();
    this.removeSessionListener = undefined;
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
