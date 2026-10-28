// Investigation only: no native loading, injection, claims, or product timeout changes.
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { win32, dirname } = require('node:path');
const fs = require('node:fs');

function parsePhases(text, self) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const result = { engineReady: lines[0] === 'ENGINE_READY', queryMs: null, imageMatchesSelf: null, protocolError: false };
  if (lines.length === 1 && result.engineReady) return result;
  const match = /^QUERY_MS=(\d+(?:\.\d+)?)$/.exec(lines[1] || '');
  const encoded = /^IMAGE_BASE64=([A-Za-z0-9+/]+={0,2})$/.exec(lines[2] || '');
  result.protocolError = !result.engineReady || lines.length !== 3 || !match || !encoded;
  if (!result.protocolError) {
    const image = Buffer.from(encoded[1], 'base64');
    result.protocolError = image.toString('base64') !== encoded[1] || !Number.isFinite(Number(match[1]));
    if (!result.protocolError) {
      result.queryMs = Number(match[1]);
      result.imageMatchesSelf = image.toString('utf8').toLowerCase() === self.toLowerCase();
    }
  }
  return result;
}

function collectAttempt(spawnChild, self, { watchdogMs = 15000, maxBytes = 256 * 1024, killGraceMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    let child, output = '', bytes = 0, watchdog, reap, settled = false, stopping = false;
    const result = { spawnMs: null, engineReadyMs: null, closeMs: null, closeObserved: false, exitCode: null, signal: null, timedOut: false, errorMarker: null, stdoutBytes: 0, stderrBytes: 0 };
    const finish = (closed, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog); clearTimeout(reap);
      Object.assign(result, parsePhases(output, self), { closeObserved: closed, exitCode: code ?? null, signal: ['SIGTERM', 'SIGKILL'].includes(signal) ? signal : signal ? 'other' : null });
      result.elapsedMs = performance.now() - start;
      result.closeMs = closed ? result.elapsedMs : null;
      resolve(result);
    };
    const stop = (marker) => {
      if (settled || stopping) return;
      stopping = true;
      result.errorMarker ||= marker;
      result.timedOut = marker === 'diagnostic-watchdog';
      child.kill('SIGTERM');
      reap = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
        finish(false);
      }, killGraceMs);
    };
    try { child = spawnChild(); } catch { result.errorMarker = 'spawn-error'; finish(false); return; }
    watchdog = setTimeout(() => stop('diagnostic-watchdog'), watchdogMs);
    child.once('spawn', () => { result.spawnMs = performance.now() - start; });
    child.once('error', () => stop('spawn-error'));
    child.once('close', (code, signal) => finish(true, code, signal));
    for (const name of ['stdout', 'stderr']) {
      child[name].on('error', () => stop('stream-error'));
      child[name].on('data', (chunk) => {
        if (settled || result.errorMarker) return;
        const retained = chunk.subarray(0, Math.max(0, maxBytes - bytes));
        result[`${name}Bytes`] += retained.length;
        bytes += retained.length;
        if (name === 'stdout') {
          output += retained.toString('latin1'); // Preserve invalid non-ASCII bytes for protocol rejection.
          if (result.engineReadyMs === null && /^ENGINE_READY\r?\n/.test(output)) result.engineReadyMs = performance.now() - start;
        }
        if (retained.length < chunk.length) stop('output-limit');
      });
    }
  });
}

function buildCommand(query) {
  const ready = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::WriteLine('ENGINE_READY'); [Console]::Out.Flush();";
  if (!query) return ready;
  return ready + `try { $sw=[Diagnostics.Stopwatch]::StartNew(); $image=[Diagnostics.Process]::GetProcessById(${process.pid}).MainModule.FileName; $sw.Stop(); [Console]::WriteLine('QUERY_MS='+$sw.Elapsed.TotalMilliseconds.ToString('R',[Globalization.CultureInfo]::InvariantCulture)); [Console]::WriteLine('IMAGE_BASE64='+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($image))); } catch { [Console]::WriteLine('QUERY_ERROR'); exit 1 }`;
}

async function runDiagnostic(context, { resolveDirectory, queryImage, spawnChild = spawn } = {}) {
  const report = { schemaVersion: 1, context, platform: process.platform, nodeVersion: process.version, diagnosticOnly: true, diagnosticWatchdogMs: 15000, maxCapturedOutputBytesPerAttempt: 256 * 1024, productionTimeoutMsUnchanged: 2000, coldOsClaim: false, firstChildScope: 'First diagnostic child only; host pwsh and OS caches may already be warm', engineReadyMeaning: 'Node receipt of flushed marker after PowerShell prelude, before process lookup; not pure engine initialization', queryPhaseMeaning: 'Stopwatch around GetProcessById and MainModule.FileName only', attempts: [], success: false };
  const start = performance.now();
  let directory;
  try {
    resolveDirectory ||= require('../dist/lib/overlay-broker-windows-os-path.js').resolveOverlayBrokerSystemDirectory;
    directory = await resolveDirectory();
    report.setup = { elapsedMs: performance.now() - start, errorMarker: null };
  } catch { report.setup = { elapsedMs: performance.now() - start, errorMarker: 'canonical-resolver-error' }; return report; }
  for (let trial = 1; trial <= 3; trial++) for (const kind of ['control', 'query']) {
    const result = await collectAttempt(() => spawnChild(win32.join(directory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', buildCommand(kind === 'query')], { cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), process.execPath);
    report.attempts.push({ label: `${kind}-${trial}`, firstWithinDiagnosticProcess: trial === 1 && kind === 'control', ...result });
  }
  const helperStart = performance.now();
  const production = { label: 'production-helper-after-warming', firstWithinDiagnosticProcess: false, imageMatchesSelf: null, errorMarker: null, killed: false, signal: null };
  try {
    queryImage ||= require('../dist/lib/overlay-broker-native-provider.js').resolveOverlayBrokerProcessImage;
    const image = await queryImage(process.pid); // The actual helper retains its original 2000 ms execFile budget.
    production.imageMatchesSelf = image.toLowerCase() === process.execPath.toLowerCase();
  } catch (error) {
    production.errorMarker = 'production-query-error';
    production.killed = error.cause?.killed === true;
    production.signal = ['SIGTERM', 'SIGKILL'].includes(error.cause?.signal) ? error.cause.signal : null;
  }
  production.elapsedMs = performance.now() - helperStart;
  report.attempts.push(production);
  report.success = report.attempts.slice(0, 6).every(a => !a.errorMarker && !a.protocolError && a.closeObserved && a.exitCode === 0 && a.engineReady && (!a.label.startsWith('query') || a.imageMatchesSelf === true)) && production.imageMatchesSelf === true;
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--output', '--context'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid diagnostic arguments');
    options[args[i]] = args[i + 1];
  }
  if (!options['--output'] || !['fresh-runner', 'after-sdk-suite'].includes(options['--context'])) throw new Error('Invalid diagnostic arguments');
  if (process.platform !== 'win32') throw new Error('Windows only; no diagnostic data written');
  const report = await runDiagnostic(options['--context']);
  fs.mkdirSync(dirname(options['--output']), { recursive: true });
  fs.writeFileSync(options['--output'], JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.success ? 0 : 1;
}

module.exports = { parsePhases, collectAttempt, buildCommand, runDiagnostic };
if (require.main === module) main().catch(error => {
  console.error(['Invalid diagnostic arguments', 'Windows only; no diagnostic data written'].includes(error.message) ? error.message : 'Diagnostic failed; details suppressed');
  process.exitCode = 1;
});
