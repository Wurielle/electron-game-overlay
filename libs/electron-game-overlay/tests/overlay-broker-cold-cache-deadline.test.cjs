const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const os = require('node:os');
const childProcess = require('node:child_process');
const nativeFs = require('node:fs');
const ownedRoot = nativeFs.mkdtempSync(path.join(tmpdir(), 'ego-cold-owned-'));
const originalUserInfo = os.userInfo;
const originalTmpdir = process.env.TMPDIR;
os.userInfo = (...args) => ({ ...originalUserInfo(...args), homedir: ownedRoot });
process.env.TMPDIR = ownedRoot;
const originalSpawn = childProcess.spawn;
const children = [];
childProcess.spawn = function (...args) {
  const child = originalSpawn.apply(this, args);
  children.push({ child, cwd: args[2]?.cwd });
  return child;
};
test.after(async () => {
  childProcess.spawn = originalSpawn;
  os.userInfo = originalUserInfo;
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await cleanupDeadline(fs.rm(ownedRoot, { recursive: true, force: true }));
});
const fixture = require('./helpers/standalone-broker-fixture.cjs');
const restorePrivilege = fixture.controlPrivilegeProbe();
const { ensureOverlayBrokerRunning } = require('../dist/lib/overlay-broker-bootstrap.js');
const { OverlayBrokerClient } = require('../dist/lib/overlay-broker-client.js');
const protocol = require('../dist/lib/overlay-broker-protocol.js');
test.after(() => restorePrivilege());
test.after(() => fixture.disposeFixture());

// node:test cancellation does not unwind an arbitrary pending promise.
function until(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const done = (settle, value) => {
      signal.removeEventListener('abort', abort);
      settle(value);
    };
    Promise.resolve(promise).then(value => done(resolve, value), error => done(reject, error));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function cleanupDeadline(promise) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Cold fixture cleanup timed out')), 1000);
  try { return await until(promise, controller.signal); }
  finally { clearTimeout(timer); }
}

async function context(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ego-cold-budget-'));
  const cleanups = [];
  t.after(async () => {
    let failure;
    const attempt = async action => {
      try { await action(); } catch (error) { failure ??= error; }
    };
    for (const cleanup of cleanups) await attempt(cleanup);
    for (const { child, cwd } of children) {
      if (!cwd?.startsWith(root + path.sep) || child.exitCode !== null || child.signalCode !== null) continue;
      await attempt(async () => {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL');
        await cleanupDeadline(exited);
      });
    }
    await attempt(() => cleanupDeadline(fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
    if (failure) throw failure;
  });
  const source = path.join(root, 'distribution');
  const log = path.join(root, 'launches.jsonl');
  await fs.mkdir(source);
  await fixture.writeFixtureDistribution(source, {
    version: '1.0.0', mode: 'healthy', delayMs: 0, log,
    capabilities: protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES,
  });
  return {
    root, log, source, cleanups,
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

// Private fixture seams only: hold the completed real copy's continuation and
// reconnect scheduling. Fatal callbacks still come from real socket/bootstrap code.
async function orderedCap(t, producer, { elapsedMs = 76_000, connectTimeoutMs } = {}) {
  const c = await context(t);
  const client = new OverlayBrokerClient({
    pipePath: c.options.pipePath, connectTimeoutMs,
    brokerInstallation: { storageRoot: c.options.storageRoot, distributionPath: c.source },
  });
  const copied = Promise.withResolvers();
  const continuation = Promise.withResolvers();
  const originalCopy = fs.copyFile;
  const originalNow = Date.now;
  const spawn = childProcess.spawn;
  const schedule = client.scheduleConnection;
  const fatal = client.failFatal;
  let offset = 0;
  let copies = 0;
  let spawnAttempts = 0;
  let reconnect;
  let schedules = 0;
  let bootstrap;
  const fatals = [];
  const keepAlive = setInterval(() => {}, 1000);
  let teardown;
  const cleanup = () => teardown ??= (async () => {
    continuation.resolve();
    try {
      if (bootstrap ?? client.brokerBootstrap) {
        await cleanupDeadline(rejection(bootstrap ?? client.brokerBootstrap));
      }
    } finally {
      try { client.stop(); }
      finally {
        fs.copyFile = originalCopy;
        Date.now = originalNow;
        childProcess.spawn = spawn;
        clearInterval(keepAlive);
      }
    }
  })();
  c.cleanups.push(cleanup);
  t.after(cleanup);
  Date.now = () => originalNow() + offset;
  fs.copyFile = async function (from, ...args) {
    const result = await originalCopy.call(this, from, ...args);
    if (path.dirname(from) === c.source && ++copies === 1) {
      offset += elapsedMs;
      bootstrap = client.brokerBootstrap;
      copied.resolve();
      await until(continuation.promise, t.signal);
    }
    return result;
  };
  childProcess.spawn = () => {
    spawnAttempts++;
    throw new Error('Forbidden executable spawn after cold-cache cap');
  };
  client.scheduleConnection = function (...args) {
    if (++schedules === 1) return schedule.apply(this, args);
    reconnect = () => schedule.call(this, args[0], 0);
  };
  client.failFatal = function (error) {
    fatals.push({ error, bootstrapPending: this.brokerBootstrap !== undefined });
    return fatal.call(this, error);
  };
  let bootstrapResult;
  try {
    client.start();
    const ready = client.whenReady();
    const readyResult = rejection(ready);
    await until(copied.promise, t.signal);
    assert.ok(bootstrap instanceof Promise, 'capture actual in-flight bootstrap');
    bootstrapResult = rejection(bootstrap);
    assert.equal(copies, 1);
    assert.ok(Date.now() >= client.startupDeadline, 'original total cap is expired');
    assert.equal(client.connectTimeoutMs, connectTimeoutMs ?? 75_000);
    assert.equal(typeof reconnect, 'function');
    if (producer === 'socket') reconnect();
    else continuation.resolve();
    const error = await until(readyResult, t.signal);
    assert.equal(fatals[0].bootstrapPending, producer === 'socket');
    assert.equal(error, fatals[0].error);
    assert.equal(spawnAttempts, 0, 'no executable spawn before fatal readiness');
    client.start();
    assert.equal(client.whenReady(), ready);
    assert.equal(await until(rejection(client.whenReady()), t.signal), error);
    let immediate = false;
    const later = rejection(client.authorizeTarget(12345, path.join(c.root, 'target.json')))
      .then(error => { immediate = true; return error; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(immediate, true);
    assert.equal((await until(later, t.signal))?.message, 'Overlay broker client is not running');
    continuation.resolve();
    const bootstrapError = await until(bootstrapResult, t.signal);
    assert.equal(bootstrapError?.message, 'No validated standalone overlay broker could be started');
    assert.equal(client.brokerBootstrap, undefined, 'actual bootstrap has settled');
    assert.equal(fatals.length, producer === 'socket' ? 2 : 1);
    if (producer === 'socket') {
      assert.equal(fatals[1].error, bootstrapError, 'late actual bootstrap rejection reaches fatal guard');
      assert.equal(fatals[1].bootstrapPending, false);
    } else {
      assert.equal(error, bootstrapError, 'bootstrap rejection is the first fatal source');
      reconnect(); // Fatal startup must suppress even the released reconnect.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(client.socket, undefined);
    }
    assert.equal(await until(rejection(client.whenReady()), t.signal), error, 'late producer cannot replace first fatal');
    assert.equal(spawnAttempts, 0, 'no late executable spawn after bootstrap cleanup');
    await assert.rejects(fs.access(c.log), { code: 'ENOENT' });
    t.diagnostic(JSON.stringify({ producer, bootstrapPendingAtFatal: fatals[0].bootstrapPending, bootstrapSettled: true, copies, spawnAttempts }));
    return { error, pipePath: c.options.pipePath };
  } finally {
    // The registered hook reports cleanup errors without masking this body's error.
    await cleanup().catch(error => t.diagnostic(error.message));
  }
}


async function coldClient(t, { elapsedMs = 16_000, connectTimeoutMs } = {}) {
  const c = await context(t);
  const client = new OverlayBrokerClient({
    pipePath: c.options.pipePath,
    connectTimeoutMs,
    brokerInstallation: { storageRoot: c.options.storageRoot, distributionPath: c.source },
  });
  const keepAlive = setInterval(() => {}, 1000);
  let teardown;
  let clock;
  const cleanup = () => teardown ??= (async () => {
    try {
      if (client.brokerBootstrap) await cleanupDeadline(rejection(client.brokerBootstrap));
    } finally {
      try { client.stop(); }
      finally { clock?.restore(); clearInterval(keepAlive); }
    }
  })();
  c.cleanups.push(cleanup);
  t.after(cleanup);
  clock = elapseAtFirstCopy(c.source, elapsedMs);
  try {
    client.start();
    const ready = client.whenReady();
    const error = await until(rejection(ready), t.signal);
    assert.ok(clock.copies >= 1, 'must reach real independent cache copying, not fail setup');
    if (!error) {
      assert.equal((await fs.readFile(c.log, 'utf8')).trim().split('\n').length, 1);
      await assert.rejects(fs.access(path.join(c.options.storageRoot, 'catalog.json')), { code: 'ENOENT' });
      return { error };
    }
    await assert.rejects(fs.access(c.log), { code: 'ENOENT' });
    client.start(); // An already-started client does not recreate its rejected ready promise.
    const sameReady = client.whenReady() === ready;
    const laterReadyError = await until(rejection(client.whenReady()), t.signal);
    const later = client.authorizeTarget(12345, path.join(c.root, 'target.json'));
    let settled = false;
    const exactPid = rejection(later).then(error => { settled = true; return error; });
    await new Promise(resolve => setImmediate(resolve));
    const immediate = settled;
    const exactPidError = await until(exactPid, t.signal);
    t.diagnostic(JSON.stringify({ ready: error?.message, retainedReady: laterReadyError?.message, exactPid: exactPidError?.message, copies: clock.copies, sameReady, immediate }));
    return { error, laterReadyError, exactPidError, sameReady, immediate };
  } finally {
    await cleanup().catch(error => t.diagnostic(error.message));
  }
}

test('control: the sealed healthy unregistered package starts with production default budgets', { timeout: 30000 }, async (t) => {
  const c = await context(t);
  await ensureOverlayBrokerRunning(c.options);
  assert.equal((await fs.readFile(c.log, 'utf8')).trim().split('\n').length, 1);
  await assert.rejects(fs.access(path.join(c.options.storageRoot, 'catalog.json')), { code: 'ENOENT' });
});

test('explicit 15000ms total override: cold copy exhausts deadline and client retains fatal readiness', { timeout: 5000 }, async (t) => {
  const { error } = await orderedCap(t, 'bootstrap', { elapsedMs: 16_000, connectTimeoutMs: 15_000 });
  assert.equal(error?.message, 'No validated standalone overlay broker could be started');
});

test('default: valid first cache preparation exceeding 15000ms reaches client readiness', { timeout: 5000 }, async (t) => {
  const { error } = await coldClient(t);
  assert.equal(error, undefined, 'healthy first-use cache preparation fits the shared bounded total startup default');
});

test('default cap: socket fatal wins while cold-cache bootstrap is pending', { timeout: 5000 }, async (t) => {
  const { error, pipePath } = await orderedCap(t, 'socket');
  assert.equal(error?.message, `Unable to connect to the per-user overlay broker at ${pipePath}`);
});

test('default cap: bootstrap fatal wins before the held socket reconnect', { timeout: 5000 }, async (t) => {
  const { error } = await orderedCap(t, 'bootstrap');
  assert.equal(error?.message, 'No validated standalone overlay broker could be started');
});

test('bootstrap default admits slow healthy copying but remains capped at 75000ms', { timeout: 5000 }, async (t) => {
  for (const elapsedMs of [16_000, 76_000]) {
    const c = await context(t);
    const clock = elapseAtFirstCopy(c.source, elapsedMs);
    c.cleanups.push(() => clock.restore());
    try {
      const error = await until(rejection(ensureOverlayBrokerRunning(c.options)), t.signal);
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
  c.cleanups.push(() => { try { client.stop(); } finally { clock.restore(); } });
  try {
    await until(ensureOverlayBrokerRunning({ ...c.options, storageRoot: path.join(c.root, 'unused-cache') }), t.signal);
    client.start();
    await until(client.whenReady(), t.signal);
    assert.equal(clock.copies, 0);
    await assert.rejects(fs.access(path.join(c.root, 'unused-cache')), { code: 'ENOENT' });
    assert.equal((await fs.readFile(c.log, 'utf8')).trim().split('\n').length, 1);
  } finally {
    client.stop();
    clock.restore();
  }
});
