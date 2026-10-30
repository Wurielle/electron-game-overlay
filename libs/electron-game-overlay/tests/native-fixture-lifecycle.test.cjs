// Native-free: evaluates the exact owned harness lifecycle and target action.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const sourcePath = path.join(__dirname, 'native-injection-binding.acceptance.cjs');
// Normalize only the source-extraction view, never payload bytes or integrity hashes.
const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
function waitForResult(worker, onReady = () => {}) {
  return new Promise((resolve, reject) => {
    let releaseTimer;
    const timer = setTimeout(() => finish(Error('owned worker result timeout')), 5000);
    function finish(error, value) {
      clearTimeout(timer); clearTimeout(releaseTimer);
      worker.off('message', message); worker.off('error', failed); worker.off('exit', exited);
      if (error) reject(error); else resolve(value);
    }
    function failed(error) { finish(error); }
    function exited(code, signal) { finish(Error(`owned worker exit before result: ${code}/${signal}`)); }
    function message(value) {
      try { if (value.ready) releaseTimer = onReady(value); else finish(null, value); }
      catch (error) { finish(error); }
    }
    worker.on('message', message); worker.once('error', failed); worker.once('exit', exited);
  });
}
async function cleanupWorker(worker, root) {
  try {
    if (worker && worker.connected) worker.disconnect();
    if (worker && worker.pid && worker.exitCode === null && worker.signalCode === null) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('owned worker cleanup timeout')), 1000);
        worker.once('close', () => { clearTimeout(timer); resolve(); });
        if (worker.connected) worker.disconnect();
        worker.kill('SIGKILL');
      });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[2] === '--exit-before-result') process.exit(2);
if (process.argv[2] === '--worker') {
  const [mode, signal, root] = process.argv.slice(3);
  const reportPath = path.join(root, 'report.json');
  const privateRoot = path.join(root, 'owned'); fs.mkdirSync(privateRoot);
  let release, rejectHeld, heldReached = false, opened = 0, closed = 0, child;
  const held = new Promise((resolve, reject) => { release = resolve; rejectHeld = reject; });
  const prefix = source.slice(0, source.indexOf('async function main()'));
  const target = source.slice(source.indexOf('  async function target('), source.indexOf('  async function invoke('));
  const run = source.slice(source.indexOf('  async function run('), source.indexOf('  async function compile('));
  const verdict = source.slice(source.indexOf("  report.stage = 'assertions-completed';"), source.indexOf('\n}\nactiveAction = main().catch') >= 0 ? source.indexOf('\n}\nactiveAction = main().catch') : source.indexOf('\n}\nmain().catch'));
  const context = vm.createContext({ require, console, Buffer, setTimeout, clearTimeout, AbortController,
    process: Object.assign(Object.create(process), { argv: [process.execPath, sourcePath, '--report', reportPath] }),
    __dirname, assert, privateRoot,
    controlledOpen: () => { opened++; return {}; }, controlledClose: () => { closed++; return true; },
    held, reached: () => { heldReached = true; process.send({ ready: true }); },
    spawnOwned: () => {
      child = cp.spawn(process.execPath, ['-e', 'console.log(`READY ${process.pid} 9007199254740993`);process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'], { stdio: ['pipe', 'pipe', 'pipe'] });
      return child;
    }
  });
  // No Windows platform substitution, FFI load, injector, or fabricated native evidence.
  vm.runInContext(prefix + `\nroot = privateRoot; native = { open: controlledOpen, close: controlledClose, last: () => 0 };
    function spawn() { if (interrupted) throw Error('interrupted'); const child = spawnOwned(); children.add(child); return child; }
    function time() { return '9007199254740993'; }
    const originalDeadline = deadline;
    deadline = (promise, ms, label, ...rest) => label === 'target-ready'
      ? originalDeadline(Promise.resolve(promise).then(async value => { reached(); await held; return value; }), ms, label, ...rest)
      : originalDeadline(promise, ms, label, ...rest);
    ${target}
    ${run}
    async function controlledAction() {
      if (${JSON.stringify(mode)} === 'readiness') await target({ target: 'controlled-node-only' }, 'controlled');
      else { await run('controlled-node-only', []); reached(); await held; }
      ${verdict}
    }
    globalThis.action = controlledAction().catch(error => {
      report.error = error.message; report.passed = false;
      report.status = interrupted ? 'interrupted' : 'setup-failed'; process.exitCode = 1;
    });
    if (typeof activeAction !== 'undefined') activeAction = action;
    globalThis.finished = action.finally(cleanup);
  `, context);
  const timer = setInterval(() => {}, 100);
  process.on('message', async message => {
    if (message.cancel) {
      assert.equal(message.cancel, signal);
      const listeners = process.listeners(signal);
      assert.equal(listeners.length, 1, 'actual harness cancellation listener registered');
      listeners[0](); // Native-free IPC delivery, never an OS signal claim.
      return;
    }
    if (!message.release) return;
    if (message.reject) rejectHeld(Error('owned-late-rejection')); else release();
    await context.finished;
    await new Promise(resolve => setTimeout(resolve, 30));
    const persistedReport = JSON.parse(fs.readFileSync(reportPath));
    const report = JSON.parse(vm.runInContext('JSON.stringify(report)', context));
    assert.equal(persistedReport.passed, false);
    const result = { report, opened, closed, heldReached, rootRemoved: !fs.existsSync(privateRoot), childExited: !child || child.exitCode !== null || child.signalCode !== null, nativeExecuted: false };
    clearInterval(timer); process.send(result, () => process.disconnect());
  });
} else {
  const { test } = require('node:test');
  test('legacy-positive precondition and CLI missing-contract RED classification remain intact', () => {
    const start = source.indexOf("  report.stage = 'assertions-completed';");
    const end = source.indexOf('\n}\nactiveAction = main().catch');
    const checks = ['x64-canonical-matching-load', 'x64-different-owned-instance-mismatch',
      'x86-canonical-matching-load', 'x86-different-owned-instance-mismatch', 'x64-binding-without-exact-pid']
      .map(name => ({ name, passed: false }));
    for (const [legacy, badFlag, expected] of [[true, false, 'missing-cli-red'], [false, false, 'behavior-failed'], [true, true, 'behavior-failed']]) {
      const report = { checks: badFlag ? [...checks, { name: 'x64-malformed-0', passed: false }] : checks,
        legacyFixtureVerified: legacy, missingCliCases: ['a', 'b', 'c', 'd'] };
      const controlled = { report, interrupted: false, process: {} };
      vm.runInNewContext(source.slice(start, end), controlled);
      assert.equal(report.passed, false); assert.equal(report.status, expected);
      assert.equal(controlled.process.exitCode, 1);
    }
  });
  for (const failure of ['exit', 'error']) test(`IPC ${failure}-before-result rejects and removes private root`, async t => {
    let worker;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-controlled-failure-'));
    t.after(() => cleanupWorker(worker, root));
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    worker = cp.fork(__filename, ['--exit-before-result'], {
      env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      ...(failure === 'error' ? { execPath: path.join(root, 'missing-node') } : {})
    });
    await assert.rejects(waitForResult(worker), failure === 'exit' ? /exit before result: 2/ : /ENOENT/);
    await cleanupWorker(worker, root);
    assert.equal(fs.existsSync(root), false);
    assert.equal(worker.connected, false);
  });
  // IPC invokes the registered cancellation listener; it is not Windows OS signal evidence.
  for (const transport of ['IPC listener dispatch', 'POSIX OS signal'])
  for (const mode of ['final', 'readiness']) for (const signal of ['SIGINT', 'SIGTERM']) for (const reject of [false, true]) {
    test(`${transport}: ${mode} ${signal} late ${reject ? 'reject' : 'success'} cannot escape final sweep`, { skip: transport === 'POSIX OS signal' && process.platform === 'win32' }, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-controlled-lifecycle-'));
      let worker, rootRemovedBeforeRelease = false;
      t.after(() => cleanupWorker(worker, root));
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      worker = cp.fork(__filename, ['--worker', mode, signal, root], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let errors = ''; worker.stderr.on('data', d => { errors += d; });
      const result = await waitForResult(worker, message => {
        if (transport === 'IPC listener dispatch') worker.send({ cancel: signal }, onSend);
        else worker.kill(signal);
        return setTimeout(() => {
          rootRemovedBeforeRelease = !fs.existsSync(path.join(root, 'owned'));
          worker.send({ release: true, reject }, onSend);
        }, 1250);
      });
      function onSend(error) { if (error) worker.emit('error', error); }
      assert.equal(result.heldReached, true);
      assert.equal(rootRemovedBeforeRelease, true, 'cleanup precedes uncooperative action release');
      assert.equal(result.report.nativeExecuted, false);
      assert.equal(result.report.passed, false, 'abort must latch verdict');
      assert.equal(result.report.status, 'interrupted');
      assert.equal(result.opened, 0, 'no late OpenProcess boundary');
      assert.equal(result.closed, 0);
      assert.equal(result.rootRemoved, true, 'root removed before outer rescue');
      assert.equal(result.childExited, true, 'direct owned child settled');
      if (reject) assert.match(result.report.error, /owned-late-rejection|interrupted/);
      await new Promise((resolve, rejectExit) => {
        if (worker.exitCode !== null || worker.signalCode !== null) return resolve();
        const timer = setTimeout(() => rejectExit(Error('owned worker exit timeout')), 1000);
        worker.once('close', () => { clearTimeout(timer); resolve(); });
      });
    });
  }
  test('four Win32 failures capture error after call and before require (source proof only)', () => {
    const cpp = fs.readFileSync(path.join(__dirname, '../../electron-game-overlay-runtime/NativeRuntime/tests/pipe-acl-feasibility.cpp'), 'utf8');
    for (const api of ['Process32FirstW', 'GetSecurityDescriptorDacl', 'GetSecurityDescriptorControl', 'GetAce']) {
      assert.match(cpp, new RegExp(`(?:BOOL )?ok = ${api}\\([^;]+;\\s*(?:DWORD )?error = ok \\? ERROR_SUCCESS : GetLastError\\(\\);\\s*require\\(ok != FALSE, \\"[^\\"]+\\", error\\);`), api);
    }
  });
}
