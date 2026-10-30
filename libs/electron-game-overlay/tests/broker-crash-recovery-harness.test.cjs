const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
function bounded(promise, label, ms = 2000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}
async function until(predicate, label, ms) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const denied = (label) => Object.assign(new Error(`injected ${label}`), { code: 'EACCES' });
async function exercise(t, state, fault) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ego-harness-regression-'));
  state.root = root;
  let runner, exited = false, cleanup, processError;
  const events = state.events = [];
  const runCleanup = () => (cleanup ??= (async () => {
    const errors = [];
    const step = async (fn, label) => {
      try { await bounded(Promise.resolve().then(fn), label); }
      catch (error) { errors.push(error); }
    };
    try {
      if (runner && !exited) {
        // Diagnostic failure must not bypass the independent IPC cleanup path.
        try {
          await step(() => fault === 'emergency-write' ? Promise.reject(denied(fault))
            : fs.writeFile(path.join(root, 'emergency'), 'cleanup'), 'rescue diagnostic');
        } finally {
          await step(async () => {
            await new Promise((resolve, reject) => runner.send({ kind: 'cleanup-owned' }, (error) => error ? reject(error) : resolve()));
            await until(() => events.some((e) => e.kind === 'cleanup-complete'), 'broker exits', 1500);
          }, 'IPC rescue');
        }
      }
    } finally {
      try {
        await step(async () => {
          if (!runner || exited) return;
          runner.kill('SIGKILL');
          await until(() => exited, 'runner exit', 1500);
        }, 'owned runner termination');
      } finally {
        await step(() => fs.rm(root, { recursive: true, force: true }), 'outer root removal');
      }
    }
    if (errors.length) throw new AggregateError(errors, errors.map((e) => e.message).join('; '));
  })());
  t.after(() => runCleanup().catch(() => {}));
  try {
    const audit = path.join(root, 'audit.jsonl');
    const preload = path.join(root, 'preload.cjs');
    const target = path.join(__dirname, 'broker-crash-recovery-hardening.test.cjs');
    const client = require.resolve('../dist/lib/overlay-broker-client.js');
    const source = `
const fs = require('node:fs');
const cp = require('node:child_process');
const Module = require('node:module');
const children = new Set();
const record = value => {
  const event = {...value, at: Date.now()};
  if (process.connected) process.send(event, () => {});
  try { fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify(event) + '\\n'); }
  catch (error) { if (process.connected) process.send({kind:'audit-error',message:error.message}, () => {}); }
};
const mkdtemp = fs.promises.mkdtemp;
fs.promises.mkdtemp = async (...args) => { const root = await mkdtemp(...args); record({kind:'root',root}); return root; };
const fork = cp.fork;
cp.fork = (file, args, options) => {
  const child = fork(file, args, {...options, execArgv: []});
  children.add(child);
  child.on('error', error => record({kind:'child-error',message:error.message}));
  child.once('exit', (code, signal) => { children.delete(child); record({kind:'exit',pid:child.pid,code,signal}); });
  record({kind:'spawn',pid:child.pid});
  return child;
};
process.on('message', async message => {
  if (message.kind !== 'cleanup-owned') return;
  await Promise.all([...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGKILL');
  })));
  record({kind:'cleanup-complete'});
});
process.channel?.unref();
const { OverlayBrokerClient } = require(${JSON.stringify(client)});
const authorize = OverlayBrokerClient.prototype.authorizeTarget;
OverlayBrokerClient.prototype.authorizeTarget = function (...args) {
  authorize.apply(this, args).catch(() => {});
  record({kind:'hung-authorization'});
  return new Promise(() => {});
};
const load = Module._extensions['.cjs'] || Module._extensions['.js'];
Module._extensions['.cjs'] = (mod, file) => {
  if (file !== ${JSON.stringify(target)}) return load(mod, file);
  const source = fs.readFileSync(file, 'utf8').replaceAll('timeout: 30000', 'timeout: ${fault ? 30000 : process.platform === 'win32' ? 3000 : 750}');
  mod._compile(source, file);
};
`;
    if (fault === 'preload-write') throw denied(fault);
    await bounded(fs.writeFile(preload, source), 'preload write');
    const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root,
      EGO_CRASH_MUTATE_FREEZE: '', EGO_CRASH_MUTATE_SETTLEMENT: '' };
    delete env.NODE_TEST_CONTEXT;
    runner = fork(target, [], {
      execArgv: ['--require', preload, '--test', '--test-isolation=none', '--test-name-pattern=published claim survives two abrupt'],
      env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    state.runner = runner;
    let output = '';
    runner.stdout.on('data', (data) => { output += data; });
    runner.stderr.on('data', (data) => { output += data; });
    runner.on('error', (error) => { processError = error; });
    runner.on('message', (event) => events.push(event));
    runner.once('exit', () => { exited = true; });
    if (fault) {
      await until(() => processError || exited || events.some((e) => e.kind === 'hung-authorization'), 'hung milestone', 6000);
      if (processError) throw processError;
      assert.ok(events.some((e) => e.kind === 'hung-authorization'), `setup reached actual hung authorization: ${output}`);
      if (fault === 'audit-read') throw denied(fault);
      if (fault === 'emergency-write') throw new Error('injected assertion before rescue');
      assert.fail('injected assertion');
    }
    await until(() => exited || processError, 'runner exits without rescue', process.platform === 'win32' ? 8000 : 3000);
    if (processError) throw processError;
    const recorded = (await bounded(fs.readFile(audit, 'utf8'), 'audit read')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(recorded.some((e) => e.kind === 'hung-authorization'));
    assert.notEqual(runner.exitCode, 0, output);
    assert.match(output, /test timed out|aborted|Timeout/i);
    assert.equal(recorded.filter((e) => e.kind === 'spawn').length, 1);
    assert.equal(recorded.filter((e) => e.kind === 'root').length, 1);
    assert.deepEqual(recorded.filter((e) => e.kind === 'exit').map((e) => e.pid).sort(), recorded.filter((e) => e.kind === 'spawn').map((e) => e.pid).sort(), 'owned exits before rescue');
    for (const event of recorded.filter((e) => e.kind === 'root')) {
      assert.equal(path.dirname(event.root), root, 'nested fixture root');
      await bounded(assert.rejects(fs.access(event.root), { code: 'ENOENT' }), 'fixture root absent');
    }
    assert.ok(!events.some((e) => e.kind === 'cleanup-complete'), 'no outer rescue used');
    state.beforeRescue = true;
  } finally {
    await runCleanup();
  }
}
async function assertClean(state) {
  await bounded(assert.rejects(fs.access(state.root), { code: 'ENOENT' }), 'outer root absent');
  if (!state.runner) return;
  assert.ok(state.runner.exitCode !== null || state.runner.signalCode !== null, 'retained runner exited');
  assert.deepEqual(state.events.filter((e) => e.kind === 'exit').map((e) => e.pid).sort(), state.events.filter((e) => e.kind === 'spawn').map((e) => e.pid).sort(), 'retained broker exits observed');
}
test('hung authorization exits with owned children and root cleaned', { timeout: 15000 }, async (t) => {
  const state = {};
  await exercise(t, state);
  assert.equal(state.beforeRescue, true);
  await assertClean(state);
});
for (const fault of ['preload-write', 'audit-read', 'emergency-write', 'assertion']) {
  test(`harness cleans owned resources after injected ${fault} failure`, { timeout: 15000 }, async (t) => {
    const state = {};
    await assert.rejects(exercise(t, state, fault), new RegExp(`injected ${fault}`));
    if (fault !== 'preload-write') {
      assert.equal(state.events.filter((e) => e.kind === 'spawn').length, 1, 'not a setup false green');
      assert.ok(state.events.some((e) => e.kind === 'hung-authorization'));
      assert.ok(state.events.some((e) => e.kind === 'cleanup-complete'), 'actual owned exits acknowledged');
    }
    await assertClean(state);
  });
}
