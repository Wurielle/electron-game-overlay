const assert = require('node:assert/strict');
const test = require('node:test');
const { parsePhases, collectAttempt, buildCommand, runDiagnostic } = require('../scripts/diagnose-process-image-probe.cjs');
const { spawn } = require('node:child_process');
const fixture = (code) => () => spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });

test('Linux/Node fixture: collect spawn, split engine marker, query and close without raw output', async () => {
  const code = `process.stdout.write('ENGINE_'); setTimeout(() => { console.log('READY'); console.log('QUERY_MS=4.5'); console.log('IMAGE_BASE64=' + Buffer.from(process.execPath).toString('base64')); console.error('PRIVATE-STDERR'); }, 10);`;
  const result = await collectAttempt(fixture(code), process.execPath);
  assert.equal(result.imageMatchesSelf, true);
  assert.equal(result.queryMs, 4.5);
  assert.equal(result.exitCode, 0);
  assert.equal(result.closeObserved, true);
  assert.equal(result.errorMarker, null);
  assert.ok(result.spawnMs >= 0 && result.engineReadyMs >= result.spawnMs && result.closeMs >= result.engineReadyMs);
  assert.ok(result.stderrBytes > 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-STDERR|IMAGE_BASE64|node\.exe|ENGINE_READY/);
});

test('Linux/Node fixture: timeout retains ready phase and terminates child without retries', async () => {
  const result = await collectAttempt(fixture("console.log('ENGINE_READY'); setInterval(() => {}, 1000)"), process.execPath, { watchdogMs: 1000, killGraceMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.errorMarker, 'diagnostic-watchdog');
  assert.equal(result.engineReady, true);
  assert.equal(result.imageMatchesSelf, null);
  assert.equal(result.closeObserved, true);
  assert.ok(result.closeMs >= 900 && result.closeMs < 5000);
});

test('Linux/Node fixture: combined output is bounded; raw spawn failures are sanitized', async () => {
  const result = await collectAttempt(fixture("process.stderr.write('S'.repeat(9000)); setInterval(() => {}, 1000)"), process.execPath, { maxBytes: 1024, watchdogMs: 1000 });
  assert.equal(result.errorMarker, 'output-limit');
  assert.ok(result.stderrBytes <= 1024);
  const failure = await collectAttempt(() => { throw new Error('PRIVATE-PATH'); }, process.execPath);
  assert.equal(failure.errorMarker, 'spawn-error');
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE-PATH/);
});

test('fixed PowerShell command marks ready before the self-only timed query', () => {
  const control = buildCommand(false);
  const query = buildCommand(true);
  assert.doesNotMatch(control, /GetProcessById|MainModule/);
  assert.ok(query.indexOf('ENGINE_READY') < query.indexOf('GetProcessById'));
  assert.match(query, new RegExp(`GetProcessById\\(${process.pid}\\)`));
  assert.match(query, /Stopwatch|InvariantCulture|ToBase64String/);
});

test('controlled child boundary: ordered trials preserve failures and call production helper last', async () => {
  const calls = [];
  const report = await runDiagnostic('fresh-runner', {
    resolveDirectory: async () => 'C:\\Windows\\System32',
    spawnChild: (exe, args, options) => {
      calls.push('diagnostic');
      assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
      assert.equal(options.shell, false);
      assert.equal(options.cwd, 'C:\\Windows\\System32');
      return fixture("console.log('ENGINE_READY'); process.exitCode=1")();
    },
    queryImage: async (pid) => {
      assert.equal(pid, process.pid);
      calls.push('production');
      throw new Error('PRIVATE-PATH', { cause: { killed: true, signal: 'SIGTERM', stderr: 'PRIVATE-STDERR' } });
    },
  });
  assert.deepEqual(calls, ['diagnostic', 'diagnostic', 'diagnostic', 'diagnostic', 'diagnostic', 'diagnostic', 'production']);
  assert.deepEqual(report.attempts.map(a => a.label), ['control-1', 'query-1', 'control-2', 'query-2', 'control-3', 'query-3', 'production-helper-after-warming']);
  assert.deepEqual(report.attempts.slice(0, 6).map(a => a.firstWithinDiagnosticProcess), [true, false, false, false, false, false]);
  assert.ok(report.attempts.slice(0, 6).every(a => a.exitCode === 1));
  assert.equal(report.diagnosticWatchdogMs, 15000);
  assert.equal(report.productionTimeoutMsUnchanged, 2000);
  assert.equal(report.success, false);
  assert.equal(report.attempts.at(-1).killed, true);
  assert.equal(report.attempts.at(-1).signal, 'SIGTERM');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|System32|powershell\.exe/);
});

test('actual compiled resolver/helper with controlled OS boundaries: canonical path, self PID, unchanged 2s budget, no Electron', async () => {
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const Module = require('node:module');
  const realpath = fs.realpath.native, exec = cp.execFile, load = Module._load;
  let resolutions = 0, productionCalls = 0;
  fs.realpath.native = (anchor, callback) => {
    assert.equal(anchor, '\\\\?\\GLOBALROOT\\SystemRoot\\System32');
    resolutions++;
    callback(null, 'C:\\Windows\\System32');
  };
  cp.execFile = (exe, args, options, callback) => {
    productionCalls++;
    assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(options.timeout, 2000);
    assert.equal(options.cwd, 'C:\\Windows\\System32');
    assert.ok(args.at(-1).includes(`GetProcessById(${process.pid})`));
    callback(null, process.execPath + '\n');
  };
  Module._load = function(name, ...args) {
    assert.notEqual(name, 'electron');
    return load.call(this, name, ...args);
  };
  try {
    const report = await runDiagnostic('after-sdk-suite', {
      spawnChild: (_exe, args) => fixture(args.at(-1).includes('GetProcessById')
        ? "console.log('ENGINE_READY'); console.log('QUERY_MS=1'); console.log('IMAGE_BASE64='+Buffer.from(process.execPath).toString('base64'))"
        : "console.log('ENGINE_READY')")(),
    });
    assert.equal(resolutions, 2);
    assert.equal(productionCalls, 1);
    // Linux self path is deliberately rejected by the real Windows-only helper's path validation.
    assert.equal(report.attempts.at(-1).imageMatchesSelf, process.platform === 'win32' ? true : null);
    assert.equal(report.success, process.platform === 'win32');
  } finally { fs.realpath.native = realpath; cp.execFile = exec; Module._load = load; }
});

test('controlled resolver failure is retained without launching fallback commands', async () => {
  const report = await runDiagnostic('after-sdk-suite', {
    resolveDirectory: async () => { throw new Error('PRIVATE-PATH'); },
    spawnChild: () => assert.fail('must not spawn'),
    queryImage: () => assert.fail('must not query'),
  });
  assert.equal(report.setup.errorMarker, 'canonical-resolver-error');
  assert.equal(report.success, false);
  assert.deepEqual(report.attempts, []);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});

test('CLI rejects unknown flags/context and refuses non-Windows without writing fake evidence', () => {
  const { spawnSync } = require('node:child_process');
  const script = require.resolve('../scripts/diagnose-process-image-probe.cjs');
  for (const args of [['--pid', '1'], ['--output', 'unused.json', '--context', 'other']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid diagnostic arguments/);
  }
  if (process.platform !== 'win32') {
    const output = require('node:path').join(require('node:os').tmpdir(), `ego-refused-probe-${require('node:crypto').randomUUID()}.json`);
    const result = spawnSync(process.execPath, [script, '--output', output, '--context', 'fresh-runner'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Windows only; no diagnostic data written/);
    assert.equal(result.stdout, '');
    assert.equal(require('node:fs').existsSync(output), false);
  }
});

test('controlled boundary: stream errors terminate and are recorded without raw details', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  child.unref = () => {};
  const pending = collectAttempt(() => child, process.execPath, { watchdogMs: 100 });
  child.stdout.emit('error', new Error('PRIVATE-STREAM'));
  const result = await pending;
  assert.equal(result.errorMarker, 'stream-error');
  assert.equal(result.timedOut, false);
  assert.equal(result.closeObserved, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-STREAM/);
});

test('controlled boundary: unresponsive child has bounded forced cleanup and no invented close event', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const kills = [];
  let unreferenced = false;
  child.kill = signal => kills.push(signal);
  child.unref = () => { unreferenced = true; };
  const result = await collectAttempt(() => child, process.execPath, { watchdogMs: 10, killGraceMs: 10 });
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(unreferenced, true);
  assert.equal(child.stdout.destroyed && child.stderr.destroyed, true);
  assert.equal(result.closeObserved, false);
  assert.equal(result.closeMs, null);
  assert.ok(result.elapsedMs >= 10 && result.elapsedMs < 1000);
  assert.equal(result.timedOut, true);
});

test('phase protocol exposes only timings and exact Windows self match', () => {
  const image = 'C:\\Program Files\\Node\\node.exe';
  const encoded = Buffer.from(image).toString('base64');
  assert.deepEqual(parsePhases(`ENGINE_READY\r\nQUERY_MS=12.25\r\nIMAGE_BASE64=${encoded}\r\n`, image.toUpperCase()), {
    engineReady: true, queryMs: 12.25, imageMatchesSelf: true, protocolError: false,
  });
  assert.equal(parsePhases(`ENGINE_READY\nQUERY_MS=0\nIMAGE_BASE64=${encoded}\n`, image + '.other').imageMatchesSelf, false);
  for (const text of ['ENGINE_READY\nQUERY_MS=NaN\nIMAGE_BASE64=%%%\n', `QUERY_MS=1\nIMAGE_BASE64=${encoded}\n`, `ENGINE_READY\nQUERY_MS=1\nIMAGE_BASE64=${encoded}\nextra`]) {
    assert.equal(parsePhases(text, image).protocolError, true);
  }
  assert.deepEqual(parsePhases('ENGINE_READY\n', image), {
    engineReady: true, queryMs: null, imageMatchesSelf: null, protocolError: false,
  });
});
