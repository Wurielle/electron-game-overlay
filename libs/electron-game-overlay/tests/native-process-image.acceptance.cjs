// Standalone Windows acceptance, intentionally outside the *.test.cjs SDK suite.
// Run AFTER the SDK suite so its first actual OS query is not warmed here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const worker = process.argv[2] === '--native-worker';
const evidencePath = worker ? process.argv[3] : path.resolve('test-results/native-process-image.json');
const report = {
  schemaVersion: 1, kind: 'electron-game-overlay-native-process-image-acceptance',
  platform: process.platform, architecture: process.arch, budgetMs: 2000,
  status: 'setup-not-completed', setupStage: 'platform', nativeExecuted: false,
  firstLabel: 'first-harness-call-not-OS-cold', selfQueries: [], checks: [], passed: false,
};
function persist() {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
}
function stage(name) { report.setupStage = name; persist(); }
persist();
if (process.platform !== 'win32') {
  console.error('REFUSED: native process-image acceptance requires actual Windows.');
  process.exit(1);
}
// This override selects a compiled test artifact, never production authority.
const manager = process.env.EGO_NATIVE_MANAGER_PATH;
stage('manager');
let managerExists = false;
try { managerExists = !!manager && path.win32.isAbsolute(manager) && fs.statSync(manager).isFile(); } catch {}
if (!managerExists) {
  console.error('REFUSED: EGO_NATIVE_MANAGER_PATH must name an absolute native test executable.');
  process.exit(1);
}
if (!worker) {
  let sandbox;
  try {
    stage('sandbox');
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ego native image 日本語 '));
    const node = path.join(sandbox, 'node with spaces é.exe');
    stage('copy');
    fs.copyFileSync(process.execPath, node);
    stage('worker');
    const result = cp.spawnSync(node, [__filename, '--native-worker', evidencePath], {
      cwd: sandbox, shell: false, windowsHide: true, stdio: 'inherit',
      timeout: 120000, killSignal: 'SIGKILL',
    });
    const completed = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    if (result.error || result.signal || result.status !== 0 || completed.status !== 'assertions-completed') process.exitCode = 1;
  } catch {
    console.error('FAIL: native acceptance setup did not complete.');
    process.exitCode = 1;
  } finally {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
} else {
  stage('fixtures');
  const failures = [];
  const game = path.join(process.cwd(), 'game with spaces 日本語');
  fs.mkdirSync(game);
  for (const name of ['game.exe', 'dxgi.dll', 'ReShade.ini', 'preset.ini', 'ReShade.log']) {
    fs.writeFileSync(path.join(game, name), `foreign fixture ${name}\r\n`);
  }
  fs.mkdirSync(path.join(game, 'reshade-shaders'));
  fs.writeFileSync(path.join(game, 'reshade-shaders', 'foreign.fx'), 'foreign effect');
  fs.mkdirSync(path.join(game, 'reshade-addons'));
  fs.writeFileSync(path.join(game, 'reshade-addons', 'foreign.addon64'), 'foreign addon');
  function fingerprint(directory) {
    const hash = createHash('sha256');
    function walk(base) {
      for (const name of fs.readdirSync(base).sort()) {
        const file = path.join(base, name), stat = fs.lstatSync(file);
        hash.update(JSON.stringify([path.relative(directory, file), stat.mode, stat.size, stat.mtimeMs]));
        if (stat.isDirectory()) walk(file);
        else hash.update(fs.readFileSync(file));
      }
    }
    walk(directory);
    return hash.digest('hex');
  }
  const originalCwd = process.cwd();
  const before = fingerprint(originalCwd);
  function check(name, action) {
    try {
      action();
      report.checks.push({ name, passed: true });
    } catch {
      // Do not persist native output, executable paths, environment, or assertion diffs.
      failures.push(name);
      report.checks.push({ name, passed: false });
    }
  }
  function query(args) {
    const start = performance.now();
    const result = cp.spawnSync(manager, args, {
      cwd: originalCwd, shell: false, windowsHide: true, encoding: null,
      timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
    });
    if (Number.isInteger(result.status) && !result.error && !result.signal) report.nativeExecuted = true;
    return { result, elapsedMs: performance.now() - start };
  }
  function bounded(call) {
    assert.equal(call.result.error, undefined);
    assert.equal(call.result.signal, null);
    assert.ok(call.elapsedMs < 2000, 'unchanged per-call budget');
  }
  function success(call, pid, expectedPath) {
    bounded(call);
    assert.equal(call.result.status, 0);
    assert.equal(call.result.stderr.length, 0);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(call.result.stdout);
    assert.match(text, /^\{[^\r\n]*\}\r?\n$/);
    const value = JSON.parse(text);
    assert.deepEqual(Object.keys(value).sort(), ['executablePath', 'kind', 'pid', 'schemaVersion']);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, 'electron-game-overlay-process-image');
    assert.equal(value.pid, pid);
    assert.equal(value.executablePath, expectedPath);
    assert.ok(path.win32.isAbsolute(value.executablePath));
  }
  function rejected(args, expectedExit = 2) {
    const call = query(args);
    bounded(call);
    assert.equal(call.result.status, expectedExit);
    const stdout = new TextDecoder('utf-8', { fatal: true }).decode(call.result.stdout);
    assert.match(stdout, /^\{[^\r\n]*\}\r?\n$/);
    const value = JSON.parse(stdout);
    assert.deepEqual(Object.keys(value).sort(), ['code', 'kind', 'message', 'operation', 'schemaVersion', 'status', 'windowsError']);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, 'electron-game-overlay-reshade-addon-manager-result');
    assert.equal(value.operation, 'query-process-image');
    assert.equal(value.status, 'error');
    assert.equal(typeof value.code, 'string');
    assert.ok(value.code.length > 0);
    assert.equal(typeof value.message, 'string');
    assert.ok(value.message.length > 0);
    if (expectedExit === 2) assert.equal(value.windowsError, null);
    else assert.ok(Number.isInteger(value.windowsError) && value.windowsError > 0);
  }
  stage('assertions');
  let completed = false;
  try {
    check('self-executable-fixture-has-spaces-and-non-ASCII', () => {
      assert.match(process.execPath, / /);
      assert.match(process.execPath, /[^\x00-\x7f]/);
    });
    // Six distinct measurements, not retries: every failure remains a gate failure.
    for (let index = 0; index < 6; index++) {
      const call = query(['--query-process-image', String(process.pid)]);
      const sample = { label: index ? `repeat-${index}` : report.firstLabel,
        elapsedMs: call.elapsedMs, passed: false };
      report.selfQueries.push(sample);
      check(index ? `self-repeat-${index}` : 'first-call-exact-self-path', () => {
        success(call, process.pid, process.execPath);
        sample.passed = true;
      });
    }
    const invalid = ['', '0', '-1', '+1', '01', '1.0', '1e2', ' 1', '1 ', 'abc',
      '4294967296', '18446744073709551616'];
    check('missing-pid', () => rejected(['--query-process-image']));
    invalid.forEach((pid, index) => check(`invalid-pid-${index}`, () => rejected(['--query-process-image', pid])));
    check('extra-argument', () => rejected(['--query-process-image', String(process.pid), 'extra']));
    function absent(pid) {
      try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
    }
    if (absent(2147483647)) {
      check('nonexistent-target-fails-closed', () => rejected(['--query-process-image', '2147483647'], 5));
    } else report.checks.push({ name: 'nonexistent-target', skipped: 'OS did not prove absence' });
    const exited = cp.spawnSync(process.execPath, ['-e', ''], {
      cwd: originalCwd, shell: false, windowsHide: true, timeout: 2000, killSignal: 'SIGKILL',
    });
    check('exited-fixture-terminated', () => {
      assert.equal(exited.error, undefined);
      assert.equal(exited.status, 0);
    });
    if (exited.pid && absent(exited.pid)) {
      check('exited-target-fails-closed', () => rejected(['--query-process-image', String(exited.pid)], 5));
    } else report.checks.push({ name: 'exited-target', skipped: 'OS did not prove absence or PID reused' });
    completed = true;
  } finally {
    check('game-and-CWD-tree-unchanged', () => assert.equal(fingerprint(originalCwd), before));
    check('CWD-unchanged', () => assert.equal(process.cwd(), originalCwd));
    report.passed = completed && failures.length === 0;
    if (completed) { report.status = 'assertions-completed'; persist(); }
    console.log(report.passed ? 'PASS: native process-image acceptance' : `FAIL: ${failures.join(', ')}`);
    if (!report.passed) process.exitCode = 1;
  }
}
