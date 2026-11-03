'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = path.resolve(__dirname, '../../../libs/electron-game-overlay-runtime/scripts/run-client-sdk-existing-reshade-installation-gate.ps1');

test('existing-installation refusal gate binds arguments to retained OS creation identity and preserves file oracles', () => {
  const source = fs.readFileSync(runner, 'utf8');
  assert.match(source, /\$HostCreationTime100ns = \$HostProcess\.StartTime\.ToUniversalTime\(\)\.ToFileTimeUtc\(\)/);
  assert.ok(source.includes('-CreationTime100ns $HostCreationTime100ns'));
  assert.ok(source.includes('TargetCreationTime100ns = $HostCreationTime100ns'));
  for (const marker of ['Assert-CandidateAndProjectModulesAbsent', 'Assert-ManifestsEqual',
    'target-existing-reshade-installation', '$HostProcess.ExitCode -ne 0']) {
    assert.ok(source.includes(marker), marker);
  }
});

test('isolated existing-installation argument guard rejects changed PID, creation time, missing binding and extra arguments', {
  skip: process.platform !== 'win32' ? 'PowerShell guard execution requires Windows' : false,
}, () => {
  // Extract only the pure guard. Do not dot-source a runner or start a target.
  const script = `
$ErrorActionPreference = 'Stop'
$Tokens=$null; $Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
$Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Assert-InstanceBoundInjectorArguments'},$true)
if(-not $Definition){throw 'Missing instance-bound argument guard'}
. ([scriptblock]::Create($Definition.Extent.Text))
$OwnProcess=Get-Process -Id $PID
$Created=$OwnProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
$Expected=@('game.exe','--pid',[string]$OwnProcess.Id,'--expected-creation-time-100ns',$Created)
$Parameters=@{ProcessName='game.exe';ProcessId=$OwnProcess.Id;CreationTime100ns=$Created}
$Result=@(Assert-InstanceBoundInjectorArguments -Arguments $Expected @Parameters)
if(($Result|ConvertTo-Json -Compress) -cne ($Expected|ConvertTo-Json -Compress)){throw 'Accepted arguments were not retained exactly'}
$Cases=@(
  ,@('game.exe','--pid',[string]($OwnProcess.Id+1),'--expected-creation-time-100ns',$Created)
  ,@('game.exe','--pid',[string]$OwnProcess.Id,'--expected-creation-time-100ns',([uint64]$Created+1).ToString())
  ,@('game.exe','--pid',[string]$OwnProcess.Id)
  ,@('game.exe','--pid',[string]$OwnProcess.Id,'--expected-creation-time-100ns',$Created,'--addon-only')
  ,@('game.exe','--pid',[string]$OwnProcess.Id,'--expected-creation-time-100ns',[uint64]$Created)
  ,@('other.exe','--pid',[string]$OwnProcess.Id,'--expected-creation-time-100ns',$Created)
  ,@('game.exe','--expected-creation-time-100ns',$Created,'--pid',[string]$OwnProcess.Id)
)
foreach($Arguments in $Cases){
  $Rejected=$false
  try{Assert-InstanceBoundInjectorArguments -Arguments $Arguments @Parameters|Out-Null}catch{$Rejected=$true}
  if(-not $Rejected){throw ('Accepted invalid instance-bound arguments: '+($Arguments|ConvertTo-Json -Compress))}
}
foreach($Invalid in @('0','01','-1','18446744073709551616')){
  $Rejected=$false
  try{Assert-InstanceBoundInjectorArguments -Arguments @('game.exe','--pid',[string]$OwnProcess.Id,'--expected-creation-time-100ns',$Invalid) -ProcessName 'game.exe' -ProcessId $OwnProcess.Id -CreationTime100ns $Invalid|Out-Null}catch{$Rejected=$true}
  if(-not $Rejected){throw ('Accepted invalid expected FILETIME: '+$Invalid)}
}
Write-Output 'Retained OS PID and creation FILETIME are required exactly.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Retained OS PID and creation FILETIME are required exactly/);
});
