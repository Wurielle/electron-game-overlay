const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  parseSceneRunDirectory,
  publishSceneRunRoute,
} = require('./private-route.cjs');
const {
  CooperativeOverlayTransport,
} = require('../../libs/electron-game-overlay/dist/lib/cooperative-overlay-transport.js');
const {
  authorizeOverlaySessionGlobalTarget,
} = require('../../libs/electron-game-overlay/dist/lib/overlay-session-authorization.js');
const {
  encodeJsonTransportPacket,
} = require('../../libs/electron-game-overlay/dist/lib/overlay-loopback-transport.js');

const DISCOVERY = 'electron-overlay-transport-v1.json';
const MARKER = 'electron-overlay-transport-v1.targeted';

async function connect(record, pid) {
  const socket = net.createConnection({ host: '127.0.0.1', port: record.port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  const initialized = new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('Scene target did not authenticate')), 3000);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 5 || buffered.length < 5 + buffered.readUInt32LE(0)) return;
      clearTimeout(timer);
      assert.equal(buffered[4], 1);
      resolve(JSON.parse(buffered.subarray(5, 5 + buffered.readUInt32LE(0))));
    });
  });
  socket.write(encodeJsonTransportPacket({
    type: 'game.process',
    protocolVersion: 1,
    token: record.token,
    pid,
    path: 'C:\\Games\\private-scene-target.exe',
  }));
  assert.equal((await initialized).type, 'overlay.init');
  return socket;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ego-scene-private-route-'));
  const transports = [];
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const transport of transports) transport.stop();
    const resolvedDirectory = path.resolve(directory);
    assert.equal(path.dirname(resolvedDirectory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolvedDirectory).startsWith('ego-scene-private-route-'));
    await rm(resolvedDirectory, { recursive: true, force: true });
  });
  return {
    directory,
    sockets,
    async producer(name) {
      const transport = new CooperativeOverlayTransport({
        directory: path.join(directory, name, 'producer'),
        isProcessAlive: () => true,
      });
      transports.push(transport);
      transport.start();
      const ready = await transport.whenReady();
      const session = { authorizeGlobalTarget: transport.authorizeGlobalTarget.bind(transport) };
      const stage = path.join(directory, name, 'native-stage');
      const release = await publishSceneRunRoute(session, stage, authorizeOverlaySessionGlobalTarget);
      return { transport, ready, stage, release };
    },
  };
}

test('scene run directory is explicit, absolute, normalized and unique', () => {
  assert.equal(parseSceneRunDirectory(['--no-sandbox']), undefined);
  const directory = path.resolve(os.tmpdir(), 'scene proof', '..', 'private stage');
  assert.equal(parseSceneRunDirectory([
    '--no-sandbox',
    `--overlay-run-directory=${directory}`,
  ]), directory);
  for (const value of ['', 'relative-stage', `${directory}\0unexpected`]) {
    assert.throws(() => parseSceneRunDirectory([`--overlay-run-directory=${value}`]));
  }
  assert.throws(() => parseSceneRunDirectory([
    `--overlay-run-directory=${directory}`,
    `--overlay-run-directory=${directory}`,
  ]));
});

test('producer-only mode does not publish a target rendezvous', async () => {
  let calls = 0;
  assert.equal(await publishSceneRunRoute({}, undefined, () => { calls += 1; }), undefined);
  assert.equal(calls, 0);
});

test('scene runners publish independent stage credentials through real private transports', async (t) => {
  const f = await fixture(t);
  const a = await f.producer('a');
  const b = await f.producer('b');
  const aPath = path.join(a.stage, DISCOVERY);
  const bPath = path.join(b.stage, DISCOVERY);
  const aRecord = JSON.parse(await readFile(aPath, 'utf8'));
  const bRecord = JSON.parse(await readFile(bPath, 'utf8'));
  assert.deepEqual(aRecord, a.ready);
  assert.deepEqual(bRecord, b.ready);
  assert.notEqual(aRecord.token, bRecord.token);
  assert.notEqual(aRecord.port, bRecord.port);
  const aSocket = await connect(aRecord, 0x7fffdb20);
  const bSocket = await connect(bRecord, 0x7fffdb21);
  f.sockets.push(aSocket, bSocket);
  const aClosed = once(aSocket, 'close');
  a.transport.stop();
  await aClosed;
  await assert.rejects(readFile(aPath), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(bPath, 'utf8')), bRecord);
  assert.equal(bSocket.destroyed, false);
  b.release();
  await assert.rejects(readFile(bPath), { code: 'ENOENT' });
});

test('a native stage with persistent target intent cannot become an unbound scene route', async (t) => {
  const f = await fixture(t);
  const transport = new CooperativeOverlayTransport({
    directory: path.join(f.directory, 'targeted-producer'),
    isProcessAlive: () => true,
  });
  t.after(() => transport.stop());
  transport.start();
  await transport.whenReady();
  const stage = path.join(f.directory, 'targeted-stage');
  await mkdir(stage);
  const markerPath = path.join(stage, MARKER);
  await writeFile(markerPath, 'retained target intent', { flag: 'wx' });
  const session = { authorizeGlobalTarget: transport.authorizeGlobalTarget.bind(transport) };
  await assert.rejects(
    publishSceneRunRoute(session, stage, authorizeOverlaySessionGlobalTarget),
    /target-bound|unbound|watcher/i,
  );
  await assert.rejects(readFile(path.join(stage, DISCOVERY)), { code: 'ENOENT' });
  assert.equal(await readFile(markerPath, 'utf8'), 'retained target intent');
});
