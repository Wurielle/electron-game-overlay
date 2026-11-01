'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const runner = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-process-start-injection-gate.ps1');

test('process-start gates retain private-stage, exact-incarnation and protected-host evidence', () => {
  const source = fs.readFileSync(runner, 'utf8');
  assert.ok(source.includes('$ParticipantDiscoveryPath = Join-Path $ReShadeRunDirectory "electron-overlay-transport-v1.json"'));
  assert.equal(source.includes('"electron-overlay-transport-v1.pid-$HostPid.json"'), false);
  assert.ok(source.includes('"--expected-creation-time-100ns", $HostCreationTime100ns'));
  assert.ok(source.includes('$StagedPackage.cooperativeAddonProtocol -ne 1'));
  assert.ok(source.includes('$StagedAddonHash -cne $ProductionAddonHash'));
  for (const check of ['Assert-CooperativeParticipantResult -Record', 'Assert-OneReShadeRuntime -Modules',
    'Assert-PreDeviceBoundary -ClientTail', 'Assert-OfficialTargetFilesPreserved',
    'This application\'s exact staged engine was not mapped',
    'The preinstalled official adapter did not remain loaded']) assert.ok(source.includes(check), check);
});

test('extracted process-start guards reject foreign engines, second runtimes and premature graphics or authentication', {
  skip: process.platform !== 'win32' ? 'PowerShell guard execution requires Windows' : false,
}, () => {
  // Execute only pure assertion helpers extracted through PowerShell's AST.
  // The native host, Electron, injector and complete gate are never started.
  const script = `
$ErrorActionPreference = 'Stop'
$Tokens = $null; $Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
foreach ($Name in @('Assert-CooperativeParticipantResult','Assert-OneReShadeRuntime','Assert-PreDeviceBoundary')) {
    $Definition = $Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
    if (-not $Definition) { throw ('Missing guard: ' + $Name) }
    . ([scriptblock]::Create($Definition.Extent.Text))
}
$Valid = [ordered]@{schemaVersion=1;pid=123;runtimeMode='participant-addon';addonAbi=1;memberProtocolVersion=1;
    targetExecutablePath='C:\\fixture\\game.exe';runtimeModulePath='C:\\fixture\\dxgi.dll';
    addonModulePath='C:\\cache\\member-a\\electron_game_overlay.addon64';reshadeBasePath='C:\\fixture'}
$Expected = @{ExpectedPid=123;ExpectedExecutablePath=$Valid.targetExecutablePath;ExpectedRuntimePath=$Valid.runtimeModulePath;
    ExpectedAddonPath=$Valid.addonModulePath;ExpectedBasePath=$Valid.reshadeBasePath}
Assert-CooperativeParticipantResult -Record ([pscustomobject]$Valid) @Expected
$Cases = @(
    @('pid',124), @('pid','123'), @('memberProtocolVersion',2), @('memberProtocolVersion','1'),
    @('runtimeMode','official-addon'), @('addonModulePath','C:\\fixture\\electron_game_overlay.addon64'),
    @('addonModulePath','C:\\cache\\member-b\\electron_game_overlay.addon64'),
    @('runtimeModulePath','C:\\cache\\ReShade64.dll'), @('reshadeBasePath','D:\\foreign'), @('unexpected',1))
foreach ($Case in $Cases) {
    $Record = [ordered]@{}; foreach ($Key in $Valid.Keys) { $Record[$Key]=$Valid[$Key] }; $Record[$Case[0]]=$Case[1]
    $Rejected=$false
    try { Assert-CooperativeParticipantResult -Record ([pscustomobject]$Record) @Expected } catch { $Rejected=$true }
    if (-not $Rejected) { throw ('Accepted bad participant field: ' + $Case[0]) }
}
$Runtime = [pscustomobject]@{FileName=$Valid.runtimeModulePath;FileVersionInfo=[pscustomobject]@{ProductName='ReShade'}}
$System = [pscustomobject]@{FileName='C:\\Windows\\System32\\d3d11.dll';FileVersionInfo=[pscustomobject]@{ProductName='Microsoft Windows'}}
Assert-OneReShadeRuntime -Modules @($Runtime,$System) -ExpectedPath $Valid.runtimeModulePath
foreach ($Extra in @('C:\\cache\\ReShade64.dll','C:\\foreign\\renamed-runtime.dll')) {
    $Other = [pscustomobject]@{FileName=$Extra;FileVersionInfo=[pscustomobject]@{ProductName='ReShade'}}
    $Rejected=$false
    try { Assert-OneReShadeRuntime -Modules @($Runtime,$Other,$System) -ExpectedPath $Valid.runtimeModulePath } catch { $Rejected=$true }
    if (-not $Rejected) { throw 'Accepted a second runtime.' }
}
$Boundary = @{ConnectedLine='RESHADE_CLIENT_TARGET_CONNECTED pid=123';ConnectedStateLine='phase=connected pid=123'}
Assert-PreDeviceBoundary -ClientTail 'phase=attaching' -RuntimeLog 'Registered add-on cooperative member' @Boundary
foreach ($Case in @(
    @('RESHADE_CLIENT_TARGET_CONNECTED pid=123',''), @('phase=connected pid=123',''),
    @('','Electron game overlay runtime initialized its transport and input router.'),
    @('','Redirecting D3D11CreateDeviceAndSwapChain'), @('','Redirecting D3D12CreateDevice'),
    @('','rendered its first transported multi-window scene (2 window(s)).'))) {
    $Rejected=$false
    try { Assert-PreDeviceBoundary -ClientTail $Case[0] -RuntimeLog $Case[1] @Boundary } catch { $Rejected=$true }
    if (-not $Rejected) { throw 'Accepted authentication/rendering before startup release.' }
}
Write-Output 'Private engine identity, singleton runtime and pre-device boundaries verified without launching an overlay.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Private engine identity, singleton runtime and pre-device boundaries verified/u);
});
