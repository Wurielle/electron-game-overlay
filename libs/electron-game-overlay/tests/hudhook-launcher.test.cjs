const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HudhookOverlayLauncher,
  buildHudhookInvocation,
  defaultHudhookRuntimeDirectory,
  parseHudhookLaunchConfig,
} = require('../dist/lib/hudhook-launcher.js');

const temporaryDirectories = new Set();

test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

test('hudhook stays disabled without the explicit startup opt-in', () => {
  assert.equal(
    parseHudhookLaunchConfig(['electron.exe', '--hudhook-backend=d3d11'], {
      bundledRuntimeDirectory: path.join(tmpdir(), 'missing-hudhook-runtime'),
    }),
    null,
  );
});

test('the SDK default resolves its staged Windows x64 runtime', () => {
  const runtimeDirectory = defaultHudhookRuntimeDirectory();
  const config = parseHudhookLaunchConfig([
    'electron.exe',
    '--hudhook-overlay',
    '--hudhook-backend=d3d11',
  ]);

  assert.ok(path.isAbsolute(runtimeDirectory));
  assert.ok(config);
  assert.equal(config.runtimeDirectory, runtimeDirectory);
  assert.equal(
    path.basename(config.injectorPath),
    'hudhook_overlay_injector.exe',
  );
  assert.equal(
    path.basename(config.payloadPath),
    'hudhook_imgui_overlay_dx11.dll',
  );
});

for (const [backend, payloadName] of [
  ['d3d11', 'hudhook_imgui_overlay_dx11.dll'],
  ['d3d12', 'hudhook_imgui_overlay_dx12.dll'],
]) {
  test(`${backend} resolves the bundled payload and no-shell argv`, () => {
    const runtimeDirectory = createRuntime(payloadName);
    const processName = `${backend}_overlay_test_host.exe`;
    const config = parseHudhookLaunchConfig(
      [
        'electron.exe',
        '--hudhook-overlay',
        `--hudhook-backend=${backend}`,
        `--hudhook-auto-target-process=${processName}`,
        '--hudhook-expected-target-pid=4242',
      ],
      { bundledRuntimeDirectory: runtimeDirectory },
    );

    assert.ok(config);
    assert.equal(config.backend, backend);
    assert.equal(
      path.basename(config.injectorPath),
      'hudhook_overlay_injector.exe',
    );
    assert.equal(path.basename(config.payloadPath), payloadName);
    assert.equal(config.autoTargetProcess, processName);
    assert.equal(config.expectedTargetPid, 4242);

    assert.deepEqual(buildHudhookInvocation(config, { processName }), {
      executable: config.injectorPath,
      arguments: [
        '--process',
        processName,
        '--backend',
        backend,
        '--dll',
        config.payloadPath,
      ],
      targetLabel: `process:${processName}`,
    });
  });
}

test('an explicit runtime directory overrides the bundled location', () => {
  const runtimeDirectory = createRuntime('hudhook_imgui_overlay_dx11.dll');
  const config = parseHudhookLaunchConfig(
    [
      'electron.exe',
      '--hudhook-overlay',
      '--hudhook-backend=d3d11',
      `--hudhook-runtime-dir=${runtimeDirectory}`,
    ],
    {
      bundledRuntimeDirectory: path.join(
        runtimeDirectory,
        'missing-bundled-runtime',
      ),
    },
  );

  assert.ok(config);
  assert.equal(config.runtimeDirectory, runtimeDirectory);

  const missingOverride = path.join(runtimeDirectory, 'missing-override');
  assert.throws(
    () =>
      parseHudhookLaunchConfig(
        [
          'electron.exe',
          '--hudhook-overlay',
          '--hudhook-backend=d3d11',
          `--hudhook-runtime-dir=${missingOverride}`,
        ],
        { bundledRuntimeDirectory: runtimeDirectory },
      ),
    /runtime directory is unavailable/,
  );
});

test('bundled runtime failures identify the missing directory or artifact', () => {
  const missingRuntime = createRuntime('hudhook_imgui_overlay_dx11.dll');
  rmSync(missingRuntime, { force: true, recursive: true });
  const args = ['electron.exe', '--hudhook-overlay', '--hudhook-backend=d3d11'];
  assert.throws(
    () =>
      parseHudhookLaunchConfig(['electron.exe', '--hudhook-overlay'], {
        bundledRuntimeDirectory: missingRuntime,
      }),
    /hudhook-backend.*required/,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig(args, {
        bundledRuntimeDirectory: missingRuntime,
      }),
    /runtime directory is unavailable/,
  );

  const missingInjector = createRuntime(
    'hudhook_imgui_overlay_dx11.dll',
    false,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig(args, {
        bundledRuntimeDirectory: missingInjector,
      }),
    /hudhook injector is unavailable/,
  );

  const missingPayload = createRuntime('hudhook_imgui_overlay_dx12.dll');
  assert.throws(
    () =>
      parseHudhookLaunchConfig(args, {
        bundledRuntimeDirectory: missingPayload,
      }),
    /d3d11 hudhook payload is unavailable/,
  );
});

test('startup parsing rejects incomplete, duplicate, and unsafe options', () => {
  const runtimeDirectory = createRuntime('hudhook_imgui_overlay_dx11.dll');
  const valid = [
    'electron.exe',
    '--hudhook-overlay',
    '--hudhook-backend=d3d11',
    `--hudhook-runtime-dir=${runtimeDirectory}`,
    '--hudhook-auto-target-process=game.exe',
  ];

  assert.throws(
    () => parseHudhookLaunchConfig([...valid, '--hudhook-overlay']),
    /exactly once/,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig([
        ...valid.filter(
          (argument) => !argument.startsWith('--hudhook-auto-target-process='),
        ),
        '--hudhook-expected-target-pid=42',
      ]),
    /expected-target-pid.*requires.*auto-target-process/,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig(
        valid.map((argument) =>
          argument === '--hudhook-backend=d3d11'
            ? '--hudhook-backend=vulkan'
            : argument,
        ),
      ),
    /d3d11 or d3d12/,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig(
        valid.map((argument) =>
          argument === '--hudhook-auto-target-process=game.exe'
            ? '--hudhook-auto-target-process=..\\game.exe'
            : argument,
        ),
      ),
    /\.exe basename/,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig([...valid, '--hudhook-expected-target-pid=0']),
    /positive integer/,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig(
        valid.map((argument) =>
          argument.startsWith('--hudhook-runtime-dir=')
            ? '--hudhook-runtime-dir=relative'
            : argument,
        ),
      ),
    /runtime-dir.*absolute/,
  );
});

test('a window title remains one injector argument even with metacharacters', () => {
  const runtimeDirectory = createRuntime('hudhook_imgui_overlay_dx11.dll');
  const config = parseHudhookLaunchConfig([
    'electron.exe',
    '--hudhook-overlay',
    '--hudhook-backend=d3d11',
    `--hudhook-runtime-dir=${runtimeDirectory}`,
  ]);
  assert.ok(config);

  const title = 'Offline game & echo never-runs';
  const invocation = buildHudhookInvocation(config, { windowTitle: title });
  assert.deepEqual(invocation.arguments.slice(0, 2), ['--title', title]);
});

test('launcher uses no-shell execFile and correlates the expected target', async () => {
  const execution = stubExecFile();
  const config = createLaunchConfig({ expectedTargetPid: 4242 });
  const launcher = new HudhookOverlayLauncher(config);

  try {
    const request = launcher.launch({ processName: 'game.exe' });
    assert.equal(
      launcher.launch({ processName: 'game.exe' }),
      request,
      'the same active target should share its request',
    );
    await assert.rejects(
      launcher.launch({ windowTitle: 'Different game' }),
      /different hudhook injection request is already active/,
    );

    assert.equal(execution.calls.length, 1);
    const call = execution.calls[0];
    assert.equal(call.executable, config.injectorPath);
    assert.deepEqual(call.arguments, [
      '--process',
      'game.exe',
      '--backend',
      'd3d11',
      '--dll',
      config.payloadPath,
    ]);
    assert.equal(call.options.cwd, config.runtimeDirectory);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 10_000);
    assert.equal(call.options.maxBuffer, 64 * 1024);
    assert.equal(call.options.encoding, 'utf8');

    assert.equal(launcher.hasRequestedInjection, true);
    assert.equal(launcher.acceptTargetConnection(7), false);
    assert.equal(launcher.acceptTargetConnection(4242), true);
    assert.equal(launcher.acceptTargetConnection(4242), false);

    call.callback(null, '', '');
    await request;
    await assert.rejects(
      launcher.launch({ processName: 'game.exe' }),
      /automatic reinjection is disabled/,
    );
  } finally {
    launcher.dispose();
    execution.restore();
  }
});

test('disposing the launcher kills an active injector and closes correlation', async () => {
  const execution = stubExecFile();
  const launcher = new HudhookOverlayLauncher(createLaunchConfig());

  try {
    const request = launcher.launch({ windowTitle: 'Controlled game' });
    assert.equal(execution.calls.length, 1);
    const call = execution.calls[0];

    launcher.dispose();
    assert.equal(call.child.killed, true);
    assert.equal(launcher.acceptTargetConnection(17), false);
    await assert.rejects(
      launcher.launch({ windowTitle: 'Controlled game' }),
      /launcher is disposed/,
    );

    call.callback(null, '', '');
    await request;
  } finally {
    launcher.dispose();
    execution.restore();
  }
});

test('attach waits for session readiness and matching process proof', async () => {
  const execution = stubExecFile();
  const readiness = deferred();
  const sessionHarness = createSessionHarness(readiness.promise);
  const launcher = new HudhookOverlayLauncher(
    createLaunchConfig({ expectedTargetPid: 4242 }),
  );

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    const sharedAttachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    assert.equal(sharedAttachment, attachment);
    await assert.rejects(
      launcher.attach(sessionHarness.session, {
        windowTitle: 'Different game',
      }),
      /different hudhook attachment is already active/,
    );
    let settled = false;
    void attachment.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await flushMicrotasks();
    assert.equal(execution.calls.length, 0);

    readiness.resolve();
    await flushMicrotasks();
    assert.equal(execution.calls.length, 1);
    assert.equal(sessionHarness.nativeHandlerCount, 1);
    assert.equal(sessionHarness.closeHandlerCount, 1);

    execution.calls[0].callback(null, '', '');
    sessionHarness.emitNative('graphics.fps', { fps: 60 });
    sessionHarness.emitNative('game.process', { pid: 7 });
    await flushMicrotasks();
    assert.equal(settled, false);

    sessionHarness.emitNative('game.process', { pid: 4242 });
    const expectedResult = {
      backend: 'd3d11',
      pid: 4242,
      targetLabel: 'process:game.exe',
    };
    const [firstResult, secondResult] = await Promise.all([
      attachment,
      sharedAttachment,
    ]);
    assert.deepEqual(firstResult, expectedResult);
    assert.deepEqual(secondResult, expectedResult);
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
  } finally {
    launcher.dispose();
    execution.restore();
  }
});

test('attach rejects promptly when the session closes before connection', async () => {
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new HudhookOverlayLauncher(createLaunchConfig());

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      windowTitle: 'Controlled game',
    });
    await flushMicrotasks();
    assert.equal(execution.calls.length, 1);
    execution.calls[0].callback(null, '', '');

    sessionHarness.close();
    const outcome = await settleWithin(attachment, 250);
    if (outcome.status === 'timeout') {
      sessionHarness.emitNative('game.process', { pid: 17 });
      await attachment;
    }

    assert.equal(outcome.status, 'rejected');
    assert.match(
      outcome.error.message,
      /session closed before the hudhook target connected/,
    );
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
  } finally {
    launcher.dispose();
    execution.restore();
  }
});

test('disposing after injector return promptly rejects an active attachment', async () => {
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new HudhookOverlayLauncher(createLaunchConfig());

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
    });
    await flushMicrotasks();
    assert.equal(execution.calls.length, 1);
    execution.calls[0].callback(null, '', '');
    await flushMicrotasks();

    launcher.dispose();
    const outcome = await settleWithin(attachment, 250);
    if (outcome.status === 'timeout') {
      sessionHarness.emitNative('game.process', { pid: 17 });
      await attachment;
    }

    assert.equal(outcome.status, 'rejected');
    assert.match(
      outcome.error.message,
      /launcher was disposed before attachment completed/,
    );
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
  } finally {
    launcher.dispose();
    execution.restore();
  }
});

test('an already-closed session prevents injector execution', async () => {
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new HudhookOverlayLauncher(createLaunchConfig());

  try {
    sessionHarness.close();
    await assert.rejects(
      launcher.attach(sessionHarness.session, { processName: 'game.exe' }),
      /overlay session is closed/,
    );
    assert.equal(execution.calls.length, 0);
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
  } finally {
    launcher.dispose();
    execution.restore();
  }
});

function createRuntime(payloadName, includeInjector = true) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hudhook-sdk-launch-'));
  temporaryDirectories.add(directory);
  if (includeInjector) {
    writeFileSync(path.join(directory, 'hudhook_overlay_injector.exe'), 'test');
  }
  writeFileSync(path.join(directory, payloadName), 'test');
  return directory;
}

function createLaunchConfig(overrides = {}) {
  const runtimeDirectory = 'C:\\hudhook-runtime';
  return Object.freeze({
    backend: 'd3d11',
    runtimeDirectory,
    injectorPath: path.join(runtimeDirectory, 'hudhook_overlay_injector.exe'),
    payloadPath: path.join(runtimeDirectory, 'hudhook_imgui_overlay_dx11.dll'),
    ...overrides,
  });
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
