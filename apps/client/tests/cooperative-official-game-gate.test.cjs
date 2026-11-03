'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const runner = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-gun-frog-official-reshade-coexistence-gate.ps1');
const windowsOnly = { skip: process.platform !== 'win32' ? 'PowerShell guard execution requires Windows' : false };
const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`;

function runGuards(names, body) {
  // Extract only pure assertions, never the runner's seeding, process or cleanup code.
  const script = `
$ErrorActionPreference = 'Stop'
# Desktop/PowerShell 7 can supply a PSModulePath without Windows PowerShell's
# built-ins. Load its own read-only hashing/JSON cmdlets explicitly.
Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$Tokens = $null; $Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile(${quotePowerShell(runner)},[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
foreach ($Name in @(${names.map(quotePowerShell).join(',')})) {
    $Definition = $Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
    if (-not $Definition) { throw ('Missing guard: ' + $Name) }
    . ([scriptblock]::Create($Definition.Extent.Text))
}
function Assert-Rejected {
    param([scriptblock]$Action,[string]$Label)
    $Rejected = $false
    try { & $Action } catch { $Rejected = $true }
    if (-not $Rejected) { throw ('Accepted invalid evidence: ' + $Label) }
}
${body}
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('official game gate retains private-member, foreign add-on, effect, input and protected-file evidence', () => {
  const source = fs.readFileSync(runner, 'utf8');
  for (const check of [
    'Assert-OfficialParticipantResult -Record',
    'Assert-OfficialParticipantModules -Modules',
    'Assert-OfficialParticipantArtifact -StagePath',
    'Assert-CurrentRuntimeSourceContract',
    'Assert-ProtectedSeedPreserved',
    '-RestoreTestOwnedMetadata',
    'Get-PathSnapshot',
    'Registered add-on "FPS Limiter"',
    "Successfully compiled '.*EGOCoexistenceWitness\\.fx'",
    'HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true',
    'HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false',
    'was not bounded by interception enable/release',
    'Gun Frog closed before all four intercepted Electron clicks',
  ]) assert.ok(source.includes(check), check);
  for (const action of ['continue', 'new-game', 'settings', 'quit']) {
    assert.ok(source.includes(`HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click name=${action}`), action);
  }
  assert.match(source, /-Operation\s+(?:`\s*)?["']?remove\b/u);
});

test('official participant guards reject foreign routes, stale proofs and incomplete module coexistence', windowsOnly, () => {
  const output = runGuards(['Assert-OfficialParticipantResult', 'Assert-OfficialParticipantModules'], String.raw`
$Valid = [ordered]@{schemaVersion=1;pid=123;runtimeMode='participant-addon';addonAbi=1;memberProtocolVersion=1;
    targetExecutablePath='C:\fixture\game.exe';runtimeModulePath='C:\fixture\dxgi.dll';
    addonModulePath='C:\cache\member-a\electron_game_overlay.addon64';reshadeBasePath='C:\fixture\.test'}
$Expected = @{ExpectedPid=123;ExpectedExecutablePath=$Valid.targetExecutablePath;ExpectedRuntimePath=$Valid.runtimeModulePath;
    ExpectedAddonPath=$Valid.addonModulePath;ExpectedBasePath=$Valid.reshadeBasePath}
Assert-OfficialParticipantResult -Record ([pscustomobject]$Valid) @Expected
$Cases = @(
    @('schemaVersion',2), @('schemaVersion','1'), @('pid',124), @('pid','123'),
    @('runtimeMode','official-addon'), @('addonAbi',2), @('addonAbi','1'),
    @('memberProtocolVersion',2), @('memberProtocolVersion','1'),
    @('targetExecutablePath','C:\foreign\game.exe'), @('targetExecutablePath','game.exe'),
    @('runtimeModulePath','C:\cache\ReShade64.dll'), @('runtimeModulePath','dxgi.dll'),
    @('addonModulePath','C:\fixture\.test\addons\electron_game_overlay.addon64'),
    @('addonModulePath','C:\cache\member-b\electron_game_overlay.addon64'),
    @('addonModulePath','electron_game_overlay.addon64'),
    @('reshadeBasePath','C:\foreign'), @('reshadeBasePath','.test'), @('unexpected',1))
foreach ($Case in $Cases) {
    $Changed = [ordered]@{}; foreach ($Key in $Valid.Keys) { $Changed[$Key]=$Valid[$Key] }; $Changed[$Case[0]]=$Case[1]
    Assert-Rejected { Assert-OfficialParticipantResult -Record ([pscustomobject]$Changed) @Expected } ('participant ' + $Case[0])
}
foreach ($Key in $Valid.Keys) {
    $Changed = [ordered]@{}; foreach ($Other in $Valid.Keys) { if ($Other -ne $Key) { $Changed[$Other]=$Valid[$Other] } }
    Assert-Rejected { Assert-OfficialParticipantResult -Record ([pscustomobject]$Changed) @Expected } ('missing participant ' + $Key)
}
function New-Module {
    param([string]$FileName,[string]$ProductName='Electron Game Overlay')
    return [pscustomobject]@{FileName=$FileName;ModuleName=[IO.Path]::GetFileName($FileName);
        FileVersionInfo=[pscustomobject]@{ProductName=$ProductName;FileDescription=$ProductName}}
}
$Runtime = New-Module $Valid.runtimeModulePath 'ReShade'
$Foreign = New-Module 'C:\fixture\.test\addons\fps_limit.addon64' 'FPS Limiter'
$Adapter = New-Module 'C:\fixture\.test\addons\electron_game_overlay.addon64'
$Participant = New-Module $Valid.addonModulePath
$System = New-Module 'C:\Windows\System32\d3d11.dll' 'Microsoft Windows'
$ModuleExpected = @{ExpectedRuntimePath=$Runtime.FileName;ExpectedForeignAddonPath=$Foreign.FileName;
    ExpectedAdapterPath=$Adapter.FileName;ExpectedParticipantPath=$Participant.FileName}
$Modules = @($Runtime,$Foreign,$Adapter,$Participant,$System)
Assert-OfficialParticipantModules -Modules $Modules @ModuleExpected
foreach ($Required in @($Runtime,$Foreign,$Adapter,$Participant)) {
    $Missing = @($Modules | Where-Object { $_.FileName -ne $Required.FileName })
    Assert-Rejected { Assert-OfficialParticipantModules -Modules $Missing @ModuleExpected } ('missing module ' + $Required.FileName)
    $Duplicate = @($Modules) + @($Required)
    Assert-Rejected { Assert-OfficialParticipantModules -Modules $Duplicate @ModuleExpected } ('duplicate module ' + $Required.FileName)
}
foreach ($Extra in @(
    (New-Module 'C:\cache\ReShade64.dll' 'ReShade'),
    (New-Module 'C:\foreign\renamed-runtime.dll' 'ReShade'),
    (New-Module 'C:\cache\ReShade64.dll' 'Unknown'),
    (New-Module 'C:\cache\member-b\electron_game_overlay.addon64'))) {
    $Augmented = @($Modules) + @($Extra)
    Assert-Rejected { Assert-OfficialParticipantModules -Modules $Augmented @ModuleExpected } ('unexpected module ' + $Extra.FileName)
}
$ForeignParticipant = @($Runtime,$Foreign,$Adapter,(New-Module 'C:\cache\member-b\electron_game_overlay.addon64'),$System)
Assert-Rejected { Assert-OfficialParticipantModules -Modules $ForeignParticipant @ModuleExpected } 'another application engine instead of this application engine'
Write-Output 'Official participant identity and four-module coexistence verified without launching an overlay.'
`);
  assert.match(output, /Official participant identity and four-module coexistence verified/u);
});

test('official participant artifact guard requires current private stage bytes and never mutates protected fixtures', windowsOnly, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-official-guards-'));
  const stage = path.join(tempRoot, 'member-a');
  fs.mkdirSync(stage);
  const addonPath = path.join(stage, 'electron_game_overlay.addon64');
  const stampPath = path.join(stage, 'electron_game_overlay_runtime.build.json');
  const protectedPath = path.join(tempRoot, 'official-protected.ini');
  const buildId = 'A8E9DA12477741B9979D9B1B51994EF3';
  const bytes = Buffer.from(`Independent staged native fixture ${buildId}\0`, 'ascii');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const stamp = { schemaVersion: 4, cooperativeAddonProtocol: 1, injectorProcessInstanceBinding: 1,
    addonBuildId: buildId, addonSha256: hash };
  const stampBytes = Buffer.from(JSON.stringify(stamp));
  fs.writeFileSync(addonPath, bytes);
  fs.writeFileSync(stampPath, stampBytes);
  fs.writeFileSync(protectedPath, '[GENERAL]\r\nExistingOfficialConfiguration=1\r\n');
  const protectedBytes = fs.readFileSync(protectedPath);
  const preservedTime = new Date('2020-01-02T03:04:06.000Z');
  for (const file of [addonPath, stampPath, protectedPath]) fs.utimesSync(file, preservedTime, preservedTime);
  const protectedModified = fs.statSync(protectedPath).mtimeMs;
  try {
    const output = runGuards(['Get-FileSha256', 'Assert-OfficialParticipantArtifact'], `
$Stage = ${quotePowerShell(stage)}
$StampPath = ${quotePowerShell(stampPath)}
$AddonPath = ${quotePowerShell(addonPath)}
$Hash = '${hash}'
$BuildId = '${buildId}'
$OriginalStamp = [IO.File]::ReadAllBytes($StampPath)
$OriginalAddon = [IO.File]::ReadAllBytes($AddonPath)
$OriginalStampTime = [IO.File]::GetLastWriteTimeUtc($StampPath)
$OriginalAddonTime = [IO.File]::GetLastWriteTimeUtc($AddonPath)
$OriginalStampAttributes = [IO.File]::GetAttributes($StampPath)
$OriginalAddonAttributes = [IO.File]::GetAttributes($AddonPath)
$Expected = @{StagePath=$Stage;ExpectedAddonHash=$Hash;ExpectedAddonBuildId=$BuildId}
Assert-OfficialParticipantArtifact @Expected
if ([IO.File]::GetLastWriteTimeUtc($StampPath) -ne $OriginalStampTime -or
    [IO.File]::GetLastWriteTimeUtc($AddonPath) -ne $OriginalAddonTime -or
    [IO.File]::GetAttributes($StampPath) -ne $OriginalStampAttributes -or
    [IO.File]::GetAttributes($AddonPath) -ne $OriginalAddonAttributes -or
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($StampPath)) -cne [Convert]::ToBase64String($OriginalStamp) -or
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($AddonPath)) -cne [Convert]::ToBase64String($OriginalAddon)) {
    throw 'Assertion rewrote staged files.'
}
$Valid = [Text.Encoding]::UTF8.GetString($OriginalStamp) | ConvertFrom-Json
$Cases = @(
    @('schemaVersion',3), @('schemaVersion','4'),
    @('cooperativeAddonProtocol',0), @('cooperativeAddonProtocol','1'),
    @('injectorProcessInstanceBinding',0), @('injectorProcessInstanceBinding','1'),
    @('addonBuildId','FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'),
    @('addonSha256',('0' * 64)))
foreach ($Case in $Cases) {
    $Changed = [ordered]@{}; foreach ($Property in $Valid.PSObject.Properties) { $Changed[$Property.Name]=$Property.Value }
    $Changed[$Case[0]]=$Case[1]
    [IO.File]::WriteAllText($StampPath,([pscustomobject]$Changed | ConvertTo-Json -Compress))
    Assert-Rejected { Assert-OfficialParticipantArtifact @Expected } ('stale stage ' + $Case[0])
}
foreach ($Key in @('cooperativeAddonProtocol','injectorProcessInstanceBinding','addonBuildId','addonSha256')) {
    $Changed = [ordered]@{}; foreach ($Property in $Valid.PSObject.Properties) { if ($Property.Name -ne $Key) { $Changed[$Property.Name]=$Property.Value } }
    [IO.File]::WriteAllText($StampPath,([pscustomobject]$Changed | ConvertTo-Json -Compress))
    Assert-Rejected { Assert-OfficialParticipantArtifact @Expected } ('missing stage ' + $Key)
}
[IO.File]::WriteAllBytes($StampPath,$OriginalStamp)
Assert-Rejected { Assert-OfficialParticipantArtifact -StagePath $Stage -ExpectedAddonHash ('0' * 64) -ExpectedAddonBuildId $BuildId } 'wrong package hash'
Assert-Rejected { Assert-OfficialParticipantArtifact -StagePath $Stage -ExpectedAddonHash $Hash -ExpectedAddonBuildId ('F' * 32) } 'wrong package build ID'
[IO.File]::WriteAllText($AddonPath,'stale ABI-compatible engine')
Assert-Rejected { Assert-OfficialParticipantArtifact @Expected } 'changed staged engine bytes'
[IO.File]::WriteAllBytes($AddonPath,$OriginalAddon)
[IO.File]::SetLastWriteTimeUtc($StampPath,$OriginalStampTime)
[IO.File]::SetLastWriteTimeUtc($AddonPath,$OriginalAddonTime)
Assert-OfficialParticipantArtifact @Expected
Write-Output 'Current private stage capability, build and hash verified using read-only assertions.'
`);
    assert.match(output, /Current private stage capability, build and hash verified/u);
    assert.deepEqual(fs.readFileSync(addonPath), bytes);
    assert.deepEqual(fs.readFileSync(stampPath), stampBytes);
    assert.deepEqual(fs.readFileSync(protectedPath), protectedBytes);
    assert.equal(fs.statSync(protectedPath).mtimeMs, protectedModified);
  } finally {
    const resolved = path.resolve(tempRoot);
    const temporaryDirectory = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(`${temporaryDirectory}${path.sep}`) && path.basename(resolved).startsWith('ego-official-guards-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
