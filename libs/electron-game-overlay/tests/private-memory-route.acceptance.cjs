'use strict';

// Native transport acceptance only. It creates no game process and does not inject.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once, EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { connect: connectSocket, createServer } = require('node:net');
const path = require('node:path');
const { createInterface } = require('node:readline');
const test = require('node:test');

const { OverlayLoopbackTransport, encodeJsonTransportPacket } = require('../dist/lib/overlay-loopback-transport.js');
const { resolveOverlayNativeProcessIdentity } = require('../dist/lib/overlay-native-process-query.js');

test('the SDK authenticates native memory routes from one versioned fixture binary without run files', { timeout: 30000 }, async () => {
  const binary = process.env.EGO_PRIVATE_ROUTE_FIXTURE;
  const manager = process.env.EGO_NATIVE_MANAGER_PATH;
  assert.ok(binary && path.isAbsolute(binary));
  assert.ok(manager && path.isAbsolute(manager));
  const producerIdentity = await resolveOverlayNativeProcessIdentity(process.pid, manager);
  assert.ok(producerIdentity.creationTime100ns);
  const parent = await fs.realpath(path.resolve('build'));
  const root = await fs.mkdtemp(path.join(parent, 'private-memory-route-'));
  const versionDirectory = path.join(root, 'sdk', '1.0.1-alpha.2026111106');
  const executable = path.join(versionDirectory, 'private-route-fixture.exe');
  const sentinel = path.join(root, 'must-not-create');
  await fs.mkdir(versionDirectory, { recursive: true });
  await fs.copyFile(binary, executable);
  const binaryIdentity = async () => {
    const { dev, ino } = await fs.stat(executable, { bigint: true });
    return [dev, ino, createHash('sha256').update(await fs.readFile(executable)).digest('hex')];
  };
  const original = await binaryIdentity();
  const inventory = async () => (await fs.readdir(root, { recursive: true })).sort();
  const originalInventory = await inventory();
  const children = new Set();
  const producers = new Set();
  const nextEvent = (emitter, name) => once(emitter, name, { signal: AbortSignal.timeout(5000) });

  async function startFixture() {
    const child = spawn(executable, [], {
      cwd: root,
      env: { ...process.env, ELECTRON_GAME_OVERLAY_RUN_DIRECTORY: sentinel },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    children.add(child);
    const closed = once(child, 'exit');
    closed.finally(() => children.delete(child)).catch(() => undefined);
    const lines = createInterface({ input: child.stdout });
    assert.deepEqual(await nextEvent(lines, 'line'), ['ready']);
    const identity = await resolveOverlayNativeProcessIdentity(child.pid, manager);
    assert.ok(identity.creationTime100ns);
    return {
      identity,
      async send(command) {
        const result = nextEvent(lines, 'line');
        child.stdin.write(JSON.stringify(command) + '\n');
        assert.deepEqual(await result, ['0']);
      },
      async finish() {
        child.stdin.end();
        assert.deepEqual(await closed, [0, null]);
        lines.close();
      },
    };
  }

  async function connect(fixture, slot) {
    const producer = new OverlayLoopbackTransport({
      discoveryPath: path.join(sentinel, 'electron-overlay-transport-v1.json'),
      privateMemoryTarget: fixture.identity,
      queryProcessIdentity: (pid) => resolveOverlayNativeProcessIdentity(pid, manager),
    });
    producers.add(producer);
    const events = new EventEmitter();
    producer.setEventCallback((event, payload) => events.emit(event, payload));
    producer.start();
    const discovery = await producer.whenReady();
    assert.equal(discovery.targetPid, fixture.identity.pid);
    if (slot === 0) {
      const socket = connectSocket({ host: '127.0.0.1', port: discovery.port });
      try {
        await nextEvent(socket, 'connect');
        const closed = nextEvent(socket, 'close');
        socket.write(encodeJsonTransportPacket({
          type: 'game.process', protocolVersion: 1, token: discovery.token,
          pid: fixture.identity.pid, path: fixture.identity.executablePath,
          capabilities: ['process-instance-hello-v1'],
          creationTime100ns: String(BigInt(fixture.identity.creationTime100ns) - 1n),
        }));
        await closed;
      } finally {
        socket.destroy();
      }
    }
    const authenticated = nextEvent(events, 'game.process');
    await fixture.send({
      command: 'start', slot,
      route: {
        producer_pid: discovery.pid,
        producer_creation_time_100ns: producerIdentity.creationTime100ns,
        target_pid: discovery.targetPid,
        creation_time_100ns: fixture.identity.creationTime100ns,
        port: discovery.port,
        token: discovery.token,
      },
    });
    const [hello] = await authenticated;
    assert.equal(hello.pid, fixture.identity.pid);
    assert.equal(hello.creationTime100ns, fixture.identity.creationTime100ns);
    assert.deepEqual(await inventory(), originalInventory);
    return { producer, events };
  }

  async function rejectWrongSocketOwner(fixture) {
    let receivedBytes = 0;
    const rejected = new EventEmitter();
    const sockets = new Set();
    const listener = createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (data) => { receivedBytes += data.length; });
      socket.on('close', () => {
        sockets.delete(socket);
        rejected.emit('close');
      });
      socket.on('error', () => socket.destroy());
    });
    const listening = nextEvent(listener, 'listening');
    listener.listen(0, '127.0.0.1');
    await listening;
    try {
      const disconnected = nextEvent(rejected, 'close');
      await fixture.send({
        command: 'start', slot: 0,
        route: {
          producer_pid: fixture.identity.pid,
          producer_creation_time_100ns: fixture.identity.creationTime100ns,
          target_pid: fixture.identity.pid,
          creation_time_100ns: fixture.identity.creationTime100ns,
          port: listener.address().port,
          token: 'a'.repeat(64),
        },
      });
      await disconnected;
      assert.equal(receivedBytes, 0, 'the wrong socket owner must never receive a token');
    } finally {
      for (const socket of sockets) socket.destroy();
      listener.close();
    }
    await fixture.send({ command: 'stop', slot: 0 });
  }

  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const fixture = await startFixture();
      if (cycle === 0) await rejectWrongSocketOwner(fixture);
      const a = await connect(fixture, 0);
      const b = await connect(fixture, 1);
      a.producer.stop();
      await fixture.send({ command: 'stop', slot: 0 });
      const update = nextEvent(b.events, 'game.graphics.fps');
      await fixture.send({ command: 'publish_fps', slot: 1, fps_milli: 59940 });
      const [fps] = await update;
      assert.equal(fps.pid, fixture.identity.pid);
      assert.equal(fps.fps, 59.94);
      await fixture.send({ command: 'stop', slot: 1 });
      b.producer.stop();
      await fixture.finish();
      assert.deepEqual(await inventory(), originalInventory);
      assert.deepEqual(await binaryIdentity(), original);
    }
  } finally {
    for (const producer of producers) producer.stop();
    await Promise.allSettled(Array.from(children, (child) => {
      const exited = nextEvent(child, 'exit');
      child.kill();
      return exited;
    }));
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    await fs.rm(root, { recursive: true, force: false });
  }
});
