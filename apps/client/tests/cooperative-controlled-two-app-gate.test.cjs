'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const runner = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-two-app-one-target-gate.ps1');

test('controlled two-app route evidence rejects the old shared endpoint and mismatched producer/target credentials', {
  skip: process.platform !== 'win32' ? 'PowerShell metadata validation requires Windows' : false,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-controlled-private-routes-'));
  const a = path.join(directory, 'a');
  const b = path.join(directory, 'b');
  const extra = path.join(directory, 'extra');
  for (const item of [a, b, extra]) fs.mkdirSync(item);
  const record = (pid, port, token) => ({ version: 1, pid, targetPid: 303, port, token });
  const recordA = record(101, 41001, 'ab'.repeat(32));
  const recordB = record(102, 41002, 'cd'.repeat(32));
  const aLog = path.join(directory, 'a.log');
  const bLog = path.join(directory, 'b.log');
  const line = item => `RESHADE_CLIENT_RUNTIME_STAGED directory=${JSON.stringify(item)}\n`;
  fs.writeFileSync(aLog, line(a));
  fs.writeFileSync(bLog, line(b));
  const expectedFingerprint = crypto.createHash('sha256').update(recordA.token).digest('hex');
  const payload = { runner, a, b, extra, aLog, bLog, recordA, recordB, expectedFingerprint };
  const payloadPath = path.join(directory, 'fixture.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  const script = `
$ErrorActionPreference = 'Stop'
$Data = Get-Content -LiteralPath '${payloadPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
$Tokens = $null; $Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Data.runner,[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
foreach ($Name in @('Get-RunDirectoriesFromClientLog','Get-PrivateParticipantRoute','Assert-PrivateParticipantRoutes')) {
    $Definition = $Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
    if (-not $Definition) { throw ('Required private route guard is missing: ' + $Name) }
    . ([scriptblock]::Create($Definition.Extent.Text))
}
function Get-ClientLogText { param([string]$Path) Get-Content -LiteralPath $Path -Raw }
function Save-Record([string]$Directory,[object]$Record) { $Record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'electron-overlay-transport-v1.json') -Encoding UTF8 }
function Must-Reject([scriptblock]$Operation,[string]$Label) { $Rejected=$false;try{ & $Operation | Out-Null }catch{$Rejected=$true};if(-not $Rejected){throw ('Incorrectly accepted ' + $Label)} }
Save-Record $Data.a $Data.recordA
Save-Record $Data.b $Data.recordB
$A = Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 101 -TargetPid 303
$B = Get-PrivateParticipantRoute -ClientLog $Data.bLog -ProducerPid 102 -TargetPid 303
Assert-PrivateParticipantRoutes $A $B
if ($A.TokenFingerprint -cne $Data.expectedFingerprint -or @($A.PSObject.Properties.Name) -contains 'token') { throw 'Private route evidence leaked a credential or used the wrong fingerprint.' }
Must-Reject { Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 999 -TargetPid 303 } 'a broker/foreign producer PID'
Must-Reject { Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 101 -TargetPid 999 } 'a foreign target PID'
foreach ($Field in @('Port','TokenFingerprint','ProducerPid','DiscoveryPath')) {
    $Bad = $B | Select-Object *
    $Bad.$Field = $A.$Field
    Must-Reject { Assert-PrivateParticipantRoutes $A $Bad } ('shared route field ' + $Field)
}
foreach ($Port in @(0,65536,'41001')) {
    $Bad = $Data.recordA | Select-Object *
    $Bad.port = $Port
    Save-Record $Data.a $Bad
    Must-Reject { Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 101 -TargetPid 303 } 'an invalid port'
}
$Bad = $Data.recordA | Select-Object *
$Bad.token = 'ab'
Save-Record $Data.a $Bad
Must-Reject { Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 101 -TargetPid 303 } 'an invalid credential'
Save-Record $Data.a $Data.recordA
Save-Record $Data.extra $Data.recordA
$ExtraLine = 'RESHADE_CLIENT_RUNTIME_STAGED directory=' + (ConvertTo-Json -InputObject $Data.extra -Compress)
Add-Content -LiteralPath $Data.aLog -Value $ExtraLine
Must-Reject { Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 101 -TargetPid 303 } 'ambiguous staged routes'
Write-Output 'Controlled private route evidence verified without starting a host or app.'
`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Controlled private route evidence verified without starting a host or app\./u);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('controlled initial runtime proof binds both producers, exact incarnation and one mapped host with two private engines', {
  skip: process.platform !== 'win32' ? 'PowerShell initial runtime proof validation requires Windows' : false,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-controlled-initial-runtime-'));
  const sdk = path.join(directory, 'sdk', 'dist');
  const runtime = path.join(sdk, 'runtime/win32-x64/reshade');
  const a = path.join(directory, 'stage-a'), b = path.join(directory, 'stage-b');
  const userA = path.join(directory, 'user-a'), userB = path.join(directory, 'user-b');
  const eventA = path.join(userA, 'logs/compatibility-runs/fixture.events.jsonl');
  const eventB = path.join(userB, 'logs/compatibility-runs/fixture.events.jsonl');
  for (const item of [runtime, a, b, path.dirname(eventA), path.dirname(eventB)]) fs.mkdirSync(item, { recursive: true });
  // File-layout PE data only. The real passive identity helper reads these
  // exports and bytes; none of the images is executable or loaded by a process.
  function image(entries) {
    const bytes = Buffer.alloc(0x1200);
    bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128);
    bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148);
    const optional = 152, section = optional + 240;
    bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(0x200, optional + 60);
    bytes.writeUInt32LE(16, optional + 108); bytes.writeUInt32LE(0x1000, optional + 112); bytes.writeUInt32LE(0x300, optional + 116);
    bytes.write('.rdata', section); bytes.writeUInt32LE(0x1000, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
    bytes.writeUInt32LE(0x1000, section + 16); bytes.writeUInt32LE(0x200, section + 20);
    bytes.writeUInt32LE(entries.length, 0x214); bytes.writeUInt32LE(entries.length, 0x218);
    bytes.writeUInt32LE(0x1040, 0x21c); bytes.writeUInt32LE(0x1080, 0x220); bytes.writeUInt32LE(0x10c0, 0x224);
    let nameRva = 0x1100;
    entries.forEach(([name, value], index) => {
      const target = 0x1400 + index * 0x80;
      bytes.writeUInt32LE(target, 0x240 + index * 4); bytes.writeUInt32LE(nameRva, 0x280 + index * 4);
      bytes.writeUInt16LE(index, 0x2c0 + index * 2); bytes.write(name + '\0', nameRva - 0xe00);
      Buffer.from(value).copy(bytes, target - 0xe00); nameRva += Buffer.byteLength(name) + 1;
    });
    return bytes;
  }
  const buildId = '0123456789ABCDEF0123456789ABCDEF';
  const abi = Buffer.alloc(4); abi.writeUInt32LE(1);
  const addon = image([['ElectronGameOverlayReShadeAddonBuildId', buildId + '\0'], ['ElectronGameOverlayReShadeAddonAbi', abi]]);
  const host = image([['ReShadeVersion', Buffer.alloc(8)]]);
  const expectedRuntime = path.join(runtime, 'ReShade64.dll');
  const expectedAddon = path.join(runtime, 'electron_game_overlay.addon64');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(path.dirname(sdk), 'package.json'), JSON.stringify({ name: 'electron-game-overlay', version: '0.1.0-fixture' }));
  fs.writeFileSync(path.join(sdk, 'index.js'), "throw new Error('CONTROLLED SDK MUST NEVER EXECUTE');\n");
  fs.writeFileSync(expectedRuntime, host); fs.writeFileSync(expectedAddon, addon);
  fs.writeFileSync(path.join(runtime, 'electron_game_overlay_runtime.build.json'), JSON.stringify({
    schemaVersion: 4, kind: 'electron-game-overlay-runtime-build', platform: 'win32-x64',
    addonSha256: hash(addon), addonBuildId: buildId, reshadeRuntimeSha256: hash(host),
    runtimeGeneration: 1, targetTransportMin: 1, targetTransportMax: 1,
  }));
  const payloadPath = path.join(directory, 'fixture.json');
  fs.writeFileSync(payloadPath, JSON.stringify({
    runner, directory, sdk, expectedRuntime, expectedAddon, a, b, userA, userB, eventA, eventB,
    target: path.join(directory, 'controlled-demo.exe'),
    aLog: path.join(directory, 'a.log'), bLog: path.join(directory, 'b.log'),
    aError: path.join(directory, 'a.err'), bError: path.join(directory, 'b.err'),
    ownedGuard: path.join(root, 'libs/electron-game-overlay-runtime/scripts/owned-injector-result.ps1'),
    hashGuard: path.join(root, 'libs/electron-game-overlay-runtime/scripts/cooperative-native-evidence.ps1'),
    inputGate: path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-input-gate.ps1'),
    nativeHelper: path.join(root, 'apps/client/scripts/cooperative-game-evidence.cjs'), node: process.execPath,
  }));
  const script = `
$ErrorActionPreference = 'Stop'
$Data = Get-Content -LiteralPath '${payloadPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
$Tokens = $null; $Errors = $null
function Import-ControlledFunction([string]$File,[string[]]$Names) {
    $Ast = [Management.Automation.Language.Parser]::ParseFile($File,[ref]$Tokens,[ref]$Errors)
    if ($Errors) { throw $Errors }
    foreach ($Name in $Names) {
        $Definition = $Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
        if (-not $Definition) { throw ('Missing production proof helper: ' + $Name) }
        . ([scriptblock]::Create('function global:' + $Definition.Extent.Text.Substring(9)))
    }
}
Import-ControlledFunction $Data.runner @('Wait-ForInitialRuntimeInjection','Get-RunDirectoriesFromClientLog')
Import-ControlledFunction $Data.ownedGuard @('Read-OwnedOverlayStartupAttempt')
Import-ControlledFunction $Data.hashGuard @('Assert-CooperativeRuntimeHash')
Import-ControlledFunction $Data.inputGate @('Get-ClientLogText')
function New-ControlledProcess([int]$ProcessId) {
    $Process = [pscustomobject]@{Id=$ProcessId;HasExited=$false;Modules=@();RefreshCount=0;
        StartTime=[DateTime]::FromFileTimeUtc(134380000000000001);MainModule=[pscustomobject]@{FileName=$Data.target}}
    $Process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {
        $this.RefreshCount++
        if ($this.Id -eq 303 -and $script:DelayedOwner -and $this.RefreshCount -ge 3) {
            $Owner=$script:DelayedOwner; $script:DelayedOwner=$null; Reset-ProofFixture $Owner
        }
    }
    return $Process
}
$HostProcess=New-ControlledProcess 303; $ClientA=New-ControlledProcess 101; $ClientB=New-ControlledProcess 102
$TargetPath=$Data.target; $TargetCreationTime100ns='134380000000000001'
$CandidateSdkDist=$Data.sdk; $EvidenceNode=$Data.node; $NativeEvidenceHelper=$Data.nativeHelper
$ClientAStdout=$Data.aLog; $ClientBStdout=$Data.bLog; $ClientAStderr=$Data.aError; $ClientBStderr=$Data.bError
$ClientAUserData=$Data.userA; $ClientBUserData=$Data.userB
$script:Records=@{}; $script:ResetSequence=0; $script:DelayedOwner=$null
function Save-Events([string]$Owner) {
    $File=if($Owner -ceq 'App A'){$Data.eventA}else{$Data.eventB}
    $Lines=@($script:Records[$Owner]|ForEach-Object{$_|ConvertTo-Json -Depth 8 -Compress})
    [IO.File]::WriteAllText($File,($Lines -join [Environment]::NewLine)+[Environment]::NewLine+'{partial')
}
function Reset-ProofFixture([string]$Owner,[bool]$BothParticipant=$false) {
    $script:ResetSequence++; $script:DelayedOwner=$null
    $script:RunDirectory=Join-Path $Data.directory ('proof-'+$script:ResetSequence)
    New-Item -ItemType Directory -Path $script:RunDirectory | Out-Null
    $HostProcess.StartTime=[DateTime]::FromFileTimeUtc(134380000000000001); $HostProcess.MainModule.FileName=$Data.target
    foreach($Stage in @($Data.a,$Data.b)){
        [IO.File]::WriteAllBytes((Join-Path $Stage 'ReShade64.dll'),[IO.File]::ReadAllBytes($Data.expectedRuntime))
        [IO.File]::WriteAllBytes((Join-Path $Stage 'electron_game_overlay.addon64'),[IO.File]::ReadAllBytes($Data.expectedAddon))
    }
    foreach($Label in @('App A','App B')){
        $IsA=$Label -ceq 'App A'; $Producer=if($IsA){101}else{102}; $Stage=if($IsA){$Data.a}else{$Data.b}
        $Log=if($IsA){$Data.aLog}else{$Data.bLog}; $ErrorLog=if($IsA){$Data.aError}else{$Data.bError}
        [IO.File]::WriteAllText($ErrorLog,'')
        $Leaf=[IO.Path]::GetFileName($Data.target)
        $Arguments=@($Leaf,'--pid','303','--expected-creation-time-100ns',$TargetCreationTime100ns)
        $Lines=@()
        $Lines+=('RESHADE_CLIENT_RUNTIME_STAGED directory='+(ConvertTo-Json -InputObject $Stage -Compress))
        $Lines+=('RESHADE_CLIENT_INJECTOR_STARTED target='+(ConvertTo-Json -InputObject $Leaf -Compress)+' arguments='+(ConvertTo-Json -InputObject $Arguments -Compress))
        $Lines+='RESHADE_CLIENT_INJECTOR_RETURNED target=controlled'
        [IO.File]::WriteAllText($Log,($Lines -join [Environment]::NewLine)+[Environment]::NewLine)
        $RunId='run-'+$Producer; $AttemptId='attempt-'+$Producer
        $Mode=if($BothParticipant -or $Label -cne $Owner){'participant-addon'}else{'injected-runtime'}
        $script:Records[$Label]=@(
            [pscustomobject]@{schemaVersion=1;runId=$RunId;type='run.started';data=[pscustomobject]@{clientPid=$Producer}},
            [pscustomobject]@{schemaVersion=1;runId=$RunId;sequence=2;type='attachment.rendezvous-authorized';pid=303;targetId='target-303';data=[pscustomobject]@{attemptId=$AttemptId}},
            [pscustomobject]@{schemaVersion=1;runId=$RunId;sequence=3;type='attachment.injector-started';pid=303;targetId='target-303';data=[pscustomobject]@{attemptId=$AttemptId;strategy='exact-pid'}},
            [pscustomobject]@{schemaVersion=1;runId=$RunId;sequence=4;type='attachment.injector-returned';pid=303;targetId='target-303';timestamp='2026-11-01T00:00:00Z';data=[pscustomobject]@{attemptId=$AttemptId;runtimeMode=$Mode}})
        Save-Events $Label
    }
    $Provider=if($Owner -ceq 'App A'){$Data.a}else{$Data.b}
    $HostProcess.Modules=@(
        [pscustomobject]@{FileName=(Join-Path $Provider 'ReShade64.dll');BaseAddress=[IntPtr]0x100000},
        [pscustomobject]@{FileName=(Join-Path $Data.a 'electron_game_overlay.addon64');BaseAddress=[IntPtr]0x200000},
        [pscustomobject]@{FileName=(Join-Path $Data.b 'electron_game_overlay.addon64');BaseAddress=[IntPtr]0x300000})
}
$Boundary='The graphics startup barrier could not be released after exact target, one-host and two-engine verification.'
function Must-Reject([string]$Label,[string]$Expected=$Boundary) {
    $Rejected=$false
    try{Wait-ForInitialRuntimeInjection -Deadline ([DateTime]::UtcNow.AddMilliseconds(150))|Out-Null}
    catch{if(-not $_.Exception.Message.StartsWith($Expected)){throw};$Rejected=$true}
    if(-not $Rejected){throw ('Incorrectly accepted initial proof: '+$Label)}
}
foreach($Owner in @('App A','App B')){
    foreach($BothParticipant in @($false,$true)){
        Reset-ProofFixture $Owner $BothParticipant
        $Proof=Wait-ForInitialRuntimeInjection -Deadline ([DateTime]::UtcNow.AddSeconds(3))
        $Producer=if($Owner -ceq 'App A'){101}else{102}; $Mode=if($BothParticipant){'participant-addon'}else{'injected-runtime'}
        if($Proof.OwnerLabel -cne $Owner -or $Proof.ProducerPid -ne $Producer -or $Proof.TargetPid -ne 303 -or
            $Proof.TargetCreationTime100ns -cne $TargetCreationTime100ns -or $Proof.RuntimeMode -cne $Mode -or
            $Proof.ParticipantInitializations.Count -ne 2 -or $Proof.AddonModules.Count -ne 2 -or
            $Proof.RuntimeSha256 -cne (Get-FileHash -LiteralPath $Data.expectedRuntime -Algorithm SHA256).Hash.ToLowerInvariant()){
            throw 'Valid exact-incarnation two-producer proof lost its mapped provider or private engines.'
        }
    }
}
Reset-ProofFixture 'App B'
foreach($File in @($Data.aLog,$Data.bLog,$Data.aError,$Data.bError)){[IO.File]::WriteAllText($File,'')}
foreach($File in @($Data.eventA,$Data.eventB)){Remove-Item -LiteralPath $File -Force}
$HostProcess.Modules=@();$HostProcess.RefreshCount=0;$script:DelayedOwner='App B'
$EmptyLogWasNull=$null -eq (Get-ClientLogText -Path $Data.aLog)
$Proof=Wait-ForInitialRuntimeInjection -Deadline ([DateTime]::UtcNow.AddSeconds(3))
if(-not $EmptyLogWasNull -or $Proof.OwnerLabel -cne 'App B' -or $HostProcess.RefreshCount -lt 3){throw 'Null/empty logs were not polled until both exact producer proofs arrived.'}
Reset-ProofFixture 'App A';[IO.File]::WriteAllText($Data.bLog,'');Must-Reject 'only one completed producer'
Reset-ProofFixture 'App A';$script:Records['App A'][0].data.clientPid=999;Save-Events 'App A';Must-Reject 'foreign producer PID'
Reset-ProofFixture 'App A';$script:Records['App A'][3].pid=404;Save-Events 'App A';Must-Reject 'another target PID'
Reset-ProofFixture 'App A';$script:Records['App A'][3].schemaVersion=2;Save-Events 'App A';Must-Reject 'wrong event schema'
Reset-ProofFixture 'App A';$script:Records['App A'][3].data.attemptId='another-attempt';Save-Events 'App A';Must-Reject 'cross-attempt completion'
Reset-ProofFixture 'App A';$script:Records['App A'][3].data.runtimeMode='existing-runtime';Save-Events 'App A';Must-Reject 'unsupported completion mode'
Reset-ProofFixture 'App A';$HostProcess.Modules=$HostProcess.Modules[0..1];Must-Reject 'one mapped engine for two producers'
Reset-ProofFixture 'App A';$HostProcess.Modules+=([pscustomobject]@{FileName=(Join-Path $Data.b 'ReShade64.dll');BaseAddress=[IntPtr]0x400000});Must-Reject 'two mapped ReShade hosts'
Reset-ProofFixture 'App A';[IO.File]::AppendAllText((Join-Path $Data.a 'electron_game_overlay.addon64'),'changed-native-bytes');Must-Reject 'changed private engine bytes'
Reset-ProofFixture 'App A';[IO.File]::AppendAllText((Join-Path $Data.a 'ReShade64.dll'),'changed-runtime-bytes');Must-Reject 'changed owned host bytes'
Reset-ProofFixture 'App A';$HostProcess.StartTime=$HostProcess.StartTime.AddTicks(1);Must-Reject 'reused PID with a different creation time' 'The retained target process identity changed before graphics startup release.'
Reset-ProofFixture 'App A';$HostProcess.MainModule.FileName='C:\foreign\other.exe';Must-Reject 'foreign target executable' 'The retained target process identity changed before graphics startup release.'
Write-Output 'Controlled exact-incarnation, two-producer, one-host/two-engine proof verified without loading images or starting a host or app.'
`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Controlled exact-incarnation, two-producer, one-host\/two-engine proof verified/u);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('controlled graphics startup releases after one proved runtime and before waiting for both engines', {
  skip: process.platform !== 'win32' ? 'PowerShell startup barrier validation requires Windows' : false,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-controlled-graphics-barrier-'));
  const payloadPath = path.join(directory, 'fixture.json');
  fs.writeFileSync(payloadPath, JSON.stringify({ runner, directory }));
  const script = `
$ErrorActionPreference = 'Stop'
$Data = Get-Content -LiteralPath '${payloadPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
$Tokens = $null; $Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Data.runner,[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
$Definition = $Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Release-GraphicsAfterInitialRuntimeInjection'},$true)
if (-not $Definition) { throw 'The graphics startup release guard is missing.' }
. ([scriptblock]::Create($Definition.Extent.Text))

# Inspect executable call sites, excluding function definitions and comments.
$TopLevelCommands = @($Ast.FindAll({param($Node) $Node -is [Management.Automation.Language.CommandAst]},$true) | Where-Object {
    $Ancestor = $_.Parent
    while ($Ancestor -and $Ancestor -isnot [Management.Automation.Language.FunctionDefinitionAst]) { $Ancestor = $Ancestor.Parent }
    -not $Ancestor
})
$ClientBStarts = @($Ast.FindAll({param($Node)
    $Node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $Node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
    $Node.Left.VariablePath.UserPath -ceq 'ClientB' -and
    $Node.Right.Extent.Text.TrimStart().StartsWith('Start-Process')
},$true))
$Releases = @($TopLevelCommands | Where-Object { $_.GetCommandName() -ceq 'Release-GraphicsAfterInitialRuntimeInjection' })
$BothReady = @($TopLevelCommands | Where-Object { $_.GetCommandName() -ceq 'Wait-ForParticipantAttachmentsReady' })
$DevTools = @($TopLevelCommands | Where-Object { $_.GetCommandName() -ceq 'Wait-ForDevToolsTarget' })
if ($ClientBStarts.Count -ne 1 -or $Releases.Count -ne 1 -or $BothReady.Count -ne 1 -or $DevTools.Count -eq 0) { throw 'The controlled startup ordering is ambiguous.' }
if ($ClientBStarts[0].Extent.EndOffset -ge $Releases[0].Extent.StartOffset -or
    $Releases[0].Extent.EndOffset -ge $BothReady[0].Extent.StartOffset) { throw 'Graphics startup waits for both engines before releasing their initialization dependency.' }
foreach ($Command in $DevTools) {
    if ($Releases[0].Extent.EndOffset -ge $Command.Extent.StartOffset) { throw 'Graphics startup still waits for DevTools before releasing the host.' }
}

function Wait-ForInitialRuntimeInjection {
    param([DateTime]$Deadline)
    if ($Deadline -ne $script:ExpectedDeadline) { throw 'The startup release changed its total deadline.' }
    if (-not (Test-Path -LiteralPath $StartupBarrier -PathType Leaf)) { throw 'Graphics was released before exact runtime injection was proved.' }
    $script:Calls.Add('initial-proof')
    if ($script:RejectInjection) { throw 'controlled-injection-rejected' }
    return [pscustomobject]@{ OwnerLabel=$script:OwnerLabel; TargetPid=303; RuntimeMode='injected-runtime'; RuntimeSha256=('ab' * 32) }
}
function Wait-ForParticipantAttachmentsReady {
    param([DateTime]$Deadline)
    if (Test-Path -LiteralPath $StartupBarrier) { throw 'Both-engine readiness is waiting on a graphics barrier that is still closed.' }
    if (-not (Test-Path -LiteralPath (Join-Path $RunDirectory 'graphics-startup-release.json') -PathType Leaf)) { throw 'The initial graphics release evidence was not persisted before both-engine readiness.' }
    $script:Calls.Add('both-ready')
    return @('App A','App B')
}

foreach ($Owner in @('App A','App B')) {
    $RunDirectory = Join-Path $Data.directory ($Owner -replace ' ','-')
    New-Item -ItemType Directory -Path $RunDirectory | Out-Null
    $StartupBarrier = Join-Path $RunDirectory 'electron-game-overlay-startup-barrier.enabled'
    [IO.File]::WriteAllText($StartupBarrier,'hold')
    $script:Calls = [Collections.Generic.List[string]]::new()
    $script:ExpectedDeadline = [DateTime]::UtcNow.AddSeconds(15)
    $script:OwnerLabel = $Owner
    $script:RejectInjection = $false
    $Evidence = Release-GraphicsAfterInitialRuntimeInjection -Deadline $script:ExpectedDeadline
    if (Test-Path -LiteralPath $StartupBarrier) { throw 'The successful initial injection did not release graphics.' }
    if ($Evidence.OwnerLabel -cne $Owner -or -not $Evidence.GraphicsReleasedUtc) { throw 'The startup release lost its initial injector evidence.' }
    $Saved = Get-Content -LiteralPath (Join-Path $RunDirectory 'graphics-startup-release.json') -Raw | ConvertFrom-Json
    if ($Saved.OwnerLabel -cne $Owner -or $Saved.RuntimeMode -cne 'injected-runtime' -or $Saved.RuntimeSha256 -cne ('ab' * 32)) { throw 'The saved release evidence does not match the proved injector.' }
    $Ready = @(Wait-ForParticipantAttachmentsReady -Deadline $script:ExpectedDeadline)
    if (($script:Calls -join ',') -cne 'initial-proof,both-ready' -or $Ready.Count -ne 2) { throw 'The startup barrier did not precede both-engine readiness.' }
}

$RunDirectory = Join-Path $Data.directory 'rejected'
New-Item -ItemType Directory -Path $RunDirectory | Out-Null
$StartupBarrier = Join-Path $RunDirectory 'electron-game-overlay-startup-barrier.enabled'
[IO.File]::WriteAllText($StartupBarrier,'hold')
$script:Calls = [Collections.Generic.List[string]]::new()
$script:RejectInjection = $true
$Rejected = $false
try { Release-GraphicsAfterInitialRuntimeInjection -Deadline $script:ExpectedDeadline | Out-Null }
catch { if ($_.Exception.Message -cne 'controlled-injection-rejected') { throw }; $Rejected = $true }
if (-not $Rejected -or -not (Test-Path -LiteralPath $StartupBarrier -PathType Leaf) -or
    (Test-Path -LiteralPath (Join-Path $RunDirectory 'graphics-startup-release.json'))) { throw 'Failed initial injection released graphics or published acceptance evidence.' }
Write-Output 'Controlled graphics startup barrier verified without starting a host or app.'
`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Controlled graphics startup barrier verified without starting a host or app\./u);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
