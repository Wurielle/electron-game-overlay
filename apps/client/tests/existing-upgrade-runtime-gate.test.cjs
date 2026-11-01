'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const runner = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-existing-reshade-upgrade-gate.ps1');

test('existing-upgrade gate requires both sealed runtime architectures and retains native-manager seed and preservation checks', () => {
  const source = fs.readFileSync(runner, 'utf8');
  const joinedSource = source.replace(/`\r?\n\s*/g, '');
  for (const name of ['inject.exe', 'inject32.exe', 'ReShade64.dll', 'ReShade32.dll',
    'ReShade64.build.json', 'ReShade32.build.json', 'electron_game_overlay.addon32',
    'electron_game_overlay_runtime.build.json', 'electron_game_overlay_runtime32.build.json']) {
    assert.ok(joinedSource.includes(`$RuntimeDistributionDirectory "${name}"`), name);
  }
  for (const marker of ['--source-sha256 $ProductionAddonHash', '$ManagerResult.addonSha256 -cne $ProductionAddonHash',
    '$SeedAddonHash -cne $ProductionAddonHash', '$SeedMarkerHash', 'Assert-SeedFilesPreserved',
    '$UpgradedRuntimeHash', '"`"--reshade-runtime-dir=$RuntimeDistributionDirectory`""']) {
    assert.ok(source.includes(marker), marker);
  }
});

test('isolated upgrade runtime selection resolves the complete sealed SDK payload accepted by production configuration', {
  skip: process.platform !== 'win32' ? 'PowerShell AST execution requires Windows' : false,
}, () => {
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null; $Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
$RepoRoot='${root.replaceAll("'", "''")}'
$RuntimeRoot=Join-Path $RepoRoot 'libs/electron-game-overlay-runtime'
foreach($Name in @('RuntimeDistributionDirectory','AddonManagerPath','ProductionAddonPath')){
  $Assignment=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.AssignmentStatementAst] -and $Node.Left.Extent.Text -eq ('$'+$Name)},$true)
  if(-not $Assignment){throw ('Missing runtime selection: '+$Name)}
  . ([scriptblock]::Create($Assignment.Extent.Text))
}
[pscustomobject]@{runtime=$RuntimeDistributionDirectory;manager=$AddonManagerPath;addon=$ProductionAddonPath}|ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const selected = JSON.parse(result.stdout);
  const expected = path.join(root, 'libs/electron-game-overlay/dist/runtime/win32-x64/reshade');
  assert.equal(selected.runtime, expected);
  assert.equal(selected.manager, path.join(expected, 'electron_game_overlay_reshade_manager.exe'));
  assert.equal(selected.addon, path.join(expected, 'electron_game_overlay.addon64'));
  const { createReShadeLaunchConfig } = require('../../../libs/electron-game-overlay/dist/lib/reshade-launcher.js');
  const config = createReShadeLaunchConfig({ runtimeDirectory: selected.runtime });
  assert.equal(config.runtimeDirectory, expected);
  assert.equal(config.x86InjectorPath, path.join(expected, 'inject32.exe'));
});

test('all upgrade attachment phases retain authoritative PID, image and creation FILETIME', {
  skip: process.platform !== 'win32' ? 'PowerShell AST execution requires Windows' : false,
}, () => {
  const source = fs.readFileSync(runner, 'utf8');
  assert.match(source, /\$HostCreationTime100ns = \$HostProcess\.StartTime\.ToUniversalTime\(\)\.ToFileTimeUtc\(\)/);
  for (const phase of ['initial', 'official-wait', 'participant']) {
    assert.ok(source.includes(`@BoundTargetIdentity -Phase ${phase}`), phase);
  }
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null; $Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
foreach($Name in @('Get-UpgradeBoundArguments','Assert-UpgradeBoundArguments','Assert-UpgradePrearmedSelection')){
  $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
  if(-not $Definition){throw ('Missing guard: '+$Name)}
  . ([scriptblock]::Create($Definition.Extent.Text))
}
$OwnProcess=Get-Process -Id $PID
$Identity=@{ExecutablePath=$OwnProcess.Path;ProcessId=$OwnProcess.Id;CreationTime100ns=$OwnProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)}
foreach($Phase in @('initial','official-wait','participant')){
  $Arguments=@(Get-UpgradeBoundArguments @Identity -Phase $Phase)
  Assert-UpgradeBoundArguments -Arguments $Arguments @Identity -Phase $Phase
  $ExpectedCount=@{initial=5;'official-wait'=7;participant=6}[$Phase]
  if($Arguments.Count -ne $ExpectedCount){throw 'Unexpected phase argument count'}
  if($Arguments[3] -cne '--expected-creation-time-100ns' -or $Arguments[4] -cne $Identity.CreationTime100ns){throw 'Binding is missing or reordered'}
  if($Phase -eq 'official-wait' -and ($Arguments[5] -cne '--wait-for-official-addon' -or $Arguments[6] -cne '30000')){throw 'Wait flags changed'}
  if($Phase -eq 'participant' -and $Arguments[5] -cne '--addon-only'){throw 'Member-only flag is not last'}
  foreach($Case in @('pid','created','missing-binding','extra','name','numeric')){
    $Bad=@($Arguments)
    switch($Case){
      pid{$Bad[2]=[string]($OwnProcess.Id+1)}
      created{$Bad[4]=([uint64]$Identity.CreationTime100ns+1).ToString()}
      missing-binding{$Bad=@($Arguments[0],$Arguments[1],$Arguments[2])}
      extra{$Bad+=@('--unexpected')}
      name{$Bad[0]=[IO.Path]::GetFileName($Identity.ExecutablePath)}
      numeric{$Bad[4]=[uint64]$Identity.CreationTime100ns}
    }
    $Rejected=$false
    try{Assert-UpgradeBoundArguments -Arguments $Bad @Identity -Phase $Phase}catch{$Rejected=$true}
    if(-not $Rejected){throw ('Accepted wrong '+$Phase+' '+$Case)}
  }
}
$Selection='EGO_TARGET_SELECTED_V2'+[char]9+$Identity.ProcessId+[char]9+$Identity.CreationTime100ns+[char]9+$Identity.ExecutablePath+[char]10
Assert-UpgradePrearmedSelection -InjectorOutput $Selection @Identity
foreach($Invalid in @($Selection+$Selection,$Selection.Replace($Identity.CreationTime100ns,'1'),$Selection.Replace($Identity.ExecutablePath,'C:\\foreign\\game.exe'))){
  $Rejected=$false
  try{Assert-UpgradePrearmedSelection -InjectorOutput $Invalid @Identity}catch{$Rejected=$true}
  if(-not $Rejected){throw 'Accepted foreign or duplicate native V2 selection'}
}
Write-Output 'All exact invocation phases and native prearmed identity are strictly bound.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /All exact invocation phases and native prearmed identity are strictly bound/);
});
