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

test('controlled initial runtime proof requires matching full-injection metadata, staged mapping, and package bytes', {
  skip: process.platform !== 'win32' ? 'PowerShell initial runtime proof validation requires Windows' : false,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-controlled-initial-runtime-'));
  const sdk = path.join(directory, 'sdk');
  const expectedRuntime = path.join(sdk, 'runtime/win32-x64/reshade/ReShade64.dll');
  const a = path.join(directory, 'stage-a');
  const b = path.join(directory, 'stage-b');
  const userA = path.join(directory, 'user-a');
  const userB = path.join(directory, 'user-b');
  const eventA = path.join(userA, 'logs/compatibility-runs/fixture.events.jsonl');
  const eventB = path.join(userB, 'logs/compatibility-runs/fixture.events.jsonl');
  for (const item of [path.dirname(expectedRuntime), a, b, path.dirname(eventA), path.dirname(eventB)]) {
    fs.mkdirSync(item, { recursive: true });
  }
  // These are hash-only fixture bytes. They are never loaded or executed.
  fs.writeFileSync(expectedRuntime, 'controlled candidate runtime bytes');
  const payloadPath = path.join(directory, 'fixture.json');
  fs.writeFileSync(payloadPath, JSON.stringify({
    runner, sdk, expectedRuntime, a, b, userA, userB, eventA, eventB,
    aLog: path.join(directory, 'a.log'), bLog: path.join(directory, 'b.log'),
    aError: path.join(directory, 'a.err'), bError: path.join(directory, 'b.err'),
    hashGuard: path.join(root, 'libs/electron-game-overlay-runtime/scripts/cooperative-native-evidence.ps1'),
    inputGate: path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-input-gate.ps1'),
  }));
  const script = `
$ErrorActionPreference = 'Stop'
$Data = Get-Content -LiteralPath '${payloadPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
$Tokens = $null; $Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Data.runner,[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
foreach ($Name in @('Wait-ForInitialRuntimeInjection','Get-RunDirectoriesFromClientLog')) {
    $Definition = $Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
    if (-not $Definition) { throw ('The initial runtime proof guard is missing: ' + $Name) }
    . ([scriptblock]::Create($Definition.Extent.Text))
}
$HashAst = [Management.Automation.Language.Parser]::ParseFile($Data.hashGuard,[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
$HashDefinition = $HashAst.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Assert-CooperativeRuntimeHash'},$true)
if (-not $HashDefinition) { throw 'The candidate runtime hash guard is missing.' }
. ([scriptblock]::Create($HashDefinition.Extent.Text))
$LogAst = [Management.Automation.Language.Parser]::ParseFile($Data.inputGate,[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
$LogDefinition = $LogAst.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Get-ClientLogText'},$true)
if (-not $LogDefinition) { throw 'The production client log reader is missing.' }
. ([scriptblock]::Create($LogDefinition.Extent.Text))
# Hash actual fixture bytes through .NET rather than depend on the optional
# Windows PowerShell Get-FileHash script module or return canned hash values.
function Get-FileHash {
    param([string]$LiteralPath,[string]$Algorithm)
    if ($Algorithm -cne 'SHA256') { throw 'The runtime proof requested an unexpected hash algorithm.' }
    $Stream = [IO.File]::OpenRead($LiteralPath)
    $Sha = [Security.Cryptography.SHA256]::Create()
    try { return [pscustomobject]@{ Hash=([BitConverter]::ToString($Sha.ComputeHash($Stream))).Replace('-','') } }
    finally { $Sha.Dispose(); $Stream.Dispose() }
}
function New-ControlledProcess([int]$ProcessId) {
    $Process = [pscustomobject]@{ Id=$ProcessId; HasExited=$false; Modules=@(); RefreshCount=0 }
    $Process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {
        $this.RefreshCount++
        if ($this.Id -eq 303 -and $script:DelayedOwner -and $this.RefreshCount -ge 3) {
            $Owner = $script:DelayedOwner
            $script:DelayedOwner = $null
            Reset-ProofFixture $Owner
        }
    }
    return $Process
}
$HostProcess = New-ControlledProcess 303
$ClientA = New-ControlledProcess 101
$ClientB = New-ControlledProcess 102
$CandidateSdkDist = $Data.sdk
$ClientAStdout = $Data.aLog; $ClientBStdout = $Data.bLog
$ClientAStderr = $Data.aError; $ClientBStderr = $Data.bError
$ClientAUserData = $Data.userA; $ClientBUserData = $Data.userB
$script:Record = $null
$script:DelayedOwner = $null
function Save-Record([string]$EventPath,[object]$Record) {
    $Json = $Record | ConvertTo-Json -Depth 5 -Compress
    # A valid event remains usable while the next appended line is incomplete.
    [IO.File]::WriteAllText($EventPath,$Json + [Environment]::NewLine + '{partial')
}
function Reset-ProofFixture([string]$Owner) {
    $script:DelayedOwner = $null
    foreach ($File in @($Data.aLog,$Data.bLog,$Data.aError,$Data.bError,$Data.eventA,$Data.eventB)) { [IO.File]::WriteAllText($File,'') }
    foreach ($Stage in @($Data.a,$Data.b)) { [IO.File]::WriteAllBytes((Join-Path $Stage 'ReShade64.dll'),[IO.File]::ReadAllBytes($Data.expectedRuntime)) }
    $Stage = if ($Owner -ceq 'App A') { $Data.a } else { $Data.b }
    $Log = if ($Owner -ceq 'App A') { $Data.aLog } else { $Data.bLog }
    $Event = if ($Owner -ceq 'App A') { $Data.eventA } else { $Data.eventB }
    $Line = 'RESHADE_CLIENT_RUNTIME_STAGED directory=' + (ConvertTo-Json -InputObject $Stage -Compress)
    [IO.File]::WriteAllText($Log,$Line + [Environment]::NewLine + 'RESHADE_CLIENT_INJECTOR_RETURNED target=controlled' + [Environment]::NewLine)
    $script:Record = [pscustomobject]@{ schemaVersion=1; type='attachment.injector-returned'; pid=303; timestamp='2026-11-01T00:00:00Z'; data=[pscustomobject]@{ runtimeMode='injected-runtime' } }
    Save-Record $Event $script:Record
    $HostProcess.Modules = @([pscustomobject]@{ ModuleName='ReShade64.dll'; FileName=(Join-Path $Stage 'ReShade64.dll') })
}
function Must-Reject([string]$Label) {
    $Rejected = $false
    try { Wait-ForInitialRuntimeInjection -Deadline ([DateTime]::UtcNow.AddMilliseconds(100)) | Out-Null }
    catch {
        if (-not $_.Exception.Message.StartsWith('The graphics startup barrier could not be released after exact full-runtime injection.')) { throw }
        $Rejected = $true
    }
    if (-not $Rejected) { throw ('Incorrectly accepted initial injection proof: ' + $Label) }
}
[void](Get-FileHash -LiteralPath $Data.expectedRuntime -Algorithm SHA256)
foreach ($Owner in @('App A','App B')) {
    Reset-ProofFixture $Owner
    $Proof = Wait-ForInitialRuntimeInjection -Deadline ([DateTime]::UtcNow.AddSeconds(2))
    $ExpectedProducer = if ($Owner -ceq 'App A') { 101 } else { 102 }
    if ($Proof.OwnerLabel -cne $Owner -or $Proof.ProducerPid -ne $ExpectedProducer -or $Proof.TargetPid -ne 303 -or
        $Proof.RuntimeMode -cne 'injected-runtime' -or $Proof.RuntimeSha256 -cne (Get-FileHash -LiteralPath $Data.expectedRuntime -Algorithm SHA256).Hash.ToLowerInvariant()) {
        throw 'Valid exact full-injection proof was not retained while the other participant log was empty.'
    }
}
Reset-ProofFixture 'App B'
foreach ($File in @($Data.aLog,$Data.bLog,$Data.aError,$Data.bError)) { [IO.File]::WriteAllText($File,'') }
foreach ($File in @($Data.eventA,$Data.eventB)) { Remove-Item -LiteralPath $File -Force }
$HostProcess.Modules = @()
$HostProcess.RefreshCount = 0
$script:DelayedOwner = 'App B'
# Use the real production log helper: an existing empty file yields null in
# Windows PowerShell 5, so casting it in the test would mask the startup race.
$EmptyLogWasNull = $null -eq (Get-ClientLogText -Path $Data.aLog)
$DelayedProof = Wait-ForInitialRuntimeInjection -Deadline ([DateTime]::UtcNow.AddSeconds(3))
if (-not $EmptyLogWasNull -or $DelayedProof.OwnerLabel -cne 'App B' -or $HostProcess.RefreshCount -lt 3) {
    throw 'Initial empty/null logs and zero event files were not safely polled until full proof arrived.'
}
Reset-ProofFixture 'App A'
[IO.File]::WriteAllText($Data.aLog,'RESHADE_CLIENT_INJECTOR_RETURNED target=controlled')
$HostProcess.RefreshCount = 0
$script:DelayedOwner = 'App A'
$DelayedStageProof = Wait-ForInitialRuntimeInjection -Deadline ([DateTime]::UtcNow.AddSeconds(3))
if ($DelayedStageProof.OwnerLabel -cne 'App A' -or $HostProcess.RefreshCount -lt 3) {
    throw 'Structured injection evidence arriving before its staged stdout line did not remain a pending observation.'
}
Reset-ProofFixture 'App A'
$script:Record.pid = 404; Save-Record $Data.eventA $script:Record
Must-Reject 'a structured event for another target PID'
Reset-ProofFixture 'App A'
$script:Record.schemaVersion = 2; Save-Record $Data.eventA $script:Record
Must-Reject 'a structured event with a different schema'
Reset-ProofFixture 'App A'
$script:Record.type = 'attachment.injector-started'; Save-Record $Data.eventA $script:Record
Must-Reject 'a structured startup event without successful injection completion'
Reset-ProofFixture 'App A'
$script:Record.data.runtimeMode = 'existing-runtime'; Save-Record $Data.eventA $script:Record
Must-Reject 'member-only completion without full ReShade injection'
Reset-ProofFixture 'App A'
[IO.File]::WriteAllText($Data.eventA,'')
Must-Reject 'a returned log marker without structured injection evidence'
Reset-ProofFixture 'App A'
[IO.File]::WriteAllText($Data.aLog,'RESHADE_CLIENT_RUNTIME_STAGED directory=' + (ConvertTo-Json -InputObject $Data.a -Compress))
Must-Reject 'structured injection metadata without successful returned marker'
Reset-ProofFixture 'App A'
$HostProcess.Modules = @([pscustomobject]@{ ModuleName='ReShade64.dll'; FileName=(Join-Path $Data.b 'ReShade64.dll') })
Must-Reject 'an equal-hash runtime mapped from another staged directory'
Reset-ProofFixture 'App A'
[IO.File]::WriteAllText((Join-Path $Data.a 'ReShade64.dll'),'different controlled bytes')
Must-Reject 'a mapped staged runtime whose bytes differ from the candidate package'
Reset-ProofFixture 'App A'
$HostProcess.Modules = @(
    [pscustomobject]@{ ModuleName='ReShade64.dll'; FileName=(Join-Path $Data.a 'ReShade64.dll') },
    [pscustomobject]@{ ModuleName='ReShade32.dll'; FileName=(Join-Path $Data.b 'ReShade64.dll') }
)
Must-Reject 'two mapped runtime modules'
Reset-ProofFixture 'App A'
$ExtraStageLine = 'RESHADE_CLIENT_RUNTIME_STAGED directory=' + (ConvertTo-Json -InputObject $Data.b -Compress)
Add-Content -LiteralPath $Data.aLog -Value ([Environment]::NewLine + $ExtraStageLine)
$AmbiguousRejected = $false
try { Wait-ForInitialRuntimeInjection -Deadline ([DateTime]::UtcNow.AddSeconds(1)) | Out-Null }
catch {
    if (-not $_.Exception.Message.Contains('ambiguous staged full-runtime directories')) { throw }
    $AmbiguousRejected = $true
}
if (-not $AmbiguousRejected) { throw 'Ambiguous staged runtime directories were accepted as a pending single-runtime observation.' }
Write-Output 'Controlled initial runtime injection proof verified without loading a DLL or starting a host or app.'
`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Controlled initial runtime injection proof verified without loading a DLL or starting a host or app\./u);
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
