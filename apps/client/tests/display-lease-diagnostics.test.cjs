'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scripts = path.resolve(__dirname, '../../../libs/electron-game-overlay-runtime/scripts');
const quote = value => value.replaceAll("'", "''");
function powershell(script, executable = 'powershell.exe') {
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('scoped visual controllers retain their own launchers and require the shared display guard by default', () => {
  for (const name of ['run-native-pointer-gate.ps1', 'run-client-sdk-input-gate.ps1', 'run-client-sdk-input-capabilities-gate.ps1']) {
    const source = fs.readFileSync(path.join(scripts, name), 'utf8');
    assert.ok(source.includes("'visual-test-display-lease.ps1'"), name);
    assert.match(source, /\$VisualDisplayLease = Enter-VisualTestDisplayLease /u, name);
    assert.match(source, /Exit-VisualTestDisplayLease \$VisualDisplayLease /u, name);
  }
  const source = fs.readFileSync(path.join(scripts, 'run-client-sdk-input-gate.ps1'), 'utf8');
  assert.ok(source.indexOf('if ($FunctionsOnly) {') < source.indexOf("'visual-test-display-lease.ps1'"));
});

test('whole display wrapper invokes a real sentinel script and saves a report under fake ON APIs', { skip: process.platform !== 'win32' }, () => {
  const build = path.resolve(scripts, '../../../build');
  fs.mkdirSync(build, { recursive: true });
  const directory = fs.mkdtempSync(path.join(build, 'display-lease-integration-'));
  const sentinel = path.join(directory, 'sentinel.ps1');
  const output = path.join(directory, 'sentinel.txt');
  const report = path.join(directory, 'report.json');
  const masterReport = path.join(directory, 'master.json');
  const stop = path.join(directory, 'master.stop');
  const deadlineReport = path.join(directory, 'deadline.json');
  fs.writeFileSync(sentinel, "param([string]$Token,[string]$OutputPath)\nif($Token -cne 'exact sentinel'){throw 'Parameters changed'}\n[IO.File]::WriteAllText($OutputPath,$Token)\n");
  try {
    assert.match(powershell(`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class EgoDisplayPowerRead {
 public static int State=1,Reads=0; public static string StopFile=null;
 public static object Read(string name,string setting,int timeout){Reads++;if(Reads==2&&!String.IsNullOrEmpty(StopFile))System.IO.File.WriteAllText(StopFile,"stop");return new Dictionary<string,object>{{"initialNotificationReceived",true},{"state",State},{"stateName",State==1?"on":"off"}};}
 public static object WaitForOn(string name,string setting,int timeout){return Read(name,setting,timeout);}
}
public sealed class EgoVisualDisplayLease : IDisposable {
 public static int Disposed=0;
 public bool ClearSucceeded {get;private set;}
 public bool CloseSucceeded {get;private set;}
 public int ClearError {get{return 0;}}
 public int CloseError {get{return 0;}}
 public static EgoVisualDisplayLease Create(){return new EgoVisualDisplayLease();}
 public void Dispose(){Disposed++;ClearSucceeded=true;CloseSucceeded=true;}
}
'@
& '${quote(path.join(scripts, 'run-with-display-lease.ps1'))}' -TestScript '${quote(sentinel)}' -TestParametersJson '${quote(JSON.stringify({ Token: 'exact sentinel', OutputPath: output }))}' -EvidencePath '${quote(report)}'
if(-not (Test-Path -LiteralPath '${quote(report)}') -or -not (Test-Path -LiteralPath '${quote(output)}')){throw 'Whole wrapper silently returned without test/report'}
$Saved=Get-Content -LiteralPath '${quote(report)}' -Raw|ConvertFrom-Json
if($Saved.status -cne 'passed' -or -not $Saved.testAttempted -or $Saved.during.state -ne 1 -or -not $Saved.clearSucceeded -or -not $Saved.closeSucceeded -or [EgoVisualDisplayLease]::Disposed -ne 1){throw 'Whole wrapper did not execute and release exactly once'}
[EgoDisplayPowerRead]::State=0;[EgoDisplayPowerRead]::Reads=0;[EgoDisplayPowerRead]::StopFile='${quote(stop)}'
& '${quote(path.join(scripts, 'run-with-display-lease.ps1'))}' -MasterLease -HoldSeconds 1800 -StopFile '${quote(stop)}' -EvidencePath '${quote(masterReport)}'
$Master=Get-Content -LiteralPath '${quote(masterReport)}' -Raw|ConvertFrom-Json
if($Master.status -cne 'completed' -or $Master.mode -cne 'matrix-master' -or $Master.testAttempted -or $Master.master.visualAcceptanceClaimed -or $Master.master.powerOnAtArm -or $Master.during.state -ne 0 -or $Master.master.stopReason -cne 'stop-file' -or -not $Master.clearSucceeded -or -not $Master.closeSucceeded -or [EgoVisualDisplayLease]::Disposed -ne 2){throw 'Master did not arm separately while OFF and release on its owned stop file'}
[EgoDisplayPowerRead]::Reads=0;[EgoDisplayPowerRead]::StopFile=$null
& '${quote(path.join(scripts, 'run-with-display-lease.ps1'))}' -MasterLease -HoldSeconds 1 -StopFile '${quote(path.join(directory, 'deadline.stop'))}' -EvidencePath '${quote(deadlineReport)}'
$Deadline=Get-Content -LiteralPath '${quote(deadlineReport)}' -Raw|ConvertFrom-Json
if($Deadline.status -cne 'completed' -or $Deadline.master.stopReason -cne 'deadline' -or $Deadline.master.elapsedMs -lt 900 -or $Deadline.testAttempted -or -not $Deadline.clearSucceeded -or -not $Deadline.closeSucceeded -or [EgoVisualDisplayLease]::Disposed -ne 3){throw 'Master did not release at its bounded deadline'}
Write-Output 'Whole wrapper executed sentinel and saved report without native calls.'
`, 'pwsh.exe'), /Whole wrapper executed sentinel and saved report without native calls/u);
    assert.equal(fs.readFileSync(output, 'utf8'), 'exact sentinel');
  } finally {
    assert.ok(path.resolve(directory).startsWith(build + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('actual display observer and lease declarations compile without reading power or creating requests', { skip: process.platform !== 'win32' }, () => {
  assert.match(powershell(`
$ErrorActionPreference='Stop'
foreach($Path in @('${quote(path.join(scripts, 'read-display-power-state.ps1'))}','${quote(path.join(scripts, 'run-with-display-lease.ps1'))}')){
 $Tokens=$null;$Errors=$null
 $Ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$Tokens,[ref]$Errors)
 if($Errors){throw $Errors}
 $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.StringConstantExpressionAst] -and ($Node.Value.Contains('public static class EgoDisplayPowerRead {') -or $Node.Value.Contains('public sealed class EgoVisualDisplayLease : IDisposable {'))},$true)
 if(-not $Definition){throw 'Missing actual display declarations'}
 Add-Type -TypeDefinition $Definition.Value
}
# Neither Read nor WaitForOn nor Create is called.
Write-Output 'Actual display diagnostics compiled without native calls.'
`), /Actual display diagnostics compiled without native calls/u);
});

test('actual lease control flow refuses an off display, passes exact parameters and always releases on strict-test failure', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-display-lease-'));
  try {
    assert.match(powershell(`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class EgoDisplayPowerRead {
 public static int State=0;
 public static object Read(string name,string setting,int timeout) {return new Dictionary<string,object>{{"initialNotificationReceived",true},{"state",State},{"stateName",State==1?"on":"off"}};}
 public static object WaitForOn(string name,string setting,int timeout) {return Read(name,setting,timeout);}
}
public sealed class EgoVisualDisplayLease : IDisposable {
 public static int Created=0,Disposed=0;
 public bool ClearSucceeded {get;private set;}
 public bool CloseSucceeded {get;private set;}
 public int ClearError {get{return 0;}}
 public int CloseError {get{return 0;}}
 public static EgoVisualDisplayLease Create(){Created++;return new EgoVisualDisplayLease();}
 public void Dispose(){Disposed++;ClearSucceeded=true;CloseSucceeded=true;}
}
'@
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${quote(path.join(scripts, 'run-with-display-lease.ps1'))}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
$TopTry=@($Ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.TryStatementAst]})[-1]
if(-not $TopTry){throw 'Missing actual lease operation'}
$SaveFunction=$Ast.Find({param($Node)$Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Save-EgoDisplayLeaseEvidence'},$true)
if(-not $SaveFunction){throw 'Missing actual lease evidence writer'}
. ([scriptblock]::Create($SaveFunction.Extent.Text))
$Operation=[scriptblock]::Create($TopTry.Extent.Text)
$script:TestCalls=0;$script:FailTest=$false
function Invoke-ConstantVisualTest {param([string]$Token) if($Token -cne 'exact'){throw 'Parameters changed'};$script:TestCalls++;if($script:FailTest){throw 'original strict pixel failure'}}
$Parameters=@{Token='exact'};$TestScript='Invoke-ConstantVisualTest';$HoldSeconds=0;$PowerTimeoutMs=1000
$EvidencePath='${quote(path.join(directory, 'lease.json'))}';$Lease=$null
$Report=[ordered]@{status='failed';testAttempted=$false}
$Caught=$null;try{& $Operation}catch{$Caught=$_.Exception.Message}
if($Caught -notlike 'Visual test requires an observed display-on notification*' -or $script:TestCalls -ne 0 -or $Report.testAttempted -or $Report.status -cne 'display-precondition-unavailable' -or [EgoVisualDisplayLease]::Disposed -ne 1 -or -not $Report.clearSucceeded -or -not $Report.closeSucceeded){throw 'Off-display precondition ran a test or failed to release the request'}
[EgoDisplayPowerRead]::State=1;$Lease=$null;$Report=[ordered]@{status='failed';testAttempted=$false}
& $Operation
if($Report.status -cne 'passed' -or -not $Report.testAttempted -or $script:TestCalls -ne 1 -or [EgoVisualDisplayLease]::Disposed -ne 2){throw 'On-display operation did not execute exactly one parameterized test and release'}
$script:FailTest=$true;$Lease=$null;$Report=[ordered]@{status='failed';testAttempted=$false}
$Caught=$null;try{& $Operation}catch{$Caught=$_.Exception.Message}
if($Caught -cne 'original strict pixel failure' -or $Report.error -cne $Caught -or $Report.status -cne 'failed' -or [EgoVisualDisplayLease]::Disposed -ne 3 -or -not $Report.clearSucceeded -or -not $Report.closeSucceeded){throw 'Strict-test failure was masked or its power request survived'}
$Tokens=$null;$Errors=$null
$GuardAst=[Management.Automation.Language.Parser]::ParseFile('${quote(path.join(scripts, 'visual-test-display-lease.ps1'))}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
foreach($Definition in $GuardAst.FindAll({param($Node)$Node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($Definition.Extent.Text))}
[EgoDisplayPowerRead]::State=0;$GuardReport=[ordered]@{};$Caught=$null
try{Enter-VisualTestDisplayLease $GuardReport|Out-Null}catch{$Caught=$_.Exception.Message}
if($Caught -notlike 'Visual test display precondition unavailable*' -or $GuardReport.displayPrecondition.status -cne 'unavailable' -or -not $GuardReport.displayPrecondition.clearSucceeded -or -not $GuardReport.displayPrecondition.closeSucceeded -or [EgoVisualDisplayLease]::Disposed -ne 4){throw 'Shared guard accepted an off display or leaked its failed request'}
[EgoDisplayPowerRead]::State=1;$GuardReport=[ordered]@{}
$GuardLease=Enter-VisualTestDisplayLease $GuardReport
if($GuardReport.displayPrecondition.status -cne 'on' -or [EgoVisualDisplayLease]::Disposed -ne 4){throw 'Shared guard did not retain the on-display lease'}
Exit-VisualTestDisplayLease $GuardLease $GuardReport
if(-not $GuardReport.displayPrecondition.clearSucceeded -or -not $GuardReport.displayPrecondition.closeSucceeded -or [EgoVisualDisplayLease]::Disposed -ne 5){throw 'Shared guard did not release at visual-test cleanup'}
Write-Output 'Display precondition, exact test arguments and failure cleanup verified without native calls.'
`), /Display precondition, exact test arguments and failure cleanup verified without native calls/u);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
