// Only filesystem identity is controlled; broker/transport/claims are production.
const os = require('node:os');
const path = require('node:path');
const root = process.env.EGO_CRASH_TEST_ROOT;
if (!root) throw new Error('isolated test root required');
const originalUserInfo = os.userInfo;
os.userInfo = (...args) => ({ ...originalUserInfo(...args), homedir: root });
os.tmpdir = () => root;
// Separate SDK application processes for the zero-surviving-app recovery case.
if (process.env.EGO_CRASH_TEST_ROLE === 'sdk') {
  const {
    OverlayBrokerClient,
  } = require('../dist/lib/overlay-broker-client.js');
  const sdk = new OverlayBrokerClient({
    pipePath: process.env.EGO_CRASH_TEST_PIPE,
    spawnBroker() {},
    connectTimeoutMs: 6000,
  });
  process.on('message', async (message) => {
    if (message.kind === 'authorize') {
      try {
        const result = await sdk.authorizeTarget(
          message.pid,
          message.route,
          message.exe,
        );
        process.send({ kind: 'sdk-authorized', result });
      } catch (error) {
        process.send({ kind: 'sdk-error', error: error.message });
      }
    }
    if (message.kind === 'exit') {
      sdk.stop();
      process.exit(0);
    }
  });
  sdk.start();
  sdk.whenReady().then(() => process.send({ kind: 'sdk-ready' }));
  return;
}
// Freeze only after the real atomic claim rename has completed. No claim is seeded.
if (process.env.EGO_CRASH_PUBLISHING_CLAIM) {
  const fs = require('node:fs/promises');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    await rename(from, to);
    if (to === process.env.EGO_CRASH_PUBLISHING_CLAIM) {
      const claim = JSON.parse(await fs.readFile(to, 'utf8'));
      if (claim.phase === 'publishing') {
        await new Promise((resolve) =>
          process.send({ kind: 'publishing-durable', claim }, resolve),
        );
        await new Promise(() => {}); // Parent kills this owned child at the barrier.
      }
    }
  };
}
if (process.env.EGO_CRASH_MUTATE_FREEZE === '1') {
  const Module = require('node:module');
  const file = require.resolve('../dist/lib/overlay-loopback-transport.js');
  const source = require('node:fs').readFileSync(file, 'utf8');
  const needle =
    "if (claim.phase === 'publishing' || claim.phase === 'published') {";
  require('node:assert/strict').equal(source.split(needle).length, 2);
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  require.cache[file] = mod;
  mod._compile(source.replace(needle, 'if (false) {'), file);
}
const protocol = require('../dist/lib/overlay-broker-protocol.js');
const encode = protocol.encodeBrokerJsonPacket;
protocol.encodeBrokerJsonPacket = (message) => {
  if (message.type === 'broker.target.authorized')
    process.send({ kind: 'authorization', message });
  return encode(message);
};
const { OverlayBrokerServer } = require('../dist/lib/overlay-broker-server.js');
const server = new OverlayBrokerServer({
  pipePath: process.env.EGO_CRASH_TEST_PIPE,
  idleShutdownMs: false,
});
server.start().then(
  () => process.send({ kind: 'ready' }),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
