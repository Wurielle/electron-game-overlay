const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createConnection } = require('node:net');
const test = require('node:test');

const { OverlayBrokerClient } = require('../dist/lib/overlay-broker-client.js');
const {
  BrokerPacketDecoder,
  OVERLAY_BROKER_CAPABILITIES,
  OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY,
  OVERLAY_BROKER_LEGACY_RUNTIME_GENERATION,
  OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MAX,
  OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MIN,
  OVERLAY_BROKER_PROTOCOL_VERSION,
  OVERLAY_BROKER_REQUIRED_CAPABILITIES,
  defaultOverlayBrokerPipePath,
  encodeBrokerFramePacket,
  encodeBrokerJsonPacket,
  getOverlayBrokerRuntimeProviderMetadata,
  getOverlayBrokerTargetRuntimeProviderMetadata,
  negotiateOverlayBrokerProtocol,
  parseOverlayBrokerClientMessage,
} = require('../dist/lib/overlay-broker-protocol.js');
const { OverlayBrokerServer } = require('../dist/lib/overlay-broker-server.js');

const TARGET_PID = 43_210;
const TARGET_EXE = 'C:\\Games\\Shared Game\\game.exe';

const overlayWindow = (name, x = 0) => ({
  name,
  transparent: true,
  rect: { x, y: 20, width: 2, height: 1 },
  caption: { left: 8, right: 8, top: 8, height: 32 },
  scaleFactorMicros: 1_250_000,
});

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for overlay broker state');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const uniquePipePath = () =>
  `\\\\.\\pipe\\electron-game-overlay-test-${randomUUID()}`;

class FakeTargetTransport {
  constructor(pid) {
    this.pid = pid;
    this.started = false;
    this.stopped = false;
    this.authorizations = [];
    this.intercepts = [];
    this.windows = new Map();
    this.frames = new Map();
    this.bounds = [];
    this.closedWindows = [];
    this.raisedWindows = [];
    this.eventCallback = () => undefined;
    this.diagnosticCallback = () => undefined;
  }

  start() {
    this.started = true;
  }

  whenReady() {
    return this.readyPromise ?? Promise.resolve();
  }

  async authorizeTarget(
    pid,
    discoveryPath,
    expectedExecutablePath,
    routeContext,
  ) {
    const authorization = {
      pid,
      discoveryPath,
      expectedExecutablePath,
      routeContext,
      released: false,
    };
    this.authorizations.push(authorization);
    await this.beforeAuthorizationReturn?.(authorization);
    return () => {
      authorization.released = true;
    };
  }

  stop() {
    this.stopped = true;
  }

  setDiagnosticCallback(callback) {
    this.diagnosticCallback = callback;
  }

  setEventCallback(callback) {
    this.eventCallback = callback;
  }

  setInputIntercept(intercept) {
    this.intercepts.push(intercept);
  }

  addWindow(windowId, details) {
    this.windows.delete(windowId);
    this.windows.set(windowId, structuredClone(details));
    this.frames.delete(windowId);
  }

  closeWindow(windowId) {
    this.closedWindows.push(windowId);
    this.windows.delete(windowId);
    this.frames.delete(windowId);
  }

  sendWindowBounds(windowId, details) {
    this.bounds.push({ windowId, details: structuredClone(details) });
  }

  sendFrameBuffer(windowId, pixels, width, height) {
    this.frames.set(windowId, {
      pixels: Buffer.from(pixels),
      width,
      height,
    });
    return true;
  }

  raiseWindowForSnapshot(windowId) {
    this.raisedWindows.push(windowId);
    const window = this.windows.get(windowId);
    if (window) {
      this.windows.delete(windowId);
      this.windows.set(windowId, window);
    }
    const frame = this.frames.get(windowId);
    if (frame) {
      this.frames.delete(windowId);
      this.frames.set(windowId, frame);
    }
  }

  emit(event, payload) {
    this.eventCallback(event, payload);
  }
}

const startFixture = async ({
  runtimeProviderElectionWindowMs = 0,
  configureTransport = () => undefined,
  isProcessAlive = () => true,
  processExitPollIntervalMs = 5,
  targetRecoveryClaimProbe = () => undefined,
  clearTargetRecoveryClaim = () => undefined,
} = {}) => {
  const transports = [];
  const pipePath = uniquePipePath();
  const server = new OverlayBrokerServer({
    pipePath,
    idleShutdownMs: false,
    runtimeProviderElectionWindowMs,
    isProcessAlive,
    processExitPollIntervalMs,
    targetRecoveryClaimProbe,
    clearTargetRecoveryClaim,
    targetTransportFactory(pid) {
      const transport = new FakeTargetTransport(pid);
      configureTransport(transport);
      transports.push(transport);
      return transport;
    },
  });
  await server.start();

  const clients = [];
  const makeClient = async (sdkVersion, options = {}) => {
    const client = new OverlayBrokerClient({
      pipePath,
      sdkVersion,
      ...options,
      spawnBroker: () => undefined,
    });
    clients.push(client);
    client.start();
    await client.whenReady();
    return client;
  };

  return {
    server,
    pipePath,
    transports,
    makeClient,
    async close() {
      for (const client of clients) {
        client.stop();
      }
      await server.stop();
    },
  };
};

const connectRawClient = async (
  pipePath,
  sdkVersion,
  requiredCapabilities = OVERLAY_BROKER_REQUIRED_CAPABILITIES,
  helloExtensions = {},
) => {
  const socket = createConnection(pipePath);
  const decoder = new BrokerPacketDecoder();
  const messages = [];
  socket.on('data', (chunk) => {
    for (const packet of decoder.push(chunk)) {
      assert.equal(packet.kind, 'json');
      messages.push(packet.value);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const send = (message) => socket.write(encodeBrokerJsonPacket(message));
  send({
    type: 'broker.hello',
    protocolMin: OVERLAY_BROKER_PROTOCOL_VERSION,
    protocolMax: OVERLAY_BROKER_PROTOCOL_VERSION,
    requiredCapabilities,
    clientPid: process.pid,
    sdkVersion,
    ...helloExtensions,
  });
  await waitFor(() => messages.some(({ type }) => type === 'broker.welcome'));
  return {
    messages,
    send,
    sendFrame(windowId, pixels, width, height) {
      socket.write(
        encodeBrokerFramePacket(windowId, width, height, Buffer.from(pixels)),
      );
    },
    close() {
      socket.destroy();
    },
  };
};

const sendRawTargetAuthorization = (
  client,
  {
    requestId,
    discoveryPath,
    runtimeGeneration = 1,
    targetTransportMin = 1,
    targetTransportMax = 1,
    leaseId,
    recovery,
    routeEstablished,
    omitExpectedExecutablePath = false,
    expectedExecutablePath = TARGET_EXE,
  },
) => {
  client.send({
    type: 'broker.target.authorize',
    requestId,
    pid: TARGET_PID,
    discoveryPath,
    ...(omitExpectedExecutablePath ? {} : { expectedExecutablePath }),
    runtimeGeneration,
    targetTransportMin,
    targetTransportMax,
    ...(leaseId === undefined ? {} : { leaseId }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(routeEstablished === undefined ? {} : { routeEstablished }),
  });
};

test('broker protocol framing is incremental and version negotiation is capability based', () => {
  const hello = {
    type: 'broker.hello',
    protocolMin: 1,
    protocolMax: 3,
    requiredCapabilities: ['scene-multiplex-v1'],
    clientPid: 17,
    sdkVersion: '7.4.0',
  };
  assert.deepEqual(parseOverlayBrokerClientMessage(hello), hello);
  assert.deepEqual(
    negotiateOverlayBrokerProtocol(
      parseOverlayBrokerClientMessage(hello),
      new Set(OVERLAY_BROKER_CAPABILITIES),
    ),
    { accepted: true, protocolVersion: OVERLAY_BROKER_PROTOCOL_VERSION },
  );
  assert.equal(
    negotiateOverlayBrokerProtocol(
      { ...hello, protocolMin: 2, protocolMax: 3 },
      new Set(OVERLAY_BROKER_CAPABILITIES),
    ).code,
    'protocol-incompatible',
  );
  assert.equal(
    negotiateOverlayBrokerProtocol(
      { ...hello, requiredCapabilities: ['future-feature-v2'] },
      new Set(OVERLAY_BROKER_CAPABILITIES),
    ).code,
    'capability-incompatible',
  );

  const json = encodeBrokerJsonPacket(hello);
  const frame = encodeBrokerFramePacket(
    9,
    2,
    1,
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
  );
  const decoder = new BrokerPacketDecoder();
  assert.deepEqual(decoder.push(json.subarray(0, 3)), []);
  const packets = decoder.push(Buffer.concat([json.subarray(3), frame]));
  assert.equal(packets.length, 2);
  assert.deepEqual(packets[0].value, hello);
  assert.deepEqual(packets[1].frame, {
    windowId: 9,
    width: 2,
    height: 1,
    pixels: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
  });
  assert.throws(
    () => encodeBrokerFramePacket(9, 2, 1, Buffer.alloc(7)),
    /Expected 8 BGRA bytes/,
  );
  const brokerPipePath = defaultOverlayBrokerPipePath();
  const mutableIdentityEnvironment = {
    USERDOMAIN: process.env.USERDOMAIN,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  try {
    process.env.USERDOMAIN = 'UNRELATED-DOMAIN';
    process.env.USERPROFILE = 'C:\\unrelated-profile';
    process.env.TEMP = 'C:\\unrelated-temp';
    process.env.TMP = 'C:\\unrelated-tmp';
    assert.equal(defaultOverlayBrokerPipePath(), brokerPipePath);
  } finally {
    for (const [name, value] of Object.entries(mutableIdentityEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  assert.ok(
    OVERLAY_BROKER_REQUIRED_CAPABILITIES.includes(
      OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY,
    ),
  );
  const orderedWindow = {
    type: 'broker.window.upsert',
    windowId: 7,
    ...overlayWindow('ordered'),
    orderToken: '00000000000000000000000000000001',
  };
  assert.deepEqual(
    parseOverlayBrokerClientMessage(orderedWindow),
    orderedWindow,
  );
  assert.equal(
    parseOverlayBrokerClientMessage({
      ...orderedWindow,
      orderToken: '1',
    }),
    null,
  );

  assert.deepEqual(getOverlayBrokerRuntimeProviderMetadata(hello), {
    runtimeGeneration: OVERLAY_BROKER_LEGACY_RUNTIME_GENERATION,
    targetTransportMin: OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MIN,
    targetTransportMax: OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MAX,
  });
  const targetAuthorize = {
    type: 'broker.target.authorize',
    requestId: 'provider-and-recovery',
    pid: TARGET_PID,
    discoveryPath:
      'C:\\broker-tests\\provider-and-recovery\\electron-overlay-transport-v1.json',
    expectedExecutablePath: TARGET_EXE,
    runtimeGeneration: 41,
    targetTransportMin: 1,
    targetTransportMax: 7,
    leaseId: '00000000000000000000000000000041',
    recovery: true,
    routeEstablished: true,
  };
  const parsedTargetAuthorize =
    parseOverlayBrokerClientMessage(targetAuthorize);
  assert.deepEqual(parsedTargetAuthorize, targetAuthorize);
  assert.deepEqual(
    getOverlayBrokerTargetRuntimeProviderMetadata(parsedTargetAuthorize, hello),
    {
      runtimeGeneration: 41,
      targetTransportMin: 1,
      targetTransportMax: 7,
    },
  );
  assert.equal(
    parseOverlayBrokerClientMessage({
      ...targetAuthorize,
      targetTransportMax: undefined,
    }),
    null,
  );
  assert.equal(
    parseOverlayBrokerClientMessage({
      ...targetAuthorize,
      targetTransportMin: 8,
    }),
    null,
  );
  assert.equal(
    parseOverlayBrokerClientMessage({
      ...targetAuthorize,
      recovery: false,
      routeEstablished: true,
    }),
    null,
  );
});

test('a new broker accepts legacy clients without sending the negotiated window-order message', async () => {
  const pipePath = uniquePipePath();
  const server = new OverlayBrokerServer({
    pipePath,
    idleShutdownMs: false,
    runtimeProviderElectionWindowMs: 0,
  });
  let client;
  try {
    await server.start();
    client = await connectRawClient(
      pipePath,
      '0.0.0-legacy',
      OVERLAY_BROKER_REQUIRED_CAPABILITIES.filter(
        (capability) =>
          capability !== OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY,
      ),
    );
    client.send({
      type: 'broker.window.upsert',
      windowId: 4,
      ...overlayWindow('legacy-window'),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      client.messages.some(({ type }) => type === 'broker.window.order'),
      false,
    );
  } finally {
    client?.close();
    await server.stop();
  }
});

test('an optional supported capability enables broker messages without becoming required', async () => {
  const pipePath = uniquePipePath();
  const server = new OverlayBrokerServer({
    pipePath,
    idleShutdownMs: false,
    runtimeProviderElectionWindowMs: 0,
  });
  let client;
  try {
    await server.start();
    const requiredCapabilities = OVERLAY_BROKER_REQUIRED_CAPABILITIES.filter(
      (capability) =>
        capability !== OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY,
    );
    client = await connectRawClient(
      pipePath,
      '1.0.0-optional-order',
      requiredCapabilities,
      {
        supportedCapabilities: [
          ...requiredCapabilities,
          OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY,
        ],
      },
    );
    client.send({
      type: 'broker.window.upsert',
      windowId: 4,
      ...overlayWindow('optional-order-window'),
    });
    await waitFor(() =>
      client.messages.some(({ type }) => type === 'broker.window.order'),
    );
  } finally {
    client?.close();
    await server.stop();
  }
});

test('an optional client capability stays disabled when the broker does not advertise it', async () => {
  const pipePath = uniquePipePath();
  const brokerCapabilities = OVERLAY_BROKER_CAPABILITIES.filter(
    (capability) =>
      capability !== OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY,
  );
  const server = new OverlayBrokerServer({
    pipePath,
    capabilities: brokerCapabilities,
    idleShutdownMs: false,
    runtimeProviderElectionWindowMs: 0,
  });
  let client;
  try {
    await server.start();
    client = await connectRawClient(
      pipePath,
      '1.0.0-unsupported-optional-order',
      brokerCapabilities,
      {
        supportedCapabilities: [
          ...brokerCapabilities,
          OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY,
        ],
      },
    );
    client.send({
      type: 'broker.window.upsert',
      windowId: 4,
      ...overlayWindow('unsupported-optional-order-window'),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      client.messages.some(({ type }) => type === 'broker.window.order'),
      false,
    );
  } finally {
    client?.close();
    await server.stop();
  }
});

test('broker-issued aggregate order survives a restart with applications reconnecting in reverse order', async () => {
  const pipePath = uniquePipePath();
  const initialServer = new OverlayBrokerServer({
    pipePath,
    idleShutdownMs: false,
    runtimeProviderElectionWindowMs: 0,
    isProcessAlive: () => true,
  });
  let replacementServer;
  let initialA;
  let initialB;
  let recoveredA;
  let recoveredB;
  try {
    await initialServer.start();
    initialA = await connectRawClient(pipePath, '1.0.0-app-a');
    initialB = await connectRawClient(pipePath, '2.0.0-app-b');

    // B is below A before the crash, despite A having connected first.
    initialB.send({
      type: 'broker.window.upsert',
      windowId: 7,
      ...overlayWindow('app-b'),
    });
    await waitFor(() =>
      initialB.messages.some(({ type }) => type === 'broker.window.order'),
    );
    initialA.send({
      type: 'broker.window.upsert',
      windowId: 7,
      ...overlayWindow('app-a'),
    });
    await waitFor(() =>
      initialA.messages.some(({ type }) => type === 'broker.window.order'),
    );
    const tokenB = initialB.messages.find(
      ({ type }) => type === 'broker.window.order',
    ).orderToken;
    const tokenA = initialA.messages.find(
      ({ type }) => type === 'broker.window.order',
    ).orderToken;
    assert.ok(tokenB < tokenA);

    await initialServer.stop();
    const transports = [];
    replacementServer = new OverlayBrokerServer({
      pipePath,
      idleShutdownMs: false,
      runtimeProviderElectionWindowMs: 0,
      isProcessAlive: () => true,
      targetTransportFactory(pid) {
        const transport = new FakeTargetTransport(pid);
        transports.push(transport);
        return transport;
      },
    });
    await replacementServer.start();

    // Reconnect in the opposite order from the z-order: top A arrives first.
    recoveredA = await connectRawClient(pipePath, '1.0.1-app-a');
    recoveredA.send({
      type: 'broker.window.upsert',
      windowId: 7,
      ...overlayWindow('app-a'),
      orderToken: tokenA,
    });
    recoveredA.sendFrame(7, [1, 2, 3, 4, 5, 6, 7, 8], 2, 1);
    recoveredA.send({
      type: 'broker.target.authorize',
      requestId: 'recovered-a',
      pid: TARGET_PID,
      discoveryPath:
        'C:\\broker-tests\\restart-order-a\\electron-overlay-transport-v1.json',
      expectedExecutablePath: TARGET_EXE,
    });
    await waitFor(
      () =>
        transports.length === 1 && transports[0].authorizations.length === 1,
    );
    assert.equal(transports[0].windows.size, 0);

    recoveredB = await connectRawClient(pipePath, '2.0.1-app-b');
    recoveredB.send({
      type: 'broker.window.upsert',
      windowId: 7,
      ...overlayWindow('app-b'),
      orderToken: tokenB,
    });
    recoveredB.sendFrame(7, [9, 10, 11, 12, 13, 14, 15, 16], 2, 1);
    recoveredB.send({
      type: 'broker.target.authorize',
      requestId: 'recovered-b',
      pid: TARGET_PID,
      discoveryPath:
        'C:\\broker-tests\\restart-order-b\\electron-overlay-transport-v1.json',
      expectedExecutablePath: TARGET_EXE,
    });
    await waitFor(() =>
      recoveredB.messages.some(({ type }) => type === 'broker.window.order'),
    );
    assert.equal(transports[0].windows.size, 0);
    transports[0].emit('game.process', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(
      () => transports[0].windows.size === 2 && transports[0].frames.size === 2,
    );
    assert.deepEqual(
      [...transports[0].windows.entries()].map(([id, window]) => [
        id,
        window.name,
      ]),
      [
        [2, 'app-b'],
        [1, 'app-a'],
      ],
    );
    assert.deepEqual(
      [...transports[0].frames.entries()].map(([id, frame]) => [
        id,
        [...frame.pixels],
      ]),
      [
        [2, [9, 10, 11, 12, 13, 14, 15, 16]],
        [1, [1, 2, 3, 4, 5, 6, 7, 8]],
      ],
    );
    assert.equal(
      recoveredA.messages.find(({ type }) => type === 'broker.window.order')
        .orderToken,
      tokenA,
    );
    assert.equal(
      recoveredB.messages.find(({ type }) => type === 'broker.window.order')
        .orderToken,
      tokenB,
    );
  } finally {
    initialA?.close();
    initialB?.close();
    recoveredA?.close();
    recoveredB?.close();
    await replacementServer?.stop();
    await initialServer.stop();
  }
});

test('the highest compatible runtime generation wins the bounded election regardless of arrival order', async () => {
  for (const arrivalOrder of [
    ['v1', 'v99'],
    ['v99', 'v1'],
  ]) {
    const fixture = await startFixture({
      runtimeProviderElectionWindowMs: 50,
    });
    try {
      const clients = {
        v1: await fixture.makeClient('1.0.0', {
          runtimeGeneration: 1,
          targetTransportMin: 1,
          targetTransportMax: 1,
        }),
        v99: await fixture.makeClient('99.0.0', {
          runtimeGeneration: 99,
          targetTransportMin: 1,
          targetTransportMax: 99,
        }),
      };
      const paths = {
        v1: 'C:\\broker-tests\\election-v1\\electron-overlay-transport-v1.json',
        v99: 'C:\\broker-tests\\election-v99\\electron-overlay-transport-v1.json',
      };
      const pending = {};
      const first = arrivalOrder[0];
      const second = arrivalOrder[1];
      pending[first] = clients[first].authorizeTarget(
        TARGET_PID,
        paths[first],
        TARGET_EXE,
      );
      void pending[first].catch(() => undefined);
      await waitFor(() => fixture.transports.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      pending[second] = clients[second].authorizeTarget(
        TARGET_PID,
        paths[second],
        TARGET_EXE,
      );
      void pending[second].catch(() => undefined);

      const transport = fixture.transports[0];
      await waitFor(() => transport.authorizations.length === 1);
      assert.equal(transport.authorizations[0].discoveryPath, paths.v99);
      const high = await pending.v99;
      assert.equal(high.disposition, 'injection-owner');

      transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
      const low = await pending.v1;
      assert.equal(low.disposition, 'joined-existing');
      high.release();
      low.release();
    } finally {
      await fixture.close();
    }
  }
});

test('legacy provider metadata defaults to generation one and preserves arrival-order ties', async () => {
  const fixture = await startFixture({
    runtimeProviderElectionWindowMs: 40,
  });
  let legacy;
  let explicitV1;
  try {
    legacy = await connectRawClient(fixture.pipePath, '0.0.0-legacy-provider');
    explicitV1 = await connectRawClient(
      fixture.pipePath,
      '80.0.0-explicit-provider',
      OVERLAY_BROKER_REQUIRED_CAPABILITIES,
      {
        runtimeGeneration: 1,
        targetTransportMin: 1,
        targetTransportMax: 1,
      },
    );
    const legacyPath =
      'C:\\broker-tests\\legacy-provider\\electron-overlay-transport-v1.json';
    legacy.send({
      type: 'broker.target.authorize',
      requestId: 'legacy-provider',
      pid: TARGET_PID,
      discoveryPath: legacyPath,
      expectedExecutablePath: TARGET_EXE,
    });
    await waitFor(() => fixture.transports.length === 1);
    explicitV1.send({
      type: 'broker.target.authorize',
      requestId: 'explicit-v1-provider',
      pid: TARGET_PID,
      discoveryPath:
        'C:\\broker-tests\\explicit-v1-provider\\electron-overlay-transport-v1.json',
      expectedExecutablePath: TARGET_EXE,
    });

    const transport = fixture.transports[0];
    await waitFor(() => transport.authorizations.length === 1);
    assert.equal(transport.authorizations[0].discoveryPath, legacyPath);
    await waitFor(() =>
      legacy.messages.some(
        ({ type, disposition }) =>
          type === 'broker.target.authorized' &&
          disposition === 'injection-owner',
      ),
    );
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    await waitFor(() =>
      explicitV1.messages.some(
        ({ type, disposition }) =>
          type === 'broker.target.authorized' &&
          disposition === 'joined-existing',
      ),
    );
  } finally {
    legacy?.close();
    explicitV1?.close();
    await fixture.close();
  }
});

test('package sdkVersion does not influence runtime-provider election', async () => {
  const fixture = await startFixture({
    runtimeProviderElectionWindowMs: 40,
  });
  let olderPackage;
  let newerPackage;
  try {
    olderPackage = await connectRawClient(fixture.pipePath, '0.0.1');
    newerPackage = await connectRawClient(fixture.pipePath, '999.0.0');
    const olderPath =
      'C:\\broker-tests\\older-package\\electron-overlay-transport-v1.json';
    olderPackage.send({
      type: 'broker.target.authorize',
      requestId: 'older-package',
      pid: TARGET_PID,
      discoveryPath: olderPath,
      expectedExecutablePath: TARGET_EXE,
      runtimeGeneration: 7,
      targetTransportMin: 1,
      targetTransportMax: 1,
    });
    await waitFor(() => fixture.transports.length === 1);
    newerPackage.send({
      type: 'broker.target.authorize',
      requestId: 'newer-package',
      pid: TARGET_PID,
      discoveryPath:
        'C:\\broker-tests\\newer-package\\electron-overlay-transport-v1.json',
      expectedExecutablePath: TARGET_EXE,
      runtimeGeneration: 7,
      targetTransportMin: 1,
      targetTransportMax: 1,
    });
    const transport = fixture.transports[0];
    await waitFor(() => transport.authorizations.length === 1);
    assert.equal(transport.authorizations[0].discoveryPath, olderPath);
    await waitFor(() =>
      olderPackage.messages.some(
        ({ type, disposition }) =>
          type === 'broker.target.authorized' &&
          disposition === 'injection-owner',
      ),
    );
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    await waitFor(() =>
      newerPackage.messages.some(
        ({ type, disposition }) =>
          type === 'broker.target.authorized' &&
          disposition === 'joined-existing',
      ),
    );
  } finally {
    olderPackage?.close();
    newerPackage?.close();
    await fixture.close();
  }
});

test('an incompatible newer provider loses to a compatible generation-one provider', async () => {
  const fixture = await startFixture({
    runtimeProviderElectionWindowMs: 40,
  });
  try {
    const incompatible = await fixture.makeClient('99.0.0', {
      runtimeGeneration: 99,
      targetTransportMin: 2,
      targetTransportMax: 99,
    });
    const compatible = await fixture.makeClient('1.0.0', {
      runtimeGeneration: 1,
      targetTransportMin: 1,
      targetTransportMax: 1,
    });
    const incompatiblePending = incompatible.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\incompatible-newer\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    void incompatiblePending.catch(() => undefined);
    const compatiblePath =
      'C:\\broker-tests\\compatible-v1\\electron-overlay-transport-v1.json';
    const compatiblePending = compatible.authorizeTarget(
      TARGET_PID,
      compatiblePath,
      TARGET_EXE,
    );
    void compatiblePending.catch(() => undefined);
    await waitFor(() => fixture.transports.length === 1);
    const transport = fixture.transports[0];
    await waitFor(() => transport.authorizations.length === 1);
    assert.equal(transport.authorizations[0].discoveryPath, compatiblePath);
    assert.equal((await compatiblePending).disposition, 'injection-owner');
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    assert.equal((await incompatiblePending).disposition, 'joined-existing');
  } finally {
    await fixture.close();
  }
});

test('an election with no compatible runtime provider fails clearly', async () => {
  const fixture = await startFixture({
    runtimeProviderElectionWindowMs: 20,
  });
  try {
    const incompatible = await fixture.makeClient('99.0.0', {
      runtimeGeneration: 99,
      targetTransportMin: 2,
      targetTransportMax: 99,
    });
    await assert.rejects(
      incompatible.authorizeTarget(
        TARGET_PID,
        'C:\\broker-tests\\only-incompatible\\electron-overlay-transport-v1.json',
        TARGET_EXE,
      ),
      /No connected application can provide target transport v1/,
    );
    assert.equal(fixture.transports[0].authorizations.length, 0);
    await waitFor(() => fixture.transports[0].stopped);
  } finally {
    await fixture.close();
  }
});

test('authorization start freezes ownership so a later higher generation cannot reinject', async () => {
  let finishFirstAuthorization;
  const fixture = await startFixture({
    configureTransport(transport) {
      transport.beforeAuthorizationReturn = (authorization) =>
        authorization.discoveryPath.includes('frozen-v1')
          ? new Promise((resolve) => {
              finishFirstAuthorization = resolve;
            })
          : undefined;
    },
  });
  try {
    const low = await fixture.makeClient('1.0.0', {
      runtimeGeneration: 1,
    });
    const high = await fixture.makeClient('99.0.0', {
      runtimeGeneration: 99,
      targetTransportMin: 1,
      targetTransportMax: 99,
    });
    const lowPending = low.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\frozen-v1\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    const transport = await (async () => {
      await waitFor(() => fixture.transports[0]?.authorizations.length === 1);
      return fixture.transports[0];
    })();
    const highPending = high.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\late-v99\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    let highSettled = false;
    void highPending.then(() => {
      highSettled = true;
    });
    finishFirstAuthorization();
    const lowAuthorization = await lowPending;
    assert.equal(lowAuthorization.disposition, 'injection-owner');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(highSettled, false);
    assert.equal(transport.authorizations.length, 1);

    lowAuthorization.release();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(transport.authorizations.length, 1);
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    assert.equal((await highPending).disposition, 'joined-existing');
  } finally {
    await fixture.close();
  }
});

test('a pre-authorization owner disconnect promotes the best waiting provider', async () => {
  let markTransportReady;
  const fixture = await startFixture({
    configureTransport(transport) {
      transport.readyPromise = new Promise((resolve) => {
        markTransportReady = resolve;
      });
    },
  });
  try {
    const low = await fixture.makeClient('1.0.0', {
      runtimeGeneration: 1,
    });
    const high = await fixture.makeClient('99.0.0', {
      runtimeGeneration: 99,
      targetTransportMin: 1,
      targetTransportMax: 99,
    });
    low.addWindow(1, overlayWindow('pre-route-low'));
    high.addWindow(2, overlayWindow('pre-route-high'));
    const lowPending = low.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\pre-route-v1\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    void lowPending.catch(() => undefined);
    await waitFor(() => fixture.transports.length === 1);
    const highPath =
      'C:\\broker-tests\\pre-route-v99\\electron-overlay-transport-v1.json';
    const highPending = high.authorizeTarget(TARGET_PID, highPath, TARGET_EXE);
    void highPending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fixture.transports[0].windows.size, 0);
    const interceptUpdatesBeforeStop = fixture.transports[0].intercepts.length;
    low.stop();
    await assert.rejects(lowPending);
    await waitFor(
      () =>
        fixture.transports[0].intercepts.length > interceptUpdatesBeforeStop,
    );
    assert.equal(fixture.transports[0].windows.size, 0);
    markTransportReady();

    const transport = fixture.transports[0];
    await waitFor(() => transport.authorizations.length === 1);
    assert.equal(transport.authorizations[0].discoveryPath, highPath);
    assert.equal((await highPending).disposition, 'injection-owner');
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    await waitFor(() => transport.windows.size === 1);
    assert.equal(transport.windows.get(1).name, 'pre-route-high');
  } finally {
    await fixture.close();
  }
});

test('a frozen owner disconnect waits for definitive process exit instead of reinjecting', async () => {
  let processAlive = true;
  const fixture = await startFixture({
    isProcessAlive: () => processAlive,
    processExitPollIntervalMs: 5,
  });
  try {
    const owner = await fixture.makeClient('1.0.0', {
      runtimeGeneration: 1,
    });
    const follower = await fixture.makeClient('99.0.0', {
      runtimeGeneration: 99,
      targetTransportMin: 1,
      targetTransportMax: 99,
    });
    await owner.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\vanished-owner\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    const followerPending = follower.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\waiting-follower\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    owner.stop();
    const transport = fixture.transports[0];
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(transport.authorizations.length, 1);
    assert.equal(transport.authorizations[0].released, false);

    processAlive = false;
    await assert.rejects(
      followerPending,
      /exited before its granted runtime authenticated/,
    );
    await waitFor(
      () => transport.authorizations[0].released && transport.stopped,
    );
  } finally {
    await fixture.close();
  }
});

test('definitive PID exit terminates an already-settled unauthenticated lease without retry', async () => {
  let processAlive = true;
  const fixture = await startFixture({
    isProcessAlive: () => processAlive,
    processExitPollIntervalMs: 5,
  });
  try {
    const client = await fixture.makeClient('1.0.0-settled-exit');
    const events = [];
    client.setEventCallback((event, payload) =>
      events.push({ event, payload }),
    );
    const authorization = await client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\settled-exit\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    assert.equal(authorization.disposition, 'injection-owner');
    const transport = fixture.transports[0];
    assert.equal(transport.authorizations.length, 1);

    processAlive = false;
    await waitFor(() =>
      events.some(({ event }) => event === 'game.process.disconnected'),
    );
    assert.deepEqual(
      events.find(({ event }) => event === 'game.process.disconnected').payload,
      { pid: TARGET_PID, path: TARGET_EXE },
    );
    await waitFor(
      () => transport.authorizations[0].released && transport.stopped,
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(transport.authorizations.length, 1);
  } finally {
    await fixture.close();
  }
});

test('an established survivor outranks a fresh generation 99 app in either reconnect order', async () => {
  for (const arrivalOrder of ['survivor-first', 'fresh-first']) {
    const fixture = await startFixture({
      runtimeProviderElectionWindowMs: 40,
    });
    let survivor;
    let fresh;
    try {
      survivor = await connectRawClient(
        fixture.pipePath,
        `1.0.0-${arrivalOrder}`,
      );
      fresh = await connectRawClient(
        fixture.pipePath,
        `99.0.0-${arrivalOrder}`,
      );
      const survivorPath =
        'C:\\broker-tests\\established-survivor\\electron-overlay-transport-v1.json';
      const sendSurvivor = () =>
        sendRawTargetAuthorization(survivor, {
          requestId: `survivor-${arrivalOrder}`,
          discoveryPath: survivorPath,
          runtimeGeneration: 1,
          leaseId: '00000000000000000000000000000001',
          recovery: true,
          routeEstablished: true,
        });
      const sendFresh = () =>
        sendRawTargetAuthorization(fresh, {
          requestId: `fresh-${arrivalOrder}`,
          discoveryPath:
            'C:\\broker-tests\\fresh-v99\\electron-overlay-transport-v1.json',
          runtimeGeneration: 99,
          targetTransportMax: 99,
          leaseId: 'ffffffffffffffffffffffffffffffff',
          recovery: false,
          routeEstablished: false,
        });
      if (arrivalOrder === 'survivor-first') {
        sendSurvivor();
        await waitFor(() => fixture.transports.length === 1);
        sendFresh();
      } else {
        sendFresh();
        await waitFor(() => fixture.transports.length === 1);
        sendSurvivor();
      }

      const transport = fixture.transports[0];
      await waitFor(() => transport.authorizations.length === 1);
      assert.equal(transport.authorizations[0].discoveryPath, survivorPath);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        survivor.messages.some(
          ({ type, disposition }) =>
            type === 'broker.target.authorized' &&
            disposition === 'injection-owner',
        ),
        false,
      );
      assert.equal(
        fresh.messages.some(({ type }) => type === 'broker.target.authorized'),
        false,
      );

      transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
      await waitFor(() =>
        [survivor, fresh].every((client) =>
          client.messages.some(
            ({ type, disposition }) =>
              type === 'broker.target.authorized' &&
              disposition === 'joined-existing',
          ),
        ),
      );
      assert.equal(transport.authorizations.length, 1);
    } finally {
      survivor?.close();
      fresh?.close();
      await fixture.close();
    }
  }
});

test('stable modern lease ordering reproduces an in-flight winner after replay', async () => {
  const runElection = async (recovery, arrivalOrder) => {
    const fixture = await startFixture({
      runtimeProviderElectionWindowMs: 35,
    });
    let clientA;
    let clientB;
    try {
      clientA = await connectRawClient(fixture.pipePath, '5.0.0-a');
      clientB = await connectRawClient(fixture.pipePath, '5.0.0-b');
      const paths = {
        a: 'C:\\broker-tests\\stable-a\\electron-overlay-transport-v1.json',
        b: 'C:\\broker-tests\\stable-b\\electron-overlay-transport-v1.json',
      };
      const clients = { a: clientA, b: clientB };
      for (const name of arrivalOrder) {
        sendRawTargetAuthorization(clients[name], {
          requestId: `${recovery ? 'replay' : 'initial'}-${name}`,
          discoveryPath: paths[name],
          runtimeGeneration: 5,
          leaseId:
            name === 'a'
              ? '0000000000000000000000000000000a'
              : '0000000000000000000000000000000b',
          recovery,
          routeEstablished: false,
        });
        await waitFor(() => fixture.transports.length === 1);
      }
      const transport = fixture.transports[0];
      await waitFor(() => transport.authorizations.length === 1);
      assert.equal(transport.authorizations[0].discoveryPath, paths.a);
      return paths.a;
    } finally {
      clientA?.close();
      clientB?.close();
      await fixture.close();
    }
  };

  const initialWinner = await runElection(false, ['b', 'a']);
  const replayWinner = await runElection(true, ['a', 'b']);
  assert.equal(replayWinner, initialWinner);
});

test('a published crash claim lets a fresh provider republish only the pinned route and never reinject', async () => {
  const claimedPath =
    'C:\\broker-tests\\orphan-survivor\\electron-overlay-transport-v1.json';
  const orphanedClaim = {
    schemaVersion: 1,
    targetPid: TARGET_PID,
    discoveryPath: claimedPath,
    staticDiscoveryPath: `C:\\broker-tests\\temp\\electron-overlay-transport-v1.pid-${TARGET_PID}.json`,
    expectedExecutablePath: TARGET_EXE,
    leaseId: '00000000000000000000000000000001',
    phase: 'published',
    record: {
      version: 1,
      pid: 7_001,
      port: 47_001,
      token: 'ab'.repeat(32),
      targetPid: TARGET_PID,
    },
  };
  const fixture = await startFixture({
    runtimeProviderElectionWindowMs: 20,
    targetRecoveryClaimProbe: () => orphanedClaim,
  });
  let fresh;
  try {
    fresh = await connectRawClient(fixture.pipePath, '99.0.0-fresh');
    sendRawTargetAuthorization(fresh, {
      requestId: 'fresh-before-survivor',
      discoveryPath:
        'C:\\broker-tests\\orphan-fresh\\electron-overlay-transport-v1.json',
      runtimeGeneration: 99,
      targetTransportMax: 99,
      leaseId: 'ffffffffffffffffffffffffffffffff',
      recovery: false,
      routeEstablished: false,
    });
    await waitFor(() => fixture.transports.length === 1);
    await waitFor(() => fixture.transports[0].authorizations.length === 1);
    assert.equal(
      fixture.transports[0].authorizations[0].discoveryPath,
      claimedPath,
    );
    assert.equal(
      fixture.transports[0].authorizations[0].expectedExecutablePath,
      TARGET_EXE,
    );
    assert.equal(
      fresh.messages.some(
        ({ type, disposition }) =>
          type === 'broker.target.authorized' &&
          disposition === 'injection-owner',
      ),
      false,
    );
    fixture.transports[0].emit('game.process', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(() =>
      fresh.messages.some(
        ({ type, disposition }) =>
          type === 'broker.target.authorized' &&
          disposition === 'joined-existing',
      ),
    );
  } finally {
    fresh?.close();
    await fixture.close();
  }
});

test('a may-consumed claim never regrants injection even to its exact unsettled lease', async () => {
  const run = async (arrivalOrder, lateExactLease = false) => {
    const claimedPath =
      'C:\\broker-tests\\published-owner\\electron-overlay-transport-v1.json';
    const claimedLease = '22222222222222222222222222222222';
    const claim = {
      schemaVersion: 1,
      targetPid: TARGET_PID,
      discoveryPath: claimedPath,
      staticDiscoveryPath: `C:\\broker-tests\\temp\\electron-overlay-transport-v1.pid-${TARGET_PID}.json`,
      expectedExecutablePath: TARGET_EXE,
      leaseId: claimedLease,
      phase: 'published',
      record: {
        version: 1,
        pid: 7_003,
        port: 47_003,
        token: 'ef'.repeat(32),
        targetPid: TARGET_PID,
      },
    };
    const fixture = await startFixture({
      runtimeProviderElectionWindowMs: lateExactLease ? 0 : 30,
      targetRecoveryClaimProbe: () => claim,
    });
    let exact;
    let fresh;
    try {
      exact = await connectRawClient(fixture.pipePath, '1.0.0-exact-lease');
      fresh = await connectRawClient(fixture.pipePath, '99.0.0-fresh-lease');
      const clients = { exact, fresh };
      for (const name of arrivalOrder) {
        sendRawTargetAuthorization(clients[name], {
          requestId: `may-consumed-${name}`,
          discoveryPath:
            name === 'exact'
              ? claimedPath
              : 'C:\\broker-tests\\fresh-provider\\electron-overlay-transport-v1.json',
          runtimeGeneration: name === 'exact' ? 1 : 99,
          targetTransportMax: name === 'exact' ? 1 : 99,
          leaseId:
            name === 'exact'
              ? claimedLease
              : '99999999999999999999999999999999',
          recovery: name === 'exact',
          routeEstablished: false,
        });
        if (lateExactLease && name === 'fresh') {
          await waitFor(
            () => fixture.transports[0]?.authorizations.length === 1,
          );
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      await waitFor(() => fixture.transports[0]?.authorizations.length === 1);
      const authorization = fixture.transports[0].authorizations[0];
      assert.equal(authorization.discoveryPath, claimedPath);
      if (!lateExactLease) {
        assert.equal(authorization.routeContext.leaseId, claimedLease);
      }
      await new Promise((resolve) => setTimeout(resolve, 35));
      assert.equal(fixture.transports[0].authorizations.length, 1);
      assert.equal(
        [exact, fresh].some((client) =>
          client.messages.some(
            ({ type, disposition }) =>
              type === 'broker.target.authorized' &&
              disposition === 'injection-owner',
          ),
        ),
        false,
      );
      fixture.transports[0].emit('game.process', {
        pid: TARGET_PID,
        path: TARGET_EXE,
      });
      await waitFor(() =>
        [exact, fresh].every((client) =>
          client.messages.some(
            ({ type, disposition }) =>
              type === 'broker.target.authorized' &&
              disposition === 'joined-existing',
          ),
        ),
      );
    } finally {
      exact?.close();
      fresh?.close();
      await fixture.close();
    }
  };

  await run(['fresh', 'exact']);
  await run(['exact', 'fresh']);
  await run(['fresh', 'exact'], true);
});

test('an incomplete claim rejects another lease but its exact replay resumes the original grant', async () => {
  const claimedPath =
    'C:\\broker-tests\\intent-owner\\electron-overlay-transport-v1.json';
  let claim = {
    schemaVersion: 1,
    targetPid: TARGET_PID,
    discoveryPath: claimedPath,
    staticDiscoveryPath: `C:\\broker-tests\\temp\\electron-overlay-transport-v1.pid-${TARGET_PID}.json`,
    expectedExecutablePath: TARGET_EXE,
    leaseId: '11111111111111111111111111111111',
    phase: 'intent',
    record: {
      version: 1,
      pid: 7_002,
      port: 47_002,
      token: 'cd'.repeat(32),
      targetPid: TARGET_PID,
    },
  };
  const fixture = await startFixture({
    targetRecoveryClaimProbe: () => claim,
    configureTransport(transport) {
      transport.beforeAuthorizationReturn = () => {
        claim = { ...claim, phase: 'published' };
      };
    },
  });
  let wrongLease;
  let exactReplay;
  try {
    wrongLease = await connectRawClient(fixture.pipePath, '99.0.0-wrong');
    sendRawTargetAuthorization(wrongLease, {
      requestId: 'wrong-lease',
      discoveryPath:
        'C:\\broker-tests\\wrong\\electron-overlay-transport-v1.json',
      runtimeGeneration: 99,
      targetTransportMax: 99,
      leaseId: '99999999999999999999999999999999',
      recovery: false,
      routeEstablished: false,
    });
    await waitFor(() =>
      wrongLease.messages.some(
        ({ type, requestId }) =>
          type === 'broker.error' && requestId === 'wrong-lease',
      ),
    );
    assert.equal(fixture.transports[0].authorizations.length, 0);

    exactReplay = await connectRawClient(fixture.pipePath, '1.0.0-exact');
    sendRawTargetAuthorization(exactReplay, {
      requestId: 'exact-replay',
      discoveryPath: claimedPath,
      runtimeGeneration: 1,
      leaseId: claim.leaseId,
      recovery: true,
      routeEstablished: false,
    });
    await waitFor(() => fixture.transports[0].authorizations.length === 1);
    assert.equal(
      fixture.transports[0].authorizations[0].discoveryPath,
      claimedPath,
    );
    await waitFor(() =>
      exactReplay.messages.some(
        ({ type, disposition }) =>
          type === 'broker.target.authorized' &&
          disposition === 'injection-owner',
      ),
    );
  } finally {
    wrongLease?.close();
    exactReplay?.close();
    await fixture.close();
  }
});

test('an opaque or future recovery claim fails closed while the target PID is live', async () => {
  const fixture = await startFixture({
    targetRecoveryClaimProbe() {
      throw new Error('unknown recovery schema version 99');
    },
  });
  let client;
  try {
    client = await connectRawClient(fixture.pipePath, '99.0.0-future-claim');
    sendRawTargetAuthorization(client, {
      requestId: 'opaque-claim',
      discoveryPath:
        'C:\\broker-tests\\opaque\\electron-overlay-transport-v1.json',
      runtimeGeneration: 99,
      targetTransportMax: 99,
      leaseId: '99999999999999999999999999999999',
      recovery: false,
      routeEstablished: false,
    });
    await waitFor(() =>
      client.messages.some(
        ({ type, code, requestId }) =>
          type === 'broker.error' &&
          code === 'target-authorization-failed' &&
          requestId === 'opaque-claim',
      ),
    );
    assert.equal(fixture.transports[0].authorizations.length, 0);
    assert.equal(
      client.messages.some(
        ({ type, disposition }) =>
          type === 'broker.target.authorized' &&
          disposition === 'injection-owner',
      ),
      false,
    );
  } finally {
    client?.close();
    await fixture.close();
  }
});

test('a durable claim repins divergent established survivors without ambiguity', async () => {
  const claimedPath =
    'C:\\broker-tests\\authoritative-claim\\electron-overlay-transport-v1.json';
  const claim = {
    schemaVersion: 1,
    targetPid: TARGET_PID,
    discoveryPath: claimedPath,
    staticDiscoveryPath: `C:\\broker-tests\\temp\\electron-overlay-transport-v1.pid-${TARGET_PID}.json`,
    expectedExecutablePath: TARGET_EXE,
    leaseId: '55555555555555555555555555555555',
    phase: 'published',
    record: {
      version: 1,
      pid: 7_006,
      port: 47_006,
      token: '56'.repeat(32),
      targetPid: TARGET_PID,
    },
  };
  const fixture = await startFixture({
    targetRecoveryClaimProbe: () => claim,
  });
  let conflicting;
  let survivor;
  try {
    conflicting = await connectRawClient(fixture.pipePath, '1.0.0-conflict');
    sendRawTargetAuthorization(conflicting, {
      requestId: 'conflicting-established',
      discoveryPath:
        'C:\\broker-tests\\conflict\\electron-overlay-transport-v1.json',
      leaseId: '66666666666666666666666666666666',
      recovery: true,
      routeEstablished: true,
    });

    survivor = await connectRawClient(fixture.pipePath, '1.0.0-survivor');
    sendRawTargetAuthorization(survivor, {
      requestId: 'correct-established',
      discoveryPath: claimedPath,
      leaseId: claim.leaseId,
      recovery: true,
      routeEstablished: true,
    });
    await waitFor(() => fixture.transports[0]?.authorizations.length === 1);
    assert.equal(
      fixture.transports[0].authorizations[0].discoveryPath,
      claimedPath,
    );
    assert.equal(
      conflicting.messages.some(({ type }) => type === 'broker.error'),
      false,
    );
    assert.equal(
      survivor.messages.some(({ type }) => type === 'broker.error'),
      false,
    );
  } finally {
    conflicting?.close();
    survivor?.close();
    await fixture.close();
  }
});

test('recovery accepts constrained and unconstrained members but keeps the claimed executable identity', async () => {
  for (const [claimExpectedExecutablePath, omitMemberExpectation] of [
    [TARGET_EXE, true],
    [undefined, false],
  ]) {
    const claimedPath =
      'C:\\broker-tests\\optional-executable\\electron-overlay-transport-v1.json';
    const claim = {
      schemaVersion: 1,
      targetPid: TARGET_PID,
      discoveryPath: claimedPath,
      staticDiscoveryPath: `C:\\broker-tests\\temp\\electron-overlay-transport-v1.pid-${TARGET_PID}.json`,
      ...(claimExpectedExecutablePath === undefined
        ? {}
        : { expectedExecutablePath: claimExpectedExecutablePath }),
      leaseId: '33333333333333333333333333333333',
      phase: 'published',
      record: {
        version: 1,
        pid: 7_004,
        port: 47_004,
        token: '12'.repeat(32),
        targetPid: TARGET_PID,
      },
    };
    const fixture = await startFixture({
      targetRecoveryClaimProbe: () => claim,
    });
    let client;
    try {
      client = await connectRawClient(
        fixture.pipePath,
        '1.0.0-optional-executable',
      );
      sendRawTargetAuthorization(client, {
        requestId: `optional-${omitMemberExpectation}`,
        discoveryPath: claimedPath,
        leaseId: claim.leaseId,
        recovery: true,
        routeEstablished: true,
        omitExpectedExecutablePath: omitMemberExpectation,
      });
      await waitFor(() => fixture.transports[0]?.authorizations.length === 1);
      assert.equal(
        fixture.transports[0].authorizations[0].expectedExecutablePath,
        claimExpectedExecutablePath,
      );
    } finally {
      client?.close();
      await fixture.close();
    }
  }

  const claimedPath =
    'C:\\broker-tests\\mismatched-executable\\electron-overlay-transport-v1.json';
  const claim = {
    schemaVersion: 1,
    targetPid: TARGET_PID,
    discoveryPath: claimedPath,
    staticDiscoveryPath: `C:\\broker-tests\\temp\\electron-overlay-transport-v1.pid-${TARGET_PID}.json`,
    expectedExecutablePath: TARGET_EXE,
    leaseId: '44444444444444444444444444444444',
    phase: 'published',
    record: {
      version: 1,
      pid: 7_005,
      port: 47_005,
      token: '34'.repeat(32),
      targetPid: TARGET_PID,
    },
  };
  const fixture = await startFixture({
    targetRecoveryClaimProbe: () => claim,
  });
  let client;
  try {
    client = await connectRawClient(fixture.pipePath, '1.0.0-wrong-exe');
    sendRawTargetAuthorization(client, {
      requestId: 'wrong-executable',
      discoveryPath: claimedPath,
      leaseId: claim.leaseId,
      recovery: true,
      routeEstablished: true,
      expectedExecutablePath: 'C:\\Games\\Different.exe',
    });
    await waitFor(() =>
      client.messages.some(
        ({ type, requestId }) =>
          type === 'broker.error' && requestId === 'wrong-executable',
      ),
    );
    assert.equal(fixture.transports[0].authorizations.length, 0);
  } finally {
    client?.close();
    await fixture.close();
  }
});

test('a recovered owner is rejected when authentication disproves its executable constraint', async () => {
  const claimedPath =
    'C:\\broker-tests\\unconstrained-claim\\electron-overlay-transport-v1.json';
  const claim = {
    schemaVersion: 1,
    targetPid: TARGET_PID,
    discoveryPath: claimedPath,
    staticDiscoveryPath: `C:\\broker-tests\\temp\\electron-overlay-transport-v1.pid-${TARGET_PID}.json`,
    leaseId: '45454545454545454545454545454545',
    phase: 'published',
    record: {
      version: 1,
      pid: 7_009,
      port: 47_009,
      token: '45'.repeat(32),
      targetPid: TARGET_PID,
    },
  };
  const fixture = await startFixture({
    targetRecoveryClaimProbe: () => claim,
    configureTransport(transport) {
      transport.beforeAuthorizationReturn = () => {
        transport.emit('game.process', {
          pid: TARGET_PID,
          path: TARGET_EXE,
        });
      };
    },
  });
  let client;
  try {
    client = await connectRawClient(fixture.pipePath, '1.0.0-wrong-owner-exe');
    sendRawTargetAuthorization(client, {
      requestId: 'wrong-owner-executable',
      discoveryPath: claimedPath,
      leaseId: claim.leaseId,
      recovery: true,
      routeEstablished: true,
      expectedExecutablePath: 'C:\\Games\\Different.exe',
    });
    await waitFor(() =>
      client.messages.some(
        ({ type, requestId }) =>
          type === 'broker.error' && requestId === 'wrong-owner-executable',
      ),
    );
    assert.equal(
      client.messages.some(
        ({ type, requestId }) =>
          type === 'broker.target.authorized' &&
          requestId === 'wrong-owner-executable',
      ),
      false,
    );
  } finally {
    client?.close();
    await fixture.close();
  }
});

test('a matching established follower can assume a vanished recovery tombstone without injecting', async () => {
  let markTransportReady;
  const fixture = await startFixture({
    runtimeProviderElectionWindowMs: 20,
    configureTransport(transport) {
      transport.readyPromise = new Promise((resolve) => {
        markTransportReady = resolve;
      });
    },
  });
  let recoveryA;
  let recoveryB;
  try {
    const recoveryPath =
      'C:\\broker-tests\\shared-recovery-route\\electron-overlay-transport-v1.json';
    recoveryA = await connectRawClient(fixture.pipePath, '1.0.0-recovery-a');
    sendRawTargetAuthorization(recoveryA, {
      requestId: 'recovery-a',
      discoveryPath: recoveryPath,
      leaseId: '0000000000000000000000000000000a',
      recovery: true,
      routeEstablished: true,
    });
    await waitFor(() => fixture.transports.length === 1);
    recoveryB = await connectRawClient(fixture.pipePath, '1.0.0-recovery-b');
    sendRawTargetAuthorization(recoveryB, {
      requestId: 'recovery-b',
      discoveryPath: recoveryPath,
      leaseId: '0000000000000000000000000000000b',
      recovery: true,
      routeEstablished: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    recoveryA.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    markTransportReady();
    const transport = fixture.transports[0];
    await waitFor(() => transport.authorizations.length === 1);
    assert.equal(transport.authorizations[0].discoveryPath, recoveryPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      recoveryB.messages.some(
        ({ type, disposition }) =>
          type === 'broker.target.authorized' &&
          disposition === 'injection-owner',
      ),
      false,
    );
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    await waitFor(() =>
      recoveryB.messages.some(
        ({ type, disposition }) =>
          type === 'broker.target.authorized' &&
          disposition === 'joined-existing',
      ),
    );
    assert.equal(transport.authorizations.length, 1);
  } finally {
    recoveryA?.close();
    recoveryB?.close();
    await fixture.close();
  }
});

test('authentication during route authorization can only join and never grants injection ownership', async () => {
  const fixture = await startFixture({
    configureTransport(transport) {
      transport.beforeAuthorizationReturn = () => {
        transport.emit('game.process', {
          pid: TARGET_PID,
          path: TARGET_EXE,
        });
      };
    },
  });
  try {
    const client = await fixture.makeClient('1.0.0-auth-race');
    const authorization = await client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\auth-race\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    assert.equal(authorization.disposition, 'joined-existing');
    assert.equal(fixture.transports[0].authorizations.length, 1);
  } finally {
    await fixture.close();
  }
});

test('definitive exit while authorization is pending rejects the owner and never authorizes it', async () => {
  let resumeAuthorization;
  const authorizationMayResume = new Promise((resolve) => {
    resumeAuthorization = resolve;
  });
  const fixture = await startFixture({
    configureTransport(transport) {
      transport.beforeAuthorizationReturn = async () => {
        transport.emit('game.process', {
          pid: TARGET_PID,
          path: TARGET_EXE,
        });
        transport.emit('game.process.disconnected', {
          pid: TARGET_PID,
          path: TARGET_EXE,
        });
        await authorizationMayResume;
      };
    },
  });
  let client;
  try {
    client = await connectRawClient(fixture.pipePath, '1.0.0-exit-race');
    sendRawTargetAuthorization(client, {
      requestId: 'exit-during-authorization',
      discoveryPath:
        'C:\\broker-tests\\exit-race\\electron-overlay-transport-v1.json',
      leaseId: '77777777777777777777777777777777',
      recovery: false,
      routeEstablished: false,
    });
    await waitFor(() =>
      client.messages.some(
        ({ type, code, requestId }) =>
          type === 'broker.error' &&
          code === 'target-exited' &&
          requestId === 'exit-during-authorization',
      ),
    );
    resumeAuthorization();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      client.messages.some(
        ({ type, requestId }) =>
          type === 'broker.target.authorized' &&
          requestId === 'exit-during-authorization',
      ),
      false,
    );
  } finally {
    resumeAuthorization?.();
    client?.close();
    await fixture.close();
  }
});

test('transport loss while authorization is pending waits for fresh authentication proof', async () => {
  let resumeAuthorization;
  const authorizationMayResume = new Promise((resolve) => {
    resumeAuthorization = resolve;
  });
  const fixture = await startFixture({
    configureTransport(transport) {
      transport.beforeAuthorizationReturn = async () => {
        transport.emit('game.process', {
          pid: TARGET_PID,
          path: TARGET_EXE,
        });
        transport.emit('game.process.transport-lost', {
          pid: TARGET_PID,
          path: TARGET_EXE,
        });
        await authorizationMayResume;
      };
    },
  });
  let client;
  try {
    client = await connectRawClient(fixture.pipePath, '1.0.0-loss-race');
    sendRawTargetAuthorization(client, {
      requestId: 'loss-during-authorization',
      discoveryPath:
        'C:\\broker-tests\\loss-race\\electron-overlay-transport-v1.json',
      leaseId: '88888888888888888888888888888888',
      recovery: false,
      routeEstablished: false,
    });
    await waitFor(() =>
      client.messages.some(
        ({ type }) => type === 'game.process.transport-lost',
      ),
    );
    resumeAuthorization();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      client.messages.some(
        ({ type, requestId }) =>
          type === 'broker.target.authorized' &&
          requestId === 'loss-during-authorization',
      ),
      false,
    );
    fixture.transports[0].emit('game.process', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(() =>
      client.messages.some(
        ({ type, disposition, requestId }) =>
          type === 'broker.target.authorized' &&
          disposition === 'joined-existing' &&
          requestId === 'loss-during-authorization',
      ),
    );
  } finally {
    resumeAuthorization?.();
    client?.close();
    await fixture.close();
  }
});

test('authorization rejection after transport loss remains queued for reauthentication', async () => {
  const fixture = await startFixture({
    configureTransport(transport) {
      transport.beforeAuthorizationReturn = () => {
        transport.emit('game.process', {
          pid: TARGET_PID,
          path: TARGET_EXE,
        });
        transport.emit('game.process.transport-lost', {
          pid: TARGET_PID,
          path: TARGET_EXE,
        });
        throw new Error('authorization failed after transient authentication');
      };
    },
  });
  let client;
  try {
    client = await connectRawClient(fixture.pipePath, '1.0.0-reject-race');
    sendRawTargetAuthorization(client, {
      requestId: 'reject-after-transport-loss',
      discoveryPath:
        'C:\\broker-tests\\reject-race\\electron-overlay-transport-v1.json',
      leaseId: '99999999999999999999999999999999',
      recovery: false,
      routeEstablished: false,
    });
    await waitFor(() =>
      client.messages.some(
        ({ type }) => type === 'game.process.transport-lost',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      client.messages.some(
        ({ type, requestId }) =>
          type === 'broker.error' &&
          requestId === 'reject-after-transport-loss',
      ),
      false,
    );

    fixture.transports[0].emit('game.process', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(() =>
      client.messages.some(
        ({ type, disposition, requestId }) =>
          type === 'broker.target.authorized' &&
          disposition === 'joined-existing' &&
          requestId === 'reject-after-transport-loss',
      ),
    );
  } finally {
    client?.close();
    await fixture.close();
  }
});

test('independent SDK versions share one exact-PID target with isolated window IDs and input', async () => {
  const fixture = await startFixture();
  try {
    const clientA = await fixture.makeClient('0.0.1');
    const clientB = await fixture.makeClient('19.8.4');
    const observer = await fixture.makeClient('1.0.0-observer');
    const eventsA = [];
    const eventsB = [];
    const observerEvents = [];
    clientA.setEventCallback((event, payload) =>
      eventsA.push({ event, payload }),
    );
    clientB.setEventCallback((event, payload) =>
      eventsB.push({ event, payload }),
    );
    observer.setEventCallback((event, payload) =>
      observerEvents.push({ event, payload }),
    );

    clientA.addWindow(7, overlayWindow('app-a', 10));
    clientA.sendFrameBuffer(7, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), 2, 1);
    const authorizationA = await clientA.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\app-a\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    assert.equal(authorizationA.disposition, 'injection-owner');

    clientB.addWindow(7, overlayWindow('app-b', 30));
    clientB.sendFrameBuffer(
      7,
      Buffer.from([9, 10, 11, 12, 13, 14, 15, 16]),
      2,
      1,
    );
    let joined = false;
    const authorizationBPromise = clientB
      .authorizeTarget(
        TARGET_PID,
        'C:\\broker-tests\\app-b\\electron-overlay-transport-v1.json',
        TARGET_EXE.toLowerCase(),
      )
      .then((authorization) => {
        joined = true;
        return authorization;
      });

    await waitFor(
      () =>
        fixture.transports.length === 1 &&
        fixture.transports[0].authorizations.length === 1,
    );
    await waitFor(
      () =>
        clientA.windows.get(7)?.orderToken &&
        clientB.windows.get(7)?.orderToken,
    );
    const initialOrderA = clientA.windows.get(7).orderToken;
    const initialOrderB = clientB.windows.get(7).orderToken;
    assert.ok(initialOrderA < initialOrderB);
    const transport = fixture.transports[0];
    assert.equal(transport.started, true);
    assert.equal(transport.authorizations.length, 1);
    assert.equal(joined, false);
    assert.equal(transport.windows.size, 0);
    assert.equal(transport.frames.size, 0);

    transport.emit('game.process', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    const authorizationB = await authorizationBPromise;
    await waitFor(
      () => transport.windows.size === 2 && transport.frames.size === 2,
    );
    assert.deepEqual(
      [...transport.windows.entries()].map(([id, window]) => [id, window.name]),
      [
        [1, 'app-a'],
        [2, 'app-b'],
      ],
    );
    assert.equal(authorizationB.disposition, 'joined-existing');
    assert.deepEqual(authorizationB.target, {
      pid: TARGET_PID,
      executablePath: TARGET_EXE,
      discoveryPath:
        'C:\\broker-tests\\app-a\\electron-overlay-transport-v1.json',
    });

    transport.emit('game.input', {
      pid: TARGET_PID,
      windowId: 2,
      kind: 'mouseMove',
      x: 1,
      y: 1,
    });
    transport.emit('game.window.focused', {
      pid: TARGET_PID,
      focusWindowId: 1,
    });
    transport.emit('game.graphics.fps', {
      pid: TARGET_PID,
      fps: 144,
    });
    await waitFor(
      () =>
        eventsA.some(({ event }) => event === 'game.graphics.fps') &&
        eventsB.some(({ event }) => event === 'game.input') &&
        clientA.windows.get(7)?.orderToken !== initialOrderA,
    );
    assert.ok(clientA.windows.get(7).orderToken > initialOrderB);
    assert.equal(
      eventsA.some(({ event }) => event === 'game.input'),
      false,
    );
    assert.equal(
      eventsB.find(({ event }) => event === 'game.input').payload.windowId,
      7,
    );
    assert.equal(
      eventsA.find(({ event }) => event === 'game.window.focused').payload
        .focusWindowId,
      7,
    );
    assert.equal(
      eventsB.find(({ event }) => event === 'game.window.focused').payload
        .focusWindowId,
      0,
    );
    assert.deepEqual(transport.raisedWindows, [1]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observerEvents.length, 0);

    clientA.setInputIntercept(true);
    clientB.setInputIntercept(false);
    await waitFor(() => transport.intercepts.at(-1) === true);
    clientA.setInputIntercept(false);
    await waitFor(() => transport.intercepts.at(-1) === false);

    authorizationA.release();
    await waitFor(() => transport.closedWindows.includes(1));
    assert.equal(transport.authorizations[0].released, false);
    assert.equal(transport.stopped, false);
    authorizationB.release();
    await waitFor(() => transport.closedWindows.includes(2));
    assert.equal(transport.authorizations[0].released, false);
    assert.equal(transport.stopped, false);
    assert.deepEqual(
      transport.closedWindows.sort((a, b) => a - b),
      [1, 2],
    );
    transport.emit('game.process.disconnected', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(
      () => transport.authorizations[0].released && transport.stopped,
    );
  } finally {
    await fixture.close();
  }
});

test('one application crash removes only its scene and keeps the surviving app interactive', async () => {
  const fixture = await startFixture();
  try {
    const clientA = await fixture.makeClient('1.2.0');
    const clientB = await fixture.makeClient('8.7.0');
    const eventsB = [];
    clientB.setEventCallback((event, payload) =>
      eventsB.push({ event, payload }),
    );

    clientA.addWindow(5, overlayWindow('crashing-app', 10));
    clientB.addWindow(5, overlayWindow('surviving-app', 30));
    await clientA.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\crashing-app\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    const joined = clientB.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\surviving-app\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    const transport = fixture.transports[0];
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    await joined;

    clientA.setInputIntercept(true);
    clientB.setInputIntercept(true);
    await waitFor(() => transport.intercepts.at(-1) === true);
    clientA.stop();
    await waitFor(
      () =>
        transport.closedWindows.includes(1) &&
        transport.windows.size === 1 &&
        transport.intercepts.at(-1) === true,
    );
    assert.equal(transport.windows.get(2).name, 'surviving-app');
    assert.equal(transport.stopped, false);
    assert.equal(transport.authorizations[0].released, false);

    transport.emit('game.input', {
      pid: TARGET_PID,
      windowId: 2,
      kind: 'mouseMove',
      x: 1,
      y: 1,
    });
    await waitFor(() => eventsB.some(({ event }) => event === 'game.input'));
    assert.equal(
      eventsB.find(({ event }) => event === 'game.input').payload.windowId,
      5,
    );

    clientB.stop();
    await waitFor(
      () =>
        transport.closedWindows.includes(2) &&
        transport.intercepts.at(-1) === false,
    );
    assert.equal(transport.stopped, false);
    transport.emit('game.process.disconnected', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(() => transport.stopped);
  } finally {
    await fixture.close();
  }
});

test('an incompatible SDK is rejected without disturbing an active target', async () => {
  const fixture = await startFixture();
  try {
    const compatible = await fixture.makeClient('2.0.0');
    compatible.addWindow(3, overlayWindow('compatible-app'));
    const authorization = await compatible.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\compatible-app\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    const transport = fixture.transports[0];
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });

    const incompatible = new OverlayBrokerClient({
      pipePath: fixture.server.pipePath,
      sdkVersion: '99.0.0',
      requiredCapabilities: ['future-scene-protocol-v2'],
      spawnBroker: () => undefined,
    });
    incompatible.start();
    await assert.rejects(
      incompatible.whenReady(),
      /capability-incompatible.*future-scene-protocol-v2/,
    );
    incompatible.stop();

    assert.equal(transport.stopped, false);
    assert.equal(transport.authorizations.length, 1);
    assert.equal(transport.authorizations[0].released, false);
    assert.equal(transport.windows.get(1).name, 'compatible-app');

    authorization.release();
    transport.emit('game.process.disconnected', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(() => transport.stopped);
  } finally {
    await fixture.close();
  }
});

test('an unauthenticated wrong-executable member never reaches the target scene or input state', async () => {
  const fixture = await startFixture({
    runtimeProviderElectionWindowMs: 50,
  });
  try {
    const correct = await fixture.makeClient('2.0.0-correct', {
      runtimeGeneration: 2,
      targetTransportMin: 1,
      targetTransportMax: 1,
    });
    const wrong = await fixture.makeClient('1.0.0-wrong', {
      runtimeGeneration: 1,
      targetTransportMin: 1,
      targetTransportMax: 1,
    });
    const wrongEvents = [];
    wrong.setEventCallback((event, payload) =>
      wrongEvents.push({ event, payload }),
    );
    correct.addWindow(1, overlayWindow('correct-scene'));
    correct.sendFrameBuffer(1, Buffer.from([1, 2, 3, 4]), 1, 1);
    wrong.addWindow(1, overlayWindow('wrong-scene'));
    wrong.sendFrameBuffer(1, Buffer.from([5, 6, 7, 8]), 1, 1);
    wrong.setInputIntercept(true);

    const correctAuthorizationPromise = correct.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\validated-scene\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    const wrongAuthorizationOutcome = wrong
      .authorizeTarget(
        TARGET_PID,
        'C:\\broker-tests\\wrong-scene\\electron-overlay-transport-v1.json',
        'C:\\Games\\Different.exe',
      )
      .then(
        (authorization) => ({ authorization }),
        (error) => ({ error }),
      );

    await waitFor(() => fixture.transports[0]?.authorizations.length === 1);
    const transport = fixture.transports[0];
    const correctAuthorization = await correctAuthorizationPromise;
    assert.equal(correctAuthorization.disposition, 'injection-owner');
    assert.equal(transport.windows.size, 0);
    assert.equal(transport.frames.size, 0);
    assert.equal(transport.intercepts.at(-1), false);

    transport.emit('game.process', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    const wrongOutcome = await wrongAuthorizationOutcome;
    assert.match(
      wrongOutcome.error?.message ?? '',
      /does not match the requested executable path/,
    );
    await waitFor(
      () => transport.windows.size === 1 && transport.frames.size === 1,
    );
    assert.deepEqual(
      [...transport.windows.values()].map(({ name }) => name),
      ['correct-scene'],
    );
    assert.equal(transport.intercepts.at(-1), false);
    assert.equal(
      wrongEvents.some(({ event }) => event === 'game.process'),
      false,
    );
    correctAuthorization.release();
  } finally {
    await fixture.close();
  }
});

test('joined apps with a conflicting executable identity are rejected', async () => {
  const fixture = await startFixture();
  try {
    const clientA = await fixture.makeClient('5.0.0');
    const clientB = await fixture.makeClient('5.1.0');
    const authorizationA = await clientA.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\identity-a\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    const authorizationBPromise = clientB.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\identity-b\\electron-overlay-transport-v1.json',
      'C:\\Games\\Different Game\\different.exe',
    );
    const transport = fixture.transports[0];
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    await assert.rejects(authorizationBPromise, /does not match/);
    authorizationA.release();
    assert.equal(transport.stopped, false);
    transport.emit('game.process.disconnected', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(() => transport.stopped);
  } finally {
    await fixture.close();
  }
});

test('an authenticated target survives zero apps and replays state before a late join resolves', async () => {
  const fixture = await startFixture();
  try {
    const clientA = await fixture.makeClient('6.0.0');
    clientA.addWindow(12, overlayWindow('first-app'));
    const authorizationA = await clientA.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\persistent-owner\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    const transport = fixture.transports[0];
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    transport.emit('game.target.surface', {
      pid: TARGET_PID,
      surfaceId: 'removed-surface',
      revision: 1,
      marker: 'stale',
    });
    transport.emit('game.target.surface.removed', {
      pid: TARGET_PID,
      surfaceId: 'removed-surface',
      revision: 2,
    });
    transport.emit('game.target.surface', {
      pid: TARGET_PID,
      surfaceId: 'live-surface',
      revision: 4,
      marker: 'current',
    });
    transport.emit('game.graphics.fps', {
      pid: TARGET_PID,
      fps: 120,
      frameTimeMicros: 8_333,
    });
    clientA.setInputIntercept(true);
    await waitFor(() => transport.intercepts.at(-1) === true);
    transport.emit('game.input.intercept', {
      pid: TARGET_PID,
      intercepting: true,
    });

    authorizationA.release();
    await waitFor(
      () =>
        transport.windows.size === 0 && transport.intercepts.at(-1) === false,
    );
    transport.emit('game.input.intercept', {
      pid: TARGET_PID,
      intercepting: false,
    });
    assert.equal(transport.authorizations.length, 1);
    assert.equal(transport.authorizations[0].released, false);
    assert.equal(transport.stopped, false);

    const clientC = await fixture.makeClient('8.3.1');
    clientC.addWindow(18, overlayWindow('late-client'));
    clientC.sendFrameBuffer(18, Buffer.from([21, 22, 23, 24]), 1, 1);
    const order = [];
    clientC.setEventCallback((event, payload) => {
      order.push({ event, payload });
    });
    const authorizationC = await clientC
      .authorizeTarget(
        TARGET_PID,
        'C:\\broker-tests\\late-client\\electron-overlay-transport-v1.json',
        `\\\\?\\${TARGET_EXE}`,
      )
      .then((authorization) => {
        order.push({ event: 'authorized', payload: authorization });
        return authorization;
      });

    assert.equal(authorizationC.disposition, 'joined-existing');
    assert.deepEqual(authorizationC.target, {
      pid: TARGET_PID,
      executablePath: TARGET_EXE,
      discoveryPath:
        'C:\\broker-tests\\persistent-owner\\electron-overlay-transport-v1.json',
    });
    assert.equal(transport.authorizations.length, 1);
    assert.deepEqual(
      order.map(({ event }) => event),
      [
        'game.process',
        'game.target.surface',
        'game.graphics.fps',
        'game.input.intercept',
        'authorized',
      ],
    );
    assert.equal(order[1].payload.surfaceId, 'live-surface');
    assert.equal(order[3].payload.intercepting, false);
    assert.deepEqual(
      [...transport.windows.values()].map(({ name }) => name),
      ['late-client'],
    );
    assert.deepEqual(
      [...transport.frames.values()].map(({ pixels }) => [...pixels]),
      [[21, 22, 23, 24]],
    );

    authorizationC.release();
    await waitFor(() => transport.intercepts.at(-1) === false);
    assert.equal(transport.stopped, false);
    transport.emit('game.process.disconnected', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(
      () => transport.authorizations[0].released && transport.stopped,
    );
  } finally {
    await fixture.close();
  }
});

test('a late app waits through transport loss and joins only after runtime reauthentication', async () => {
  const fixture = await startFixture();
  try {
    const clientA = await fixture.makeClient('7.0.0');
    const authorizationA = await clientA.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\transport-owner\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    const transport = fixture.transports[0];
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    transport.emit('game.target.surface', {
      pid: TARGET_PID,
      surfaceId: 'pre-loss-surface',
      revision: 3,
    });
    transport.emit('game.process.transport-lost', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });

    const clientB = await fixture.makeClient('7.9.0');
    const eventsB = [];
    clientB.setEventCallback((event, payload) =>
      eventsB.push({ event, payload }),
    );
    let joined = false;
    const authorizationBPromise = clientB
      .authorizeTarget(
        TARGET_PID,
        'C:\\broker-tests\\transport-waiter\\electron-overlay-transport-v1.json',
        TARGET_EXE,
      )
      .then((authorization) => {
        joined = true;
        return authorization;
      });

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(joined, false);
    assert.deepEqual(eventsB, []);
    assert.equal(transport.authorizations.length, 1);

    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    const authorizationB = await authorizationBPromise;
    assert.equal(authorizationB.disposition, 'joined-existing');
    assert.deepEqual(
      eventsB.map(({ event }) => event),
      ['game.process'],
    );

    authorizationA.release();
    authorizationB.release();
    transport.emit('game.process.disconnected', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(() => transport.stopped);
  } finally {
    await fixture.close();
  }
});

test('a late app waiting through transport loss is rejected if the target exits', async () => {
  const fixture = await startFixture();
  try {
    const clientA = await fixture.makeClient('7.1.0');
    await clientA.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\exiting-owner\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    const transport = fixture.transports[0];
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    transport.emit('game.process.transport-lost', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });

    const clientB = await fixture.makeClient('7.2.0');
    const waitingAuthorization = clientB.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\exiting-waiter\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    transport.emit('game.process.disconnected', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });

    await assert.rejects(waitingAuthorization, /exited before.*lease/i);
    await waitFor(() => transport.stopped);
  } finally {
    await fixture.close();
  }
});

test('idle shutdown waits for the last authenticated target anchor to exit', async () => {
  const pipePath = uniquePipePath();
  const transport = new FakeTargetTransport(TARGET_PID);
  const server = new OverlayBrokerServer({
    pipePath,
    idleShutdownMs: 25,
    runtimeProviderElectionWindowMs: 0,
    isProcessAlive: () => true,
    targetTransportFactory: () => transport,
  });
  const client = new OverlayBrokerClient({
    pipePath,
    sdkVersion: '9.0.0',
    spawnBroker: () => undefined,
  });
  try {
    await server.start();
    client.start();
    await client.whenReady();
    await client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\idle-anchor\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    client.stop();
    await waitFor(() => transport.intercepts.at(-1) === false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(server.isRunning, true);
    assert.equal(transport.stopped, false);

    transport.emit('game.process.disconnected', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(() => !server.isRunning);
    assert.equal(transport.stopped, true);
    assert.equal(transport.authorizations[0].released, true);
  } finally {
    client.stop();
    await server.stop();
  }
});

test('a settled lease recovers from broker loss and retries transient reauthorization failures', async () => {
  const pipePath = uniquePipePath();
  const initialTransport = new FakeTargetTransport(TARGET_PID);
  const initialServer = new OverlayBrokerServer({
    pipePath,
    idleShutdownMs: false,
    runtimeProviderElectionWindowMs: 0,
    isProcessAlive: () => true,
    targetTransportFactory: () => initialTransport,
  });
  const client = new OverlayBrokerClient({
    pipePath,
    sdkVersion: '10.0.0-survivor',
    spawnBroker: () => undefined,
  });
  let replacementServer;
  try {
    await initialServer.start();
    client.start();
    await client.whenReady();

    const events = [];
    client.setEventCallback((event, payload) =>
      events.push({ event, payload }),
    );
    let authorizationResolutionCount = 0;
    const authorization = await client
      .authorizeTarget(
        TARGET_PID,
        'C:\\broker-tests\\restart-owner\\electron-overlay-transport-v1.json',
        TARGET_EXE,
      )
      .then((value) => {
        authorizationResolutionCount += 1;
        return value;
      });
    assert.equal(authorization.disposition, 'injection-owner');

    initialTransport.emit('game.process', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(
      () => events.filter(({ event }) => event === 'game.process').length === 1,
    );

    await initialServer.stop();
    await waitFor(
      () =>
        events.filter(({ event }) => event === 'game.process.transport-lost')
          .length === 1,
    );
    assert.deepEqual(
      events.find(({ event }) => event === 'game.process.transport-lost')
        .payload,
      { pid: TARGET_PID, path: TARGET_EXE },
    );

    let reauthorizationAttempts = 0;
    const attemptedDiscoveryPaths = [];
    const replacementTransports = [];
    replacementServer = new OverlayBrokerServer({
      pipePath,
      idleShutdownMs: false,
      runtimeProviderElectionWindowMs: 0,
      isProcessAlive: () => true,
      targetTransportFactory(pid) {
        const transport = new FakeTargetTransport(pid);
        const authorizeTarget = transport.authorizeTarget.bind(transport);
        transport.authorizeTarget = async (
          requestedPid,
          discoveryPath,
          expectedExecutablePath,
        ) => {
          reauthorizationAttempts += 1;
          attemptedDiscoveryPaths.push(discoveryPath);
          if (reauthorizationAttempts < 3) {
            throw new Error('transient restart authorization failure');
          }
          return authorizeTarget(
            requestedPid,
            discoveryPath,
            expectedExecutablePath,
          );
        };
        replacementTransports.push(transport);
        return transport;
      },
    });
    await replacementServer.start();

    await waitFor(() => reauthorizationAttempts === 3, 4_000);
    assert.deepEqual(attemptedDiscoveryPaths, [
      'C:\\broker-tests\\restart-owner\\electron-overlay-transport-v1.json',
      'C:\\broker-tests\\restart-owner\\electron-overlay-transport-v1.json',
      'C:\\broker-tests\\restart-owner\\electron-overlay-transport-v1.json',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(reauthorizationAttempts, 3);
    assert.equal(authorizationResolutionCount, 1);

    const recoveredTransport = replacementTransports.at(-1);
    assert.ok(recoveredTransport);
    recoveredTransport.emit('game.process', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(
      () => events.filter(({ event }) => event === 'game.process').length === 2,
    );
    assert.equal(
      events.filter(({ event }) => event === 'game.process.transport-lost')
        .length,
      1,
    );

    authorization.release();
    recoveredTransport.emit('game.process.disconnected', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(() => recoveredTransport.stopped);
  } finally {
    client.stop();
    await replacementServer?.stop();
    await initialServer.stop();
  }
});

test('a settled replay is retired terminally when the target exits before reauthentication', async () => {
  const pipePath = uniquePipePath();
  const initialTransport = new FakeTargetTransport(TARGET_PID);
  const initialServer = new OverlayBrokerServer({
    pipePath,
    idleShutdownMs: false,
    runtimeProviderElectionWindowMs: 0,
    isProcessAlive: () => true,
    targetRecoveryClaimProbe: () => undefined,
    clearTargetRecoveryClaim: () => undefined,
    targetTransportFactory: () => initialTransport,
  });
  const client = new OverlayBrokerClient({
    pipePath,
    sdkVersion: '10.0.0-terminal-replay',
    spawnBroker: () => undefined,
  });
  let replacementServer;
  try {
    await initialServer.start();
    client.start();
    await client.whenReady();
    const events = [];
    client.setEventCallback((event, payload) =>
      events.push({ event, payload }),
    );
    await client.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\terminal-replay\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    initialTransport.emit('game.process', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(() => events.some(({ event }) => event === 'game.process'));
    await initialServer.stop();

    const replacementTransport = new FakeTargetTransport(TARGET_PID);
    replacementServer = new OverlayBrokerServer({
      pipePath,
      idleShutdownMs: false,
      runtimeProviderElectionWindowMs: 0,
      isProcessAlive: () => true,
      targetRecoveryClaimProbe: () => undefined,
      clearTargetRecoveryClaim: () => undefined,
      targetTransportFactory: () => replacementTransport,
    });
    await replacementServer.start();
    await waitFor(
      () => replacementTransport.authorizations.length === 1,
      4_000,
    );
    replacementTransport.emit('game.process.disconnected', {
      pid: TARGET_PID,
      path: TARGET_EXE,
    });
    await waitFor(
      () =>
        events.filter(({ event }) => event === 'game.process.disconnected')
          .length === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(replacementTransport.authorizations.length, 1);
    assert.equal(
      events.filter(({ event }) => event === 'game.process.disconnected')
        .length,
      1,
    );
  } finally {
    client.stop();
    await replacementServer?.stop();
    await initialServer.stop();
  }
});

test('a caught pre-consumable intent failure does not strand the PID for a new application lease', async () => {
  let firstAttempt = true;
  let claim;
  const fixture = await startFixture({
    targetRecoveryClaimProbe: () => claim,
    configureTransport(transport) {
      const authorizeTarget = transport.authorizeTarget.bind(transport);
      transport.authorizeTarget = async (...args) => {
        if (firstAttempt) {
          firstAttempt = false;
          claim = {
            schemaVersion: 1,
            targetPid: TARGET_PID,
            discoveryPath: args[1],
            staticDiscoveryPath: `C:\\broker-tests\\temp\\electron-overlay-transport-v1.pid-${TARGET_PID}.json`,
            expectedExecutablePath: args[2],
            leaseId: args[3]?.leaseId,
            phase: 'intent',
            record: {
              version: 1,
              pid: 7_007,
              port: 47_007,
              token: '78'.repeat(32),
              targetPid: TARGET_PID,
            },
          };
          claim = undefined;
          throw new Error('caught intent publication failure');
        }
        return authorizeTarget(...args);
      };
    },
  });
  try {
    const first = await fixture.makeClient('1.0.0-first-lease');
    await assert.rejects(
      first.authorizeTarget(
        TARGET_PID,
        'C:\\broker-tests\\caught-intent\\electron-overlay-transport-v1.json',
        TARGET_EXE,
      ),
      /caught intent publication failure/i,
    );

    const second = await fixture.makeClient('2.0.0-new-lease');
    const authorization = await second.authorizeTarget(
      TARGET_PID,
      'C:\\broker-tests\\caught-intent\\electron-overlay-transport-v1.json',
      TARGET_EXE,
    );
    assert.equal(authorization.disposition, 'injection-owner');
    authorization.release();
  } finally {
    await fixture.close();
  }
});

test('an initial target authorization failure remains terminal and is not retried', async () => {
  const pipePath = uniquePipePath();
  let authorizationAttempts = 0;
  const server = new OverlayBrokerServer({
    pipePath,
    idleShutdownMs: false,
    runtimeProviderElectionWindowMs: 0,
    isProcessAlive: () => true,
    targetTransportFactory(pid) {
      const transport = new FakeTargetTransport(pid);
      transport.authorizeTarget = async () => {
        authorizationAttempts += 1;
        throw new Error('initial authorization failure');
      };
      return transport;
    },
  });
  const client = new OverlayBrokerClient({
    pipePath,
    sdkVersion: '10.0.0-initial-failure',
    spawnBroker: () => undefined,
  });
  try {
    await server.start();
    client.start();
    await client.whenReady();
    await assert.rejects(
      client.authorizeTarget(
        TARGET_PID,
        'C:\\broker-tests\\initial-failure\\electron-overlay-transport-v1.json',
        TARGET_EXE,
      ),
      /target-authorization-failed:.*initial authorization failure/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(authorizationAttempts, 1);
  } finally {
    client.stop();
    await server.stop();
  }
});
