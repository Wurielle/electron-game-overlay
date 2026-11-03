const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('initial owned result accepts exact legacy or participant schemas without inventing legacy module paths', {
  skip: process.platform !== 'win32',
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-initial-result-'));
  try {
    const expected = {
      pid: 29532, executable: path.join(directory, 'target', 'game.exe'),
      runtime: path.join(directory, 'ReShade64.dll'), addon: path.join(directory, 'electron_game_overlay.addon64'), base: directory,
    };
    const legacy = { schemaVersion: 1, pid: expected.pid, targetExecutablePath: expected.executable, runtimeMode: 'injected-runtime' };
    const participant = { ...legacy, runtimeMode: 'participant-addon', runtimeModulePath: expected.runtime,
      addonModulePath: expected.addon, reshadeBasePath: expected.base, addonAbi: 1, memberProtocolVersion: 1 };
    const render = record => `ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ${JSON.stringify(record)}\r\n`;
    const progress = 'Injecting ReShade ... Found a matching process! Loading Electron Game Overlay participant into existing ReShade ... Succeeded!\r\n';
    const cases = [];
    const add = (name, record, accepted = false, overrides = {}) => cases.push({ name, text: render(record), accepted, expected, ...overrides });
    add('legacy full runtime', legacy, true, { propertyCount: 4 });
    add('participant runtime', participant, true, { propertyCount: 9 });
    add('nested participant progress', participant, true, { propertyCount: 9, text: progress + render(participant) });
    add('case insensitive absolute paths', { ...participant, targetExecutablePath: expected.executable.toUpperCase(), runtimeModulePath: expected.runtime.toUpperCase() }, true, { propertyCount: 9 });
    add('unknown runtime mode', { ...legacy, runtimeMode: 'official-addon' });
    add('array runtime mode', { ...legacy, runtimeMode: ['injected-runtime'] });
    add('legacy extra module path', { ...legacy, runtimeModulePath: expected.runtime });
    add('legacy missing image', { schemaVersion: 1, pid: expected.pid, runtimeMode: 'injected-runtime' });
    add('wrong PID', { ...legacy, pid: expected.pid + 1 });
    add('string PID', { ...legacy, pid: String(expected.pid) });
    add('wrong target image', { ...legacy, targetExecutablePath: path.join(directory, 'wrong.exe') });
    add('relative target image', { ...legacy, targetExecutablePath: 'game.exe' });
    add('array target image', { ...legacy, targetExecutablePath: [expected.executable] });
    add('wrong schema', { ...legacy, schemaVersion: 2 });
    add('string schema', { ...legacy, schemaVersion: '1' });
    add('floating schema', legacy, false, { text: render(legacy).replace('"schemaVersion":1', '"schemaVersion":1.0') });
    add('wrong participant runtime', { ...participant, runtimeModulePath: path.join(directory, 'other', 'ReShade64.dll') });
    add('wrong participant addon', { ...participant, addonModulePath: path.join(directory, 'other.addon64') });
    add('wrong participant base', { ...participant, reshadeBasePath: path.join(directory, 'other') });
    add('participant extra property', { ...participant, other: true });
    const incomplete = { ...participant }; delete incomplete.memberProtocolVersion;
    add('participant missing property', incomplete);
    add('wrong participant protocol', { ...participant, memberProtocolVersion: 2 });
    add('wrong participant ABI', { ...participant, addonAbi: 2 });
    add('duplicate result', legacy, false, { text: render(legacy) + render(legacy) });
    add('mixed duplicate modes', legacy, false, { text: render(legacy) + render(participant) });
    add('malformed result', legacy, false, { text: 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT {' });
    add('array envelope', legacy, false, { text: render([legacy]) });
    add('empty log', legacy, false, { text: '' });
    add('human progress alone', legacy, false, { text: progress });
    add('diagnostic plus legacy result', legacy, false, { text: render(legacy) + 'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC {}' });
    add('not-started plus legacy result', legacy, false, { text: render(legacy) + 'ReShade injection not started.' });
    add('expected runtime outside own base', legacy, false, { expected: { ...expected, runtime: path.join(directory, 'other', 'ReShade64.dll') } });
    add('expected addon outside own base', legacy, false, { expected: { ...expected, addon: path.join(directory, 'other', 'electron_game_overlay.addon64') } });
    add('expected relative runtime', legacy, false, { expected: { ...expected, runtime: 'ReShade64.dll' } });
    add('expected relative base', legacy, false, { expected: { ...expected, base: 'stage' } });
    const valid = render(legacy);
    add('exact maximum log byte size', legacy, true, { propertyCount: 4, text: valid + 'x'.repeat(1024 * 1024 - Buffer.byteLength(valid)) });
    add('oversized log', legacy, false, { text: valid + 'x'.repeat(1024 * 1024 + 1 - Buffer.byteLength(valid)) });
    fs.writeFileSync(path.join(directory, 'input.json'), JSON.stringify(cases));
    fs.writeFileSync(path.join(directory, 'check.ps1'), String.raw`
$ErrorActionPreference='Stop'
. $env:EGO_INITIAL_HELPER
$Cases=Get-Content -Raw $env:EGO_INITIAL_INPUT|ConvertFrom-Json
$Results=@()
foreach($Case in $Cases) {
  $Stdout=Join-Path $env:EGO_INITIAL_DIRECTORY 'inject.log'
  [IO.File]::WriteAllText($Stdout,$Case.text,[Text.UTF8Encoding]::new($false))
  try {
    $Proof=Read-OwnedOverlayInitialResult -StdoutPath $Stdout -ExpectedPid $Case.expected.pid -ExpectedExecutablePath $Case.expected.executable -ExpectedRuntimePath $Case.expected.runtime -ExpectedAddonPath $Case.expected.addon -ExpectedBasePath $Case.expected.base
    $Results += [pscustomobject]@{name=$Case.name;accepted=$true;proof=$Proof;propertyCount=@($Proof.PSObject.Properties).Count}
  } catch {$Results += [pscustomobject]@{name=$Case.name;accepted=$false;error=$_.Exception.Message}}
  # The bounded read lease must be disposed on both acceptance and rejection.
  $Renamed=$Stdout+'.released'
  [IO.File]::Move($Stdout,$Renamed)
  [IO.File]::Move($Renamed,$Stdout)
}
[Console]::WriteLine(($Results|ConvertTo-Json -Depth 8 -Compress))
`);
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(directory, 'check.ps1')], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, EGO_INITIAL_HELPER: path.resolve(__dirname, '../../electron-game-overlay-runtime/scripts/owned-injector-result.ps1'), EGO_INITIAL_INPUT: path.join(directory, 'input.json'), EGO_INITIAL_DIRECTORY: directory },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const observed = JSON.parse(result.stdout.trim());
    assert.equal(observed.length, cases.length);
    for (let index = 0; index < cases.length; index++) {
      const value = observed[index];
      assert.equal(value.accepted, cases[index].accepted, `${cases[index].name}: ${value.error || JSON.stringify(value)}`);
      if (cases[index].accepted) {
        assert.equal(value.propertyCount, cases[index].propertyCount, `${cases[index].name}: helper must preserve original result shape`);
        assert.equal(value.proof.pid, expected.pid);
        assert.equal(value.proof.targetExecutablePath.toLowerCase(), expected.executable.toLowerCase());
        if (value.proof.runtimeMode === 'injected-runtime') {
          for (const key of ['runtimeModulePath', 'addonModulePath', 'reshadeBasePath']) assert.equal(Object.hasOwn(value.proof, key), false);
        }
      }
    }
  } finally {
    assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().replace(/[\\/]$/, '').toLowerCase());
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('mapped evidence rejects a forged creation identity and a live process without the owned modules', {
  skip: process.platform !== 'win32',
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-mapped-proof-'));
  try {
    const runner = path.join(directory, 'mapped.ps1');
    fs.writeFileSync(runner, String.raw`
$ErrorActionPreference='Stop'
. $env:EGO_INITIAL_HELPER
$TaskSelf=Get-Process -Id $PID
try {
  $TaskImage=$TaskSelf.MainModule.FileName
  $TaskCreation=$TaskSelf.StartTime.ToFileTimeUtc()
  $TaskLog=Join-Path $env:EGO_INITIAL_DIRECTORY 'inject.log'
  $TaskResults=@()
  foreach($TaskCase in @(
      @{name='forged creation time';creation=($TaskCreation+1).ToString();expected='native watcher PID, creation time and image'},
      @{name='no mapped runtime';creation=$TaskCreation.ToString();expected='exactly one ReShade'})) {
    [IO.File]::WriteAllText($TaskLog,('EGO_TARGET_SELECTED_V2'+[char]9+$TaskSelf.Id+[char]9+$TaskCase.creation+[char]9+$TaskImage),[Text.UTF8Encoding]::new($false))
    try {
      $TaskProof=Get-OwnedOverlayMappedEvidence -Process $TaskSelf -InjectorStdoutPath $TaskLog -ExpectedExecutablePath $TaskImage -ExpectedRuntimePath (Join-Path $env:EGO_INITIAL_DIRECTORY 'ReShade64.dll') -ExpectedAddonPath (Join-Path $env:EGO_INITIAL_DIRECTORY 'electron_game_overlay.addon64') -ExpectedRuntimeSha256 ('0'*64) -ExpectedAddonSha256 ('0'*64)
      $TaskResults += [pscustomobject]@{name=$TaskCase.name;accepted=$true}
    } catch {$TaskResults += [pscustomobject]@{name=$TaskCase.name;accepted=$false;error=$_.Exception.Message;expected=$TaskCase.expected}}
  }
  [Console]::WriteLine(($TaskResults|ConvertTo-Json -Compress))
} finally {$TaskSelf.Dispose()}
`);
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', runner], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...process.env, EGO_INITIAL_HELPER: path.resolve(__dirname, '../../electron-game-overlay-runtime/scripts/owned-injector-result.ps1'), EGO_INITIAL_DIRECTORY: directory },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const observed = JSON.parse(result.stdout.trim());
    assert.equal(observed.length, 2);
    for (const value of observed) {
      assert.equal(value.accepted, false, value.name);
      assert.ok(value.error.includes(value.expected), `${value.name}: ${value.error}`);
    }
  } finally {
    assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().replace(/[\\/]$/, '').toLowerCase());
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
