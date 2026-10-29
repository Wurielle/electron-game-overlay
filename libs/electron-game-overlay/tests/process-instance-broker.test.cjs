const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { OverlayBrokerServer } = require('../dist/lib/overlay-broker-server.js');
const { OverlayBrokerClient } = require('../dist/lib/overlay-broker-client.js');
const { BrokerPacketDecoder, encodeBrokerJsonPacket, OVERLAY_BROKER_REQUIRED_CAPABILITIES } = require('../dist/lib/overlay-broker-protocol.js');
const { OverlayLoopbackTransport, encodeJsonTransportPacket } = require('../dist/lib/overlay-loopback-transport.js');
const EXE = 'C:\\Games\\same.exe';
const A = '133700000000000001';
const B = '133700000000000002';
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const end = Date.now() + 3500;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timeout: ${label}`);
    await delay(5);
  }
}
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-instance-'));
  const userInfo = os.userInfo, tmpdir = os.tmpdir;
  os.userInfo = () => ({ ...userInfo(), homedir: root });
  os.tmpdir = () => root;
  const clients = [], sockets = [], transports = [];
  let server;
  t.after(async () => {
    clients.forEach(c => c.stop()); sockets.forEach(s => s.destroy());
    await server?.stop(); transports.forEach(x => x.stop());
    os.userInfo = userInfo; os.tmpdir = tmpdir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pid = process.pid;
  const route = path.join(root, 'run', 'electron-overlay-transport-v1.json');
  const claimPath = path.join(root, '.electron-game-overlay', 'broker-v1', `electron-overlay-transport-v1.pid-${pid}.recovery.json`);
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\ego-instance-${randomUUID()}` : path.join(root, 'broker.sock');
  const readClaim = () => JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  async function start(extra = {}) {
    server = new OverlayBrokerServer({ pipePath, idleShutdownMs: false, runtimeProviderElectionWindowMs: 0, isProcessAlive: () => true, processExitPollIntervalMs: 10, ...options, ...extra });
    await server.start();
    return server;
  }
  async function raw() {
    const socket = net.createConnection(pipePath); sockets.push(socket);
    const messages = [], decoder = new BrokerPacketDecoder();
    socket.on('error', () => {});
    socket.on('data', data => { for (const packet of decoder.push(data)) messages.push(packet.value); });
    const send = message => socket.write(encodeBrokerJsonPacket(message));
    await until(() => !socket.connecting, 'raw connect');
    send({ type: 'broker.hello', protocolMin: 1, protocolMax: 1, requiredCapabilities: OVERLAY_BROKER_REQUIRED_CAPABILITIES, clientPid: pid, sdkVersion: 'legacy' });
    await until(() => messages.some(x => x.type === 'broker.welcome'), 'welcome');
    return { socket, messages, authorize(id = randomUUID()) { send({ type: 'broker.target.authorize', requestId: id, pid, discoveryPath: route }); return id; } };
  }
  async function seed(time) {
    if (arguments.length === 0) time = A;
    const transport = new OverlayLoopbackTransport({ discoveryPath: path.join(root, 'seed.host.json'), isProcessAlive: () => true }); transports.push(transport);
    transport.start(); await transport.whenReady();
    await transport.authorizeTarget(pid, route, EXE, { leaseId: 'original-lease', ...(time === undefined ? {} : { creationTime100ns: time }) });
    transport.stop();

  }
  return { root, pid, route, claimPath, readClaim, start, raw, seed, get server() { return server; } };
}

for (const unavailable of ['missing', 'throws']) {
  test(`lost-watch confirmation retries once after ${unavailable} and settles recovery waiter`, { timeout: 6000 }, async t => {
    let queries = 0, active = 0, maxActive = 0;
    const f = await fixture(t, { queryProcessIdentity: async pid => {
      queries++; active++; maxActive = Math.max(maxActive, active);
      try {
        if (queries === 3) {
          if (unavailable === 'throws') throw new Error('controlled unavailable');
          return undefined;
        }
        return { pid, executablePath: EXE, creationTime100ns: queries === 1 ? A : B };
      } finally { active--; }
    } });
    await f.start(); const owner = await f.raw(); owner.authorize('owner');
    await until(() => owner.messages.some(x => x.disposition === 'injection-owner'), 'grant');
    const before = fs.readFileSync(f.claimPath, 'utf8');
    const socket = await authenticate(t, f);
    await until(() => owner.messages.some(x => x.type === 'game.process'), 'authenticate');
    socket.destroy();
    await until(() => owner.messages.some(x => x.type === 'game.process.transport-lost'), 'lost');
    const waiter = await f.raw(); waiter.authorize('waiter');
    await until(() => queries >= 5 || waiter.messages.some(x => x.type === 'broker.error'), 'later observation');
    await delay(25);
    assert.ok(waiter.messages.some(x => x.type === 'broker.error' && x.requestId === 'waiter'), 'confirmed mismatch must settle the correlated waiter');
    assert.equal(fs.readFileSync(f.claimPath, 'utf8'), before);
    assert.equal(waiter.messages.filter(x => x.type === 'broker.target.authorized').length, 0);
    assert.equal(owner.messages.filter(x => x.type === 'game.process.disconnected').length, 0);
    assert.equal(maxActive, 1);
  });
}

test('replacement host does not reuse retired host in-flight identity observation', { timeout: 6000 }, async t => {
  let queries = 0, release, alive = true;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { runtimeProviderElectionWindowMs: 50, isProcessAlive: () => alive, queryProcessIdentity: async pid => {
    const call = ++queries;
    if (call === 2) await held;
    return { pid, executablePath: EXE, creationTime100ns: call <= 2 ? A : B };
  } });
  await f.seed(); await f.start();
  const first = await f.raw(); first.authorize('old');
  await until(() => queries === 2, 'old held capture');
  const oldHost = f.server.targets.get(f.pid);
  assert.equal(oldHost.authorizationPending, true);
  alive = false; await oldHost.pollFrozenTargetExit();
  await until(() => !f.server.targets.has(f.pid), 'authoritative exit retirement');
  alive = true;
  const second = await f.raw(); second.authorize('new');
  await until(() => f.server.targets.has(f.pid), 'replacement host');
  await delay(90);
  const freshQueries = queries;
  release();
  await until(() => second.messages.some(x => x.type === 'broker.target.authorized'), 'replacement grant');
  assert.equal(freshQueries, 3, 'replacement must launch a fresh observation, not reuse retired host promise');
  assert.equal(f.readClaim().creationTime100ns, B);
});

for (const queryToHold of [3, 4]) for (const action of ['reconnect', 'dispose', 'replace']) for (const outcome of ['success', 'rejection']) {
  test(`held host confirmation ${queryToHold} ignores late ${outcome} after ${action}`, { timeout: 6000 }, async t => {
    let queries = 0, resolve, reject;
    const held = new Promise((yes, no) => { resolve = yes; reject = no; });
    const f = await fixture(t, { queryProcessIdentity: async pid => {
      const call = ++queries;
      if (call === queryToHold) return held;
      if (call === 3 && queryToHold === 4) return undefined;
      return { pid, executablePath: EXE, creationTime100ns: call === 1 ? A : B };
    } });
    await f.start(); const owner = await f.raw(); owner.authorize('owner');
    await until(() => owner.messages.some(x => x.disposition === 'injection-owner'), 'grant');
    const native = await authenticate(t, f);
    await until(() => owner.messages.some(x => x.type === 'game.process'), 'authenticate');
    native.destroy();
    await until(() => owner.messages.some(x => x.type === 'game.process.transport-lost'), 'lost');
    const waiter = await f.raw(); waiter.authorize('waiter');
    await until(() => queries >= queryToHold, 'host confirmation held');
    const host = f.server.targets.get(f.pid);
    const before = fs.readFileSync(f.claimPath, 'utf8');
    if (action === 'reconnect') {
      await authenticate(t, f);
      await until(() => waiter.messages.some(x => x.disposition === 'joined-existing'), 'rejoined');
    } else if (action === 'dispose') await f.server.stop();
    else {
      f.server.retireTerminalTarget(host);
      const replacement = await f.raw(); replacement.authorize('replacement');
      await until(() => f.server.targets.get(f.pid) && f.server.targets.get(f.pid) !== host, 'host replaced');
      await until(() => waiter.messages.some(x => x.type === 'broker.error'), 'retirement error delivered');
    }
    const errorsBeforeRelease = waiter.messages.filter(x => x.type === 'broker.error').length;
    if (outcome === 'rejection') reject(new Error('late controlled rejection'));
    else resolve({ pid: f.pid, executablePath: EXE, creationTime100ns: B });
    await delay(50);
    assert.equal(host.processIdentityFailure, undefined);
    assert.equal(waiter.messages.filter(x => x.type === 'broker.error').length, errorsBeforeRelease);
    assert.equal(waiter.messages.filter(x => x.disposition === 'injection-owner').length, 0);
    if (action !== 'replace') assert.equal(fs.readFileSync(f.claimPath, 'utf8'), before);
  });
}

async function authenticate(t, f) {
  const record = JSON.parse(fs.readFileSync(f.route, 'utf8'));
  const socket = net.createConnection({ host: record.host, port: record.port });
  t.after(() => socket.destroy()); socket.on('error', () => {});
  await until(() => !socket.connecting, 'native connect');
  socket.write(encodeJsonTransportPacket({ type: 'game.process', protocolVersion: 1, token: record.token, pid: f.pid, path: EXE }));
  return socket;
}

test('new legacy-v1 external winner captures broker-owned identity before publication', { timeout: 5000 }, async t => {
  let queries = 0;
  const f = await fixture(t, { queryProcessIdentity: async pid => { queries++; return { pid, executablePath: EXE, creationTime100ns: A }; } });
  await f.start(); const c = await f.raw(); c.authorize('new');
  await until(() => c.messages.some(x => x.type === 'broker.target.authorized'), 'grant');
  assert.ok(queries >= 1, 'broker-owned OS identity probe must run for external winner');
  assert.equal(f.readClaim().creationTime100ns, A);
});

test('known claim mismatch rejects concurrent recovery members without publication or cleanup', { timeout: 5000 }, async t => {
  let release, queries = 0;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { queryProcessIdentity: async pid => { queries++; await held; return { pid, executablePath: EXE, creationTime100ns: B }; } });
  await f.seed(); const before = fs.readFileSync(f.claimPath, 'utf8');
  const routeBefore = fs.readFileSync(f.route, 'utf8');
  await f.start(); const first = await f.raw(); first.authorize('first');
  await until(() => queries > 0, 'held identity query');
  const second = await f.raw(); second.authorize('second');
  await until(() => f.server.targets.get(f.pid).members.size === 2, 'second admitted');
  assert.equal(queries, 1, 'one in-flight target probe'); release();
  await until(() => [first, second].every(c => c.messages.some(x => x.type === 'broker.error' && /identity/i.test(x.message))), 'correlated identity errors');
  assert.equal(fs.readFileSync(f.claimPath, 'utf8'), before);
  assert.equal(fs.readFileSync(f.route, 'utf8'), routeBefore);
  assert.equal([...first.messages, ...second.messages].filter(x => x.type === 'broker.target.authorized').length, 0);
  const late = await f.raw(); late.authorize('late');
  await until(() => late.messages.some(x => x.type === 'broker.error' && x.requestId === 'late'), 'future correlated failure');
});

test('transport-lost instance mismatch settles SDK recovery waiter without a disconnected event', { timeout: 7000 }, async t => {
  let time = A;
  const f = await fixture(t, { queryProcessIdentity: async pid => ({ pid, executablePath: EXE, creationTime100ns: time }) });
  await f.start(); const owner = await f.raw(); owner.authorize('owner');
  await until(() => owner.messages.some(x => x.disposition === 'injection-owner'), 'first grant');
  const record = JSON.parse(fs.readFileSync(f.route, 'utf8'));
  const socket = net.createConnection({ host: record.host, port: record.port });
  t.after(() => socket.destroy()); socket.on('error', () => {});
  await until(() => !socket.connecting, 'native connect');
  socket.write(encodeJsonTransportPacket({ type: 'game.process', protocolVersion: 1, token: record.token, pid: f.pid, path: EXE }));
  await until(() => owner.messages.some(x => x.type === 'game.process'), 'authenticate');
  socket.destroy();
  await until(() => owner.messages.some(x => x.type === 'game.process.transport-lost'), 'transport loss');
  const client = new OverlayBrokerClient({ pipePath: f.server.pipePath, spawnBroker() {} });
  t.after(() => client.stop()); client.start(); await client.whenReady();
  const authorization = client.authorizeTarget(f.pid, f.route, EXE);
  const outcome = authorization.then(() => 'authorized', error => error.message);
  time = B;
  const result = await Promise.race([outcome, delay(3500).then(() => 'pending')]);
  assert.match(result, /identity/i, 'lost-state identity failure must settle pending authorization');
  assert.equal(f.readClaim().creationTime100ns, A);
  assert.equal(owner.messages.filter(x => x.disposition === 'injection-owner').length, 1);
  assert.equal(owner.messages.filter(x => x.type === 'game.process.disconnected').length, 0);
});

for (const unavailable of ['missing', 'throws', 'malformed']) {
  test(`known claim retains ownership when probe is ${unavailable}`, { timeout: 5000 }, async t => {
    const f = await fixture(t, { queryProcessIdentity: async pid => {
      if (unavailable === 'throws') throw new Error('controlled denied');
      return { pid, executablePath: EXE, ...(unavailable === 'missing' ? {} : { creationTime100ns: '01' }) };
    } });
    await f.seed(); const before = fs.readFileSync(f.claimPath, 'utf8');
    await f.start(); const c = await f.raw(); c.authorize('unavailable');
    await until(() => c.messages.some(x => x.type === 'broker.error'), 'unknown identity failure');
    assert.equal(fs.readFileSync(f.claimPath, 'utf8'), before);
    assert.equal(c.messages.filter(x => x.type === 'broker.target.authorized').length, 0);
  });
}

test('legacy published claim is never backfilled from a successful modern probe', { timeout: 5000 }, async t => {
  const f = await fixture(t, { queryProcessIdentity: async pid => ({ pid, executablePath: EXE, creationTime100ns: B }) });
  await f.seed(undefined); assert.equal(f.readClaim().creationTime100ns, undefined);
  await f.start(); const c = await f.raw(); c.authorize('legacy');
  await until(() => f.readClaim().record.port !== 0 && f.server.targets.get(f.pid)?.authorizationRelease, 'recovery publication');
  assert.equal(f.readClaim().creationTime100ns, undefined);
  assert.equal(c.messages.filter(x => x.type === 'broker.target.authorized').length, 0);
});

test('disposal while initial OS query is held ignores the late response', { timeout: 5000 }, async t => {
  let release, entered = false;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { queryProcessIdentity: async pid => { entered = true; await pending; return { pid, executablePath: EXE, creationTime100ns: A }; } });
  await f.start(); const c = await f.raw(); c.authorize('disposed');
  await until(() => entered, 'query entered'); await f.server.stop(); release();
  await delay(30); assert.equal(fs.existsSync(f.claimPath), false);
  assert.equal(fs.existsSync(f.route), false);
});

test('frozen A capture then PID-only grant consumption by B never permits a second grant', { timeout: 7000 }, async t => {
  let time = A;
  const f = await fixture(t, { queryProcessIdentity: async pid => ({ pid, executablePath: EXE, creationTime100ns: time }) });
  await f.start(); const owner = await f.raw(); owner.authorize('original');
  await until(() => owner.messages.some(x => x.disposition === 'injection-owner'), 'original grant');
  const before = fs.readFileSync(f.claimPath, 'utf8'); time = B;
  // The old injector may consume this already-issued PID-only grant in B.
  const late = await f.raw(); late.authorize('replacement');
  await until(() => late.messages.some(x => x.type === 'broker.error'), 'frozen identity mismatch');
  assert.equal(fs.readFileSync(f.claimPath, 'utf8'), before);
  assert.equal([...owner.messages, ...late.messages].filter(x => x.disposition === 'injection-owner').length, 1);
});

test('bound cached-provider probe is used even when the external provider wins', { timeout: 5000 }, async t => {
  const provider = { calls: 0, createTarget() { return undefined; }, dispose() {},
    async queryProcessIdentity(pid) { this.calls++; return { pid, executablePath: EXE, creationTime100ns: A }; } };
  const f = await fixture(t, { nativeRuntimeProvider: provider });
  await f.start(); const c = await f.raw(); c.authorize('external');
  await until(() => c.messages.some(x => x.disposition === 'injection-owner'), 'external grant');
  assert.equal(provider.calls, 1);
  assert.equal(f.readClaim().creationTime100ns, A);
});

test('reconnection invalidates a held lost-state identity result', { timeout: 6000 }, async t => {
  let queries = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { queryProcessIdentity: async pid => {
    queries++;
    if (queries > 1) { await held; return { pid, executablePath: EXE, creationTime100ns: B }; }
    return { pid, executablePath: EXE, creationTime100ns: A };
  } });
  await f.start(); const c = await f.raw(); c.authorize('first');
  await until(() => c.messages.some(x => x.disposition === 'injection-owner'), 'grant');
  const record = JSON.parse(fs.readFileSync(f.route, 'utf8'));
  async function connect() {
    const socket = net.createConnection({ host: record.host, port: record.port });
    t.after(() => socket.destroy()); socket.on('error', () => {});
    await until(() => !socket.connecting, 'native connection');
    socket.write(encodeJsonTransportPacket({ type: 'game.process', protocolVersion: 1, token: record.token, pid: f.pid, path: EXE }));
    return socket;
  }
  const first = await connect();
  await until(() => c.messages.some(x => x.type === 'game.process'), 'first authentication');
  first.destroy(); await until(() => queries > 1, 'held lost probe');
  const waiter = await f.raw(); waiter.authorize('waiter'); await connect();
  await until(() => waiter.messages.some(x => x.disposition === 'joined-existing'), 'reauthentication');
  release(); await delay(40);
  assert.equal(waiter.messages.filter(x => x.type === 'broker.error').length, 0);
  assert.equal(f.readClaim().creationTime100ns, A);
});

test('matching known claim republishes pinned route and joins only after authentication', { timeout: 5000 }, async t => {
  const f = await fixture(t, { queryProcessIdentity: async pid => ({ pid, executablePath: EXE, creationTime100ns: A }) });
  await f.seed(); await f.start(); const c = await f.raw(); c.authorize('matching');
  await until(() => f.server.targets.get(f.pid)?.authorizationRelease, 'pinned recovery publication');
  assert.equal(c.messages.filter(x => x.type === 'broker.target.authorized').length, 0);
  const record = JSON.parse(fs.readFileSync(f.route, 'utf8'));
  const socket = net.createConnection({ host: record.host, port: record.port });
  t.after(() => socket.destroy()); socket.on('error', () => {});
  await until(() => !socket.connecting, 'matching native connect');
  socket.write(encodeJsonTransportPacket({ type: 'game.process', protocolVersion: 1, token: record.token, pid: f.pid, path: EXE }));
  await until(() => c.messages.some(x => x.disposition === 'joined-existing'), 'matching join');
  assert.equal(f.readClaim().creationTime100ns, A);
  assert.equal(c.messages.filter(x => x.disposition === 'injection-owner').length, 0);
});
