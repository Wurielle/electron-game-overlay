const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CooperativeOverlayTransport } = require('../dist/lib/cooperative-overlay-transport.js');
const { ElectronGameOverlay } = require('../dist/lib/electron-game-overlay.js');
const { encodeJsonTransportPacket } = require('../dist/lib/overlay-loopback-transport.js');
const { inputCapabilitiesFromTokens } = require('../dist/lib/input-capabilities.js');
const PID = 0x7fffdc17, IMAGE = 'C:\\Games\\capability-target.exe', CREATED = '9007199254740993';
const WM = ['input-capabilities-v1', 'copied-wm-input-v1'];
const RAW = [...WM, 'copied-raw-input-buffer-v1'];
const identity = ['process-instance-hello-v1'];
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw Error('Timed out waiting for capability transport');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t, requiredInputCapabilities) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ego-input-capabilities-'));
  const transport = new CooperativeOverlayTransport({ directory, requiredInputCapabilities, isProcessAlive: () => true });
  const events = [], diagnostics = [], sockets = [];
  transport.setEventCallback((type, payload) => events.push({ type, payload }));
  transport.setDiagnosticCallback(diagnostic => diagnostics.push(diagnostic));
  transport.start();
  await transport.whenReady();
  t.after(async () => {
    for (const peer of sockets) peer.socket.destroy();
    transport.stop();
    await rm(directory, { recursive: true, force: true });
  });
  async function connect(capabilities, { pid = PID, token, image = IMAGE, created = CREATED } = {}) {
    const stage = path.join(directory, `stage-${pid}`);
    const discovery = path.join(stage, 'electron-overlay-transport-v1.json');
    await transport.authorizeTarget(pid, discovery, IMAGE, undefined, undefined, CREATED);
    const record = JSON.parse(await readFile(discovery, 'utf8'));
    const socket = net.createConnection({ host: '127.0.0.1', port: record.port });
    const peer = { socket, bytes: [], closed: false, discovery };
    sockets.push(peer);
    socket.on('error', () => {});
    socket.on('data', bytes => peer.bytes.push(bytes));
    socket.on('close', () => { peer.closed = true; });
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(encodeJsonTransportPacket({ type: 'game.process', protocolVersion: 1,
      token: token ?? record.token, pid, path: image,
      capabilities: capabilities === undefined ? undefined : [...identity, ...capabilities], creationTime100ns: created }));
    return peer;
  }
  return { transport, events, diagnostics, connect };
}
function jsonPackets(peer) {
  const bytes = Buffer.concat(peer.bytes), packets = [];
  for (let offset = 0; offset + 5 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset), end = offset + 5 + size;
    if (end > bytes.length) break;
    if (bytes[offset + 4] === 1) packets.push(JSON.parse(bytes.subarray(offset + 5, end).toString()));
    offset = end;
  }
  return packets;
}
function publishScene(transport) {
  transport.addWindow(7, { name: 'private-scene', transparent: false, rect: { x: 1, y: 1, width: 1, height: 1 } });
  transport.sendFrameBuffer(7, Buffer.from([10, 20, 30, 255]), 1, 1);
  transport.setInputIntercept(true);
}

test('input capability options validate synchronously and snapshot mutable application requirements', async t => {
  for (const value of ['copied-wm-input', null, ['unknown'], ['copied-wm-input', 1]]) {
    assert.throws(() => new ElectronGameOverlay({ requiredInputCapabilities: value }), /requiredInputCapabilities/);
  }
  const required = ['copied-raw-input-buffer'];
  const f = await fixture(t, required);
  required.length = 0;
  publishScene(f.transport);
  const rejected = await f.connect(WM);
  await until(() => rejected.closed);
  assert.equal(Buffer.concat(rejected.bytes).length, 0);
  assert.equal(f.events.find(event => event.type === 'game.process.input-capabilities-rejected').payload.requiredInputCapabilities[0], 'copied-raw-input-buffer');
});

test('required copied input rejects unsupported or unknown hosts before any scene, frame or interception snapshot', async t => {
  const f = await fixture(t, ['copied-raw-input-buffer']);
  publishScene(f.transport);
  for (const [tokens, support] of [[WM, 'unsupported'], [[], 'unknown'], [['copied-raw-input-buffer-v1'], 'unknown']]) {
    const before = f.events.length;
    const peer = await f.connect(tokens);
    await until(() => peer.closed);
    assert.equal(Buffer.concat(peer.bytes).length, 0, 'rejected private routes receive no snapshot bytes');
    const event = f.events.slice(before).find(event => event.type === 'game.process.input-capabilities-rejected');
    assert.equal(event.payload.inputCapabilities.copiedRawInputBuffer, support);
    assert.ok(Object.isFrozen(event.payload.inputCapabilities));
    assert.ok(Object.isFrozen(event.payload.requiredInputCapabilities));
    assert.equal(f.events.slice(before).some(event => event.type === 'game.process' || event.type === 'game.input.intercept'), false);
  }
  const diagnostic = f.diagnostics.find(diagnostic => diagnostic.code === 'target-input-capability-unsupported');
  assert.equal(diagnostic.severity, 'error');
  assert.deepEqual(diagnostic.context, { capability: 'copied-raw-input-buffer', support: 'unsupported' });
  const claims = f.transport.targetAuthorizationsByPid;
  assert.equal(claims.get(PID).recoveryClaim.phase, 'published', 'capability rejection retains possibly consumed native ownership');
  const accepted = await f.connect(RAW);
  await until(() => jsonPackets(accepted).some(packet => packet.type === 'command.input.intercept'));
  assert.equal(jsonPackets(accepted)[0].type, 'overlay.init');
  assert.deepEqual(f.events.find(event => event.type === 'game.process').payload.inputCapabilities,
    { copiedWmInput: 'supported', copiedRawInputBuffer: 'supported' });
});

test('optional capabilities preserve legacy operation and expose unknown rather than inventing support', async t => {
  const f = await fixture(t, []);
  publishScene(f.transport);
  const legacy = await f.connect([]);
  await until(() => jsonPackets(legacy).some(packet => packet.type === 'command.input.intercept'));
  assert.deepEqual(f.events.find(event => event.type === 'game.process').payload.inputCapabilities,
    { copiedWmInput: 'unknown', copiedRawInputBuffer: 'unknown' });
  const wm = await f.connect([...WM, 'future-optional-v9']);
  await until(() => f.events.filter(event => event.type === 'game.process').length === 2);
  const metadata = f.events.filter(event => event.type === 'game.process').at(-1).payload;
  assert.ok(metadata.capabilities.includes('future-optional-v9'));
  assert.deepEqual(metadata.inputCapabilities, { copiedWmInput: 'supported', copiedRawInputBuffer: 'unsupported' });
  assert.ok(Object.isFrozen(metadata.capabilities));
  assert.deepEqual(inputCapabilitiesFromTokens(['copied-raw-input-buffer-v1']),
    { copiedWmInput: 'unknown', copiedRawInputBuffer: 'unknown' });
});

test('capability denial is private to one producer and cannot retire a good same-PID route or stop another target', async t => {
  const strict = await fixture(t, ['copied-raw-input-buffer']);
  const permissive = await fixture(t, ['copied-wm-input']);
  publishScene(strict.transport); publishScene(permissive.transport);
  const good = await strict.connect(RAW);
  const other = await permissive.connect(WM);
  await until(() => jsonPackets(good).length > 0 && jsonPackets(other).length > 0);
  const badReconnect = await strict.connect(WM);
  await until(() => badReconnect.closed);
  assert.equal(good.closed, false, 'unsupported reconnect cannot retire the retained compatible peer');
  const badOtherTarget = await strict.connect(WM, { pid: PID + 1 });
  await until(() => badOtherTarget.closed);
  strict.transport.setInputIntercept(false); permissive.transport.setInputIntercept(false);
  await until(() => jsonPackets(good).some(packet => packet.type === 'command.input.intercept' && packet.intercept === false) &&
    jsonPackets(other).some(packet => packet.type === 'command.input.intercept' && packet.intercept === false));
  assert.equal(strict.events.filter(event => event.type === 'game.process').length, 1);
  assert.equal(permissive.diagnostics.some(diagnostic => diagnostic.code === 'target-input-capability-unsupported'), false);
});

test('capability rejection diagnostics require valid credentials and exact incarnation first', async t => {
  const f = await fixture(t, ['copied-raw-input-buffer']);
  for (const overrides of [{ token: '00'.repeat(32) }, { created: '9007199254740994' }, { image: 'C:\\wrong.exe' }]) {
    const peer = await f.connect(WM, overrides);
    await until(() => peer.closed);
  }
  assert.equal(f.diagnostics.some(diagnostic => diagnostic.code === 'target-input-capability-unsupported'), false);
  assert.equal(f.events.length, 0, 'unauthenticated guesses cannot synthesize public capability rejection');
});

test('authenticated targets cannot forge transport-owned capability rejection events', async t => {
  const f = await fixture(t, []);
  const peer = await f.connect(RAW);
  await until(() => f.events.some(event => event.type === 'game.process'));
  peer.socket.write(encodeJsonTransportPacket({ type: 'game.process.input-capabilities-rejected',
    pid: PID + 1, path: IMAGE, inputCapabilities: inputCapabilitiesFromTokens(WM),
    requiredInputCapabilities: ['copied-raw-input-buffer'] }));
  await until(() => peer.closed);
  assert.equal(f.events.some(event => event.type === 'game.process.input-capabilities-rejected'), false);
});
