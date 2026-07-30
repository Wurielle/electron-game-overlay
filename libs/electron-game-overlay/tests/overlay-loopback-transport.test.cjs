const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BackpressurePacketQueue,
  OverlayLoopbackTransport,
  MAX_JSON_BODY_BYTES,
  OVERLAY_TRANSPORT_TARGET_ROUTE_FILE_NAME,
  encodeFrameTransportPacket,
  encodeJsonTransportPacket,
} = require('../dist/lib/overlay-loopback-transport.js');
const { ElectronGameOverlay } = require('../dist/lib/electron-game-overlay.js');
const { OverlaySession } = require('../dist/lib/overlay-session.js');
const { createWindowScaleState } = require('../dist/lib/window-scale-state.js');

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

const targetSurfaceMessage = (overrides = {}) => ({
  type: 'game.target.surface',
  pid: 9999,
  surfaceId: '0x1234',
  hwnd: '0xabcd',
  revision: 7,
  graphicsApi: 'd3d12',
  renderSize: { width: 2560, height: 1440 },
  clientBounds: { x: 0, y: 0, width: 2560, height: 1440 },
  clientScreenBounds: { x: -2560, y: 40, width: 2560, height: 1440 },
  windowScreenBounds: { x: -2568, y: 9, width: 2576, height: 1479 },
  dpi: { x: 120, y: 120 },
  monitor: {
    id: '0x55',
    bounds: { x: -2560, y: 0, width: 2560, height: 1440 },
    workArea: { x: -2560, y: 0, width: 2560, height: 1400 },
  },
  focused: true,
  minimized: false,
  visible: true,
  fullscreen: true,
  ...overrides,
});

const runtimeDiagnosticMessage = (overrides = {}) => ({
  type: 'game.diagnostic',
  schemaVersion: 1,
  source: 'electron-game-overlay-runtime',
  code: 'runtime-ready',
  ...overrides,
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

test('failed window encoding does not mutate retained transport state', () => {
  const transport = new OverlayLoopbackTransport();
  const oversizedWindow = overlayWindow('x'.repeat(MAX_JSON_BODY_BYTES));

  assert.throws(
    () => transport.addWindow(7, oversizedWindow),
    /Overlay JSON packet exceeds/,
  );
  assert.equal(transport.windows.has(7), false);
  assert.equal(transport.latestFrames.has(7), false);

  transport.addWindow(7, overlayWindow('retained'));
  transport.sendFrameBuffer(7, Buffer.alloc(8, 1), 2, 1);

  assert.throws(
    () => transport.addWindow(7, oversizedWindow),
    /Overlay JSON packet exceeds/,
  );
  assert.equal(transport.windows.get(7).name, 'retained');
  assert.equal(transport.latestFrames.has(7), true);
});

test('window metadata rejects zero identifiers and scale factors at ingress', () => {
  const transport = new OverlayLoopbackTransport();
  const details = overlayWindow('strict-window');
  const geometry = { rect: { ...details.rect } };

  assert.throws(
    () => transport.addWindow(0, details),
    /windowId must be greater than zero/,
  );
  assert.throws(
    () =>
      transport.addWindow(7, {
        ...details,
        scaleFactorMicros: 0,
      }),
    /scaleFactorMicros must be greater than zero/,
  );
  assert.throws(
    () => transport.sendWindowBounds(0, geometry),
    /windowId must be greater than zero/,
  );
  assert.throws(
    () =>
      transport.sendWindowBounds(7, {
        ...geometry,
        scaleFactorMicros: 0,
      }),
    /scaleFactorMicros must be greater than zero/,
  );
  assert.throws(
    () => transport.closeWindow(0),
    /windowId must be greater than zero/,
  );
  assert.equal(transport.windows.size, 0);
});

test('legacy process discovery and injection fail explicitly', () => {
  const message = /unavailable in the overlay transport/;
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

test('one synchronous client write failure does not abort later clients', () => {
  const writeErrors = [];
  const delivered = [];
  const transport = new OverlayLoopbackTransport();
  const failingWriter = new BackpressurePacketQueue(
    {
      write() {
        const error = new Error('synchronous sink failure');
        error.code = 'EPIPE';
        throw error;
      },
    },
    (error) => writeErrors.push(error),
  );
  const healthyWriter = new BackpressurePacketQueue({
    write(packet) {
      delivered.push(Buffer.from(packet));
      return true;
    },
  });
  const client = (writer) => ({
    socket: { destroy() {} },
    writer,
    receiveBuffer: Buffer.alloc(0),
    authenticated: true,
    diagnosticRates: new Map(),
  });
  transport.clients.add(client(failingWriter));
  transport.clients.add(client(healthyWriter));

  assert.doesNotThrow(() =>
    transport.addWindow(9, overlayWindow('still-delivered')),
  );
  assert.equal(writeErrors.length, 1);
  assert.equal(delivered.length, 1);
  const message = JSON.parse(delivered[0].subarray(5).toString('utf8'));
  assert.equal(message.type, 'window');
  assert.equal(message.windowId, 9);
  assert.equal(message.name, 'still-delivered');
});

test('authenticated clients receive canonical snapshot before callback commands', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-transport-test-'),
  );
  const discoveryPath = path.join(tempDirectory, 'transport.json');
  const transport = new OverlayLoopbackTransport({
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

test('invalid authenticated input envelopes fail closed before SDK forwarding', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-input-envelope-test-'),
  );
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
    isProcessAlive: () => true,
  });
  const events = [];
  const diagnostics = [];
  let socket;
  t.after(async () => {
    socket?.destroy();
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.setEventCallback((event, payload) => {
    events.push({ event, payload });
  });
  transport.setDiagnosticCallback((diagnostic) => {
    diagnostics.push(diagnostic);
  });
  transport.start();
  const record = await transport.whenReady();
  socket = await connect(record.port);
  const reader = createPacketReader(socket);
  socket.write(
    encodeJsonTransportPacket({
      type: 'game.process',
      protocolVersion: 1,
      token: TOKEN,
      pid: 4321,
      path: 'C:\\games\\invalid-input-envelope.exe',
    }),
  );
  assert.equal(decodeJson(await reader.next()).type, 'overlay.init');
  await waitFor(() => events.length === 1);

  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.write(
    encodeJsonTransportPacket({
      type: 'game.input',
      windowId: 1,
      msg: '512',
      wparam: null,
      lparam: [0],
      secret: 'must-not-cross',
    }),
  );
  await closed;
  await waitFor(() =>
    diagnostics.some(({ code }) => code === 'target-packet-rejected'),
  );

  assert.equal(
    events.some(({ event }) => event === 'game.input'),
    false,
  );
  assert.deepEqual(
    diagnostics.filter(({ code }) => code === 'target-packet-rejected'),
    [
      {
        schemaVersion: 1,
        source: 'electron-overlay-transport',
        severity: 'warning',
        code: 'target-packet-rejected',
        message:
          'The overlay transport rejected a packet from an authenticated target.',
        pid: 4321,
        context: {
          reason: 'invalid-game-input',
          eventType: 'game.input',
        },
      },
    ],
  );
  assert.equal(JSON.stringify(diagnostics).includes('must-not-cross'), false);
});

test('Electron input dispatch failure does not disconnect the authenticated target', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-input-dispatch-containment-test-'),
  );
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
    isProcessAlive: () => true,
  });
  const session = new OverlaySession(transport);
  const diagnostics = [];
  const delivered = [];
  const warnings = [];
  const originalWarn = console.warn;
  let rejectDispatch = true;
  let socket;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(async () => {
    console.warn = originalWarn;
    socket?.destroy();
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  session.windowsByNativeId.set(7, {
    nativeId: 7,
    visible: true,
    browserWindow: {
      focusOnWebView() {},
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        sendInputEvent(event) {
          if (rejectDispatch) {
            throw Object.assign(new Error('dispatch failed'), {
              code: 'EPIPE',
            });
          }
          delivered.push(event);
        },
      },
    },
  });
  session.windowScaleStates.set(
    7,
    createWindowScaleState(
      { id: 1, scaleFactor: 1, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 640, height: 360 },
    ),
  );
  session.on('diagnostic', (diagnostic) => diagnostics.push(diagnostic));
  transport.setEventCallback((event, payload) => {
    session.handleEvent(event, payload);
  });
  transport.start();
  const record = await transport.whenReady();
  socket = await connect(record.port);
  const reader = createPacketReader(socket);
  socket.write(
    encodeJsonTransportPacket({
      type: 'game.process',
      protocolVersion: 1,
      token: TOKEN,
      pid: 6101,
      path: 'C:\\games\\input-dispatch-containment.exe',
    }),
  );
  assert.equal(decodeJson(await reader.next()).type, 'overlay.init');
  await waitFor(() => transport.activeClientsByPid.has(6101));
  const authoritativeClient = transport.activeClientsByPid.get(6101);

  const sendMouseMove = (x) => {
    socket.write(
      encodeJsonTransportPacket({
        type: 'game.input',
        windowId: 7,
        msg: 0x0200,
        wparam: 0,
        lparam: (20 << 16) | x,
      }),
    );
  };
  sendMouseMove(10);
  await waitFor(() =>
    diagnostics.some(
      ({ code, pid }) =>
        code === 'producer-input-forwarding-failed' && pid === 6101,
    ),
  );

  rejectDispatch = false;
  sendMouseMove(11);
  await waitFor(() => delivered.length === 1);
  assert.equal(delivered[0].x, 11);
  assert.equal(
    transport.activeClientsByPid.get(6101),
    authoritativeClient,
    'the same authenticated socket must remain authoritative',
  );
  assert.equal(socket.destroyed, false);
  assert.equal(warnings.length, 1);
});

test('invalid authentication is closed without receiving a snapshot', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-auth-test-'),
  );
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
  });
  const diagnostics = [];
  let socket;
  t.after(async () => {
    socket?.destroy();
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.setDiagnosticCallback((diagnostic) => {
    diagnostics.push(diagnostic);
  });
  transport.start();
  const record = await transport.whenReady();
  for (let attempt = 0; attempt < 12; attempt += 1) {
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
  }
  const rejected = diagnostics.filter(
    ({ code }) => code === 'target-authentication-rejected',
  );
  assert.equal(
    rejected.length,
    8,
    'repeated rejected clients must hit the per-code diagnostic bound',
  );
  assert.deepEqual(rejected[0], {
    schemaVersion: 1,
    source: 'electron-overlay-transport',
    severity: 'warning',
    code: 'target-authentication-rejected',
    message: 'An overlay target presented an invalid transport credential.',
    context: { scope: 'global' },
  });
  assert.equal(
    JSON.stringify(rejected).includes('cd'.repeat(32)),
    false,
    'diagnostics must not expose rejected credentials',
  );
});

test('run-local credentials isolate simultaneous exact-PID targets', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-target-auth-test-'),
  );
  const tokens = ['10'.repeat(32), '20'.repeat(32), '30'.repeat(32)];
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'global', 'transport.json'),
    tokenFactory: () => {
      const token = tokens.shift();
      assert.ok(token, 'test token supply exhausted');
      return token;
    },
    isProcessAlive: () => true,
  });
  const sockets = [];
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
  });
  transport.start();
  const globalRecord = await transport.whenReady();
  const firstPath = path.join(
    tempDirectory,
    'first-run',
    'electron-overlay-transport-v1.json',
  );
  const secondPath = path.join(
    tempDirectory,
    'second-run',
    'electron-overlay-transport-v1.json',
  );
  const firstRouteIntentPath = path.join(
    path.dirname(firstPath),
    OVERLAY_TRANSPORT_TARGET_ROUTE_FILE_NAME,
  );
  const secondRouteIntentPath = path.join(
    path.dirname(secondPath),
    OVERLAY_TRANSPORT_TARGET_ROUTE_FILE_NAME,
  );
  const [releaseFirst, releaseSecond] = await Promise.all([
    transport.authorizeTarget(4101, firstPath),
    transport.authorizeTarget(4102, secondPath),
  ]);
  const firstRecord = JSON.parse(await readFile(firstPath, 'utf8'));
  const secondRecord = JSON.parse(await readFile(secondPath, 'utf8'));

  assert.equal(firstRecord.targetPid, 4101);
  assert.equal(secondRecord.targetPid, 4102);
  assert.equal(firstRecord.port, globalRecord.port);
  assert.equal(secondRecord.port, globalRecord.port);
  assert.notEqual(firstRecord.token, secondRecord.token);
  assert.notEqual(firstRecord.token, globalRecord.token);
  assert.deepEqual(
    JSON.parse(await readFile(firstRouteIntentPath, 'utf8')),
    firstRecord,
  );
  assert.deepEqual(
    JSON.parse(await readFile(secondRouteIntentPath, 'utf8')),
    secondRecord,
  );
  await assert.rejects(
    transport.authorizeTarget(4103, firstPath),
    /already authorized for PID 4101/,
  );

  const wrongSocket = await connect(globalRecord.port);
  sockets.push(wrongSocket);
  const wrongBytes = [];
  wrongSocket.on('data', (chunk) => wrongBytes.push(chunk));
  const wrongClosed = new Promise((resolve) =>
    wrongSocket.once('close', resolve),
  );
  wrongSocket.write(
    encodeJsonTransportPacket({
      type: 'game.process',
      protocolVersion: 1,
      token: firstRecord.token,
      pid: 4102,
      path: 'C:\\games\\wrong-target.exe',
    }),
  );
  await wrongClosed;
  assert.equal(Buffer.concat(wrongBytes).length, 0);
  assert.equal(events.length, 0);

  const globalTokenSocket = await connect(globalRecord.port);
  sockets.push(globalTokenSocket);
  const globalTokenBytes = [];
  globalTokenSocket.on('data', (chunk) => globalTokenBytes.push(chunk));
  const globalTokenClosed = new Promise((resolve) =>
    globalTokenSocket.once('close', resolve),
  );
  globalTokenSocket.write(
    encodeJsonTransportPacket({
      type: 'game.process',
      protocolVersion: 1,
      token: globalRecord.token,
      pid: 4101,
      path: 'C:\\games\\global-token-bypass.exe',
    }),
  );
  await globalTokenClosed;
  assert.equal(Buffer.concat(globalTokenBytes).length, 0);
  assert.equal(events.length, 0);

  const authenticate = async (record, pid, executablePath) => {
    const socket = await connect(globalRecord.port);
    sockets.push(socket);
    const reader = createPacketReader(socket);
    socket.write(
      encodeJsonTransportPacket({
        type: 'game.process',
        protocolVersion: 1,
        token: record.token,
        pid,
        path: executablePath,
      }),
    );
    assert.equal(decodeJson(await reader.next()).type, 'overlay.init');
    return socket;
  };

  const [firstSocket, secondSocket] = await Promise.all([
    authenticate(firstRecord, 4101, 'C:\\games\\first.exe'),
    authenticate(secondRecord, 4102, 'C:\\games\\second.exe'),
  ]);
  await waitFor(
    () => events.filter(({ event }) => event === 'game.process').length === 2,
  );
  assert.deepEqual(
    events
      .filter(({ event }) => event === 'game.process')
      .map(({ payload }) => payload.pid)
      .sort(),
    [4101, 4102],
  );

  const firstSocketClosed = new Promise((resolve) =>
    firstSocket.once('close', resolve),
  );
  firstSocket.destroy();
  await firstSocketClosed;
  await waitFor(() =>
    events.some(
      ({ event, payload }) =>
        event === 'game.process.transport-lost' && payload.pid === 4101,
    ),
  );
  assert.deepEqual(JSON.parse(await readFile(firstPath, 'utf8')), firstRecord);
  const reauthenticatedFirstSocket = await authenticate(
    firstRecord,
    4101,
    'C:\\games\\first-reconnected.exe',
  );
  await waitFor(
    () => events.filter(({ event }) => event === 'game.process').length === 3,
  );

  const reauthenticatedFirstClosed = new Promise((resolve) =>
    reauthenticatedFirstSocket.once('close', resolve),
  );
  releaseFirst();
  await reauthenticatedFirstClosed;
  await assert.rejects(
    readFile(firstPath, 'utf8'),
    (error) => error.code === 'ENOENT',
  );
  assert.deepEqual(
    JSON.parse(await readFile(firstRouteIntentPath, 'utf8')),
    firstRecord,
  );
  assert.deepEqual(
    JSON.parse(await readFile(secondPath, 'utf8')),
    secondRecord,
  );

  const secondSocketClosed = new Promise((resolve) =>
    secondSocket.once('close', resolve),
  );
  releaseSecond();
  await secondSocketClosed;
  await assert.rejects(
    readFile(secondPath, 'utf8'),
    (error) => error.code === 'ENOENT',
  );
  assert.deepEqual(
    JSON.parse(await readFile(secondRouteIntentPath, 'utf8')),
    secondRecord,
  );
});

test('authenticated surface and FPS telemetry is validated with an authoritative PID', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-telemetry-test-'),
  );
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
    isProcessAlive: () => true,
  });
  const events = [];
  const diagnostics = [];
  let socket;
  t.after(async () => {
    socket?.destroy();
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.setEventCallback((event, payload) => {
    events.push({ event, payload });
  });
  transport.setDiagnosticCallback((diagnostic) => {
    diagnostics.push(diagnostic);
  });
  transport.start();
  const record = await transport.whenReady();
  socket = await connect(record.port);
  const reader = createPacketReader(socket);
  socket.write(
    encodeJsonTransportPacket({
      type: 'game.process',
      protocolVersion: 1,
      token: TOKEN,
      pid: 4321,
      path: 'C:\\games\\telemetry.exe',
    }),
  );
  assert.equal(decodeJson(await reader.next()).type, 'overlay.init');

  socket.write(encodeJsonTransportPacket(targetSurfaceMessage()));
  socket.write(
    encodeJsonTransportPacket({
      type: 'game.graphics.fps',
      pid: 9999,
      fps: 143.625,
    }),
  );
  socket.write(
    encodeJsonTransportPacket({
      type: 'game.target.surface.removed',
      pid: 9999,
      surfaceId: '0x1234',
      revision: 8,
    }),
  );
  await waitFor(() => events.length === 4);

  const surface = events[1];
  assert.equal(surface.event, 'game.target.surface');
  assert.equal(surface.payload.pid, 4321);
  assert.equal(surface.payload.dpi.scaleFactor, 1.25);
  assert.deepEqual(surface.payload.clientScreenBounds, {
    x: -2560,
    y: 40,
    width: 2560,
    height: 1440,
  });
  assert.deepEqual(events[2], {
    event: 'game.graphics.fps',
    payload: { pid: 4321, fps: 143.625 },
  });
  assert.deepEqual(events[3], {
    event: 'game.target.surface.removed',
    payload: { pid: 4321, surfaceId: '0x1234', revision: 8 },
  });

  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.write(
    encodeJsonTransportPacket(
      targetSurfaceMessage({
        surfaceId: '0xABCD',
      }),
    ),
  );
  await closed;
  assert.equal(events.length, 5, 'only transport loss follows malformed data');
  assert.equal(events.at(-1).event, 'game.process.transport-lost');
  assert.deepEqual(
    diagnostics.filter(({ code }) => code === 'target-packet-rejected'),
    [
      {
        schemaVersion: 1,
        source: 'electron-overlay-transport',
        severity: 'warning',
        code: 'target-packet-rejected',
        message:
          'The overlay transport rejected a packet from an authenticated target.',
        pid: 4321,
        context: {
          reason: 'invalid-target-surface',
          eventType: 'game.target.surface',
        },
      },
    ],
  );
});

test('authenticated runtime diagnostics are canonical, PID-authoritative, and not native events', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-runtime-diagnostic-test-'),
  );
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
    isProcessAlive: () => true,
  });
  const events = [];
  const diagnostics = [];
  let socket;
  t.after(async () => {
    socket?.destroy();
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.setEventCallback((event, payload) => {
    events.push({ event, payload });
  });
  transport.setDiagnosticCallback((diagnostic) => {
    diagnostics.push(diagnostic);
  });
  transport.start();
  const record = await transport.whenReady();
  socket = await connect(record.port);
  const reader = createPacketReader(socket);
  socket.write(
    encodeJsonTransportPacket({
      type: 'game.process',
      protocolVersion: 1,
      token: TOKEN,
      pid: 4321,
      path: 'C:\\games\\runtime-diagnostic.exe',
    }),
  );
  assert.equal(decodeJson(await reader.next()).type, 'overlay.init');

  socket.write(
    encodeJsonTransportPacket(
      runtimeDiagnosticMessage({
        code: 'runtime-frame-upload-failed',
        context: { errorCode: -6 },
      }),
    ),
  );
  await waitFor(() =>
    diagnostics.some(({ code }) => code === 'runtime-frame-upload-failed'),
  );

  assert.deepEqual(
    diagnostics.filter(({ code }) => code === 'runtime-frame-upload-failed'),
    [
      {
        schemaVersion: 1,
        source: 'electron-game-overlay-runtime',
        severity: 'error',
        code: 'runtime-frame-upload-failed',
        message:
          'The injected overlay runtime could not upload a transported Electron frame.',
        pid: 4321,
        context: { errorCode: -6 },
      },
    ],
  );
  assert.equal(
    events.some(({ event }) => event === 'game.diagnostic'),
    false,
  );
});

test('invalid runtime diagnostic envelopes fail closed with an authoritative rejection', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-runtime-diagnostic-rejection-test-'),
  );
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
    isProcessAlive: () => true,
  });
  const diagnostics = [];
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.setDiagnosticCallback((diagnostic) => {
    diagnostics.push(diagnostic);
  });
  transport.start();
  const record = await transport.whenReady();
  const invalidPackets = [
    runtimeDiagnosticMessage({ source: 'electron-overlay-transport' }),
    runtimeDiagnosticMessage({ code: 'runtime-unknown' }),
    runtimeDiagnosticMessage({ context: {} }),
    runtimeDiagnosticMessage({ context: { errorCode: -8 } }),
    runtimeDiagnosticMessage({ pid: 9999 }),
    runtimeDiagnosticMessage({ severity: 'error' }),
    runtimeDiagnosticMessage({ message: 'producer-owned message' }),
  ];

  for (const [index, packet] of invalidPackets.entries()) {
    const socket = await connect(record.port);
    sockets.push(socket);
    const reader = createPacketReader(socket);
    const pid = 5100 + index;
    socket.write(
      encodeJsonTransportPacket({
        type: 'game.process',
        protocolVersion: 1,
        token: TOKEN,
        pid,
        path: `C:\\games\\invalid-runtime-diagnostic-${index}.exe`,
      }),
    );
    assert.equal(decodeJson(await reader.next()).type, 'overlay.init');

    const rejectionCount = diagnostics.filter(
      ({ code }) => code === 'target-packet-rejected',
    ).length;
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.write(encodeJsonTransportPacket(packet));
    await closed;
    await waitFor(
      () =>
        diagnostics.filter(({ code }) => code === 'target-packet-rejected')
          .length ===
        rejectionCount + 1,
    );

    assert.deepEqual(
      diagnostics
        .filter(({ code }) => code === 'target-packet-rejected')
        .at(-1),
      {
        schemaVersion: 1,
        source: 'electron-overlay-transport',
        severity: 'warning',
        code: 'target-packet-rejected',
        message:
          'The overlay transport rejected a packet from an authenticated target.',
        pid,
        context: {
          reason: 'invalid-runtime-diagnostic',
          eventType: 'game.diagnostic',
        },
      },
    );
  }

  assert.equal(
    diagnostics.some(
      ({ source }) => source === 'electron-game-overlay-runtime',
    ),
    false,
  );
});

test('runtime diagnostic rate limiting is isolated to each authenticated client', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-runtime-diagnostic-rate-test-'),
  );
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
    isProcessAlive: () => true,
  });
  const diagnostics = [];
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.setDiagnosticCallback((diagnostic) => {
    diagnostics.push(diagnostic);
  });
  transport.start();
  const record = await transport.whenReady();
  const authenticate = async (pid) => {
    const socket = await connect(record.port);
    sockets.push(socket);
    const reader = createPacketReader(socket);
    socket.write(
      encodeJsonTransportPacket({
        type: 'game.process',
        protocolVersion: 1,
        token: TOKEN,
        pid,
        path: `C:\\games\\runtime-diagnostic-rate-${pid}.exe`,
      }),
    );
    assert.equal(decodeJson(await reader.next()).type, 'overlay.init');
    return socket;
  };
  const publishBurst = (socket) => {
    for (let index = 0; index < 12; index += 1) {
      socket.write(
        encodeJsonTransportPacket(
          runtimeDiagnosticMessage({
            code: 'runtime-input-router-reset',
          }),
        ),
      );
    }
  };

  const first = await authenticate(5201);
  publishBurst(first);
  await waitFor(
    () =>
      diagnostics.filter(
        ({ code, pid }) =>
          code === 'runtime-input-router-reset' && pid === 5201,
      ).length === 8,
  );

  const second = await authenticate(5202);
  publishBurst(second);
  await waitFor(
    () =>
      diagnostics.filter(
        ({ code, pid }) =>
          code === 'runtime-input-router-reset' && pid === 5202,
      ).length === 8,
  );

  assert.equal(
    diagnostics.filter(({ code }) => code === 'runtime-input-router-reset')
      .length,
    16,
  );
});

test('authenticated clients cannot forge server-owned lifecycle events', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-disconnect-auth-test-'),
  );
  let processAlive = true;
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
    isProcessAlive: () => processAlive,
    processExitPollIntervalMs: 5,
  });
  const events = [];
  let socket;
  t.after(async () => {
    socket?.destroy();
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.setEventCallback((event, payload) => {
    events.push({ event, payload });
  });
  transport.start();
  const record = await transport.whenReady();
  const authenticate = async () => {
    const expectedProcessEvents =
      events.filter(({ event }) => event === 'game.process').length + 1;
    socket = await connect(record.port);
    const reader = createPacketReader(socket);
    socket.write(
      encodeJsonTransportPacket({
        type: 'game.process',
        protocolVersion: 1,
        token: TOKEN,
        pid: 4321,
        path: 'C:\\games\\real.exe',
      }),
    );
    assert.equal(decodeJson(await reader.next()).type, 'overlay.init');
    await waitFor(
      () =>
        events.filter(({ event }) => event === 'game.process').length ===
        expectedProcessEvents,
    );
  };

  for (const reservedEvent of [
    'game.process.disconnected',
    'game.process.transport-lost',
  ]) {
    await authenticate();
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.write(
      encodeJsonTransportPacket({
        type: reservedEvent,
        pid: 9999,
        path: 'C:\\games\\forged.exe',
      }),
    );
    await closed;
  }

  assert.deepEqual(
    events.filter(({ event }) => event === 'game.process.transport-lost'),
    [
      {
        event: 'game.process.transport-lost',
        payload: { pid: 4321, path: 'C:\\games\\real.exe' },
      },
      {
        event: 'game.process.transport-lost',
        payload: { pid: 4321, path: 'C:\\games\\real.exe' },
      },
    ],
  );
  assert.equal(
    events.filter(({ event }) => event === 'game.process.disconnected').length,
    0,
  );

  processAlive = false;
  await waitFor(
    () =>
      events.filter(({ event }) => event === 'game.process.disconnected')
        .length === 1,
  );
  assert.deepEqual(
    events.filter(({ event }) => event === 'game.process.disconnected'),
    [
      {
        event: 'game.process.disconnected',
        payload: { pid: 4321, path: 'C:\\games\\real.exe' },
      },
    ],
  );
  assert.deepEqual(
    events
      .filter(({ event }) =>
        ['game.process.transport-lost', 'game.process.disconnected'].includes(
          event,
        ),
      )
      .map(({ event }) => event),
    [
      'game.process.transport-lost',
      'game.process.transport-lost',
      'game.process.disconnected',
    ],
  );
});

test('sequential same-PID reauthentication cancels exit confirmation', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-process-exit-test-'),
  );
  let processAlive = true;
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
    isProcessAlive: () => processAlive,
    processExitPollIntervalMs: 5,
  });
  const sockets = [];
  const events = [];
  let throwOnNextTransportLoss = true;
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.setEventCallback((event, payload) => {
    events.push({ event, payload });
    if (event === 'game.process.transport-lost' && throwOnNextTransportLoss) {
      throwOnNextTransportLoss = false;
      throw new Error('consumer lifecycle callback failed');
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
  socket.destroy();
  await waitFor(
    () =>
      events.filter(({ event }) => event === 'game.process.transport-lost')
        .length === 1,
  );
  assert.equal(
    events.filter(({ event }) => event === 'game.process.disconnected').length,
    0,
  );

  socket = await authenticate();
  processAlive = false;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    events.filter(({ event }) => event === 'game.process.disconnected').length,
    0,
    'reauthentication must cancel the prior socket exit watch',
  );

  socket.destroy();
  await waitFor(
    () =>
      events.filter(({ event }) => event === 'game.process.disconnected')
        .length === 1,
  );
  assert.deepEqual(
    events.filter(({ event }) => event === 'game.process.disconnected'),
    [
      {
        event: 'game.process.disconnected',
        payload: { pid: 4321, path: 'C:\\games\\test.exe' },
      },
    ],
  );
});

test('process exit inspection failures emit one bounded authoritative diagnostic', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-process-inspection-test-'),
  );
  let inspectionCalls = 0;
  const transport = new OverlayLoopbackTransport({
    discoveryPath: path.join(tempDirectory, 'transport.json'),
    tokenFactory: () => TOKEN,
    isProcessAlive: () => {
      inspectionCalls += 1;
      const error = new Error('sensitive process inspection detail');
      error.code = 'EINSPECT';
      throw error;
    },
    processExitPollIntervalMs: 5,
  });
  const diagnostics = [];
  let socket;
  t.after(async () => {
    socket?.destroy();
    transport.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  transport.setDiagnosticCallback((diagnostic) => {
    diagnostics.push(diagnostic);
  });
  transport.start();
  const record = await transport.whenReady();
  socket = await connect(record.port);
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

  socket.destroy();
  await waitFor(() => inspectionCalls >= 3);
  const failures = diagnostics.filter(
    ({ code }) => code === 'target-process-inspection-failed',
  );
  assert.deepEqual(failures, [
    {
      schemaVersion: 1,
      source: 'electron-overlay-transport',
      severity: 'warning',
      code: 'target-process-inspection-failed',
      message:
        'The overlay transport could not confirm whether a disconnected target exited.',
      pid: 4321,
    },
  ]);
  assert.equal(
    JSON.stringify(failures).includes('sensitive process inspection detail'),
    false,
  );
});

test('reconnects reset input state and emit only authoritative disconnects', async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'overlay-input-state-test-'),
  );
  const transport = new OverlayLoopbackTransport({
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
  assert.equal(
    events.filter(({ event }) => event === 'game.process.disconnected').length,
    0,
    'closing a replaced same-PID socket must not report the new socket as disconnected',
  );
  assert.equal(
    events.filter(({ event }) => event === 'game.process.transport-lost')
      .length,
    0,
    'closing a replaced same-PID socket must not report transient transport loss',
  );
  input(0x43);
  await waitFor(() => translated.length === 6);
  assert.deepEqual(translated[5].modifiers, []);

  socket.destroy();
  await waitFor(
    () =>
      events.filter(({ event }) => event === 'game.process.disconnected')
        .length === 1,
  );
  assert.deepEqual(
    events.find(({ event }) => event === 'game.process.disconnected'),
    {
      event: 'game.process.disconnected',
      payload: { pid: 4321, path: 'C:\\games\\test.exe' },
    },
  );
  assert.equal(
    events.filter(({ event }) => event === 'game.process.transport-lost')
      .length,
    1,
  );
});
