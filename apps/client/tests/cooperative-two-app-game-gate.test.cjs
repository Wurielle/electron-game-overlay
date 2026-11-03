'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const runner = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-cooperative-two-app-game-gate.ps1');
const fixture = path.join(root, 'apps/client/scripts/cooperative-two-app-game-fixture.cjs');

test('Electron acceptance fixture has valid JavaScript syntax without executing Electron or a game', () => {
  const result = spawnSync(process.execPath, ['--check', fixture], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('actual wait guard preserves the caller app and command identity while observing an absent late app', { skip: process.platform !== 'win32' }, () => {
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
foreach($Name in @('Wait-Condition','Command')){
 $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
 if(-not $Definition){throw ('Missing actual wait guard '+$Name)}
 . ([scriptblock]::Create($Definition.Extent.Text))
}
$script:LateError=$false
$script:A=[pscustomobject]@{ready=$true;commandSequence=0}
$script:Reads=[Collections.Generic.List[string]]::new()
$script:CaseDirectory='C:\\isolated-app-scope';$script:Sequence=0
function Read-State {param($Member) $script:Reads.Add($Member);if($Member -eq 'a'){return $script:A};if($script:LateError){return [pscustomobject]@{error='late app failure'}};return $null}
function Start-AppCaller {param([string]$Member) Wait-Condition {(Read-State $Member).ready} ('ready '+$Member) 1}
Start-AppCaller a
if($script:Reads[-1] -cne 'a' -or -not $script:Reads.Contains('b')){throw 'Observer replaced the caller app or failed to check the late app'}
function Save-Json {param($Value,$Path) $script:SavedCommand=$Value}
function Move-Item {param($LiteralPath,$Destination,[switch]$Force) if($Destination -notlike '*a-command.json'){throw 'Command destination changed app'};$script:A.commandSequence=$script:SavedCommand.sequence}
Command a focus main
if($script:SavedCommand.sequence -ne 1 -or $script:SavedCommand.action -cne 'focus' -or $script:Reads[-1] -cne 'a'){throw 'Command acknowledgement read the wrong app'}
$script:LateError=$true
$Rejected=$false
try{Start-AppCaller a}catch{$Rejected=$_.Exception.Message -ceq 'App b failed: late app failure'}
if(-not $Rejected){throw 'Checking the caller skipped a real late-app fault'}
Write-Output 'Caller app readiness and command predicates survived observation of absent/failed B.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Caller app readiness and command predicates survived/u);
});

test('both actual launch sequences foreground the owned game before waiting for rendering', { skip: process.platform !== 'win32' }, () => {
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
$script:FirstMember='a';$script:LateMember='b'
$script:CaseResult=[ordered]@{}
$script:Game=[pscustomobject]@{Id=444}
$script:ForegroundReady=$false
$script:Calls=[Collections.Generic.List[string]]::new()
function Start-Game {$script:Calls.Add('start');$script:ForegroundReady=$false;return [pscustomobject]@{pid=444}}
function Activate-Game {$script:Calls.Add('foreground');$script:ForegroundReady=$true}
function Read-State {param($Member) return [pscustomobject]@{attached=$script:ForegroundReady;rendering=$script:ForegroundReady;targetPid=444}}
function Wait-Condition {param([scriptblock]$Predicate,$Label,$Seconds) $script:Calls.Add('render-proof');if(-not (&$Predicate)){throw 'Rendering proof ran before the owned game could foreground'}}
foreach($Property in @('target','relaunchTarget')){
 $ExpectedLeft='$script:CaseResult.'+$Property
 $Assignment=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.AssignmentStatementAst] -and $Node.Left.Extent.Text -ceq $ExpectedLeft},$true)
 if(-not $Assignment){throw ('Owned launch sequence missing: '+$Property)}
 $Body=$Assignment.Parent
 while($Body -isnot [Management.Automation.Language.StatementBlockAst]){$Body=$Body.Parent}
 $Statements=@($Body.Statements)
 $Index=[array]::IndexOf($Statements,$Assignment)
 if($Index -lt 0 -or $Index+2 -ge $Statements.Count){throw 'Incomplete owned launch sequence'}
 $Phase=[scriptblock]::Create(($Statements[$Index..($Index+2)]|ForEach-Object{$_.Extent.Text}) -join [Environment]::NewLine)
 $script:Calls.Clear()
 &$Phase
 if(($script:Calls -join ',') -cne 'start,foreground,render-proof' -or $script:CaseResult.$Property.pid -ne 444){throw 'Owned launch identity/foreground/render ordering changed'}
}
Write-Output 'Initial and survivor-relaunch source sequences foreground before authenticated rendering.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Initial and survivor-relaunch source sequences foreground/u);
});

test('actual foreground waiter retries transient owned HWNDs, times out safely, and aborts on target exit', { skip: process.platform !== 'win32' }, () => {
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
foreach($Name in @('Wait-Condition','Activate-Game')){
 $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
 if(-not $Definition){throw ('Missing actual owned foreground guard '+$Name)}
 . ([scriptblock]::Create($Definition.Extent.Text))
}
# Constant test doubles; no native screen/input methods exist in this type.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class EgoCooperativeGameInput {
 public static List<long> Activated=new List<long>();
 public static bool OwnedWindow(IntPtr h,int pid) { return pid==444&&h!=IntPtr.Zero&&h.ToInt64()!=9; }
 public static bool LargeEnough(IntPtr h,int width,int height) { if(width!=640||height!=540)throw new Exception("Calibration changed");return h.ToInt64()!=1; }
 public static bool Activate(IntPtr h) { Activated.Add(h.ToInt64());return h.ToInt64()!=2; }
 public static bool Foreground(IntPtr h) { return h.ToInt64()==3; }
}
'@
function Read-State {param($Member) return $null}
$script:CaseDirectory='isolated-owned-window-test'
function New-GameDouble([string]$Mode){
 $Game=[pscustomobject]@{Id=444;HasExited=$false;MainWindowHandle=[IntPtr]::Zero;RefreshCount=0;Mode=$Mode}
 $Game|Add-Member -MemberType ScriptMethod -Name Refresh -Value {
  $this.RefreshCount++
  if($this.Mode -eq 'exit'){$this.HasExited=$true;$this.MainWindowHandle=[IntPtr]::new(3);return}
  if($this.Mode -eq 'never'){$this.MainWindowHandle=[IntPtr]::new(2);return}
  $Handles=@(0,1,9,2,4,3)
  $this.MainWindowHandle=[IntPtr]::new($Handles[[Math]::Min($this.RefreshCount-1,5)])
 }
 return $Game
}
$script:Game=New-GameDouble transient
Activate-Game 1
if($script:GameHwnd -ne [IntPtr]::new(3) -or $script:Game.RefreshCount -ne 6 -or ([EgoCooperativeGameInput]::Activated -join ',') -cne '2,4,3'){throw 'Transient invalid/small/foreign/failed-activation windows were not safely retried'}
[EgoCooperativeGameInput]::Activated.Clear()
$script:Game=New-GameDouble never
$Clock=[Diagnostics.Stopwatch]::StartNew()
$Rejected=$false;try{Activate-Game 1}catch{$Rejected=$_.Exception.Message -like 'Timed out:*verified foreground ownership*'}
$Clock.Stop()
if(-not $Rejected -or $script:GameHwnd -ne [IntPtr]::Zero -or [EgoCooperativeGameInput]::Activated.Count -lt 1 -or $Clock.ElapsedMilliseconds -gt 2500){throw 'Failed activation did not time out without publishing a usable window'}
[EgoCooperativeGameInput]::Activated.Clear()
$script:Game=New-GameDouble exit
$Rejected=$false;try{Activate-Game 1}catch{$Rejected=$_.Exception.Message -ceq 'The owned game exited before a foreground-ready window was available.'}
if(-not $Rejected -or $script:Game.RefreshCount -ne 1 -or [EgoCooperativeGameInput]::Activated.Count -ne 0 -or $script:GameHwnd -ne [IntPtr]::Zero){throw 'Exited process allowed a foreground/input attempt'}
Write-Output 'Owned foreground readiness retries, bounded failure and early exit verified.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Owned foreground readiness retries, bounded failure and early exit verified/u);
});

test('game controller parses, compiles its input interop, and refuses ownership of an existing game', {
  skip: process.platform !== 'win32' ? 'PowerShell and Windows interop compilation require Windows' : false,
}, () => {
  // Extract only the controller-owned launch function. The process-start
  // boundary and process inventory are replaced; no executable is launched by
  // this test except the isolated PowerShell interpreter itself.
  const script = `
$ErrorActionPreference = 'Stop'
$Runner = '${runner.replaceAll("'", "''")}'
$Tokens = $null; $Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Runner,[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
$Source = Get-Content -LiteralPath $Runner -Raw
$Interop = [regex]::Match($Source,"(?s)Add-Type -TypeDefinition @'\\r?\\n(.*?)\\r?\\n'@")
if (-not $Interop.Success) { throw 'Input interop source is missing.' }
Add-Type -TypeDefinition $Interop.Groups[1].Value
foreach ($Name in @('Start-Game','Assert-NoRunningGame')) {
    $Definition = $Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
    if (-not $Definition) { throw ('Controller-owned launch function is missing: ' + $Name) }
    . ([scriptblock]::Create($Definition.Extent.Text))
}
$script:Existing = $false
$script:Starts = 0
$script:Games = [Collections.ArrayList]::new()
$GameExecutable = 'C:\\owned-test\\Gun Frog.exe'
function Get-Process { param([string]$Name) if ($script:Existing) { [pscustomobject]@{Id=777} } }
function Start-OwnedProcess {
    param([Diagnostics.ProcessStartInfo]$StartInfo,[string]$Label)
    $script:Starts++
    if ($StartInfo.FileName -cne $GameExecutable -or $StartInfo.UseShellExecute -or
        $StartInfo.WorkingDirectory -cne (Split-Path -Parent $GameExecutable) -or
        $StartInfo.Environment['SteamAppId'] -cne '3173130' -or
        $StartInfo.Environment['SteamGameId'] -cne '3173130') { throw 'Unexpected game launch identity/environment.' }
    return [pscustomobject]@{Id=123;StartTime=[DateTime]::UtcNow}
}
$Identity = @(Start-Game)
if ($script:Starts -ne 1 -or $script:Games.Count -ne 1 -or $Identity[-1].pid -ne 123 -or
    $Identity[-1].creationTime100ns -notmatch '^[1-9][0-9]*$') { throw 'Controller did not retain the owned game identity.' }
$script:Existing = $true
$Rejected = $false
try { Start-Game | Out-Null } catch { $Rejected = $_.Exception.Message -like '*already running*' }
if (-not $Rejected -or $script:Starts -ne 1 -or $script:Games.Count -ne 1) { throw 'An existing game was adopted or another launch attempted.' }
Write-Output 'Controller ownership and interop verified without launching a game.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Controller ownership and interop verified without launching a game\./u);
});
