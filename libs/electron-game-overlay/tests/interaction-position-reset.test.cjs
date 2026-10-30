const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { OverlayBrokerClient } = require('../dist/lib/overlay-broker-client.js');
const { OverlayBrokerServer } = require('../dist/lib/overlay-broker-server.js');

const waitFor = async (predicate) => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'broker/socket fixture timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const details = (name, x) => ({
  name, transparent: true, rect: { x, y: 20, width: 200, height: 100 },
  caption: { left: 8, right: 8, top: 8, height: 32 },
});

test('adding a peer test window must not reannounce stale placements of either app control', async () => {
  // Real broker/client code and sockets; only the native target boundary is controlled.
  // Native caption drag has NO incoming position event in v1. Do not invent one,
  // or implement Rust drag/geometry algorithms in this JavaScript fixture.
  const pid = 43210;
  const executable = 'C:\\Games\\GunFrog.exe';
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\ego-position-${randomUUID()}`
    : `\0ego-position-${randomUUID()}`;
  const announcements = [];
  const knownWindows = new Map();
  const frames = [];
  let nativeEvent;
  const transport = {
    start() {}, stop() {}, whenReady() { return Promise.resolve(); },
    async authorizeTarget() { return () => {}; },
    setDiagnosticCallback() {}, setEventCallback(callback) { nativeEvent = callback; },
    setInputIntercept() {}, closeWindow() {},
    sendFrameBuffer(id, pixels) { frames.push({ id, pixels: [...pixels] }); return true; },
    sendWindowBounds() {}, raiseWindowForSnapshot() {},
    addWindow(id, window) {
      announcements.push({ id, details: structuredClone(window) });
      knownWindows.set(window.name, id);
    },
  };
  const server = new OverlayBrokerServer({
    pipePath, idleShutdownMs: false, runtimeProviderElectionWindowMs: 0,
    isProcessAlive: () => true, targetRecoveryClaimProbe: () => undefined,
    clearTargetRecoveryClaim: () => {}, targetTransportFactory: () => transport,
  });
  const clients = [];
  try {
    await server.start();
    for (let index = 0; index < 2; index++) {
      const client = new OverlayBrokerClient({ pipePath, spawnBroker: () => {} });
      clients.push(client);
      client.start();
      await client.whenReady();
    }
    clients[0].addWindow(7, details('a-control', 10));
    clients[1].addWindow(7, details('b-control', 30));
    await clients[0].authorizeTarget(pid, require('node:path').resolve(process.env.TMPDIR || require('node:os').tmpdir(), 'ego-position-a.json'), executable);
    nativeEvent('game.process', { pid, path: executable });
    await clients[1].authorizeTarget(pid, require('node:path').resolve(process.env.TMPDIR || require('node:os').tmpdir(), 'ego-position-b.json'), executable);
    await waitFor(() => knownWindows.size === 2);
    const a = knownWindows.get('a-control');
    const b = knownWindows.get('b-control');
    assert.notEqual(a, b, 'same local ID must map to distinct target IDs');

    // At this point real native caption drags may have moved both controls.
    // Their placements are private to Rust; focus contains no rectangle.
    const beforeFocus = announcements.length;
    const focused = [];
    clients[0].setEventCallback((event) => focused.push(event));
    nativeEvent('game.window.focused', { pid, focusWindowId: a });
    await waitFor(() => focused.includes('game.window.focused'));
    assert.equal(announcements.length, beforeFocus,
      'bare broker focus must be metadata-only, not a geometry reset');

    clients[0].sendFrameBuffer(7, Buffer.from([1, 2, 3, 4]), 1, 1);
    clients[1].sendFrameBuffer(7, Buffer.from([5, 6, 7, 8]), 1, 1);
    await waitFor(() => frames.length === 2);
    const beforeFrames = frames.length;
    const beforeNewWindow = announcements.length;
    clients[0].addWindow(8, details('a-test', 70));
    await waitFor(() => knownWindows.has('a-test'));
    const staleControlAnnouncements = announcements.slice(beforeNewWindow)
      .filter(({ id }) => id === a || id === b);
    assert.deepEqual(staleControlAnnouncements, [],
      'new test window must not overwrite runtime-owned drag positions with both controls initial SDK rectangles');
    assert.equal(frames.length, beforeFrames, 'peer retained frames must not be resent');

    // Explicit registration intentionally changes/raises its own window only.
    const beforeUpdate = announcements.length;
    clients[0].addWindow(7, details('a-control-updated', 111));
    await waitFor(() => knownWindows.has('a-control-updated'));
    assert.deepEqual(announcements.slice(beforeUpdate).map(({ id, details }) => [id, details.rect.x]),
      [[a, 111]], 'explicit geometry registration must affect only its owner');
    assert.equal(frames.length, beforeFrames, 'peer frames survive another owner registration');

    // A fresh late app has newer order tokens, so v1 permits an incremental append.
    const late = new OverlayBrokerClient({ pipePath, spawnBroker: () => {} });
    clients.push(late);
    late.start();
    await late.whenReady();
    late.addWindow(7, details('late-control', 90));
    late.sendFrameBuffer(7, Buffer.from([9, 10, 11, 12]), 1, 1);
    const beforeLate = announcements.length;
    await late.authorizeTarget(pid, require('node:path').resolve(process.env.TMPDIR || require('node:os').tmpdir(), 'ego-position-late.json'), executable);
    await waitFor(() => knownWindows.has('late-control'));
    assert.deepEqual(announcements.slice(beforeLate).map(({ details }) => details.name),
      ['late-control'], 'fresh late join must not reannounce existing placements');
    assert.deepEqual(frames.slice(beforeFrames), [{ id: knownWindows.get('late-control'), pixels: [9, 10, 11, 12] }],
      'late materialization must send only its own retained frame');
  } finally {
    for (const client of clients) client.stop();
    await server.stop();
  }
});
