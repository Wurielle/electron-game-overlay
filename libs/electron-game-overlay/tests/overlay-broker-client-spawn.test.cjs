const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const test = require('node:test');

const { OverlayBrokerClient } = require('../dist/lib/overlay-broker-client.js');
const {
  BrokerPacketDecoder,
  OVERLAY_BROKER_CAPABILITIES,
  OVERLAY_BROKER_PROTOCOL_VERSION,
  encodeBrokerJsonPacket,
} = require('../dist/lib/overlay-broker-protocol.js');

const uniquePipePath = () =>
  `\\\\.\\pipe\\electron-game-overlay-spawn-test-${randomUUID()}`;

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for overlay broker spawn recovery');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('retries a failed replacement broker spawn after the client was ready', async () => {
  const pipePath = uniquePipePath();
  const initialBroker = await startWelcomeBroker(pipePath);
  let spawnAttempts = 0;
  const spawnAttemptTimes = [];
  let replacementBroker;
  let replacementStart;
  const client = new OverlayBrokerClient({
    pipePath,
    sdkVersion: 'spawn-recovery-test',
    spawnBroker() {
      spawnAttempts += 1;
      spawnAttemptTimes.push(Date.now());
      if (spawnAttempts === 2) {
        replacementStart = startWelcomeBroker(pipePath).then((broker) => {
          replacementBroker = broker;
          return broker;
        });
      }
    },
  });

  try {
    client.start();
    await client.whenReady();
    await waitFor(() => initialBroker.helloCount === 1);

    await initialBroker.close();
    await waitFor(() => spawnAttempts >= 2);
    assert.ok(replacementStart);
    await replacementStart;
    await waitFor(() => replacementBroker.helloCount === 1);
    assert.ok(
      spawnAttemptTimes[1] - spawnAttemptTimes[0] >= 750,
      'spawn retries must remain cooldown-bounded',
    );
  } finally {
    client.stop();
    await replacementBroker?.close();
    await initialBroker.close();
  }
});

async function startWelcomeBroker(pipePath) {
  const sockets = new Set();
  let helloCount = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    const decoder = new BrokerPacketDecoder();
    socket.on('data', (chunk) => {
      for (const packet of decoder.push(chunk)) {
        if (packet.kind !== 'json' || packet.value.type !== 'broker.hello') {
          continue;
        }
        helloCount += 1;
        socket.write(
          encodeBrokerJsonPacket({
            type: 'broker.welcome',
            protocolVersion: OVERLAY_BROKER_PROTOCOL_VERSION,
            capabilities: OVERLAY_BROKER_CAPABILITIES,
            sessionId: randomUUID(),
            brokerPid: process.pid,
          }),
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, resolve);
  });
  let closed = false;
  return {
    get helloCount() {
      return helloCount;
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
