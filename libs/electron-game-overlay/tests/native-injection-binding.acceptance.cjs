// Standalone acceptance: never included in the portable *.test.cjs suite.
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const reportIndex = argv.indexOf('--report');
const evidencePath = path.resolve(reportIndex >= 0 && argv[reportIndex + 1]
  ? argv[reportIndex + 1] : 'test-results/native-injection-binding.json');
const report = {
  schemaVersion: 1, kind: 'electron-game-overlay-native-injection-binding-acceptance',
  platform: process.platform, architecture: process.arch, nativeExecuted: false,
  status: 'setup-not-completed', stage: 'initialization', passed: false,
  legacyFixtureVerified: false, sameHandlePlacementVerified: false,
  checks: [], invocations: [], cleanupErrors: [],
};
function persist() {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
}
persist();

// Cleanup and failure evidence are installed before optional imports or builds.
const children = new Set();
const handles = new Set();
let root, native, cleanupPromise, activeAction;
let interrupted = false;
const cancellation = new AbortController();
function requireActive() { if (interrupted) throw Error('interrupted'); }
const budget = 15000;
function deadline(promise, ms, label, cancellable = true) {
  let timer, onAbort;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}-timeout`)), ms);
    if (cancellable) {
      onAbort = () => reject(Error('interrupted'));
      if (interrupted) onAbort();
      else cancellation.signal.addEventListener('abort', onAbort, { once: true });
    }
  })]).finally(() => {
    clearTimeout(timer);
    if (onAbort) cancellation.signal.removeEventListener('abort', onAbort);
  });
}
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
}
function cleanup() {
  return cleanupPromise ??= (async () => {
    // Cancel waits before sweeping; late continuations must pass requireActive.
    if (activeAction) {
      try { await deadline(activeAction, 1000, 'active-action-settle', false); }
      catch { /* The original action error is recorded by its catch, not cleanup. */ }
    }
    for (const child of children) {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin?.end();
          try { await deadline(exited(child), 1000, 'normal-child-exit', false); }
          catch { child.kill(); await deadline(exited(child), 5000, 'killed-child-exit', false); }
        }
      } catch { report.cleanupErrors.push('owned-child-exit'); }
    }
    for (const handle of handles) {
      try { if (!native.close(handle)) throw Error('close'); }
      catch { report.cleanupErrors.push('retained-process-handle'); }
    }
    if (root && report.cleanupErrors.length === 0) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
      catch { report.cleanupErrors.push('private-root-removal'); }
    }
    report.cleanupCompleted = report.cleanupErrors.length === 0;
    if (interrupted) { report.passed = false; report.status = 'interrupted'; }
    if (!report.cleanupCompleted) { report.passed = false; process.exitCode = 1; }
    persist();
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true; report.passed = false; report.status = 'interrupted'; process.exitCode = 1;
  cancellation.abort();
  void cleanup();
});
function stage(value) { if (interrupted) throw Error('interrupted'); report.stage = value; persist(); }

function canonical(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n;
}
function records(text, prefix) {
  return text.split(/\r?\n/).filter(line => line.startsWith(`${prefix} `))
    .map(line => JSON.parse(line.slice(prefix.length + 1)));
}
function parseOptions(args) {
  const result = {};
  const allowed = new Set(['--injector64', '--injector32', '--vcvarsall', '--report']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.has(key) || result[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--'))
      throw Error('invalid-acceptance-options');
    result[key] = args[i + 1];
  }
  for (const key of ['--injector64', '--injector32', '--vcvarsall']) {
    if (!result[key] || !path.win32.isAbsolute(result[key]) || /[\r\n"%]/.test(result[key]))
      throw Error(`required-absolute-path:${key}`);
  }
  return result;
}
function portableChecks() {
  const assert = require('node:assert/strict');
  for (const value of ['1', '9007199254740993', '18446744073709551615']) assert.equal(canonical(value), true);
  for (const value of ['', '0', '01', '+1', '-1', ' 1', '1 ', '1.0', '1e2', '١', '18446744073709551616', '1'.repeat(21), 1, null])
    assert.equal(canonical(value), false);
  const d = { schemaVersion: 1, stage: 'target-preflight', code: 'target-process-instance-mismatch',
    pid: 42, targetExecutablePath: 'C:\\owned\\target.exe', injectionStarted: false, windowsErrorCode: 1306 };
  assert.deepEqual(records(`noise\nELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ${JSON.stringify(d)}\r\n`,
    'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC'), [d]);
  assert.throws(() => records('ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC {', 'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC'));
  const paths = ['--injector64', 'C:\\fresh\\inject64.exe', '--injector32', 'C:\\fresh\\inject32.exe', '--vcvarsall', 'C:\\VS\\vcvarsall.bat'];
  assert.equal(parseOptions(paths)['--injector32'], paths[3]);
  for (const args of [[], [...paths, '--unknown', 'x'], [...paths, '--injector64', 'C:\\other.exe'], paths.slice(0, -1)])
    assert.throws(() => parseOptions(args));
  report.portableParsersVerified = true;
}
async function main() {
  portableChecks();
  if (argv.length === 1 && argv[0] === '--self-test') {
    report.status = 'portable-parsers-passed'; report.stage = 'portable-only';
    report.passed = true; persist(); return;
  }
  if (process.platform !== 'win32') {
    report.status = 'platform-refused';
    throw Error('actual-Windows-required; nativeExecuted=false');
  }
  stage('options');
  const options = parseOptions(argv);
  const assert = require('node:assert/strict');
  const cp = require('node:child_process');
  const os = require('node:os');
  const { createHash } = require('node:crypto');
  const koffi = require('koffi');
  const kernel = koffi.load('kernel32.dll');
  native = {
    open: kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    times: kernel.func('int __stdcall GetProcessTimes(void *process, void *created, void *exited, void *kernel, void *user)'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
    last: kernel.func('uint32_t __stdcall GetLastError()'),
  };
  report.runnerContext = { username: os.userInfo().username, pid: process.pid,
    token: 'inherited unchanged; integrity not measured', securityAdjustments: false };
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const key of ['--injector64', '--injector32', '--vcvarsall']) assert.ok(fs.statSync(options[key]).isFile());
  report.injectorHashes = { x64: hash(options['--injector64']), x86: hash(options['--injector32']) };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego binding owned 日本語 '));
  // The producer uses MAX_PATH for its payload location.
  assert.ok(root.length < 150, 'private-root-too-long');
  const source = path.resolve(__dirname, '../../electron-game-overlay-runtime/NativeRuntime/tests');
  function spawn(file, args, extra = {}) {
    if (interrupted) throw Error('interrupted');
    const child = cp.spawn(file, args, { cwd: root, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], ...extra });
    children.add(child); return child;
  }
  async function run(file, args, extra = {}, isNative = false) {
    const child = spawn(file, args, extra);
    if (isNative) child.once('spawn', () => { report.nativeExecuted = true; persist(); });
    let stdout = '', stderr = '', spawnError;
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 262144) child.kill(); });
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 262144) child.kill(); });
    child.once('error', error => { spawnError = error; });
    child.stdin.end();
    try { await deadline(exited(child), budget, 'command'); }
    catch (error) {
      try { child.kill(); await deadline(exited(child), 5000, 'command-stop', false); }
      catch { report.cleanupErrors.push('command-stop'); }
      throw error;
    }
    requireActive();
    assert.equal(spawnError, undefined, 'executable-spawn-failed');
    assert.equal(child.signalCode, null, 'executable-signalled');
    assert.ok(stdout.length <= 262144 && stderr.length <= 262144, 'output-limit');
    return { code: child.exitCode, stdout, stderr };
  }
  async function compile(arch) {
    stage(`compile-${arch}`);
    const envFile = path.join(root, `environment-${arch}.cmd`);
    fs.writeFileSync(envFile, `@echo off\r\ncall "${options['--vcvarsall']}" ${arch === 'x64' ? 'x64' : 'x64_x86'} >nul\r\nif errorlevel 1 exit /b 1\r\nset\r\n`);
    const result = await run(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', `""${envFile}""`], { windowsVerbatimArguments: true });
    assert.equal(result.code, 0, 'MSVC-environment-setup');
    const env = { ...process.env };
    for (const line of result.stdout.split(/\r?\n/)) {
      const split = line.indexOf('='); if (split > 0) {
        const name = line.slice(0, split);
        for (const key of Object.keys(env)) if (key.toLowerCase() === name.toLowerCase()) delete env[key];
        env[name] = line.slice(split + 1);
      }
    }
    const search = Object.keys(env).find(key => key.toLowerCase() === 'path');
    const cl = env[search].split(';').map(dir => path.join(dir, 'cl.exe')).find(file => fs.existsSync(file));
    assert.ok(cl, 'MSVC-cl-not-found');
    const dir = path.join(root, `compiled-${arch}`); fs.mkdirSync(dir);
    const target = path.join(dir, 'owned-target.exe');
    const payload = path.join(dir, 'owned-payload.dll');
    for (const [input, output, dll] of [['binding-target.cpp', target, false], ['binding-payload.cpp', payload, true]]) {
      const built = await run(cl, ['/nologo', '/W4', '/WX', '/MT', ...(dll ? ['/LD'] : []),
        path.join(source, input), `/Fe${output}`, `/Fo${path.join(dir, `${input}.obj`)}`,
        '/link', '/INCREMENTAL:NO'], { cwd: dir, env });
      assert.equal(built.code, 0, `owned-fixture-compile:${input}`);
      assert.ok(fs.statSync(output).isFile());
    }
    return { target, payload };
  }
  function time(handle) {
    const created = Buffer.alloc(8);
    const ok = native.times(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8));
    const error = ok ? 0 : native.last();
    assert.ok(ok, `GetProcessTimes:${error}`);
    const value = created.readBigUInt64LE().toString();
    assert.ok(canonical(value)); assert.ok(BigInt(value) > 2n ** 53n, 'actual-FILETIME-above-2^53');
    return value;
  }
  async function target(fixture, label) {
    stage(`ready-${label}`);
    const marker = path.join(root, `${label}.marker`);
    const child = spawn(fixture.target, [], { env: { ...process.env, EGO_BINDING_FIXTURE_MARKER: marker } });
    const ready = new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', data => {
        output += data;
        if (output.length > 1024) reject(Error('target-output-limit'));
        const match = /^READY ([0-9]+) ([0-9]+)\r?\n$/.exec(output);
        if (match) resolve(match);
      });
      child.once('error', reject); child.once('exit', () => reject(Error('target-exited-before-ready')));
    });
    const match = await deadline(ready, 5000, 'target-ready');
    requireActive();
    assert.equal(Number(match[1]), child.pid);
    const handle = native.open(0x1000, 0, child.pid);
    const error = handle ? 0 : native.last();
    assert.ok(handle, `owned-OpenProcess:${error}`); handles.add(handle);
    const actual = time(handle); assert.equal(actual, match[2], 'child-and-parent-actual-FILETIME');
    return { child, handle, actual, marker, executable: fixture.target };
  }
  async function invoke(arch, fixture, owned, label, extra, omitPid = false) {
    stage(label);
    assert.equal(time(owned.handle), owned.actual, 'same-retained-reference-handle');
    assert.equal(owned.child.exitCode, null); assert.equal(owned.child.signalCode, null);
    const dir = path.join(root, label); fs.mkdirSync(dir);
    const injector = path.join(dir, 'inject.exe');
    fs.copyFileSync(options[arch === 'x64' ? '--injector64' : '--injector32'], injector);
    assert.equal(hash(injector), report.injectorHashes[arch], 'injector-copy-must-match-input');
    const payload = path.join(dir, arch === 'x64' ? 'ReShade64.dll' : 'ReShade32.dll');
    fs.copyFileSync(fixture.payload, payload);
    const before = hash(payload);
    const base = omitPid ? [owned.executable] : [owned.executable, '--pid', String(owned.child.pid)];
    const args = [...base, ...(extra ?? [])];
    const call = await run(injector, args, {}, true);
    requireActive();
    report.nativeExecuted = true;
    report.invocations.push({ label, arch, code: call.code,
      expectedCreationTime100ns: extra?.[1] ?? null,
      actualCreationTime100ns: owned.actual, markerPresent: fs.existsSync(owned.marker) });
    assert.equal(hash(payload), before, 'owned-payload-content-unchanged');
    persist(); return call;
  }
  function loaded(call, owned) {
    assert.equal(call.code, 0, 'owned-payload-load-success-required');
    assert.equal(records(call.stdout, 'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC').length, 0);
    const result = records(call.stdout, 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { schemaVersion: 1, pid: owned.child.pid,
      targetExecutablePath: owned.executable, runtimeMode: 'injected-runtime' });
    const marker = fs.readFileSync(owned.marker);
    assert.equal(marker.length, 4); assert.equal(marker.readUInt32LE(), owned.child.pid);
  }
  async function check(name, action) {
    try { await action(); report.checks.push({ name, passed: true }); }
    catch (error) { report.checks.push({ name, passed: false, assertion: error.message.split('\n')[0].slice(0, 180) }); }
    persist();
  }
  // Compile both architectures before counting any production behavior as RED.
  const fixtures = { x64: await compile('x64'), x86: await compile('x86') };
  // Both unchanged legacy invocations must load the marker before bound tests.
  for (const arch of ['x64', 'x86']) {
    const owned = await target(fixtures[arch], `${arch}-legacy`);
    loaded(await invoke(arch, fixtures[arch], owned, `${arch}-legacy-call`, null), owned);
  }
  report.legacyFixtureVerified = true; persist();
  // Future selection uses only the inert owned payload, not a real ReShade
  // rendezvous. This tests filtering before injection independently of an
  // unrelated application's exclusive future-watcher ownership.
  for (const arch of ['x64', 'x86']) {
    await check(`${arch}-future-exact-path-baseline-and-early-filter`, async () => {
      const fixture = fixtures[arch];
      const baseline = await target(fixture, `${arch}-future-baseline`);
      const directory = path.join(root, `${arch}-future-injector`); fs.mkdirSync(directory);
      const injector = path.join(directory, 'inject.exe');
      fs.copyFileSync(options[arch === 'x64' ? '--injector64' : '--injector32'], injector);
      fs.copyFileSync(fixture.payload, path.join(directory, arch === 'x64' ? 'ReShade64.dll' : 'ReShade32.dll'));
      const watcher = spawn(injector, [fixture.target]);
      let stdout = '', stderr = '';
      watcher.stdout.on('data', chunk => { stdout += chunk; });
      watcher.stderr.on('data', chunk => { stderr += chunk; });
      await deadline((async () => {
        while (!stdout.includes('ReShade process watcher armed.')) {
          assert.equal(watcher.exitCode, null, 'watcher remains alive before readiness');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      })(), 5000, 'future-watcher-ready');
      const wrongDirectory = path.join(root, `${arch}-denied-path`); fs.mkdirSync(wrongDirectory);
      const wrongPath = path.join(wrongDirectory, path.basename(fixture.target));
      fs.copyFileSync(fixture.target, wrongPath);
      const wrong = await target({ ...fixture, target: wrongPath }, `${arch}-future-wrong-path`);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(fs.existsSync(baseline.marker), false, 'baseline process must never be injected');
      assert.equal(fs.existsSync(wrong.marker), false, 'same basename at a different path must never be injected');
      assert.equal(watcher.exitCode, null, 'watcher remains armed after a nonmatching creation');
      const selected = await target(fixture, `${arch}-future-selected`);
      await deadline(exited(watcher), budget, 'future-selected-injection');
      loaded({ code: watcher.exitCode, stdout, stderr }, selected);
      assert.equal(fs.existsSync(baseline.marker), false);
      assert.equal(fs.existsSync(wrong.marker), false);
      report.nativeExecuted = true;
    });
  }
  for (const arch of ['x64', 'x86']) {
    const fixture = fixtures[arch];
    const a = await target(fixture, `${arch}-A`);
    await new Promise(resolve => setTimeout(resolve, 30));
    const b = await target(fixture, `${arch}-B`);
    assert.notEqual(a.actual, b.actual, 'two-owned-actual-times-must-differ');
    await check(`${arch}-canonical-matching-load`, async () => {
      const call = await invoke(arch, fixture, a, `${arch}-matching`, ['--expected-creation-time-100ns', a.actual]);
      if (call.code === 87 && /usage:/.test(call.stdout) && /ReShade injection not started\./.test(call.stdout) &&
          !fs.existsSync(a.marker) && records(call.stdout, 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT').length === 0)
        (report.missingCliCases ??= []).push(`${arch}-matching`);
      loaded(call, a);
    });
    await check(`${arch}-different-owned-instance-mismatch`, async () => {
      const call = await invoke(arch, fixture, b, `${arch}-mismatch`, ['--expected-creation-time-100ns', a.actual]);
      assert.equal(fs.existsSync(b.marker), false, 'mismatch-must-not-load');
      if (call.code === 87 && /usage:/.test(call.stdout) && /ReShade injection not started\./.test(call.stdout) &&
          records(call.stdout, 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT').length === 0)
        (report.missingCliCases ??= []).push(`${arch}-mismatch`);
      assert.equal(call.code, 1306, 'dedicated-mismatch-exit-required');
      assert.deepEqual(records(call.stdout, 'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC'), [{
        schemaVersion: 1, stage: 'target-preflight', code: 'target-process-instance-mismatch',
        pid: b.child.pid, targetExecutablePath: b.executable, injectionStarted: false, windowsErrorCode: 1306,
      }]);
      assert.equal(records(call.stdout, 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT').length, 0);
    });
    const malformed = ['', '0', '01', '-1', '+1', ' 1', '1 ', '1.0', '1e2', '١',
      '18446744073709551616', '1'.repeat(21)];
    const optionsCases = malformed.map(value => ['--expected-creation-time-100ns', value]);
    optionsCases.push(['--expected-creation-time-100ns'],
      ['--expected-creation-time-100ns', b.actual, '--expected-creation-time-100ns', b.actual],
      ['--expected-creation-time-100ns', b.actual, 'trailing']);
    for (let i = 0; i < optionsCases.length; i++) await check(`${arch}-malformed-${i}`, async () => {
      const call = await invoke(arch, fixture, b, `${arch}-malformed-call-${i}`, optionsCases[i]);
      assert.equal(call.code, 87); assert.match(call.stdout, /ReShade injection not started\./);
      assert.equal(fs.existsSync(b.marker), false);
      assert.equal(records(call.stdout, 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT').length, 0);
    });
    await check(`${arch}-binding-without-exact-pid`, async () => {
      const call = await invoke(arch, fixture, b, `${arch}-without-pid`,
        ['--expected-creation-time-100ns', b.actual], true);
      assert.equal(call.code, 87); assert.match(call.stdout, /ReShade injection not started\./);
      assert.equal(fs.existsSync(b.marker), false);
      assert.equal(records(call.stdout, 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT').length, 0);
    });
  }
  report.stage = 'assertions-completed';
  report.passed = !interrupted && report.checks.every(check => check.passed);
  const missingCli = report.legacyFixtureVerified && report.missingCliCases?.length === 4 &&
    report.checks.filter(check => !check.passed).every(check =>
      /canonical-matching-load|different-owned-instance-mismatch|binding-without-exact-pid/.test(check.name));
  report.status = interrupted ? 'interrupted' : report.passed ? 'passed' : missingCli ? 'missing-cli-red' : 'behavior-failed';
  if (!report.passed) process.exitCode = 1;
}
activeAction = main().catch(error => {
  report.passed = false;
  report.status = interrupted ? 'interrupted' : report.stage === 'assertions-completed' ? report.status : 'setup-failed';
  if (process.platform !== 'win32' && argv[0] !== '--self-test') report.status = 'platform-refused';
  report.error = error.message.split('\n')[0].slice(0, 180);
  process.exitCode = 1;
});
void activeAction.finally(cleanup);
