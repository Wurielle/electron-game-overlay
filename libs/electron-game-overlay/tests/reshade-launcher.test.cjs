const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const fsPromises = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  acceptReShadeTargetConnection,
  ReShadeOperationError,
  ReShadeOverlayLauncher,
  buildReShadeInvocation,
  launchReShadeOverlay,
  defaultReShadeRunsRootDirectory,
  defaultReShadeRuntimeDirectory,
  isReShadeOperationError,
  parseReShadeLaunchConfig,
} = require('../dist/lib/reshade-launcher.js');
const existingReShadeInstallation = require('../dist/lib/existing-reshade-installation.js');

const artifacts = [
  'inject.exe',
  'inject32.exe',
  'electron_game_overlay_reshade_manager.exe',
  'electron_game_overlay_reshade_manager32.exe',
  'ReShade64.dll',
  'ReShade32.dll',
  'ReShade64.build.json',
  'ReShade32.build.json',
  'electron_game_overlay_runtime.build.json',
  'electron_game_overlay_runtime32.build.json',
  'electron_game_overlay.addon64',
  'electron_game_overlay.addon32',
  'ReShade.ini',
];
const runOwnershipMarkerFileName = '.electron-game-overlay-run.json';
const runReclaimableMarkerFileName =
  '.electron-game-overlay-run-reclaimable.json';
const runtimeStartupFileName = '.electron-game-overlay-runtime-startup.json';
const runtimeStartupRecordCodes = [
  'bridge-thread-create-failed',
  'bridge-thread-started',
  'bridge-window-create-failed',
  'bridge-window-ready',
  'discovery-not-ready',
  'discovery-document-invalid',
  'discovery-version-mismatch',
  'discovery-target-mismatch',
  'loopback-connect-failed',
  'loopback-configuration-failed',
  'process-hello-build-failed',
  'network-worker-start-failed',
  'network-worker-started',
  'network-connection-lost',
  'bridge-message-pump-failed',
];
const runRetentionMaxAgeMs = 7 * 24 * 60 * 60 * 1_000;
let retainedRunSequence = 0;
const injectorResult = (result) =>
  `ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ${JSON.stringify({
    schemaVersion: 1,
    targetExecutablePath: 'C:\\games\\game.exe',
    ...result,
  })}\n`;
const injectorSuccessFor = (pid, processName = 'Gun Frog.exe') =>
  `Waiting for a '${processName}' process to spawn ...\n` +
  `Found a matching process with PID ${pid}! Injecting ReShade ... Succeeded!\n` +
  injectorResult({
    pid,
    targetExecutablePath: path.win32.join('C:\\games', processName),
    runtimeMode: 'injected-runtime',
  });
const injectorSuccessAt = (pid, targetExecutablePath) =>
  `Found a matching process with PID ${pid}! Injecting ReShade ... Succeeded!\n` +
  injectorResult({
    pid,
    targetExecutablePath,
    runtimeMode: 'injected-runtime',
  });
const existingRuntimeSuccessFor = (
  pid,
  runtimeModulePath,
  processName = 'Gun Frog.exe',
) =>
  `Waiting for a '${processName}' process to spawn ...\n` +
  `Found a matching process with PID ${pid}! Reusing ReShade ... Succeeded!\n` +
  injectorResult({
    pid,
    targetExecutablePath: path.win32.join(
      path.win32.dirname(runtimeModulePath),
      processName,
    ),
    runtimeMode: 'existing-runtime',
    runtimeModulePath,
    hostAbi: 1,
  });
const officialAddonSuccessFor = (
  pid,
  runtimeModulePath,
  addonModulePath,
  processName = 'Gun Frog.exe',
  effectiveOverrides = {},
) =>
  `Waiting for a '${processName}' process to spawn ...\n` +
  `Found a matching process with PID ${pid}! Using official ReShade add-on ... Succeeded!\n` +
  injectorResult({
    pid,
    targetExecutablePath: path.win32.join(
      path.win32.dirname(runtimeModulePath),
      processName,
    ),
    runtimeMode: 'official-addon',
    runtimeModulePath,
    addonModulePath,
    addonAbi: 1,
    addonBuildId: 'F2A88AD705204DBB8E18D86E7147A13C',
    reshadeBasePath: path.win32.dirname(runtimeModulePath),
    addonDirectoryPath: path.win32.dirname(addonModulePath),
    electronGameOverlayAddonDisabled: false,
    ...effectiveOverrides,
  });
const injectorSuccess = injectorSuccessFor(4242);
const pathInjectorSuccessFor = (pid, executablePath) =>
  'ReShade path watcher armed.\n' +
  `Matched executable path: ${executablePath}\n` +
  `Found a matching process with PID ${pid}! Injecting ReShade ... Succeeded!\n` +
  injectorResult({
    pid,
    targetExecutablePath: executablePath,
    runtimeMode: 'injected-runtime',
  });
const injectorDiagnostic = (diagnostic) =>
  `ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ${JSON.stringify({
    schemaVersion: 1,
    targetExecutablePath: 'C:\\game\\game.exe',
    ...diagnostic,
  })}\n`;
const injectorPreflightDiagnostic = (diagnostic) => {
  const hasEffectiveSettings = [
    'target-existing-reshade-installation',
    'target-existing-reshade-global-layer',
    'target-runtime-incompatible',
  ].includes(diagnostic.code);
  return injectorDiagnostic({
    stage: 'target-preflight',
    injectionStarted: false,
    targetExecutablePath: 'C:\\game\\game.exe',
    ...(hasEffectiveSettings
      ? {
          reshadeBasePath: path.win32.dirname(
            diagnostic.modulePath ?? 'C:\\game\\dxgi.dll',
          ),
          addonDirectoryPath: path.win32.dirname(
            diagnostic.modulePath ?? 'C:\\game\\dxgi.dll',
          ),
          electronGameOverlayAddonDisabled: false,
        }
      : {}),
    ...diagnostic,
  });
};
const architectureMismatchFor = (
  pid,
  targetExecutablePath = 'C:\\game\\game.exe',
  overrides = {},
  includeNotStartedMarker = true,
) =>
  `Found a matching process with PID ${pid}! Injecting ReShade ... \n` +
  injectorPreflightDiagnostic({
    code: 'target-architecture-mismatch',
    pid,
    targetExecutablePath,
    windowsErrorCode: 706,
    ...overrides,
  }) +
  (includeNotStartedMarker ? 'ReShade injection not started.\n' : '');
const runtimeStartupRecord = (pid, code, additionalFields = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    source: 'electron-game-overlay-runtime',
    pid,
    code,
    ...additionalFields,
  });
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
      config.x86InjectorPath,
      config.addonManagerPath,
      config.x86AddonManagerPath,
      config.runtimePath,
      config.x86RuntimePath,
      config.buildStampPath,
      config.x86BuildStampPath,
      config.packageBuildStampPath,
      config.x86PackageBuildStampPath,
      config.addonPath,
      config.x86AddonPath,
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
  assert.deepEqual(
    buildReShadeInvocation(
      {
        processName: 'Gun Frog.exe',
        pid: 4242,
        executablePath:
          'D:\\SteamLibrary\\steamapps\\common\\Gun Frog\\Gun Frog.exe',
      },
      runDirectory,
    ),
    {
      executable: path.join(runDirectory, 'inject.exe'),
      arguments: [
        'D:\\SteamLibrary\\steamapps\\common\\Gun Frog\\Gun Frog.exe',
        '--pid',
        '4242',
      ],
      targetLabel:
        'process:Gun Frog.exe:pid:4242:path:d:\\steamlibrary\\steamapps\\common\\gun frog\\gun frog.exe',
      workingDirectory: runDirectory,
    },
  );
  assert.deepEqual(
    buildReShadeInvocation({ pathContains: '\\steamapps\\' }, runDirectory),
    {
      executable: path.join(runDirectory, 'inject.exe'),
      arguments: ['--path-contains', '\\steamapps\\'],
      targetLabel: 'path-contains:\\steamapps\\',
      workingDirectory: runDirectory,
    },
  );
  assert.deepEqual(
    buildReShadeInvocation(
      {
        pathContains: '\\steamapps\\',
        excludedProcessNames: [
          'UnityCrashHandler64.exe',
          'UnityCrashHandler.exe',
        ],
      },
      runDirectory,
    ),
    {
      executable: path.join(runDirectory, 'inject.exe'),
      arguments: [
        '--path-contains',
        '\\steamapps\\',
        '--exclude-name',
        'UnityCrashHandler64.exe',
        '--exclude-name',
        'UnityCrashHandler.exe',
      ],
      targetLabel:
        'path-contains:\\steamapps\\:exclude:unitycrashhandler.exe,unitycrashhandler64.exe',
      workingDirectory: runDirectory,
    },
  );
});

test('exact-PID invocations normalize native image paths while preserving case', () => {
  const runDirectory = path.join(tmpdir(), 'reshade-exact-path-run');
  const cases = [
    {
      input:
        'D:/SteamLibrary/STEAMAPPS/common/Example/../Gun Frog/./Gun Frog.exe',
      expected: 'D:\\SteamLibrary\\STEAMAPPS\\common\\Gun Frog\\Gun Frog.exe',
    },
    {
      input:
        '\\\\?\\D:\\SteamLibrary\\STEAMAPPS\\common\\Gun Frog\\.\\Gun Frog.exe',
      expected: 'D:\\SteamLibrary\\STEAMAPPS\\common\\Gun Frog\\Gun Frog.exe',
    },
    {
      input:
        '\\\\?\\UNC\\GameServer\\OverlayShare\\Games\\..\\Gun Frog\\Gun Frog.exe',
      expected: '\\\\GameServer\\OverlayShare\\Gun Frog\\Gun Frog.exe',
    },
  ];

  for (const { input, expected } of cases) {
    const invocation = buildReShadeInvocation(
      {
        processName: 'Gun Frog.exe',
        pid: 4242,
        executablePath: input,
      },
      runDirectory,
    );
    assert.deepEqual(invocation.arguments, [expected, '--pid', '4242']);
    assert.ok(
      invocation.targetLabel.endsWith(`:path:${expected.toLowerCase()}`),
    );
  }
});

test('startup parsing validates both architecture package manifests and payload hashes', async (t) => {
  await t.test('rejects a corrupted x86 add-on', () => {
    const fixture = createRuntime();
    writeFileSync(
      path.join(fixture.runtimeDirectory, 'electron_game_overlay.addon32'),
      'corrupted x86 add-on',
    );

    assert.throws(
      () => createConfig(fixture),
      /x86 Electron Game Overlay runtime package build stamp addonSha256 does not match electron_game_overlay\.addon32/,
    );
  });

  await t.test('rejects a corrupted x64 manager', () => {
    const fixture = createRuntime();
    writeFileSync(
      path.join(
        fixture.runtimeDirectory,
        'electron_game_overlay_reshade_manager.exe',
      ),
      'corrupted x64 manager',
    );

    assert.throws(
      () => createConfig(fixture),
      /x64 Electron Game Overlay runtime package build stamp managerSha256 does not match electron_game_overlay_reshade_manager\.exe/,
    );
  });

  await t.test('rejects an unknown schema property', () => {
    const fixture = createRuntime();
    rewriteRuntimePackageBuildStamp(
      fixture.runtimeDirectory,
      'electron_game_overlay_runtime32.build.json',
      (manifest) => {
        manifest.unexpected = true;
      },
    );

    assert.throws(
      () => createConfig(fixture),
      /x86 Electron Game Overlay runtime package build stamp does not match schema version 2/,
    );
  });

  await t.test('rejects a repeated literal x64 schema key', () => {
    const fixture = createRuntime();
    prependDuplicateRuntimePackageBuildStampKey(
      fixture.runtimeDirectory,
      'electron_game_overlay_runtime.build.json',
      'managerSha256',
    );

    assert.throws(
      () => createConfig(fixture),
      /x64 Electron Game Overlay runtime package build stamp does not match schema version 2/,
    );
  });

  await t.test('rejects an escaped x86 schema-key alias', () => {
    const fixture = createRuntime();
    prependDuplicateRuntimePackageBuildStampKey(
      fixture.runtimeDirectory,
      'electron_game_overlay_runtime32.build.json',
      'addonSha256',
      '\\u0061ddonSha256',
    );

    assert.throws(
      () => createConfig(fixture),
      /x86 Electron Game Overlay runtime package build stamp does not match schema version 2/,
    );
  });

  await t.test('rejects a schema-version mismatch', () => {
    const fixture = createRuntime();
    rewriteRuntimePackageBuildStamp(
      fixture.runtimeDirectory,
      'electron_game_overlay_runtime.build.json',
      (manifest) => {
        manifest.schemaVersion = 3;
      },
    );

    assert.throws(
      () => createConfig(fixture),
      /x64 Electron Game Overlay runtime package build stamp does not match schema version 2/,
    );
  });

  await t.test('rejects a manifest staged under the wrong architecture', () => {
    const fixture = createRuntime();
    rewriteRuntimePackageBuildStamp(
      fixture.runtimeDirectory,
      'electron_game_overlay_runtime32.build.json',
      (manifest) => {
        manifest.platform = 'win32-x64';
      },
    );

    assert.throws(
      () => createConfig(fixture),
      /x86 Electron Game Overlay runtime package build stamp declares platform "win32-x64"; expected win32-ia32/,
    );
  });
});

test('staged payloads are revalidated before injector execution', async () => {
  const fixture = createRuntime();
  const config = createConfig(fixture);
  writeFileSync(
    path.join(fixture.runtimeDirectory, 'electron_game_overlay.addon32'),
    'corrupted after configuration',
  );
  const launcher = new ReShadeOverlayLauncher(config);

  try {
    await assert.rejects(launcher.prepare(), (error) => {
      assert.ok(isReShadeOperationError(error));
      assert.equal(error.code, 'runtime-staging-failed');
      assert.equal(error.stage, 'runtime-staging');
      assert.equal(error.retrySafety, 'definite-safe');
      assert.match(
        error.message,
        /x86 Electron Game Overlay runtime package build stamp addonSha256 does not match electron_game_overlay\.addon32/,
      );
      return true;
    });
    assert.deepEqual(await fsPromises.readdir(fixture.runsRootDirectory), []);
  } finally {
    launcher.dispose();
  }
});

test('prepared runtime artifacts remain private snapshots after their package source changes', async () => {
  const fixture = createRuntime();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  let stagedRunDirectory;
  const unsubscribe = launcher.onEvent((event) => {
    if (event.type === 'runtime-staged') {
      stagedRunDirectory = event.runDirectory;
    }
  });

  try {
    await launcher.prepare();
    assert.ok(stagedRunDirectory);
    const stagedInjectorPath = path.join(stagedRunDirectory, 'inject32.exe');
    const stagedBytes = readFileSync(stagedInjectorPath);

    writeFileSync(
      path.join(fixture.runtimeDirectory, 'inject32.exe'),
      'changed after prepare',
    );

    assert.deepEqual(readFileSync(stagedInjectorPath), stagedBytes);
    assert.notDeepEqual(
      readFileSync(stagedInjectorPath),
      readFileSync(path.join(fixture.runtimeDirectory, 'inject32.exe')),
    );
  } finally {
    unsubscribe();
    launcher.dispose();
  }
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

  for (const executablePath of [
    'game.exe',
    'C:\\games\\other.exe',
    'C:\\games\\game.exe\0suffix',
  ]) {
    assert.throws(
      () =>
        buildReShadeInvocation(
          { processName: 'game.exe', pid: 42, executablePath },
          path.join(fixture.runsRootDirectory, 'run'),
        ),
      /executable path.*exact PID.*absolute.*match its process basename/,
    );
  }
  assert.throws(
    () =>
      buildReShadeInvocation(
        {
          processName: 'game.exe',
          executablePath: 'C:\\games\\game.exe',
        },
        path.join(fixture.runsRootDirectory, 'run'),
      ),
    /executable path.*requires an exact PID/,
  );

  for (const pathContains of ['', 'steamapps', ' \\steamapps\\', 'x\0y']) {
    assert.throws(
      () =>
        buildReShadeInvocation(
          { pathContains },
          path.join(fixture.runsRootDirectory, 'run'),
        ),
      /target path fragment/,
    );
  }
  assert.throws(
    () =>
      buildReShadeInvocation(
        {
          pathContains: '\\steamapps\\',
          excludedProcessNames: ['helper.exe', 'HELPER.EXE'],
        },
        path.join(fixture.runsRootDirectory, 'run'),
      ),
    /exclusions.*duplicate/,
  );

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
      () =>
        launchReShadeOverlay(launcher, { processName: 'game.exe', pid: 4243 }),
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

    const request = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 4242,
    });
    assert.equal(
      launchReShadeOverlay(launcher, { processName: 'game.exe', pid: 4242 }),
      request,
      'the same name/PID identity should share its active launch request',
    );
    assert.throws(
      () =>
        launchReShadeOverlay(launcher, { processName: 'game.exe', pid: 4241 }),
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
    assert.equal(acceptReShadeTargetConnection(launcher, 4241), false);
    assert.equal(acceptReShadeTargetConnection(launcher, 4242), true);
  } finally {
    launcher.dispose();
    execution.restore();
  }
});

test('launcher lifecycle subscriptions are optional, immutable, removable, and failure-isolated', async () => {
  const fixture = createRuntime();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  const logs = [];
  const observed = [];
  const removed = [];
  console.log = (...values) => logs.push(values);

  const removeThrowingHandler = launcher.onEvent((event) => {
    observed.push(event);
    throw new Error('synthetic observer failure');
  });
  const removeBeforeEvent = launcher.onEvent((event) => removed.push(event));
  removeBeforeEvent();
  removeBeforeEvent();

  try {
    assert.throws(
      () => launcher.onEvent(null),
      /event handler must be a function/,
    );
    await launcher.prepare();
    assert.equal(observed.length, 1);
    assert.equal(observed[0].type, 'runtime-staged');
    assert.equal(
      path.dirname(observed[0].runDirectory),
      fixture.runsRootDirectory,
    );
    assert.match(path.basename(observed[0].runDirectory), /^prepared-/);
    assert.ok(Object.isFrozen(observed[0]));
    assert.deepEqual(removed, []);
    assert.deepEqual(logs, []);

    removeThrowingHandler();
    removeThrowingHandler();
    launcher.dispose();
    assert.equal(observed.length, 1);
  } finally {
    removeThrowingHandler();
    launcher.dispose();
    console.log = originalLog;
  }
});

test('exact-PID stdout mismatch remains indeterminate and blocks retry', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const failures = [];
  const unsubscribe = launcher.onEvent((event) => {
    if (event.type === 'injector-failed') {
      failures.push(event);
      throw new Error('synthetic failure observer error');
    }
  });

  try {
    const request = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 5001,
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    execution.calls[0].callback(null, injectorSuccessFor(5002, 'game.exe'), '');
    let operationError;
    await assert.rejects(request, (error) => {
      operationError = error;
      assert.match(error.message, /selected pid=5002; expected pid=5001/);
      return true;
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].diagnostic, operationError.diagnostic);
    assert.equal(launcher.state, 'blocked');
    await flushMicrotasks();
    assert.equal(
      existsSync(path.join(runDirectory, runReclaimableMarkerFileName)),
      false,
      'an indeterminate injection result must not become reclaimable',
    );
    await assert.rejects(
      launchReShadeOverlay(launcher, { processName: 'game.exe', pid: 5001 }),
      /outcome is indeterminate/,
    );
  } finally {
    unsubscribe();
    launcher.dispose();
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
    const failed = launchReShadeOverlay(launcher, target);
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

    const retry = launchReShadeOverlay(launcher, target);
    await waitFor(() => execution.calls.length === 2);
    execution.calls[1].callback(null, injectorSuccessFor(6001, 'game.exe'), '');
    await retry;
    assert.equal(acceptReShadeTargetConnection(launcher, 6001), true);
  } finally {
    launcher.dispose();
    console.error = originalError;
    console.log = originalLog;
    execution.restore();
  }
});

test('a successful x64 injection never starts the x86 injector', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));

  try {
    const request = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 6051,
    });
    await waitFor(() => execution.calls.length === 1);
    assert.equal(path.basename(execution.calls[0].executable), 'inject.exe');
    execution.calls[0].callback(null, injectorSuccessFor(6051, 'game.exe'), '');
    await request;
    await flushMicrotasks();
    assert.equal(execution.calls.length, 1);
  } finally {
    launcher.dispose();
    execution.restore();
  }
});

test('a validated x64 architecture mismatch hands the exact target to x86 once', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath =
    'C:\\Steam\\steamapps\\common\\Example\\game.exe';
  const reportedTargetExecutablePath =
    '\\\\?\\C:\\Steam\\steamapps\\common\\Example\\.\\game.exe';

  try {
    const request = launchReShadeOverlay(launcher, {
      pathContains: '\\steamapps\\',
    });
    await waitFor(() => execution.calls.length === 1);
    assert.deepEqual(execution.calls[0].arguments, [
      '--path-contains',
      '\\steamapps\\',
    ]);
    assert.equal(execution.calls[0].options.timeout, 0);
    execution.calls[0].callback(
      Object.assign(new Error('wrong injector architecture'), { code: 706 }),
      architectureMismatchFor(6061, reportedTargetExecutablePath, {}, false),
      'x64 mismatch\n',
    );

    await waitFor(() => execution.calls.length === 2);
    assert.equal(path.basename(execution.calls[1].executable), 'inject32.exe');
    assert.equal(
      execution.calls[1].options.cwd,
      execution.calls[0].options.cwd,
    );
    assert.equal(execution.calls[1].options.timeout, 120_000);
    assert.deepEqual(execution.calls[1].arguments, [
      targetExecutablePath,
      '--pid',
      '6061',
    ]);
    execution.calls[1].callback(
      null,
      injectorSuccessAt(6061, targetExecutablePath),
      'x86 success\n',
    );

    const result = await request;
    assert.equal(result.injectorTargetPid, 6061);
    assert.equal(result.targetExecutablePath, targetExecutablePath);
    assert.equal(result.selectedPath, targetExecutablePath);
    assert.equal(result.runtimeMode, 'injected-runtime');
    assert.equal(execution.calls.length, 2);
    assert.match(
      readFileSync(result.injectorStdoutPath, 'utf8'),
      /=== x64 injector stdout ===[\s\S]*target-architecture-mismatch[\s\S]*=== x86 injector stdout ===[\s\S]*Succeeded!/,
    );
    assert.match(
      readFileSync(result.injectorStderrPath, 'utf8'),
      /=== x64 injector stderr ===\nx64 mismatch\n=== x86 injector stderr ===\nx86 success\n/,
    );
  } finally {
    launcher.dispose();
    execution.restore();
  }
});

test('a confirmed path-target exit during architecture handoff prevents the x86 spawn', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const delayedEvidence = delayInjectorEvidenceWrite();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'C:\\Steam\\steamapps\\common\\Exited\\game.exe';

  try {
    const request = launchReShadeOverlay(launcher, {
      pathContains: '\\steamapps\\',
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      Object.assign(new Error('wrong injector architecture'), { code: 706 }),
      architectureMismatchFor(6062, targetExecutablePath, {}, false),
      '',
    );

    await delayedEvidence.entered;
    assert.equal(launcher.confirmTargetExited(6062), true);
    delayedEvidence.release();
    await assert.rejects(request, (error) => {
      assert.equal(error.code, 'operation-cancelled');
      assert.equal(error.retrySafety, 'definite-safe');
      return true;
    });
    await flushMicrotasks();
    assert.equal(execution.calls.length, 1);
    assert.equal(launcher.state, 'idle');
  } finally {
    delayedEvidence.release();
    delayedEvidence.restore();
    launcher.dispose();
    execution.restore();
  }
});

test('x86 fallback accepts a compatible existing runtime after loading addon32', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  let preparationCalls = 0;
  const preparation = stubExistingReShadePreparation(async () => {
    preparationCalls += 1;
    throw new Error('x86 existing-runtime reuse must not touch disk');
  });
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'C:\\game\\game.exe';
  const runtimeModulePath = 'C:\\game\\ReShade32.dll';

  try {
    const request = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 6063,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      Object.assign(new Error('wrong injector architecture'), { code: 706 }),
      architectureMismatchFor(6063, targetExecutablePath, {}, false),
      '',
    );

    await waitFor(() => execution.calls.length === 2);
    assert.deepEqual(execution.calls[1].arguments, [
      targetExecutablePath,
      '--pid',
      '6063',
    ]);
    execution.calls[1].callback(
      null,
      existingRuntimeSuccessFor(6063, runtimeModulePath, 'game.exe'),
      '',
    );

    const result = await request;
    assert.equal(result.runtimeMode, 'existing-runtime');
    assert.equal(result.injectorTargetPid, 6063);
    assert.equal(result.targetExecutablePath, targetExecutablePath);
    assert.equal(result.hostRuntimePath, runtimeModulePath);
    assert.equal(preparationCalls, 0);
    assert.equal(execution.calls.length, 2);
  } finally {
    launcher.dispose();
    preparation.restore();
    execution.restore();
  }
});

test('malformed or mismatched architecture diagnostics cannot start x86', async (t) => {
  const scenarios = [
    {
      name: 'malformed schema',
      target: { processName: 'game.exe', pid: 6071 },
      stdout: architectureMismatchFor(6071, 'C:\\game\\game.exe', {
        targetArchitecture: 'x86',
      }),
    },
    {
      name: 'wrong pid',
      target: { processName: 'game.exe', pid: 6072 },
      stdout: architectureMismatchFor(9999, 'C:\\game\\game.exe'),
    },
    {
      name: 'wrong exact path',
      target: {
        processName: 'game.exe',
        pid: 6073,
        executablePath: 'C:\\game\\game.exe',
      },
      stdout: architectureMismatchFor(6073, 'C:\\other\\game.exe'),
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = createRuntime();
      const execution = stubExecFile();
      const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
      const originalError = console.error;
      console.error = () => undefined;
      try {
        const request = launchReShadeOverlay(launcher, scenario.target);
        await waitFor(() => execution.calls.length === 1);
        execution.calls[0].callback(
          Object.assign(new Error('wrong injector architecture'), {
            code: 706,
          }),
          scenario.stdout,
          '',
        );
        await assert.rejects(request);
        await flushMicrotasks();
        assert.equal(execution.calls.length, 1);
      } finally {
        launcher.dispose();
        console.error = originalError;
        execution.restore();
      }
    });
  }
});

test('a markerless x86 architecture mismatch is terminal and cannot loop', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const request = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 6081,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      Object.assign(new Error('wrong injector architecture'), { code: 706 }),
      architectureMismatchFor(6081, 'C:\\game\\game.exe', {}, false),
      '',
    );
    await waitFor(() => execution.calls.length === 2);
    execution.calls[1].callback(
      Object.assign(new Error('x86 injector also rejected target'), {
        code: 706,
      }),
      architectureMismatchFor(6081, 'C:\\game\\game.exe', {}, false),
      '',
    );

    await assert.rejects(request, (error) => {
      assert.equal(error.code, 'target-architecture-mismatch');
      assert.equal(error.retrySafety, 'definite-safe');
      return true;
    });
    await flushMicrotasks();
    assert.equal(execution.calls.length, 2);
  } finally {
    launcher.dispose();
    console.error = originalError;
    execution.restore();
  }
});

test('structured target preflight failures expose stable diagnostics and remain retry-safe', async (t) => {
  const scenarios = [
    {
      code: 'target-injection-already-claimed',
      native: {
        code: 'target-injection-already-claimed',
        pid: 6101,
        windowsErrorCode: 170,
      },
      message: /already claimed by another ReShade injector.*Windows error 170/,
    },
    {
      code: 'target-injection-claim-failed',
      native: {
        code: 'target-injection-claim-failed',
        pid: 6101,
        windowsErrorCode: 5,
      },
      message:
        /unable to establish exclusive ReShade injection ownership.*Windows error 5/,
    },
    {
      code: 'target-existing-reshade-installation',
      exitCode: 183,
      native: {
        code: 'target-existing-reshade-installation',
        pid: 6101,
        modulePath: 'C:\\game\\dxgi.dll',
      },
      message:
        /has an existing ReShade installation.*installation was preserved.*was not injected/,
    },
    {
      code: 'target-runtime-conflict',
      native: {
        code: 'target-runtime-conflict',
        pid: 6101,
        modulePath: 'C:\\Jeux\\測試\\renamed-wrapper.dll',
        windowsErrorCode: 183,
      },
      message: /already has a loaded ReShade runtime/,
    },
    {
      code: 'target-runtime-incompatible',
      native: {
        code: 'target-runtime-incompatible',
        pid: 6101,
        modulePath: 'C:\\game\\dxgi.dll',
        windowsErrorCode: 50,
      },
      message: /has an incompatible ReShade runtime/,
    },
    {
      code: 'target-runtime-reuse-too-late',
      native: {
        code: 'target-runtime-reuse-too-late',
        pid: 6101,
        modulePath: 'C:\\game\\dxgi.dll',
        windowsErrorCode: 170,
      },
      message: /loaded ReShade too late for safe runtime reuse/,
    },
    {
      code: 'target-runtime-reuse-raced',
      native: {
        code: 'target-runtime-reuse-raced',
        pid: 6101,
        modulePath: 'C:\\game\\dxgi.dll',
        windowsErrorCode: 1237,
      },
      message: /runtime changed while preparing reuse/,
    },
    {
      code: 'target-module-inspection-failed',
      native: {
        code: 'target-module-inspection-failed',
        pid: 6101,
        windowsErrorCode: 5,
      },
      message: /module inspection failed.*Windows error 5/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.code, async () => {
      const fixture = createRuntime();
      const execution = stubExecFile();
      const sessionHarness = createSessionHarness();
      const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
      const originalError = console.error;
      const originalLog = console.log;
      console.error = () => undefined;
      console.log = () => undefined;

      try {
        const target = { processName: 'game.exe', pid: 6101 };
        const attachment = launcher.attach(sessionHarness.session, target);
        await waitFor(() => execution.calls.length === 1);
        const runDirectory = execution.calls[0].options.cwd;
        execution.calls[0].callback(
          Object.assign(new Error('injector preflight rejected the target'), {
            code: scenario.exitCode ?? scenario.native.windowsErrorCode,
          }),
          `Found a matching process with PID 6101! Injecting ReShade ... \n` +
            injectorPreflightDiagnostic(scenario.native) +
            'ReShade injection not started.\n',
          '',
        );

        await assert.rejects(attachment, (error) => {
          assert.ok(error instanceof ReShadeOperationError);
          assert.equal(isReShadeOperationError(error), true);
          assert.match(error.message, scenario.message);
          assert.equal(error.code, scenario.code);
          assert.equal(error.stage, 'target-preflight');
          assert.equal(error.retrySafety, 'definite-safe');
          assert.equal(error.diagnostic.code, scenario.code);
          assert.equal(error.diagnostic.pid, 6101);
          assert.equal(error.diagnostic.modulePath, scenario.native.modulePath);
          assert.equal(
            error.diagnostic.windowsErrorCode,
            scenario.native.windowsErrorCode,
          );
          assert.equal(error.diagnostic.evidence.runDirectory, runDirectory);
          assert.equal(
            error.diagnostic.evidence.injectorStdoutPath,
            path.join(runDirectory, 'inject.stdout.log'),
          );
          const referencesHostRuntime =
            scenario.native.modulePath !== undefined &&
            [
              'target-existing-reshade-installation',
              'target-runtime-conflict',
              'target-runtime-incompatible',
              'target-runtime-reuse-too-late',
              'target-runtime-reuse-raced',
            ].includes(scenario.code);
          assert.equal(
            error.diagnostic.evidence.reshadeLogPath,
            referencesHostRuntime
              ? path.win32.join(
                  path.win32.dirname(scenario.native.modulePath),
                  'ReShade.log',
                )
              : path.join(runDirectory, 'ReShade.log'),
          );
          assert.equal(Object.isFrozen(error.diagnostic), true);
          assert.equal(Object.isFrozen(error.diagnostic.evidence), true);
          return true;
        });
        assert.equal(launcher.state, 'idle');
        assert.equal(sessionHarness.targetAuthorizations.length, 1);
        assert.equal(
          sessionHarness.targetAuthorizations[0].releaseCount,
          1,
          'a definite preflight rejection must release exact-PID rendezvous authorization',
        );

        const retry = launchReShadeOverlay(launcher, target);
        await waitFor(() => execution.calls.length === 2);
        execution.calls[1].callback(
          null,
          injectorSuccessFor(6101, 'game.exe'),
          '',
        );
        await retry;
        assert.equal(acceptReShadeTargetConnection(launcher, 6101), true);
      } finally {
        launcher.dispose();
        console.error = originalError;
        console.log = originalLog;
        execution.restore();
      }
    });
  }
});

test('existing-runtime add-on load failure is post-mutation and blocks retry', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const target = { processName: 'game.exe', pid: 6151 };
    const request = launchReShadeOverlay(launcher, target);
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      Object.assign(new Error('remote add-on load failed'), { code: 1114 }),
      injectorDiagnostic({
        stage: 'existing-runtime-addon-load',
        code: 'existing-runtime-addon-load-failed',
        pid: 6151,
        injectionStarted: true,
        modulePath: 'C:\\game\\dxgi.dll',
        windowsErrorCode: 1114,
      }),
      '',
    );

    await assert.rejects(request, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-runtime-addon-load-failed');
      assert.equal(error.stage, 'runtime-initialization');
      assert.equal(error.retrySafety, 'indeterminate');
      assert.equal(error.diagnostic.pid, 6151);
      assert.equal(error.diagnostic.modulePath, 'C:\\game\\dxgi.dll');
      assert.equal(error.diagnostic.windowsErrorCode, 1114);
      assert.equal(
        error.diagnostic.evidence.reshadeLogPath,
        'C:\\game\\ReShade.log',
      );
      return true;
    });
    assert.equal(launcher.state, 'blocked');
    await assert.rejects(
      launchReShadeOverlay(launcher, target),
      /outcome is indeterminate/,
    );
  } finally {
    launcher.dispose();
    console.error = originalError;
    execution.restore();
  }
});

test('malformed or contradictory injector diagnostic records cannot claim safe preflight', async (t) => {
  const cases = [
    {
      name: 'malformed JSON',
      stdout:
        'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC {not-json}\n' +
        'ReShade injection not started.\n',
      retrySafety: 'definite-safe',
      state: 'idle',
    },
    {
      name: 'relative module path',
      stdout:
        injectorPreflightDiagnostic({
          code: 'target-existing-reshade-installation',
          pid: 6201,
          modulePath: 'dxgi.dll',
        }) + 'ReShade injection not started.\n',
      retrySafety: 'definite-safe',
      state: 'idle',
    },
    {
      name: 'diagnostic contradicted by success',
      stdout:
        injectorSuccessFor(6201, 'game.exe') +
        injectorPreflightDiagnostic({
          code: 'target-runtime-conflict',
          pid: 6201,
          modulePath: 'C:\\game\\dxgi.dll',
        }) +
        'ReShade injection not started.\n',
      retrySafety: 'indeterminate',
      state: 'blocked',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = createRuntime();
      const execution = stubExecFile();
      const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
      const originalError = console.error;
      console.error = () => undefined;
      try {
        const request = launchReShadeOverlay(launcher, {
          processName: 'game.exe',
          pid: 6201,
        });
        await waitFor(() => execution.calls.length === 1);
        execution.calls[0].callback(
          Object.assign(new Error('diagnostic protocol failure'), { code: 1 }),
          scenario.stdout,
          '',
        );
        await assert.rejects(request, (error) => {
          assert.ok(isReShadeOperationError(error));
          assert.equal(error.code, 'injector-result-invalid');
          assert.equal(error.stage, 'injector');
          assert.equal(error.retrySafety, scenario.retrySafety);
          return true;
        });
        assert.equal(launcher.state, scenario.state);
      } finally {
        launcher.dispose();
        console.error = originalError;
        execution.restore();
      }
    });
  }
});

test('pre-injection proof cannot make legacy or contradictory output retry-safe', async (t) => {
  const scenarios = [
    {
      name: 'name-only invocation',
      target: { processName: 'game.exe' },
      stdout: 'ReShade injection not started.\n',
      message: /ambiguous injector failure/,
    },
    {
      name: 'exact-PID output that also reports injection success',
      target: { processName: 'game.exe', pid: 6002 },
      stdout:
        injectorSuccessFor(6002, 'game.exe') +
        'ReShade injection not started.\n',
      message: /structured success result while the injector process failed/,
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
        const request = launchReShadeOverlay(launcher, scenario.target);
        await waitFor(() => execution.calls.length === 1);
        execution.calls[0].callback(
          Object.assign(new Error('ambiguous injector failure'), { code: 1 }),
          scenario.stdout,
          '',
        );
        await assert.rejects(request, scenario.message);
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

test('launch stages the exact runtime, materializes configured PID, and preserves logs', async () => {
  const fixture = createRuntime();
  const config = createConfig(fixture, { expectedTargetPid: 4242 });
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(config);
  const events = [];
  const unsubscribe = launcher.onEvent((event) => events.push(event));

  try {
    assert.equal(launcher.state, 'idle');
    const request = launchReShadeOverlay(launcher, {
      processName: 'Gun Frog.exe',
    });
    assert.equal(launcher.state, 'attaching');
    assert.equal(acceptReShadeTargetConnection(launcher, 7), false);
    assert.equal(launcher.state, 'attaching');
    assert.equal(
      launchReShadeOverlay(launcher, { processName: 'Gun Frog.exe' }),
      request,
      'the same active target should share its launch request',
    );
    await waitFor(() => execution.calls.length === 1);

    const call = execution.calls[0];
    assert.deepEqual(call.arguments, ['Gun Frog.exe', '--pid', '4242']);
    assert.equal(call.options.cwd, path.dirname(call.executable));
    assert.equal(path.basename(call.executable), 'inject.exe');
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 120_000);
    assert.equal(call.options.maxBuffer, 64 * 1024);
    assert.equal(call.options.encoding, 'utf8');
    call.emitStdout(
      'ReShade process watcher armed.\nReShade path watcher armed.\n',
    );

    const runDirectory = call.options.cwd;
    assert.equal(path.dirname(runDirectory), fixture.runsRootDirectory);
    for (const artifact of artifacts) {
      assert.deepEqual(
        readFileSync(path.join(runDirectory, artifact)),
        readFileSync(path.join(fixture.runtimeDirectory, artifact)),
      );
      const sourceStats = statSync(
        path.join(fixture.runtimeDirectory, artifact),
      );
      const stagedStats = statSync(path.join(runDirectory, artifact));
      assert.notEqual(stagedStats.ino, sourceStats.ino);
    }

    call.callback(null, injectorSuccess, 'diagnostic stderr\n');
    const result = await request;
    assert.equal(result.processName, 'Gun Frog.exe');
    assert.equal(result.targetLabel, 'process:Gun Frog.exe:pid:4242');
    assert.equal(result.injectorTargetPid, 4242);
    assert.equal(result.runtimeMode, 'injected-runtime');
    assert.equal(Object.hasOwn(result, 'hostRuntimePath'), false);
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
    assert.equal(
      result.runtimeStartupPath,
      path.join(runDirectory, runtimeStartupFileName),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['runtime-staged', 'injector-started', 'injector-returned'],
    );
    assert.deepEqual(events[0], {
      type: 'runtime-staged',
      runDirectory,
    });
    assert.deepEqual(events[1], {
      type: 'injector-started',
      invocation: {
        executable: call.executable,
        arguments: ['Gun Frog.exe', '--pid', '4242'],
        targetLabel: 'process:Gun Frog.exe:pid:4242',
        workingDirectory: runDirectory,
      },
    });
    assert.deepEqual(events[2], {
      type: 'injector-returned',
      result,
    });
    assert.ok(events.every(Object.isFrozen));
    assert.ok(Object.isFrozen(events[1].invocation));
    assert.ok(Object.isFrozen(events[1].invocation.arguments));
    assert.ok(Object.isFrozen(events[2].result));
    assert.equal(acceptReShadeTargetConnection(launcher, 4242), true);
    assert.equal(launcher.state, 'connected');
    assert.equal(acceptReShadeTargetConnection(launcher, 4242), false);
    await assert.rejects(
      launchReShadeOverlay(launcher, { processName: 'Gun Frog.exe' }),
      /already connected/,
    );
    await assert.rejects(
      launcher.attach(createSessionHarness().session, {
        processName: 'Gun Frog.exe',
      }),
      /already connected/,
    );
  } finally {
    unsubscribe();
    launcher.dispose();
    execution.restore();
  }
});

test('name watcher readiness is emitted once after a split native marker', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const events = [];
  const unsubscribe = launcher.onEvent((event) => events.push(event));

  try {
    const request = launchReShadeOverlay(launcher, {
      processName: 'Gun Frog.exe',
    });
    await waitFor(() => execution.calls.length === 1);
    const call = execution.calls[0];
    call.emitStdout('ignored prefix\nReShade process wat');
    assert.equal(
      events.some((event) => event.type === 'injector-watcher-ready'),
      false,
    );
    call.emitStdout(Buffer.from('cher armed.\n'));
    call.emitStdout('ReShade process watcher armed.\n');

    const readyEvents = events.filter(
      (event) => event.type === 'injector-watcher-ready',
    );
    assert.equal(readyEvents.length, 1);
    assert.deepEqual(readyEvents[0], {
      type: 'injector-watcher-ready',
      invocation: {
        executable: call.executable,
        arguments: ['Gun Frog.exe'],
        targetLabel: 'process:Gun Frog.exe',
        workingDirectory: call.options.cwd,
      },
    });
    assert.ok(Object.isFrozen(readyEvents[0]));

    call.callback(
      null,
      `ReShade process watcher armed.\n${injectorSuccess}`,
      '',
    );
    await request;
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'runtime-staged',
        'injector-started',
        'injector-watcher-ready',
        'injector-returned',
      ],
    );
  } finally {
    unsubscribe();
    launcher.dispose();
    execution.restore();
  }
});

test('attach reports a validated existing ReShade host runtime', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const hostRuntimePath = 'D:\\Games\\Gun Frog\\dxgi.dll';
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'Gun Frog.exe',
      pid: 4252,
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    execution.calls[0].callback(
      null,
      existingRuntimeSuccessFor(4252, hostRuntimePath),
      '',
    );
    sessionHarness.emitNative('game.process', {
      pid: 4252,
      path: 'D:\\Games\\Gun Frog\\Gun Frog.exe',
    });

    const result = await attachment;
    assert.equal(result.pid, 4252);
    assert.equal(result.injectorTargetPid, 4252);
    assert.equal(result.runtimeMode, 'existing-runtime');
    assert.equal(result.hostRuntimePath, hostRuntimePath);
    assert.equal(result.reshadeLogPath, 'D:\\Games\\Gun Frog\\ReShade.log');
    assert.equal(
      result.runtimeStartupPath,
      path.join(result.runDirectory, runtimeStartupFileName),
    );
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('attach reports a preinstalled add-on hosted by official ReShade', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const hostRuntimePath = 'D:\\Games\\Gun Frog\\dxgi.dll';
  const addonModulePath = 'D:\\Games\\Gun Frog\\electron_game_overlay.addon64';
  const inspections = [];
  const inspectionStub = stubLoadedOfficialReShadeInspection(
    async (options) => {
      inspections.push(options);
      return officialLoadedAddonInspectionResult({
        targetExecutablePath: 'D:\\Games\\Gun Frog\\Gun Frog.exe',
        reshadeModulePath: hostRuntimePath,
        loadedAddonModulePath: addonModulePath,
      });
    },
  );
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'Gun Frog.exe',
      pid: 4253,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      null,
      officialAddonSuccessFor(4253, hostRuntimePath, addonModulePath),
      '',
    );
    sessionHarness.emitNative('game.process', {
      pid: 4253,
      path: 'D:\\Games\\Gun Frog\\Gun Frog.exe',
    });

    const result = await attachment;
    assert.equal(result.pid, 4253);
    assert.equal(result.injectorTargetPid, 4253);
    assert.equal(result.runtimeMode, 'official-addon');
    assert.equal(result.hostRuntimePath, hostRuntimePath);
    assert.equal(result.addonModulePath, addonModulePath);
    assert.equal(result.reshadeLogPath, 'D:\\Games\\Gun Frog\\ReShade.log');
    assert.equal(inspections.length, 1);
    assert.equal(
      inspections[0].managerExecutablePath,
      path.join(
        result.runDirectory,
        'electron_game_overlay_reshade_manager.exe',
      ),
    );
    assert.deepEqual(inspections[0].targetEffectiveSettings, {
      reshadeBasePath: 'D:\\Games\\Gun Frog',
      addonDirectoryPath: 'D:\\Games\\Gun Frog',
      electronGameOverlayAddonDisabled: false,
    });
  } finally {
    launcher.dispose();
    console.log = originalLog;
    inspectionStub.restore();
    execution.restore();
  }
});

test('a loaded stale official add-on is refused until it can be updated and restarted', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Gun Frog\\Gun Frog.exe';
  const hostRuntimePath = 'D:\\Games\\Gun Frog\\dxgi.dll';
  const addonModulePath = 'D:\\Games\\Gun Frog\\electron_game_overlay.addon64';
  const inspectionStub = stubLoadedOfficialReShadeInspection(async () =>
    officialLoadedAddonInspectionResult({
      status: 'update-required',
      targetExecutablePath,
      reshadeModulePath: hostRuntimePath,
      loadedAddonModulePath: addonModulePath,
    }),
  );
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'Gun Frog.exe',
      pid: 4259,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      null,
      officialAddonSuccessFor(4259, hostRuntimePath, addonModulePath),
      '',
    );
    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-maintenance-deferred');
      assert.equal(error.retrySafety, 'definite-safe');
      assert.match(error.message, /non-current managed add-on/);
      return true;
    });
    assert.equal(launcher.state, 'idle');
  } finally {
    launcher.dispose();
    console.error = originalError;
    inspectionStub.restore();
    execution.restore();
  }
});

test('a foreign official-host add-on collision is preserved without scheduling maintenance', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Gun Frog\\Gun Frog.exe';
  const hostRuntimePath = 'D:\\Games\\Gun Frog\\dxgi.dll';
  const addonModulePath = 'D:\\Games\\Gun Frog\\electron_game_overlay.addon64';
  let preparationCount = 0;
  const preparationStub = stubExistingReShadePreparation(async () => {
    preparationCount += 1;
    throw new Error('foreign add-on maintenance must not be scheduled');
  });
  const inspectionStub = stubLoadedOfficialReShadeInspection(async () =>
    officialLoadedAddonInspectionResult({
      status: 'foreign-collision',
      targetExecutablePath,
      reshadeModulePath: hostRuntimePath,
      loadedAddonModulePath: addonModulePath,
    }),
  );
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'Gun Frog.exe',
      pid: 4265,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      null,
      officialAddonSuccessFor(4265, hostRuntimePath, addonModulePath),
      '',
    );
    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-conflict');
      assert.equal(error.retrySafety, 'definite-safe');
      assert.match(error.message, /existing installation was preserved/);
      assert.match(error.message, /no automatic update was scheduled/);
      return true;
    });
    assert.equal(launcher.confirmTargetExited(4265), false);
    await flushMicrotasks();
    assert.equal(preparationCount, 0);
    assert.equal(launcher.state, 'idle');
  } finally {
    launcher.dispose();
    console.error = originalError;
    inspectionStub.restore();
    preparationStub.restore();
    execution.restore();
  }
});

test('a target-effective DisabledAddons opt-out refuses a loaded official add-on without disk inspection', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Gun Frog\\Gun Frog.exe';
  const hostRuntimePath = 'D:\\Games\\Gun Frog\\dxgi.dll';
  const addonModulePath = 'D:\\Games\\Gun Frog\\electron_game_overlay.addon64';
  let inspectionCount = 0;
  const inspectionStub = stubLoadedOfficialReShadeInspection(async () => {
    inspectionCount += 1;
    throw new Error('inspection must not run for a disabled add-on');
  });
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'Gun Frog.exe',
      pid: 4260,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      null,
      officialAddonSuccessFor(
        4260,
        hostRuntimePath,
        addonModulePath,
        'Gun Frog.exe',
        { electronGameOverlayAddonDisabled: true },
      ),
      '',
    );
    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-disabled');
      assert.equal(error.retrySafety, 'definite-safe');
      return true;
    });
    assert.equal(inspectionCount, 0);
    assert.equal(launcher.state, 'idle');
  } finally {
    launcher.dispose();
    console.error = originalError;
    inspectionStub.restore();
    execution.restore();
  }
});

test('an inactive recognized official install is prepared once and requires a target restart', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Official\\game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  const prepared = officialPreparedAddonResult({
    status: 'installed',
    targetExecutablePath,
    reshadeModulePath: hostRuntimePath,
  });
  const preparations = [];
  const preparationStub = stubExistingReShadePreparation(async (options) => {
    preparations.push(options);
    return prepared;
  });
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 4254,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    execution.calls[0].callback(
      Object.assign(new Error('existing installation'), { code: 183 }),
      `Found a matching process with PID 4254!\n` +
        injectorPreflightDiagnostic({
          code: 'target-existing-reshade-installation',
          pid: 4254,
          targetExecutablePath,
          modulePath: hostRuntimePath,
        }) +
        'ReShade injection not started.\n',
      '',
    );

    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-restart-required');
      assert.equal(error.stage, 'target-preflight');
      assert.equal(error.retrySafety, 'definite-safe');
      assert.equal(error.diagnostic.modulePath, hostRuntimePath);
      assert.equal(error.diagnostic.addonPath, prepared.addonDestinationPath);
      assert.match(error.message, /was installed.*must be restarted/);
      return true;
    });
    assert.deepEqual(preparations, [
      {
        targetExecutablePath,
        reshadeModulePath: hostRuntimePath,
        addonSourcePath: path.join(
          runDirectory,
          'electron_game_overlay.addon64',
        ),
        managerExecutablePath: path.join(
          runDirectory,
          'electron_game_overlay_reshade_manager.exe',
        ),
        targetEffectiveSettings: {
          reshadeBasePath: path.win32.dirname(hostRuntimePath),
          addonDirectoryPath: path.win32.dirname(hostRuntimePath),
          electronGameOverlayAddonDisabled: false,
        },
      },
    ]);
    assert.equal(launcher.state, 'idle');
  } finally {
    launcher.dispose();
    console.error = originalError;
    preparationStub.restore();
    execution.restore();
  }
});

test('an arbitrary ReShade identity never schedules automatic owned add-on removal', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Upgraded\\game.exe';
  const hostRuntimePath = 'D:\\Games\\Upgraded\\dxgi.dll';
  const addonModulePath = 'D:\\Games\\Upgraded\\electron_game_overlay.addon64';
  const preparationOptions = [];
  const preparationStub = stubExistingReShadePreparation(async (options) => {
    preparationOptions.push(options);
    return officialPreparedAddonResult({
      status: 'already-current',
      targetExecutablePath,
      reshadeModulePath: hostRuntimePath,
      reshadeModuleSha256: 'B'.repeat(64),
    });
  });
  let removalCount = 0;
  const removalStub = stubExistingReShadeRemoval(async () => {
    removalCount += 1;
    throw new Error('automatic removal must not run');
  });
  const originalError = console.error;
  const originalLog = console.log;
  const maintenanceLogs = [];
  console.error = () => undefined;
  console.log = (...values) => maintenanceLogs.push(values.join(' '));

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 4266,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    execution.calls[0].callback(
      Object.assign(new Error('unsupported upgraded runtime'), { code: 50 }),
      `Found a matching process with PID 4266!\n` +
        injectorPreflightDiagnostic({
          code: 'target-runtime-incompatible',
          pid: 4266,
          targetExecutablePath,
          modulePath: hostRuntimePath,
          windowsErrorCode: 50,
        }) +
        'ReShade injection not started.\n',
      '',
    );
    await waitFor(() => execution.calls.length === 2);
    assert.deepEqual(execution.calls[1].arguments, [
      targetExecutablePath,
      '--pid',
      '4266',
      '--wait-for-official-addon',
      '30000',
    ]);
    execution.calls[1].callback(
      Object.assign(new Error('unsupported upgraded runtime'), { code: 50 }),
      `Found a matching process with PID 4266!\n` +
        injectorPreflightDiagnostic({
          code: 'target-runtime-incompatible',
          pid: 4266,
          targetExecutablePath,
          modulePath: hostRuntimePath,
          windowsErrorCode: 50,
        }) +
        'ReShade injection not started.\n',
      '',
    );

    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-host-incompatible');
      assert.equal(error.retrySafety, 'definite-safe');
      assert.equal(error.diagnostic.addonPath, addonModulePath);
      assert.match(
        error.message,
        /did not load it.*public add-on API 18.*Dear ImGui/,
      );
      return true;
    });
    assert.equal(
      preparationOptions.length,
      2,
      'the post-grace diagnostic revalidates the still-current managed add-on',
    );
    assert.equal(removalCount, 0);
    assert.equal(launcher.confirmTargetExited(4266), false);
    await flushMicrotasks();
    assert.equal(removalCount, 0);
    assert.deepEqual(maintenanceLogs, []);
    await waitFor(() =>
      existsSync(path.join(runDirectory, runReclaimableMarkerFileName)),
    );
  } finally {
    launcher.dispose();
    console.error = originalError;
    console.log = originalLog;
    removalStub.restore();
    preparationStub.restore();
    execution.restore();
  }
});

test('a mapped official add-on update retries only after confirmed target exit and then retires its staged run', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Official\\game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  const preparations = [];
  let releaseDeferredPreparation;
  const deferredPreparation = new Promise((resolve) => {
    releaseDeferredPreparation = resolve;
  });
  const preparationStub = stubExistingReShadePreparation(async (options) => {
    preparations.push(options);
    if (preparations.length === 1) {
      throw new existingReShadeInstallation.ExistingReShadeInstallationError(
        'manager-failed',
        'the mapped add-on could not be replaced while the target was alive',
        options.addonSourcePath,
      );
    }
    await deferredPreparation;
    return officialPreparedAddonResult({
      status: 'updated',
      targetExecutablePath,
      reshadeModulePath: hostRuntimePath,
    });
  });
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => undefined;
  console.log = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 4261,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    execution.calls[0].callback(
      Object.assign(new Error('incompatible loaded runtime'), { code: 50 }),
      `Found a matching process with PID 4261!\n` +
        injectorPreflightDiagnostic({
          code: 'target-runtime-incompatible',
          pid: 4261,
          targetExecutablePath,
          modulePath: hostRuntimePath,
          windowsErrorCode: 50,
        }) +
        'ReShade injection not started.\n',
      '',
    );

    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-maintenance-deferred');
      assert.equal(error.retrySafety, 'definite-safe');
      assert.match(error.message, /manager-failed/);
      return true;
    });
    await flushMicrotasks();
    assert.equal(
      preparations.length,
      1,
      'the manager must not retry while the target may still map the add-on',
    );
    assert.equal(
      existsSync(path.join(runDirectory, runReclaimableMarkerFileName)),
      false,
      'the staged manager and add-on must remain available for the deferred retry',
    );
    assert.equal(launcher.confirmTargetExited(4262), false);
    assert.equal(preparations.length, 1);

    assert.equal(launcher.confirmTargetExited(4261), true);
    await waitFor(() => preparations.length === 2);
    assert.deepEqual(preparations[1], preparations[0]);
    assert.equal(
      existsSync(path.join(runDirectory, runReclaimableMarkerFileName)),
      false,
      'the run must remain live until deferred maintenance settles',
    );

    releaseDeferredPreparation();
    await waitFor(() =>
      existsSync(path.join(runDirectory, runReclaimableMarkerFileName)),
    );
    assert.equal(launcher.confirmTargetExited(4261), false);
  } finally {
    releaseDeferredPreparation?.();
    launcher.dispose();
    console.error = originalError;
    console.log = originalLog;
    preparationStub.restore();
    execution.restore();
  }
});

test('a confirmed exit that races manager failure survives immediate launcher disposal', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Official\\racing-game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  let rejectFirstPreparation;
  let resolveFirstPreparationStarted;
  const firstPreparationStarted = new Promise((resolve) => {
    resolveFirstPreparationStarted = resolve;
  });
  let preparationCount = 0;
  const preparationStub = stubExistingReShadePreparation(async (options) => {
    ++preparationCount;
    if (preparationCount === 1) {
      resolveFirstPreparationStarted();
      return new Promise((resolve, reject) => {
        void resolve;
        rejectFirstPreparation = () =>
          reject(
            new existingReShadeInstallation.ExistingReShadeInstallationError(
              'manager-failed',
              'the target exited while its mapped add-on was still locked',
              options.addonSourcePath,
            ),
          );
      });
    }
    return officialPreparedAddonResult({
      status: 'updated',
      targetExecutablePath,
      reshadeModulePath: hostRuntimePath,
    });
  });
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => undefined;
  console.log = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'racing-game.exe',
      pid: 4263,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      Object.assign(new Error('incompatible loaded runtime'), { code: 50 }),
      injectorPreflightDiagnostic({
        code: 'target-runtime-incompatible',
        pid: 4263,
        targetExecutablePath,
        modulePath: hostRuntimePath,
        windowsErrorCode: 50,
      }) + 'ReShade injection not started.\n',
      '',
    );

    await firstPreparationStarted;
    assert.equal(launcher.confirmTargetExited(4263), true);
    launcher.dispose();
    rejectFirstPreparation();
    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-maintenance-deferred');
      return true;
    });
    await waitFor(() => preparationCount === 2);
  } finally {
    rejectFirstPreparation?.();
    launcher.dispose();
    console.error = originalError;
    console.log = originalLog;
    preparationStub.restore();
    execution.restore();
  }
});

test('disposal before exit proof cannot claim that delayed maintenance was queued', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Official\\disposed-game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  let rejectPreparation;
  let resolvePreparationStarted;
  const preparationStarted = new Promise((resolve) => {
    resolvePreparationStarted = resolve;
  });
  let preparationCount = 0;
  const preparationStub = stubExistingReShadePreparation(async (options) => {
    ++preparationCount;
    resolvePreparationStarted();
    return new Promise((resolve, reject) => {
      void resolve;
      rejectPreparation = () =>
        reject(
          new existingReShadeInstallation.ExistingReShadeInstallationError(
            'manager-failed',
            'the delayed manager request failed after launcher disposal',
            options.addonSourcePath,
          ),
        );
    });
  });
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'disposed-game.exe',
      pid: 4267,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    execution.calls[0].callback(
      Object.assign(new Error('incompatible loaded runtime'), { code: 50 }),
      injectorPreflightDiagnostic({
        code: 'target-runtime-incompatible',
        pid: 4267,
        targetExecutablePath,
        modulePath: hostRuntimePath,
        windowsErrorCode: 50,
      }) + 'ReShade injection not started.\n',
      '',
    );

    await preparationStarted;
    launcher.dispose();
    rejectPreparation();
    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-preparation-failed');
      assert.doesNotMatch(error.message, /maintenance is deferred/);
      return true;
    });
    await waitFor(() =>
      existsSync(path.join(runDirectory, runReclaimableMarkerFileName)),
    );
    assert.equal(launcher.confirmTargetExited(4267), false);
    assert.equal(preparationCount, 1);
  } finally {
    rejectPreparation?.();
    launcher.dispose();
    console.error = originalError;
    preparationStub.restore();
    execution.restore();
  }
});

test('disposing before target exit abandons deferred maintenance and retires its staged run', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Official\\abandoned-game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  let preparationCount = 0;
  const preparationStub = stubExistingReShadePreparation(async (options) => {
    ++preparationCount;
    throw new existingReShadeInstallation.ExistingReShadeInstallationError(
      'manager-failed',
      'the mapped add-on remains locked',
      options.addonSourcePath,
    );
  });
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'abandoned-game.exe',
      pid: 4264,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    execution.calls[0].callback(
      Object.assign(new Error('incompatible loaded runtime'), { code: 50 }),
      injectorPreflightDiagnostic({
        code: 'target-runtime-incompatible',
        pid: 4264,
        targetExecutablePath,
        modulePath: hostRuntimePath,
        windowsErrorCode: 50,
      }) + 'ReShade injection not started.\n',
      '',
    );

    await assert.rejects(launch);
    assert.equal(preparationCount, 1);
    launcher.dispose();
    await waitFor(() =>
      existsSync(path.join(runDirectory, runReclaimableMarkerFileName)),
    );
    assert.equal(launcher.confirmTargetExited(4264), false);
    assert.equal(preparationCount, 1);
  } finally {
    launcher.dispose();
    console.error = originalError;
    preparationStub.restore();
    execution.restore();
  }
});

test('official add-on preparation requires the exact normal native preflight exit', async (t) => {
  const cases = [
    {
      name: 'wrong exit code',
      error: Object.assign(new Error('wrong terminal status'), { code: 1 }),
    },
    {
      name: 'timeout kill',
      error: Object.assign(new Error('timed out'), {
        code: 183,
        killed: true,
        signal: 'SIGTERM',
      }),
    },
    {
      name: 'zero exit',
      error: null,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = createRuntime();
      const execution = stubExecFile();
      const targetExecutablePath = 'D:\\Games\\Official\\game.exe';
      const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
      let preparationCount = 0;
      const preparationStub = stubExistingReShadePreparation(async () => {
        ++preparationCount;
        return officialPreparedAddonResult({
          status: 'installed',
          targetExecutablePath,
          reshadeModulePath: hostRuntimePath,
        });
      });
      const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
      const originalError = console.error;
      console.error = () => undefined;

      try {
        const launch = launchReShadeOverlay(launcher, {
          processName: 'game.exe',
          pid: 4254,
          executablePath: targetExecutablePath,
        });
        await waitFor(() => execution.calls.length === 1);
        execution.calls[0].callback(
          scenario.error,
          injectorPreflightDiagnostic({
            code: 'target-existing-reshade-installation',
            pid: 4254,
            targetExecutablePath,
            modulePath: hostRuntimePath,
          }) + 'ReShade injection not started.\n',
          '',
        );

        await assert.rejects(launch, (error) => {
          assert.ok(error instanceof ReShadeOperationError);
          assert.equal(error.code, 'injector-result-invalid');
          assert.equal(error.retrySafety, 'indeterminate');
          return true;
        });
        assert.equal(
          preparationCount,
          0,
          'an untrusted injector termination must never mutate an official installation',
        );
        assert.equal(launcher.state, 'blocked');
      } finally {
        launcher.dispose();
        console.error = originalError;
        preparationStub.restore();
        execution.restore();
      }
    });
  }
});

test('an expired official add-on startup wait remains definite-safe and never falls back', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Official\\game.exe';
  const requestedTargetExecutablePath =
    '\\\\?\\D:\\Games\\Official\\.\\game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  const prepared = officialPreparedAddonResult({
    status: 'already-current',
    targetExecutablePath,
    reshadeModulePath: hostRuntimePath,
  });
  const preparationStub = stubExistingReShadePreparation(async () => prepared);
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 4255,
      executablePath: requestedTargetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    assert.deepEqual(execution.calls[0].arguments, [
      targetExecutablePath,
      '--pid',
      '4255',
    ]);
    execution.calls[0].callback(
      Object.assign(new Error('existing installation'), { code: 183 }),
      `Found a matching process with PID 4255!\n` +
        injectorPreflightDiagnostic({
          code: 'target-existing-reshade-installation',
          pid: 4255,
          targetExecutablePath,
          modulePath: hostRuntimePath,
        }) +
        'ReShade injection not started.\n',
      '',
    );
    await waitFor(() => execution.calls.length === 2);
    assert.deepEqual(execution.calls[1].arguments, [
      targetExecutablePath,
      '--pid',
      '4255',
      '--wait-for-official-addon',
      '30000',
    ]);
    execution.calls[1].callback(
      Object.assign(new Error('official add-on startup wait expired'), {
        code: 1460,
      }),
      `Found a matching process with PID 4255!\n` +
        injectorPreflightDiagnostic({
          code: 'target-official-addon-wait-expired',
          pid: 4255,
          targetExecutablePath,
          windowsErrorCode: 1460,
        }) +
        'ReShade injection not started.\n',
      '',
    );
    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'target-official-addon-wait-expired');
      assert.equal(error.retrySafety, 'definite-safe');
      assert.match(
        error.message,
        /bounded official ReShade add-on startup wait ended.*injection were refused/,
      );
      return true;
    });
    assert.equal(launcher.state, 'idle');
  } finally {
    launcher.dispose();
    console.error = originalError;
    preparationStub.restore();
    execution.restore();
  }
});

test('the SDK rejects a mutating result from the inspection-only official add-on wait', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Official\\game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  const preparationStub = stubExistingReShadePreparation(async () =>
    officialPreparedAddonResult({
      status: 'already-current',
      targetExecutablePath,
      reshadeModulePath: hostRuntimePath,
    }),
  );
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 4265,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      Object.assign(new Error('existing installation'), { code: 183 }),
      injectorPreflightDiagnostic({
        code: 'target-existing-reshade-installation',
        pid: 4265,
        targetExecutablePath,
        modulePath: hostRuntimePath,
      }) + 'ReShade injection not started.\n',
      '',
    );

    await waitFor(() => execution.calls.length === 2);
    execution.calls[1].callback(null, injectorSuccessFor(4265, 'game.exe'), '');

    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'injector-result-invalid');
      assert.equal(error.retrySafety, 'indeterminate');
      assert.match(
        error.message,
        /startup wait returned a mutating runtime mode/,
      );
      return true;
    });
    assert.equal(launcher.state, 'blocked');
  } finally {
    launcher.dispose();
    console.error = originalError;
    preparationStub.restore();
    execution.restore();
  }
});

test('a current add-on may finish loading during the bounded startup grace', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Official\\game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  const addonModulePath = 'D:\\Games\\Official\\electron_game_overlay.addon64';
  const preparationStub = stubExistingReShadePreparation(async () =>
    officialPreparedAddonResult({
      status: 'already-current',
      targetExecutablePath,
      reshadeModulePath: hostRuntimePath,
    }),
  );
  const inspectionStub = stubLoadedOfficialReShadeInspection(async (options) =>
    officialLoadedAddonInspectionResult({
      targetExecutablePath: options.targetExecutablePath,
      reshadeModulePath: options.reshadeModulePath,
      loadedAddonModulePath: options.loadedAddonModulePath,
    }),
  );

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 4257,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      Object.assign(new Error('existing installation'), { code: 183 }),
      `Found a matching process with PID 4257!\n` +
        injectorPreflightDiagnostic({
          code: 'target-existing-reshade-installation',
          pid: 4257,
          targetExecutablePath,
          modulePath: hostRuntimePath,
        }) +
        'ReShade injection not started.\n',
      '',
    );

    await waitFor(() => execution.calls.length === 2);
    assert.deepEqual(execution.calls[1].arguments, [
      targetExecutablePath,
      '--pid',
      '4257',
      '--wait-for-official-addon',
      '30000',
    ]);
    execution.calls[1].callback(
      null,
      officialAddonSuccessFor(
        4257,
        hostRuntimePath,
        addonModulePath,
        'game.exe',
      ),
      '',
    );

    const result = await launch;
    assert.equal(result.runtimeMode, 'official-addon');
    assert.equal(result.hostRuntimePath, hostRuntimePath);
    assert.equal(result.addonModulePath, addonModulePath);
    assert.equal(acceptReShadeTargetConnection(launcher, 4257), true);
  } finally {
    launcher.dispose();
    inspectionStub.restore();
    preparationStub.restore();
    execution.restore();
  }
});

test('concurrent launchers coordinate one same-process official add-on startup grace', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const config = createConfig(fixture);
  const firstLauncher = new ReShadeOverlayLauncher(config);
  const secondLauncher = new ReShadeOverlayLauncher(config);
  const targetExecutablePath = 'D:\\Games\\Official\\game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  const addonModulePath = 'D:\\Games\\Official\\electron_game_overlay.addon64';
  const preparationStub = stubExistingReShadePreparation(async () =>
    officialPreparedAddonResult({
      status: 'already-current',
      targetExecutablePath,
      reshadeModulePath: hostRuntimePath,
    }),
  );
  const inspectionStub = stubLoadedOfficialReShadeInspection(async (options) =>
    officialLoadedAddonInspectionResult({
      targetExecutablePath: options.targetExecutablePath,
      reshadeModulePath: options.reshadeModulePath,
      loadedAddonModulePath: options.loadedAddonModulePath,
    }),
  );
  const events = [];
  firstLauncher.onEvent((event) => events.push(event));
  secondLauncher.onEvent((event) => events.push(event));

  try {
    const target = {
      processName: 'game.exe',
      pid: 4258,
      executablePath: targetExecutablePath,
    };
    const firstLaunch = launchReShadeOverlay(firstLauncher, target).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    );
    const secondLaunch = launchReShadeOverlay(secondLauncher, target).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    );
    await waitFor(() => execution.calls.length === 2);
    const preflightOutput =
      `Found a matching process with PID 4258!\n` +
      injectorPreflightDiagnostic({
        code: 'target-existing-reshade-installation',
        pid: 4258,
        targetExecutablePath,
        modulePath: hostRuntimePath,
      }) +
      'ReShade injection not started.\n';
    for (const call of execution.calls.slice(0, 2)) {
      call.callback(
        Object.assign(new Error('existing installation'), { code: 183 }),
        preflightOutput,
        '',
      );
    }

    await waitFor(() => execution.calls.length === 3);
    assert.deepEqual(execution.calls[2].arguments, [
      targetExecutablePath,
      '--pid',
      '4258',
      '--wait-for-official-addon',
      '30000',
    ]);
    await flushMicrotasks();
    assert.equal(
      execution.calls.length,
      3,
      'same PID and executable path must start one native grace process',
    );
    execution.calls[2].callback(
      null,
      officialAddonSuccessFor(
        4258,
        hostRuntimePath,
        addonModulePath,
        'game.exe',
      ),
      '',
    );

    const outcomes = await Promise.all([firstLaunch, secondLaunch]);
    const fulfilled = outcomes.filter(({ status }) => status === 'fulfilled');
    const rejected = outcomes.filter(({ status }) => status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(fulfilled[0].value.runtimeMode, 'official-addon');
    assert.ok(rejected[0].reason instanceof ReShadeOperationError);
    assert.equal(
      rejected[0].reason.code,
      'official-addon-startup-grace-coordinated',
    );
    assert.equal(
      events.filter(({ type }) => type === 'injector-returned').length,
      1,
      'only the native grace owner may publish a success result',
    );
    assert.equal(
      events.filter(
        (event) =>
          event.type === 'injector-failed' &&
          event.diagnostic.code === 'official-addon-startup-grace-coordinated',
      ).length,
      1,
    );
    assert.equal(
      acceptReShadeTargetConnection(firstLauncher, 4258) ||
        acceptReShadeTargetConnection(secondLauncher, 4258),
      true,
    );
  } finally {
    firstLauncher.dispose();
    secondLauncher.dispose();
    inspectionStub.restore();
    preparationStub.restore();
    execution.restore();
  }
});

test('a loaded ReShade host that rejected the current add-on is capability-incompatible', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Official\\game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  const prepared = officialPreparedAddonResult({
    status: 'already-current',
    targetExecutablePath,
    reshadeModulePath: hostRuntimePath,
  });
  const preparationStub = stubExistingReShadePreparation(async () => prepared);
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 4256,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      Object.assign(new Error('incompatible loaded runtime'), { code: 50 }),
      `Found a matching process with PID 4256!\n` +
        injectorPreflightDiagnostic({
          code: 'target-runtime-incompatible',
          pid: 4256,
          targetExecutablePath,
          modulePath: hostRuntimePath,
          windowsErrorCode: 50,
        }) +
        'ReShade injection not started.\n',
      '',
    );
    await waitFor(() => execution.calls.length === 2);
    assert.deepEqual(execution.calls[1].arguments, [
      targetExecutablePath,
      '--pid',
      '4256',
      '--wait-for-official-addon',
      '30000',
    ]);
    execution.calls[1].callback(
      Object.assign(new Error('incompatible loaded runtime'), { code: 50 }),
      `Found a matching process with PID 4256!\n` +
        injectorPreflightDiagnostic({
          code: 'target-runtime-incompatible',
          pid: 4256,
          targetExecutablePath,
          modulePath: hostRuntimePath,
          windowsErrorCode: 50,
        }) +
        'ReShade injection not started.\n',
      '',
    );

    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-host-incompatible');
      assert.match(
        error.message,
        /did not load it.*public add-on API 18.*Dear ImGui/,
      );
      return true;
    });
    assert.equal(launcher.state, 'idle');
  } finally {
    launcher.dispose();
    console.error = originalError;
    preparationStub.restore();
    execution.restore();
  }
});

test('a user-disabled official add-on is preserved and reported without a restart loop', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Official\\game.exe';
  const hostRuntimePath = 'D:\\Games\\Official\\dxgi.dll';
  const prepared = officialPreparedAddonResult({
    status: 'disabled-by-user',
    targetExecutablePath,
    reshadeModulePath: hostRuntimePath,
  });
  const preparationStub = stubExistingReShadePreparation(async () => prepared);
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 4256,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      Object.assign(new Error('existing installation'), { code: 183 }),
      injectorPreflightDiagnostic({
        code: 'target-existing-reshade-installation',
        pid: 4256,
        targetExecutablePath,
        modulePath: hostRuntimePath,
      }) + 'ReShade injection not started.\n',
      '',
    );

    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-disabled');
      assert.equal(error.retrySafety, 'definite-safe');
      assert.equal(error.diagnostic.addonPath, undefined);
      assert.match(
        error.message,
        /user has disabled "Electron Game Overlay Runtime".*enable that add-on/,
      );
      return true;
    });
    assert.equal(launcher.state, 'idle');
  } finally {
    launcher.dispose();
    console.error = originalError;
    preparationStub.restore();
    execution.restore();
  }
});

test('an arbitrary existing ReShade identity is prepared and requires one restart', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath = 'D:\\Games\\Arbitrary\\game.exe';
  const hostRuntimePath = 'D:\\Games\\Arbitrary\\dxgi.dll';
  const prepared = officialPreparedAddonResult({
    status: 'installed',
    targetExecutablePath,
    reshadeModulePath: hostRuntimePath,
    reshadeModuleSha256: 'D'.repeat(64),
  });
  const preparationStub = stubExistingReShadePreparation(async () => prepared);
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const launch = launchReShadeOverlay(launcher, {
      processName: 'game.exe',
      pid: 4257,
      executablePath: targetExecutablePath,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      Object.assign(new Error('existing installation'), { code: 183 }),
      `Found a matching process with PID 4257!\n` +
        injectorPreflightDiagnostic({
          code: 'target-existing-reshade-installation',
          pid: 4257,
          targetExecutablePath,
          modulePath: hostRuntimePath,
        }) +
        'ReShade injection not started.\n',
      '',
    );

    await assert.rejects(launch, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'existing-reshade-addon-restart-required');
      assert.equal(error.retrySafety, 'definite-safe');
      assert.equal(error.diagnostic.modulePath, hostRuntimePath);
      assert.equal(error.diagnostic.addonPath, prepared.addonDestinationPath);
      assert.match(error.message, /was installed.*must be restarted/);
      return true;
    });
    assert.equal(launcher.state, 'idle');
  } finally {
    launcher.dispose();
    console.error = originalError;
    preparationStub.restore();
    execution.restore();
  }
});

test('path-selected official add-ons publish exact-PID discovery before accepting proof', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const targetExecutablePath =
    'D:\\SteamLibrary\\steamapps\\common\\Official\\game.exe';
  const hostRuntimePath =
    'D:\\SteamLibrary\\steamapps\\common\\Official\\dxgi.dll';
  const addonModulePath =
    'D:\\SteamLibrary\\steamapps\\common\\Official\\electron_game_overlay.addon64';
  const inspectionStub = stubLoadedOfficialReShadeInspection(async () =>
    officialLoadedAddonInspectionResult({
      targetExecutablePath,
      reshadeModulePath: hostRuntimePath,
      loadedAddonModulePath: addonModulePath,
    }),
  );
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      pathContains: '\\steamapps\\',
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    execution.calls[0].callback(
      null,
      `Matched executable path: ${targetExecutablePath}\n` +
        officialAddonSuccessFor(
          4258,
          hostRuntimePath,
          addonModulePath,
          'game.exe',
        ),
      '',
    );
    await waitFor(
      () => sessionHarness.targetAuthorizations.length === 1,
      1_000,
    );
    assert.deepEqual(sessionHarness.targetAuthorizations[0], {
      pid: 4258,
      discoveryPath: path.join(
        runDirectory,
        'electron-overlay-transport-v1.json',
      ),
      expectedExecutablePath: targetExecutablePath,
      releaseCount: 0,
    });
    sessionHarness.emitNative('game.process', {
      pid: 4258,
      path: targetExecutablePath,
    });

    const result = await attachment;
    assert.equal(result.pid, 4258);
    assert.equal(result.runtimeMode, 'official-addon');
    assert.equal(result.selectedPath, targetExecutablePath);
  } finally {
    launcher.dispose();
    console.log = originalLog;
    inspectionStub.restore();
    execution.restore();
  }
});

test('structured injector results reject malformed and contradictory runtime metadata', async (t) => {
  const cases = [
    {
      name: 'malformed JSON',
      stdout: 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT {not-json}\n',
      message: /result record was not valid JSON/,
    },
    {
      name: 'duplicate records',
      stdout:
        injectorResult({ pid: 4262, runtimeMode: 'injected-runtime' }) +
        injectorResult({ pid: 4262, runtimeMode: 'injected-runtime' }),
      message: /expected one result record, received 2/,
    },
    {
      name: 'injected runtime with host-only fields',
      stdout: injectorResult({
        pid: 4262,
        runtimeMode: 'injected-runtime',
        runtimeModulePath: 'C:\\game\\dxgi.dll',
        hostAbi: 1,
      }),
      message: /contradictory or unexpected fields/,
    },
    {
      name: 'existing runtime without module path',
      stdout: injectorResult({
        pid: 4262,
        runtimeMode: 'existing-runtime',
        hostAbi: 1,
      }),
      message: /absolute runtime module path and host ABI 1/,
    },
    {
      name: 'existing runtime with relative module path',
      stdout: injectorResult({
        pid: 4262,
        runtimeMode: 'existing-runtime',
        runtimeModulePath: 'dxgi.dll',
        hostAbi: 1,
      }),
      message: /absolute runtime module path and host ABI 1/,
    },
    {
      name: 'existing runtime with incompatible host ABI',
      stdout: injectorResult({
        pid: 4262,
        runtimeMode: 'existing-runtime',
        runtimeModulePath: 'C:\\game\\dxgi.dll',
        hostAbi: 2,
      }),
      message: /absolute runtime module path and host ABI 1/,
    },
    {
      name: 'official add-on without add-on module path',
      stdout: injectorResult({
        pid: 4262,
        runtimeMode: 'official-addon',
        runtimeModulePath: 'C:\\game\\dxgi.dll',
        addonAbi: 1,
      }),
      message: /absolute runtime and add-on module paths and add-on ABI 1/,
    },
    {
      name: 'official add-on with relative add-on module path',
      stdout: injectorResult({
        pid: 4262,
        runtimeMode: 'official-addon',
        runtimeModulePath: 'C:\\game\\dxgi.dll',
        addonModulePath: 'electron_game_overlay.addon64',
        addonAbi: 1,
      }),
      message: /absolute runtime and add-on module paths and add-on ABI 1/,
    },
    {
      name: 'official add-on with incompatible add-on ABI',
      stdout: injectorResult({
        pid: 4262,
        runtimeMode: 'official-addon',
        runtimeModulePath: 'C:\\game\\dxgi.dll',
        addonModulePath: 'C:\\game\\electron_game_overlay.addon64',
        addonAbi: 2,
      }),
      message: /absolute runtime and add-on module paths and add-on ABI 1/,
    },
    {
      name: 'official add-on with a stale build identity',
      stdout: injectorResult({
        pid: 4262,
        runtimeMode: 'official-addon',
        runtimeModulePath: 'C:\\game\\dxgi.dll',
        addonModulePath: 'C:\\game\\electron_game_overlay.addon64',
        addonAbi: 1,
        addonBuildId: '00000000000000000000000000000000',
        reshadeBasePath: 'C:\\game',
        addonDirectoryPath: 'C:\\game',
        electronGameOverlayAddonDisabled: false,
      }),
      message: /absolute runtime and add-on module paths and add-on ABI 1/,
    },
    {
      name: 'unexpected schema field',
      stdout: injectorResult({
        pid: 4262,
        runtimeMode: 'injected-runtime',
        extra: true,
      }),
      message: /contradictory or unexpected fields/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = createRuntime();
      const execution = stubExecFile();
      const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
      const originalError = console.error;
      console.error = () => undefined;
      try {
        const request = launchReShadeOverlay(launcher, {
          processName: 'game.exe',
          pid: 4262,
        });
        await waitFor(() => execution.calls.length === 1);
        execution.calls[0].callback(null, scenario.stdout, '');
        await assert.rejects(request, scenario.message);
        assert.equal(launcher.state, 'blocked');
      } finally {
        launcher.dispose();
        console.error = originalError;
        execution.restore();
      }
    });
  }
});

test('prepare stages once without injection and the next launch consumes that exact runtime', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const staging = delayRuntimeStaging(fixture.runsRootDirectory);
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    const firstPreparation = launcher.prepare();
    const secondPreparation = launcher.prepare();
    await staging.entered;
    assert.equal(execution.calls.length, 0);

    staging.release();
    await Promise.all([firstPreparation, secondPreparation]);
    assert.equal(execution.calls.length, 0);

    const preparedDirectories = await fsPromises.readdir(
      fixture.runsRootDirectory,
    );
    assert.equal(preparedDirectories.length, 1);
    assert.match(preparedDirectories[0], /^prepared-/);
    const preparedDirectory = path.join(
      fixture.runsRootDirectory,
      preparedDirectories[0],
    );

    const request = launchReShadeOverlay(launcher, {
      processName: 'Gun Frog.exe',
      pid: 4242,
    });
    await waitFor(() => execution.calls.length === 1);
    assert.equal(execution.calls[0].options.cwd, preparedDirectory);
    assert.equal(
      execution.calls[0].executable,
      path.join(preparedDirectory, 'inject.exe'),
    );

    execution.calls[0].callback(null, injectorSuccess, '');
    const result = await request;
    assert.equal(result.runDirectory, preparedDirectory);
  } finally {
    staging.release();
    staging.restore();
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('prepare prunes reclaimable runs older than seven days and beyond the newest 64', async () => {
  const fixture = createRuntime();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  const originalWarn = console.warn;
  const now = Date.now();
  const countLimitedRuns = Array.from({ length: 66 }, (_, index) =>
    createRetainedRun(
      fixture,
      `count-limited-${String(index).padStart(2, '0')}`,
      {
        createdAt: now - (index + 2) * 60_000,
        retiredAt: now - (index + 1) * 60_000,
      },
    ),
  );
  const ageLimitedRun = createRetainedRun(fixture, 'age-limited', {
    createdAt: now - runRetentionMaxAgeMs - 120_000,
    retiredAt: now - runRetentionMaxAgeMs - 60_000,
  });
  console.log = () => undefined;
  console.warn = () => undefined;

  try {
    await launcher.prepare();

    await waitFor(() => !existsSync(ageLimitedRun));
    assert.equal(existsSync(ageLimitedRun), false);
    await waitFor(() => !existsSync(countLimitedRuns.at(-1)));
    for (const [index, runDirectory] of countLimitedRuns.entries()) {
      assert.equal(
        existsSync(runDirectory),
        index < 64,
        `count-limited run ${index} should ${
          index < 64 ? 'be retained' : 'be pruned'
        }`,
      );
    }

    const preparedDirectories = readdirSync(fixture.runsRootDirectory).filter(
      (entry) => entry.startsWith('prepared-'),
    );
    assert.equal(preparedDirectories.length, 1);
  } finally {
    launcher.dispose();
    console.log = originalLog;
    console.warn = originalWarn;
  }
});

test('retention preserves unmarked, malformed, non-reclaimable, and prepared runs', async () => {
  const fixture = createRuntime();
  const preparedLauncher = new ReShadeOverlayLauncher(createConfig(fixture));
  const sweepLauncher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  const originalWarn = console.warn;
  const oldTimestamp = Date.now() - runRetentionMaxAgeMs - 60_000;
  console.log = () => undefined;
  console.warn = () => undefined;

  try {
    await preparedLauncher.prepare();
    const preparedDirectoryName = readdirSync(fixture.runsRootDirectory).find(
      (entry) => entry.startsWith('prepared-'),
    );
    assert.ok(preparedDirectoryName);
    const preparedDirectory = path.join(
      fixture.runsRootDirectory,
      preparedDirectoryName,
    );
    assert.equal(
      existsSync(path.join(preparedDirectory, runOwnershipMarkerFileName)),
      true,
    );
    assert.equal(
      existsSync(path.join(preparedDirectory, runReclaimableMarkerFileName)),
      false,
    );

    const unmarkedDirectory = path.join(
      fixture.runsRootDirectory,
      'foreign-unmarked',
    );
    mkdirSync(unmarkedDirectory);

    const malformedDirectory = createRetainedRun(
      fixture,
      'malformed-reclaimable',
      {
        createdAt: oldTimestamp - 60_000,
        retiredAt: oldTimestamp,
      },
    );
    writeFileSync(
      path.join(malformedDirectory, runReclaimableMarkerFileName),
      '{not-json',
    );

    const nonReclaimableDirectory = createRetainedRun(
      fixture,
      'ownership-only',
      {
        createdAt: oldTimestamp,
      },
    );
    const mismatchedDirectory = createRetainedRun(
      fixture,
      'mismatched-markers',
      {
        createdAt: oldTimestamp - 60_000,
        retiredAt: oldTimestamp,
        reclaimableRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      },
    );
    const eligibleControlDirectory = createRetainedRun(
      fixture,
      'eligible-control',
      {
        createdAt: oldTimestamp - 60_000,
        retiredAt: oldTimestamp,
      },
    );

    await sweepLauncher.prepare();

    await waitFor(() => !existsSync(eligibleControlDirectory));
    assert.equal(existsSync(eligibleControlDirectory), false);
    for (const preservedDirectory of [
      preparedDirectory,
      unmarkedDirectory,
      malformedDirectory,
      nonReclaimableDirectory,
      mismatchedDirectory,
    ]) {
      assert.equal(
        existsSync(preservedDirectory),
        true,
        `${path.basename(preservedDirectory)} should be preserved`,
      );
    }
  } finally {
    preparedLauncher.dispose();
    sweepLauncher.dispose();
    console.log = originalLog;
    console.warn = originalWarn;
  }
});

test('dispose removes successful and in-flight unused prepared runtimes', async (t) => {
  await t.test('successful preparation', async () => {
    const fixture = createRuntime();
    const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
    const originalLog = console.log;
    console.log = () => undefined;

    try {
      await launcher.prepare();
      const preparedDirectories = await fsPromises.readdir(
        fixture.runsRootDirectory,
      );
      assert.equal(preparedDirectories.length, 1);
      const preparedDirectory = path.join(
        fixture.runsRootDirectory,
        preparedDirectories[0],
      );

      launcher.dispose();
      await waitFor(() => !existsSync(preparedDirectory));
    } finally {
      launcher.dispose();
      console.log = originalLog;
    }
  });

  await t.test('in-flight preparation', async () => {
    const fixture = createRuntime();
    const staging = delayRuntimeStaging(fixture.runsRootDirectory);
    const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
    const originalLog = console.log;
    console.log = () => undefined;

    try {
      const preparation = launcher.prepare();
      await staging.entered;
      launcher.dispose();
      staging.release();
      await preparation;
      await staging.finished;
      await waitFor(() => readdirSync(fixture.runsRootDirectory).length === 0);
    } finally {
      staging.release();
      staging.restore();
      launcher.dispose();
      console.log = originalLog;
    }
  });
});

test('a failed preparation waits for sibling staging before cleanup and can be retried', async () => {
  const fixture = createRuntime();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalCopyFile = fsPromises.copyFile;
  const originalLink = fsPromises.link;
  const originalLog = console.log;
  const siblingCopyEntered = deferred();
  const releaseSiblingCopy = deferred();
  console.log = () => undefined;
  fsPromises.copyFile = async (sourcePath, destinationPath) => {
    const fileName = path.basename(destinationPath);
    if (fileName === 'ReShade.ini') {
      throw new Error('synthetic staging failure');
    }
    if (fileName === 'ReShade64.dll') {
      siblingCopyEntered.resolve();
      await releaseSiblingCopy.promise;
    }
    return originalCopyFile(sourcePath, destinationPath);
  };
  fsPromises.link = async (sourcePath, destinationPath) => {
    return originalLink(sourcePath, destinationPath);
  };

  try {
    const preparation = launcher.prepare();
    await siblingCopyEntered.promise;
    assert.equal(
      (await settleWithin(preparation, 20)).status,
      'timeout',
      'cleanup must wait until every parallel staging operation has settled',
    );

    releaseSiblingCopy.resolve();
    await assert.rejects(preparation, (error) => {
      assert.ok(isReShadeOperationError(error));
      assert.match(error.message, /synthetic staging failure/);
      assert.equal(error.code, 'runtime-staging-failed');
      assert.equal(error.stage, 'runtime-staging');
      assert.equal(error.retrySafety, 'definite-safe');
      return true;
    });
    assert.deepEqual(
      await fsPromises.readdir(fixture.runsRootDirectory),
      [],
      'the partially staged runtime should be removed',
    );

    fsPromises.copyFile = originalCopyFile;
    fsPromises.link = originalLink;
    await launcher.prepare();
    const preparedDirectories = await fsPromises.readdir(
      fixture.runsRootDirectory,
    );
    assert.equal(preparedDirectories.length, 1);
    assert.match(preparedDirectories[0], /^prepared-/);
  } finally {
    releaseSiblingCopy.resolve();
    fsPromises.copyFile = originalCopyFile;
    fsPromises.link = originalLink;
    launcher.dispose();
    console.log = originalLog;
  }
});

test('path watcher is prearmed without an injector timeout and pins the selected Steam process', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const target = {
    pathContains: '\\steamapps\\',
    excludedProcessNames: ['UnityCrashHandler64.exe'],
  };
  const selectedPath =
    'D:\\SteamLibrary\\steamapps\\common\\Gun Frog\\Gun Frog.exe';
  const originalLog = console.log;
  const originalWarn = console.warn;
  const events = [];
  const unsubscribe = launcher.onEvent((event) => events.push(event));
  console.log = () => undefined;
  console.warn = () => undefined;

  try {
    const attachment = launcher.attach(sessionHarness.session, target);
    await waitFor(() => execution.calls.length === 1);
    assert.deepEqual(execution.calls[0].arguments, [
      '--path-contains',
      '\\steamapps\\',
      '--exclude-name',
      'UnityCrashHandler64.exe',
    ]);
    assert.equal(execution.calls[0].options.timeout, 0);
    assert.match(path.basename(execution.calls[0].options.cwd), /^path-watch-/);
    execution.calls[0].emitStdout('ReShade path watcher ar');
    execution.calls[0].emitStdout(Buffer.from('med.\n'));
    execution.calls[0].emitStdout('ReShade path watcher armed.\n');
    const readyEvents = events.filter(
      (event) => event.type === 'injector-watcher-ready',
    );
    assert.equal(readyEvents.length, 1);
    assert.deepEqual(readyEvents[0].invocation.arguments, [
      '--path-contains',
      '\\steamapps\\',
      '--exclude-name',
      'UnityCrashHandler64.exe',
    ]);

    sessionHarness.emitNative('game.process', {
      pid: 9300,
      path: 'C:\\games\\unrelated.exe',
    });
    sessionHarness.emitNative('game.process', {
      pid: 9302,
      path: 'D:\\SteamLibrary\\steamapps\\common\\Gun Frog\\UnityCrashHandler64.exe',
    });
    sessionHarness.emitNative('game.process', {
      pid: 9301,
      path: selectedPath.toUpperCase(),
    });
    assert.equal((await settleWithin(attachment, 20)).status, 'timeout');

    execution.calls[0].callback(
      null,
      pathInjectorSuccessFor(9301, selectedPath),
      '',
    );
    const result = await attachment;
    assert.equal(result.pid, 9301);
    assert.equal(result.injectorTargetPid, 9301);
    assert.equal(result.processName, 'Gun Frog.exe');
    assert.equal(result.selectedPath, selectedPath);
    assert.equal(
      result.targetLabel,
      'path-contains:\\steamapps\\:exclude:unitycrashhandler64.exe',
    );
    assert.equal(launcher.state, 'connected');

    assert.equal(launcher.confirmTargetExited(9302), false);
    assert.equal(launcher.confirmTargetExited(9301), true);
    assert.equal(launcher.confirmTargetExited(9301), false);
    assert.equal(launcher.state, 'idle');
    await waitFor(() =>
      existsSync(path.join(result.runDirectory, runReclaimableMarkerFileName)),
    );
  } finally {
    unsubscribe();
    launcher.dispose();
    console.log = originalLog;
    console.warn = originalWarn;
    execution.restore();
  }
});

test('authoritative process exit retires an attaching exact-PID run before disposal', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
      pid: 9351,
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    assert.equal(launcher.state, 'attaching');
    assert.equal(launcher.confirmTargetExited(9352), false);
    assert.equal(launcher.confirmTargetExited(9351), true);
    assert.equal(execution.calls[0].child.killed, true);
    assert.equal(launcher.state, 'idle');

    launcher.dispose();
    await assert.rejects(attachment, (error) => {
      assert.ok(error instanceof ReShadeOperationError);
      assert.equal(error.code, 'target-disconnected');
      assert.equal(error.retrySafety, 'definite-safe');
      assert.equal(error.diagnostic.pid, 9351);
      return true;
    });
    await waitFor(() =>
      existsSync(path.join(runDirectory, runReclaimableMarkerFileName)),
    );
  } finally {
    launcher.dispose();
    console.log = originalLog;
    execution.restore();
  }
});

test('path watcher pre-mutation proof is retry-safe', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const target = { pathContains: '\\steamapps\\' };
    const failed = launchReShadeOverlay(launcher, target);
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    execution.calls[0].callback(
      Object.assign(new Error('selected process was unsupported'), { code: 1 }),
      'ReShade path watcher armed.\nReShade injection not started.\n',
      '',
    );
    await assert.rejects(failed, /selected process was unsupported/);
    assert.equal(launcher.state, 'idle');
    await waitFor(() =>
      existsSync(path.join(runDirectory, runReclaimableMarkerFileName)),
    );
  } finally {
    launcher.dispose();
    console.error = originalError;
    execution.restore();
  }
});

test('successful low-level path launch opens a PID-pinned bounded proof window', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const selectedPath =
    'D:\\SteamLibrary\\steamapps\\common\\Gun Frog\\Gun Frog.exe';
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const proofTimerHandle = Object.freeze({ pathProofTimer: true });
  let proofTimerCallback;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 10_000 && proofTimerCallback === undefined) {
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
    const request = launchReShadeOverlay(launcher, {
      pathContains: '\\steamapps\\',
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      null,
      pathInjectorSuccessFor(9401, selectedPath),
      '',
    );
    const result = await request;

    assert.equal(result.injectorTargetPid, 9401);
    assert.equal(typeof proofTimerCallback, 'function');
    assert.equal(acceptReShadeTargetConnection(launcher, 9402), false);
    assert.equal(acceptReShadeTargetConnection(launcher, 9401), true);
    assert.equal(launcher.state, 'connected');
  } finally {
    launcher.dispose();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    execution.restore();
  }
});

test('path-target connection timeout reports the selected injector PID', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const selectedPath =
    'D:\\SteamLibrary\\steamapps\\common\\Gun Frog\\Gun Frog.exe';
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const proofTimerHandle = Object.freeze({ pathProofTimer: true });
  let proofTimerCallback;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 10_000 && proofTimerCallback === undefined) {
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
    const attachment = launcher.attach(sessionHarness.session, {
      pathContains: '\\steamapps\\',
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      null,
      pathInjectorSuccessFor(9403, selectedPath),
      '',
    );
    await waitFor(() => typeof proofTimerCallback === 'function');
    proofTimerCallback();

    await assert.rejects(attachment, (error) => {
      assert.ok(isReShadeOperationError(error));
      assert.equal(error.code, 'runtime-initialization-timeout');
      assert.equal(error.stage, 'runtime-initialization');
      assert.equal(error.retrySafety, 'indeterminate');
      assert.equal(error.diagnostic.pid, 9403);
      assert.equal(error.diagnostic.runtimeStartupCode, 'not-observed');
      assert.equal(
        error.diagnostic.evidence.runtimeStartupPath,
        path.join(launcher.runDirectory, runtimeStartupFileName),
      );
      return true;
    });
    assert.equal(launcher.state, 'blocked');
  } finally {
    launcher.dispose();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
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
    const request = launchReShadeOverlay(launcher, { processName: 'game.exe' });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(null, injectorSuccessFor(4242, 'game.exe'), '');
    await request;
    assert.equal(launcher.state, 'attaching');
    assert.equal(typeof proofTimerCallback, 'function');

    proofTimerCallback();
    assert.equal(launcher.state, 'attaching');
    assert.equal(acceptReShadeTargetConnection(launcher, 4242), false);
    await assert.rejects(
      launchReShadeOverlay(launcher, { processName: 'game.exe' }),
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
    const request = launchReShadeOverlay(launcher, { processName: 'game.exe' });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(
      null,
      'injector returned without proof\n',
      'warning\n',
    );
    await assert.rejects(
      request,
      /did not contain exactly one.*INJECTOR_RESULT/,
    );

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
      launchReShadeOverlay(launcher, { processName: 'game.exe' }),
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

test('legacy success marker without a structured result blocks retries', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const originalError = console.error;
  console.error = () => undefined;
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));

  try {
    const request = launchReShadeOverlay(launcher, { processName: 'game.exe' });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(null, 'Injecting ReShade ... Succeeded!\n', '');
    await assert.rejects(
      request,
      /did not contain exactly one.*INJECTOR_RESULT/,
    );
    assert.equal(launcher.state, 'blocked');
    await assert.rejects(
      launchReShadeOverlay(launcher, { processName: 'game.exe' }),
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
      const request = launchReShadeOverlay(launcher, {
        processName: 'game.exe',
      });
      await waitFor(() => execution.calls.length === 1);
      const callbackError = Object.assign(new Error('late callback failure'), {
        code: 'ETIMEDOUT',
      });
      execution.calls[0].callback(
        callbackError,
        injectorSuccessFor(9001, 'game.exe'),
        '',
      );
      await assert.rejects(
        request,
        /structured success result while the injector process failed/,
      );
      assert.equal(launcher.state, 'blocked');
      await assert.rejects(
        launchReShadeOverlay(launcher, { processName: 'game.exe' }),
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
      const request = launchReShadeOverlay(launcher, {
        processName: 'game.exe',
      });
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
  const events = [];
  const unsubscribe = launcher.onEvent((event) => events.push(event));

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
      pid: 9101,
    });
    await waitFor(() => execution.calls.length === 1);
    execution.calls[0].callback(null, injectorSuccessFor(9101, 'game.exe'), '');
    await waitFor(() =>
      events.some((event) => event.type === 'injector-returned'),
    );
    sessionHarness.close();
    await assert.rejects(attachment, /session closed before.*target connected/);
    assert.equal(launcher.state, 'blocked');
    assert.equal(sessionHarness.targetAuthorizations.length, 1);
    assert.equal(sessionHarness.targetAuthorizations[0].releaseCount, 0);
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
    await assert.rejects(
      launcher.attach(createSessionHarness().session, {
        processName: 'game.exe',
        pid: 9101,
      }),
      /outcome is indeterminate/,
    );
    launcher.dispose();
    assert.equal(sessionHarness.targetAuthorizations[0].releaseCount, 1);
  } finally {
    unsubscribe();
    launcher.dispose();
    execution.restore();
  }
});

test('target authorization failure prevents injection and removes the staged run', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness(Promise.resolve(), async () => {
    throw new Error('synthetic target authorization failure');
  });
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalLog = console.log;
  console.log = () => undefined;

  try {
    await assert.rejects(
      launcher.attach(sessionHarness.session, {
        processName: 'game.exe',
        pid: 9150,
      }),
      /synthetic target authorization failure/,
    );
    assert.equal(execution.calls.length, 0);
    assert.equal(launcher.state, 'idle');
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
    assert.equal(sessionHarness.targetAuthorizations.length, 1);
    assert.deepEqual(await fsPromises.readdir(fixture.runsRootDirectory), []);
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

    await assert.rejects(attachment, (error) => {
      assert.ok(isReShadeOperationError(error));
      assert.match(error.message, /did not connect within/);
      assert.equal(error.code, 'runtime-initialization-timeout');
      assert.equal(error.stage, 'runtime-initialization');
      assert.equal(error.retrySafety, 'indeterminate');
      assert.equal(error.diagnostic.runtimeStartupCode, 'not-observed');
      assert.equal(
        error.diagnostic.evidence.runDirectory,
        launcher.runDirectory,
      );
      assert.equal(
        error.diagnostic.evidence.runtimeStartupPath,
        path.join(launcher.runDirectory, runtimeStartupFileName),
      );
      return true;
    });
    assert.equal(launcher.state, 'blocked');
    assert.equal(sessionHarness.nativeHandlerCount, 0);
    assert.equal(sessionHarness.closeHandlerCount, 0);
    await assert.rejects(
      launchReShadeOverlay(launcher, { processName: 'game.exe' }),
      /outcome is indeterminate/,
    );
  } finally {
    launcher.dispose();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    execution.restore();
  }
});

test('connection timeout accepts every fixed runtime startup code', async (t) => {
  for (const [index, code] of runtimeStartupRecordCodes.entries()) {
    await t.test(code, async () => {
      const pid = 9300 + index;
      const { outcome, runDirectory } = await runRuntimeStartupTimeoutScenario({
        pid,
        record: runtimeStartupRecord(pid, code),
      });

      assert.equal(outcome.status, 'rejected');
      const { error } = outcome;
      assert.ok(isReShadeOperationError(error));
      assert.equal(error.code, 'runtime-initialization-timeout');
      assert.equal(error.stage, 'runtime-initialization');
      assert.equal(error.retrySafety, 'indeterminate');
      assert.equal(error.diagnostic.pid, pid);
      assert.equal(error.diagnostic.runtimeStartupCode, code);
      assert.match(error.message, /did not connect within 120000ms/);
      assert.notEqual(
        error.message,
        `the ReShade target did not connect within 120000ms; ${code}`,
      );
      assert.equal(
        error.diagnostic.evidence.runtimeStartupPath,
        path.join(runDirectory, runtimeStartupFileName),
      );
    });
  }
});

test('connection timeout keeps the selected existing-runtime evidence paths', async () => {
  const pid = 9399;
  const hostRuntimePath = 'D:\\Games\\Gun Frog\\dxgi.dll';
  const { outcome, runDirectory } = await runRuntimeStartupTimeoutScenario({
    pid,
    record: runtimeStartupRecord(pid, 'network-worker-started'),
    injectorStdout: existingRuntimeSuccessFor(pid, hostRuntimePath, 'game.exe'),
  });

  assert.equal(outcome.status, 'rejected');
  const { error } = outcome;
  assert.ok(isReShadeOperationError(error));
  assert.equal(error.diagnostic.runtimeStartupCode, 'network-worker-started');
  assert.equal(
    error.diagnostic.evidence.reshadeLogPath,
    'D:\\Games\\Gun Frog\\ReShade.log',
  );
  assert.equal(
    error.diagnostic.evidence.runtimeStartupPath,
    path.join(runDirectory, runtimeStartupFileName),
  );
});

test('connection timeout rejects untrusted runtime startup records without exposing their contents', async (t) => {
  const secret = 'SECRET_NATIVE_RECORD_TEXT';
  const cases = [
    {
      name: 'missing record',
      record: undefined,
      expectedCode: 'not-observed',
    },
    {
      name: 'malformed JSON',
      record: `{"message":"${secret}"`,
      expectedCode: 'invalid-record',
    },
    {
      name: 'oversized record',
      record: `${secret}${'x'.repeat(257)}`,
      expectedCode: 'invalid-record',
    },
    {
      name: 'non-object record',
      record: JSON.stringify([1, 2, 3, secret]),
      expectedCode: 'invalid-record',
    },
    {
      name: 'extra field',
      record: runtimeStartupRecord(9400, 'bridge-thread-started', {
        message: secret,
      }),
      expectedCode: 'invalid-record',
    },
    {
      name: 'duplicate fixed field',
      record:
        '{"schemaVersion":1,"source":"electron-game-overlay-runtime","pid":9400,"code":"bridge-thread-started","code":"bridge-window-ready"}',
      expectedCode: 'invalid-record',
    },
    {
      name: 'escaped duplicate fixed field',
      record: String.raw`{"schemaVersion":1,"source":"electron-game-overlay-runtime","pid":9400,"code":"bridge-thread-started","co\u0064e":"bridge-window-ready"}`,
      expectedCode: 'invalid-record',
    },
    {
      name: 'wrong schema version',
      record: JSON.stringify({
        schemaVersion: 2,
        source: 'electron-game-overlay-runtime',
        pid: 9400,
        code: 'bridge-thread-started',
      }),
      expectedCode: 'invalid-record',
    },
    {
      name: 'wrong source',
      record: JSON.stringify({
        schemaVersion: 1,
        source: secret,
        pid: 9400,
        code: 'bridge-thread-started',
      }),
      expectedCode: 'invalid-record',
    },
    {
      name: 'unknown code',
      record: runtimeStartupRecord(9400, secret),
      expectedCode: 'invalid-record',
    },
    {
      name: 'zero PID',
      record: runtimeStartupRecord(0, 'bridge-thread-started'),
      expectedCode: 'invalid-record',
    },
    {
      name: 'non-integer PID',
      record: runtimeStartupRecord(9400.5, 'bridge-thread-started'),
      expectedCode: 'invalid-record',
    },
    {
      name: 'PID above uint32',
      record: runtimeStartupRecord(0x1_0000_0000, 'bridge-thread-started'),
      expectedCode: 'invalid-record',
    },
    {
      name: 'different valid PID',
      record: runtimeStartupRecord(9401, 'bridge-thread-started'),
      expectedCode: 'pid-mismatch',
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { outcome } = await runRuntimeStartupTimeoutScenario({
        pid: 9400,
        record: testCase.record,
      });

      assert.equal(outcome.status, 'rejected');
      const { error } = outcome;
      assert.ok(isReShadeOperationError(error));
      assert.equal(error.code, 'runtime-initialization-timeout');
      assert.equal(error.diagnostic.runtimeStartupCode, testCase.expectedCode);
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error.diagnostic).includes(secret), false);
    });
  }
});

test('an authenticated target wins while timeout startup evidence is being read', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalOpen = fsPromises.open;
  const proofTimers = [];
  const startupReadEntered = deferred();
  const releaseStartupRead = deferred();
  const pid = 9500;
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
  fsPromises.open = async (filePath, ...args) => {
    if (path.basename(filePath) === runtimeStartupFileName) {
      startupReadEntered.resolve();
      await releaseStartupRead.promise;
    }
    return originalOpen(filePath, ...args);
  };

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
      pid,
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    writeFileSync(
      path.join(runDirectory, runtimeStartupFileName),
      runtimeStartupRecord(pid, 'bridge-window-ready'),
    );
    execution.calls[0].callback(null, injectorSuccessFor(pid, 'game.exe'), '');
    await waitFor(() =>
      existsSync(path.join(runDirectory, 'inject.stdout.log')),
    );
    await flushMicrotasks();

    proofTimers[0].callback();
    await startupReadEntered.promise;
    sessionHarness.emitNative('game.process', {
      pid,
      path: 'C:\\games\\game.exe',
    });
    releaseStartupRead.resolve();

    const result = await attachment;
    assert.equal(result.pid, pid);
    assert.equal(launcher.state, 'connected');
    await flushMicrotasks();
  } finally {
    releaseStartupRead.resolve();
    fsPromises.open = originalOpen;
    launcher.dispose();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    execution.restore();
  }
});

test('startup observation budget bounds stalled open and read operations and closes their handles', async (t) => {
  for (const stalledOperation of ['open', 'read']) {
    await t.test(stalledOperation, async () => {
      const fixture = createRuntime();
      const execution = stubExecFile();
      const sessionHarness = createSessionHarness();
      const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
      const originalSetTimeout = global.setTimeout;
      const originalClearTimeout = global.clearTimeout;
      const originalOpen = fsPromises.open;
      const proofTimers = [];
      const observationTimers = [];
      const operationEntered = deferred();
      const releaseOperation = deferred();
      const pid = stalledOperation === 'open' ? 9510 : 9511;
      const startupBytes = Buffer.from(
        runtimeStartupRecord(pid, 'bridge-window-ready'),
      );
      let readCount = 0;
      let closeCount = 0;
      const fakeStartupFile = {
        async read(buffer, offset) {
          ++readCount;
          if (stalledOperation === 'read') {
            operationEntered.resolve();
            await releaseOperation.promise;
          }
          startupBytes.copy(buffer, offset);
          return { bytesRead: startupBytes.length, buffer };
        },
        async close() {
          ++closeCount;
        },
      };
      global.setTimeout = (callback, delay, ...args) => {
        if (delay === 120_000) {
          const handle = { callback: () => callback(...args) };
          proofTimers.push(handle);
          return handle;
        }
        if (delay === 250) {
          const handle = { callback: () => callback(...args) };
          observationTimers.push(handle);
          return handle;
        }
        return originalSetTimeout(callback, delay, ...args);
      };
      global.clearTimeout = (handle) => {
        if (
          !proofTimers.includes(handle) &&
          !observationTimers.includes(handle)
        ) {
          originalClearTimeout(handle);
        }
      };
      fsPromises.open = async (filePath, ...args) => {
        if (path.basename(filePath) !== runtimeStartupFileName) {
          return originalOpen(filePath, ...args);
        }
        if (stalledOperation === 'open') {
          operationEntered.resolve();
          await releaseOperation.promise;
        }
        return fakeStartupFile;
      };

      try {
        const attachment = launcher.attach(sessionHarness.session, {
          processName: 'game.exe',
          pid,
        });
        await waitFor(() => execution.calls.length === 1);
        execution.calls[0].callback(
          null,
          injectorSuccessFor(pid, 'game.exe'),
          '',
        );
        await waitFor(() =>
          existsSync(
            path.join(execution.calls[0].options.cwd, 'inject.stdout.log'),
          ),
        );
        await flushMicrotasks();

        proofTimers[0].callback();
        await operationEntered.promise;
        assert.equal(observationTimers.length, 1);
        observationTimers[0].callback();

        const outcome = await settleWithin(attachment, 100);
        assert.equal(outcome.status, 'rejected');
        assert.ok(isReShadeOperationError(outcome.error));
        assert.equal(outcome.error.code, 'runtime-initialization-timeout');
        assert.equal(
          outcome.error.diagnostic.runtimeStartupCode,
          'invalid-record',
        );
        assert.equal(launcher.state, 'blocked');

        if (stalledOperation === 'read') {
          await waitFor(() => closeCount === 1);
        } else {
          assert.equal(closeCount, 0);
        }
        releaseOperation.resolve();
        await waitFor(() => closeCount === 1);
        assert.equal(readCount, stalledOperation === 'read' ? 1 : 0);
      } finally {
        releaseOperation.resolve();
        fsPromises.open = originalOpen;
        launcher.dispose();
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        execution.restore();
      }
    });
  }
});

test('a stale timeout reader cannot block a same-target retry after a definite-safe injector failure', async () => {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalOpen = fsPromises.open;
  const originalError = console.error;
  const originalLog = console.log;
  const proofTimers = [];
  const observationTimers = [];
  const startupReadEntered = deferred();
  const releaseStartupRead = deferred();
  const pid = 9520;
  const startupBytes = Buffer.from(
    runtimeStartupRecord(pid, 'bridge-window-ready'),
  );
  let closeCount = 0;
  const fakeStartupFile = {
    async read(buffer, offset) {
      startupReadEntered.resolve();
      await releaseStartupRead.promise;
      startupBytes.copy(buffer, offset);
      return { bytesRead: startupBytes.length, buffer };
    },
    async close() {
      ++closeCount;
    },
  };
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 120_000) {
      const handle = { callback: () => callback(...args) };
      proofTimers.push(handle);
      return handle;
    }
    if (delay === 250) {
      const handle = { callback: () => callback(...args) };
      observationTimers.push(handle);
      return handle;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.clearTimeout = (handle) => {
    if (!proofTimers.includes(handle) && !observationTimers.includes(handle)) {
      originalClearTimeout(handle);
    }
  };
  fsPromises.open = async (filePath, ...args) =>
    path.basename(filePath) === runtimeStartupFileName
      ? fakeStartupFile
      : originalOpen(filePath, ...args);
  console.error = () => undefined;
  console.log = () => undefined;

  try {
    const firstAttachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
      pid,
    });
    await waitFor(() => execution.calls.length === 1);
    proofTimers[0].callback();
    await startupReadEntered.promise;
    assert.equal(observationTimers.length, 1);

    execution.calls[0].callback(
      new Error('synthetic pre-injection failure'),
      'ReShade injection not started.\n',
      '',
    );
    await assert.rejects(firstAttachment, (error) => {
      assert.ok(isReShadeOperationError(error));
      assert.equal(error.retrySafety, 'definite-safe');
      return true;
    });
    assert.equal(launcher.state, 'idle');

    const retry = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
      pid,
    });
    await waitFor(() => execution.calls.length === 2);
    assert.equal(launcher.state, 'attaching');

    releaseStartupRead.resolve();
    await waitFor(() => closeCount === 1);
    await flushMicrotasks();
    assert.equal(
      launcher.state,
      'attaching',
      'the retired attachment reporter must not block the retry',
    );

    execution.calls[1].callback(null, injectorSuccessFor(pid, 'game.exe'), '');
    sessionHarness.emitNative('game.process', {
      pid,
      path: 'C:\\games\\game.exe',
    });
    const result = await retry;
    assert.equal(result.pid, pid);
    assert.equal(launcher.state, 'connected');
  } finally {
    releaseStartupRead.resolve();
    fsPromises.open = originalOpen;
    launcher.dispose();
    console.error = originalError;
    console.log = originalLog;
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
  const events = [];
  const unsubscribe = launcher.onEvent((event) => events.push(event));

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'Gun Frog.exe',
    });
    const sharedAttachment = launcher.attach(sessionHarness.session, {
      processName: 'Gun Frog.exe',
    });
    assert.equal(sharedAttachment, attachment);
    assert.equal(launcher.state, 'attaching');
    await assert.rejects(
      launchReShadeOverlay(launcher, { processName: 'Gun Frog.exe' }),
      /attachment is already active/,
    );
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
    assert.equal(firstResult.targetLabel, 'process:Gun Frog.exe:pid:4242');
    assert.ok(existsSync(firstResult.runDirectory));
    assert.deepEqual(
      events.find((event) => event.type === 'target-connected'),
      {
        type: 'target-connected',
        targetLabel: 'process:Gun Frog.exe:pid:4242',
        pid: 4242,
        path: 'C:\\games\\GUN FROG.EXE',
      },
    );
    assert.deepEqual(
      events.find((event) => event.type === 'target-rendezvous-authorized'),
      {
        type: 'target-rendezvous-authorized',
        targetLabel: 'process:Gun Frog.exe:pid:4242',
        pid: 4242,
        discoveryPath: path.join(
          firstResult.runDirectory,
          'electron-overlay-transport-v1.json',
        ),
      },
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
    assert.deepEqual(
      events.find((event) => event.type === 'target-disconnected'),
      {
        type: 'target-disconnected',
        targetLabel: 'process:Gun Frog.exe:pid:4242',
        pid: 4242,
        path: 'C:\\games\\GUN FROG.EXE',
      },
    );
  } finally {
    unsubscribe();
    launcher.dispose();
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
    assert.equal(sessionHarness.targetAuthorizations.length, 1);
    assert.equal(sessionHarness.targetAuthorizations[0].pid, 7301);
    assert.equal(
      sessionHarness.targetAuthorizations[0].discoveryPath,
      path.join(
        execution.calls[0].options.cwd,
        'electron-overlay-transport-v1.json',
      ),
    );
    assert.equal(sessionHarness.targetAuthorizations[0].releaseCount, 0);
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
    assert.equal(sessionHarness.targetAuthorizations[0].releaseCount, 0);
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
    assert.equal(sessionHarness.targetAuthorizations[0].releaseCount, 1);
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
    assert.equal(
      (await settleWithin(attachment, 20)).status,
      'timeout',
      'PID reuse must not bypass the requested executable identity',
    );
    sessionHarness.emitNative('game.process', {
      pid: 8201,
      path: 'C:\\games\\game.exe',
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
    await assert.rejects(failedAttachment, (error) => {
      assert.ok(isReShadeOperationError(error));
      assert.match(error.message, /injector did not spawn/);
      assert.equal(error.code, 'injector-start-failed');
      assert.equal(error.stage, 'injector');
      assert.equal(error.retrySafety, 'definite-safe');
      return true;
    });
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
          launchReShadeOverlay(launcher, { processName: 'game.exe' }),
          /launcher is disposed/,
        );
      } else {
        assert.equal(launcher.state, 'blocked');
        await assert.rejects(
          launchReShadeOverlay(launcher, { processName: 'game.exe' }),
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
  const events = [];
  const unsubscribe = launcher.onEvent((event) => events.push(event));

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
    await waitFor(
      () =>
        events.filter((event) => event.type === 'injector-failed').length === 1,
    );
    const failure = events.find((event) => event.type === 'injector-failed');
    assert.equal(failure.diagnostic.code, 'operation-cancelled');
    assert.equal(failure.diagnostic.stage, 'lifecycle');
    assert.equal(failure.diagnostic.retrySafety, 'indeterminate');
    assert.ok(Object.isFrozen(failure));
    assert.ok(Object.isFrozen(failure.diagnostic));
  } finally {
    unsubscribe();
    launcher.dispose();
    execution.restore();
  }
});

function createRetainedRun(
  fixture,
  directoryName,
  { createdAt, retiredAt, reclaimableRunId } = {},
) {
  const runDirectory = path.join(fixture.runsRootDirectory, directoryName);
  const runId = `00000000-0000-4000-8000-${(++retainedRunSequence)
    .toString(16)
    .padStart(12, '0')}`;
  mkdirSync(runDirectory);
  writeFileSync(
    path.join(runDirectory, runOwnershipMarkerFileName),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'electron-game-overlay-reshade-run',
      runId,
      directoryName,
      createdAt: new Date(createdAt ?? Date.now()).toISOString(),
    }),
  );
  if (retiredAt !== undefined) {
    writeFileSync(
      path.join(runDirectory, runReclaimableMarkerFileName),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'electron-game-overlay-reshade-run-reclaimable',
        runId: reclaimableRunId ?? runId,
        directoryName,
        retiredAt: new Date(retiredAt).toISOString(),
      }),
    );
  }
  return runDirectory;
}

function createRuntime() {
  const root = mkdtempSync(path.join(tmpdir(), 'reshade-sdk-launch-'));
  temporaryDirectories.add(root);
  const runtimeDirectory = path.join(root, 'runtime');
  const runsRootDirectory = path.join(root, 'runs');
  mkdirSync(runtimeDirectory, { recursive: true });
  mkdirSync(runsRootDirectory, { recursive: true });
  for (const artifact of artifacts.filter(
    (fileName) =>
      fileName !== 'electron_game_overlay_runtime.build.json' &&
      fileName !== 'electron_game_overlay_runtime32.build.json',
  )) {
    writeFileSync(path.join(runtimeDirectory, artifact), `fixture:${artifact}`);
  }
  writeRuntimePackageBuildStamp(runtimeDirectory, {
    manifestFileName: 'electron_game_overlay_runtime.build.json',
    platform: 'win32-x64',
    managerFileName: 'electron_game_overlay_reshade_manager.exe',
    addonFileName: 'electron_game_overlay.addon64',
    injectorFileName: 'inject.exe',
    runtimeFileName: 'ReShade64.dll',
    buildStampFileName: 'ReShade64.build.json',
  });
  writeRuntimePackageBuildStamp(runtimeDirectory, {
    manifestFileName: 'electron_game_overlay_runtime32.build.json',
    platform: 'win32-ia32',
    managerFileName: 'electron_game_overlay_reshade_manager32.exe',
    addonFileName: 'electron_game_overlay.addon32',
    injectorFileName: 'inject32.exe',
    runtimeFileName: 'ReShade32.dll',
    buildStampFileName: 'ReShade32.build.json',
  });
  return { root, runtimeDirectory, runsRootDirectory };
}

function writeRuntimePackageBuildStamp(runtimeDirectory, spec) {
  const hash = (fileName) =>
    createHash('sha256')
      .update(readFileSync(path.join(runtimeDirectory, fileName)))
      .digest('hex')
      .toUpperCase();
  writeFileSync(
    path.join(runtimeDirectory, spec.manifestFileName),
    JSON.stringify({
      schemaVersion: 2,
      kind: 'electron-game-overlay-runtime-build',
      platform: spec.platform,
      configuration: 'RelWithDebInfo',
      addonBuildId: 'F2A88AD705204DBB8E18D86E7147A13C',
      managerProtocolSchemaVersion: 1,
      managerSourceSha256: 'A'.repeat(64),
      managerSha256: hash(spec.managerFileName),
      addonSha256: hash(spec.addonFileName),
      injectorSha256: hash(spec.injectorFileName),
      reshadeRuntimeSha256: hash(spec.runtimeFileName),
      reshadeConfigSha256: hash('ReShade.ini'),
      reshadeBuildStampSha256: hash(spec.buildStampFileName),
    }),
  );
}

function rewriteRuntimePackageBuildStamp(
  runtimeDirectory,
  manifestFileName,
  rewrite,
) {
  const manifestPath = path.join(runtimeDirectory, manifestFileName);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  rewrite(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

function prependDuplicateRuntimePackageBuildStampKey(
  runtimeDirectory,
  manifestFileName,
  key,
  rawKey = key,
) {
  const manifestPath = path.join(runtimeDirectory, manifestFileName);
  const text = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(text);
  const marker = `"${key}":`;
  const markerIndex = text.indexOf(marker);
  assert.notEqual(markerIndex, -1);
  writeFileSync(
    manifestPath,
    `${text.slice(0, markerIndex)}"${rawKey}":${JSON.stringify(
      manifest[key],
    )},${text.slice(markerIndex)}`,
  );
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

function officialPreparedAddonResult({
  status,
  targetExecutablePath,
  reshadeModulePath,
  reshadeModuleSha256 = 'B'.repeat(64),
}) {
  const addonDirectoryPath = path.win32.dirname(reshadeModulePath);
  return Object.freeze({
    targetExecutablePath,
    reshadeModulePath,
    reshadeModuleSha256,
    status,
    addonSourcePath: 'C:\\sdk\\electron_game_overlay.addon64',
    addonSourceSha256: 'A'.repeat(64),
    reshadeBaseDirectoryPath: addonDirectoryPath,
    reshadeConfigPath: path.win32.join(addonDirectoryPath, 'ReShade.ini'),
    addonDirectoryPath,
    addonDestinationPath: path.win32.join(
      addonDirectoryPath,
      existingReShadeInstallation.existingReShadeAddonFileName,
    ),
    ownershipMarkerPath: path.win32.join(
      addonDirectoryPath,
      existingReShadeInstallation.existingReShadeAddonMarkerFileName,
    ),
    currentProcessLoadState: 'unknown',
    restartRequired: status !== 'disabled-by-user',
  });
}

function officialLoadedAddonInspectionResult({
  targetExecutablePath,
  reshadeModulePath,
  loadedAddonModulePath,
  status = 'already-current',
  reshadeModuleSha256 = 'C'.repeat(64),
}) {
  const addonDirectoryPath = path.win32.dirname(loadedAddonModulePath);
  return Object.freeze({
    status,
    targetExecutablePath,
    reshadeModulePath,
    reshadeModuleSha256,
    loadedAddonModulePath,
    addonSourcePath: 'C:\\sdk\\electron_game_overlay.addon64',
    addonSourceSha256: 'A'.repeat(64),
    addonDirectoryPath,
    addonDestinationPath: path.win32.join(
      addonDirectoryPath,
      existingReShadeInstallation.existingReShadeAddonFileName,
    ),
    ownershipMarkerPath: path.win32.join(
      addonDirectoryPath,
      existingReShadeInstallation.existingReShadeAddonMarkerFileName,
    ),
    restartRequired: status !== 'already-current',
  });
}

function stubExistingReShadePreparation(implementation) {
  const original = existingReShadeInstallation.prepareExistingReShadeAddon;
  existingReShadeInstallation.prepareExistingReShadeAddon = implementation;
  return {
    restore() {
      existingReShadeInstallation.prepareExistingReShadeAddon = original;
    },
  };
}

function stubExistingReShadeRemoval(implementation) {
  const original = existingReShadeInstallation.removeOwnedExistingReShadeAddon;
  existingReShadeInstallation.removeOwnedExistingReShadeAddon = implementation;
  return {
    restore() {
      existingReShadeInstallation.removeOwnedExistingReShadeAddon = original;
    },
  };
}

function stubLoadedOfficialReShadeInspection(implementation) {
  const original =
    existingReShadeInstallation.inspectLoadedOfficialReShadeAddon;
  existingReShadeInstallation.inspectLoadedOfficialReShadeAddon =
    implementation;
  return {
    restore() {
      existingReShadeInstallation.inspectLoadedOfficialReShadeAddon = original;
    },
  };
}

async function runRuntimeStartupTimeoutScenario({
  pid,
  record,
  injectorStdout = injectorSuccessFor(pid, 'game.exe'),
}) {
  const fixture = createRuntime();
  const execution = stubExecFile();
  const sessionHarness = createSessionHarness();
  const launcher = new ReShadeOverlayLauncher(createConfig(fixture));
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalLog = console.log;
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
  console.log = () => undefined;

  try {
    const attachment = launcher.attach(sessionHarness.session, {
      processName: 'game.exe',
      pid,
    });
    await waitFor(() => execution.calls.length === 1);
    const runDirectory = execution.calls[0].options.cwd;
    if (record !== undefined) {
      writeFileSync(path.join(runDirectory, runtimeStartupFileName), record);
    }
    execution.calls[0].callback(null, injectorStdout, '');
    await waitFor(() =>
      existsSync(path.join(runDirectory, 'inject.stdout.log')),
    );
    await flushMicrotasks();
    proofTimers[0].callback();

    const outcome = await settleWithin(attachment, 1_000);
    assert.notEqual(outcome.status, 'timeout');
    assert.equal(launcher.state, 'blocked');
    return { outcome, runDirectory };
  } finally {
    launcher.dispose();
    console.log = originalLog;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    execution.restore();
  }
}

function stubExecFile({ autoSpawn = true } = {}) {
  const originalExecFile = childProcess.execFile;
  const calls = [];

  childProcess.execFile = (executable, args, options, callback) => {
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout,
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
      emitStdout(chunk) {
        stdout.emit('data', chunk);
      },
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
  const originalLink = fsPromises.link;
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
  const recordStagedArtifact = (destinationPath) => {
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
  };
  fsPromises.copyFile = async (sourcePath, destinationPath) => {
    const result = await originalCopyFile(sourcePath, destinationPath);
    recordStagedArtifact(destinationPath);
    return result;
  };
  fsPromises.link = async (sourcePath, destinationPath) => {
    const result = await originalLink(sourcePath, destinationPath);
    recordStagedArtifact(destinationPath);
    return result;
  };

  return {
    entered: entered.promise,
    finished: finished.promise,
    release: release.resolve,
    restore() {
      fsPromises.mkdir = originalMkdir;
      fsPromises.copyFile = originalCopyFile;
      fsPromises.link = originalLink;
    },
  };
}

function delayInjectorEvidenceWrite() {
  const originalWriteFile = fsPromises.writeFile;
  const entered = deferred();
  const release = deferred();
  let intercepted = false;
  fsPromises.writeFile = async (destinationPath, ...args) => {
    if (
      !intercepted &&
      path.basename(destinationPath) === 'inject.stdout.log'
    ) {
      intercepted = true;
      entered.resolve();
      await release.promise;
    }
    return originalWriteFile(destinationPath, ...args);
  };

  return {
    entered: entered.promise,
    release: release.resolve,
    restore() {
      fsPromises.writeFile = originalWriteFile;
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

function createSessionHarness(
  ready = Promise.resolve(),
  authorizeTargetOverride,
) {
  const lifecycleHandlers = new Map();
  const closeHandlers = new Set();
  const targetAuthorizations = [];
  let closed = false;

  return {
    session: {
      whenReady() {
        if (closed) {
          return Promise.reject(new Error('the overlay session is closed'));
        }
        return ready;
      },
      async authorizeTarget(pid, discoveryPath, expectedExecutablePath) {
        if (closed) {
          throw new Error('the overlay session is closed');
        }
        const authorization = {
          pid,
          discoveryPath,
          ...(expectedExecutablePath === undefined
            ? {}
            : { expectedExecutablePath }),
          releaseCount: 0,
        };
        targetAuthorizations.push(authorization);
        const releaseOverride = authorizeTargetOverride
          ? await authorizeTargetOverride(authorization)
          : undefined;
        return () => {
          ++authorization.releaseCount;
          releaseOverride?.();
        };
      },
      on(event, handler) {
        assert.ok(
          [
            'targetConnected',
            'targetTransportLost',
            'targetDisconnected',
          ].includes(event),
        );
        let handlers = lifecycleHandlers.get(event);
        if (!handlers) {
          handlers = new Set();
          lifecycleHandlers.set(event, handlers);
        }
        handlers.add(handler);
        return () => handlers.delete(handler);
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
      const typedEvent = {
        'game.process': 'targetConnected',
        'game.process.transport-lost': 'targetTransportLost',
        'game.process.disconnected': 'targetDisconnected',
      }[event];
      assert.ok(typedEvent, `unexpected lifecycle event ${event}`);
      for (const handler of Array.from(
        lifecycleHandlers.get(typedEvent) ?? [],
      )) {
        handler({
          pid: payload.pid,
          executablePath: payload.path ?? 'C:\\Games\\unknown.exe',
        });
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
      return Array.from(lifecycleHandlers.values()).some(
        (handlers) => handlers.size > 0,
      )
        ? 1
        : 0;
    },
    get closeHandlerCount() {
      return closeHandlers.size;
    },
    get targetAuthorizations() {
      return targetAuthorizations;
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
