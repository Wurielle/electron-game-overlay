const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNativeOverlay } = require('../dist/lib/native.js');
const {
  CooperativeOverlayTransport,
} = require('../dist/lib/cooperative-overlay-transport.js');
const {
  defaultOverlayTargetDiscoveryPath,
  defaultOverlayTargetRecoveryClaimPath,
  encodeJsonTransportPacket,
} = require('../dist/lib/overlay-loopback-transport.js');

const PID = 0x7fffda19;
const IMAGE = 'C:\\Games\\cooperative-target.exe';
const CREATION_TIME = '9007199254740993';
const DISCOVERY = 'electron-overlay-transport-v1.json';
const capabilities = [
  'process-instance-hello-v1',
  'window-order-v1',
  'window-cursor-v1',
  'window-focus-v1',
];

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for participant state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function packets(socket) {
  const pending = [];
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32LE(0)) {
      const end = 5 + buffer.readUInt32LE(0);
      pending.push({
        kind: buffer[4],
        body: Buffer.from(buffer.subarray(5, end)),
      });
      buffer = buffer.subarray(end);
    }
  });
  return {
    async next() {
      await waitFor(() => pending.length > 0);
      return pending.shift();
    },
    async json() {
      const packet = await this.next();
      assert.equal(packet.kind, 1);
      return JSON.parse(packet.body.toString('utf8'));
    },
  };
}

async function connect(record) {
  const socket = net.createConnection({ host: '127.0.0.1', port: record.port });
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function hello(record, overrides = {}) {
  return {
    type: 'game.process',
    protocolVersion: 1,
    token: record.token,
    pid: PID,
    path: IMAGE,
    capabilities,
    creationTime100ns: CREATION_TIME,
    ...overrides,
  };
}

function send(socket, value) {
  socket.write(encodeJsonTransportPacket(value));
}
function input(x) {
  return {
    type: 'game.input',
    windowId: 7,
    msg: 0x0200,
    wparam: 0,
    lparam: (20 << 16) | x,
  };
}
function window(name, x) {
  return { name, transparent: true, rect: { x, y: 20, width: 2, height: 1 } };
}

test('the production backend creates independent participants without starting a feature broker', async (t) => {
  const a = createNativeOverlay();
  const b = createNativeOverlay(true);
  t.after(async () => {
    a.stop();
    b.stop();
    await Promise.all(
      [a, b].map((transport) =>
        rm(transport.directory, { recursive: true, force: true }),
      ),
    );
  });
  assert.ok(a instanceof CooperativeOverlayTransport);
  assert.ok(b instanceof CooperativeOverlayTransport);
  assert.notEqual(a.directory, b.directory);
  a.start();
  b.start();
  const [first, second] = await Promise.all([a.whenReady(), b.whenReady()]);
  assert.notEqual(first.port, second.port);
  assert.notEqual(first.token, second.token);
  assert.equal(
    Object.keys(require.cache).some((filename) =>
      filename.endsWith('overlay-broker-client.js'),
    ),
    false,
  );
});

async function fixture(t, name) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `ego-participant-${name}-`),
  );
  const transport = new CooperativeOverlayTransport({
    directory: path.join(root, 'participant'),
    isProcessAlive: () => true,
  });
  const events = [];
  const diagnostics = [];
  const sockets = [];
  transport.setEventCallback((event, payload) =>
    events.push({ event, payload }),
  );
  transport.setDiagnosticCallback((diagnostic) => diagnostics.push(diagnostic));
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    transport.stop();
    await rm(root, { recursive: true, force: true });
  });
  transport.start();
  await transport.whenReady();
  const discoveryPath = path.join(root, 'staged-addon', DISCOVERY);
  const release = await transport.authorizeTarget(PID, discoveryPath, IMAGE, {
    creationTime100ns: CREATION_TIME,
  });
  const record = JSON.parse(await readFile(discoveryPath, 'utf8'));
  return {
    root,
    transport,
    events,
    diagnostics,
    discoveryPath,
    release,
    record,
    async socket(overrides = {}) {
      const socket = await connect(record);
      sockets.push(socket);
      const reader = packets(socket);
      send(socket, hello(record, overrides));
      return { socket, reader };
    },
  };
}

test('private participants retain colliding local IDs, frames and input across independent disconnects', async (t) => {
  const globalPaths = [
    defaultOverlayTargetDiscoveryPath(PID),
    defaultOverlayTargetRecoveryClaimPath(PID),
  ];
  const readOptional = (filename) =>
    readFile(filename).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  const ownerEvidenceBefore = await Promise.all(globalPaths.map(readOptional));
  const a = await fixture(t, 'a');
  const b = await fixture(t, 'b');
  assert.notEqual(a.record.port, b.record.port);
  assert.notEqual(a.record.token, b.record.token);
  for (const [f, name, x, byte] of [
    [a, 'A', 10, 0x11],
    [b, 'B', 200, 0x22],
  ]) {
    f.transport.addWindow(7, window(name, x));
    f.transport.sendFrameBuffer(7, Buffer.alloc(8, byte), 2, 1);
    f.transport.setWindowCursor(7, 32649);
    f.transport.setWindowFocus(7, true);
    f.transport.setInputIntercept(true);
  }
  const appA = await a.socket();
  const appB = await b.socket();
  for (const [connection, name, byte] of [
    [appA, 'A', 0x11],
    [appB, 'B', 0x22],
  ]) {
    const init = await connection.reader.json();
    assert.equal(init.type, 'overlay.init');
    assert.equal(init.windows.length, 1);
    assert.equal(init.windows[0].windowId, 7);
    assert.equal(init.windows[0].name, name);
    const frame = await connection.reader.next();
    assert.equal(frame.kind, 2);
    assert.equal(frame.body.readUInt32LE(0), 7);
    assert.deepEqual(frame.body.subarray(12), Buffer.alloc(8, byte));
    assert.deepEqual(await connection.reader.json(), {
      type: 'window.cursor',
      windowId: 7,
      cursor: 32649,
    });
    assert.deepEqual(await connection.reader.json(), {
      type: 'window.focus',
      windowId: 7,
      focused: true,
    });
    assert.deepEqual(await connection.reader.json(), {
      type: 'command.input.intercept',
      intercept: true,
    });
  }
  send(appA.socket, input(11));
  send(appB.socket, input(22));
  await waitFor(
    () =>
      a.events.some(({ event }) => event === 'game.input') &&
      b.events.some(({ event }) => event === 'game.input'),
  );
  assert.equal(
    a.events.find(({ event }) => event === 'game.input').payload.lparam &
      0xffff,
    11,
  );
  assert.equal(
    b.events.find(({ event }) => event === 'game.input').payload.lparam &
      0xffff,
    22,
  );
  appA.socket.destroy();
  await waitFor(() =>
    a.events.some(({ event }) => event === 'game.process.transport-lost'),
  );
  assert.equal(
    b.events.some(({ event }) => event === 'game.process.transport-lost'),
    false,
  );
  send(appB.socket, input(23));
  await waitFor(
    () => b.events.filter(({ event }) => event === 'game.input').length === 2,
  );
  const resumedA = await a.socket();
  assert.equal((await resumedA.reader.json()).windows[0].name, 'A');
  assert.equal((await resumedA.reader.next()).kind, 2);
  a.transport.stop();
  b.transport.sendFrameBuffer(7, Buffer.alloc(8, 0x33), 2, 1);
  const frameB = await appB.reader.next();
  assert.equal(frameB.kind, 2);
  assert.deepEqual(frameB.body.subarray(12), Buffer.alloc(8, 0x33));
  assert.equal(
    b.events.some(({ event }) => event === 'game.process.disconnected'),
    false,
  );
  assert.deepEqual(
    await Promise.all(globalPaths.map(readOptional)),
    ownerEvidenceBefore,
    'participant routes must never mutate shared ReShade ownership or static discovery',
  );
});

test('private participant authentication requires its own token and exact pinned incarnation', async (t) => {
  const a = await fixture(t, 'identity-a');
  const b = await fixture(t, 'identity-b');
  for (const overrides of [
    { token: b.record.token },
    { creationTime100ns: '9007199254740994' },
    { capabilities: [], creationTime100ns: undefined },
    { path: 'C:\\Games\\another-game.exe' },
  ]) {
    const { socket } = await a.socket(overrides);
    await new Promise((resolve) => socket.once('close', resolve));
  }
  assert.equal(
    a.events.some(({ event }) => event === 'game.process'),
    false,
  );
  const good = await a.socket();
  assert.equal((await good.reader.json()).type, 'overlay.init');
  await waitFor(() => a.events.some(({ event }) => event === 'game.process'));
  assert.equal(
    b.events.some(({ event }) => event === 'game.process'),
    false,
  );
});

test('future-target private global discovery remains isolated and receives the full scene', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ego-participant-future-'));
  const transports = ['a', 'b'].map(
    (name) =>
      new CooperativeOverlayTransport({
        directory: path.join(root, name),
        isProcessAlive: () => true,
      }),
  );
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    transports.forEach((transport) => transport.stop());
    await rm(root, { recursive: true, force: true });
  });
  for (const [index, transport] of transports.entries()) {
    transport.start();
    transport.addWindow(7, window(`future-${index}`, index * 10));
    const record = await transport.whenReady();
    const socket = await connect(record);
    sockets.push(socket);
    const reader = packets(socket);
    send(socket, hello(record));
    assert.equal((await reader.json()).windows[0].name, `future-${index}`);
  }
});

test('a staged future route upgrades to a bound participant without falling back or losing its credential', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'ego-participant-upgrade-'),
  );
  const transport = new CooperativeOverlayTransport({
    directory: path.join(root, 'owner'),
    isProcessAlive: () => true,
  });
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    transport.stop();
    await rm(root, { recursive: true, force: true });
  });
  transport.start();
  const globalRecord = await transport.whenReady();
  const discoveryPath = path.join(root, 'module', DISCOVERY);
  const releaseGlobal = await transport.authorizeGlobalTarget(discoveryPath);
  assert.deepEqual(
    JSON.parse(await readFile(discoveryPath, 'utf8')),
    globalRecord,
  );
  const authorization = await transport.authorizeTarget(
    PID,
    discoveryPath,
    IMAGE,
    undefined,
    undefined,
    CREATION_TIME,
  );
  assert.equal(authorization.disposition, 'participant');
  assert.equal(authorization.expectedCreationTime100ns, CREATION_TIME);
  const record = JSON.parse(await readFile(discoveryPath, 'utf8'));
  assert.equal(record.targetPid, PID);
  assert.notEqual(record.token, globalRecord.token);
  releaseGlobal();
  assert.deepEqual(
    JSON.parse(await readFile(discoveryPath, 'utf8')),
    record,
    'releasing the watcher must not erase the selected participant credential',
  );
  await assert.rejects(
    transport.authorizeGlobalTarget(discoveryPath),
    /target-bound/,
  );
  const wrong = await connect(record);
  sockets.push(wrong);
  send(wrong, hello(globalRecord));
  await new Promise((resolve) => wrong.once('close', resolve));
  const good = await connect(record);
  sockets.push(good);
  const reader = packets(good);
  send(good, hello(record));
  assert.equal((await reader.json()).type, 'overlay.init');
});
