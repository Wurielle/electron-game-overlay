'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { PacketMetadataObserver, packetSummary, wireSummary, observeNativeConnections, parseArguments, isFixtureEntry } = require('../scripts/cooperative-input-capabilities-fixture.cjs');

function packet(value, kind = 1) {
  const body = kind === 1 ? Buffer.from(JSON.stringify(value)) : Buffer.from(value);
  const result = Buffer.alloc(body.length + 5);
  result.writeUInt32LE(body.length); result[4] = kind; body.copy(result, 5); return result;
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fixture wire metadata.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('fixture arguments require an exact target and default strict rejection versus supported WM admission', () => {
  const common = ['--evidence=C:/owned/evidence', '--sdk-dist=C:/owned/sdk', '--target=C:/owned/host.exe', '--pid=123'];
  assert.equal(parseArguments([...common, '--member=strict']).require, 'copied-raw-input-buffer');
  assert.equal(parseArguments([...common, '--member=strict']).expect, 'reject');
  assert.equal(parseArguments([...common, '--member=permissive']).require, 'copied-wm-input');
  assert.equal(parseArguments([...common, '--member=permissive']).expect, 'accept');
  assert.equal(parseArguments([...common, '--member=strict', '--expect=accept']).expect, 'accept');
  for (const value of [[], common, [...common, '--member=strict', '--pid=0'], [...common, '--member=strict', '--require=fictional-input']]) assert.throws(() => parseArguments(value));
});

test('Electron default-app browser entry runs even when require.main belongs to its loader', () => {
  const fixture = path.resolve(__dirname, '../scripts/cooperative-input-capabilities-fixture.cjs');
  const selected = { isMain: false, electron: '42.0.0', processType: 'browser', argv: ['electron.exe', fixture, '--member=strict'] };
  assert.equal(isFixtureEntry(selected), true);
  assert.equal(isFixtureEntry({ ...selected, argv: ['electron.exe', '--force-device-scale-factor=1', fixture, '--member=strict'] }), true);
  assert.equal(isFixtureEntry({ ...selected, argv: ['electron.exe', '--require', __filename, fixture, '--member=strict'] }), true);
  assert.equal(isFixtureEntry({ ...selected, argv: ['electron.exe', '-r', __filename, '--app=' + fixture] }), true);
  assert.equal(isFixtureEntry({ ...selected, isMain: true, electron: undefined, processType: undefined }), true);
  assert.equal(isFixtureEntry({ ...selected, processType: 'renderer' }), false);
  assert.equal(isFixtureEntry({ ...selected, electron: undefined }), false);
  assert.equal(isFixtureEntry({ ...selected, argv: ['electron.exe', __filename] }), false);
  assert.equal(isFixtureEntry({ ...selected, argv: ['electron.exe'] }), false);
  assert.equal(isFixtureEntry({ ...selected, argv: ['electron.exe', path.join(__dirname, 'missing-fixture.cjs')] }), false);
  assert.equal(isFixtureEntry(), false, 'requiring this module in a Node test must not start Electron');
});

test('the actual selected Electron module enters run with a different require.main', async () => {
  const fixture = path.resolve(__dirname, '../scripts/cooperative-input-capabilities-fixture.cjs');
  const errors = [], exits = [];
  const requireFromLoader = name => name === 'electron' ? { app: { exit: code => exits.push(code) } } : require(name);
  requireFromLoader.main = { filename: 'electron-default-app-loader.js' };
  // Invalid fixture arguments deliberately stop before SDK loading or any file
  // writes. Observing that rejection proves the real bottom-level entry guard
  // invoked run(), rather than merely testing a disconnected predicate.
  vm.runInNewContext(fs.readFileSync(fixture, 'utf8'), {
    require: requireFromLoader, module: { exports: {} }, __filename: fixture,
    process: { versions: { electron: '42.0.0' }, type: 'browser', platform: process.platform, argv: ['electron.exe', '--force-device-scale-factor=1', fixture] },
    console: { error: error => errors.push(error) }, Buffer,
  }, { filename: fixture });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Expected member strict\|permissive/u);
  assert.deepEqual(exits, [1]);
});

test('fragmented packet observation retains only actual hello identity and typed counters, never credentials or frame payload', () => {
  const inbound = packetSummary(), outbound = packetSummary();
  const reader = new PacketMetadataObserver('inbound', inbound), writer = new PacketMetadataObserver('outbound', outbound);
  const hello = packet({ type: 'game.process', protocolVersion: 1, pid: 123, path: 'C:/owned/host.exe', creationTime100ns: '134380000000000000',
    token: 'NEVER_PERSIST_THIS_TOKEN', nested: { secret: 'NEVER_PERSIST_THIS_NESTED_PAYLOAD' }, capabilities: ['input-capabilities-v1', 'copied-wm-input-v1'] });
  for (let offset = 0; offset < hello.length; offset += 3) reader.push(hello.subarray(offset, offset + 3));
  const init = packet({ type: 'overlay.init', windows: [{ id: 8, name: 'NEVER_PERSIST_THIS_WINDOW_PAYLOAD' }] });
  const frame = packet(Buffer.from('NEVER_PERSIST_THIS_FRAME_PAYLOAD'), 2);
  const command = packet({ type: 'command.input.intercept', intercept: true });
  const bytes = Buffer.concat([init, frame, command]);
  for (let offset = 0; offset < bytes.length; offset += 7) writer.push(bytes.subarray(offset, offset + 7));
  assert.equal(inbound.bytes, hello.length);
  assert.deepEqual(inbound.hello.capabilities, ['input-capabilities-v1', 'copied-wm-input-v1']);
  assert.equal(inbound.hello.pid, 123);
  assert.equal(outbound.bytes, bytes.length);
  assert.equal(outbound.frames, 1);
  assert.equal(outbound.interceptTrue, 1);
  assert.equal(outbound.types['overlay.init'], 1);
  const aggregate = wireSummary([{ inbound, outbound }]);
  assert.equal(aggregate.helloCount, 1);
  assert.equal(aggregate.outboundBytes, bytes.length);
  assert.equal(aggregate.outboundFrames, 1);
  assert.equal(aggregate.interceptTruePackets, 1);
  assert.doesNotMatch(JSON.stringify({ inbound, outbound, aggregate }), /NEVER_PERSIST|"token"|"nested"|"windows"/u);
});

test('wire errors are bounded labels and cannot quote a malformed credential body', () => {
  const summary = packetSummary(), observer = new PacketMetadataObserver('inbound', summary);
  const body = Buffer.from('{"token":"secret-must-not-leak"');
  observer.push(packet(body, 2).map((byte, index) => index === 4 ? 1 : byte));
  assert.equal(summary.error, 'malformed-json');
  assert.doesNotMatch(JSON.stringify(summary), /secret-must-not-leak|token/u);
});

test('real TCP observer sees rejected routes receive zero bytes while an independent allowed route gets its complete snapshot', { concurrency: false }, async () => {
  // Simulated peers prove the observer; the acceptance launcher supplies actual
  // native hellos. This unit does not establish native/stock-host support.
  const records = [], observedErrors = [], restore = observeNativeConnections(records, error => observedErrors.push(error));
  const blocked = net.createServer(socket => { socket.on('error', () => {}); socket.once('data', () => socket.destroy()); });
  const allowed = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write(packet({ type: 'overlay.init', windows: [] }));
      socket.write(packet(Buffer.alloc(16, 0x7f), 2));
      socket.write(packet({ type: 'command.input.intercept', intercept: true }));
    });
  });
  const peers = [];
  try {
    blocked.listen(0, '127.0.0.1'); allowed.listen(0, '127.0.0.1');
    await Promise.all([once(blocked, 'listening'), once(allowed, 'listening')]);
    const nativeHello = packet({ type: 'game.process', pid: 123, path: 'C:/owned/host.exe', protocolVersion: 1,
      token: 'do-not-record-credentials', capabilities: ['input-capabilities-v1', 'copied-wm-input-v1'] });
    for (const server of [blocked, allowed]) {
      const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
      peers.push(socket); socket.on('error', () => {}); socket.on('data', () => {});
      await once(socket, 'connect'); socket.write(nativeHello);
    }
    await until(() => records.length === 2 && records[0].closed && records[1].outbound.interceptTrue === 1);
    assert.equal(records[0].inbound.hello.pid, 123);
    assert.equal(records[0].outbound.bytes, 0);
    assert.equal(records[0].actualBytesWritten, 0);
    assert.equal(records[1].outbound.types['overlay.init'], 1);
    assert.equal(records[1].outbound.frames, 1);
    assert.equal(records[1].outbound.interceptTrue, 1);
    assert.equal(records[1].closed, false);
    assert.equal(observedErrors.length, 0);
    assert.doesNotMatch(JSON.stringify(records), /do-not-record-credentials|"token"/u);
  } finally {
    for (const peer of peers) peer.destroy();
    await Promise.all([new Promise(resolve => blocked.close(resolve)), new Promise(resolve => allowed.close(resolve))]);
    restore();
  }
});

test('acceptance fixture uses immutable public requirements, retains rejected routes, and never fabricates native hello tokens', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/cooperative-input-capabilities-fixture.cjs'), 'utf8');
  assert.match(source, /new ElectronGameOverlay\(\{ requiredInputCapabilities: \[args\.require\] \}\)/u);
  assert.match(source, /session\.on\('targetInputCapabilitiesRejected'/u);
  assert.match(source, /error\.diagnostic\?\.code !== 'target-input-capability-unsupported'/u);
  assert.match(source, /value\.type === 'runtime-staged'/u);
  assert.match(source, /state\.transport = \{ producerPid: route\.pid, targetPid: route\.targetPid/u);
  assert.match(source, /observeNativeConnections\(state\.wireConnections, fail\)/u);
  assert.doesNotMatch(source, /socket\.write\(.*game\.process|encodeJsonTransportPacket\(.*game\.process/u);
});
