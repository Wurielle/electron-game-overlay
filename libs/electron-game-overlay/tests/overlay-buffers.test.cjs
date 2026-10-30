const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { createConnection } = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  BackpressurePacketQueue,
  OverlayLoopbackTransport,
  MAX_JSON_BODY_BYTES,
  MAX_PENDING_PACKET_BYTES,
  encodeJsonTransportPacket,
} = require('../dist/lib/overlay-loopback-transport.js');

const windowDetails = (name = 'window') => ({
  name,
  transparent: true,
  rect: { x: 0, y: 0, width: 2, height: 1 },
});

test('pending bytes are bounded across windows and control overflow reports instead of dropping input', () => {
  const writes = [];
  const errors = [];
  const queue = new BackpressurePacketQueue({
    write(packet) { writes.push(packet.toString()); return false; },
  }, (error) => errors.push(error), 16);
  queue.sendControl(Buffer.from('blocked'));
  queue.sendFrame(1, Buffer.alloc(8));
  queue.sendFrame(2, Buffer.alloc(8));
  assert.equal(queue.pendingBytes, 16);
  queue.sendFrame(1, Buffer.alloc(4));
  assert.equal(queue.pendingBytes, 12);
  queue.sendControl(Buffer.from('key!'));
  assert.equal(queue.pendingBytes, 16);
  queue.sendControl(Buffer.from('key-up'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /pending.*22.*16/i);
  assert.equal(errors[0].code, 'ERR_OVERLAY_QUEUE_LIMIT');
  assert.equal(queue.pendingBytes, 0);
  assert.equal(queue.pending.length, 0);
  assert.deepEqual(writes, ['blocked']);
  queue.handleDrain();
  queue.sendControl(Buffer.from('must-not-resume'));
  assert.deepEqual(writes, ['blocked'], 'a failed queue cannot resume writes before its socket closes');
});

test('scene admission preserves the frozen v1 init cap at the exact byte boundary', () => {
  const transport = new OverlayLoopbackTransport();
  const metadata = { windowId: 1, ...windowDetails('') };
  const overhead = Buffer.byteLength(JSON.stringify({ type: 'overlay.init', windows: [metadata] }));
  transport.addWindow(1, windowDetails('x'.repeat(MAX_JSON_BODY_BYTES - overhead)));
  const snapshot = () => ({ type: 'overlay.init', windows: Array.from(transport.windows.values(), ({ type, ...rest }) => rest) });
  assert.equal(encodeJsonTransportPacket(snapshot()).byteLength, MAX_JSON_BODY_BYTES + 5);
  assert.throws(() => transport.addWindow(2, windowDetails()), /snapshot.*limit|JSON packet exceeds/i);
  assert.equal(transport.windows.size, 1);
  assert.equal(encodeJsonTransportPacket(snapshot()).byteLength, MAX_JSON_BODY_BYTES + 5);
  transport.closeWindow(1);
  assert.doesNotThrow(() => transport.addWindow(2, windowDetails()));
});

test('bounds growth cannot invalidate an accepted v1 snapshot or its retained frame', () => {
  const transport = new OverlayLoopbackTransport();
  const overhead = Buffer.byteLength(JSON.stringify({ type: 'overlay.init', windows: [{ windowId: 1, ...windowDetails('') }] }));
  transport.addWindow(1, windowDetails('x'.repeat(MAX_JSON_BODY_BYTES - overhead)));
  transport.sendFrameBuffer(1, Buffer.alloc(8), 2, 1);
  assert.throws(() => transport.sendWindowBounds(1, { rect: { x: -2147483648, y: 0, width: 2, height: 1 }, rasterChanged: true }), /JSON packet exceeds/);
  assert.equal(transport.windows.get(1).rect.x, 0);
  assert.equal(transport.latestFrames.size, 1);
});

test('retained frames have one aggregate byte budget and reject before copying pixels', () => {
  const transport = new OverlayLoopbackTransport();
  const pixels = Buffer.alloc(64 * 1024 * 1024);
  let copies = 0;
  const copy = pixels.copy.bind(pixels);
  pixels.copy = (...args) => { copies += 1; return copy(...args); };
  for (let id = 1; id <= 4; id += 1) transport.addWindow(id, windowDetails());
  for (let id = 1; id <= 3; id += 1) assert.equal(transport.sendFrameBuffer(id, pixels, 4096, 4096), true);
  assert.throws(() => transport.sendFrameBuffer(4, pixels, 4096, 4096), /retained frame.*limit/i);
  assert.equal(copies, 3, 'admission must precede the frame packet allocation/copy');
  assert.equal(transport.latestFrames.size, 3);
  assert.doesNotThrow(() => transport.sendFrameBuffer(1, pixels, 4096, 4096));
  transport.closeWindow(2);
  assert.equal(transport.sendFrameBuffer(4, pixels, 4096, 4096), true);
  transport.stop();
  assert.equal(transport.latestFrames.size, 0);
});

test('a queue budget may be lowered but cannot disable the hard byte ceiling', () => {
  for (const limit of [0, -1, NaN, Infinity, 1.5, MAX_PENDING_PACKET_BYTES + 1]) {
    assert.throws(() => new BackpressurePacketQueue({ write: () => true }, () => {}, limit), /maxPendingBytes/);
  }
});

for (const closeOrder of ['native', 'remote-first']) {
  test(`target pending overflow emits a safe buffer diagnostic and permits same-PID recovery (${closeOrder})`,
    (t) => testOverflowCleanup(t, closeOrder));
}

async function testOverflowCleanup(t, closeOrder) {
  const directory = await mkdtemp(join(tmpdir(), 'overlay-buffer-'));
  const token = 'ab'.repeat(32);
  const transport = new OverlayLoopbackTransport({
    discoveryPath: join(directory, 'transport.json'),
    tokenFactory: () => token,
    isProcessAlive: () => true,
  });
  const sockets = [];
  t.after(async () => { sockets.forEach((socket) => socket.destroy()); transport.stop(); await rm(directory, { recursive: true, force: true }); });
  const diagnostics = [];
  transport.setDiagnosticCallback((diagnostic) => diagnostics.push(diagnostic));
  transport.start();
  const record = await transport.whenReady();
  const authenticate = async () => {
    const socket = createConnection({ host: '127.0.0.1', port: record.port });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const received = new Promise((resolve) => socket.once('data', resolve));
    socket.write(encodeJsonTransportPacket({ type: 'game.process', protocolVersion: 1, token, pid: 12345, path: 'C:\\Games\\fixture.exe' }));
    await received;
    return socket;
  };
  const socket = await authenticate();
  const peer = transport.activeClientsByPid.get(12345);
  peer.socket.write = () => false;
  peer.writer.maxPendingBytes = 32;
  const closed = new Promise((resolve) => socket.once('close', resolve));
  const localClosed = new Promise((resolve) => peer.socket.once('close', resolve));
  if (closeOrder === 'remote-first') {
    // Gate only delivery of the real local close event, not socket destruction
    // or transport cleanup. Windows may deliver the remote event first.
    const emit = peer.socket.emit;
    peer.socket.emit = function (event, ...args) {
      if (event !== 'close') return emit.call(this, event, ...args);
      closed.then(() => setImmediate(() => {
        this.emit = emit;
        emit.call(this, event, ...args);
      }));
      return false;
    };
  }
  transport.setInputIntercept(true);
  transport.setInputIntercept(false);
  // The remote close does not imply that the local transport close handler
  // has removed its client. Observe both endpoints before cleanup/recovery.
  await Promise.all([closed, localClosed]);
  const diagnostic = diagnostics.find(({ code }) => code === 'target-socket-error');
  assert.deepEqual(diagnostic.context, { errorCode: 'ENOBUFS' });
  assert.equal(peer.writer.pendingBytes, 0);
  assert.equal(transport.clients.has(peer), false);
  const recovered = await authenticate();
  assert.equal(recovered.destroyed, false);
  assert.notEqual(transport.activeClientsByPid.get(12345), peer);
}
