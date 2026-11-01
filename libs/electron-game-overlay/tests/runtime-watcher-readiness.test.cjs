const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptsDirectory = path.resolve(__dirname, '../../electron-game-overlay-runtime/scripts');
const helper = path.join(scriptsDirectory, 'watcher-readiness.ps1');
const readyMarker = 'ReShade process watcher armed.';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const fakeInjector = String.raw`
$ErrorActionPreference = 'Stop'
$parentProcess = [Diagnostics.Process]::GetProcessById([int]$env:EGO_WATCHER_PARENT_PID)
[Console]::WriteLine('STARTED')
[Console]::WriteLine('ReShade process watcher armed. pending')
[Console]::Out.Flush()
if ($env:EGO_WATCHER_MODE -eq 'exit') { exit 7 }
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while (-not (Test-Path -LiteralPath $env:EGO_WATCHER_CONTROL)) {
    if ($parentProcess.HasExited -or [DateTime]::UtcNow -gt $deadline) { exit 8 }
    Start-Sleep -Milliseconds 20
}
[Console]::WriteLine('ReShade process watcher armed.')
[Console]::Out.Flush()
while (-not $parentProcess.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 20
}
`;

const observer = String.raw`
$ErrorActionPreference = 'Stop'
. $env:EGO_WATCHER_HELPER
$env:EGO_WATCHER_PARENT_PID = [string]$PID
$child = Start-Process -FilePath $env:EGO_WATCHER_SHELL -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    ('"' + $env:EGO_WATCHER_FAKE + '"')
) -WindowStyle Hidden -PassThru -RedirectStandardOutput $env:EGO_WATCHER_STDOUT -RedirectStandardError $env:EGO_WATCHER_STDERR
$exitCode = 0
try {
    Wait-OverlayNativeWatcherReady -InjectorProcess $child -StdoutPath $env:EGO_WATCHER_STDOUT ` + '`' + String.raw`
        -Deadline ([DateTime]::UtcNow.AddSeconds([double]$env:EGO_WATCHER_TIMEOUT))
    [IO.File]::WriteAllText($env:EGO_WATCHER_HOST, 'host would launch after readiness')
    [Console]::WriteLine('WATCHER_READY_ACCEPTED')
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $exitCode = 23
}
finally {
    $child.Refresh()
    if (-not $child.HasExited) { $child.Kill() }
    $child.WaitForExit()
    $child.Dispose()
}
exit $exitCode
`;

function textOrEmpty(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function until(predicate, description, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await sleep(20);
  }
}

function launchObserver(t, mode, timeoutSeconds) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-watcher-ready-'));
  const fakeFile = path.join(directory, 'fake-injector.ps1');
  const observerFile = path.join(directory, 'observer.ps1');
  const control = path.join(directory, 'allow-ready');
  const stdoutFile = path.join(directory, 'injector.stdout.txt');
  const stderrFile = path.join(directory, 'injector.stderr.txt');
  const hostFile = path.join(directory, 'host-would-launch');
  fs.writeFileSync(fakeFile, fakeInjector, 'utf8');
  fs.writeFileSync(observerFile, observer, 'utf8');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', observerFile,
  ], {
    env: {
      ...process.env,
      EGO_WATCHER_HELPER: helper,
      EGO_WATCHER_SHELL: 'powershell.exe',
      EGO_WATCHER_FAKE: fakeFile,
      EGO_WATCHER_CONTROL: control,
      EGO_WATCHER_STDOUT: stdoutFile,
      EGO_WATCHER_STDERR: stderrFile,
      EGO_WATCHER_HOST: hostFile,
      EGO_WATCHER_MODE: mode,
      EGO_WATCHER_TIMEOUT: String(timeoutSeconds),
    },
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  completion.catch(() => {});
  t.after(async () => {
    fs.writeFileSync(control, 'cleanup allows owned fake child to finish');
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([completion, sleep(1000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.race([completion, sleep(2000)]);
    const resolvedDirectory = path.resolve(directory);
    assert.equal(path.dirname(resolvedDirectory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolvedDirectory).startsWith('ego-watcher-ready-'));
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  });
  return { child, control, stdoutFile, hostFile, completion };
}

test('native watcher readiness blocks host launch until the exact armed line arrives', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async (t) => {
  const f = launchObserver(t, 'delayed', 8);
  await until(() => textOrEmpty(f.stdoutFile).includes('STARTED'), 'fake injector startup');
  await sleep(200);
  assert.equal(fs.existsSync(f.hostFile), false, 'Spawn, STARTED and a marker prefix must not count as readiness');
  fs.writeFileSync(f.control, 'publish the exact armed marker now');
  const result = await f.completion;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /WATCHER_READY_ACCEPTED/);
  assert.ok(textOrEmpty(f.stdoutFile).split(/\r?\n/).includes(readyMarker));
  assert.equal(textOrEmpty(f.hostFile), 'host would launch after readiness');
});

test('native watcher readiness rejects an injector that exits before becoming armed', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async (t) => {
  const f = launchObserver(t, 'exit', 5);
  const result = await f.completion;
  assert.equal(result.code, 23);
  assert.match(result.stderr, /exited before.*watcher.*ready/i);
  assert.equal(fs.existsSync(f.hostFile), false);
});

test('native watcher readiness times out without launching the future target', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async (t) => {
  const f = launchObserver(t, 'timeout', 1);
  const result = await f.completion;
  assert.equal(result.code, 23);
  assert.match(result.stderr, /timed out.*readiness marker/i);
  assert.equal(fs.existsSync(f.hostFile), false);
});

test('future-target runners await watcher readiness before launching their target', () => {
  for (const [file, targetLaunch] of [
    ['run-injected-electron-scene.ps1', 'Start-Process -FilePath $LaunchUri'],
    ['run-client-sdk-session-deactivation-gate.ps1', '$HostProcess = Start-Process'],
  ]) {
    const source = fs.readFileSync(path.join(scriptsDirectory, file), 'utf8');
    const wait = source.search(/^\s*Wait-OverlayNativeWatcherReady\b/m);
    const launch = source.indexOf(targetLaunch);
    assert.ok(wait >= 0 && launch > wait, `${file} must await its native child before target launch`);
    assert.ok(source.includes('watcher-readiness.ps1'));
  }
  for (const [file, priorProof, targetLaunch] of [
    ['test-cases/gun-frog-client-sdk.ps1', 'RESHADE_CLIENT_INJECTOR_STARTED', 'Start-Process -FilePath $LaunchUri'],
    ['run-client-sdk-multi-swapchain-gate.ps1', 'RESHADE_CLIENT_INJECTOR_STARTED', '$HostProcess = Start-Process'],
    ['run-client-sdk-target-surface-drain-gate.ps1', 'RESHADE_CLIENT_INJECTOR_STARTED', '$HostProcess = Start-Process'],
    ['run-client-sdk-reinjection-gate.ps1', 'RESHADE_CLIENT_INJECTOR_STARTED', '$script:CurrentHostProcess = Start-Process'],
    ['run-client-sdk-gun-frog-official-reshade-coexistence-gate.ps1', 'STEAM_GAME_AUTO_ATTACH_ARMING', 'Start-Process -FilePath $LaunchUri'],
    ['run-client-sdk-existing-reshade-upgrade-gate.ps1', 'STEAM_GAME_AUTO_ATTACH_ARMING', '$HostProcess = Start-Process'],
  ]) {
    const source = fs.readFileSync(path.join(scriptsDirectory, file), 'utf8');
    const started = source.indexOf(priorProof);
    const ready = source.indexOf('RESHADE_CLIENT_INJECTOR_WATCHER_READY');
    const launch = source.indexOf(targetLaunch);
    assert.ok(started >= 0 && ready > started && launch > ready,
      `${file} must retain startup proof and await watcher readiness before target launch`);
  }
});
