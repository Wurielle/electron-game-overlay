'use strict';
// Execute the controller's actual assertion phase under fake input interop.
// No desktop, target process, native input API or complete runtime gate runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const controller = path.resolve(__dirname, '../../../libs/electron-game-overlay-runtime/scripts/run-client-sdk-input-gate.ps1');
const quote = value => value.replaceAll("'", "''");

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`settled action capture excludes release-shortcut events without hiding missing or duplicate input under ${shell}`, { skip: process.platform !== 'win32' }, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-action-log-boundary-'));
    const liveLog = path.join(directory, 'client.stdout.log');
    const script = String.raw`
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${quote(controller)}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
foreach($Name in @('Get-ClientLogText','Assert-MarkerCount','Assert-ExactLineCount','Assert-RegexCount','Assert-MarkerBetween')){
 $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -ceq $Name},$true)
 if(-not $Definition){throw ('Missing assertion helper '+$Name)}
 . ([scriptblock]::Create($Definition.Extent.Text))
}
$Capture=@($Ast.FindAll({param($Node) $Node -is [Management.Automation.Language.AssignmentStatementAst] -and $Node.Left.Extent.Text -ceq '$ActionLogSnapshot'},$true))
if($Capture.Count -ne 1){throw 'Expected one immutable feature-action snapshot assignment'}
$Capture=$Capture[0];$Body=$Capture.Parent
while($Body -and $Body -isnot [Management.Automation.Language.StatementBlockAst]){$Body=$Body.Parent}
if(-not $Body){throw 'The capture lost its executable assertion block'}
$Statements=@($Body.Statements);$Start=[array]::IndexOf($Statements,$Capture)
if($Start -lt 3 -or $Statements[$Start+1].Extent.Text -cne '[ReShadeClientSdkGate.NativeInputMethods]::SendControlI()'){
 throw 'Action capture must precede the release shortcut in the actual controller'
}
$Settle=@($Statements[0..($Start-1)]|Where-Object{$_.Extent.Text -ceq 'Start-Sleep -Milliseconds 500'}|Select-Object -Last 1)
$Foreground=@($Statements[0..($Start-1)]|Where-Object{$_.Extent.Text.Contains('An Electron backing window stole foreground ownership during intercepted interaction.')})
$Oracle=@($Statements[0..($Start-1)]|Where-Object{$_.Extent.Text.Contains('The game input oracle changed during overlay interaction.')})
if($Settle.Count -ne 1 -or $Foreground.Count -ne 1 -or $Oracle.Count -ne 1 -or
 $Settle[0].Extent.EndOffset -ge $Foreground[0].Extent.StartOffset -or
 $Foreground[0].Extent.EndOffset -ge $Oracle[0].Extent.StartOffset -or
 $Oracle[0].Extent.EndOffset -ge $Capture.Extent.StartOffset){throw 'Capture must remain after settle, foreground and game-oracle checks'}
$Stop=-1
for($Index=$Start+1;$Index -lt $Statements.Count;$Index++){
 if($Statements[$Index].Extent.Text.StartsWith('[void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(',[StringComparison]::Ordinal)){$Stop=$Index;break}
}
if($Stop -le $Start+2){throw 'Cannot identify the complete feature assertion phase before released game input'}
$Phase=[scriptblock]::Create(($Statements[$Start..($Stop-1)]|ForEach-Object{$_.Extent.Text}) -join [Environment]::NewLine)
Add-Type -TypeDefinition @'
using System.IO;
namespace ReShadeClientSdkGate {
 public static class NativeInputMethods {
  public static string LogPath, ShortcutSuffix;
  public static int ShortcutCalls;
  public static void SendControlI(){ShortcutCalls++;File.AppendAllText(LogPath,ShortcutSuffix);}
 }
}
'@
$ClientStdout='${quote(liveLog)}';$ClientProcess=[pscustomobject]@{Id=123}
[ReShadeClientSdkGate.NativeInputMethods]::LogPath=$ClientStdout
function Wait-ForClientMarker {
 param($Path,$ClientProcess,$Marker,$Deadline)
 if($Path -cne $ClientStdout -or $Marker -cne 'HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false'){throw 'Unexpected shortcut acknowledgement wait'}
 [IO.File]::AppendAllText($Path,$Marker+[Environment]::NewLine)
}
function New-ControlledActionLog([string]$Mode){
 $Lines=[Collections.Generic.List[string]]::new()
 foreach($Marker in @('RESHADE_CLIENT_RUNTIME_STAGED','RESHADE_CLIENT_INJECTOR_STARTED','RESHADE_CLIENT_TARGET_CONNECTED','RESHADE_CLIENT_INJECTOR_RETURNED','HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true')){$Lines.Add($Marker)}
 for($Click=0;$Click -lt 2;$Click++){
  foreach($Event in @('mousedown','mouseup','click')){$Lines.Add('HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC '+$Event+' target=hudhook-status-input-target @ 89,32')}
  foreach($Event in @('mousedown','mouseup','click')){$Lines.Add('HUDHOOK_CLIENT_INPUT_DIAGNOSTIC '+$Event+' target=hudhook-client-input-target @ 144,130')}
  $Lines.Add('HUDHOOK_CLIENT_INPUT_CLICKED')
 }
 $MainValues=if($Mode -ceq 'legacy'){@('m','m1','m1d')}else{@(' ','  ')}
 $MainKeys=if($Mode -ceq 'legacy'){4}else{3}
 for($Key=0;$Key -lt $MainKeys;$Key++){
  $Lines.Add('HUDHOOK_CLIENT_INPUT_DIAGNOSTIC keydown target=hudhook-client-input-target')
  if($Key -lt $MainValues.Count){$Lines.Add('HUDHOOK_CLIENT_INPUT_DIAGNOSTIC input target=hudhook-client-input-target value="'+$MainValues[$Key]+'"')}
  $Lines.Add('HUDHOOK_CLIENT_INPUT_DIAGNOSTIC keyup target=hudhook-client-input-target')
 }
 $Lines.Add($ExpectedMainValue);$Lines.Add('HUDHOOK_CLIENT_INPUT_ESCAPE_FORWARDED')
 if($Mode -cne 'legacy'){$Lines.Add('HUDHOOK_CLIENT_INPUT_WHEEL deltaY=-120')}
 $StatusValues=if($Mode -ceq 'legacy'){@('s','s1','s1z')}else{@(' ','  ')}
 foreach($Value in $StatusValues){
  $Lines.Add('HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC keydown target=hudhook-status-input-target')
  $Lines.Add('HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input target=hudhook-status-input-target value="'+$Value+'"')
  $Lines.Add('HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC keyup target=hudhook-status-input-target')
 }
 return ($Lines -join [Environment]::NewLine)+[Environment]::NewLine
}
$StatusDown='HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC keydown target=hudhook-status-input-target'
$StatusUp='HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC keyup target=hudhook-status-input-target'
$MainDown='HUDHOOK_CLIENT_INPUT_DIAGNOSTIC keydown target=hudhook-client-input-target'
$MainUp='HUDHOOK_CLIENT_INPUT_DIAGNOSTIC keyup target=hudhook-client-input-target'
$ExpectedInjectorStartCount=1;$Cases=0
foreach($InputMode in @('legacy','wm-input','raw-buffer')){
 $ExpectedMainValue=if($InputMode -ceq 'legacy'){'HUDHOOK_CLIENT_INPUT_VALUE value=m1d'}else{'HUDHOOK_CLIENT_INPUT_VALUE value=  '}
 $ExpectedStatusValue=if($InputMode -ceq 'legacy'){'HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input target=hudhook-status-input-target value="s1z"'}else{'HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input target=hudhook-status-input-target value="  "'}
 foreach($Mutation in @('valid','missing-final-up','duplicate-main-pair','trailing-status-pair','trailing-status-down','trailing-input')){
  $Prefix=New-ControlledActionLog $InputMode
  $Suffix=$StatusDown+[Environment]::NewLine+$StatusUp+[Environment]::NewLine
  switch($Mutation){
   'missing-final-up' {$Position=$Prefix.LastIndexOf($StatusUp,[StringComparison]::Ordinal);if($Position -lt 0){throw 'Missing controlled final keyup'};$Prefix=$Prefix.Remove($Position,$StatusUp.Length);$Suffix=$StatusUp+[Environment]::NewLine}
   'duplicate-main-pair' {$Position=$Prefix.LastIndexOf($StatusUp,[StringComparison]::Ordinal);$Prefix=$Prefix.Insert($Position,$MainDown+[Environment]::NewLine+$MainUp+[Environment]::NewLine)}
   'trailing-status-pair' {$Prefix+=$StatusDown+[Environment]::NewLine+$StatusUp+[Environment]::NewLine}
   'trailing-status-down' {$Prefix+=$StatusDown+[Environment]::NewLine}
   'trailing-input' {$Prefix+=$ExpectedStatusValue+[Environment]::NewLine}
  }
  [IO.File]::WriteAllText($ClientStdout,$Prefix)
  [ReShadeClientSdkGate.NativeInputMethods]::ShortcutSuffix=$Suffix
  [ReShadeClientSdkGate.NativeInputMethods]::ShortcutCalls=0
  $Rejected=$false
  try{. $Phase}catch{
   if($_.Exception.Message -notmatch '^Expected .* (?:line|event|marker)\(s\), found \d+\.$'){throw}
   $Rejected=$true
  }
  if(($Mutation -ceq 'valid') -eq $Rejected){throw ('Unexpected assertion outcome for '+$InputMode+'/'+$Mutation)}
  if([ReShadeClientSdkGate.NativeInputMethods]::ShortcutCalls -ne 1 -or $ActionLogSnapshot -cne $Prefix){throw 'The actual assertion phase did not retain its pre-shortcut snapshot'}
  if(-not ([IO.File]::ReadAllText($ClientStdout).Contains($Suffix+'HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false'))){throw 'The controlled shortcut suffix was not present in the later ACK log'}
  $Cases++
 }
}
Write-Output ('Controlled action assertions passed '+$Cases+' source-extracted cases with no native input calls.')
`;
    try {
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Controlled action assertions passed 18 source-extracted cases with no native input calls\./u);
    } finally {
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
