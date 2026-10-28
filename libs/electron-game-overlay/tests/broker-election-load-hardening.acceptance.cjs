'use strict';
// Opt-in: node --test tests/broker-election-load-hardening.acceptance.cjs
// EGO_HARDENING_OLD_DIST must identify an independently compiled SDK graph.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const test = require('node:test');
const hash = (s) => createHash('sha256').update(s).digest('hex');
function graph(root, mutate = false) {
  root = fs.realpathSync(root);
  const cache = new Map(),
    hashes = {};
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    assert.ok(filename.startsWith(root + path.sep));
    assert.equal(path.extname(filename), '.js');
    let source = fs.readFileSync(filename, 'utf8');
    hashes[path.relative(root, filename)] = hash(source);
    if (
      mutate &&
      filename === path.join(root, 'lib/overlay-broker-server.js')
    ) {
      const election = mutate === 'election';
      const needle = election
        ? 'candidate.runtimeGeneration > current.runtimeGeneration'
        : 'this.transport.setInputIntercept(intercept)';
      assert.equal(source.split(needle).length, 2);
      source = source.replace(
        needle,
        election
          ? 'candidate.runtimeGeneration < current.runtimeGeneration'
          : 'this.transport.setInputIntercept(false)',
      );
      console.log(
        '# MUTATION_APPLIED ' +
          (election ? 'generation-order-reversed' : 'interception-disabled'),
      );
    }
    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, m);
    m.require = (id) => {
      assert.ok(id !== 'electron' && !id.endsWith('.node'));
      const resolved = Module._resolveFilename(id, m);
      return resolved.startsWith(root + path.sep)
        ? load(resolved)
        : require(resolved);
    };
    m._compile(source, filename);
    return m.exports;
  }
  return {
    root,
    hashes,
    Client: load(path.join(root, 'lib/overlay-broker-client.js'))
      .OverlayBrokerClient,
    Server: load(path.join(root, 'lib/overlay-broker-server.js'))
      .OverlayBrokerServer,
  };
}
assert.ok(
  process.env.EGO_HARDENING_OLD_DIST &&
    path.isAbsolute(process.env.EGO_HARDENING_OLD_DIST),
  'Set EGO_HARDENING_OLD_DIST to an absolute independently built SDK dist directory',
);
const old = graph(process.env.EGO_HARDENING_OLD_DIST);
const current = graph(
  path.resolve(__dirname, '../dist'),
  process.env.EGO_HARDENING_MUTATION || false,
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  const end = Date.now() + 4000;
  while (!predicate() && Date.now() < end) await delay(2);
  assert.ok(predicate(), label);
}
class NativeBoundary {
  constructor() {
    this.windows = new Map();
    this.frames = new Map();
    this.routes = [];
    this.intercepts = [];
  }
  start() {}
  whenReady() {
    return Promise.resolve();
  }
  stop() {
    this.stopped = true;
  }
  setEventCallback(cb) {
    this.cb = cb;
  }
  setDiagnosticCallback() {}
  async authorizeTarget(pid, discoveryPath) {
    this.routes.push({ pid, discoveryPath, time: performance.now() });
    return () => {};
  }
  setInputIntercept(value) {
    this.intercepts.push(value);
  }
  addWindow(id, details) {
    this.windows.set(id, details);
  }
  closeWindow(id) {
    this.windows.delete(id);
    this.frames.delete(id);
  }
  sendWindowBounds() {}
  sendFrameBuffer(id, pixels) {
    this.frames.set(id, { size: pixels.length, byte: pixels[0] });
    return true;
  }
  raiseWindowForSnapshot() {}
  emit(event, payload) {
    this.cb(event, payload);
  }
}
const details = (name) => ({
  name,
  transparent: true,
  rect: { x: 0, y: 0, width: 320, height: 160 },
});
async function fixture(t, sdk) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-hardening-'));
  const pipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ego-hardening-${randomUUID()}`
      : path.join(temp, 'b.sock');
  const transports = [],
    clients = [];
  const server = new sdk.Server({
    pipePath,
    idleShutdownMs: false,
    runtimeProviderElectionWindowMs: 50,
    targetRecoveryClaimProbe: () => undefined,
    clearTargetRecoveryClaim: () => {},
    targetTransportFactory() {
      const transport = new NativeBoundary();
      transports.push(transport);
      return transport;
    },
  });
  t.after(async () => {
    clients.forEach((c) => c.stop());
    await server.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await server.start();
  const exe = path.join(temp, 'controlled-game.exe'),
    pid = process.pid;
  async function connect(sdk, generation) {
    const client = new sdk.Client({
      pipePath,
      connectTimeoutMs: 4000,
      runtimeGeneration: generation,
      targetTransportMin: 1,
      targetTransportMax: 1,
      spawnBroker() {
        assert.fail('Must use fresh explicit coordinator');
      },
    });
    const events = [];
    client.setEventCallback((event, payload) =>
      events.push({ event, payload }),
    );
    clients.push(client);
    client.start();
    await client.whenReady();
    const session = [...server.clients].find((s) => !s.fixtureClaimed);
    assert.ok(session);
    session.fixtureClaimed = true;
    return { client, events, session };
  }
  function authorize(app, tag) {
    const p = app.client.authorizeTarget(
      pid,
      path.join(temp, tag, 'transport.json'),
      exe,
    );
    p.catch(() => {});
    return p;
  }
  return { server, connect, authorize, transports, pid, exe };
}
test('SDK implementation graphs differ beyond package version labels', () => {
  for (const file of ['overlay-broker-client.js', 'overlay-broker-server.js']) {
    const implementation = (g) =>
      fs
        .readFileSync(path.join(g.root, 'lib', file), 'utf8')
        .replace(/const SDK_VERSION\s*=\s*[^;]+;/g, '')
        .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
    assert.notEqual(hash(implementation(old)), hash(implementation(current)));
  }
  console.log(
    '# PACKAGE_GRAPHS ' +
      JSON.stringify({ old: old.hashes, current: current.hashes }),
  );
});
for (const [serverName, sdk] of [
  ['old', old],
  ['current', current],
]) {
  for (const order of [
    ['old', 'current'],
    ['current', 'old'],
  ]) {
    for (const high of ['old', 'current']) {
      test(
        `fresh ${serverName} coordinator; ${order.join(' then ')}; ${high} higher generation`,
        { timeout: 12000 },
        async (t) => {
          const f = await fixture(t, sdk);
          const apps = {};
          // Apps become ready in this order before observing the target PID.
          // Submit both requests together so host scheduling cannot turn the
          // intended open-cohort case into a valid late-arrival case.
          const started = performance.now();
          apps[order[0]] = await f.connect(
            order[0] === 'old' ? old : current,
            order[0] === high ? 9 : 1,
          );
          apps[order[1]] = await f.connect(
            order[1] === 'old' ? old : current,
            order[1] === high ? 9 : 1,
          );
          const pending = {};
          const sent = performance.now();
          for (const name of order) pending[name] = f.authorize(apps[name], name);
          await until(
            () => [...f.server.targets.values()][0]?.members.size === 2,
            'Both providers admitted before cutoff',
          );
          const host = [...f.server.targets.values()][0];
          assert.equal(
            host.electionWindowElapsed,
            false,
            'Both actual socket requests must enter the open cohort',
          );
          const transport = f.transports[0];
          await until(
            () => transport.routes.length === 1,
            '50ms election publishes one route',
          );
          assert.equal(
            path.basename(path.dirname(transport.routes[0].discoveryPath)),
            high,
            'Highest generation wins, not coordinator or arrival order',
          );
          assert.ok(
            transport.routes[0].time - sent >= 40,
            'Election must not publish immediately',
          );
          assert.equal((await pending[high]).disposition, 'injection-owner');
          const late = await f.connect(current, 99);
          let lateSettled = false;
          const latePending = f.authorize(late, 'late').then((v) => {
            lateSettled = true;
            return v;
          });
          await until(
            () => host.members.size === 3,
            'Late higher request admitted after publication',
          );
          await delay(60);
          assert.equal(
            lateSettled,
            false,
            'Late higher waits for authentication, never takes over',
          );
          assert.equal(transport.routes.length, 1);
          transport.emit('game.process', { pid: f.pid, path: f.exe });
          assert.equal(
            (await pending[high === 'old' ? 'current' : 'old']).disposition,
            'joined-existing',
          );
          assert.equal((await latePending).disposition, 'joined-existing');
          assert.equal(f.transports.length, 1);
          assert.equal(transport.routes.length, 1);
          console.log(
            '# ELECTION ' +
              JSON.stringify({
                serverName,
                order,
                high,
                elapsedMs: performance.now() - started,
              }),
          );
        },
      );
    }
  }
}
for (const count of [32, 64])
  test(
    `${count} actual socket members: collision isolation, bounded frames, stalled cleanup and survivor progress`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, current),
        apps = [];
      for (let i = 0; i < count; i++)
        apps.push(await f.connect(i % 2 ? old : current, 1));
      const owner = await f.authorize(apps[0], 'owner');
      assert.equal(owner.disposition, 'injection-owner');
      const transport = f.transports[0];
      transport.emit('game.process', { pid: f.pid, path: f.exe });
      await Promise.all(
        apps.slice(1).map((a, i) => f.authorize(a, `peer-${i}`)),
      );
      const width = count === 32 ? 320 : 256;
      const height = count === 32 ? 160 : 128;
      const bytes = width * height * 4;
      apps.forEach((app, i) => {
        const window = details(`app-${i}`);
        window.rect.width = width;
        window.rect.height = height;
        app.client.addWindow(7, window);
        app.client.sendFrameBuffer(
          7,
          Buffer.alloc(bytes, i + 1),
          width,
          height,
        );
      });
      await until(
        () => transport.frames.size === count,
        'All bounded frames forwarded over real sockets',
      );
      assert.equal(transport.windows.size, count);
      assert.equal(new Set(transport.windows.keys()).size, count);
      for (const [id, window] of transport.windows)
        assert.deepEqual(transport.frames.get(id), {
          size: bytes,
          byte: Number(window.name.slice(4)) + 1,
        });
      const lastId = [...transport.windows].find(
        ([, w]) => w.name === `app-${count - 1}`,
      )[0];
      transport.emit('game.input', {
        pid: f.pid,
        windowId: lastId,
        kind: 'mouseMove',
        x: 1,
        y: 1,
      });
      transport.emit('game.graphics.fps', { pid: f.pid, fps: 123 });
      await until(
        () =>
          apps.every((a) =>
            a.events.some(
              (e) => e.event === 'game.graphics.fps' && e.payload.fps === 123,
            ),
          ),
        'Socket fanout barrier',
      );
      assert.deepEqual(
        apps.map(
          (a) => a.events.filter((e) => e.event === 'game.input').length,
        ),
        apps.map((_, i) => (i === count - 1 ? 1 : 0)),
      );
      assert.equal(
        apps.at(-1).events.find((e) => e.event === 'game.input').payload
          .windowId,
        7,
      );
      apps[0].client.setInputIntercept(true);
      await until(
        () => apps[0].session.inputIntercept,
        'First true request processed',
      );
      assert.equal(
        transport.intercepts.at(-1),
        true,
        'interception OR must preserve live true request',
      );
      apps[1].client.setInputIntercept(false);
      apps[2].client.setInputIntercept(true);
      await until(
        () => apps[2].session.inputIntercept,
        'Second true request processed',
      );
      assert.equal(transport.intercepts.at(-1), true);
      // Pause a genuine reader; lower only the existing queue budget, not production scheduling.
      const stalled = apps[0].session;
      const stalledErrors = [];
      stalled.socket.on('error', (error) => stalledErrors.push(error.code));
      apps[0].client.socket.pause();
      stalled.writer.maxPendingBytes = 256 * 1024;
      for (let i = 0; i < 64 && !stalled.socket.destroyed; i++)
        stalled.send({ type: 'game.fixture', data: 'x'.repeat(64 * 1024) });
      await until(
        () => !f.server.clients.has(stalled),
        'Paused reader must be cleaned after bounded queue overflow',
      );
      assert.deepEqual(
        stalledErrors,
        ['ERR_OVERLAY_QUEUE_LIMIT'],
        'Cleanup must be caused by the bounded queue, not arbitrary socket failure',
      );
      apps[0].client.stop();
      assert.equal(stalled.windows.size, 0);
      assert.equal(stalled.writer.pendingBytes, 0);
      assert.equal(transport.windows.size, count - 1);
      assert.equal(
        transport.intercepts.at(-1),
        true,
        'Survivor true request remains',
      );
      apps[1].client.stop();
      await until(
        () => transport.windows.size === count - 2,
        'One ordinary disconnect removes only its window',
      );
      apps
        .at(-1)
        .client.sendFrameBuffer(7, Buffer.alloc(bytes, 201), width, height);
      await until(
        () => transport.frames.get(lastId)?.byte === 201,
        'Survivor frame progresses after stalled-peer cleanup',
      );
      const inputCounts = apps.map(
        (app) => app.events.filter((event) => event.event === 'game.input').length,
      );
      transport.emit('game.input', {
        pid: f.pid,
        windowId: lastId,
        kind: 'mouseMove',
        x: 2,
        y: 2,
      });
      transport.emit('game.graphics.fps', { pid: f.pid, fps: 124 });
      await until(
        () =>
          apps.slice(2).every((app) =>
            app.events.some(
              (event) =>
                event.event === 'game.graphics.fps' && event.payload.fps === 124,
            ),
          ),
        'Survivor input fanout barrier after cleanup',
      );
      assert.deepEqual(
        apps.map(
          (app, i) =>
            app.events.filter((event) => event.event === 'game.input').length -
            inputCounts[i],
        ),
        apps.map((_, i) => (i === count - 1 ? 1 : 0)),
        'Cleanup must preserve owner-only survivor input routing',
      );
      apps[2].client.setInputIntercept(false);
      await until(
        () => !apps[2].session.inputIntercept,
        'Last true request cleared',
      );
      assert.equal(transport.intercepts.at(-1), false);
      assert.equal(transport.stopped, undefined);
      assert.equal(transport.routes.length, 1);
      console.log(
        '# LOAD ' +
          JSON.stringify({
            count,
            bytesPerFrame: bytes,
            aggregateFrameBytes: count * bytes,
            pausedReaderQueueLimit: 256 * 1024,
            maxFloodBytes: 64 * 64 * 1024,
          }),
      );
    },
  );
