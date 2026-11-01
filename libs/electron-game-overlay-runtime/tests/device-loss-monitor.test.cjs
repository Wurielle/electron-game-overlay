'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const scripts = path.resolve(__dirname, '../scripts');
const quote = value => `'${value.replaceAll("'", "''")}'`;

test('executes actual diagnostic filters, exact identity and incremental owned-log reader without observing any process', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-device-loss-unit-'));
  const fixture = path.join(temporary, 'unit.ps1');
  fs.writeFileSync(fixture, `
$ErrorActionPreference = 'Stop'
$FunctionsOnly = $false
. ${quote(path.join(scripts, 'device-loss-monitor.ps1'))} -FunctionsOnly
function Require($Condition, $Message) { if (-not $Condition) { throw $Message } }
Require (-not $FunctionsOnly) 'helper import clobbered controller FunctionsOnly parameter'
$identity = [pscustomobject]@{ ProcessId = 1234; ExecutablePath = 'C:\\owned\\target.exe'; CreationTime100ns = '134380192787113523' }
$same = [pscustomobject]@{ ProcessId = 1234; ExecutablePath = 'c:\\OWNED\\target.exe'; CreationTime100ns = '134380192787113523' }
Require (Test-EgoDiagnosticIdentity $identity $same) 'Windows path case must not change identity'
foreach ($property in @('ProcessId', 'ExecutablePath', 'CreationTime100ns')) {
    $wrong = $same.PSObject.Copy()
    if ($property -eq 'ProcessId') { $wrong.$property = 1235 } else { $wrong.$property = 'different' }
    Require (-not (Test-EgoDiagnosticIdentity $identity $wrong)) "wrong $property accepted"
}
foreach ($line in @('DXGI_ERROR_DEVICE_HUNG', 'error 0x887A0005', 'Device has been lost', 'DeviceRemoved')) {
    Require ($null -ne (Find-EgoDeviceLossLine $line)) "real device-loss marker missed: $line"
}
foreach ($line in @('GetDeviceRemovedReason returned 0x00000000', 'DeviceRemovedReason = S_OK', 'Created device successfully', 'gpu usage 10%')) {
    Require ($null -eq (Find-EgoDeviceLossLine $line)) "non-fault triggered: $line"
}
Require ((Find-EgoDeviceLossLine ('DXGI_ERROR_DEVICE_REMOVED' + [char]10 + 'DXGI_ERROR_DEVICE_HUNG')) -ceq 'DXGI_ERROR_DEVICE_REMOVED') 'first fault must win'
$health = 'EGO_DEVICE_HEALTH ' + (@{ ProcessId=1234; ExecutablePath=$identity.ExecutablePath; CreationTime100ns=$identity.CreationTime100ns; Status='device-hung' } | ConvertTo-Json -Compress)
Require ($null -ne (Get-EgoDeviceHealthMarker $health $identity)) 'exact device-health marker missed'
Require ($null -eq (Get-EgoDeviceHealthMarker ($health.Replace('1234','1235')) $identity)) 'foreign health marker accepted'
function EventXml($Data, $Record = 51, $Time = '2026-11-01T12:00:01.0000000Z') {
    return "<Event><System><Provider Name='nvlddmkm'/><EventRecordID>$Record</EventRecordID><TimeCreated SystemTime='$Time'/><Execution ProcessID='1234'/></System><EventData>$Data</EventData></Event>"
}
$armed = [DateTime]::Parse('2026-11-01T12:00:00Z')
Require ($null -eq (Get-EgoScopedGpuEvent (EventXml '') $identity 50 $armed)) 'System.Execution PID is not target attribution'
Require ($null -eq (Get-EgoScopedGpuEvent (EventXml "<Data Name='ProcessId'>9999</Data>") $identity 50 $armed)) 'foreign event accepted'
Require ($null -eq (Get-EgoScopedGpuEvent (EventXml "<Data Name='ProcessId'>1234</Data>" 49) $identity 50 $armed)) 'old event record accepted'
Require ($null -eq (Get-EgoScopedGpuEvent (EventXml "<Data Name='ProcessId'>1234</Data>" 51 '2026-11-01T11:59:59Z') $identity 50 $armed)) 'pre-arm event accepted'
Require ($null -ne (Get-EgoScopedGpuEvent (EventXml "<Data Name='ProcessId'>0x4d2</Data>") $identity 50 $armed)) 'exact scoped hexadecimal event missed'
$log = ${quote(path.join(temporary, 'owned.log'))}
$state = @{ Offset=0L; Pending=''; Truncated=$false }
[IO.File]::WriteAllText($log, 'DXGI_ERROR_DEVICE_')
Require (@(Read-EgoDiagnosticTail $state $log).Count -eq 0) 'incomplete marker treated as line'
[IO.File]::AppendAllText($log, ('HUNG' + [char]10 + 'normal' + [char]10))
$lines = @(Read-EgoDiagnosticTail $state $log)
Require ($lines.Count -eq 2 -and $lines[0] -ceq 'DXGI_ERROR_DEVICE_HUNG') 'split write lost or duplicated first marker'
Require (@(Read-EgoDiagnosticTail $state $log).Count -eq 0) 'tail reread old fault'
[IO.File]::WriteAllText($log, ('reset' + [char]10))
Require ((@(Read-EgoDiagnosticTail $state $log))[0] -ceq 'reset' -and $state.Truncated) 'truncation not recorded'
$jsonPath = ${quote(path.join(temporary, 'atomic.json'))}
Write-EgoDiagnosticJson $jsonPath @{ Count=1 }
Write-EgoDiagnosticJson $jsonPath @{ Count=2 }
Require (((Read-EgoDiagnosticText $jsonPath) | ConvertFrom-Json).Count -eq 2) 'atomic state publication failed'
'DIAGNOSTIC_PURE_BEHAVIOR_PASS'
`);
  try {
    const output = execFileSync('pwsh.exe', ['-NoProfile', '-File', fixture], { encoding: 'utf8', timeout: 30000 });
    assert.match(output, /DIAGNOSTIC_PURE_BEHAVIOR_PASS/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('all tooling/seam scripts parse; opt-in monitor arms before first gate input and joins before producer cleanup', () => {
  const names = ['device-loss-monitor.ps1', 'run-client-sdk-input-gate.ps1',
    'test-cases/gun-frog-client-sdk.ps1', 'test-cases/d3d11-client-sdk-device-loss-monitor.ps1',
    'test-cases/gun-frog-client-sdk-device-loss-monitor.ps1', 'device-loss-monitor-self-test.ps1',
    'test-cases/device-loss-monitor-synthetic-self-test.ps1'];
  const command = names.map(name => `$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile(${quote(path.join(scripts, name))},[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors.Message -join ';')}`).join('\n');
  execFileSync('pwsh.exe', ['-NoProfile', '-Command', command], { timeout: 30000, stdio: 'pipe' });
  const controlled = fs.readFileSync(path.join(scripts, names[1]), 'utf8');
  const game = fs.readFileSync(path.join(scripts, names[2]), 'utf8');
  assert(controlled.indexOf('$DeviceLossMonitor = Start-EgoDeviceLossMonitor') < controlled.indexOf('::SendControlI()'));
  assert(controlled.indexOf('Stop-EgoDeviceLossMonitor $DeviceLossMonitor') < controlled.indexOf('Stop-AttemptElectronProcesses -UserData $UserData'));
  assert(game.indexOf('$DeviceLossMonitor = Start-EgoDeviceLossMonitor') < game.indexOf('REAL CLIENT GUN FROG INPUT GATE READY'));
  assert(game.indexOf('Stop-EgoDeviceLossMonitor $DeviceLossMonitor') < game.indexOf('$CleanupIds = @('));
});

test('executes the synthetic capture evidence oracle and rejects incomplete, late, foreign and invalid dump results', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-device-loss-oracle-'));
  const dump = path.join(temporary, 'first-device-loss.dmp');
  const bytes = Buffer.alloc(64); bytes.write('MDMP'); fs.writeFileSync(dump, bytes);
  const fixture = path.join(temporary, 'oracle.ps1');
  fs.writeFileSync(fixture, `
$ErrorActionPreference = 'Stop'
. ${quote(path.join(scripts, 'device-loss-monitor-self-test.ps1'))} -SelfTestFunctionsOnly
$identity = [pscustomobject]@{ ProcessId=1234; ExecutablePath='C:\\owned\\child.exe'; CreationTime100ns='134380192787113523' }
function New-Report {
    return [pscustomobject]@{
        Status='captured'; RootCauseClaimed=$false; Identity=$identity
        Dump=[pscustomobject]@{ Complete=$true; Bytes=64 }; DumpPath=${quote(dump)}
        FirstFault=[pscustomobject]@{ Source='identity-bound-device-health'; Marker=[pscustomobject]@{
            ProcessId=1234; ExecutablePath=$identity.ExecutablePath; CreationTime100ns=$identity.CreationTime100ns
            Synthetic=$true; EvidenceKind='synthetic-monitor-self-test'; Status='device-hung'
        } }
        FirstFaultObservedAtUtc='2026-11-01T12:00:00.040Z'
        DumpStartedAtUtc='2026-11-01T12:00:00.050Z'; DumpCompletedAtUtc='2026-11-01T12:00:00.150Z'
    }
}
$published=[DateTime]::Parse('2026-11-01T12:00:00Z')
$valid=Assert-EgoSyntheticDumpEvidence (New-Report) $identity $published $true
if (-not $valid.Synthetic -or $valid.GenuineGpuLossObserved -or $valid.DumpStartMilliseconds -ne 50) { throw 'synthetic boundary missing' }
$roundTripped=(New-Report) | ConvertTo-Json -Depth 10 | ConvertFrom-Json
$valid=Assert-EgoSyntheticDumpEvidence $roundTripped $identity $published $true
if ($valid.DumpStartMilliseconds -ne 50 -or $valid.FirstFaultDetectionMilliseconds -ne 40) { throw 'JSON DateTime conversion lost precision or UTC Kind' }
foreach ($case in @('incomplete','foreign','late','realclaim','notSynthetic','deadchild')) {
    $r=New-Report; $alive=$true
    switch ($case) {
        incomplete { $r.Dump.Complete=$false }
        foreign { $r.FirstFault.Marker.CreationTime100ns='different' }
        late { $r.DumpStartedAtUtc='2026-11-01T12:01:00Z' }
        realclaim { $r.RootCauseClaimed=$true }
        notSynthetic { $r.FirstFault.Marker.Synthetic=$false }
        deadchild { $alive=$false }
    }
    $rejected=$false
    try { $null=Assert-EgoSyntheticDumpEvidence $r $identity $published $alive } catch { $rejected=$true }
    if (-not $rejected) { throw "invalid $case evidence accepted" }
}
[IO.File]::WriteAllBytes(${quote(dump)}, [byte[]]::new(64))
$rejected=$false
try { $null=Assert-EgoSyntheticDumpEvidence (New-Report) $identity $published $true } catch { $rejected=$true }
if (-not $rejected) { throw 'invalid MDMP signature accepted' }
'SYNTHETIC_EVIDENCE_ORACLE_PASS'
`);
  try {
    const output = execFileSync('pwsh.exe', ['-NoProfile', '-File', fixture], { encoding: 'utf8', timeout: 30000 });
    assert.match(output, /SYNTHETIC_EVIDENCE_ORACLE_PASS/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
