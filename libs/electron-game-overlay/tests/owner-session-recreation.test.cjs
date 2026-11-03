const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { authorizeOverlaySessionTarget } = require('../dist/lib/overlay-session-authorization.js');
const { defaultOverlayTargetRecoveryClaimPath, encodeJsonTransportPacket } = require('../dist/lib/overlay-loopback-transport.js');

// Exercise the actual production owner source with the real built backend and
// session. No SDK dist/stamp/seal is rewritten while preparing this regression.
function sourceOwner() {
  const filename = path.resolve(__dirname, '../dist/lib/electron-game-overlay.js');
  const owner = new Module(filename, module);
  owner.filename = filename;
  owner.paths = Module._nodeModulePaths(path.dirname(filename));
  const source = fs.readFileSync(path.resolve(__dirname, '../src/lib/electron-game-overlay.ts'), 'utf8');
  owner._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename);
  return owner.exports.ElectronGameOverlay;
}
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw Error('Timed out waiting for owner-session transport');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const IMAGE = 'C:\\Games\\owner-session-target.exe', CREATED = '9007199254740993';
const RAW = ['process-instance-hello-v1', 'input-capabilities-v1', 'copied-wm-input-v1', 'copied-raw-input-buffer-v1'];

test('a replacement public session keeps consumed claims dormant and uses its own fresh route while a sibling survives', async t => {
  const Owner = sourceOwner(), requirements = ['copied-raw-input-buffer'];
  const owner = new Owner({ requiredInputCapabilities: requirements });
  const sibling = new Owner({ requiredInputCapabilities: ['copied-wm-input'] });
  const root = await mkdtemp(path.join(os.tmpdir(), 'ego-owner-recreation-'));
  const backends = new Set(), sockets = [];
  t.after(async () => {
    owner.dispose(); sibling.dispose();
    for (const peer of sockets) peer.socket.destroy();
    for (const backend of backends) {
      backend.stop();
      await rm(backend.directory, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  });
  requirements.length = 0;
  async function start(currentOwner, label) {
    const session = currentOwner.createSession(), backend = currentOwner.nativeOverlay;
    backends.add(backend);
    session.electronScreen = new EventEmitter();
    session.start();
    await session.whenReady();
    const discovery = path.join(root, label, 'electron-overlay-transport-v1.json');
    await authorizeOverlaySessionTarget(session, process.pid, discovery, IMAGE, undefined, undefined, CREATED);
    return { session, backend, discovery,
      claim: defaultOverlayTargetRecoveryClaimPath(process.pid, path.join(backend.directory, 'targets')) };
  }
  async function connect(target, caps = RAW) {
    const record = JSON.parse(await readFile(target.discovery, 'utf8'));
    const socket = net.createConnection({ host: '127.0.0.1', port: record.port });
    const peer = { socket, packets: [], closed: false };
    sockets.push(peer);
    let pending = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('close', () => { peer.closed = true; });
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32LE(0)) {
        const end = 5 + pending.readUInt32LE(0);
        if (pending[4] === 1) peer.packets.push(JSON.parse(pending.subarray(5, end).toString()));
        else peer.packets.push({ type: 'frame', pixels: [...pending.subarray(17, end)] });
        pending = pending.subarray(end);
      }
    });
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(encodeJsonTransportPacket({ type: 'game.process', protocolVersion: 1, token: record.token,
      pid: process.pid, path: IMAGE, capabilities: caps, creationTime100ns: CREATED }));
    return peer;
  }
  function scene(target, value) {
    target.backend.addWindow(7, { name: value, transparent: false, rect: { x: 1, y: 1, width: 1, height: 1 } });
    target.backend.sendFrameBuffer(7, Buffer.from([value === 'old' ? 1 : 2, 3, 4, 255]), 1, 1);
    target.session.input.intercept();
  }
  const first = await start(owner, 'stage-old'), survivor = await start(sibling, 'stage-sibling');
  scene(first, 'old'); scene(survivor, 'sibling');
  const oldPeer = await connect(first), survivorPeer = await connect(survivor);
  await until(() => oldPeer.packets.some(packet => packet.type === 'command.input.intercept') &&
    survivorPeer.packets.some(packet => packet.type === 'frame'));
  assert.throws(() => owner.createSession(), /active overlay session/);
  const consumed = await readFile(first.claim, 'utf8');
  assert.equal(JSON.parse(consumed).phase, 'published');
  first.session.close();
  await until(() => oldPeer.closed);
  assert.equal(await readFile(first.claim, 'utf8'), consumed, 'session close cannot clear a consumed native route claim');
  const replacement = await start(owner, 'stage-new');
  assert.notEqual(replacement.backend, first.backend);
  assert.notEqual(replacement.backend.directory, first.backend.directory);
  const rejected = await connect(replacement, ['process-instance-hello-v1', 'input-capabilities-v1', 'copied-wm-input-v1']);
  await until(() => rejected.closed);
  assert.equal(rejected.packets.length, 0, 'replacement retains immutable owner-level raw-buffer requirements');
  scene(replacement, 'new');
  const currentPeer = await connect(replacement);
  await until(() => currentPeer.packets.some(packet => packet.type === 'frame'));
  assert.equal(currentPeer.packets[0].windows[0].name, 'new');
  assert.deepEqual(currentPeer.packets.find(packet => packet.type === 'frame').pixels, [2, 3, 4, 255]);
  replacement.session.input.release(); survivor.session.input.release();
  await until(() => currentPeer.packets.some(packet => packet.type === 'command.input.intercept' && !packet.intercept) &&
    survivorPeer.packets.some(packet => packet.type === 'command.input.intercept' && !packet.intercept));
  assert.equal(survivorPeer.closed, false, 'another application keeps its authenticated route through replacement');
  assert.equal(await readFile(first.claim, 'utf8'), consumed, 'a fresh session must not rewrite the old consumed claim');
  assert.equal(JSON.parse(await readFile(replacement.claim, 'utf8')).discoveryPath, replacement.discovery);
});
