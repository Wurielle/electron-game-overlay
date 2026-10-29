const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const net = require('node:net');
const ts = require('typescript');

// Exercise a private, current source graph without writing production build output.
const source = path.resolve(__dirname, '../src/lib');
const cache = new Map();
let launcherBoundary;
let privilegeOutput = 'S-1-16-8192';
let privilegeCalls = 0;
let managerBoundary;
const ownedEndpoints = new Set();
const controlledNet = {
  createConnection(endpoint, ...args) {
    assert.ok(ownedEndpoints.has(endpoint), 'connection must target an owned private listener');
    return net.createConnection(endpoint, ...args);
  },
  createServer(...args) {
    const server = net.createServer(...args);
    const listen = server.listen;
    server.listen = function (endpoint, ...rest) {
      if (typeof endpoint === 'string') {
        assert.ok(ownedEndpoints.has(endpoint), 'listener must use the owned private endpoint');
      } else {
        assert.equal(endpoint, 0, 'only an ephemeral owned loopback listener is permitted');
        assert.equal(rest[0], '127.0.0.1');
      }
      return listen.call(this, endpoint, ...rest);
    };
    return server;
  },
};
const controlledDirectory = 'Z:\\Controlled OS\\System32';
const controlledChildProcess = new Proxy({}, { get(_target, key) {
  if (key !== 'execFile') return () => assert.fail(`unexpected process operation: ${String(key)}`);
  return (exe, args, options, callback) => {
    if (exe === `${controlledDirectory}\\whoami.exe`) {
      assert.deepEqual(args, ['/groups', '/fo', 'csv', '/nh']);
      assert.deepEqual(options, { shell: false, windowsHide: true, cwd: controlledDirectory, timeout: 2000, maxBuffer: 64 * 1024, encoding: 'utf8' });
      privilegeCalls++;
      queueMicrotask(() => callback(null, privilegeOutput, ''));
      return new (require('node:events').EventEmitter)();
    }
    assert.equal(exe, managerBoundary, 'only the owned controlled manager query is permitted');
    assert.ok(managerBoundary);
    assert.deepEqual(args, ['--query-process-image', String(PID)]);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    queueMicrotask(() => callback(null, JSON.stringify({ schemaVersion: 1, kind: 'electron-game-overlay-process-image', pid: PID, executablePath: EXE, creationTime100ns: A }) + '\n', ''));
    return new (require('node:events').EventEmitter)();
  };
} });
function load(name) {
  const file = path.join(source, name + '.ts');
  if (cache.has(file)) return cache.get(file).exports;
  const mod = new Module(file, module);
  cache.set(file, mod);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(source);
  mod.require = function (id) {
    if (id === 'node:net') return controlledNet;
    if (id === 'node:child_process') return controlledChildProcess;
    if (id === 'node:fs' && name === 'overlay-broker-windows-os-path') return {
      ...fs, realpath: { native(input, callback) {
        assert.equal(input, '\\\\?\\GLOBALROOT\\SystemRoot\\System32');
        queueMicrotask(() => callback(null, controlledDirectory));
      } },
    };
    if (id === 'electron') return { screen: new (require('node:events').EventEmitter)() };
    if (id === './reshade-launcher.js' && launcherBoundary) return launcherBoundary;
    if (id.startsWith('./') && id.endsWith('.js')) return load(id.slice(2, -3));
    assert.ok(['node:crypto', 'node:fs', 'node:fs/promises', 'node:os', 'node:path', 'node:events'].includes(id), `unexpected private-graph dependency: ${id}`);
    return module.require(id);
  };
  let text = fs.readFileSync(file, 'utf8');
  // Explicit controlled Windows branch projection, never host platform replacement.
  // Only select the branch; the actual guard, resolver and output parser remain real.
  const branch = name === 'overlay-broker-bootstrap'
    ? "if (process.platform !== 'win32') return;"
    : name === 'overlay-broker-native-provider'
      ? "if (process.platform !== 'win32' || process.arch !== 'x64') return undefined;" : undefined;
  if (branch && process.platform !== 'win32') { assert.equal(text.split(branch).length, 2); text = text.replace(branch, '/* controlled Windows branch selection; nativeExecuted=false */'); }
  mod._compile(ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText, file);
  return mod.exports;
}
const A = '9007199254740993';

test('client rejects malformed-present expectations without numeric coercion', async t => {
  const bootstrap = load('overlay-broker-bootstrap');
  privilegeOutput = 'S-1-16-12288';
  await assert.rejects(bootstrap.assertOverlayBrokerPrivilege(), /requires proven medium/);
  privilegeOutput = 'S-1-16-8192';
  await bootstrap.assertOverlayBrokerPrivilege();
  assert.ok(privilegeCalls >= 2, 'actual Windows guard consumed controlled OS output');
  const f = await fixture(t);
  const client = await f.client();
  const message = { type: 'broker.target.authorized', requestId: 'unknown', pid: PID, disposition: 'injection-owner', discoveryPath: path.join(f.root, 'raw.json') };
  assert.equal(client.receiveMessage(message), true, 'old broker omission remains valid');
  for (const value of [undefined, null, 0, 9007199254740992, '', '0', '01', '+1', ' 1', '1.0', '1e2', '18446744073709551616', '1'.repeat(21)]) {
    assert.equal(client.receiveMessage({ ...message, expectedCreationTime100ns: value }), false, String(value));
  }
  for (const value of ['1', A, '18446744073709551615']) assert.equal(client.receiveMessage({ ...message, expectedCreationTime100ns: value }), true);
});
const PID = 54321;
const EXE = 'C:\\Games\\game.exe';
const CAP = 'process-instance-injection-v1';

test('optional capability omission and raw frozen v1 grants remain unbound', async t => {
  assert.ok(!protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES.includes(CAP));
  const f = await fixture(t);
  const client = await f.client({ supportedCapabilities: protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES });
  const value = await bounded(client.authorizeTarget(PID, path.join(f.root, 'legacy.json'), EXE), t.signal);
  assert.equal('expectedCreationTime100ns' in value, false);
  value.release();
  const raw = await f.raw();
  raw.socket.write(protocol.encodeBrokerJsonPacket({ type: 'broker.target.authorize', requestId: 'raw-old', pid: PID + 1, discoveryPath: path.join(f.root, 'old.json') }));
  const deadline = Date.now() + 2000;
  while (!raw.messages.some(m => m.type === 'broker.target.authorized')) {
    assert.ok(Date.now() < deadline); t.signal.throwIfAborted(); await new Promise(r => setTimeout(r, 5));
  }
  assert.equal('expectedCreationTime100ns' in raw.messages.find(m => m.type === 'broker.target.authorized'), false);
});

test('broker capability omission keeps a new capable client legacy-unbound', async t => {
  const f = await fixture(t, { capabilities: protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES });
  const client = await f.client();
  const value = await bounded(client.authorizeTarget(PID, path.join(f.root, 'old-broker.json'), EXE), t.signal);
  assert.equal('expectedCreationTime100ns' in value, false);
  value.release();
});

test('joined-existing carries no injector expectation', async t => {
  const f = await fixture(t);
  const owner = await f.client();
  const first = await bounded(owner.authorizeTarget(PID, path.join(f.root, 'owner.json'), EXE), t.signal);
  f.emit('game.process', { pid: PID, path: EXE });
  const joiner = await f.client();
  const joined = await bounded(joiner.authorizeTarget(PID, path.join(f.root, 'joiner.json'), EXE), t.signal);
  assert.equal(joined.disposition, 'joined-existing');
  assert.equal('expectedCreationTime100ns' in joined, false);
  assert.equal(f.publications.length, 1);
  first.release(); joined.release();
});
const protocol = load('overlay-broker-protocol');
const { OverlayBrokerServer } = load('overlay-broker-server');
const { OverlayBrokerClient } = load('overlay-broker-client');
const auth = load('overlay-session-authorization');
const { createOverlaySession } = load('overlay-session');

for (const observed of ['9007199254740994', undefined]) test(`known published tombstone retains ownership on ${observed ? 'mismatch' : 'unavailable identity'}`, async t => {
  const api = load('overlay-loopback-transport');
  const f = await fixture(t, { targetRecoveryClaimProbe: api.readOverlayTargetRecoveryClaim,
    queryProcessIdentity: async () => observed === undefined ? undefined : ({ pid: PID, executablePath: EXE, creationTime100ns: observed }) });
  const transport = new api.OverlayLoopbackTransport({ discoveryPath: path.join(f.root, 'global.json'), isProcessAlive: () => true });
  f.own(() => transport.stop()); transport.start(); await bounded(transport.whenReady(), t.signal);
  await bounded(transport.authorizeTarget(PID, path.join(f.root, 'known', 'electron-overlay-transport-v1.json'), EXE, { leaseId: 'retained', creationTime100ns: A }), t.signal);
  const before = api.readOverlayTargetRecoveryClaim(PID); transport.stop();
  const client = await f.client();
  await assert.rejects(bounded(client.authorizeTarget(PID, before.discoveryPath, EXE), t.signal), /identity|inspection|creation/i);
  assert.deepEqual(api.readOverlayTargetRecoveryClaim(PID), before);
  assert.equal(f.publications.length, 0);
});

test('actual legacy intent resumption never backfills current A into claim', async t => {
  const api = load('overlay-loopback-transport');
  const f = await fixture(t);
  let release, reached;
  const held = new Promise(r => { release = r; });
  const ready = new Promise(r => { reached = r; });
  let transaction;
  const old = new api.OverlayLoopbackTransport({ discoveryPath: path.join(f.root, 'old-global.json'), isProcessAlive: () => true,
    async targetAuthorizationPublicationHook(phase) { if (phase === 'recovery-claim-published') { reached(); await held; } } });
  const modern = new api.OverlayLoopbackTransport({ discoveryPath: path.join(f.root, 'new-global.json'), isProcessAlive: () => true });
  f.own(async () => { old.stop(); modern.stop(); release(); if (transaction) await bounded(transaction, undefined); });
  old.start(); await bounded(old.whenReady(), t.signal);
  const route = path.join(f.root, 'intent', 'electron-overlay-transport-v1.json');
  transaction = old.authorizeTarget(PID, route, EXE, { leaseId: 'legacy-intent' }).then(() => undefined, () => undefined);
  await bounded(ready, t.signal);
  assert.equal(api.readOverlayTargetRecoveryClaim(PID).phase, 'intent');
  old.stop(); modern.start(); await bounded(modern.whenReady(), t.signal);
  await bounded(modern.authorizeTarget(PID, route, EXE, { leaseId: 'legacy-intent', creationTime100ns: A }), t.signal);
  assert.equal('creationTime100ns' in api.readOverlayTargetRecoveryClaim(PID), false);
  release(); await bounded(transaction, t.signal);
  assert.equal('creationTime100ns' in api.readOverlayTargetRecoveryClaim(PID), false);
});
function bounded(promise, signal, ms = 2500) {
  return new Promise((resolve, reject) => {
    const abort = () => done(reject, signal.reason);
    const timer = setTimeout(() => done(reject, new Error('fixture deadline')), ms);
    function done(fn, value) { clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(v => done(resolve, v), e => done(reject, e));
  });
}
async function fixture(t, options = {}) {
  let root, server;
  const clients = [], sockets = [], ownedCleanup = [];
  const userInfo = os.userInfo, tmpdir = os.tmpdir;
  let cleaned;
  const cleanup = () => cleaned ??= (async () => {
    try {
      for (const client of clients) client.stop();
      for (const socket of sockets) socket.destroy();
      const errors = [];
      for (const dispose of ownedCleanup.reverse()) { try { await bounded(dispose(), undefined); } catch (e) { errors.push(e); } }
      try { if (server) await bounded(server.stop(), undefined); } catch (e) { errors.push(e); }
      if (errors.length) throw new AggregateError(errors);
    } finally {
      os.userInfo = userInfo; os.tmpdir = tmpdir;
      ownedEndpoints.clear();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  })();
  t.after(cleanup);
  root = fs.mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'ego-binding-'));
  os.userInfo = (...args) => ({ ...userInfo(...args), homedir: root });
  os.tmpdir = () => root;
  let event;
  const publications = [];
  const transport = {
    start() {}, whenReady: async () => {}, stop() {},
    setEventCallback(cb) { event = cb; }, setDiagnosticCallback() {},
    setInputIntercept() {}, addWindow() {}, closeWindow() {}, sendWindowBounds() {}, sendFrameBuffer() {},
    async authorizeTarget(...args) { publications.push(args); return () => {}; },
  };
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\ego-binding-${require('node:crypto').randomUUID()}` : path.join(root, 'broker.sock');
  ownedEndpoints.add(pipePath);
  server = new OverlayBrokerServer({ pipePath, idleShutdownMs: false, runtimeProviderElectionWindowMs: 0,
    isProcessAlive: () => true, targetRecoveryClaimProbe: () => undefined,
    clearTargetRecoveryClaim: () => assert.fail('must not clear retained ownership'),
    queryProcessIdentity: async () => ({ pid: PID, executablePath: EXE, creationTime100ns: A }),
    targetTransportFactory: () => transport, ...options });
  await bounded(server.start(), t.signal);
  async function client(opts = {}) {
    const c = new OverlayBrokerClient({ pipePath, connectTimeoutMs: 1000, ...opts });
    clients.push(c); c.start(); await bounded(c.whenReady(), t.signal); return c;
  }
  async function raw(hello = {}, onMessage) {
    const socket = controlledNet.createConnection(pipePath); sockets.push(socket);
    const messages = [], decoder = new protocol.BrokerPacketDecoder();
    socket.on('data', data => { for (const packet of decoder.push(data)) { messages.push(packet.value); onMessage?.(packet.value, socket); } });
    await bounded(new Promise((r, j) => { socket.once('connect', r); socket.once('error', j); }), t.signal);
    socket.write(protocol.encodeBrokerJsonPacket({ type: 'broker.hello', protocolMin: 1, protocolMax: 1,
      requiredCapabilities: protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES, clientPid: process.pid, sdkVersion: 'old-v1', ...hello }));
    return { socket, messages };
  }
  return { root, client, raw, transport, publications, emit: (...args) => event(...args), cleanup, own: cb => ownedCleanup.push(cb) };
}

test('known broker A survives real client and object/function session adapters exactly', { timeout: 7000 }, async t => {
  const f = await fixture(t);
  const client = await f.client();
  const session = createOverlaySession(client);
  const result = await bounded(auth.authorizeOverlaySessionTarget(session, PID, path.join(f.root, 'route.json'), EXE), t.signal);
  assert.equal(f.publications[0][3].creationTime100ns, A);
  assert.equal(result.expectedCreationTime100ns, A);
  assert.equal(auth.normalizeSessionTargetAuthorization({ release() {}, disposition: 'injection-owner', expectedCreationTime100ns: A }).expectedCreationTime100ns, A);
  assert.equal(auth.normalizeSessionTargetAuthorization(Object.assign(() => {}, { disposition: 'injection-owner', expectedCreationTime100ns: A })).expectedCreationTime100ns, A);
  result();
});

test('cached internal provider preserves broker A through its real synthetic session', { timeout: 7000 }, async t => {
  const f = await fixture(t);
  let provider, settlement;
  f.own(async () => { try { provider?.dispose(); if (settlement) await bounded(settlement, undefined); } finally { managerBoundary = undefined; launcherBoundary = undefined; } });
  const stamp = path.join(f.root, 'stamp.json'); fs.writeFileSync(stamp, '{}');
  const route = path.join(f.root, 'cached.json');
  const metadata = { runtimeGeneration: 7, targetTransportMin: 1, targetTransportMax: 1 };
  let captured;
  launcherBoundary = {
    parseReShadeLaunchConfig: () => ({ packageBuildStampPath: stamp, x86PackageBuildStampPath: stamp, addonManagerPath: path.join(f.root, 'manager.exe'), runtimeProvider: metadata }),
    ReShadeOverlayLauncher: class { async prepare() {} dispose() {} },
    attachReShadeOverlay(_launcher, session) {
      settlement = auth.authorizeOverlaySessionTarget(session, PID, route, EXE, metadata).then(value => { captured = value; });
      return settlement;
    },
  };
  managerBoundary = path.join(f.root, 'manager.exe');
  provider = await load('overlay-broker-native-provider').prepareStandaloneOverlayNativeProvider();
  assert.ok(provider);
  const target = provider.createTarget({ pid: PID });
  await bounded(target.prepare(), t.signal);
  target.receive({ type: 'broker.target.authorized', pid: PID, requestId: 'cached', disposition: 'injection-owner', discoveryPath: route, expectedCreationTime100ns: A });
  await bounded(settlement, t.signal);
  assert.equal(captured.expectedCreationTime100ns, A);
});
