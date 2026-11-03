'use strict';
// Pure controller/argument tests: no target, Electron, native observer or desktop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const controller = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-cooperative-resource-soak-gate.ps1');
const launcher = path.join(root, 'libs/electron-game-overlay-runtime/scripts/test-cases/client-sdk-cooperative-resource-soak.ps1');
const loadPureFunctions = `
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile($env:EGO_SOAK_CONTROLLER_SOURCE,[ref]$Tokens,[ref]$Errors)
if($Errors.Count){throw $Errors}
foreach($Name in @('ConvertTo-SoakWindowsArgument','New-SoakStartInfo','Test-SoakPath','Read-SoakInitialRuntimeProof','New-SoakOwnedPaths','Assert-SoakStagedPathBudget','Test-SoakResourceCounts','Test-SoakCimCreation','Save-SoakJson','New-SoakProducerLaunchEvidence','New-SoakProducerLifecycleEvidence','Save-SoakProducerLifecycle')){
 $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
 if(-not $Definition){throw ('Pure helper missing: '+$Name)}
 . ([scriptblock]::Create($Definition.Extent.Text))
}
`;

function powershell(script, extraEnv = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 20_000,
    env: { ...process.env, EGO_SOAK_CONTROLLER_SOURCE: controller, ...extraEnv },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

test('real-SDK soak gate remains distinct and never builds, mutates registry or drives desktop input', () => {
  const source = fs.readFileSync(controller, 'utf8'), entry = fs.readFileSync(launcher, 'utf8');
  assert.match(entry, /run-client-sdk-cooperative-resource-soak-gate\.ps1/u);
  assert.match(source, /\[ValidateRange\(1, 64\)\]\[int\]\$Cycles = 8/u);
  assert.match(source, /if \(\$FunctionsOnly\) \{ return \}/u);
  assert.match(source, /already running; refusing/u);
  assert.match(source, /workspace build directory/u);
  for (const forbidden of ['SendInput', 'SetForegroundWindow', 'WriteProcessMemory', 'CreateRemoteThread', 'cmake', 'nx run', 'Remove-Item']) assert.ok(!source.includes(forbidden), `${forbidden} must stay outside this controller`);
  assert.match(source, /Private bytes and total handles|privateBytesDiagnostic/u);
  assert.match(source, /\$SurvivorTcpId = 0\s+\$Final = Wait-SoakResources 'final-all-dormant' @\(\)/u);
  assert.ok(source.indexOf('[IO.File]::WriteAllText($StartupMarker') < source.indexOf('$Target = Start-SoakOwned'));
  const initial = source.indexOf('$InitialRuntime = Read-SoakInitialRuntimeProof');
  assert.ok(initial > 0 && initial < source.indexOf('[IO.File]::Delete($Marker)'));
  assert.ok(source.indexOf("'startup-native-resources.json'") > initial && source.indexOf("'startup-native-resources.json'") < source.indexOf('[IO.File]::Delete($Marker)'));
  assert.match(source, /\$Selected\.creationTime100ns -cne \$ExpectedCreation/u);
  assert.match(source, /\$StartupNativeProof\.mapped\.runtimeCount -ne 1/u);
  assert.match(source, /\$StartupNativeProof\.mapped\.addons\.Count -ne 1/u);
  assert.match(source, /Test-SoakCimCreation \$Child\.StartTime \$Record\.CreationDate/u);
  const controlledEntry = fs.readFileSync(path.join(path.dirname(launcher), 'cooperative-resource-soak.ps1'), 'utf8');
  assert.match(controlledEntry, /run-cooperative-resource-soak-gate\.ps1/u);
  assert.ok(!controlledEntry.includes('TargetExecutable'));
});

test('startup accepts bounded owned result modes with exact native paths and retained process/producer/creation proof', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-soak-initial-proof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const common = path.join(root, 'libs/electron-game-overlay-runtime/scripts/owned-injector-result.ps1');
  powershell(`
$ErrorActionPreference='Stop'
${loadPureFunctions}
$Tokens=$null;$Errors=$null
$Common=[Management.Automation.Language.Parser]::ParseFile($env:EGO_SOAK_COMMON_SOURCE,[ref]$Tokens,[ref]$Errors)
if($Errors.Count){throw $Errors}
foreach($Name in @('Read-OwnedOverlayInjectorResult','Read-OwnedOverlayInitialResult')){
 $Definition=$Common.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
 if(-not $Definition){throw ('Missing common native result helper: '+$Name)}
 . ([scriptblock]::Create($Definition.Extent.Text))
}
$Stage=$env:EGO_SOAK_INITIAL_STAGE
$Image=Join-Path $Stage 'owned-target.exe';$Runtime=Join-Path $Stage 'ReShade64.dll';$Addon=Join-Path $Stage 'electron_game_overlay.addon64';$Stdout=Join-Path $Stage 'inject.stdout.log'
$Creation='132000000000000001'
foreach($Mode in @('injected-runtime','participant-addon')){
 $State=@{processId=654;cycle=1;injectorReturned=$true;selectedTarget=@{pid=321;creationTime100ns=$Creation;executablePath=$Image};injectorBinding=@{pid=321;creationTime100ns=$Creation;executablePath=$Image;runDirectory=$Stage};injectorProof=@{runtimeMode=$Mode;injectorTargetPid=321;targetExecutablePath=$Image;runDirectory=$Stage;injectorStdoutPath=$Stdout}}
 $Record=@{schemaVersion=1;pid=321;targetExecutablePath=$Image;runtimeMode=$Mode}
 if($Mode -ceq 'participant-addon'){$Record.runtimeModulePath=$Runtime;$Record.addonModulePath=$Addon;$Record.reshadeBasePath=$Stage;$Record.addonAbi=1;$Record.memberProtocolVersion=1;$State.injectorProof.hostRuntimePath=$Runtime;$State.injectorProof.addonModulePath=$Addon}
 [IO.File]::WriteAllText($Stdout,('ELECTRON_GAME_OVERLAY_INJECTOR_RESULT '+($Record | ConvertTo-Json -Compress)))
 $Result=Read-SoakInitialRuntimeProof $State 321 654 $Creation $Image
 if($Result.result.runtimeMode -cne $Mode -or $Result.runtimePath -cne $Runtime -or $Result.addonPath -cne $Addon){throw 'The exact owned native proof was not preserved'}
 foreach($Kind in @('producer','pid','creation','binding','image','stdout','mode','stage')){
  $Changed=$State | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  switch($Kind){'producer'{$Changed.processId=655};'pid'{$Changed.selectedTarget.pid=322};'creation'{$Changed.selectedTarget.creationTime100ns='132000000000000002'};'binding'{$Changed.injectorBinding.creationTime100ns='132000000000000002'};'image'{$Changed.injectorProof.targetExecutablePath=Join-Path $Stage 'other.exe'};'stdout'{$Changed.injectorProof.injectorStdoutPath=Join-Path (Split-Path -Parent $Stage) 'foreign.log'};'mode'{$Changed.injectorProof.runtimeMode='official-addon'};'stage'{$Changed.injectorBinding.runDirectory=Join-Path $Stage 'foreign'}}
  $Rejected=$false;try{Read-SoakInitialRuntimeProof $Changed 321 654 $Creation $Image | Out-Null}catch{$Rejected=$true}
  if(-not $Rejected){throw ('Startup identity drift accepted: '+$Mode+'/'+$Kind)}
 }
 if($Mode -ceq 'participant-addon'){$Record.addonAbi=2;[IO.File]::WriteAllText($Stdout,('ELECTRON_GAME_OVERLAY_INJECTOR_RESULT '+($Record | ConvertTo-Json -Compress)));$Rejected=$false;try{Read-SoakInitialRuntimeProof $State 321 654 $Creation $Image | Out-Null}catch{$Rejected=$true};if(-not $Rejected){throw 'Foreign native addon ABI was accepted'}}
}
Write-Output 'Both owned result modes retain exact native and creation-bound identity.'
`, { EGO_SOAK_COMMON_SOURCE: common, EGO_SOAK_INITIAL_STAGE: directory });
});

test('short unique owned paths keep the longest staged asset within 240 Windows characters', { skip: process.platform !== 'win32' }, () => {
  const output = powershell(`
$ErrorActionPreference='Stop'
${loadPureFunctions}
$Root=$env:EGO_SOAK_WORKSPACE_ROOT
$Paths=New-SoakOwnedPaths $Root ('a' * 32) ('b' * 32)
if([IO.Path]::GetFileName($Paths.run) -cne ('r-' + ('a' * 16)) -or [IO.Path]::GetFileName($Paths.target) -cne ('ego-soak-' + ('b' * 8) + '.exe')){throw 'Owned path identifiers were not shortened as specified'}
$Assets=@('electron_game_overlay_reshade_manager32.exe','electron_game_overlay_runtime32.build.json','.electron-game-overlay-runtime-startup.json','.electron-game-overlay-run-reclaimable.json')
foreach($Member in @('survivor','churn')){
 $Producer=Join-Path $Paths.run ('producers\\' + $Member + '-32')
 $Budget=Assert-SoakStagedPathBudget $Producer $Member ([IO.Path]::GetFileName($Paths.target)) $Assets
 if($Budget.longestProjectedCharacters -gt 240 -or $Budget.longestProjectedAsset -notmatch 'cycle-1024'){throw 'The maximum cycle/staged-asset path exceeded its bound'}
}
$LongRoot=Join-Path $Root ('build\\cooperative-resource-soak\\run-20261101-170214-' + ('a' * 32))
$Failed=$false
try{Assert-SoakStagedPathBudget (Join-Path $LongRoot 'producers\\survivor-1') 'survivor' ([IO.Path]::GetFileName($Paths.target)) $Assets | Out-Null}catch{$Failed=$true}
if(-not $Failed){throw 'A known overflowing owned run path was accepted'}
Write-Output ($Paths | ConvertTo-Json -Compress)
`, { EGO_SOAK_WORKSPACE_ROOT: root });
  const paths = JSON.parse(output);
  assert.equal(path.dirname(path.dirname(paths.target)), paths.run);
});

test('Windows process argument quoting round-trips empty strings, quotes and trailing slashes without a shell', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-soak-arguments-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const values = ['', 'space value', 'embedded"quote', 'trailing\\', 'quoted " value\\', '$HOME;`literal`'];
  const argumentsPath = path.join(directory, 'arguments.json');
  fs.writeFileSync(argumentsPath, JSON.stringify({ node: process.execPath, arguments: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values], directory }));
  const output = powershell(`
$ErrorActionPreference='Stop'
${loadPureFunctions}
$Data=Get-Content -LiteralPath $env:EGO_SOAK_ARGUMENTS_FILE -Raw | ConvertFrom-Json
$Info=New-SoakStartInfo $Data.node @($Data.arguments) $Data.directory
if($Info.UseShellExecute){throw 'The process would execute through a shell'}
$Child=[Diagnostics.Process]::new();$Child.StartInfo=$Info
try{if(-not $Child.Start()){throw 'Pure Node argument child did not start'};$Output=$Child.StandardOutput.ReadToEnd();$ErrorText=$Child.StandardError.ReadToEnd();if(-not $Child.WaitForExit(10000) -or $Child.ExitCode -ne 0){throw $ErrorText};Write-Output $Output}finally{if(-not $Child.HasExited){$Child.Kill();$Child.WaitForExit()};$Child.Dispose()}
`, { EGO_SOAK_ARGUMENTS_FILE: argumentsPath });
  assert.deepEqual(JSON.parse(output), values);
});

test('exact count predicate rejects hidden lifetime, named-thread, owned-scene and survivor-ID drift', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-soak-counts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const survivorPath = path.join(directory, 'survivor', 'electron_game_overlay.addon64');
  const churnPath = path.join(directory, 'churn', 'electron_game_overlay.addon64');
  const snapshot = {
    frameThreads: 2, tcpThreads: 1, frameThreadIds: [11, 12], tcpThreadIds: [21],
    modules: [{ path: survivorPath }, { path: churnPath }],
    registry: { lifetimeSlots: 2, activeParticipants: 2, windows: 1, ranks: 1, focus: { participant: 1 }, capture: { participant: 0 }, captureButtons: 0, participants: [
      { id: 1, modulePath: survivorPath, windows: 1, ranks: 1, interception: 0 },
      { id: 2, modulePath: churnPath, windows: 0, ranks: 0, interception: 0 },
    ] },
  };
  const dataPath = path.join(directory, 'counts.json');
  fs.writeFileSync(dataPath, JSON.stringify({ snapshot, identities: [{ path: survivorPath }, { path: churnPath }], survivorPath }));
  powershell(`
$ErrorActionPreference='Stop'
${loadPureFunctions}
$Data=Get-Content -LiteralPath $env:EGO_SOAK_COUNTS_FILE -Raw | ConvertFrom-Json
function Check([object]$Value){Test-SoakResourceCounts $Value @($Data.identities) @($Data.survivorPath) @(11,12) 21}
if(-not (Check $Data.snapshot)){throw 'Valid dormant shape rejected'}
foreach($Kind in @('slot','participant','frame','tcp','window','rank','retired-scene','retired-interception','module','survivor-thread','retired-focus','retired-capture','unowned-buttons')){
 $Value=$Data.snapshot | ConvertTo-Json -Depth 12 | ConvertFrom-Json
 switch($Kind){
 'slot'{$Value.registry.lifetimeSlots++}
 'participant'{$Value.registry.activeParticipants--}
 'frame'{$Value.frameThreads++}
 'tcp'{$Value.tcpThreads++}
 'window'{$Value.registry.windows++}
 'rank'{$Value.registry.ranks++}
 'retired-scene'{$Value.registry.participants[1].windows=1}
 'retired-interception'{$Value.registry.participants[1].interception=1}
 'module'{$Value.modules[1].path='C:\\foreign\\electron_game_overlay.addon64'}
 'survivor-thread'{$Value.tcpThreadIds=@(99)}
 'retired-focus'{$Value.registry.focus.participant=2}
 'retired-capture'{$Value.registry.capture.participant=2}
 'unowned-buttons'{$Value.registry.captureButtons=1}
 }
 if(Check $Value){throw ('Drift accepted: '+$Kind)}
}
Write-Output 'Exact resource bounds rejected every drift fixture.'
`, { EGO_SOAK_COUNTS_FILE: dataPath });
});

test('CIM child ownership binding compares the retained creation identity at exact reported precision', { skip: process.platform !== 'win32' }, () => {
  powershell(`
$ErrorActionPreference='Stop'
${loadPureFunctions}
$Observed=[datetime]::new(638000000000000000,[DateTimeKind]::Utc)
if(-not (Test-SoakCimCreation ($Observed.AddTicks(9)) $Observed)){throw '100 ns remainder was not compared at CIM microsecond precision'}
if(Test-SoakCimCreation ($Observed.AddTicks(10)) $Observed){throw 'Reused child identity accepted'}
if(Test-SoakCimCreation $Observed 'unknown'){throw 'Unknown creation identity accepted'}
Write-Output 'Exact CIM precision bound passed.'
`);
});

test('producer launch and lifecycle evidence retain exact argv and distinguish alive, exited and changed identities with no GUI process', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-soak-lifecycle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const values = {
    directory, executable: path.join(directory, 'Electron executable.exe'), cwd: directory,
    arguments: [path.join(directory, 'fixture with spaces.cjs'), '--member=churn', `--evidence=${directory}`, '--pid=73'],
  };
  const dataPath = path.join(directory, 'input.json'); fs.writeFileSync(dataPath, JSON.stringify(values));
  const output = powershell(`
$ErrorActionPreference='Stop'
${loadPureFunctions}
$Data=Get-Content -LiteralPath $env:EGO_SOAK_LIFECYCLE_FILE -Raw | ConvertFrom-Json
$Mock=[pscustomobject]@{Id=73;StartTime=[datetime]::new(638000000000000000,[DateTimeKind]::Utc);HasExited=$false;ExitTime=[datetime]::new(638000000100000000,[DateTimeKind]::Utc)}
$Mock | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
$Mock | Add-Member -MemberType ScriptProperty -Name ExitCode -Value {if(-not $this.HasExited){throw 'ExitCode must not be read for a live producer'};return 7}
$Launch=New-SoakProducerLaunchEvidence $Data.executable @($Data.arguments) $Data.cwd $Mock
$Entry=@{member='churn';directory=$Data.directory;process=$Mock;launch=$Launch;expectedExit=$false;lifecycleSequence=0}
$Alive=New-SoakProducerLifecycleEvidence $Entry 'started'
Save-SoakProducerLifecycle $Entry 'started'
$Mock.HasExited=$true
$Exited=New-SoakProducerLifecycleEvidence $Entry 'unexpected-exit'
Save-SoakProducerLifecycle $Entry 'unexpected-exit'
$Mock.StartTime=$Mock.StartTime.AddSeconds(1)
$Changed=New-SoakProducerLifecycleEvidence $Entry 'cleanup-before-force'
$Rejected=$false
try{New-SoakProducerLaunchEvidence $Data.executable @($Data.arguments[0],'--token=must-not-be-recorded') $Data.cwd $Mock | Out-Null}catch{$Rejected=$true}
if(-not $Rejected){throw 'Credential argument field was admitted'}
@{launch=$Launch;alive=$Alive;exited=$Exited;changed=$Changed;events=$Entry.lifecycleSequence} | ConvertTo-Json -Depth 12 -Compress
`, { EGO_SOAK_LIFECYCLE_FILE: dataPath });
  const result = JSON.parse(output);
  assert.equal(result.launch.executable, values.executable);
  assert.equal(result.launch.workingDirectory, values.cwd);
  assert.deepEqual(result.launch.arguments, values.arguments);
  assert.equal(result.launch.processId, 73);
  assert.match(result.launch.creationTime100ns, /^[1-9][0-9]+$/u);
  assert.equal(result.alive.hasExited, false);
  assert.equal(result.alive.exitCode, null);
  assert.equal(result.alive.observedIdentityMatchesLaunch, true);
  assert.equal(result.alive.observationError, undefined);
  assert.equal(result.alive.producerStateFileExists, false);
  assert.equal(result.alive.producerSdkFileExists, false);
  assert.equal(result.exited.hasExited, true);
  assert.equal(result.exited.exitCode, 7);
  assert.equal(result.changed.observedIdentityMatchesLaunch, false);
  assert.equal(result.events, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'process-lifecycle-latest.json'), 'utf8').replace(/^\uFEFF/u, '')).phase, 'unexpected-exit');
});
