const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const test = require('node:test');

const { OverlayBrokerClient } = require('../dist/lib/overlay-broker-client.js');
const {
  BrokerPacketDecoder,
  OVERLAY_BROKER_CAPABILITIES,
  OVERLAY_BROKER_LEGACY_RUNTIME_GENERATION,
  OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MAX,
  OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MIN,
  OVERLAY_BROKER_PROTOCOL_VERSION,
  OVERLAY_BROKER_REQUIRED_CAPABILITIES,
  encodeBrokerJsonPacket,
  getOverlayBrokerRuntimeProviderMetadata,
  parseOverlayBrokerClientMessage,
} = require('../dist/lib/overlay-broker-protocol.js');
const { OverlayBrokerServer } = require('../dist/lib/overlay-broker-server.js');

const TARGET_PID = 43_211;
const TARGET_EXE = 'C:\\Games\\Artifact Game\\game.exe';

const uniquePipePath = () =>
  `\\\\.\\pipe\\electron-game-overlay-artifact-test-${randomUUID()}`;

const waitFor = async (predicate, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for broker artifact metadata state');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

class FakeTargetTransport {
  constructor() {
    this.authorizations = [];
    this.eventCallback = () => undefined;
  }

  start() {}
  stop() {}
  whenReady() {
    return Promise.resolve();
  }
  setDiagnosticCallback() {}
  setEventCallback(callback) {
    this.eventCallback = callback;
  }
  setInputIntercept() {}
  addWindow() {}
  closeWindow() {}
  sendWindowBounds() {}
  sendFrameBuffer() {
    return true;
  }
  raiseWindowForSnapshot() {
    return true;
  }

  async authorizeTarget(pid, discoveryPath, expectedExecutablePath) {
    this.authorizations.push({ pid, discoveryPath, expectedExecutablePath });
    return () => undefined;
  }

  emit(event, payload) {
    this.eventCallback(event, payload);
  }
}

test('target provider metadata is atomic while legacy defaults stay frozen at v1', () => {
  assert.equal(OVERLAY_BROKER_LEGACY_RUNTIME_GENERATION, 1);
  assert.equal(OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MIN, 1);
  assert.equal(OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MAX, 1);
  assert.deepEqual(
    getOverlayBrokerRuntimeProviderMetadata({
      type: 'broker.hello',
      protocolMin: 1,
      protocolMax: 1,
      requiredCapabilities: OVERLAY_BROKER_REQUIRED_CAPABILITIES,
      clientPid: 17,
      sdkVersion: 'legacy',
    }),
    {
      runtimeGeneration: 1,
      targetTransportMin: 1,
      targetTransportMax: 1,
    },
  );

  const request = {
    type: 'broker.target.authorize',
    requestId: 'artifact-provider',
    pid: TARGET_PID,
    discoveryPath:
      'C:\\broker-tests\\artifact-provider\\electron-overlay-transport-v1.json',
    expectedExecutablePath: TARGET_EXE,
    runtimeGeneration: 9,
    targetTransportMin: 1,
    targetTransportMax: 3,
  };
  assert.deepEqual(parseOverlayBrokerClientMessage(request), request);
  assert.equal(
    parseOverlayBrokerClientMessage({
      ...request,
      targetTransportMax: undefined,
    }),
    null,
  );
  assert.equal(
    parseOverlayBrokerClientMessage({
      ...request,
      targetTransportMin: 4,
      targetTransportMax: 3,
    }),
    null,
  );
});

test('target artifact metadata takes precedence over package hello metadata', async () => {
  const pipePath = uniquePipePath();
  const transports = [];
  const server = new OverlayBrokerServer({
    pipePath,
    idleShutdownMs: false,
    runtimeProviderElectionWindowMs: 250,
    isProcessAlive: () => true,
    targetTransportFactory() {
      const transport = new FakeTargetTransport();
      transports.push(transport);
      return transport;
    },
  });
  const advertisedNewer = new OverlayBrokerClient({
    pipePath,
    sdkVersion: '99.0.0',
    runtimeGeneration: 99,
    spawnBroker: () => undefined,
  });
  const advertisedOlder = new OverlayBrokerClient({
    pipePath,
    sdkVersion: '1.0.0',
    runtimeGeneration: 1,
    spawnBroker: () => undefined,
  });

  try {
    await server.start();
    advertisedNewer.start();
    advertisedOlder.start();
    await Promise.all([
      advertisedNewer.whenReady(),
      advertisedOlder.whenReady(),
    ]);
    const packageNewerPath =
      'C:\\broker-tests\\package-newer-artifact-v1\\electron-overlay-transport-v1.json';
    const packageOlderPath =
      'C:\\broker-tests\\package-older-artifact-v9\\electron-overlay-transport-v1.json';
    const lowerArtifact = advertisedNewer.authorizeTarget(
      TARGET_PID,
      packageNewerPath,
      TARGET_EXE,
      {
        runtimeGeneration: 1,
        targetTransportMin: 1,
        targetTransportMax: 1,
      },
    );
    void lowerArtifact.catch(() => undefined);
    await waitFor(() => transports.length === 1);
    const higherArtifact = advertisedOlder.authorizeTarget(
      TARGET_PID,
      packageOlderPath,
      TARGET_EXE,
      {
        runtimeGeneration: 9,
        targetTransportMin: 1,
        targetTransportMax: 3,
      },
    );
    void higherArtifact.catch(() => undefined);

    await waitFor(() => transports[0].authorizations.length === 1);
    assert.equal(
      transports[0].authorizations[0].discoveryPath,
      packageOlderPath,
    );
    const owner = await higherArtifact;
    assert.equal(owner.disposition, 'injection-owner');
    transports[0].emit('game.process', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    const follower = await lowerArtifact;
    assert.equal(follower.disposition, 'joined-existing');
    owner.release();
    follower.release();
  } finally {
    advertisedNewer.stop();
    advertisedOlder.stop();
    await server.stop();
  }
});

test('broker reconnect replays the same artifact metadata and stable lease identity', async () => {
  const pipePath = uniquePipePath();
  const firstBroker = await startCaptureBroker(pipePath, true);
  const client = new OverlayBrokerClient({
    pipePath,
    sdkVersion: '9.0.0-artifact-replay',
    connectTimeoutMs: 4_000,
    spawnBroker: () => undefined,
  });
  let replacementBroker;

  try {
    client.start();
    await client.whenReady();
    const authorization = await client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\artifact-replay\\electron-overlay-transport-v1.json',
      TARGET_EXE,
      {
        runtimeGeneration: 9,
        targetTransportMin: 1,
        targetTransportMax: 3,
      },
    );
    await waitFor(() => firstBroker.authorizations.length === 1);
    const firstRequest = firstBroker.authorizations[0];
    assert.equal(firstRequest.recovery, false);
    assert.equal(firstRequest.routeEstablished, false);

    await firstBroker.close();
    replacementBroker = await startCaptureBroker(pipePath, false);
    await waitFor(() => replacementBroker.authorizations.length === 1);
    const replay = replacementBroker.authorizations[0];
    assert.equal(replay.recovery, true);
    assert.equal(replay.routeEstablished, true);
    assert.equal(replay.leaseId, firstRequest.leaseId);
    assert.deepEqual(
      {
        runtimeGeneration: replay.runtimeGeneration,
        targetTransportMin: replay.targetTransportMin,
        targetTransportMax: replay.targetTransportMax,
      },
      {
        runtimeGeneration: 9,
        targetTransportMin: 1,
        targetTransportMax: 3,
      },
    );
    authorization.release();
  } finally {
    client.stop();
    await replacementBroker?.close();
    await firstBroker.close();
  }
});

test('aborting a pending target lease releases it and permits immediate same-PID reuse', async () => {
  const pipePath = uniquePipePath();
  const broker = await startCaptureBroker(pipePath, false);
  const client = new OverlayBrokerClient({
    pipePath,
    connectTimeoutMs: 4_000,
    spawnBroker: () => undefined,
  });
  const controller = new AbortController();
  const cancellation = new Error('intentional pending target cancellation');

  try {
    client.start();
    await client.whenReady();
    const pending = client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\canceled-lease\\electron-overlay-transport-v1.json',
      TARGET_EXE,
      undefined,
      controller.signal,
    );
    await waitFor(() => broker.authorizations.length === 1);
    controller.abort(cancellation);
    await assert.rejects(pending, (error) => error === cancellation);
    await waitFor(() => broker.releases.length === 1);

    const replacement = client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\replacement-lease\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    await waitFor(() => broker.authorizations.length === 2);
    broker.authorize(1);
    const authorization = await replacement;
    assert.equal(authorization.disposition, 'injection-owner');
    authorization.release();
  } finally {
    client.stop();
    await broker.close();
  }
});

test('aborting before broker readiness rejects promptly and does not reserve the PID', async () => {
  const client = new OverlayBrokerClient({
    pipePath: uniquePipePath(),
    connectTimeoutMs: 4_000,
    spawnBroker: () => undefined,
  });
  const controller = new AbortController();
  const cancellation = new Error('cancel before broker readiness');

  try {
    client.start();
    const pending = client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\pre-ready-cancel\\electron-overlay-transport-v1.json',
      TARGET_EXE,
      undefined,
      controller.signal,
    );
    controller.abort(cancellation);
    await Promise.race([
      assert.rejects(pending, (error) => error === cancellation),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('pre-ready cancellation was not prompt')),
          250,
        ),
      ),
    ]);
    const replacement = client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\pre-ready-reuse\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    void replacement.catch(() => undefined);
    await Promise.resolve();
    assert.equal(client.targetLeases.has(TARGET_PID), true);
  } finally {
    client.stop();
  }
});

test('an independent readiness failure terminalizes its lease and removes abort observation', async () => {
  const client = new OverlayBrokerClient({
    pipePath: uniquePipePath(),
    connectTimeoutMs: 4_000,
    spawnBroker: () => undefined,
  });
  const readinessFailure = new Error('independent broker readiness failure');
  const abortListeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(type, listener) {
      assert.equal(type, 'abort');
      abortListeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort');
      abortListeners.delete(listener);
    },
    throwIfAborted() {},
  };

  try {
    client.start();
    client.whenReady = () => Promise.reject(readinessFailure);
    await assert.rejects(
      client.authorizeTarget(
        TARGET_PID,
        'C:\\broker-tests\\readiness-failure\\electron-overlay-transport-v1.json',
        TARGET_EXE,
        undefined,
        signal,
      ),
      (error) => error === readinessFailure,
    );
    await Promise.resolve();
    assert.equal(client.targetLeases.has(TARGET_PID), false);
    assert.equal(client.leasesByRequestId.size, 0);
    assert.equal(abortListeners.size, 0);

    client.whenReady = () => Promise.resolve();
    const replacement = client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\readiness-reuse\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    void replacement.catch(() => undefined);
    await Promise.resolve();
    assert.equal(client.targetLeases.has(TARGET_PID), true);
  } finally {
    client.stop();
  }
});

test('a pid-only target-exited error terminalizes a settled lease', async () => {
  const pipePath = uniquePipePath();
  const broker = await startCaptureBroker(pipePath, false);
  const client = new OverlayBrokerClient({
    pipePath,
    connectTimeoutMs: 4_000,
    spawnBroker: () => undefined,
  });
  const events = [];

  try {
    client.setEventCallback((event, payload) =>
      events.push({ event, payload }),
    );
    client.start();
    await client.whenReady();
    const pending = client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\terminal-lease\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    await waitFor(() => broker.authorizations.length === 1);
    broker.authorize(0);
    await pending;

    broker.send({
      type: 'broker.error',
      code: 'target-exited',
      message: 'target exited',
      pid: TARGET_PID,
    });
    await waitFor(() =>
      events.some(
        ({ event, payload }) =>
          event === 'game.process.disconnected' && payload.pid === TARGET_PID,
      ),
    );

    const replacement = client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\terminal-reuse\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    await waitFor(() => broker.authorizations.length === 2);
    broker.authorize(1);
    const authorization = await replacement;
    authorization.release();
  } finally {
    client.stop();
    await broker.close();
  }
});

async function startCaptureBroker(pipePath, authorizeRequests) {
  const authorizations = [];
  const authorizationSockets = new Map();
  const releases = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    const decoder = new BrokerPacketDecoder();
    socket.on('data', (chunk) => {
      for (const packet of decoder.push(chunk)) {
        if (packet.kind !== 'json') {
          continue;
        }
        const message = packet.value;
        if (message.type === 'broker.hello') {
          socket.write(
            encodeBrokerJsonPacket({
              type: 'broker.welcome',
              protocolVersion: OVERLAY_BROKER_PROTOCOL_VERSION,
              capabilities: OVERLAY_BROKER_CAPABILITIES,
              sessionId: randomUUID(),
              brokerPid: process.pid,
            }),
          );
        } else if (message.type === 'broker.target.authorize') {
          authorizations.push(message);
          authorizationSockets.set(message.requestId, socket);
          if (authorizeRequests) {
            socket.write(
              encodeBrokerJsonPacket({
                type: 'broker.target.authorized',
                requestId: message.requestId,
                pid: message.pid,
                disposition: 'injection-owner',
                discoveryPath: message.discoveryPath,
              }),
            );
          }
        } else if (message.type === 'broker.target.release') {
          releases.push(message);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, resolve);
  });
  let closed = false;
  return {
    authorizations,
    releases,
    authorize(index, disposition = 'injection-owner') {
      const request = authorizations[index];
      const socket = request
        ? authorizationSockets.get(request.requestId)
        : undefined;
      assert.ok(request, `missing target authorization ${index}`);
      assert.ok(socket && !socket.destroyed, 'authorization socket is closed');
      socket.write(
        encodeBrokerJsonPacket({
          type: 'broker.target.authorized',
          requestId: request.requestId,
          pid: request.pid,
          disposition,
          discoveryPath: request.discoveryPath,
        }),
      );
    },
    send(message) {
      for (const socket of sockets) {
        if (!socket.destroyed) {
          socket.write(encodeBrokerJsonPacket(message));
        }
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
