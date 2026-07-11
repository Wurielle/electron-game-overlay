const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BackpressurePacketQueue,
  HudhookLoopbackTransport,
  MAX_JSON_BODY_BYTES,
  encodeFrameTransportPacket,
  encodeJsonTransportPacket,
} = require('../dist/lib/hudhook-transport.js');
const { ElectronGameOverlay } = require('../dist/lib/electron-game-overlay.js');
const { OverlaySession } = require('../dist/lib/overlay-session.js');

const TOKEN = 'ab'.repeat(32);

const overlayWindow = (name, x = 0) => ({
  name,
  transparent: true,
  resizable: true,
  maxWidth: 1920,
  maxHeight: 1080,
  minWidth: 100,
  minHeight: 100,
  rect: { x, y: 20, width: 2, height: 1 },
  nativeHandle: 123,
  dragBorderWidth: 8,
  caption: { left: 8, right: 8, top: 8, height: 32 },
  scaleFactorMicros: 1_250_000,
});

const connect = (port) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for transport state');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const createPacketReader = (socket) => {
  let buffered = Buffer.alloc(0);
  const packets = [];
  const waiters = [];

  const dispatch = () => {
    while (buffered.length >= 5) {
      const bodyLength = buffered.readUInt32LE(0);
      const packetLength = 5 + bodyLength;
      if (buffered.length < packetLength) {
        return;
      }
      const packet = {
        kind: buffered.readUInt8(4),
        body: Buffer.from(buffered.subarray(5, packetLength)),
      };
      buffered = buffered.subarray(packetLength);
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(packet);
      } else {
        packets.push(packet);
      }
    }
  };

  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    dispatch();
  });

  return {
    next(timeoutMs = 2_000) {
      const packet = packets.shift();
      if (packet) {
        return Promise.resolve(packet);
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
            reject(new Error('Timed out waiting for transport packet'));
          }
        }, timeoutMs).unref();
      });
    },
  };
};

const decodeJson = (packet) => {
  assert.equal(packet.kind, 1);
  return JSON.parse(packet.body.toString('utf8'));
};

test('packet framing uses a body-only length and validates BGRA dimensions', () => {
  const json = encodeJsonTransportPacket({ type: 'test', value: 4 });
  assert.equal(json.readUInt32LE(0), json.length - 5);
  assert.equal(json.readUInt8(4), 1);
  assert.deepEqual(JSON.parse(json.subarray(5).toString('utf8')), {
    type: 'test',
    value: 4,
  });

  const pixels = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const frame = encodeFrameTransportPacket(9, 2, 1, pixels);
  assert.equal(frame.readUInt32LE(0), 12 + pixels.length);
  assert.equal(frame.readUInt8(4), 2);
  assert.equal(frame.readUInt32LE(5), 9);
  assert.equal(frame.readUInt32LE(9), 2);
  assert.equal(frame.readUInt32LE(13), 1);
  assert.deepEqual(frame.subarray(17), pixels);

  assert.throws(
    () => encodeFrameTransportPacket(9, 2, 1, Buffer.alloc(7)),
    /Expected 8 BGRA bytes/,
  );
  assert.throws(
    () => encodeJsonTransportPacket({ text: 'x'.repeat(MAX_JSON_BODY_BYTES) }),
    /exceeds/,
  );
});

test('legacy process discovery and injection fail explicitly', () => {
  const message = /unavailable in the hudhook transport/;
  const overlay = new ElectronGameOverlay();
  assert.throws(() => overlay.findWindows(), message);
  assert.throws(
    () => new OverlaySession({}).attachToProcess({ pid: 4321 }),
    message,
  );
});

test('backpressure coalesces same-window frames without crossing control barriers', () => {
  const writes = [];
  let blockFirstWrite = true;
  const queue = new BackpressurePacketQueue({
    write(packet) {
      writes.push(Buffer.from(packet).toString());
      if (blockFirstWrite) {
        blockFirstWrite = false;
        return false;
      }
      return true;
    },
  });

  queue.sendControl(Buffer.from('blocked'));
  queue.sendFrame(1, Buffer.from('frame-a'));
  queue.sendFrame(1, Buffer.from('frame-b'));
  queue.sendControl(Buffer.from('bounds'));
  queue.sendFrame(1, Buffer.from('frame-c'));
  queue.sendFrame(1, Buffer.from('frame-d'));
  queue.sendFrame(2, Buffer.from('frame-other'));
  queue.sendFrame(1, Buffer.from('frame-e'));
  queue.handleDrain();

  assert.deepEqual(writes, [
    'blocked',
    'frame-b',
    'bounds',
    'frame-e',
    'frame-other',
  ]);
});

test('window barriers drop only stale unsent frames and retain control FIFO order', () => {
  const writes = [];
  let blockFirstWrite = true;
  const queue = new BackpressurePacketQueue({
    write(packet) {
      writes.push(Buffer.from(packet).toString());
      if (blockFirstWrite) {
        blockFirstWrite = false;
        return false;
      }
      return true;
    },
  });

  queue.sendControl(Buffer.from('blocked'));
  queue.sendFrame(1, Buffer.from('stale-a'));
  queue.sendControl(Buffer.from('control-a'));
  queue.sendFrame(1, Buffer.from('stale-b'));
  queue.sendFrame(2, Buffer.from('other-window'));
  queue.dropPendingFrames(1);
  queue.sendControl(Buffer.from('window.close'));
  queue.handleDrain();

  assert.deepEqual(writes, [
    'blocked',
    'control-a',
    'other-window',
    'window.close',
  ]);
});

test('authenticated clients receive canonical snapshot before callback commands', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'hudhook-transport-test-'),
  );
  const discoveryPath = path.join(tempDirectory, 'transport.json');
  const transport = new HudhookLoopbackTransport({
    discoveryPath,
    tokenFactory: () => TOKEN,
  });
  let socket;
  t.after(async () => {
    socket?.destroy();
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.addWindow(1, overlayWindow('first'));
  transport.addWindow(2, overlayWindow('second', 10));
  transport.addWindow(1, overlayWindow('first-replaced', 20));
  const latestPixels = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80]);
  transport.sendFrameBuffer(1, Buffer.alloc(8, 1), 2, 1);
  transport.sendFrameBuffer(1, latestPixels, 2, 1);
  transport.sendCommand({ command: 'input.intercept', intercept: true });

  const events = [];
  transport.setEventCallback((event, payload) => {
    events.push({ event, payload });
    if (event === 'game.process') {
      transport.sendCommand({ command: 'cursor', cursor: 'pointer' });
    }
  });
  transport.start();
  const record = await transport.whenReady();
  assert.equal(record.pid, process.pid);
  assert.equal(record.token, TOKEN);
  assert.deepEqual(JSON.parse(await readFile(discoveryPath, 'utf8')), record);

  socket = await connect(record.port);
  const reader = createPacketReader(socket);
  const hello = encodeJsonTransportPacket({
    type: 'game.process',
    protocolVersion: 1,
    token: TOKEN,
    pid: 4321,
    path: 'C:\\games\\test.exe',
  });
  socket.write(hello.subarray(0, 3));
  socket.write(hello.subarray(3));

  const init = decodeJson(await reader.next());
  assert.equal(init.type, 'overlay.init');
  assert.deepEqual(
    init.windows.map((window) => [window.windowId, window.name]),
    [
      [2, 'second'],
      [1, 'first-replaced'],
    ],
  );

  const frame = await reader.next();
  assert.equal(frame.kind, 2);
  assert.equal(frame.body.readUInt32LE(0), 1);
  assert.equal(frame.body.readUInt32LE(4), 2);
  assert.equal(frame.body.readUInt32LE(8), 1);
  assert.deepEqual(frame.body.subarray(12), latestPixels);
  assert.deepEqual(decodeJson(await reader.next()), {
    type: 'command.input.intercept',
    intercept: true,
  });
  assert.deepEqual(decodeJson(await reader.next()), {
    type: 'command.cursor',
    cursor: 'pointer',
  });

  await waitFor(() => events.length === 1);
  assert.deepEqual(events[0], {
    event: 'game.process',
    payload: { pid: 4321, path: 'C:\\games\\test.exe' },
  });

  socket.write(
    encodeJsonTransportPacket({
      type: 'game.input',
      pid: 9999,
      windowId: 1,
      msg: 0x0200,
      wparam: 0,
      lparam: 0,
    }),
  );
  await waitFor(() => events.length === 2);
  assert.deepEqual(events[1], {
    event: 'game.input',
    payload: {
      pid: 4321,
      windowId: 1,
      msg: 0x0200,
      wparam: 0,
      lparam: 0,
    },
  });

  transport.stop();
  await assert.rejects(
    readFile(discoveryPath, 'utf8'),
    (error) => error.code === 'ENOENT',
  );
});

test('invalid authentication is closed without receiving a snapshot', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'hudhook-auth-test-'),
  );
  const transport = new HudhookLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
  });
  let socket;
  t.after(async () => {
    socket?.destroy();
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.start();
  const record = await transport.whenReady();
  socket = await connect(record.port);
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.write(
    encodeJsonTransportPacket({
      type: 'game.process',
      protocolVersion: 1,
      token: 'cd'.repeat(32),
      pid: 4321,
      path: 'bad.exe',
    }),
  );
  await closed;
});

test('modifier state is reset when routing is lost or a payload reconnects', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'hudhook-input-state-test-'),
  );
  const transport = new HudhookLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
  });
  const sockets = [];
  const translated = [];
  const events = [];
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.setEventCallback((event, payload) => {
    events.push({ event, payload });
    if (event === 'game.input') {
      translated.push(transport.translateInputEvent(payload));
    }
  });
  transport.start();
  const record = await transport.whenReady();

  const authenticate = async () => {
    const socket = await connect(record.port);
    sockets.push(socket);
    const reader = createPacketReader(socket);
    socket.write(
      encodeJsonTransportPacket({
        type: 'game.process',
        protocolVersion: 1,
        token: TOKEN,
        pid: 4321,
        path: 'C:\\games\\test.exe',
      }),
    );
    assert.equal(decodeJson(await reader.next()).type, 'overlay.init');
    return socket;
  };

  let socket = await authenticate();
  const input = (wparam) =>
    socket.write(
      encodeJsonTransportPacket({
        type: 'game.input',
        windowId: 1,
        msg: 0x0100,
        wparam,
        lparam: 0,
      }),
    );

  input(0x11);
  await waitFor(() => translated.length === 1);
  assert.deepEqual(translated[0].modifiers, ['control', 'left']);

  socket.write(
    encodeJsonTransportPacket({
      type: 'game.window.focused',
      focusWindowId: 0,
    }),
  );
  await waitFor(() =>
    events.some(
      ({ event, payload }) =>
        event === 'game.window.focused' && payload.focusWindowId === 0,
    ),
  );
  input(0x41);
  await waitFor(() => translated.length === 2);
  assert.deepEqual(translated[1].modifiers, []);

  input(0x11);
  await waitFor(() => translated.length === 3);
  socket.write(
    encodeJsonTransportPacket({
      type: 'game.input.intercept',
      intercepting: false,
    }),
  );
  await waitFor(() =>
    events.some(
      ({ event, payload }) =>
        event === 'game.input.intercept' && payload.intercepting === false,
    ),
  );
  input(0x42);
  await waitFor(() => translated.length === 4);
  assert.deepEqual(translated[3].modifiers, []);

  input(0x11);
  await waitFor(() => translated.length === 5);
  const replacedSocketClosed = new Promise((resolve) =>
    socket.once('close', resolve),
  );
  socket = await authenticate();
  await replacedSocketClosed;
  input(0x43);
  await waitFor(() => translated.length === 6);
  assert.deepEqual(translated[5].modifiers, []);
});
