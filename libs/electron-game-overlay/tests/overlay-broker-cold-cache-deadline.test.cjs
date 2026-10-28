const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const fixture = require('./helpers/standalone-broker-fixture.cjs');
const restorePrivilege = fixture.controlPrivilegeProbe();
const { ensureOverlayBrokerRunning } = require('../dist/lib/overlay-broker-bootstrap.js');
const { OverlayBrokerClient } = require('../dist/lib/overlay-broker-client.js');
const protocol = require('../dist/lib/overlay-broker-protocol.js');
test.after(() => restorePrivilege());
test.after(() => fixture.disposeFixture());

async function context(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ego-cold-budget-'));
  const source = path.join(root, 'distribution');
  const log = path.join(root, 'launches.jsonl');
  await fs.mkdir(source);
  await fixture.writeFixtureDistribution(source, {
    version: '1.0.0', mode: 'healthy', delayMs: 0, log,
    capabilities: protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES,
  });
  t.after(async () => {
    try {
      for (const line of (await fs.readFile(log, 'utf8')).trim().split('\n')) {
        try { process.kill(JSON.parse(line).pid, 'SIGKILL'); } catch {}
      }
    } catch {}
    await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });
  return {
    root, log, source,
    options: {
      storageRoot: path.join(root, 'state'), distributionPath: source,
      pipePath: process.platform === 'win32' ? `\\\\.\\pipe\\ego-cold-${randomUUID()}` : path.join(root, 'broker.sock'),
    },
  };
}

// Only elapsed wall-clock accounting at an actual filesystem copy is controlled.
// All validation/hash/copy, discovery, mutex, sockets, bootstrap and client code is real.
function elapseAtFirstCopy(source, elapsedMs = 16_000) {
  const originalCopy = fs.copyFile;
  const originalNow = Date.now;
  let copies = 0;
  let offset = 0;
  Date.now = () => originalNow() + offset;
  fs.copyFile = async function (from, ...args) {
    const result = await originalCopy.call(this, from, ...args);
    if (path.dirname(from) === source && ++copies === 1) offset += elapsedMs;
    return result;
  };
  return {
    get copies() { return copies; },
    restore() { fs.copyFile = originalCopy; Date.now = originalNow; },
  };
}

const rejection = (promise) => promise.then(() => undefined, error => error);

async function coldClient(t, { elapsedMs = 16_000, connectTimeoutMs } = {}) {
  const c = await context(t);
  const client = new OverlayBrokerClient({
    pipePath: c.options.pipePath,
    connectTimeoutMs,
    brokerInstallation: { storageRoot: c.options.storageRoot, distributionPath: c.source },
  });
  t.after(() => client.stop());
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const clock = elapseAtFirstCopy(c.source, elapsedMs);
  try {
    client.start();
    const ready = client.whenReady();
    const error = await rejection(ready);
    assert.ok(clock.copies >= 1, 'must reach real independent cache copying, not fail setup');
    if (!error) {
      assert.equal((await fs.readFile(c.log, 'utf8')).trim().split('\n').length, 1);
      await assert.rejects(fs.access(path.join(c.options.storageRoot, 'catalog.json')), { code: 'ENOENT' });
      return { error };
    }
    await assert.rejects(fs.access(c.log), { code: 'ENOENT' });
    client.start(); // An already-started client does not recreate its rejected ready promise.
    const sameReady = client.whenReady() === ready;
    const laterReadyError = await rejection(client.whenReady());
    const later = client.authorizeTarget(12345, path.join(c.root, 'target.json'));
    let settled = false;
    const exactPid = rejection(later).then(error => { settled = true; return error; });
    await new Promise(resolve => setImmediate(resolve));
    const immediate = settled;
    const exactPidError = await exactPid;
    t.diagnostic(JSON.stringify({ ready: error?.message, retainedReady: laterReadyError?.message, exactPid: exactPidError?.message, copies: clock.copies, sameReady, immediate }));
    return { error, laterReadyError, exactPidError, sameReady, immediate };
  } finally {
    clock.restore();
    client.stop();
    // Let expired in-flight filesystem cleanup finish before fixture teardown.
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

test('control: the sealed healthy unregistered package starts with production default budgets', { timeout: 30000 }, async (t) => {
  const c = await context(t);
  await ensureOverlayBrokerRunning(c.options);
  assert.equal((await fs.readFile(c.log, 'utf8')).trim().split('\n').length, 1);
  await assert.rejects(fs.access(path.join(c.options.storageRoot, 'catalog.json')), { code: 'ENOENT' });
});

test('explicit 15000ms total override: cold copy exhausts deadline and client retains fatal readiness', { timeout: 5000 }, async (t) => {
  const { error, laterReadyError, exactPidError, sameReady, immediate } = await coldClient(t, { connectTimeoutMs: 15_000 });
  assert.equal(sameReady, true);
  assert.equal(immediate, true);
  assert.equal(error?.message, 'No validated standalone overlay broker could be started');
  assert.equal(laterReadyError, error);
  assert.equal(exactPidError?.message, 'Overlay broker client is not running');
});

test('default: valid first cache preparation exceeding 15000ms reaches client readiness', { timeout: 5000 }, async (t) => {
  const { error } = await coldClient(t);
  assert.equal(error, undefined, 'healthy first-use cache preparation fits the shared bounded total startup default');
});

test('default cap: healthy cold cache exceeding 75000ms fails without spawning', { timeout: 5000 }, async (t) => {
  const { error, sameReady, immediate } = await coldClient(t, { elapsedMs: 76_000 });
  assert.equal(error?.message, 'No validated standalone overlay broker could be started');
  assert.equal(sameReady, true);
  assert.equal(immediate, true);
});

test('bootstrap default admits slow healthy copying but remains capped at 75000ms', { timeout: 5000 }, async (t) => {
  for (const elapsedMs of [16_000, 76_000]) {
    const c = await context(t);
    const clock = elapseAtFirstCopy(c.source, elapsedMs);
    try {
      const error = await rejection(ensureOverlayBrokerRunning(c.options));
      assert.ok(clock.copies >= 1);
      if (elapsedMs < 75_000) {
        assert.equal(error, undefined);
        assert.equal((await fs.readFile(c.log, 'utf8')).trim().split('\n').length, 1);
      } else {
        assert.equal(error?.message, 'No validated standalone overlay broker could be started');
        await assert.rejects(fs.access(c.log), { code: 'ENOENT' });
      }
    } finally {
      clock.restore();
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
});

test('default joins existing compatible owner without preparing another cold cache', { timeout: 5000 }, async (t) => {
  const c = await context(t);
  await ensureOverlayBrokerRunning(c.options);
  const clock = elapseAtFirstCopy(c.source, 76_000);
  const client = new OverlayBrokerClient({
    pipePath: c.options.pipePath,
    brokerInstallation: { storageRoot: path.join(c.root, 'unused-cache'), distributionPath: c.source },
  });
  try {
    await ensureOverlayBrokerRunning({ ...c.options, storageRoot: path.join(c.root, 'unused-cache') });
    client.start();
    await client.whenReady();
    assert.equal(clock.copies, 0);
    await assert.rejects(fs.access(path.join(c.root, 'unused-cache')), { code: 'ENOENT' });
    assert.equal((await fs.readFile(c.log, 'utf8')).trim().split('\n').length, 1);
  } finally {
    client.stop();
    clock.restore();
  }
});
