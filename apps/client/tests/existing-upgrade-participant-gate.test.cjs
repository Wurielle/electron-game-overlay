'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const runner = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-existing-reshade-upgrade-gate.ps1');
const windowsOnly = { skip: process.platform !== 'win32' ? 'PowerShell guard execution requires Windows' : false };
const ps = value => `'${value.replaceAll("'", "''")}'`;

function runGuards(names, body) {
  // Only the extracted pure helpers execute: no seeding, Electron or native programs.
  const script = `
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$Tokens = $null; $Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile(${ps(runner)},[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
foreach ($Name in @(${names.map(ps).join(',')})) {
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

test('upgrade gate preserves installation canaries, startup ordering and exact private-member evidence', () => {
  const source = fs.readFileSync(runner, 'utf8');
  for (const check of [
    'Assert-UpgradeParticipantResult -Record',
    'Assert-UpgradeParticipantModules -Modules',
    'Assert-UpgradeParticipantArtifact -StagePath',
    'DisabledAddons=Foreign Canary@foreign-canary.addon64',
    'existing-canary.fx',
    'existing-canary.png',
    'Assert-SeedFilesPreserved',
    '$PreReleaseClientLogBoundaryIndex',
    'Assert-NoTargetFailureOrMaintenance',
    'Assert-UpgradeLifecycleOrder',
    '-ConnectedIndex $Connected.Index',
    '-AutoConnectedIndex $AutoConnected.Index',
  ]) assert.ok(source.includes(check), check);
  assert.match(source, /Select-UpgradeParticipantResult\s+(?:`\s*)?-Results/u);
});

test('upgrade lifecycle accepts either TCP/completion order and rejects every premature connection or unbound pending phase', windowsOnly, () => {
  const output = runGuards(['Assert-UpgradeLifecycleOrder'], String.raw`
$Valid=@{WatcherReadyIndex=10;DetectedIndex=20;InitialIndex=30;OfficialWaitIndex=40;
    ReleaseBoundaryIndex=50;ParticipantIndex=60;ReturnedIndex=90;ConnectedIndex=80;AutoConnectedIndex=70;Prearmed=$true}
Assert-UpgradeLifecycleOrder @Valid
$ReturnFirst=@{};foreach($Key in $Valid.Keys){$ReturnFirst[$Key]=$Valid[$Key]}
$ReturnFirst.ReturnedIndex=70;$ReturnFirst.ConnectedIndex=80;$ReturnFirst.AutoConnectedIndex=90
Assert-UpgradeLifecycleOrder @ReturnFirst
$NativeWaitFirst=@{};foreach($Key in $Valid.Keys){$NativeWaitFirst[$Key]=$Valid[$Key]}
$NativeWaitFirst.InitialIndex=45
Assert-UpgradeLifecycleOrder @NativeWaitFirst
$NativeWaitFirst.Prearmed=$false
Assert-Rejected { Assert-UpgradeLifecycleOrder @NativeWaitFirst } 'exact invocation after wait'
foreach($Case in @(
    @('WatcherReadyIndex',21),@('DetectedIndex',31),@('InitialIndex',51),@('OfficialWaitIndex',51),
    @('ParticipantIndex',50),@('ReturnedIndex',59),@('ConnectedIndex',50),@('AutoConnectedIndex',50),
    @('ConnectedIndex',-1))){
    $Bad=@{};foreach($Key in $Valid.Keys){$Bad[$Key]=$Valid[$Key]};$Bad[$Case[0]]=$Case[1]
    Assert-Rejected { Assert-UpgradeLifecycleOrder @Bad } ('wrong lifecycle '+$Case[0])
}
Write-Output 'Independent post-release completion and connection proofs preserve the startup barrier.'
`);
  assert.match(output, /Independent post-release completion and connection proofs preserve the startup barrier/u);
});

test('upgrade guards bind exact participant identity and retain one runtime, adapter and own engine', windowsOnly, () => {
  const output = runGuards(['Assert-UpgradeParticipantResult', 'Assert-UpgradeParticipantModules'], String.raw`
$Valid = [ordered]@{schemaVersion=1;pid=123;runtimeMode='participant-addon';addonAbi=1;memberProtocolVersion=1;
    targetExecutablePath='C:\fixture\game.exe';runtimeModulePath='C:\fixture\dxgi.dll';
    addonModulePath='C:\cache\member-a\electron_game_overlay.addon64';reshadeBasePath='C:\fixture'}
$Expected = @{ExpectedPid=123;ExpectedExecutablePath=$Valid.targetExecutablePath;ExpectedRuntimePath=$Valid.runtimeModulePath;
    ExpectedAddonPath=$Valid.addonModulePath;ExpectedBasePath=$Valid.reshadeBasePath}
Assert-UpgradeParticipantResult -Record ([pscustomobject]$Valid) @Expected
foreach ($Case in @(
    @('schemaVersion',2), @('schemaVersion','1'), @('pid',124), @('pid','123'),
    @('runtimeMode','official-addon'), @('addonAbi',2), @('addonAbi','1'),
    @('memberProtocolVersion',2), @('memberProtocolVersion','1'),
    @('targetExecutablePath','C:\foreign\game.exe'), @('targetExecutablePath','game.exe'),
    @('runtimeModulePath','C:\cache\ReShade64.dll'), @('reshadeBasePath','C:\foreign'),
    @('addonModulePath','C:\fixture\existing-addons\electron_game_overlay.addon64'),
    @('addonModulePath','C:\cache\member-b\electron_game_overlay.addon64'),
    @('addonModulePath','electron_game_overlay.addon64'), @('unexpected',1))) {
    $Changed = [ordered]@{}; foreach ($Key in $Valid.Keys) { $Changed[$Key]=$Valid[$Key] }; $Changed[$Case[0]]=$Case[1]
    Assert-Rejected { Assert-UpgradeParticipantResult -Record ([pscustomobject]$Changed) @Expected } ('participant ' + $Case[0])
}
foreach ($Key in $Valid.Keys) {
    $Changed = [ordered]@{}; foreach ($Other in $Valid.Keys) { if ($Other -ne $Key) { $Changed[$Other]=$Valid[$Other] } }
    Assert-Rejected { Assert-UpgradeParticipantResult -Record ([pscustomobject]$Changed) @Expected } ('missing participant ' + $Key)
}
function New-Module {
    param([string]$FileName,[string]$ProductName='Electron Game Overlay')
    return [pscustomobject]@{FileName=$FileName;ModuleName=[IO.Path]::GetFileName($FileName);
        FileVersionInfo=[pscustomobject]@{ProductName=$ProductName;FileDescription=$ProductName}}
}
$Runtime = New-Module $Valid.runtimeModulePath 'ReShade'
$Adapter = New-Module 'C:\fixture\existing-addons\electron_game_overlay.addon64'
$Participant = New-Module $Valid.addonModulePath
$System = New-Module 'C:\Windows\System32\d3d11.dll' 'Microsoft Windows'
$ModuleExpected = @{ExpectedRuntimePath=$Runtime.FileName;ExpectedAdapterPath=$Adapter.FileName;ExpectedParticipantPath=$Participant.FileName}
$Modules = @($Runtime,$Adapter,$Participant,$System)
Assert-UpgradeParticipantModules -Modules $Modules @ModuleExpected
foreach ($Required in @($Runtime,$Adapter,$Participant)) {
    $Missing = @($Modules | Where-Object { $_.FileName -ne $Required.FileName })
    Assert-Rejected { Assert-UpgradeParticipantModules -Modules $Missing @ModuleExpected } ('missing ' + $Required.FileName)
    $Duplicate = @($Modules) + @($Required)
    Assert-Rejected { Assert-UpgradeParticipantModules -Modules $Duplicate @ModuleExpected } ('duplicate ' + $Required.FileName)
}
foreach ($Extra in @(
    (New-Module 'C:\cache\ReShade64.dll' 'ReShade'),
    (New-Module 'C:\foreign\renamed-runtime.dll' 'ReShade'),
    (New-Module 'C:\cache\ReShade64.dll' 'Unknown'),
    (New-Module 'C:\cache\member-b\electron_game_overlay.addon64'))) {
    $Augmented = @($Modules) + @($Extra)
    Assert-Rejected { Assert-UpgradeParticipantModules -Modules $Augmented @ModuleExpected } ('unexpected ' + $Extra.FileName)
}
Write-Output 'Upgrade private participant and singleton module identities verified.'
`);
  assert.match(output, /Upgrade private participant and singleton module identities verified/u);
});

test('upgrade result selection allows one ordered official proof and binds the same injector stage', windowsOnly, () => {
  const output = runGuards(['Select-UpgradeParticipantResult'], String.raw`
function New-Result {
    param([string]$Mode='participant-addon',[int]$TargetPid=123)
    return [pscustomobject]@{schemaVersion=1;pid=$TargetPid;runtimeMode=$Mode;addonAbi=1;memberProtocolVersion=1;
        targetExecutablePath='C:\fixture\game.exe';runtimeModulePath='C:\fixture\dxgi.dll';
        addonModulePath='C:\cache\member-a\electron_game_overlay.addon64';reshadeBasePath='C:\fixture'}
}
function New-Entry {
    param([object]$Result,[string]$StdoutPath='C:\cache\member-a\injector.stdout.log')
    return [pscustomobject]@{Result=$Result;StdoutPath=$StdoutPath}
}
$Participant = New-Entry (New-Result)
$Official = New-Entry (New-Result 'official-addon')
$Official.Result.addonModulePath = 'C:\fixture\existing-addons\electron_game_overlay.addon64'
$ForeignTarget = New-Entry (New-Result 'unrelated-mode' 999) 'C:\cache\other-target\injector.stdout.log'
$Selected = Select-UpgradeParticipantResult -Results @($Participant,$ForeignTarget) -ExpectedPid 123
if ($Selected.Result.runtimeMode -cne 'participant-addon' -or @($Selected.IntermediateOfficialResults).Count -ne 0 -or
    $Selected.StdoutPath -cne $Participant.StdoutPath) { throw 'Single participant result was not selected.' }
$Selected = Select-UpgradeParticipantResult -Results @($Official,$ForeignTarget,$Participant) -ExpectedPid 123
if ($Selected.Result.runtimeMode -cne 'participant-addon' -or @($Selected.IntermediateOfficialResults).Count -ne 1 -or
    $Selected.StdoutPath -cne $Participant.StdoutPath) { throw 'Ordered optional official proof was not retained.' }
foreach ($Case in @(
    @{Name='no participant';Entries=@($Official)},
    @{Name='duplicate participant';Entries=@($Participant,$Participant)},
    @{Name='duplicate official';Entries=@($Official,$Official,$Participant)},
    @{Name='reversed phase';Entries=@($Participant,$Official)},
    @{Name='unknown target mode';Entries=@((New-Entry (New-Result 'full-runtime')),$Participant)},
    @{Name='different stage';Entries=@((New-Entry $Official.Result 'C:\cache\member-b\injector.stdout.log'),$Participant)})) {
    Assert-Rejected { Select-UpgradeParticipantResult -Results $Case.Entries -ExpectedPid 123 } $Case.Name
}
foreach ($Field in @('targetExecutablePath','runtimeModulePath','reshadeBasePath')) {
    $Changed = New-Result 'official-addon'
    $Changed.$Field = 'C:\foreign\different'
    $Entries = @((New-Entry $Changed),$Participant)
    Assert-Rejected { Select-UpgradeParticipantResult -Results $Entries -ExpectedPid 123 } ('mixed target identity ' + $Field)
}
Write-Output 'Upgrade optional official proof and final private result selection verified.'
`);
  assert.match(output, /Upgrade optional official proof and final private result selection verified/u);
});

test('upgrade artifact guard binds private stage to sealed package without modifying either', windowsOnly, () => {
  const temporaryDirectory = path.resolve(os.tmpdir());
  const tempRoot = fs.mkdtempSync(path.join(temporaryDirectory, 'ego-upgrade-guards-'));
  const buildId = 'A8E9DA12477741B9979D9B1B51994EF3';
  const bytes = Buffer.from(`Sealed current native fixture ${buildId}\0`, 'ascii');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const stamp = { schemaVersion: 4, cooperativeAddonProtocol: 1, injectorProcessInstanceBinding: 1,
    addonBuildId: buildId, addonSha256: hash };
  const cases = [];
  const snapshots = new Map();
  const addCase = (name, { stage = {}, package: sealed = {}, stageBytes = bytes, packageBytes = bytes, expectedHash = hash, rejected = true } = {}) => {
    const caseRoot = path.join(tempRoot, name);
    const stagePath = path.join(caseRoot, 'stage');
    const packageDirectory = path.join(caseRoot, 'package');
    for (const [directory, metadata, artifact] of [[stagePath, { ...stamp, ...stage }, stageBytes], [packageDirectory, { ...stamp, ...sealed }, packageBytes]]) {
      fs.mkdirSync(directory, { recursive: true });
      for (const [name, contents] of [['electron_game_overlay.addon64', artifact], ['electron_game_overlay_runtime.build.json', JSON.stringify(metadata)]]) {
        const file = path.join(directory, name);
        fs.writeFileSync(file, contents);
        fs.utimesSync(file, new Date('2020-01-02T03:04:06Z'), new Date('2020-01-02T03:04:06Z'));
        const stat = fs.statSync(file);
        snapshots.set(file, { bytes: fs.readFileSync(file), mtimeMs: stat.mtimeMs, mode: stat.mode });
      }
    }
    cases.push({ Name: name, StagePath: stagePath, PackageDirectory: packageDirectory, ExpectedAddonHash: expectedHash, Rejected: rejected });
  };
  addCase('current', { rejected: false });
  for (const field of ['schemaVersion', 'cooperativeAddonProtocol', 'injectorProcessInstanceBinding']) {
    addCase(`stage-${field}`, { stage: { [field]: 0 } });
    addCase(`package-${field}`, { package: { [field]: 0 } });
    addCase(`typed-${field}`, { stage: { [field]: String(stamp[field]) } });
  }
  addCase('foreign-stage-build', { stage: { addonBuildId: 'F'.repeat(32) } });
  addCase('foreign-package-build', { package: { addonBuildId: 'F'.repeat(32) } });
  addCase('stale-stage-hash', { stage: { addonSha256: '0'.repeat(64) } });
  addCase('stale-package-hash', { package: { addonSha256: '0'.repeat(64) } });
  addCase('unexpected-hash', { expectedHash: '0'.repeat(64) });
  addCase('changed-stage-bytes', { stageBytes: Buffer.from('Stale stage implementation') });
  addCase('changed-package-bytes', { packageBytes: Buffer.from('Stale package implementation') });
  try {
    const output = runGuards(['Assert-UpgradeParticipantArtifact'], `
$Cases = ${ps(JSON.stringify(cases))} | ConvertFrom-Json
foreach ($Case in $Cases) {
    $Expected = @{StagePath=$Case.StagePath;ExpectedAddonHash=$Case.ExpectedAddonHash;PackageDirectory=$Case.PackageDirectory}
    if ($Case.Rejected) { Assert-Rejected { Assert-UpgradeParticipantArtifact @Expected } $Case.Name }
    else {
        $Artifact = Assert-UpgradeParticipantArtifact @Expected
        if ($Artifact.AddonBuildId -cne '${buildId}' -or $Artifact.AddonSha256 -cne '${hash}' -or
            $Artifact.CooperativeAddonProtocol -ne 1 -or $Artifact.StagePath -cne $Case.StagePath) {
            throw 'Artifact proof does not identify the validated stage.'
        }
    }
}
Write-Output 'Upgrade stage and sealed package metadata, bytes and hash are bound.'
`);
    assert.match(output, /Upgrade stage and sealed package metadata, bytes and hash are bound/u);
    for (const [file, snapshot] of snapshots) {
      assert.deepEqual(fs.readFileSync(file), snapshot.bytes, file);
      assert.equal(fs.statSync(file).mtimeMs, snapshot.mtimeMs, file);
      assert.equal(fs.statSync(file).mode, snapshot.mode, file);
    }
  } finally {
    const resolved = path.resolve(tempRoot);
    assert.ok(resolved.startsWith(`${temporaryDirectory}${path.sep}`) && path.basename(resolved).startsWith('ego-upgrade-guards-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
