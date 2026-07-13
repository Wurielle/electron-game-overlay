const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fsPromises = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  RESHADE_CLIENT_INJECTOR_RETURNED_MARKER,
  RESHADE_CLIENT_INJECTOR_STARTED_MARKER,
  RESHADE_CLIENT_RUNTIME_STAGED_MARKER,
  RESHADE_CLIENT_TARGET_CONNECTED_MARKER,
  RESHADE_CLIENT_TARGET_DISCONNECTED_MARKER,
  ReShadeOverlayLauncher,
  buildReShadeInvocation,
  defaultReShadeRunsRootDirectory,
  defaultReShadeRuntimeDirectory,
  parseReShadeLaunchConfig,
} = require('../dist/lib/reshade-launcher.js');

const artifacts = [
  'inject.exe',
  'ReShade64.dll',
  'ReShade64.build.json',
  'electron_reshade_overlay_poc.addon64',
  'ReShade.ini',
];
const injectorSuccessFor = (pid, processName = 'Gun Frog.exe') =>
  `Waiting for a '${processName}' process to spawn ...\n` +
  `Found a matching process with PID ${pid}! Injecting ReShade ... Succeeded!\n`;
const injectorSuccess = injectorSuccessFor(4242);
const temporaryDirectories = new Set();

test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

test('ReShade stays disabled without opt-in and exposes absolute default roots', () => {
  assert.equal(
    parseReShadeLaunchConfig(['electron.exe'], {
      bundledRuntimeDirectory: path.join(tmpdir(), 'missing-reshade-runtime'),
    }),
    null,
  );
  assert.ok(path.isAbsolute(defaultReShadeRuntimeDirectory()));
  assert.ok(
    defaultReShadeRuntimeDirectory().endsWith(
      path.join('runtime', 'win32-x64', 'reshade'),
    ),
  );
  assert.ok(path.isAbsolute(defaultReShadeRunsRootDirectory()));
});

test('startup parsing validates a co-located runtime without a graphics backend', () => {
  const fixture = createRuntime();
  const config = parseReShadeLaunchConfig(
    [
      'electron.exe',
      '--reshade-overlay',
      `--reshade-runtime-dir=${fixture.runtimeDirectory}`,
      '--reshade-auto-target-process=Gun Frog.exe',
      '--reshade-expected-target-pid=4242',
    ],
    { runsRootDirectory: fixture.runsRootDirectory },
  );

  assert.ok(config);
  assert.equal(config.runtimeDirectory, fixture.runtimeDirectory);
  assert.equal(config.runsRootDirectory, fixture.runsRootDirectory);
  assert.equal(config.autoTargetProcess, 'Gun Frog.exe');
  assert.equal(config.expectedTargetPid, 4242);
  assert.equal(Object.hasOwn(config, 'backend'), false);
  assert.deepEqual(
    [
      config.injectorPath,
      config.runtimePath,
      config.buildStampPath,
      config.addonPath,
      config.configPath,
    ].map((artifactPath) => path.basename(artifactPath)),
    artifacts,
  );

  const runDirectory = path.join(fixture.runsRootDirectory, 'exact-run');
  assert.deepEqual(
    buildReShadeInvocation({ processName: 'Gun Frog.exe' }, runDirectory),
    {
      executable: path.join(runDirectory, 'inject.exe'),
      arguments: ['Gun Frog.exe'],
      targetLabel: 'process:Gun Frog.exe',
      workingDirectory: runDirectory,
    },
  );
  assert.deepEqual(
    buildReShadeInvocation(
      { processName: 'Gun Frog.exe', pid: 4242 },
      runDirectory,
    ),
    {
      executable: path.join(runDirectory, 'inject.exe'),
      arguments: ['Gun Frog.exe', '--pid', '4242'],
      targetLabel: 'process:Gun Frog.exe:pid:4242',
      workingDirectory: runDirectory,
    },
  );
});

test('startup and target validation reject incomplete or unsafe inputs', () => {
  const fixture = createRuntime();
  const valid = [
    'electron.exe',
    '--reshade-overlay',
    `--reshade-runtime-dir=${fixture.runtimeDirectory}`,
    '--reshade-auto-target-process=game.exe',
  ];

  assert.throws(
    () => parseReShadeLaunchConfig([...valid, '--reshade-overlay']),
    /exactly once/,
  );
  assert.throws(
    () =>
      parseReShadeLaunchConfig(
        [
          ...valid.filter(
            (argument) =>
              !argument.startsWith('--reshade-auto-target-process='),
          ),
          '--reshade-expected-target-pid=42',
        ],
        { runsRootDirectory: fixture.runsRootDirectory },
      ),
    /expected-target-pid.*requires.*auto-target-process/,
  );
  assert.throws(
    () =>
      parseReShadeLaunchConfig(
        valid.map((argument) =>
          argument.startsWith('--reshade-runtime-dir=')
            ? '--reshade-runtime-dir=relative'
            : argument,
        ),
      ),
    /runtime-dir.*absolute/,
  );

  for (const processName of [
    '..\\game.exe',
    'folder/game.exe',
    'game',
    ' game.exe',
    'game.exe\n',
  ]) {
    assert.throws(
      () =>
        buildReShadeInvocation(
          { processName },
          path.join(fixture.runsRootDirectory, 'run'),
        ),
      /valid \.exe basename/,
    );
  }

  for (const pid of [0, -1, 1.5, 0x1_0000_0000, NaN, Infinity, '42']) {
    assert.throws(
      () =>
        buildReShadeInvocation(
          { processName: 'game.exe', pid },
          path.join(fixture.runsRootDirectory, 'run'),
        ),
      /target PID.*positive uint32 integer/,
    );
  }

  assert.throws(
    () =>
      parseReShadeLaunchConfig(
        [...valid, '--reshade-expected-target-pid=4294967296'],
        { runsRootDirectory: fixture.runsRootDirectory },
      ),
    /expected-target-pid.*positive uint32 integer/,
  );

  unlinkSync(path.join(fixture.runtimeDirectory, 'ReShade.ini'));
  assert.throws(
    () =>
      parseReShadeLaunchConfig(valid, {
        runsRootDirectory: fixture.runsRootDirectory,
      }),
    /ReShade configuration is unavailable/,
  );
});

test('exact-PID targets are identity-distinct and compatible with a matching configured PID', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(
    createConfig(fixture, { expectedTargetPid: 4242 }),
  );

  try {
    assert.throws(
      () => launcher.launch({ processName: 'game.exe', pid: 4243 }),
      /pid=4243 conflicts with configured expected target pid=4242/,
    );
    assert.throws(
      () =>
        launcher.attach(createSessionHarness().session, {
          processName: 'game.exe',
          pid: 4243,
        }),
      /pid=4243 conflicts with configured expected target pid=4242/,
    );
    assert.equal(launcher.state, 'idle');
    assert.equal(launcher.runDirectory, null);
    assert.equal(execution.calls.length, 0);

    const request = launcher.launch({ processName: 'game.exe', pid: 4242 });
    assert.equal(
      launcher.launch({ processName: 'game.exe', pid: 4242 }),
      request,
      'the same name/PID identity should share its active launch request',
    );
    assert.throws(
      () => launcher.launch({ processName: 'game.exe', pid: 4241 }),
      /conflicts with configured expected target pid=4242/,
    );
    await waitFor(() => execution.calls.length === 1);
    assert.deepEqual(execution.calls[0].arguments, [
      'game.exe',
      '--pid',
      '4242',
    ]);
    execution.calls[0].callback(null, injectorSuccessFor(4242, 'game.exe'), '');
    const result = await request;
    assert.equal(result.targetLabel, 'process:game.exe:pid:4242');
    assert.equal(result.injectorTargetPid, 4242);
    assert.equal(launcher.acceptTargetConnection(4241), false);
    assert.equal(launcher.acceptTargetConnection(4242), true);
  } finally {
    launcher.dispose();
    execution.restore();
  }
});

test('exact-PID stdout mismatch remains indeterminate and blocks retry', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const request = launcher.launch({ processName: 'game.exe', pid: 5001 });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(null, injectorSuccessFor(5002, 'game.exe'), '');
    await assert.rejects(request, /selected pid=5002; expected pid=5001/);
    assert.equal(launcher.state, 'blocked');
    await assert.rejects(
      launcher.launch({ processName: 'game.exe', pid: 5001 }),
      /outcome is indeterminate/,
    );
  } finally {
    launcher.dispose();
    console.error = originalError;
    execution.restore();
  }
});

test('exact-PID pre-injection failure proof returns to idle after the child spawned', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => undefined;
  console.log = () => undefined;

  try {
    const target = { processName: 'game.exe', pid: 6001 };
    const failed = launcher.launch(target);
    await waitFor(() => execution.calls.length === 1);
    const failure = Object.assign(new Error('exact target validation failed'), {
      code: 1,
    });
    execution.calls[0].callback(
      failure,
      'Exact PID target was not usable.\r\nReShade injection not started.\r\n',
      '',
    );
    await assert.rejects(failed, /exact target validation failed/);
    assert.equal(launcher.state, 'idle');

    const retry = launcher.launch(target);
    await waitFor(() => execution.calls.length === 2);
    execution.calls[1].callback(null, injectorSuccessFor(6001, 'game.exe'), '');
    await retry;
    assert.equal(launcher.acceptTargetConnection(6001), true);
  } finally {
    launcher.dispose();
    console.error = originalError;
    console.log = originalLog;
    execution.restore();
  }
});

test('pre-injection proof cannot make legacy or contradictory output retry-safe', async (t) => {
  const scenarios = [
    {
      name: 'name-only invocation',
      target: { processName: 'game.exe' },
      stdout: 'ReShade injection not started.\n',
    },
    {
      name: 'exact-PID output that also reports injection success',
      target: { processName: 'game.exe', pid: 6002 },
      stdout:
        injectorSuccessFor(6002, 'game.exe') +
        'ReShade injection not started.\n',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = createRuntime();
      const execution = stubExecFile();
      const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
      const originalError = console.error;
      const originalLog = console.log;
      console.error = () => undefined;
      console.log = () => undefined;
      try {
        const request = launcher.launch(scenario.target);
        await waitFor(() => execution.calls.length === 1);
        execution.calls[0].callback(
          Object.assign(new Error('ambiguous injector failure'), { code: 1 }),
          scenario.stdout,
          '',
        );
        await assert.rejects(request, /ambiguous injector failure/);
        assert.equal(launcher.state, 'blocked');
      } finally {
        launcher.dispose();
        console.error = originalError;
        console.log = originalLog;
        execution.restore();
      }
    });
  }
});

test('launch copies the exact runtime, uses one process argument, and preserves logs', async () => {
  const fixture = createRuntime();
  const config = createConfig(fixture, { expectedTargetPid: 4242 });
  const execution = stubExecFile();
  const originalLog = console.log;
  const markers = [];
  console.log = (message) => markers.push(String(message));
  const launcher = new ReShadeOverlayLauncher(config);

  try {
    assert.equal(launcher.state, 'idle');
    const request = launcher.launch({ processName: 'Gun Frog.exe' });
    assert.equal(launcher.state, 'attaching');
    assert.equal(launcher.acceptTargetConnection(7), false);
    assert.equal(launcher.state, 'attaching');
    assert.equal(
      launcher.launch({ processName: 'Gun Frog.exe' }),
      request,
      'the same active target should share its launch request',
    );
    await waitFor(() => execution.calls.length === 1);

    const call = execution.calls[0];
    assert.deepEqual(call.arguments, ['Gun Frog.exe']);
    assert.equal(call.options.cwd, path.dirname(call.executable));
    assert.equal(path.basename(call.executable), 'inject.exe');
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 120_000);
    assert.equal(call.options.maxBuffer, 64 * 1024);
    assert.equal(call.options.encoding, 'utf8');

    const runDirectory = call.options.cwd;
    assert.equal(path.dirname(runDirectory), fixture.runsRootDirectory);
    for (const artifact of artifacts) {
      assert.equal(
        readFileSync(path.join(runDirectory, artifact), 'utf8'),
        `fixture:${artifact}`,
      );
    }

    call.callback(null, injectorSuccess, 'diagnostic stderr\n');
    const result = await request;
    assert.equal(result.processName, 'Gun Frog.exe');
    assert.equal(result.targetLabel, 'process:Gun Frog.exe');
    assert.equal(result.injectorTargetPid, 4242);
    assert.equal(result.runDirectory, runDirectory);
    assert.equal(launcher.runDirectory, runDirectory);
    assert.equal(
      readFileSync(result.injectorStdoutPath, 'utf8'),
      injectorSuccess,
    );
    assert.equal(
      readFileSync(result.injectorStderrPath, 'utf8'),
      'diagnostic stderr\n',
    );
    assert.equal(result.reshadeLogPath, path.join(runDirectory, 'ReShade.log'));
    assert.ok(
      markers.some((line) =>
        line.startsWith(`${RESHADE_CLIENT_RUNTIME_STAGED_MARKER} directory=`),
      ),
    );
    assert.ok(
      markers.includes(
        `${RESHADE_CLIENT_INJECTOR_STARTED_MARKER} target="Gun Frog.exe" arguments=["Gun Frog.exe"]`,
      ),
    );
    assert.ok(
      markers.includes(
        `${RESHADE_CLIENT_INJECTOR_RETURNED_MARKER} target="Gun Frog.exe"`,
      ),
    );
    assert.equal(launcher.acceptTargetConnection(4242), true);
    assert.equal(launcher.state, 'connected');
    assert.equal(launcher.acceptTargetConnection(4242), false);
    await assert.rejects(
      launcher.launch({ processName: 'Gun Frog.exe' }),
      /already connected/,
    );
    await assert.rejects(
      launcher.attach(createSessionHarness().session, {
        processName: 'Gun Frog.exe',
      }),
      /already connected/,
    );
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('missing low-level connection proof stays conservatively latched', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const proofTimerHandle = Object.freeze({ proofTimer: true });
  let proofTimerCallback;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 120_000 && proofTimerCallback === undefined) {
      proofTimerCallback = () => callback(...args);
      return proofTimerHandle;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.clearTimeout = (handle) => {
    if (handle !== proofTimerHandle) {
      originalClearTimeout(handle);
    }
  };

  try {
    const request = launcher.launch({ processName: 'game.exe' });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(null, injectorSuccessFor(4242, 'game.exe'), '');
    await request;
    assert.equal(launcher.state, 'attaching');
    assert.equal(typeof proofTimerCallback, 'function');

    proofTimerCallback();
    assert.equal(launcher.state, 'attaching');
    assert.equal(launcher.acceptTargetConnection(4242), false);
    await assert.rejects(
      launcher.launch({ processName: 'game.exe' }),
      /awaiting target connection/,
    );
    await assert.rejects(
      launcher.attach(createSessionHarness().session, {
        processName: 'game.exe',
      }),
      /awaiting target connection/,
    );
  } finally {
    launcher.dispose();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    execution.restore();
  }
});

test('launch rejects a false-positive injector return and keeps its evidence', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const originalError = console.error;
  console.error = () => undefined;
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));

  try {
    const request = launcher.launch({ processName: 'game.exe' });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      null,
      'injector returned without proof\n',
      'warning\n',
    );
    await assert.rejects(request, /did not contain.*Succeeded/);

    const runDirectory = launcher.runDirectory;
    assert.ok(runDirectory);
    assert.equal(
      readFileSync(path.join(runDirectory, 'inject.stdout.log'), 'utf8'),
      'injector returned without proof\n',
    );
    assert.equal(
      readFileSync(path.join(runDirectory, 'inject.stderr.log'), 'utf8'),
      'warning\n',
    );
    assert.equal(launcher.state, 'blocked');
    await assert.rejects(
      launcher.launch({ processName: 'game.exe' }),
      /outcome is indeterminate/,
    );
    await assert.rejects(
      launcher.attach(createSessionHarness().session, {
        processName: 'game.exe',
      }),
      /outcome is indeterminate/,
    );
  } finally {
    launcher.dispose();
    console.error = originalError;
    execution.restore();
  }
});

test('success marker with a missing PID blocks retries', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const originalError = console.error;
  console.error = () => undefined;
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));

  try {
    const request = launcher.launch({ processName: 'game.exe' });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(null, 'Injecting ReShade ... Succeeded!\n', '');
    await assert.rejects(request, /valid matched process PID/);
    assert.equal(launcher.state, 'blocked');
    await assert.rejects(
      launcher.launch({ processName: 'game.exe' }),
      /outcome is indeterminate/,
    );
  } finally {
    launcher.dispose();
    console.error = originalError;
    execution.restore();
  }
});

test('ambiguous injector callback and expected-PID mismatch block retries', async (t) => {
  await t.test('success marker accompanied by callback error', async () => {
    const fixture = createRuntime();
    const execution = stubExecFile();
    const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const request = launcher.launch({ processName: 'game.exe' });
      await waitFor(() => execution.calls.length === 1);
      const callbackError = Object.assign(new Error('late callback failure'), {
        code: 'ETIMEDOUT',
      });
      execution.calls[0].callback(
        callbackError,
        injectorSuccessFor(9001, 'game.exe'),
        '',
      );
      await assert.rejects(request, /late callback failure/);
      assert.equal(launcher.state, 'blocked');
      await assert.rejects(
        launcher.launch({ processName: 'game.exe' }),
        /outcome is indeterminate/,
      );
    } finally {
      launcher.dispose();
      console.error = originalError;
      execution.restore();
    }
  });

  await t.test('successful injector selected an unexpected PID', async () => {
    const fixture = createRuntime();
    const execution = stubExecFile();
    const launcher = new ReShadeOverlayLauncher(
      createConfig(fixture, { expectedTargetPid: 9001 }),
    );
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const request = launcher.launch({ processName: 'game.exe' });
      await waitFor(() => execution.calls.length === 1);
      execution.calls[0].callback(
        null,
        injectorSuccessFor(9002, 'game.exe'),
        '',
      );
      await assert.rejects(request, /selected pid=9002; expected pid=9001/);
      assert.equal(launcher.state, 'blocked');
      await assert.rejects(
        launcher.attach(createSessionHarness().session, {
          processName: 'game.exe',
        }),
        /outcome is indeterminate/,
      );
    } finally {
      launcher.dispose();
      console.error = originalError;
      execution.restore();
    }
  });
});

test('session loss after successful injection proof blocks retries', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  const markers = [];
  console.log = (message) => markers.push(String(message));

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(null, injectorSuccessFor(9101, 'game.exe'), '');
    await waitFor(() =>
      markers.includes(
        `${RESHADE_CLIENT_INJECTOR_RETURNED_MARKER} target="game.exe"`,
      ),
    );
    sessionHarness.close();
    await assert.rejects(attachment, /session closed before.*target connected/);
    assert.equal(launcher.state, 'blocked');
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
    await assert.rejects(
      launcher.attach(createSessionHarness().session, {
        processName: 'game.exe',
      }),
      /outcome is indeterminate/,
    );
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('connection-proof timeout after successful injection blocks retries', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const proofTimers = [];
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 120_000) {
      const handle = { callback: () => callback(...args) };
      proofTimers.push(handle);
      return handle;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.clearTimeout = (handle) => {
    if (!proofTimers.includes(handle)) {
      originalClearTimeout(handle);
    }
  };

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(null, injectorSuccessFor(9201, 'game.exe'), '');
    await waitFor(() => proofTimers.length === 2);
    proofTimers[0].callback();

    await assert.rejects(attachment, /did not connect within/);
    assert.equal(launcher.state, 'blocked');
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
    await assert.rejects(
      launcher.launch({ processName: 'game.exe' }),
      /outcome is indeterminate/,
    );
  } finally {
    launcher.dispose();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    execution.restore();
  }
});

test('attach requires matching path and PID, rejects live duplicates, and cleans up on disconnect', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const readiness = deferred();
  const sessionHarness = createSessionHarness(readiness.promise);
  const launcher = new ReShadeOverlayLauncher(
    createConfig(fixture, { expectedTargetPid: 4242 }),
  );
  const originalLog = console.log;
  const markers = [];
  console.log = (message) => markers.push(String(message));

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'Gun Frog.exe',
    });
    const sharedAttachment = launcher.attach(sessionHarness.session, {
      processName: 'Gun Frog.exe',
    });
    assert.equal(sharedAttachment, attachment);
    await flushMicrotasks();
    assert.equal(execution.calls.length, 0);

    readiness.resolve();
    await waitFor(() => execution.calls.length === 1);
    assert.equal(sessionHarness.nativeHandlerCount, 1);
    assert.equal(sessionHarness.closeHandlerCount, 1);

    execution.calls[0].callback(null, injectorSuccess, '');
    sessionHarness.emitNative('game.process', {
      pid: 4242,
      path: 'C:\\games\\Other Game.exe',
    });
    sessionHarness.emitNative('game.process', {
      pid: 7,
      path: 'C:\\games\\Gun Frog.exe',
    });
    await flushMicrotasks();
    assert.equal((await settleWithin(attachment, 20)).status, 'timeout');
    sessionHarness.emitNative('game.process', {
      pid: 4242,
      path: 'C:\\games\\GUN FROG.EXE',
    });

    const [firstResult, secondResult] = await Promise.all([
      attachment,
      sharedAttachment,
    ]);
    assert.deepEqual(firstResult, secondResult);
    assert.equal(firstResult.pid, 4242);
    assert.equal(firstResult.targetLabel, 'process:Gun Frog.exe');
    assert.ok(existsSync(firstResult.runDirectory));
    assert.ok(
      markers.includes(`${RESHADE_CLIENT_TARGET_CONNECTED_MARKER} pid=4242`),
    );
    assert.equal(launcher.state, 'connected');
    assert.equal(sessionHarness.nativeHandlerCount, 1);
    assert.equal(sessionHarness.closeHandlerCount, 1);

    sessionHarness.emitNative('game.process.transport-lost', {
      pid: 4242,
      path: 'C:\\games\\GUN FROG.EXE',
    });
    assert.equal(launcher.state, 'connected');
    sessionHarness.emitNative('game.process', {
      pid: 4242,
      path: 'D:\\reconnected\\renamed-image.bin',
    });
    assert.equal(launcher.state, 'connected');

    await assert.rejects(
      launcher.attach(sessionHarness.session, {
        processName: 'Gun Frog.exe',
      }),
      /already connected/,
    );
    await assert.rejects(
      launcher.attach(sessionHarness.session, { processName: 'game.exe' }),
      /different ReShade target is already connected/,
    );

    sessionHarness.emitNative('game.process.disconnected', {
      pid: 7,
      path: 'C:\\games\\GUN FROG.EXE',
    });
    assert.equal(launcher.state, 'connected');
    sessionHarness.emitNative('game.process.disconnected', {
      pid: 4242,
      path: 'C:\\games\\GUN FROG.EXE',
    });
    assert.equal(launcher.state, 'idle');
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
    assert.ok(
      markers.includes(`${RESHADE_CLIENT_TARGET_DISCONNECTED_MARKER} pid=4242`),
    );
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('attach correlates exact-PID candidates, identity, reauthentication, and terminal exit', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    const target = { processName: 'game.exe', pid: 7301 };
    const attachment = launcher.attach(sessionHarness.session, target);
    assert.equal(launcher.attach(sessionHarness.session, target), attachment);
    await assert.rejects(
      launcher.attach(sessionHarness.session, {
        processName: 'game.exe',
        pid: 7302,
      }),
      /different ReShade attachment is already active/,
    );
    await waitFor(() => execution.calls.length === 1);
    assert.deepEqual(execution.calls[0].arguments, [
      'game.exe',
      '--pid',
      '7301',
    ]);

    sessionHarness.emitNative('game.process', {
      pid: 7302,
      path: 'C:\\games\\game.exe',
    });
    execution.calls[0].callback(null, injectorSuccessFor(7301, 'game.exe'), '');
    assert.equal((await settleWithin(attachment, 20)).status, 'timeout');

    sessionHarness.emitNative('game.process', {
      pid: 7301,
      path: 'C:\\games\\GAME.EXE',
    });
    const result = await attachment;
    assert.equal(result.pid, 7301);
    assert.equal(result.injectorTargetPid, 7301);
    assert.equal(result.targetLabel, 'process:game.exe:pid:7301');
    assert.equal(launcher.state, 'connected');

    sessionHarness.emitNative('game.process.transport-lost', {
      pid: 7301,
      path: 'C:\\games\\game.exe',
    });
    assert.equal(launcher.state, 'connected');
    sessionHarness.emitNative('game.process', {
      pid: 7301,
      path: 'D:\\reauthenticated\\renamed-image.bin',
    });
    assert.equal(launcher.state, 'connected');

    sessionHarness.emitNative('game.process.disconnected', {
      pid: 7302,
      path: 'C:\\games\\game.exe',
    });
    assert.equal(launcher.state, 'connected');
    sessionHarness.emitNative('game.process.disconnected', {
      pid: 7301,
      path: 'unrelated-path-after-exact-pid-proof',
    });
    assert.equal(launcher.state, 'idle');
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('exact-PID terminal exit before injector proof is a definite-safe retry boundary', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    const target = { processName: 'game.exe', pid: 7401 };
    const attachment = launcher.attach(sessionHarness.session, target);
    await waitFor(() => execution.calls.length === 1);
    sessionHarness.emitNative('game.process.disconnected', {
      pid: 7402,
      path: 'C:\\games\\game.exe',
    });
    assert.equal((await settleWithin(attachment, 20)).status, 'timeout');

    sessionHarness.emitNative('game.process.disconnected', {
      pid: 7401,
      path: 'C:\\games\\game.exe',
    });
    const outcomeBeforeInjectorReturn = await settleWithin(attachment, 20);
    assert.equal(
      outcomeBeforeInjectorReturn.status,
      'timeout',
      'the attachment must await the in-flight injector before exposing retry safety',
    );
    execution.calls[0].callback(
      Object.assign(new Error('injector target exited'), { code: 1 }),
      'ReShade injection not started.\n',
      '',
    );
    await assert.rejects(attachment, /pid=7401 disconnected/);
    assert.equal(launcher.state, 'idle');

    const retry = launcher.attach(sessionHarness.session, target);
    await waitFor(() => execution.calls.length === 2);
    execution.calls[1].callback(null, injectorSuccessFor(7401, 'game.exe'), '');
    sessionHarness.emitNative('game.process', {
      pid: 7401,
      path: 'C:\\games\\game.exe',
    });
    assert.equal((await retry).pid, 7401);
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('one launcher attaches twice with injector-pinned PIDs and distinct staged runs', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    const firstAttachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await waitFor(() => execution.calls.length === 1);
    sessionHarness.emitNative('game.process', {
      pid: 5100,
      path: 'C:\\games\\game.exe',
    });
    execution.calls[0].callback(null, injectorSuccessFor(5101, 'game.exe'), '');
    await flushMicrotasks();
    assert.equal(
      (await settleWithin(firstAttachment, 20)).status,
      'timeout',
      'a stale same-name connection must not satisfy the injector PID pin',
    );
    sessionHarness.emitNative('game.process', {
      pid: 5101,
      path: 'C:\\games\\game.exe',
    });
    const firstResult = await firstAttachment;
    assert.equal(firstResult.pid, 5101);
    assert.equal(firstResult.injectorTargetPid, 5101);
    assert.equal(launcher.state, 'connected');

    sessionHarness.emitNative('game.process.disconnected', {
      pid: 5101,
      path: 'C:\\games\\game.exe',
    });
    assert.equal(launcher.state, 'idle');

    const secondAttachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await waitFor(() => execution.calls.length === 2);
    execution.calls[1].callback(null, injectorSuccessFor(6101, 'game.exe'), '');
    sessionHarness.emitNative('game.process', {
      pid: 6101,
      path: 'D:\\other\\GAME.EXE',
    });
    const secondResult = await secondAttachment;
    assert.equal(secondResult.pid, 6101);
    assert.equal(secondResult.injectorTargetPid, 6101);
    assert.notEqual(secondResult.runDirectory, firstResult.runDirectory);
    assert.notEqual(
      execution.calls[1].options.cwd,
      execution.calls[0].options.cwd,
    );

    sessionHarness.emitNative('game.process.disconnected', {
      pid: 6101,
      path: 'D:\\other\\GAME.EXE',
    });
    assert.equal(launcher.state, 'idle');
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('a candidate disconnect before injector PID proof rejects once pinned and permits retry', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    const disconnectedAttachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await waitFor(() => execution.calls.length === 1);
    sessionHarness.emitNative('game.process', {
      pid: 8101,
      path: 'C:\\games\\game.exe',
    });
    sessionHarness.emitNative('game.process.transport-lost', {
      pid: 8101,
      path: 'C:\\games\\game.exe',
    });
    sessionHarness.emitNative('game.process.disconnected', {
      pid: 8101,
      path: 'C:\\games\\game.exe',
    });
    assert.equal(
      (await settleWithin(disconnectedAttachment, 20)).status,
      'timeout',
      'an unpinned same-name process could still be unrelated',
    );

    execution.calls[0].callback(null, injectorSuccessFor(8101, 'game.exe'), '');
    const disconnectedOutcome = await settleWithin(disconnectedAttachment, 250);
    assert.equal(disconnectedOutcome.status, 'rejected');
    assert.match(
      disconnectedOutcome.error.message,
      /pid=8101 disconnected before attachment completed/,
    );
    assert.equal(launcher.state, 'idle');
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);

    const retry = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await waitFor(() => execution.calls.length === 2);
    execution.calls[1].callback(null, injectorSuccessFor(8102, 'game.exe'), '');
    sessionHarness.emitNative('game.process', {
      pid: 8102,
      path: 'C:\\games\\game.exe',
    });
    assert.equal((await retry).pid, 8102);

    sessionHarness.emitNative('game.process.disconnected', {
      pid: 8102,
      path: 'C:\\games\\game.exe',
    });
    assert.equal(launcher.state, 'idle');
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('candidate transport loss before PID proof requires same-PID reauthentication', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await waitFor(() => execution.calls.length === 1);
    sessionHarness.emitNative('game.process', {
      pid: 8201,
      path: 'C:\\games\\game.exe',
    });
    sessionHarness.emitNative('game.process.transport-lost', {
      pid: 8201,
      path: 'C:\\games\\game.exe',
    });
    execution.calls[0].callback(null, injectorSuccessFor(8201, 'game.exe'), '');
    assert.equal((await settleWithin(attachment, 20)).status, 'timeout');

    sessionHarness.emitNative('game.process', {
      pid: 8201,
      path: 'D:\\reauthenticated\\renamed-image.bin',
    });
    assert.equal((await attachment).pid, 8201);
    assert.equal(launcher.state, 'connected');

    sessionHarness.emitNative('game.process.disconnected', {
      pid: 8201,
      path: 'unrelated-path-after-pid-proof',
    });
    assert.equal(launcher.state, 'idle');
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('a failed attachment returns to idle and can be retried without leaked listeners', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile({ autoSpawn: false });
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => undefined;
  console.log = () => undefined;

  try {
    const failedAttachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await waitFor(() => execution.calls.length === 1);
    const spawnError = Object.assign(new Error('injector did not spawn'), {
      code: 'ENOENT',
    });
    execution.calls[0].callback(spawnError, '', 'failure\n');
    await assert.rejects(failedAttachment, /injector did not spawn/);
    assert.equal(launcher.state, 'idle');
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);

    const retriedAttachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await waitFor(() => execution.calls.length === 2);
    execution.calls[1].spawn();
    execution.calls[1].callback(null, injectorSuccessFor(7002, 'game.exe'), '');
    sessionHarness.emitNative('game.process', {
      pid: 7002,
      path: 'C:\\games\\game.exe',
    });
    const retriedResult = await retriedAttachment;
    assert.equal(retriedResult.pid, 7002);
    assert.notEqual(retriedResult.runDirectory, execution.calls[0].options.cwd);

    sessionHarness.emitNative('game.process.disconnected', {
      pid: 7002,
      path: 'C:\\games\\game.exe',
    });
    assert.equal(launcher.state, 'idle');
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
  } finally {
    launcher.dispose();
    console.error = originalError;
    console.log = originalLog;
    execution.restore();
  }
});

test('timeout, session close, and dispose cannot spawn after delayed staging', async () => {
  for (const scenario of ['timeout', 'session-close', 'dispose']) {
    const fixture = createRuntime();
    const execution = stubExecFile();
    const staging = delayRuntimeStaging(fixture.runsRootDirectory);
    const sessionHarness = createSessionHarness();
    const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const proofTimers = [];
    if (scenario === 'timeout') {
      global.setTimeout = (callback, delay, ...args) => {
        if (delay === 120_000) {
          const handle = { callback: () => callback(...args) };
          proofTimers.push(handle);
          return handle;
        }
        return originalSetTimeout(callback, delay, ...args);
      };
      global.clearTimeout = (handle) => {
        if (!proofTimers.includes(handle)) {
          originalClearTimeout(handle);
        }
      };
    }

    try {
      const attachment = launcher.attach(sessionHarness.session, {
        processName: 'game.exe',
      });
      await staging.entered;

      if (scenario === 'timeout') {
        assert.equal(proofTimers.length, 2);
        proofTimers[0].callback();
      } else if (scenario === 'session-close') {
        sessionHarness.close();
      } else {
        launcher.dispose();
      }

      const earlyOutcome = await settleWithin(attachment, 20);
      assert.equal(
        earlyOutcome.status,
        scenario === 'dispose' ? 'rejected' : 'timeout',
        `${scenario} must not expose a retryable result while staging is unresolved`,
      );
      assert.equal(execution.calls.length, 0);

      staging.release();
      await staging.finished;
      await flushMicrotasks();
      const outcome =
        scenario === 'dispose'
          ? earlyOutcome
          : await settleWithin(attachment, 500);
      assert.equal(outcome.status, 'rejected');
      assert.equal(execution.calls.length, 0);
      if (scenario === 'dispose') {
        assert.match(outcome.error.message, /disposed before attachment/);
        await assert.rejects(
          launcher.launch({ processName: 'game.exe' }),
          /launcher is disposed/,
        );
      } else {
        assert.equal(launcher.state, 'blocked');
        await assert.rejects(
          launcher.launch({ processName: 'game.exe' }),
          /outcome is indeterminate/,
        );
      }
    } finally {
      staging.release();
      staging.restore();
      launcher.dispose();
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      execution.restore();
    }
  }
});

test('disposing a pending attachment kills the injector and rejects promptly', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await waitFor(() => execution.calls.length === 1);
    const call = execution.calls[0];

    launcher.dispose();
    assert.equal(call.child.killed, true);
    const outcome = await settleWithin(attachment, 250);
    assert.equal(outcome.status, 'rejected');
    assert.match(
      outcome.error.message,
      /launcher was disposed before attachment completed/,
    );
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
    assert.equal(launcher.state, 'idle');

    call.callback(null, injectorSuccess, '');
    await waitFor(() => errors.length === 1);
  } finally {
    launcher.dispose();
    console.error = originalError;
    execution.restore();
  }
});

function createRuntime() {
  const root = mkdtempSync(path.join(tmpdir(), 'reshade-sdk-launch-'));
  temporaryDirectories.add(root);
  const runtimeDirectory = path.join(root, 'runtime');
  const runsRootDirectory = path.join(root, 'runs');
  mkdirSync(runtimeDirectory, { recursive: true });
  mkdirSync(runsRootDirectory, { recursive: true });
  for (const artifact of artifacts) {
    writeFileSync(path.join(runtimeDirectory, artifact), `fixture:${artifact}`);
  }
  return { root, runtimeDirectory, runsRootDirectory };
}

function createConfig(fixture, overrides = {}) {
  const config = parseReShadeLaunchConfig(
    [
      'electron.exe',
      '--reshade-overlay',
      `--reshade-runtime-dir=${fixture.runtimeDirectory}`,
    ],
    { runsRootDirectory: fixture.runsRootDirectory },
  );
  assert.ok(config);
  return Object.freeze({ ...config, ...overrides });
}

function stubExecFile({ autoSpawn = true } = {}) {
  const originalExecFile = childProcess.execFile;
  const calls = [];

  childProcess.execFile = (executable, args, options, callback) => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      killed: false,
      kill() {
        this.killed = true;
        return true;
      },
    });
    let spawned = false;
    const spawn = () => {
      if (!spawned && !child.killed) {
        spawned = true;
        child.emit('spawn');
      }
    };
    calls.push({
      executable,
      arguments: args,
      options,
      callback,
      child,
      spawn,
    });
    if (autoSpawn) {
      queueMicrotask(spawn);
    }
    return child;
  };

  return {
    calls,
    restore() {
      childProcess.execFile = originalExecFile;
    },
  };
}

function delayRuntimeStaging(runsRootDirectory) {
  const originalMkdir = fsPromises.mkdir;
  const originalCopyFile = fsPromises.copyFile;
  const entered = deferred();
  const release = deferred();
  const finished = deferred();
  let intercepted = false;
  let completedCopies = 0;
  fsPromises.mkdir = async (directoryPath, options) => {
    if (
      !intercepted &&
      path.resolve(directoryPath) === path.resolve(runsRootDirectory)
    ) {
      intercepted = true;
      entered.resolve();
      await release.promise;
    }
    return originalMkdir(directoryPath, options);
  };
  fsPromises.copyFile = async (sourcePath, destinationPath) => {
    const result = await originalCopyFile(sourcePath, destinationPath);
    if (
      path
        .resolve(destinationPath)
        .startsWith(`${path.resolve(runsRootDirectory)}${path.sep}`)
    ) {
      completedCopies += 1;
      if (completedCopies === artifacts.length) {
        finished.resolve();
      }
    }
    return result;
  };

  return {
    entered: entered.promise,
    finished: finished.promise,
    release: release.resolve,
    restore() {
      fsPromises.mkdir = originalMkdir;
      fsPromises.copyFile = originalCopyFile;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSessionHarness(ready = Promise.resolve()) {
  const nativeHandlers = new Set();
  const closeHandlers = new Set();
  let closed = false;

  return {
    session: {
      whenReady() {
        if (closed) {
          return Promise.reject(new Error('the overlay session is closed'));
        }
        return ready;
      },
      on(event, handler) {
        assert.equal(event, 'nativeEvent');
        nativeHandlers.add(handler);
        return () => nativeHandlers.delete(handler);
      },
      onClose(handler) {
        if (closed) {
          handler();
          return () => {};
        }
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
    },
    emitNative(event, payload) {
      for (const handler of Array.from(nativeHandlers)) {
        handler({ event, payload });
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const handler of Array.from(closeHandlers)) {
        handler();
      }
    },
    get nativeHandlerCount() {
      return nativeHandlers.size;
    },
    get closeHandlerCount() {
      return closeHandlers.size;
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for test condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve({ status: 'resolved', value });
      },
      (error) => {
        clearTimeout(timeout);
        resolve({ status: 'rejected', error });
      },
    );
  });
}
