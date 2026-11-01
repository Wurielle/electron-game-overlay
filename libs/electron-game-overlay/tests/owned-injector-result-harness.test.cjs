const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const scripts = path.resolve(__dirname, '../../electron-game-overlay-runtime/scripts');

test('owned injector proof accepts nested progress and rejects mismatched or ambiguous structured identities', {
  skip: process.platform !== 'win32',
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-injector-result-'));
  try {
    const expected = {
      pid: 29532,
      executable: path.join(directory, 'target', 'game.exe'),
      runtime: path.join(directory, 'ReShade64.dll'),
      addon: path.join(directory, 'electron_game_overlay.addon64'),
      base: directory,
    };
    const record = {
      schemaVersion: 1, pid: expected.pid, targetExecutablePath: expected.executable,
      runtimeMode: 'participant-addon', runtimeModulePath: expected.runtime,
      addonModulePath: expected.addon, reshadeBasePath: expected.base,
      addonAbi: 1, memberProtocolVersion: 1,
    };
    const prefix = 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ';
    const nestedProgress = 'Found a matching process with PID 29532! Injecting ReShade ... Found a matching process with PID 29532! Loading Electron Game Overlay participant into existing ReShade ... Succeeded!\r\n';
    assert.equal(nestedProgress.includes('Injecting ReShade ... Succeeded!'), false,
      'the regression fixture must fail the former human-text success match');
    const render = value => prefix + JSON.stringify(value) + '\r\n';
    const cases = [
      { name: 'nested first-host/member progress', accepted: true, text: nestedProgress + render(record) },
      { name: 'case-insensitive exact Windows paths', accepted: true,
        text: render({ ...record, targetExecutablePath: record.targetExecutablePath.toUpperCase(), runtimeModulePath: record.runtimeModulePath.toUpperCase() }) },
      { name: 'human progress alone', accepted: false, text: nestedProgress },
      { name: 'duplicate results', accepted: false, text: render(record) + render(record) },
      { name: 'malformed JSON', accepted: false, text: prefix + '{' },
      { name: 'array envelope', accepted: false, text: render([record]) },
      { name: 'extra schema property', accepted: false, text: render({ ...record, unrecognized: 1 }) },
      { name: 'different PID', accepted: false, text: render({ ...record, pid: expected.pid + 4 }) },
      { name: 'string PID', accepted: false, text: render({ ...record, pid: String(expected.pid) }) },
      { name: 'wrong target image', accepted: false, text: render({ ...record, targetExecutablePath: path.join(directory, 'other.exe') }) },
      { name: 'wrong runtime', accepted: false, text: render({ ...record, runtimeModulePath: path.join(directory, 'foreign', 'ReShade64.dll') }) },
      { name: 'wrong add-on', accepted: false, text: render({ ...record, addonModulePath: path.join(directory, 'foreign.addon64') }) },
      { name: 'wrong base path', accepted: false, text: render({ ...record, reshadeBasePath: path.join(directory, 'foreign') }) },
      { name: 'relative path', accepted: false, text: render({ ...record, runtimeModulePath: 'ReShade64.dll' }) },
      { name: 'root-relative path', accepted: false, text: render({ ...record, runtimeModulePath: expected.runtime.slice(2) }) },
      { name: 'foreign runtime mode', accepted: false, text: render({ ...record, runtimeMode: 'official-addon' }) },
      { name: 'array runtime mode', accepted: false, text: render({ ...record, runtimeMode: ['participant-addon'] }) },
      { name: 'wrong add-on ABI', accepted: false, text: render({ ...record, addonAbi: 2 }) },
      { name: 'wrong member protocol', accepted: false, text: render({ ...record, memberProtocolVersion: 2 }) },
      { name: 'wrong schema', accepted: false, text: render({ ...record, schemaVersion: 2 }) },
      { name: 'floating schema', accepted: false, text: render(record).replace('"schemaVersion":1', '"schemaVersion":1.0') },
      { name: 'success plus diagnostic', accepted: false, text: render(record) + 'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC {}' },
      { name: 'success plus not-started declaration', accepted: false, text: render(record) + 'ReShade injection not started.' },
    ];
    const missing = { ...record }; delete missing.memberProtocolVersion;
    cases.push({ name: 'missing member protocol', accepted: false, text: render(missing) });
    const inputPath = path.join(directory, 'input.json');
    fs.writeFileSync(inputPath, JSON.stringify({ expected, cases }));
    const runnerPath = path.join(directory, 'check.ps1');
    fs.writeFileSync(runnerPath, String.raw`
$ErrorActionPreference = 'Stop'
. $env:EGO_RESULT_HELPER
$Fixture = Get-Content -Raw -LiteralPath $env:EGO_RESULT_INPUT | ConvertFrom-Json
$Results = @()
foreach ($Case in $Fixture.cases) {
    $Stdout = Join-Path $env:EGO_RESULT_DIRECTORY 'inject.stdout.log'
    [IO.File]::WriteAllText($Stdout, $Case.text, [Text.UTF8Encoding]::new($false))
    try {
        $Result = Read-OwnedOverlayInjectorResult -StdoutPath $Stdout -ExpectedPid $Fixture.expected.pid -ExpectedExecutablePath $Fixture.expected.executable -ExpectedRuntimePath $Fixture.expected.runtime -ExpectedAddonPath $Fixture.expected.addon -ExpectedBasePath $Fixture.expected.base
        $Results += [pscustomobject]@{name=$Case.name;accepted=$true;pid=$Result.pid}
    } catch {
        $Results += [pscustomobject]@{name=$Case.name;accepted=$false;error=$_.Exception.Message}
    }
}
[Console]::WriteLine(($Results | ConvertTo-Json -Depth 5 -Compress))
`);
    const processResult = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', runnerPath], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...process.env, EGO_RESULT_HELPER: path.join(scripts, 'owned-injector-result.ps1'), EGO_RESULT_INPUT: inputPath, EGO_RESULT_DIRECTORY: directory },
    });
    assert.equal(processResult.status, 0, processResult.stderr || processResult.error?.message);
    const observed = JSON.parse(processResult.stdout.trim());
    assert.equal(observed.length, cases.length);
    for (let index = 0; index < cases.length; index++) {
      assert.equal(observed[index].name, cases[index].name);
      assert.equal(observed[index].accepted, cases[index].accepted,
        `${cases[index].name}: ${observed[index].error || JSON.stringify(observed[index])}`);
    }
  } finally {
    assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().replace(/[\\/]$/, '').toLowerCase());
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const leaf of ['run-client-sdk-session-deactivation-gate.ps1', 'run-injected-electron-scene.ps1']) {
  test(`${leaf} retains exact structured proof before starting its producer`, () => {
    const source = fs.readFileSync(path.join(scripts, leaf), 'utf8');
    assert.ok(source.indexOf('$InjectorResult = Read-OwnedOverlayInjectorResult') < source.indexOf('$ProducerProcess = Start-Process'));
    assert.ok(source.includes("Join-Path $PSScriptRoot 'owned-injector-result.ps1'"));
    assert.equal(source.includes('-SimpleMatch "Injecting ReShade ... Succeeded!"'), false);
    for (const parameter of ['StdoutPath', 'ExpectedPid', 'ExpectedExecutablePath', 'ExpectedRuntimePath', 'ExpectedAddonPath', 'ExpectedBasePath']) {
      assert.match(source, new RegExp(`-${parameter}\\b`));
    }
  });
}
