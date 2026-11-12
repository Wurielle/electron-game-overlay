'use strict';

// Native watcher policy acceptance. The armed watcher matches no fixture process.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { serializeOverlayProcessPolicy } = require('../dist/lib/process-policy.js');
const { clearOldReShadeRuntimeCache, createReShadeLaunchConfig, inspectReShadeRuntimeStorage, launchReShadeOverlay, ReShadeOverlayLauncher } =
  require('../dist/lib/reshade-launcher.js');

function frame(policy) {
  const bytes = Buffer.from(policy, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}

test('native x64 and x86 policy stdin reject a valid prefix of an incomplete frame', () => {
  const directory = process.env.EGO_TEST_BUNDLED_RUNTIME;
  assert.ok(directory && path.isAbsolute(directory));
  const allow = 'C:/owned-fixture/**';
  const deny = 'C:/owned-fixture/blocked.exe';
  const policy = serializeOverlayProcessPolicy({ allow: [allow], deny: [deny] });
  const document = frame(policy);
  const incomplete = document.subarray(0, document.indexOf('\nD\t') + 1);
  assert.ok(incomplete.length > 4);
  for (const leaf of ['inject.exe', 'inject32.exe']) {
    const evaluate = (file, input) => spawnSync(path.join(directory, leaf),
      ['--check-process-policy-stdin', file], { input, encoding: 'utf8', windowsHide: true, timeout: 4000 });
    for (const [file, verdict] of [['C:/owned-fixture/allowed.exe', 'ALLOW'], [deny, 'DENY']]) {
      const outcome = evaluate(file, document);
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.status, 0, outcome.stderr);
      assert.equal(outcome.stdout.trim(), 'EGO_PROCESS_POLICY_' + verdict);
    }
    for (const invalid of [incomplete, Buffer.alloc(262149), Buffer.concat([document, Buffer.of(0)])]) {
      const outcome = evaluate(deny, invalid);
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.status, 13);
      assert.equal(outcome.stdout, '');
    }
  }
});

test('overlapping and restarted production watchers use stdin and reuse one version cache', { timeout: 15000 }, async () => {
  const parent = await fs.realpath(path.resolve('build'));
  const fixture = await fs.mkdtemp(path.join(parent, 'native-policy-stdin-'));
  const launchers = [];
  const config = createReShadeLaunchConfig({
    bundledRuntimeDirectory: process.env.EGO_TEST_BUNDLED_RUNTIME,
    runsRootDirectory: path.join(fixture, 'runs'),
  });
  async function arm(label) {
    const launcher = new ReShadeOverlayLauncher(config);
    launchers.push(launcher);
    let timer;
    const ready = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Watcher did not arm from stdin')), 8000);
      launcher.onEvent((event) => {
        if (event.type === 'injector-watcher-ready') resolve(event);
        if (event.type === 'target-selected') reject(new Error('Unexpected fixture target'));
      });
    });
    const selector = path.join(fixture, label).replace(/\\/g, '/');
    const operation = launchReShadeOverlay(launcher, {
      pathContains: selector, processPolicy: { allow: [selector + '/**'] },
    }).catch((error) => error);
    try {
      const event = await ready;
      assert.ok(event.creationCutoff100ns);
      assert.deepEqual(event.invocation.arguments.slice(2), ['--policy-stdin', '1']);
      await assert.rejects(fs.access(path.join(launcher.runDirectory, 'ego-process-policy.txt')), { code: 'ENOENT' });
      return { launcher, operation };
    } finally {
      clearTimeout(timer);
    }
  }
  async function stop({ launcher, operation }) {
    assert.equal(await launcher.quiesceUnselectedPolicyWatcher(), true);
    assert.equal((await operation).retrySafety, 'definite-safe');
    await launcher.disposeAsync();
  }
  try {
    const overlapping = await Promise.all([arm('never-created-a'), arm('never-created-b')]);
    const { sdkVersionCacheDirectory } = await inspectReShadeRuntimeStorage({ runsRootDirectory: config.runsRootDirectory });
    const versionKey = createHash('sha256').update(require('../package.json').version).digest('hex');
    const cachedPath = path.join(sdkVersionCacheDirectory, versionKey, 'inject.exe');
    const identity = async (file) => {
      const { dev, ino } = await fs.stat(file, { bigint: true });
      return [dev, ino];
    };
    const cachedIdentity = await identity(cachedPath);
    for (const { launcher } of overlapping)
      assert.deepEqual(await identity(path.join(launcher.runDirectory, 'inject.exe')), cachedIdentity);
    assert.deepEqual(await clearOldReShadeRuntimeCache({ runsRootDirectory: config.runsRootDirectory }), []);
    await Promise.all(overlapping.map(stop));
    const restarted = await arm('never-created-c');
    assert.deepEqual(await identity(path.join(restarted.launcher.runDirectory, 'inject.exe')), cachedIdentity);
    await stop(restarted);
    assert.deepEqual(await fs.readdir(sdkVersionCacheDirectory), [versionKey]);
    assert.deepEqual(await identity(cachedPath), cachedIdentity);
  } finally {
    await Promise.all(launchers.map((launcher) => launcher.disposeAsync()));
    assert.equal(path.dirname(await fs.realpath(fixture)), parent);
    await fs.rm(fixture, { recursive: true, force: false });
  }
});
