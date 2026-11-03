'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OverlayLoopbackTransport, encodeJsonTransportPacket } = require('../dist/lib/overlay-loopback-transport.js');
const { createOverlaySession } = require('../dist/lib/overlay-session.js');
const IMAGE = 'C:\\Games\\instance-lifecycle.exe';

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for instance lifecycle evidence');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('typed lifecycle events preserve exact optional uint64 creation identity and legacy absence', () => {
  const session = createOverlaySession({});
  const connected = [];
  session.on('targetConnected', value => connected.push(value));
  for (const [index, creationTime100ns] of ['9007199254740993', '18446744073709551615', undefined].entries()) {
    session.handleEvent('game.process', { pid: 62001 + index, path: IMAGE, ...(creationTime100ns === undefined ? {} : { creationTime100ns }) });
  }
  assert.deepEqual(connected, [
    { pid: 62001, executablePath: IMAGE, creationTime100ns: '9007199254740993' },
    { pid: 62002, executablePath: IMAGE, creationTime100ns: '18446744073709551615' },
    { pid: 62003, executablePath: IMAGE },
  ]);
  assert.ok(connected.every(Object.isFrozen));
  for (const creationTime100ns of [undefined, null, 0, 9007199254740992, '', '0', '01', '-1', '18446744073709551616']) {
    session.handleEvent('game.process', { pid: 62010, path: IMAGE, creationTime100ns });
  }
  assert.equal(connected.length, 3, 'malformed present evidence must not be reinterpreted as legacy absence');
});

test('authenticated transport only exposes negotiated valid native creation evidence', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ego-instance-lifecycle-'));
  const transport = new OverlayLoopbackTransport({ discoveryPath: path.join(directory, 'discovery.json'), isProcessAlive: () => true });
  const sockets = [];
  const observed = [];
  transport.setEventCallback((event, payload) => { if (event === 'game.process') observed.push(payload); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    transport.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  transport.start();
  const record = await transport.whenReady();
  async function connect(pid, extra) {
    const socket = net.createConnection({ host: '127.0.0.1', port: record.port });
    socket.on('error', () => {});
    socket.on('data', () => {});
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write(encodeJsonTransportPacket({ type: 'game.process', protocolVersion: 1, token: record.token, pid, path: IMAGE, ...extra }));
    return socket;
  }
  await connect(62101, { capabilities: ['process-instance-hello-v1'], creationTime100ns: '9007199254740993' });
  await waitFor(() => observed.length === 1);
  assert.deepEqual(observed[0], { pid: 62101, path: IMAGE, creationTime100ns: '9007199254740993',
    capabilities: ['process-instance-hello-v1'],
    inputCapabilities: { copiedWmInput: 'unknown', copiedRawInputBuffer: 'unknown' } });
  await connect(62102, {});
  await waitFor(() => observed.length === 2);
  assert.deepEqual(observed[1], { pid: 62102, path: IMAGE });
  await connect(62103, { capabilities: [], creationTime100ns: '9007199254740993' });
  await waitFor(() => observed.length === 3);
  assert.deepEqual(observed[2], { pid: 62103, path: IMAGE, capabilities: [],
    inputCapabilities: { copiedWmInput: 'unknown', copiedRawInputBuffer: 'unknown' } },
  'unnegotiated creation fields do not acquire authority, and absent input baseline remains unknown');
  const rejected = await connect(62104, { capabilities: ['process-instance-hello-v1'], creationTime100ns: '01' });
  await new Promise(resolve => { if (rejected.destroyed) resolve(); else rejected.once('close', resolve); });
  assert.equal(observed.length, 3);
});
