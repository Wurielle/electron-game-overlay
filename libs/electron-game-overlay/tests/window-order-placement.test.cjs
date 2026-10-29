const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const Module = require('node:module');
const ts = require('typescript');

// Execute current source without changing package build output or native code.
const source = path.resolve(__dirname, '../src/lib');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name).exports;
  const filename = path.join(source, `${name}.ts`);
  const mod = new Module(filename, module);
  cache.set(name, mod);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(source);
  mod.require = id => id.startsWith('./') && id.endsWith('.js')
    ? load(id.slice(2, -3)) : module.require(id);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return mod.exports;
}
const { OverlayLoopbackTransport, encodeJsonTransportPacket } = load('overlay-loopback-transport');
const { OverlayBrokerTargetHost } = load('overlay-broker-server');
const CAP = 'window-order-v1';
const details = (name, x = 10) => ({ name, transparent: true,
  rect: { x, y: 20, width: 1, height: 1 }, caption: { left: 0, right: 0, top: 0, height: 1 } });
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'private socket deadline');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
async function fixture(t) {
  const sockets = [];
  let root;
  let transport;
  t.after(async () => {
    sockets.forEach(socket => socket.destroy());
    transport?.stop();
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });
  root = await fsp.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'ego-window-order-'));
  transport = new OverlayLoopbackTransport({ discoveryPath: path.join(root, 'global.json'), isProcessAlive: () => true });
  transport.start();
  const record = await transport.whenReady();
  async function peer(pid, capabilities) {
    const socket = net.createConnection({ host: '127.0.0.1', port: record.port });
    sockets.push(socket);
    const packets = [];
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5 && pending.length >= pending.readUInt32LE(0) + 5) {
        const length = pending.readUInt32LE(0);
        packets.push(pending[4] === 1 ? JSON.parse(pending.subarray(5, 5 + length)) : {
          type: 'frame', windowId: pending.readUInt32LE(5), pixels: [...pending.subarray(17, 5 + length)],
        });
        pending = pending.subarray(5 + length);
      }
    });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write(encodeJsonTransportPacket({ type: 'game.process', protocolVersion: 1,
      token: record.token, pid, path: 'C:\\Controlled\\Game.exe',
      ...(capabilities === undefined ? {} : { capabilities }) }));
    await waitFor(() => packets.some(packet => packet.type === 'overlay.init'));
    return { socket, packets };
  }
  async function flush(peers) {
    const counts = peers.map(peer => peer.packets.filter(p => p.type === 'command.input.intercept').length);
    transport.setInputIntercept(false);
    await waitFor(() => peers.every((peer, i) => peer.packets.filter(p => p.type === 'command.input.intercept').length > counts[i]));
  }
  return { transport, peer, flush };
}

test('capable authenticated socket inserts only its window and retains complete ordered snapshot and frames', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.transport.addWindow(2, details('survivor', 22));
  f.transport.sendFrameBuffer(2, Buffer.from([1, 2, 3, 4]), 1, 1);
  const peer = await f.peer(51001, [CAP]);
  peer.packets.length = 0;
  assert.equal(f.transport.addWindowInOrder?.(1, details('restored'), [1, 2]), true,
    'explicit capable native peer must permit placement-preserving insertion');
  await f.flush([peer]);
  assert.deepEqual(peer.packets.filter(p => p.type !== 'command.input.intercept'), [
    { type: 'window', windowId: 1, ...details('restored') },
    { type: 'window.order', windowIds: [1, 2] },
  ]);
  f.transport.sendFrameBuffer(1, Buffer.from([5, 6, 7, 8]), 1, 1);
  await f.flush([peer]);
  peer.packets.length = 0;
  assert.equal(f.transport.addWindowInOrder(1, details('updated', 77), [2, 1]), true);
  await f.flush([peer]);
  assert.deepEqual(peer.packets.filter(p => p.type !== 'command.input.intercept').map(p => p.type), ['window', 'window.order']);
  const reconnected = await f.peer(51001, [CAP]);
  assert.deepEqual(reconnected.packets[0].windows.map(w => [w.windowId, w.rect.x]), [[2, 22], [1, 77]]);
  await f.flush([reconnected]);
  assert.deepEqual(reconnected.packets.filter(p => p.type === 'frame').sort((a, b) => a.windowId - b.windowId), [
    { type: 'frame', windowId: 1, pixels: [5, 6, 7, 8] },
    { type: 'frame', windowId: 2, pixels: [1, 2, 3, 4] },
  ]);
});

for (const mode of ['capable', 'legacy', 'mixed', 'no-method']) test(`broker older-token restoration uses exact ${mode} native path`, { timeout: 10000 }, async t => {
  const f = await fixture(t);
  // Control only route publication; real host scene routing and native sockets run.
  f.transport.authorizeTarget = async () => () => {};
  if (mode === 'no-method') f.transport.addWindowInOrder = undefined;
  const host = new OverlayBrokerTargetHost(51002, f.transport, 0, () => true, 250,
    undefined, () => undefined, () => {}, () => {}, () => {}, () => {});
  t.after(() => host.dispose());
  const messages = [];
  const client = { id: 'member', closed: false, inputIntercept: false,
    hello: { type: 'broker.hello', protocolMin: 1, protocolMax: 1,
      requiredCapabilities: load('overlay-broker-protocol').OVERLAY_BROKER_CAPABILITIES,
      clientPid: 51003, sdkVersion: 'controlled' },
    windows: new Map(), targets: new Map(), send: message => messages.push(message) };
  const state = (name, token, pixel) => ({ details: details(name), orderToken: token,
    snapshotBytes: 100, latestFrame: { pixels: Buffer.from([pixel, 0, 0, 255]), width: 1, height: 1 } });
  client.windows.set(20, state('survivor', '00000000000000000000000000000020', 20));
  host.addMember(client, { type: 'broker.target.authorize', requestId: 'owned',
    pid: 51002, discoveryPath: path.resolve(process.env.TMPDIR || os.tmpdir(), 'controlled-order.json') });
  await waitFor(() => messages.some(m => m.type === 'broker.target.authorized'));
  const peer = await f.peer(51002, mode === 'legacy' ? undefined : [CAP]);
  if (mode === 'mixed') await f.peer(51004);
  await f.flush([peer]);
  const survivorId = peer.packets.find(p => p.type === 'window' && p.name === 'survivor').windowId;
  peer.packets.length = 0;
  const restored = state('restored', '00000000000000000000000000000010', 10);
  client.windows.set(10, restored);
  host.upsertWindow(client, 10, restored);
  await f.flush([peer]);
  const publications = peer.packets.filter(p => p.type !== 'command.input.intercept');
  assert.deepEqual(publications.filter(p => p.type === 'window').map(p => p.name),
    mode === 'capable' ? ['restored'] : ['restored', 'survivor'],
    'capable replay must preserve survivor placement; fallback must retain exact v1 replay');
  const restoredId = publications.find(p => p.type === 'window').windowId;
  assert.deepEqual(publications.find(p => p.type === 'window.order'), mode === 'capable'
    ? { type: 'window.order', windowIds: [restoredId, survivorId] } : undefined);
  assert.deepEqual(publications.filter(p => p.type === 'frame').map(p => p.windowId),
    mode === 'capable' ? [restoredId] : [restoredId, survivorId]);
  peer.packets.length = 0;
  host.updateWindowBounds(client, 20, { rect: { x: 99, y: 20, width: 1, height: 1 } });
  await f.flush([peer]);
  assert.deepEqual(peer.packets.find(p => p.type === 'window.bounds').rect, { x: 99, y: 20, width: 1, height: 1 });
  const next = await f.peer(51002, [CAP]);
  assert.deepEqual(next.packets[0].windows.map(w => w.windowId), [restoredId, survivorId]);
});

test('invalid full orders fail atomically without metadata, frames, or snapshot mutation', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.transport.addWindow(2, details('survivor', 22));
  f.transport.sendFrameBuffer(2, Buffer.from([1, 2, 3, 4]), 1, 1);
  const peer = await f.peer(51010, [CAP]);
  await f.flush([peer]);
  peer.packets.length = 0;
  for (const ids of [[1, 1], [1], [1, 3], [1, 2, 3], []]) {
    assert.equal(f.transport.addWindowInOrder(1, details('invalid'), ids), false, JSON.stringify(ids));
  }
  await f.flush([peer]);
  assert.deepEqual(peer.packets.filter(p => p.type !== 'command.input.intercept'), []);
  const next = await f.peer(51011, [CAP]);
  await f.flush([next]);
  assert.deepEqual(next.packets[0].windows.map(w => [w.windowId, w.rect.x]), [[2, 22]]);
  assert.deepEqual(next.packets.filter(p => p.type === 'frame'), [{ type: 'frame', windowId: 2, pixels: [1, 2, 3, 4] }]);
});

for (const hole of ['leading', 'trailing']) test(`sparse ${hole} hole order rejects atomically`, { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.transport.addWindow(2, details('survivor', 22));
  f.transport.sendFrameBuffer(2, Buffer.from([1, 2, 3, 4]), 1, 1);
  const peer = await f.peer(51012, [CAP]);
  await f.flush([peer]);
  const client = [...f.transport.clients].find(client => client.authenticated);
  client.writer.blocked = true;
  f.transport.sendFrameBuffer(2, Buffer.from([5, 6, 7, 8]), 1, 1);
  const before = structuredClone({
    windows: [...f.transport.windows], frames: [...f.transport.latestFrames],
    pending: client.writer.pending, pendingBytes: client.writer.pendingBytes,
    packets: peer.packets,
  });
  const ids = Array(2);
  ids[hole === 'leading' ? 1 : 0] = 1;
  let result;
  assert.doesNotThrow(() => { result = f.transport.addWindowInOrder(1, details('invalid'), ids); });
  assert.equal(result, false);
  assert.deepEqual(structuredClone({
    windows: [...f.transport.windows], frames: [...f.transport.latestFrames],
    pending: client.writer.pending, pendingBytes: client.writer.pendingBytes,
    packets: peer.packets,
  }), before);
  client.writer.handleDrain();
  await f.flush([peer]);
  const next = await f.peer(51013, [CAP]);
  await f.flush([next]);
  assert.deepEqual(next.packets[0].windows, [{ windowId: 2, ...details('survivor', 22) }]);
  assert.deepEqual(next.packets.filter(p => p.type === 'frame'), [
    { type: 'frame', windowId: 2, pixels: [5, 6, 7, 8] },
  ]);
});

test('capabilities require explicit known string on each authenticated connection, not later events', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.transport.addWindow(2, details('survivor'));
  assert.equal(f.transport.addWindowInOrder(1, details('none'), [1, 2]), false);
  for (const caps of [undefined, [], ['window-order-v2'], 'window-order-v1', [true], [{ name: CAP }]]) {
    const peer = await f.peer(51020, caps);
    await f.flush([peer]);
    peer.packets.length = 0;
    assert.equal(f.transport.addWindowInOrder(1, details('unsupported'), [1, 2]), false);
    peer.socket.write(encodeJsonTransportPacket({ type: 'game.capabilities', capabilities: [CAP] }));
    await f.flush([peer]);
    assert.equal(f.transport.addWindowInOrder(1, details('still-unsupported'), [1, 2]), false);
    assert.deepEqual(peer.packets.filter(p => p.type !== 'command.input.intercept'), []);
  }
  const capable = await f.peer(51020, [CAP, 'unknown-future']);
  assert.equal(f.transport.addWindowInOrder(1, details('capable'), [1, 2]), true);
  await f.flush([capable]);
  // Replace a capable connection before its old socket close callback runs.
  const reset = await f.peer(51020);
  await f.flush([reset]);
  reset.packets.length = 0;
  assert.equal(f.transport.addWindowInOrder(1, details('must-not-change', 99), [2, 1]), false);
  await f.flush([reset]);
  assert.deepEqual(reset.packets.filter(p => p.type !== 'command.input.intercept'), []);
  const snapshot = await f.peer(51020, [CAP]);
  assert.deepEqual(snapshot.packets[0].windows.map(w => [w.windowId, w.name]), [[1, 'capable'], [2, 'survivor']]);
});

test('capability is effective before snapshot delivery and synchronous game.process materialization', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const results = [];
  const snapshot = f.transport.sendAuthenticatedSnapshot.bind(f.transport);
  f.transport.sendAuthenticatedSnapshot = client => {
    results.push(f.transport.addWindowInOrder(1, details('before-snapshot'), [1]));
    snapshot(client);
  };
  f.transport.setEventCallback(event => {
    if (event === 'game.process') results.push(f.transport.addWindowInOrder(1, details('during-event'), [1]));
  });
  const peer = await f.peer(51030, [CAP]);
  await f.flush([peer]);
  assert.deepEqual(results, [true, true]);
  assert.equal(peer.packets.find(p => p.type === 'overlay.init').windows[0].name, 'before-snapshot');
  assert.deepEqual(peer.packets.filter(p => p.type === 'window').map(p => p.name), ['before-snapshot', 'during-event']);
});
