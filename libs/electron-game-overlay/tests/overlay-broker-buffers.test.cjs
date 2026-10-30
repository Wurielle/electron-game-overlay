const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createConnection } = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { OverlayBrokerServer } = require('../dist/lib/overlay-broker-server.js');
const { BrokerPacketDecoder, OVERLAY_BROKER_REQUIRED_CAPABILITIES, encodeBrokerJsonPacket } = require('../dist/lib/overlay-broker-protocol.js');

const waitFor = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for buffer fixture');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const details = (name = 'window') => ({ name, transparent: true, rect: { x: 0, y: 0, width: 2, height: 1 } });
const fixture = async (t) => {
  const server = new OverlayBrokerServer({ pipePath: process.platform === 'win32' ? `\\\\.\\pipe\\buffer-${randomUUID()}` : join(tmpdir(), `buffer-${randomUUID()}.sock`), idleShutdownMs: false, targetRecoveryClaimProbe: () => undefined });
  const sockets = [];
  t.after(async () => { sockets.forEach((socket) => socket.destroy()); await server.stop(); });
  await server.start();
  const client = async () => {
    const socket = createConnection(server.pipePath);
    sockets.push(socket);
    const decoder = new BrokerPacketDecoder();
    const messages = [];
    socket.on('data', (chunk) => { for (const packet of decoder.push(chunk)) messages.push(packet.value); });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const send = (message) => socket.write(encodeBrokerJsonPacket(message));
    send({ type: 'broker.hello', protocolMin: 1, protocolMax: 1, requiredCapabilities: OVERLAY_BROKER_REQUIRED_CAPABILITIES, clientPid: process.pid, sdkVersion: '0.0.1' });
    await waitFor(() => messages.some(({ type }) => type === 'broker.welcome'));
    const session = Array.from(server.clients).find((session) => session.id === messages.find(({ type }) => type === 'broker.welcome').sessionId);
    return { socket, messages, send, session, upsert: (windowId, name) => send({ type: 'broker.window.upsert', windowId, ...details(name) }) };
  };
  return { server, client };
};

test('broker rejects only the scene mutation that would make aggregate v1 recovery unencodable', async (t) => {
  const { client } = await fixture(t);
  const first = await client();
  const second = await client();
  for (let id = 1; id <= 450; id += 1) first.upsert(id, 'a'.repeat(1024));
  await waitFor(() => first.session.windows.size === 450);
  for (let id = 1; id <= 550; id += 1) second.upsert(id, 'b'.repeat(1024));
  await waitFor(() => second.session.windows.has(550) || second.messages.some(({ type }) => type === 'broker.error'));
  assert.equal(second.session.windows.has(550), false, 'aggregate overflow must be rejected before retaining window 550');
  await waitFor(() => second.messages.some(({ type }) => type === 'broker.error'));
  assert.match(second.messages.at(-1).message, /1048576/);
  assert.equal(second.session.windows.has(550), false);
  assert.equal(first.messages.some(({ type }) => type === 'broker.error'), false);
  assert.equal(first.socket.destroyed, false);
  const size = second.session.windows.size;
  second.send({ type: 'broker.window.close', windowId: 1 });
  second.upsert(550, 'small recovery');
  await waitFor(() => second.session.windows.has(550));
  assert.equal(second.session.windows.size, size);
});

test('broker bounds admission keeps the aggregate recoverable before mutating retained metadata', async (t) => {
  const { client } = await fixture(t);
  const peer = await client();
  for (let id = 1; id <= 937; id += 1) peer.upsert(id, 'x'.repeat(1024));
  await waitFor(() => peer.session.windows.size === 937);
  for (let id = 1; id <= 100; id += 1) peer.send({ type: 'broker.window.bounds', windowId: id, rect: { x: -2147483648, y: -2147483648, width: 2147483647, height: 2147483647 } });
  peer.send({ type: 'broker.input.intercept', intercept: true });
  await waitFor(() => peer.session.inputIntercept);
  assert.equal(peer.session.windows.get(100).details.rect.x, 0, 'the mutation exceeding the aggregate cap must not be retained');
  await waitFor(() => peer.messages.some(({ type }) => type === 'broker.error'));
  assert.match(peer.messages.at(-1).message, /snapshot.*1048576/i);
});

test('broker retained-frame admission is aggregate across peers and precedes the retained copy', async (t) => {
  const { server, client } = await fixture(t);
  const first = await client();
  const second = await client();
  first.upsert(1); first.upsert(2); second.upsert(1); second.upsert(2);
  await waitFor(() => first.session.windows.size === 2 && second.session.windows.size === 2);
  const pixels = Buffer.alloc(64 * 1024 * 1024);
  const frame = (windowId) => ({ windowId, width: 4096, height: 4096, pixels });
  server.handleFrame(first.session, frame(1));
  server.handleFrame(first.session, frame(2));
  server.handleFrame(second.session, frame(1));
  let copies = 0;
  const from = Buffer.from;
  Buffer.from = (...args) => { if (args[0] === pixels) copies += 1; return from(...args); };
  try { server.handleFrame(second.session, frame(2)); } finally { Buffer.from = from; }
  assert.equal(second.session.windows.get(2).latestFrame === undefined, true, 'overflow must not retain another frame');
  assert.equal(copies, 0);
  await waitFor(() => second.messages.some(({ type }) => type === 'broker.error'));
  assert.match(second.messages.at(-1).message, /retained frame.*268435456/i);
  assert.equal(first.messages.some(({ type }) => type === 'broker.error'), false);
  first.send({ type: 'broker.window.close', windowId: 1 });
  await waitFor(() => !first.session.windows.has(1));
  server.handleFrame(second.session, frame(2));
  assert.equal(second.session.windows.get(2).latestFrame.pixels.byteLength, pixels.byteLength);
});

test('an outbound encode overflow is contained to its socket and releases that peer scene', async (t) => {
  const { server, client } = await fixture(t);
  const first = await client();
  const second = await client();
  first.upsert(1);
  await waitFor(() => first.session.windows.has(1));
  assert.doesNotThrow(() => first.session.send({ type: 'game.fixture', text: 'x'.repeat(1024 * 1024) }));
  await waitFor(() => first.socket.destroyed && !server.clients.has(first.session));
  assert.equal(first.session.windows.size, 0);
  second.session.send({ type: 'game.fixture', value: 'healthy' });
  await waitFor(() => second.messages.some(({ value }) => value === 'healthy'));
  assert.equal(second.socket.destroyed, false);
});

test('pending overflow reports its error on only the stalled socket and cleans its scene', async (t) => {
  const { server, client } = await fixture(t);
  const first = await client();
  const second = await client();
  first.upsert(1);
  await waitFor(() => first.session.windows.has(1));
  const errors = [];
  first.session.socket.on('error', (error) => errors.push(error));
  first.session.socket.write = () => false;
  first.session.writer.maxPendingBytes = 32;
  first.session.send({ type: 'game.fixture', value: 'blocked' });
  first.session.send({ type: 'game.fixture', value: 'over budget' });
  await waitFor(() => first.socket.destroyed && !server.clients.has(first.session));
  assert.equal(errors.length, 1, 'the offending socket must receive the overflow cause');
  assert.equal(errors[0].code, 'ERR_OVERLAY_QUEUE_LIMIT');
  assert.equal(first.session.writer.pendingBytes, 0);
  assert.equal(first.session.windows.size, 0);
  second.session.send({ type: 'game.fixture', value: 'after overflow' });
  await waitFor(() => second.messages.some(({ value }) => value === 'after overflow'));
  assert.equal(second.socket.destroyed, false);
});

test('an overflowed peer cannot publish later packets from the same inbound batch', async (t) => {
  const { server, client } = await fixture(t);
  const peer = await client();
  peer.session.socket.write = () => false;
  peer.session.writer.maxPendingBytes = 10;
  server.receiveClientData(peer.session, Buffer.concat([
    encodeBrokerJsonPacket({ type: 'broker.target.release', requestId: 'a', pid: 123 }),
    encodeBrokerJsonPacket({ type: 'broker.target.release', requestId: 'b', pid: 123 }),
    encodeBrokerJsonPacket({ type: 'broker.window.upsert', windowId: 7, ...details() }),
  ]));
  assert.equal(peer.session.socket.destroyed, true);
  assert.equal(peer.session.windows.size, 0, 'dispatch must stop immediately after socket overflow');
});

test('closing a peer releases an incomplete inbound frame as well as its scene', async (t) => {
  const { server, client } = await fixture(t);
  const peer = await client();
  const prefix = Buffer.alloc(128);
  prefix.writeUInt32LE(1036, 0);
  prefix.writeUInt8(2, 4);
  peer.socket.write(prefix);
  await waitFor(() => peer.session.decoder.buffer.byteLength === 128);
  peer.socket.destroy();
  await waitFor(() => !server.clients.has(peer.session));
  assert.equal(peer.session.decoder.buffer.byteLength, 0);
});
