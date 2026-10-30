'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const harness = path.join(__dirname, 'process-instance-mixed.acceptance.cjs');
const source = () => fs.readFileSync(harness, 'utf8');

test('wrapper removes the entire private container after its owned worker times out', (t) => {
  const root = fixture(t);
  const old = path.join(root, 'validation-only-dist');
  fs.mkdirSync(path.join(old, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(old, 'lib/overlay-loopback-transport.js'), '// controlled validation input; never loaded');
  const marker = path.join(root, 'worker-root.json');
  const env = { ...process.env, TMPDIR: root, EGO_INSTANCE_MIXED_EVIDENCE: path.join(root, 'report.json') };
  delete env.EGO_INSTANCE_MIXED_WORKER;
  let calls = 0;
  let result;
  const stop = new Error('stop after first owned worker');
  const controlledSpawn = (_exe, _args, options) => {
    if (calls++) throw stop;
    assert.equal(options.timeout, 20000);
    const child = `const fs=require('node:fs'),path=require('node:path'); const parent=process.env.EGO_INSTANCE_MIXED_FIXTURE_PARENT || process.env.TMPDIR; const root=fs.mkdtempSync(path.join(parent,'ego-instance-mix-')); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent,root})); setInterval(()=>{},1000);`;
    result = spawnSync(process.execPath, ['-e', child], options);
    assert.equal(result.error?.code, 'ETIMEDOUT');
    assert.equal(result.signal, 'SIGTERM');
    return result;
  };
  try {
    vm.runInNewContext(source(), {
      require: (id) => id === 'node:child_process' ? { spawnSync: controlledSpawn } : require(id),
      __dirname, __filename: harness, console: { log() {} },
      process: { env, argv: [process.execPath, harness, old], execPath: process.execPath, platform: process.platform, version: process.version },
    });
  } catch (error) { assert.equal(error, stop); }
  assert.ok(result, 'actual owned child was invoked');
  const owned = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(fs.existsSync(owned.root), false, 'wrapper must remove timed-out worker root before outer rescue');
  assert.notEqual(owned.parent, root, 'wrapper must allocate its own entire container');
  assert.equal(fs.existsSync(owned.parent), false);
});
const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ego-mixed-harness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('invalid and missing roots overwrite stale success evidence', (t) => {
  const root = fixture(t);
  const evidence = path.join(root, 'evidence.json');
  for (const args of [[], ['relative-invalid-dist'], [path.join(root, 'missing')]]) {
    fs.writeFileSync(evidence, JSON.stringify({ success: true, stale: true }));
    const env = { ...process.env, EGO_INSTANCE_MIXED_EVIDENCE: evidence };
    delete env.EGO_INSTANCE_MIXED_WORKER;
    delete env.EGO_INSTANCE_MIXED_OLD_DIST;
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [harness, ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Explicit absolute|must be absolute|ENOENT/);
    const report = JSON.parse(fs.readFileSync(evidence, 'utf8'));
    assert.equal(report.success, false, 'validation must invalidate stale success');
    assert.equal(report.stale, undefined);
  }
});

test('settlement deadline preserves its error and still removes the owned root', async (t) => {
  const parent = fixture(t);
  const root = fs.mkdtempSync(path.join(parent, 'worker-'));
  const text = source();
  const helper = text.slice(text.indexOf('  const bounded ='), text.indexOf('  function graph('));
  const cleanup = text.slice(text.indexOf('      t.after(async () => {'), text.indexOf('      root = fs.mkdtempSync('));
  let after;
  vm.runInNewContext(helper + cleanup, {
    fs, assert, root, transports: [], releases: [], pending: [new Promise(() => {})],
    setTimeout, clearTimeout, t: { after: (fn) => { after = fn; } },
  });
  let error;
  try { await after(); } catch (caught) { error = caught; }
  assert.match(error?.message || '', /Deadline: owned authorization settlement/);
  assert.equal(fs.existsSync(root), false, 'settlement failure must not skip root removal');
});
