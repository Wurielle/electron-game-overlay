const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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
const injectorSuccess =
  "Waiting for a 'Gun Frog.exe' process to spawn ...\n" +
  'Found a matching process with PID 4242! Injecting ReShade ... Succeeded!\n';
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

  unlinkSync(path.join(fixture.runtimeDirectory, 'ReShade.ini'));
  assert.throws(
    () =>
      parseReShadeLaunchConfig(valid, {
        runsRootDirectory: fixture.runsRootDirectory,
      }),
    /ReShade configuration is unavailable/,
  );
});

test('launch copies the exact runtime, uses one process argument, and preserves logs', async () => {
  const fixture = createRuntime();
  const config = createConfig(fixture);
  const execution = stubExecFile();
  const originalLog = console.log;
  const markers = [];
  console.log = (message) => markers.push(String(message));
  const launcher = new ReShadeOverlayLauncher(config);

  try {
    const request = launcher.launch({ processName: 'Gun Frog.exe' });
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
        `${RESHADE_CLIENT_INJECTOR_STARTED_MARKER} target="Gun Frog.exe"`,
      ),
    );
    assert.ok(
      markers.includes(
        `${RESHADE_CLIENT_INJECTOR_RETURNED_MARKER} target="Gun Frog.exe"`,
      ),
    );
    await assert.rejects(
      launcher.launch({ processName: 'Gun Frog.exe' }),
      /automatic reinjection is disabled/,
    );
  } finally {
    launcher.dispose();
    console.log = originalLog;
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
  } finally {
    launcher.dispose();
    console.error = originalError;
    execution.restore();
  }
});

test('attach waits for readiness, injector proof, and matching authenticated PID', async () => {
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
    sessionHarness.emitNative('game.process', { pid: 7 });
    await flushMicrotasks();
    sessionHarness.emitNative('game.process', { pid: 4242 });

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
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('disposing a pending attachment kills the injector and rejects promptly', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));

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

    call.callback(null, injectorSuccess, '');
    await flushMicrotasks();
  } finally {
    launcher.dispose();
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

function stubExecFile() {
  const originalExecFile = childProcess.execFile;
  const calls = [];

  childProcess.execFile = (executable, args, options, callback) => {
    const child = {
      exitCode: null,
      signalCode: null,
      killed: false,
      kill() {
        this.killed = true;
        return true;
      },
    };
    calls.push({ executable, arguments: args, options, callback, child });
    return child;
  };

  return {
    calls,
    restore() {
      childProcess.execFile = originalExecFile;
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
