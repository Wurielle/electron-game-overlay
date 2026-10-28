const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const clientPath = require.resolve('../dist/lib/overlay-broker-client.js');
// Disposable in-memory mutation: never rewrite source or dist.
if (process.env.EGO_CRASH_MUTATE_SETTLEMENT === '1') {
  const source = require('node:fs').readFileSync(clientPath, 'utf8');
  const needle =
    'if (lease.settled) {\n            return;\n        }\n        lease.settled = true;\n        lease.resolve';
  assert.equal(
    source.split(needle).length,
    2,
    'mutation must match exactly once',
  );
  const mod = new Module(clientPath, module);
  mod.filename = clientPath;
  mod.paths = Module._nodeModulePaths(path.dirname(clientPath));
  require.cache[clientPath] = mod;
  mod._compile(
    source.replace(
      needle,
      'if (false) {\n            return;\n        }\n        lease.settled = true;\n        lease.resolve',
    ),
    clientPath,
  );
}
const { OverlayBrokerClient } = require(clientPath);
const {
  encodeJsonTransportPacket,
} = require('../dist/lib/overlay-loopback-transport.js');
function bounded(promise, label, signal, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, new Error(`Aborted: ${label}`));
    const timer = setTimeout(
      () => finish(reject, new Error(`Timeout: ${label}`)),
      timeout,
    );
    signal?.addEventListener('abort', abort, { once: true });
    // Observe late rejection even after cancellation wins.
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal?.aborted) abort();
  });
}
async function killOwned(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await bounded(exited, 'owned child exit', signal, 2000);
}
function ownedCleanup(t, root, children, clients, sockets) {
  let cleanup;
  const run = () =>
    (cleanup ??= (async () => {
      clients.forEach((client) => client.stop());
      sockets.forEach((socket) => socket.destroy());
      // Independent cleanup budget: never use the already-aborted test signal.
      await Promise.all(children.map((child) => killOwned(child)));
      await bounded(
        fs.rm(root, { recursive: true, force: true }),
        'owned root removal',
        undefined,
        2000,
      );
    })());
  t.after(run);
  return run;
}
const poll = async (predicate, label, timeout = 6000, signal) => {
  const end = Date.now() + timeout;
  while (
    !(await bounded(Promise.resolve().then(predicate), label, signal, timeout))
  ) {
    if (Date.now() > end) throw new Error(`Timeout: ${label}`);
    await bounded(
      new Promise((resolve) => setTimeout(resolve, 10)),
      label,
      signal,
      timeout,
    );
  }
};
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const window = (name) => ({
  name,
  transparent: true,
  rect: { x: 0, y: 0, width: 2, height: 1 },
  caption: { left: 0, right: 0, top: 0, height: 0 },
});

// Minimal fixture for the two claim-boundary cases; production owns every write.
async function claimFixture(t) {
  const waitFor = (predicate, label, timeout) =>
    poll(predicate, label, timeout, t.signal);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ego-claim-crash-'));
  const pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ego-claim-${process.pid}-${path.basename(root)}`
      : path.join(root, 'broker.sock');
  const pid = process.pid;
  const exe = 'C:\\controlled-native-boundary\\game.exe';
  const route = path.join(root, 'owner', 'electron-overlay-transport-v1.json');
  const claimPath = path.join(
    root,
    '.electron-game-overlay',
    'broker-v1',
    `electron-overlay-transport-v1.pid-${pid}.recovery.json`,
  );
  const children = [],
    clients = [],
    sockets = [],
    authorizations = [],
    barriers = [];
  ownedCleanup(t, root, children, clients, sockets);
  async function launch({ barrier = false, mutate = false } = {}) {
    if (process.platform !== 'win32') await fs.rm(pipe, { force: true });
    const child = fork(
      path.join(__dirname, 'broker-crash-recovery-hardening-child.cjs'),
      [],
      {
        env: {
          ...process.env,
          EGO_CRASH_TEST_ROOT: root,
          EGO_CRASH_TEST_PIPE: pipe,
          EGO_CRASH_PUBLISHING_CLAIM: barrier ? claimPath : '',
          EGO_CRASH_MUTATE_FREEZE: mutate ? '1' : '',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    children.push(child);
    let ready = false,
      stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('message', (value) => {
      if (value.kind === 'ready') ready = true;
      if (value.kind === 'authorization') authorizations.push(value.message);
      if (value.kind === 'publishing-durable') barriers.push(value.claim);
    });
    await waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`broker setup failed: ${stderr}`);
      return ready;
    }, 'broker ready');
    return child;
  }
  async function client() {
    const sdk = new OverlayBrokerClient({
      pipePath: pipe,
      spawnBroker() {},
      connectTimeoutMs: 6000,
    });
    clients.push(sdk);
    sdk.start();
    await bounded(sdk.whenReady(), 'SDK ready', t.signal);
    return sdk;
  }
  function authorize(sdk, discoveryPath = route) {
    const state = { settled: false, result: null, error: null };
    state.promise = sdk.authorizeTarget(pid, discoveryPath, exe).then(
      (result) => {
        state.settled = true;
        return (state.result = result);
      },
      (error) => {
        state.settled = true;
        state.error = error;
      },
    );
    return state;
  }
  async function authenticate() {
    const record = await json(route);
    const socket = net.createConnection({
      host: '127.0.0.1',
      port: record.port,
    });
    sockets.push(socket);
    socket.on('error', () => {});
    await bounded(once(socket, 'connect'), 'native socket connect', t.signal);
    socket.write(
      encodeJsonTransportPacket({
        type: 'game.process',
        protocolVersion: 1,
        token: record.token,
        pid,
        path: exe,
      }),
    );
  }
  async function recovered(child, pinned) {
    await waitFor(async () => {
      try {
        return (await json(route)).pid === child.pid;
      } catch {
        return false;
      }
    }, 'pinned replacement route');
    const claim = await json(claimPath);
    for (const key of ['discoveryPath', 'staticDiscoveryPath', 'leaseId']) {
      assert.equal(claim[key], pinned[key], `preserved claim ${key}`);
    }
    return claim;
  }
  async function sdkApp() {
    const app = fork(
      path.join(__dirname, 'broker-crash-recovery-hardening-child.cjs'),
      [],
      {
        env: {
          ...process.env,
          EGO_CRASH_TEST_ROOT: root,
          EGO_CRASH_TEST_PIPE: pipe,
          EGO_CRASH_TEST_ROLE: 'sdk',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    children.push(app);
    const messages = [];
    app.on('message', (message) => messages.push(message));
    await waitFor(
      () => messages.some((m) => m.kind === 'sdk-ready'),
      'SDK app ready',
    );
    app.send({ kind: 'authorize', pid, route, exe });
    return {
      async result() {
        await waitFor(
          () =>
            messages.some(
              (m) => m.kind === 'sdk-authorized' || m.kind === 'sdk-error',
            ),
          'SDK app authorization',
        );
        const message = messages.find(
          (m) => m.kind === 'sdk-authorized' || m.kind === 'sdk-error',
        );
        assert.equal(message.kind, 'sdk-authorized', message.error);
        return message.result;
      },
      async exit() {
        const exited = once(app, 'exit');
        app.send({ kind: 'exit' });
        assert.equal(
          (await bounded(exited, 'SDK app exit', t.signal, 2000))[0],
          0,
          'SDK app process exited cleanly',
        );
      },
    };
  }
  return {
    root,
    route,
    claimPath,
    pid,
    launch,
    client,
    sdkApp,
    authorize,
    authenticate,
    recovered,
    killOwned: (child) => killOwned(child, t.signal),
    authorizations,
    barriers,
  };
}

test(
  'publishing durable claim freezes original unsettled lease and fresh member until native authentication',
  { timeout: 30000 },
  async (t) => {
    const f = await claimFixture(t);
    const child = await f.launch({ barrier: true });
    const waitFor = (predicate, label, timeout) =>
      poll(predicate, label, timeout, t.signal);
    const original = await f.client();
    const pending = f.authorize(original);
    await waitFor(
      () => f.barriers.length === 1,
      'actual publishing rename acknowledgement',
    );
    const pinned = await json(f.claimPath);
    assert.equal(pinned.phase, 'publishing');
    assert.deepEqual(pinned, f.barriers[0]);
    assert.equal(
      pending.settled,
      false,
      'authorization has not returned at publication barrier',
    );
    assert.equal(f.authorizations.length, 0, 'no grant delivered before crash');
    await assert.rejects(fs.access(f.route), { code: 'ENOENT' });
    await f.killOwned(child);
    const replacement = await f.launch({
      mutate: process.env.EGO_CRASH_MUTATE_FREEZE === '1',
    });
    await f.recovered(replacement, pinned);
    const fresh = await f.client();
    assert.equal(
      fresh.targetLeases.size,
      0,
      'fresh member has no remembered lease',
    );
    const waiter = f.authorize(
      fresh,
      path.join(f.root, 'fresh', 'electron-overlay-transport-v1.json'),
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(
      f.authorizations.filter((a) => a.disposition === 'injection-owner')
        .length,
      0,
      'possibly consumed publishing claim must never regrant injection',
    );
    assert.equal(
      pending.settled,
      false,
      'original unsettled lease waits for authentication',
    );
    assert.equal(
      waiter.settled,
      false,
      'fresh member waits for authentication',
    );
    await f.authenticate();
    await waitFor(
      () => pending.settled && waiter.settled,
      'late native authentication releases both waiters',
    );
    assert.equal(pending.result?.disposition, 'joined-existing');
    assert.equal(waiter.result?.disposition, 'joined-existing');
    await f.recovered(replacement, pinned);
    assert.equal(
      f.authorizations.filter((a) => a.disposition === 'injection-owner')
        .length,
      0,
    );
  },
);

test(
  'published claim survives every prior SDK app exit and broker death for a fresh lease',
  { timeout: 30000 },
  async (t) => {
    const f = await claimFixture(t);
    const child = await f.launch();
    const waitFor = (predicate, label, timeout) =>
      poll(predicate, label, timeout, t.signal);
    const first = await f.sdkApp();
    assert.equal((await first.result()).disposition, 'injection-owner');
    const pinned = await json(f.claimPath);
    assert.equal(pinned.phase, 'published');
    await f.authenticate();
    const second = await f.sdkApp();
    assert.equal((await second.result()).disposition, 'joined-existing');
    await first.exit();
    await second.exit();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await f.killOwned(child);
    assert.deepEqual(
      await json(f.claimPath),
      pinned,
      'app exits and coordinator death retain claim',
    );
    const replacement = await f.launch();
    const fresh = await f.client();
    assert.equal(
      fresh.targetLeases.size,
      0,
      'no remembered lease in fresh SDK',
    );
    const waiting = f.authorize(
      fresh,
      path.join(f.root, 'fresh', 'electron-overlay-transport-v1.json'),
    );
    await f.recovered(replacement, pinned);
    assert.notEqual(fresh.targetLeases.get(f.pid).leaseId, pinned.leaseId);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(waiting.settled, false);
    assert.equal(
      f.authorizations.filter((a) => a.disposition === 'injection-owner')
        .length,
      1,
      'fresh app cannot acquire a second injection grant',
    );
    await f.authenticate();
    await bounded(waiting.promise, 'fresh authorization', t.signal);
    assert.equal(waiting.result?.disposition, 'joined-existing');
    await f.recovered(replacement, pinned);
    assert.equal(
      f.authorizations.filter((a) => a.disposition === 'injection-owner')
        .length,
      1,
    );
  },
);

test(
  'published claim survives two abrupt coordinator process deaths with two SDK survivors and one injection grant',
  { timeout: 30000 },
  async (t) => {
    const waitFor = (predicate, label, timeout) =>
      poll(predicate, label, timeout, t.signal);
    const root = await fs.mkdtemp(
      path.join(process.env.TMPDIR || os.tmpdir(), 'ego-crash-hardening-'),
    );
    const pipe =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\ego-crash-${process.pid}-${Date.now()}`
        : path.join(root, 'broker.sock');
    const pid = process.pid; // Real live process; never killed by this test.
    const exe = 'C:\\controlled-native-boundary\\game.exe';
    const route = path.join(
      root,
      'owner',
      'electron-overlay-transport-v1.json',
    );
    const claimPath = path.join(
      root,
      '.electron-game-overlay',
      'broker-v1',
      `electron-overlay-transport-v1.pid-${pid}.recovery.json`,
    );
    const children = [],
      clients = [],
      sockets = [],
      authorizations = [];
    const cleanup = ownedCleanup(t, root, children, clients, sockets);
    let child;
    const launch = async () => {
      if (process.platform !== 'win32') await fs.rm(pipe, { force: true }); // Owned dead child's socket only.
      child = fork(
        path.join(__dirname, 'broker-crash-recovery-hardening-child.cjs'),
        [],
        {
          env: {
            ...process.env,
            EGO_CRASH_TEST_ROOT: root,
            EGO_CRASH_TEST_PIPE: pipe,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      children.push(child);
      let ready = false,
        stderr = '';
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.on('message', (value) => {
        if (value.kind === 'ready') ready = true;
        if (value.kind === 'authorization') authorizations.push(value.message);
      });
      await waitFor(() => {
        if (child.exitCode !== null)
          throw new Error(`broker setup failed: ${stderr}`);
        return ready;
      }, 'broker ready');
      return child;
    };
    const peer = async (record) => {
      const socket = net.createConnection({
        host: '127.0.0.1',
        port: record.port,
      });
      sockets.push(socket);
      socket.on('error', () => {});
      const packets = [];
      let buffered = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (
          buffered.length >= 5 &&
          buffered.length >= buffered.readUInt32LE(0) + 5
        ) {
          const length = buffered.readUInt32LE(0) + 5;
          const body = Buffer.from(buffered.subarray(5, length));
          packets.push(
            buffered[4] === 1 ? JSON.parse(body.toString()) : { frame: body },
          );
          buffered = buffered.subarray(length);
        }
      });
      await bounded(once(socket, 'connect'), 'native socket connect', t.signal);
      socket.write(
        encodeJsonTransportPacket({
          type: 'game.process',
          protocolVersion: 1,
          token: record.token,
          pid,
          path: exe,
        }),
      );
      return { socket, packets };
    };
    try {
      await launch();
      const events = [[], []],
        settlements = [0, 0];
      for (let i = 0; i < 2; i++) {
        const client = new OverlayBrokerClient({
          pipePath: pipe,
          spawnBroker() {},
          connectTimeoutMs: 6000,
        });
        clients.push(client);
        client.setEventCallback((event, payload) =>
          events[i].push({ event, payload }),
        );
        client.start();
        await bounded(client.whenReady(), 'SDK ready', t.signal);
        client.addWindow(7, window(`app-${i}`));
        client.sendFrameBuffer(7, Buffer.alloc(8, i + 1), 2, 1);
      }
      clients[0].setInputIntercept(true);
      clients[1].setInputIntercept(false);
      const first = clients[0].authorizeTarget(pid, route, exe);
      await waitFor(() => clients[0].targetLeases.has(pid), 'owner lease');
      const instrument = (i) => {
        const lease = clients[i].targetLeases.get(pid),
          resolve = lease.resolve;
        lease.resolve = (value) => {
          settlements[i]++;
          resolve(value);
        };
      };
      instrument(0);
      assert.equal(
        (await bounded(first, 'owner authorization', t.signal)).disposition,
        'injection-owner',
      );
      const second = clients[1].authorizeTarget(
        pid,
        path.join(root, 'other', 'electron-overlay-transport-v1.json'),
        exe,
      );
      await waitFor(() => clients[1].targetLeases.has(pid), 'waiter lease');
      instrument(1);
      const initialClaim = await json(claimPath);
      assert.equal(initialClaim.phase, 'published');
      let game = await peer(await json(route));
      assert.equal(
        (await bounded(second, 'waiter authorization', t.signal)).disposition,
        'joined-existing',
      );
      await waitFor(
        () => clients.every((client) => client.windows.get(7).orderToken),
        'order tokens',
      );
      const tokens = clients.map((client) => client.windows.get(7).orderToken);
      for (let restart = 1; restart <= 2; restart++) {
        const previous = await json(route);
        const before = events.map(
          (list) => list.filter((e) => e.event === 'game.process').length,
        );
        await killOwned(child, t.signal);
        await waitFor(
          () =>
            events.every(
              (list) =>
                list.filter((e) => e.event === 'game.process.transport-lost')
                  .length === restart,
            ),
          'one synthetic loss per crash',
        );
        await launch();
        await waitFor(async () => {
          try {
            return (await json(route)).pid === child.pid;
          } catch {
            return false;
          }
        }, 'replacement pinned route');
        const claim = await json(claimPath),
          record = await json(route);
        assert.equal(claim.phase, 'published');
        assert.equal(claim.discoveryPath, initialClaim.discoveryPath);
        assert.equal(
          claim.staticDiscoveryPath,
          initialClaim.staticDiscoveryPath,
        );
        assert.equal(claim.leaseId, initialClaim.leaseId);
        assert.notEqual(record.pid, previous.pid);
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.equal(
          authorizations.filter((a) => a.disposition === 'injection-owner')
            .length,
          1,
          'no second injection grant before reauthentication',
        );
        game = await peer(record);
        await waitFor(
          () =>
            events.every(
              (list, i) =>
                list.filter((e) => e.event === 'game.process').length >
                before[i],
            ),
          'both SDKs reauthenticated',
        );
        await waitFor(
          () =>
            game.packets.filter((p) => p.type === 'window').length >= 2 ||
            game.packets.some(
              (p) => p.type === 'overlay.init' && p.windows?.length === 2,
            ),
          'retained windows',
        );
        await waitFor(
          () => game.packets.filter((p) => p.frame).length >= 2,
          'retained frame bytes',
        );
        assert.deepEqual(
          clients.map((client) => client.windows.get(7).orderToken),
          tokens,
        );
        const scene = new Map();
        for (const packet of game.packets) {
          if (packet.type === 'overlay.init') {
            scene.clear();
            for (const w of packet.windows) scene.set(w.windowId, w);
          }
          if (packet.type === 'window.close') scene.delete(packet.windowId);
          if (packet.type === 'window') {
            scene.delete(packet.windowId);
            scene.set(packet.windowId, packet);
          }
        }
        assert.deepEqual(
          [...scene.values()].map((w) => w.name),
          ['app-0', 'app-1'],
          'aggregate wire order retained',
        );
        assert.deepEqual(
          game.packets
            .filter((p) => p.frame)
            .slice(-2)
            .map((p) => [...p.frame.subarray(12)])
            .sort(),
          [Array(8).fill(1), Array(8).fill(2)],
        );
        await waitFor(
          () =>
            game.packets.some(
              (p) =>
                p.type === 'command.input.intercept' && p.intercept === true,
            ),
          'survivor interception OR',
        );
        for (let owner = 0; owner < 2; owner++) {
          const counts = events.map(
            (list) => list.filter((e) => e.event === 'game.input').length,
          );
          const targetWindow = [...scene.values()].find(
            (w) => w.name === `app-${owner}`,
          );
          game.socket.write(
            encodeJsonTransportPacket({
              type: 'game.input',
              windowId: targetWindow.windowId,
              msg: 0x0200,
              wparam: 0,
              lparam: 0x00010001,
            }),
          );
          await waitFor(
            () =>
              events[owner].filter((e) => e.event === 'game.input').length >
              counts[owner],
            'survivor isolated input',
          );
          assert.equal(
            events[1 - owner].filter((e) => e.event === 'game.input').length,
            counts[1 - owner],
          );
          assert.equal(
            events[owner].filter((e) => e.event === 'game.input').at(-1).payload
              .windowId,
            7,
          );
        }
        assert.deepEqual(
          settlements,
          [1, 1],
          'settled authorization resolver must not run twice',
        );
      }
      assert.equal(
        authorizations.filter((a) => a.disposition === 'injection-owner')
          .length,
        1,
      );
      assert.ok(
        authorizations.filter((a) => a.disposition === 'joined-existing')
          .length >= 5,
      );
    } finally {
      await cleanup();
    }
  },
);
