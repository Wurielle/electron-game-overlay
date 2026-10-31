const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

test('standalone native attachment module graph never loads Electron', () => {
  const original = Module._load;
  Module._load = function (name, ...args) {
    assert.notEqual(name, 'electron', 'native provider must not load Electron');
    return original.call(this, name, ...args);
  };
  try {
    require('../dist/lib/reshade-launcher.js');
    require('../dist/lib/overlay-broker-native-provider.js');
  } finally {
    Module._load = original;
  }
});

const cp = require('node:child_process');
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createConnection } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const os = require('node:os');
const { OverlayBrokerServer } = require('../dist/lib/overlay-broker-server.js');
const {
  OverlayLoopbackTransport,
  encodeJsonTransportPacket,
} = require('../dist/lib/overlay-loopback-transport.js');
const {
  BrokerPacketDecoder,
  encodeBrokerJsonPacket,
  OVERLAY_BROKER_REQUIRED_CAPABILITIES,
} = require('../dist/lib/overlay-broker-protocol.js');
const PID = 54321;
const EXE = 'C:\\Games\\Cached\\game.exe';
const imageRecord = (pid = PID, executablePath = EXE) =>
  JSON.stringify({
    schemaVersion: 1,
    kind: 'electron-game-overlay-process-image',
    pid,
    executablePath,
  }) + '\n';

test('native image query executes only the explicit absolute manager with bounded PID-only arguments', async (t) => {
  const original = cp.execFile;
  const originalRealpath = fs.realpath.native;
  const manager = path.resolve('controlled-native-manager.exe');
  const calls = [];
  t.after(() => {
    cp.execFile = original;
    fs.realpath.native = originalRealpath;
  });
  fs.realpath.native = () => {
    assert.fail(
      'native query must not resolve SystemRoot or environment authority',
    );
  };
  cp.execFile = (exe, args, options, callback) => {
    calls.push({ exe, args, options });
    queueMicrotask(() => callback(null, imageRecord(), ''));
    return new EventEmitter();
  };
  const {
    resolveOverlayBrokerProcessImage,
  } = require('../dist/lib/overlay-broker-native-provider.js');
  assert.equal(await resolveOverlayBrokerProcessImage(PID, manager), EXE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, manager);
  assert.deepEqual(calls[0].args, ['--query-process-image', String(PID)]);
  assert.equal(calls[0].options.cwd, path.dirname(manager));
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 2000);
  assert.equal(calls[0].options.maxBuffer, 128 * 1024);
  assert.equal(calls[0].options.encoding, 'utf8');
});
test('native image query rejects malformed or mismatched response envelopes without fallback', async (t) => {
  const original = cp.execFile;
  t.after(() => {
    cp.execFile = original;
  });
  const {
    resolveOverlayBrokerProcessImage,
  } = require('../dist/lib/overlay-broker-native-provider.js');
  const valid = JSON.parse(imageRecord());
  for (const output of [
    JSON.stringify({ ...valid, schemaVersion: 2 }),
    JSON.stringify({ ...valid, kind: 'other' }),
    JSON.stringify({ ...valid, pid: PID + 1 }),
    JSON.stringify({ ...valid, pid: String(PID) }),
    JSON.stringify({ ...valid, executablePath: 42 }),
    JSON.stringify({ ...valid, executablePath: 'C:relative.exe' }),
    JSON.stringify({ ...valid, executablePath: '\\game.exe' }),
    JSON.stringify({ ...valid, executablePath: 'C:\\bad\npath.exe' }),
    JSON.stringify({ ...valid, executablePath: 'C:\\' + 'x'.repeat(32768) }),
    'null',
    '[]',
    '{}',
    'not JSON',
    imageRecord() + imageRecord(),
    JSON.stringify(valid, null, 2),
  ]) {
    let calls = 0;
    cp.execFile = (_exe, _args, _opts, callback) => {
      calls++;
      queueMicrotask(() => callback(null, output, ''));
      return new EventEmitter();
    };
    await assert.rejects(
      resolveOverlayBrokerProcessImage(PID, path.resolve('manager.exe')),
    );
    assert.equal(
      calls,
      1,
      'invalid native output must not invoke another probe',
    );
  }
});

test('native image query refuses absent or nonabsolute manager authority before spawning', async (t) => {
  const original = cp.execFile;
  t.after(() => {
    cp.execFile = original;
  });
  let calls = 0;
  cp.execFile = (_exe, _args, _opts, callback) => {
    calls++;
    queueMicrotask(() => callback(null, imageRecord(), ''));
  };
  const {
    resolveOverlayBrokerProcessImage,
  } = require('../dist/lib/overlay-broker-native-provider.js');
  for (const manager of [
    'manager.exe',
    undefined,
    '',
    'C:manager.exe',
    'relative/manager.exe',
  ]) {
    await assert.rejects(
      resolveOverlayBrokerProcessImage(PID, manager),
      /absolute native manager path/,
    );
  }
  assert.equal(calls, 0);
});

test('native image query rejects child errors even with valid stdout and never falls back', async (t) => {
  const original = cp.execFile;
  t.after(() => {
    cp.execFile = original;
  });
  const {
    resolveOverlayBrokerProcessImage,
  } = require('../dist/lib/overlay-broker-native-provider.js');
  for (const error of [
    Object.assign(new Error('nonzero exit'), { code: 1 }),
    Object.assign(new Error('deadline'), { killed: true }),
    Object.assign(new Error('output limit'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    }),
  ]) {
    let calls = 0;
    cp.execFile = (_exe, _args, _opts, callback) => {
      calls++;
      queueMicrotask(() =>
        callback(error, imageRecord(), 'bounded diagnostic'),
      );
      return new EventEmitter();
    };
    await assert.rejects(
      resolveOverlayBrokerProcessImage(PID, path.resolve('manager.exe')),
      (actual) =>
        /Unable to query OS executable identity/.test(actual.message) &&
        actual.cause === error,
    );
    assert.equal(calls, 1);
  }
});

test('structured process identity decoder retains exact creation time above Number precision', async (t) => {
  const original = cp.execFile;
  t.after(() => { cp.execFile = original; });
  const creationTime100ns = '9007199254740993';
  cp.execFile = (_exe, _args, _opts, callback) => {
    queueMicrotask(() => callback(null, JSON.stringify({
      ...JSON.parse(imageRecord()), creationTime100ns,
    }) + '\n', ''));
    return new EventEmitter();
  };
  const { resolveOverlayBrokerProcessIdentity } = require('../dist/lib/overlay-broker-native-provider.js');
  assert.deepEqual(await resolveOverlayBrokerProcessIdentity(PID, path.resolve('manager.exe')), {
    pid: PID, executablePath: EXE, creationTime100ns,
  });
});

test('structured identity rejects malformed present canonical uint64 creation times in both APIs', async (t) => {
  const original = cp.execFile;
  t.after(() => { cp.execFile = original; });
  const api = require('../dist/lib/overlay-broker-native-provider.js');
  for (const value of [null, 0, 1, 9007199254740992, '', '0', '01', '+1', '-1', ' 1', '1 ', '1\n', '1.0', '1e3', '18446744073709551616', '999999999999999999999']) {
    for (const query of [api.resolveOverlayBrokerProcessIdentity, api.resolveOverlayBrokerProcessImage]) {
      let calls = 0;
      cp.execFile = (_exe, _args, _opts, callback) => {
        calls++;
        queueMicrotask(() => callback(null, JSON.stringify({ ...JSON.parse(imageRecord()), creationTime100ns: value }), ''));
        return new EventEmitter();
      };
      await assert.rejects(query(PID, path.resolve('manager.exe')), /identity unavailable/, `creationTime100ns=${JSON.stringify(value)}`);
      assert.equal(calls, 1);
    }
  }
});

test('structured identity preserves legacy absence and exact canonical uint64 boundaries with one child per API', async (t) => {
  const original = cp.execFile;
  t.after(() => { cp.execFile = original; });
  const api = require('../dist/lib/overlay-broker-native-provider.js');
  for (const creationTime100ns of [undefined, '1', '9007199254740993', '18446744073709551615']) {
    const expected = { pid: PID, executablePath: EXE, ...(creationTime100ns === undefined ? {} : { creationTime100ns }) };
    const calls = [];
    cp.execFile = (exe, args, options, callback) => {
      calls.push({ exe, args, options });
      queueMicrotask(() => callback(null, JSON.stringify({ ...JSON.parse(imageRecord()), ...expected }) + '\r\n', ''));
      return new EventEmitter();
    };
    assert.deepEqual(await api.resolveOverlayBrokerProcessIdentity(PID, path.resolve('manager.exe')), expected);
    assert.equal(calls.length, 1);
    assert.equal(await api.resolveOverlayBrokerProcessImage(PID, path.resolve('manager.exe')), EXE);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.options.shell, false);
      assert.equal(call.options.timeout, 2000);
      assert.equal(call.options.maxBuffer, 128 * 1024);
      assert.equal(call.options.cwd, path.dirname(path.resolve('manager.exe')));
      assert.deepEqual(call.args, ['--query-process-image', String(PID)]);
    }
  }
});

test('structured query preserves PID and absolute-root authority guards, protocol bounds and child failures', async (t) => {
  const original = cp.execFile;
  const originalRealpath = fs.realpath.native;
  t.after(() => { cp.execFile = original; fs.realpath.native = originalRealpath; });
  const { resolveOverlayBrokerProcessIdentity: query } = require('../dist/lib/overlay-broker-native-provider.js');
  let calls = 0;
  cp.execFile = () => { calls++; assert.fail('invalid authority must not spawn'); };
  fs.realpath.native = () => assert.fail('must not use OS/environment fallback authority');
  for (const manager of [undefined, '', 'manager.exe', 'C:manager.exe', 'relative/manager.exe'])
    await assert.rejects(query(PID, manager), /absolute native manager path/);
  for (const pid of [0, -1, 1.5, NaN, Infinity, 0x100000000, '54321'])
    await assert.rejects(query(pid, path.resolve('manager.exe')), /positive uint32/);
  assert.equal(calls, 0);
  for (const output of ['null', '[]', '{}', 'not JSON', imageRecord() + imageRecord(), JSON.stringify(JSON.parse(imageRecord()), null, 2),
    JSON.stringify({ ...JSON.parse(imageRecord()), pid: PID + 1 }),
    JSON.stringify({ ...JSON.parse(imageRecord()), schemaVersion: 2 }),
    JSON.stringify({ ...JSON.parse(imageRecord()), executablePath: '\\game.exe' }),
    JSON.stringify({ ...JSON.parse(imageRecord()), executablePath: 'C:\\' + 'x'.repeat(32768) })]) {
    let count = 0;
    cp.execFile = (_exe, _args, _opts, cb) => { count++; queueMicrotask(() => cb(null, output, '')); return new EventEmitter(); };
    await assert.rejects(query(PID, path.resolve('manager.exe')), /identity unavailable/);
    assert.equal(count, 1);
  }
  for (const error of [Object.assign(new Error('exit'), { code: 1 }), Object.assign(new Error('timeout'), { killed: true }), Object.assign(new Error('output'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })]) {
    let count = 0;
    cp.execFile = (_exe, _args, _opts, cb) => { count++; queueMicrotask(() => cb(error, imageRecord(), '')); return new EventEmitter(); };
    await assert.rejects(query(PID, path.resolve('manager.exe')), actual => actual.cause === error);
    assert.equal(count, 1);
  }
});

const wait = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      'timed out waiting for real broker/native boundary',
    );
    await new Promise((r) => setTimeout(r, 5));
  }
};
function runtime(root, generation) {
  const directory = path.join(root, 'runtime', 'win32-x64', 'reshade');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'ReShade.ini'), '[GENERAL]\n');
  for (const bits of [64, 32]) {
    const files = {
      managerSha256: `electron_game_overlay_reshade_manager${bits === 64 ? '' : '32'}.exe`,
      addonSha256: `electron_game_overlay.addon${bits}`,
      injectorSha256: `inject${bits === 64 ? '' : '32'}.exe`,
      reshadeRuntimeSha256: `ReShade${bits}.dll`,
      reshadeBuildStampSha256: `ReShade${bits}.build.json`,
    };
    for (const file of Object.values(files))
      fs.writeFileSync(
        path.join(directory, file),
        `controlled-native-boundary:g${generation}:${file}`,
      );
    const hash = (file) =>
      createHash('sha256')
        .update(fs.readFileSync(path.join(directory, file)))
        .digest('hex')
        .toUpperCase();
    fs.writeFileSync(
      path.join(
        directory,
        `electron_game_overlay_runtime${bits === 64 ? '' : '32'}.build.json`,
      ),
      JSON.stringify({
        schemaVersion: 3,
        kind: 'electron-game-overlay-runtime-build',
        platform: bits === 64 ? 'win32-x64' : 'win32-ia32',
        configuration: 'RelWithDebInfo',
        addonBuildId: '12EE788081A34E00B10862242DF38893',
        managerProtocolSchemaVersion: 1,
        managerSourceSha256: 'A'.repeat(64),
        runtimeGeneration: generation,
        targetTransportMin: 1,
        targetTransportMax: 1,
        ...Object.fromEntries(
          Object.entries(files).map(([key, file]) => [key, hash(file)]),
        ),
        reshadeConfigSha256: hash('ReShade.ini'),
      }),
    );
  }
  return directory;
}
async function fixture(t, generation = 7, options = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ego-native-provider-'));
  const directory = runtime(root, generation);
  const originalUserInfo = os.userInfo;
  os.userInfo = (...args) => ({ ...originalUserInfo(...args), homedir: root });
  const diagnostics = [];
  const {
    prepareStandaloneOverlayNativeProvider,
  } = require('../dist/lib/overlay-broker-native-provider.js');
  let bundleRoot = root;
  async function prepareProvider() {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const prepared = await prepareStandaloneOverlayNativeProvider({
        executablePath: path.join(bundleRoot, 'broker.exe'),
        runsRootDirectory: path.join(root, 'runs'),
        onDiagnostic: (d) => diagnostics.push(d),
      });
      assert.ok(prepared, JSON.stringify(diagnostics));
      return prepared;
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  }
  let provider = await prepareProvider();
  const calls = [];
  const imageQueries = [];
  const sockets = [];
  let transport;
  const original = cp.execFile;
  const originalRealpath = fs.realpath.native;
  fs.realpath.native = () =>
    assert.fail('native query must not resolve OS/environment paths');
  cp.execFile = (exe, args, opts, callback) => {
    if (args[0] === '--query-process-image') {
      assert.equal(
        exe,
        path.join(
          bundleRoot,
          'runtime',
          'win32-x64',
          'reshade',
          'electron_game_overlay_reshade_manager.exe',
        ),
      );
      assert.deepEqual(args, ['--query-process-image', String(PID)]);
      imageQueries.push({ exe, args, opts });
      if (options.queryHook) {
        options.queryHook(callback);
        return new EventEmitter();
      }
      queueMicrotask(() =>
        callback(
          options.processImageError ?? null,
          imageRecord(PID, options.processImage ?? EXE),
          '',
        ),
      );
      return new EventEmitter();
    }
    calls.push({ exe, args, opts, callback });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      exitCode: null,
      signalCode: null,
      kill() {
        return true;
      },
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const pipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ego-native-${randomUUID()}`
      : path.join(root, 'broker.sock');
  let alive = true;
  const brokerOptions = {
    pipePath,
    idleShutdownMs: false,
    nativeRuntimeProvider: provider,
    runtimeProviderElectionWindowMs: 50,
    isProcessAlive: () => alive,
    processExitPollIntervalMs: 5,

    targetTransportFactory(pid) {
      transport = new OverlayLoopbackTransport({
        discoveryPath: path.join(root, 'host.json'),
        isProcessAlive: () => alive,
        ...options.transportOptions,
      });
      return transport;
    },
    ...options.serverOptions,
  };
  let server = new OverlayBrokerServer(brokerOptions);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await server.stop();
    provider?.dispose();
    cp.execFile = original;
    fs.realpath.native = originalRealpath;
    require('../dist/lib/overlay-loopback-transport.js').clearOverlayTargetRecoveryClaimForExitedPid(
      PID,
    );
    os.userInfo = originalUserInfo;
    await new Promise((r) => setTimeout(r, 30));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await server.start();
  async function client(extensions = {}) {
    const socket = createConnection(pipePath);
    sockets.push(socket);
    const messages = [];
    const decoder = new BrokerPacketDecoder();
    socket.on('data', (data) => {
      for (const packet of decoder.push(data)) messages.push(packet.value);
    });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const send = (message) => socket.write(encodeBrokerJsonPacket(message));
    send({
      type: 'broker.hello',
      protocolMin: 1,
      protocolMax: 1,
      requiredCapabilities: OVERLAY_BROKER_REQUIRED_CAPABILITIES,
      clientPid: process.pid,
      sdkVersion: '1.0.0',
    });
    await wait(() => messages.some((m) => m.type === 'broker.welcome'));
    const requestId = randomUUID();
    send({
      type: 'broker.target.authorize',
      requestId,
      pid: PID,
      discoveryPath: path.join(
        root,
        randomUUID(),
        'electron-overlay-transport-v1.json',
      ),
      expectedExecutablePath: EXE,
      ...extensions,
    });
    return { socket, messages, send, requestId };
  }
  async function authenticate(discoveryPath) {
    const record = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
    const socket = createConnection({ host: '127.0.0.1', port: record.port });
    sockets.push(socket);
    socket.on('data', () => {});
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      encodeJsonTransportPacket({
        type: 'game.process',
        protocolVersion: 1,
        token: record.token,
        pid: PID,
        path: EXE,
      }),
    );
    return socket;
  }
  async function finishNative() {
    await wait(() => calls.length === 1);
    const call = calls[0];
    const record = path.join(
      call.opts.cwd,
      'electron-overlay-transport-v1.json',
    );
    const targetSocket = await authenticate(record);
    call.callback(
      null,
      'Injecting ReShade ... Succeeded!\nELECTRON_GAME_OVERLAY_INJECTOR_RESULT ' +
        JSON.stringify({
          schemaVersion: 1,
          pid: PID,
          targetExecutablePath: EXE,
          runtimeMode: 'injected-runtime',
        }) +
        '\n',
      '',
    );
    return targetSocket;
  }
  return {
    root,
    directory,
    get server() {
      return server;
    },
    get provider() {
      return provider;
    },
    relocate() {
      bundleRoot = path.join(root, 'relocated-bundle');
      fs.cpSync(path.join(root, 'runtime'), path.join(bundleRoot, 'runtime'), {
        recursive: true,
      });
    },
    diagnostics,
    calls,
    imageQueries,
    client,
    authenticate,
    finishNative,
    transport: () => transport,
    exit: () => {
      alive = false;
    },
    async restart() {
      await server.stop();
      provider = await prepareProvider();
      server = new OverlayBrokerServer({
        ...brokerOptions,
        nativeRuntimeProvider: provider,
      });
      await server.start();
    },
  };
}

test('broker-owned process query exists before election and uses its validated manager after live runtime wins', async (t) => {
  const f = await fixture(t, 7, {
    queryHook(callback) {
      queueMicrotask(() => callback(null, JSON.stringify({
        ...JSON.parse(imageRecord()), creationTime100ns: '18446744073709551615',
      }) + '\n', ''));
    },
  });
  assert.equal(typeof f.provider.queryProcessIdentity, 'function');
  const expected = { pid: PID, executablePath: EXE, creationTime100ns: '18446744073709551615' };
  assert.deepEqual(await f.provider.queryProcessIdentity(PID), expected);
  assert.equal(f.server.targets.size, 0, 'query must not allocate a target adapter');
  assert.equal(f.calls.length, 0);
  const app = await f.client({ runtimeGeneration: 99, targetTransportMin: 1, targetTransportMax: 1 });
  await wait(() => app.messages.some(m => m.type === 'broker.target.authorized'));
  assert.equal(app.messages.find(m => m.type === 'broker.target.authorized').disposition, 'injection-owner');
  const before = f.imageQueries.length;
  assert.deepEqual(await f.provider.queryProcessIdentity(PID), expected);
  assert.equal(f.imageQueries.length, before + 1);
  assert.equal(f.calls.length, 0);
});

test('validated installed runtime beats first raw-v1 app while source app is unavailable', async (t) => {
  const f = await fixture(t);
  const old = await f.client();
  await f.finishNative();
  await wait(() =>
    old.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  assert.equal(
    old.messages.find((m) => m.type === 'broker.target.authorized').disposition,
    'joined-existing',
  );
  assert.match(
    fs.readFileSync(f.calls[0].exe, 'utf8'),
    /controlled-native-boundary:g7:/,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.imageQueries.length, 1, 'cached preparation and initial publication share one identity sample');
  assert.deepEqual(await f.provider.queryProcessIdentity(PID), { pid: PID, executablePath: EXE });
  assert.equal(f.imageQueries.length, 2, 'a later recovery query must sample afresh');
  assert.equal(fs.existsSync(path.join(f.root, 'supplying-app.exe')), false);
});

test('cached provider rejects the sole wrong executable before publication or native execution', async (t) => {
  const publications = [];
  const f = await fixture(t, 7, {
    transportOptions: {
      targetAuthorizationPublicationHook: (phase) => publications.push(phase),
    },
  });
  const app = await f.client({
    expectedExecutablePath: 'C:\\OtherGame\\OtherGame.exe',
  });
  await wait(
    () =>
      f.calls.length > 0 || app.messages.some((m) => m.type === 'broker.error'),
  );
  assert.equal(
    f.calls.length,
    0,
    'no requester accepts the authoritative OS image',
  );
  await wait(() => app.messages.some((m) => m.type === 'broker.error'));
  const errors = app.messages.filter((m) => m.type === 'broker.error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].requestId, app.requestId);
  assert.equal(errors[0].pid, PID);
  assert.equal(errors[0].code, 'target-authorization-failed');
  assert.match(errors[0].message, /does not match/);
  assert.ok(Buffer.byteLength(errors[0].message) < 2048);
  assert.equal(
    app.messages.some((m) => m.type === 'broker.target.authorized'),
    false,
  );
  assert.equal(
    require('../dist/lib/overlay-loopback-transport.js').readOverlayTargetRecoveryClaim(
      PID,
    ),
    undefined,
  );
  await wait(() => f.server.targets.size === 0);
  await wait(() => fs.readdirSync(path.join(f.root, 'runs')).length === 0);
  assert.deepEqual(
    publications,
    [],
    'no target publication transaction may begin',
  );
});

for (const expectedExecutablePath of [EXE, undefined]) {
  test(`cached provider isolates wrong first requester from later ${expectedExecutablePath ? 'correct-path' : 'PID-only'} requester`, async (t) => {
    let finishQuery;
    const f = await fixture(t, 7, {
      queryHook: (callback) => {
        finishQuery = callback;
      },
    });
    const wrong = await f.client({
      expectedExecutablePath: 'C:\\OtherGame\\OtherGame.exe',
    });
    await wait(() => finishQuery);
    const accepting = await f.client({ expectedExecutablePath });
    await wait(() => f.server.targets.get(PID).members.size === 3);
    finishQuery(null, imageRecord(), '');
    await wait(() => f.calls.length === 1);
    await wait(() => wrong.messages.some((m) => m.type === 'broker.error'));
    const errors = wrong.messages.filter((m) => m.type === 'broker.error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].requestId, wrong.requestId);
    assert.equal(errors[0].pid, PID);
    assert.equal(errors[0].code, 'target-authorization-failed');
    assert.match(errors[0].message, /does not match/);
    assert.ok(Buffer.byteLength(errors[0].message) < 2048);
    assert.equal(
      wrong.messages.some((m) => m.type === 'broker.target.authorized'),
      false,
    );
    assert.equal(
      accepting.messages.some((m) => m.type === 'broker.error'),
      false,
    );
    await f.finishNative();
    await wait(() =>
      accepting.messages.some((m) => m.type === 'broker.target.authorized'),
    );
    assert.equal(
      accepting.messages.find((m) => m.type === 'broker.target.authorized')
        .disposition,
      'joined-existing',
    );
    assert.equal(f.calls.length, 1);
    assert.equal(
      require('../dist/lib/overlay-loopback-transport.js').readOverlayTargetRecoveryClaim(
        PID,
      ).expectedExecutablePath,
      EXE.toLowerCase(),
    );
  });
}

test('PID-only frozen-v1 app elects cached runtime and pins the authoritative OS image', async (t) => {
  const f = await fixture(t);
  const old = await f.client({ expectedExecutablePath: undefined });
  await wait(
    () =>
      f.calls.length > 0 ||
      old.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  assert.equal(
    old.messages.some(
      (m) =>
        m.type === 'broker.target.authorized' &&
        m.disposition === 'injection-owner',
    ),
    false,
    'omitting the optional path must not hide the installed higher generation',
  );
  await f.finishNative();
  await wait(() =>
    old.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  const claim =
    require('../dist/lib/overlay-loopback-transport.js').readOverlayTargetRecoveryClaim(
      PID,
    );
  assert.equal(claim.expectedExecutablePath, EXE.toLowerCase());
  assert.equal(
    old.messages.find((m) => m.type === 'broker.target.authorized').disposition,
    'joined-existing',
  );
  assert.equal(f.calls.length, 1);
});

test('postgrant injector failure rejects correlated pending apps but keeps pinned ownership for late authentication', async (t) => {
  const f = await fixture(t);
  const first = await f.client();
  const second = await f.client();
  await wait(() => f.calls.length === 1);
  const transportModule = require('../dist/lib/overlay-loopback-transport.js');
  const pinned = transportModule.readOverlayTargetRecoveryClaim(PID);
  f.calls[0].callback(
    new Error('controlled injector launch failed ' + 'x'.repeat(10000)),
    '',
    'controlled injector stderr',
  );
  await wait(() => f.diagnostics.length > 0);
  await new Promise((r) => setTimeout(r, 40));
  for (const app of [first, second]) {
    const errors = app.messages.filter((m) => m.type === 'broker.error');
    assert.equal(
      errors.length,
      1,
      'each pending app must get a terminal, correlated attachment error',
    );
    assert.equal(errors[0].pid, PID);
    assert.equal(errors[0].requestId, app.requestId);
    assert.ok(
      Buffer.byteLength(errors[0].message) < 10000,
      'native error detail must be bounded',
    );
    assert.equal(errors[0].code, 'target-authorization-failed');
    assert.match(errors[0].message, /controlled injector|injector/i);
  }
  const future = await f.client();
  await wait(() => future.messages.some((m) => m.type === 'broker.error'));
  assert.equal(
    future.messages.filter((m) => m.type === 'broker.error').length,
    1,
  );
  assert.deepEqual(transportModule.readOverlayTargetRecoveryClaim(PID), pinned);
  assert.equal(f.server.targets.size, 1);
  assert.equal(f.calls.length, 1);
  await f.authenticate(pinned.discoveryPath);
  const late = await f.client();
  await wait(() =>
    late.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  assert.equal(
    late.messages.find((m) => m.type === 'broker.target.authorized')
      .disposition,
    'joined-existing',
  );
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.diagnostics.length,
    1,
    'broker failure delivery must not recursively report through the provider',
  );
});

test('postgrant runtime initialization timeout settles pending/future authorizations without clearing the claim', async (t) => {
  const originalTimeout = global.setTimeout;
  let expireProof;
  global.setTimeout = (handler, ms, ...args) => {
    if (ms === 120000) {
      expireProof ??= () => handler(...args);
      return originalTimeout(() => {}, 120000).unref();
    }
    return originalTimeout(handler, ms, ...args);
  };
  t.after(() => {
    global.setTimeout = originalTimeout;
  });
  const f = await fixture(t);
  const app = await f.client();
  await wait(() => f.calls.length === 1 && expireProof);
  const transportModule = require('../dist/lib/overlay-loopback-transport.js');
  const pinned = transportModule.readOverlayTargetRecoveryClaim(PID);
  f.calls[0].callback(
    null,
    'Injecting ReShade ... Succeeded!\nELECTRON_GAME_OVERLAY_INJECTOR_RESULT ' +
      JSON.stringify({
        schemaVersion: 1,
        pid: PID,
        targetExecutablePath: EXE,
        runtimeMode: 'injected-runtime',
      }) +
      '\n',
    '',
  );
  await new Promise((r) => setImmediate(r));
  expireProof();
  await wait(() => f.diagnostics.length > 0);
  await new Promise((r) => originalTimeout(r, 30));
  const failure = app.messages.find((m) => m.type === 'broker.error');
  assert.ok(
    failure,
    'runtime proof timeout must terminate the application authorization',
  );
  assert.equal(failure.pid, PID);
  assert.equal(failure.requestId, app.requestId);
  assert.equal(failure.code, 'target-authorization-failed');
  assert.match(failure.message, /did not connect within 120000ms/);
  const future = await f.client();
  await wait(() => future.messages.some((m) => m.type === 'broker.error'));
  assert.deepEqual(transportModule.readOverlayTargetRecoveryClaim(PID), pinned);
  assert.equal(f.server.targets.size, 1);
  await f.authenticate(pinned.discoveryPath);
  const late = await f.client();
  await wait(() =>
    late.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  assert.equal(
    late.messages.find((m) => m.type === 'broker.target.authorized')
      .disposition,
    'joined-existing',
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.diagnostics.length, 1);
});

test('a late injector error after actual authentication does not release surviving apps input or scene', async (t) => {
  const f = await fixture(t);
  const first = await f.client();
  const survivor = await f.client();
  await wait(() => f.calls.length === 1);
  const transportModule = require('../dist/lib/overlay-loopback-transport.js');
  const pinned = transportModule.readOverlayTargetRecoveryClaim(PID);
  await f.authenticate(pinned.discoveryPath);
  await wait(() =>
    [first, survivor].every((app) =>
      app.messages.some((m) => m.type === 'broker.target.authorized'),
    ),
  );
  survivor.send({
    type: 'broker.window.upsert',
    windowId: 1,
    name: 'survivor',
    transparent: true,
    rect: { x: 0, y: 0, width: 2, height: 1 },
  });
  survivor.send({ type: 'broker.input.intercept', intercept: true });
  const host = f.server.targets.get(PID);
  await wait(
    () =>
      host.ownersByTargetWindowId.size === 1 &&
      [...host.members.values()].some((m) => m.client.inputIntercept),
  );
  let inputMutations = 0;
  let closedWindows = 0;
  const transport = f.transport();
  const setIntercept = transport.setInputIntercept.bind(transport);
  const closeWindow = transport.closeWindow.bind(transport);
  transport.setInputIntercept = (...args) => {
    inputMutations++;
    return setIntercept(...args);
  };
  transport.closeWindow = (...args) => {
    closedWindows++;
    return closeWindow(...args);
  };
  f.calls[0].callback(
    new Error('controlled late injector reporting failure'),
    '',
    '',
  );
  await wait(() => f.diagnostics.length > 0);
  assert.equal(host.targetConnected, true);
  assert.equal(host.ownersByTargetWindowId.size, 1);
  assert.equal(inputMutations, 0);
  assert.equal(closedWindows, 0);
  assert.equal(
    survivor.messages.some(
      (m) =>
        m.type === 'broker.error' || m.type === 'game.process.disconnected',
    ),
    false,
  );
  assert.deepEqual(transportModule.readOverlayTargetRecoveryClaim(PID), pinned);
  const late = await f.client();
  await wait(() =>
    late.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  assert.equal(
    late.messages.find((m) => m.type === 'broker.target.authorized')
      .disposition,
    'joined-existing',
  );
  assert.equal(f.calls.length, 1);
});

test('OS image query rejects drive-relative/root-relative output before publishing a cached candidate', async (t) => {
  const f = await fixture(t, 7, { processImage: '\\game.exe' });
  const app = await f.client({ expectedExecutablePath: undefined });
  await wait(
    () =>
      app.messages.some((m) => m.type === 'broker.target.authorized') ||
      f.calls.length > 0,
  );
  assert.equal(
    f.calls.length,
    0,
    'an invalid OS response must fall back before native publication/injection',
  );
  assert.equal(
    app.messages.find((m) => m.type === 'broker.target.authorized').disposition,
    'injection-owner',
  );
});

test('winner resolves OS identity before any route publication and does not use the caller path or CWD as query authority', async (t) => {
  let finishQuery;
  const f = await fixture(t, 7, {
    queryHook: (callback) => {
      finishQuery = callback;
    },
  });
  const app = await f.client({
    expectedExecutablePath: "C:\\untrusted\\game'; throw 'caller'.exe",
  });
  await wait(() => finishQuery);
  const transportModule = require('../dist/lib/overlay-loopback-transport.js');
  assert.equal(transportModule.readOverlayTargetRecoveryClaim(PID), undefined);
  assert.equal(
    fs.existsSync(path.join(f.root, 'host.json')),
    true,
    'host can listen before target publication',
  );
  assert.equal(f.calls.length, 0);
  const query = f.imageQueries[0];
  assert.equal(
    query.exe,
    path.join(f.directory, 'electron_game_overlay_reshade_manager.exe'),
  );
  assert.equal(query.opts.cwd, f.directory);
  assert.equal(query.opts.shell, false);
  assert.equal(query.opts.timeout, 2000);
  assert.equal(query.opts.maxBuffer, 128 * 1024);
  assert.deepEqual(query.args, ['--query-process-image', String(PID)]);
  assert.ok(!query.args.some((arg) => arg.includes('caller')));
  const accepting = await f.client({ expectedExecutablePath: undefined });
  await wait(() => f.server.targets.get(PID).members.size === 3);
  finishQuery(null, imageRecord(), '');
  await f.finishNative();
  await wait(() =>
    accepting.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  await wait(() => app.messages.some((m) => m.type === 'broker.error'));
  assert.match(
    app.messages.find((m) => m.type === 'broker.error').message,
    /does not match/,
  );
  assert.equal(
    transportModule.readOverlayTargetRecoveryClaim(PID).expectedExecutablePath,
    EXE.toLowerCase(),
  );
});

test('OS-query failure before publication falls back to an ordinary PID-only provider', async (t) => {
  const f = await fixture(t, 7, {
    processImageError: Object.assign(new Error('controlled OS query timeout'), {
      killed: true,
    }),
  });
  const app = await f.client({ expectedExecutablePath: undefined });
  await wait(() =>
    app.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  assert.equal(
    app.messages.find((m) => m.type === 'broker.target.authorized').disposition,
    'injection-owner',
  );
  assert.equal(f.calls.length, 0);
  // The failed cached candidate is disposed; the independently elected live
  // candidate still gets a broker-local identity attempt, also fail-closed.
  assert.equal(f.imageQueries.length, 2);
  assert.match(
    f.diagnostics[0].message,
    /Unable to query OS executable identity/,
  );
});

test('process identity query validates positive uint32 PID before starting any child', async (t) => {
  const f = await fixture(t);
  const {
    resolveOverlayBrokerProcessImage,
  } = require('../dist/lib/overlay-broker-native-provider.js');
  for (const pid of [0, -1, 1.5, NaN, Infinity, 0x100000000, '54321']) {
    await assert.rejects(
      resolveOverlayBrokerProcessImage(
        pid,
        path.join(f.directory, 'electron_game_overlay_reshade_manager.exe'),
      ),
      /positive uint32/,
    );
    assert.equal(f.provider.createTarget({ pid }), undefined);
  }
  assert.equal(f.imageQueries.length, 0);
  assert.equal(f.calls.length, 0);
});

test(
  'native Windows first-call self-process image query returns the actual executable',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const {
      resolveOverlayBrokerProcessImage,
    } = require('../dist/lib/overlay-broker-native-provider.js');
    const started = performance.now();
    assert.ok(
      process.env.EGO_NATIVE_MANAGER_PATH,
      'compiled helper fixture EGO_NATIVE_MANAGER_PATH is required on Windows',
    );
    assert.ok(path.isAbsolute(process.env.EGO_NATIVE_MANAGER_PATH));
    assert.ok(fs.statSync(process.env.EGO_NATIVE_MANAGER_PATH).isFile());
    const actual = await resolveOverlayBrokerProcessImage(
      process.pid,
      process.env.EGO_NATIVE_MANAGER_PATH,
    );
    t.diagnostic(
      `OS identity query elapsed ${Math.round(performance.now() - started)}ms`,
    );
    assert.equal(
      path.win32.normalize(actual).toLowerCase(),
      path.win32.normalize(process.execPath).toLowerCase(),
    );
    // Run the negative probe only after recording the genuine first invocation.
    await assert.rejects(
      resolveOverlayBrokerProcessImage(
        0xffffffff,
        process.env.EGO_NATIVE_MANAGER_PATH,
      ),
      /Unable to query OS executable identity/,
    );
  },
);

test('local provider does not retain an abandoned prepublication target', async (t) => {
  const f = await fixture(t, 7, {
    serverOptions: { runtimeProviderElectionWindowMs: 500 },
  });
  const app = await f.client();
  await wait(() => f.server.targets.size === 1);
  app.socket.destroy();
  await wait(() => f.server.clients.size === 0);
  await wait(() => f.server.targets.size === 0);
  assert.equal(f.calls.length, 0);
});

for (const generation of [7, 8]) {
  test(`equal/higher live generation ${generation} competes through normal stable lease election`, async (t) => {
    const f = await fixture(t);
    const app = await f.client({
      runtimeGeneration: generation,
      targetTransportMin: 1,
      targetTransportMax: 1,
      leaseId: '00000000-0000-4000-8000-000000000000',
    });
    await wait(() =>
      app.messages.some((m) => m.type === 'broker.target.authorized'),
    );
    const grant = app.messages.find(
      (m) => m.type === 'broker.target.authorized',
    );
    assert.equal(grant.disposition, 'injection-owner');
    await f.authenticate(grant.discoveryPath);
    assert.equal(f.calls.length, 0);
  });
}

test('late higher live provider joins cached owner without a second native execution', async (t) => {
  const f = await fixture(t);
  await f.client();
  await f.finishNative();
  const late = await f.client({
    runtimeGeneration: 99,
    targetTransportMin: 1,
    targetTransportMax: 1,
  });
  await wait(() =>
    late.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  assert.equal(
    late.messages.find((m) => m.type === 'broker.target.authorized')
      .disposition,
    'joined-existing',
  );
  assert.equal(f.calls.length, 1);
});

test('native preparation is in cohort before delayed staging can exceed cutoff', async (t) => {
  const f = await fixture(t);
  // Force the per-target path to prepare after election rather than consume the
  // startup spare, while retaining actual launcher staging/manifest validation.
  const discarded = f.provider.createTarget({
    pid: PID + 1,
    expectedExecutablePath: EXE,
  });
  discarded.dispose();
  const fsPromises = require('node:fs/promises');
  const original = fsPromises.mkdir;
  fsPromises.mkdir = async (...args) => {
    if (path.resolve(args[0]) === path.join(f.root, 'runs'))
      await new Promise((r) => setTimeout(r, 100));
    return original(...args);
  };
  t.after(() => {
    fsPromises.mkdir = original;
  });
  const old = await f.client();
  await f.finishNative();
  await wait(() =>
    old.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  assert.equal(
    old.messages.find((m) => m.type === 'broker.target.authorized').disposition,
    'joined-existing',
  );
  assert.equal(f.calls.length, 1);
});

test('proven prepublication claim failure falls back to live provider', async (t) => {
  let failed = false;
  const f = await fixture(t, 7, {
    transportOptions: {
      targetRecoveryClaimWriteHook(claim) {
        if (!failed && claim.phase === 'intent') {
          failed = true;
          throw Error('controlled prepublication storage failure');
        }
      },
    },
  });
  const app = await f.client();
  await wait(() =>
    app.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  assert.equal(failed, true);
  assert.equal(
    app.messages.find((m) => m.type === 'broker.target.authorized').disposition,
    'injection-owner',
  );
  assert.equal(f.calls.length, 0);
});

test('possibly consumed native publication stays frozen through shutdown', async (t) => {
  const f = await fixture(t, 7, {
    transportOptions: {
      targetAuthorizationPublicationHook(phase) {
        if (phase === 'recovery-claim-armed')
          throw Error('controlled possibly consumed publication failure');
      },
    },
  });
  const app = await f.client();
  const {
    readOverlayTargetRecoveryClaim,
  } = require('../dist/lib/overlay-loopback-transport.js');
  await wait(() => {
    const claim = readOverlayTargetRecoveryClaim(PID);
    return (
      claim &&
      require('../dist/lib/overlay-loopback-transport.js').overlayTargetRecoveryClaimMayHaveBeenConsumed(
        claim,
      )
    );
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    app.messages.some((m) => m.type === 'broker.target.authorized'),
    false,
  );
  assert.equal(f.calls.length, 0);
  await f.server.stop();
  assert.equal(
    require('../dist/lib/overlay-loopback-transport.js').overlayTargetRecoveryClaimMayHaveBeenConsumed(
      readOverlayTargetRecoveryClaim(PID),
    ),
    true,
  );
});

test('cached provider target retires only on authoritative target exit', async (t) => {
  const f = await fixture(t);
  const app = await f.client();
  const targetSocket = await f.finishNative();
  await wait(() =>
    app.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  app.socket.destroy();
  await wait(() => f.server.clients.size === 0);
  assert.equal(
    f.server.targets.size,
    1,
    'zero applications does not mean target exit',
  );
  f.exit();
  targetSocket.destroy();
  await wait(() => f.server.targets.size === 0);
  assert.equal(
    require('../dist/lib/overlay-loopback-transport.js').readOverlayTargetRecoveryClaim(
      PID,
    ),
    undefined,
  );
});

test('restarted cached provider services consumed pinned route without reinjection', async (t) => {
  let failed = false;
  const f = await fixture(t, 7, {
    transportOptions: {
      targetAuthorizationPublicationHook(phase) {
        if (!failed && phase === 'recovery-claim-armed') {
          failed = true;
          throw Error('controlled crash point');
        }
      },
    },
  });
  const app = await f.client();
  const {
    readOverlayTargetRecoveryClaim,
  } = require('../dist/lib/overlay-loopback-transport.js');
  await wait(() => readOverlayTargetRecoveryClaim(PID));
  await wait(() => f.diagnostics.length > 0);
  const pinned = readOverlayTargetRecoveryClaim(PID).discoveryPath;
  await f.restart();
  const pinnedClaim = readOverlayTargetRecoveryClaim(PID);
  const wrong = await f.client({
    expectedExecutablePath: 'C:\\OtherGame\\OtherGame.exe',
  });
  await wait(() => wrong.messages.some((m) => m.type === 'broker.error'));
  await wait(() => f.server.targets.get(PID)?.isEmpty === true);
  assert.deepEqual(readOverlayTargetRecoveryClaim(PID), pinnedClaim);
  assert.equal(f.calls.length, 0);
  assert.equal(
    wrong.messages.find((m) => m.type === 'broker.error').requestId,
    wrong.requestId,
  );
  const replacement = await f.client();
  await wait(() => {
    try {
      return (
        fs.existsSync(pinned) &&
        JSON.parse(fs.readFileSync(pinned, 'utf8')).port ===
          JSON.parse(fs.readFileSync(path.join(f.root, 'host.json'), 'utf8'))
            .port
      );
    } catch {
      return false;
    }
  });
  await f.authenticate(pinned);
  await wait(() =>
    replacement.messages.some((m) => m.type === 'broker.target.authorized'),
  );
  assert.equal(
    replacement.messages.find((m) => m.type === 'broker.target.authorized')
      .disposition,
    'joined-existing',
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    app.messages.some(
      (m) =>
        m.type === 'broker.target.authorized' &&
        m.disposition === 'injection-owner',
    ),
    false,
  );
});

test('provider is not an app lease keeping an otherwise idle listener alive', async (t) => {
  const f = await fixture(t, 7, {
    serverOptions: { idleShutdownMs: 40, runtimeProviderElectionWindowMs: 500 },
  });
  const app = await f.client();
  await wait(() => f.server.targets.size === 1);
  app.socket.destroy();
  await wait(() => f.server.server === undefined);
  assert.equal(f.calls.length, 0);
});

test('invalid x86 cached artifacts are diagnosed rather than offered as a generation', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ego-native-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = runtime(root, 55);
  fs.appendFileSync(path.join(directory, 'inject32.exe'), 'tampered');
  const diagnostics = [];
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let provider;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    provider =
      await require('../dist/lib/overlay-broker-native-provider.js').prepareStandaloneOverlayNativeProvider(
        {
          executablePath: path.join(root, 'broker.exe'),
          onDiagnostic: (d) => diagnostics.push(d),
        },
      );
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  assert.equal(provider, undefined);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'cached-native-runtime-unavailable');
  assert.match(diagnostics[0].message, /inject32.exe|injectorSha256/);
});

test(
  'non-Windows standalone does not claim a usable native provider',
  { skip: process.platform === 'win32' },
  async () => {
    assert.equal(
      await require('../dist/lib/overlay-broker-native-provider.js').prepareStandaloneOverlayNativeProvider(),
      undefined,
    );
  },
);

test('cached target lease identity stays stable across target adapter recreation', async (t) => {
  const f = await fixture(t);
  const request = { pid: PID, expectedExecutablePath: EXE };
  const first = f.provider.createTarget(request);
  const lease = first.leaseId;
  first.dispose();
  const second = f.provider.createTarget(request);
  assert.equal(second.leaseId, lease);
  second.dispose();
});

test('cached lease ignores bundle relocation and optional caller executable identity', async (t) => {
  const f = await fixture(t);
  const first = f.provider.createTarget({
    pid: PID,
    expectedExecutablePath: EXE,
  });
  const lease = first.leaseId;
  first.dispose();
  f.relocate();
  await f.restart();
  const second = f.provider.createTarget({ pid: PID });
  assert.equal(
    second.leaseId,
    lease,
    'identical validated artifacts must resume the same PID lease after relocation',
  );
  second.dispose();
});

test('cached provider resumes its exact unconsumed crash-snapshot intent with one injection', async (t) => {
  let captured;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, 7, {
    transportOptions: {
      async targetAuthorizationPublicationHook(phase, claim) {
        if (!captured && phase === 'recovery-claim-published') {
          captured = structuredClone(claim);
          await barrier;
          throw Error('controlled pre-consumable crash snapshot');
        }
      },
    },
  });
  await f.client();
  await wait(() => captured);
  assert.equal(captured.phase, 'intent');
  await f.server.stop();
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Recreate the exact claim actually written before the controlled crash
  // boundary; no native execution or publishing phase occurred before it.
  const claimPath =
    require('../dist/lib/overlay-loopback-transport.js').defaultOverlayTargetRecoveryClaimPath(
      PID,
    );
  fs.mkdirSync(path.dirname(claimPath), { recursive: true });
  fs.writeFileSync(claimPath, JSON.stringify(captured));
  f.relocate();
  await f.restart();
  const wrong = await f.client({
    expectedExecutablePath: 'C:\\OtherGame\\OtherGame.exe',
  });
  await wait(() => wrong.messages.some((m) => m.type === 'broker.error'));
  assert.equal(
    wrong.messages.find((m) => m.type === 'broker.error').requestId,
    wrong.requestId,
  );
  const replacement = await f.client({ expectedExecutablePath: undefined });
  await f.finishNative();
  await wait(() =>
    replacement.messages.some(
      (message) => message.type === 'broker.target.authorized',
    ),
  );
  assert.equal(
    replacement.messages.find(
      (message) => message.type === 'broker.target.authorized',
    ).disposition,
    'joined-existing',
  );
  assert.equal(f.calls.length, 1);
});

test('broker shutdown releases its unused prepared cached runtime', async (t) => {
  const f = await fixture(t);
  assert.ok(fs.readdirSync(path.join(f.root, 'runs')).length > 0);
  await f.server.stop();
  await wait(() => fs.readdirSync(path.join(f.root, 'runs')).length === 0);
});
