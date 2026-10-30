const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const manager = path.resolve('validated-native-manager.exe');
const anchor = '\\\\?\\GLOBALROOT\\SystemRoot\\System32';
const directory = 'Z:\\OS Installation\\System32';
const bootstrap = require('../dist/lib/overlay-broker-bootstrap.js');
const provider = require('../dist/lib/overlay-broker-native-provider.js');

function boundary(t, resolution = directory) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalRealpath = fs.realpath.native;
  const originalExec = cp.execFile;
  const calls = [];
  Object.defineProperty(process, 'platform', { value: 'win32' });
  fs.realpath.native = (input, callback) => {
    assert.equal(
      input,
      anchor,
      'only the kernel-owned anchor is resolution authority',
    );
    calls.push('resolve');
    queueMicrotask(() =>
      callback(resolution instanceof Error ? resolution : null, resolution),
    );
  };
  cp.execFile = (exe, args, options, callback) => {
    calls.push(exe);
    assert.equal(
      options.cwd,
      exe.endsWith('whoami.exe') ? directory : path.dirname(manager),
    );
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    queueMicrotask(() =>
      callback(
        null,
        exe.endsWith('whoami.exe')
          ? 'S-1-16-8192'
          : JSON.stringify({
              schemaVersion: 1,
              kind: 'electron-game-overlay-process-image',
              pid: 42,
              executablePath: 'C:\\Games\\game.exe',
            }) + '\n',
      ),
    );
  };
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    fs.realpath.native = originalRealpath;
    cp.execFile = originalExec;
  });
  return calls;
}

test('privilege guard retains kernel-owned whoami while native query never resolves SystemRoot or PowerShell', async (t) => {
  const calls = boundary(t);
  await bootstrap.assertOverlayBrokerPrivilege();
  const environment = process.env;
  let actual;
  try {
    process.env = new Proxy(environment, {
      get() {
        assert.fail('native query must not consult environment authority');
      },
      ownKeys() {
        assert.fail('native query must not enumerate environment authority');
      },
    });
    actual = await provider.resolveOverlayBrokerProcessImage(42, manager);
  } finally {
    process.env = environment;
  }
  assert.equal(actual, 'C:\\Games\\game.exe');
  assert.deepEqual(calls, ['resolve', directory + '\\whoami.exe', manager]);
});

test('kernel anchor rejects noncanonical/device/relative resolution without spawning the privilege probe', async (t) => {
  const calls = boundary(t);
  for (const result of [
    'C:relative',
    '\\System32',
    '\\\\server\\share',
    anchor,
    'C:\\Windows\\..\\app',
    'C:\\bad\npath',
    'C:\\Windows\\System32:stream',
  ]) {
    fs.realpath.native = (input, callback) => {
      assert.equal(input, anchor);
      queueMicrotask(() => callback(null, result));
    };
    await assert.rejects(
      bootstrap.assertOverlayBrokerPrivilege(),
      /Unable to prove medium Windows integrity/,
    );
  }
  assert.deepEqual(calls, []);
});

test('resolution failure and synchronous spawn EINVAL retain actionable caller context and cause', async (t) => {
  const calls = boundary(
    t,
    Object.assign(new Error('anchor unavailable'), { code: 'ENOENT' }),
  );
  await assert.rejects(
    bootstrap.assertOverlayBrokerPrivilege(),
    (error) =>
      /Unable to prove medium Windows integrity/.test(error.message) &&
      error.cause.code === 'ENOENT',
  );
  assert.equal(
    await provider.resolveOverlayBrokerProcessImage(42, manager),
    'C:\\Games\\game.exe',
  );
  assert.deepEqual(calls, ['resolve', manager]);
  fs.realpath.native = (input, callback) =>
    queueMicrotask(() => callback(null, directory));
  cp.execFile = () => {
    throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
  };
  await assert.rejects(
    bootstrap.assertOverlayBrokerPrivilege(),
    (error) =>
      /Unable to prove medium Windows integrity/.test(error.message) &&
      error.cause.code === 'EINVAL',
  );
  await assert.rejects(
    provider.resolveOverlayBrokerProcessImage(42, manager),
    (error) =>
      /Unable to query OS executable identity for PID 42/.test(error.message) &&
      error.cause.code === 'EINVAL',
  );
});

test('kernel anchor resolution is bounded and a late callback never starts a child', async (t) => {
  const calls = boundary(t);
  let finish;
  fs.realpath.native = (input, callback) => {
    assert.equal(input, anchor);
    finish = callback;
  };
  const started = performance.now();
  let watchdog;
  const result = await Promise.race([
    bootstrap.assertOverlayBrokerPrivilege().then(
      () => 'accepted',
      () => 'refused',
    ),
    new Promise((resolve) => {
      watchdog = setTimeout(() => resolve('unbounded'), 2800);
    }),
  ]);
  clearTimeout(watchdog);
  assert.equal(
    result,
    'refused',
    'OS resolution must refuse before its deadline',
  );
  assert.ok(performance.now() - started < 3000);
  finish(null, directory);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
});
