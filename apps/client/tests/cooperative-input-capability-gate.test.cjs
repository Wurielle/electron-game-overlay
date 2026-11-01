'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const helpers = path.join(root,
  'libs/electron-game-overlay-runtime/scripts/input-capability-gate-helpers.ps1');
const controller = path.join(root,
  'libs/electron-game-overlay-runtime/scripts/run-client-sdk-input-capabilities-gate.ps1');
const windowsOnly = { skip: process.platform !== 'win32' ? 'PowerShell helper validation requires Windows' : false };

test('the owned controller emits the explicit no-peer field required by its validator', () => {
  const source = fs.readFileSync(controller, 'utf8');
  const initialization = source.split(/\r?\n/u).find(line => line.startsWith('$Report = '));
  assert.match(initialization, /\bpermissive\s*=\s*\$null\s*\}/u);
  assert.match(source, /\$Released\.RawBuffer\s*-le\s*\$Baseline\.RawBuffer/u);
  assert.match(source, /releasedRawBufferAdvanced\s*=\s*\$Mode\s*-eq\s*'owned'\s*-and\s*\$Released\.RawBuffer\s*-gt\s*\$Baseline\.RawBuffer/u);
});

function probe(body, fixture) {
  const hosts = ['powershell.exe'];
  const core = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8', timeout: 10_000,
  });
  if (!core.error || core.error.code !== 'ENOENT') {
    assert.ok(!core.error, core.error?.message);
    assert.equal(core.status, 0, `PowerShell Core discovery failed: ${core.stderr}`);
    assert.match(core.stdout.trim(), /^[7-9]\d*$/u);
    hosts.push('pwsh.exe');
  }
  for (const host of hosts) probeForHost(body, fixture, host);
}

function probeForHost(body, fixture, host) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-input-capability-'));
  try {
    fixture?.(directory);
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$Tokens = $null; $Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($env:EGO_CAPABILITY_HELPERS_SOURCE, [ref]$Tokens, [ref]$Errors)
if ($Errors) { throw $Errors }
foreach ($Name in @('Get-CapabilityProtectedManifest', 'Assert-CapabilityProtectedManifest', 'Invoke-CapabilityAddonTransaction')) {
    $Definitions = @($Ast.FindAll({ param($Node)
        $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name
    }, $true))
    if ($Definitions.Count -ne 1) { throw ('Expected exactly one production helper: ' + $Name) }
    . ([scriptblock]::Create($Definitions[0].Extent.Text))
}
function Must-Reject([scriptblock]$Operation, [string]$Label) {
    $Rejected = $false
    try { & $Operation | Out-Null } catch { $Rejected = $true }
    if (-not $Rejected) { throw ('Incorrectly accepted ' + $Label) }
}
$Fixture = $env:EGO_CAPABILITY_TEST_ROOT
` + body;
    const probeSource = path.join(directory, 'probe.txt');
    fs.writeFileSync(probeSource, script);
    const bootstrap = '& ([scriptblock]::Create([IO.File]::ReadAllText($env:EGO_CAPABILITY_PROBE_SOURCE)))';
    const result = spawnSync(host, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(bootstrap, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, EGO_CAPABILITY_HELPERS_SOURCE: helpers,
        EGO_CAPABILITY_CONTROLLER_SOURCE: controller, EGO_CAPABILITY_TEST_ROOT: directory,
        EGO_CAPABILITY_PROBE_SOURCE: probeSource },
    });
    assert.ok(!result.error, result.error?.message);
    assert.equal(result.status, 0, `${host}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /CAPABILITY_HELPER_PROBE_PASS/u);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('capability preservation manifests exclude only mutable logs, cache and the exact reserved pair', windowsOnly, () => {
  probe(String.raw`
$Target = Join-Path $Fixture 'target'
$Expected = @(Get-CapabilityProtectedManifest -Root $Target)
$ExpectedPaths = @('addons/foreign.addon64', 'dxgi.dll', 'nested/cache/keep.bin',
    'nested/ReShade.log', 'preset.ini', 'ReShade.ini', 'shaders/witness.fx') | Sort-Object
if (($Expected.RelativePath -join '|') -cne ($ExpectedPaths -join '|')) {
    throw ('Wrong preservation scope: ' + ($Expected.RelativePath -join '|'))
}
if ($Expected[0].Sha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $Expected[0].Length -isnot [int64] -or $Expected[0].LastWriteUtcTicks -isnot [string] -or
    $Expected[0].LastWriteUtcTicks -cnotmatch '^[0-9]+$') {
    throw 'The manifest must contain real hashes and lossless decimal-string timestamps.'
}
$OneTick = $Expected[0] | Select-Object *
$OneTick.LastWriteUtcTicks = ([int64]::Parse($OneTick.LastWriteUtcTicks) + 1).ToString([Globalization.CultureInfo]::InvariantCulture)
Must-Reject { Assert-CapabilityProtectedManifest -Expected @($Expected[0]) -Actual @($OneTick) } 'one timestamp tick'
$NumericTicks = $Expected[0] | Select-Object *
$NumericTicks.LastWriteUtcTicks = [int64]::Parse($NumericTicks.LastWriteUtcTicks)
Must-Reject { Assert-CapabilityProtectedManifest -Expected @($Expected[0]) -Actual @($NumericTicks) } 'lossy numeric timestamps'
# Only these paths may change without altering protected installation evidence.
foreach ($Relative in @('ReShade.log', 'cache/generated.bin',
    'addons/electron_game_overlay.addon64', 'addons/.electron-game-overlay-addon.json')) {
    [IO.File]::WriteAllText((Join-Path $Target $Relative), 'changed ignored output')
}
Assert-CapabilityProtectedManifest -Expected $Expected -Actual @(Get-CapabilityProtectedManifest -Root $Target)
# Object property order and input enumeration order are not meaningful changes.
$Reordered = @($Expected | Sort-Object RelativePath -Descending | ForEach-Object {
    [pscustomobject][ordered]@{ Sha256=$_.Sha256; Attributes=$_.Attributes;
        Length=$_.Length; LastWriteUtcTicks=$_.LastWriteUtcTicks; RelativePath=$_.RelativePath }
})
Assert-CapabilityProtectedManifest -Expected $Expected -Actual $Reordered
foreach ($Relative in @('addons/.electron-game-overlay-addon.transaction.json',
    'addons/electron_game_overlay.addon64.tmp', 'unexpected.bin')) {
    $Extra = Join-Path $Target $Relative
    [IO.File]::WriteAllText($Extra, 'unexpected leftover')
    Must-Reject { Assert-CapabilityProtectedManifest -Expected $Expected -Actual @(Get-CapabilityProtectedManifest -Root $Target) } $Relative
    [IO.File]::Delete($Extra)
}
foreach ($Relative in @('dxgi.dll', 'ReShade.ini', 'preset.ini', 'addons/foreign.addon64',
    'shaders/witness.fx', 'nested/ReShade.log', 'nested/cache/keep.bin')) {
    $Before = @(Get-CapabilityProtectedManifest -Root $Target)
    [IO.File]::WriteAllText((Join-Path $Target $Relative), 'altered protected bytes')
    Must-Reject { Assert-CapabilityProtectedManifest -Expected $Before -Actual @(Get-CapabilityProtectedManifest -Root $Target) } ('changed bytes ' + $Relative)
}
$Before = @(Get-CapabilityProtectedManifest -Root $Target)
$Protected = Join-Path $Target 'dxgi.dll'
[IO.File]::SetLastWriteTimeUtc($Protected, ([IO.File]::GetLastWriteTimeUtc($Protected)).AddSeconds(2))
Must-Reject { Assert-CapabilityProtectedManifest -Expected $Before -Actual @(Get-CapabilityProtectedManifest -Root $Target) } 'changed modification metadata'
$Before = @(Get-CapabilityProtectedManifest -Root $Target)
[IO.File]::SetAttributes($Protected, ([IO.File]::GetAttributes($Protected) -bor [IO.FileAttributes]::ReadOnly))
Must-Reject { Assert-CapabilityProtectedManifest -Expected $Before -Actual @(Get-CapabilityProtectedManifest -Root $Target) } 'changed attributes'
[IO.File]::SetAttributes($Protected, [IO.FileAttributes]::Normal)
$Before = @(Get-CapabilityProtectedManifest -Root $Target)
[IO.File]::Delete((Join-Path $Target 'preset.ini'))
Must-Reject { Assert-CapabilityProtectedManifest -Expected $Before -Actual @(Get-CapabilityProtectedManifest -Root $Target) } 'removed protected file'
Must-Reject { Assert-CapabilityProtectedManifest -Expected $Expected -Actual @($Expected + $Expected[0]) } 'duplicate manifest identity'
$Malformed = $Expected[0] | Select-Object *
$Malformed | Add-Member -NotePropertyName Unexpected -NotePropertyValue 'hidden comparison field'
Must-Reject { Assert-CapabilityProtectedManifest -Expected @($Expected[0]) -Actual @($Malformed) } 'unknown manifest property'
Must-Reject { Get-CapabilityProtectedManifest -Root 'relative-target' } 'relative preservation root'
$Empty = Join-Path $Fixture 'empty'
[void][IO.Directory]::CreateDirectory($Empty)
Assert-CapabilityProtectedManifest -Expected @() -Actual @(Get-CapabilityProtectedManifest -Root $Empty)
Write-Output 'CAPABILITY_HELPER_PROBE_PASS'
`, directory => {
    const target = path.join(directory, 'target');
    for (const relative of ['addons/foreign.addon64', 'dxgi.dll', 'nested/cache/keep.bin',
      'nested/ReShade.log', 'preset.ini', 'ReShade.ini', 'shaders/witness.fx', 'ReShade.log',
      'cache/generated.bin', 'addons/electron_game_overlay.addon64', 'addons/.electron-game-overlay-addon.json']) {
      const filename = path.join(target, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, `owned hash-only fixture: ${relative}`);
    }
  });
});

test('reserved add-on transactions require exact manager identities and unambiguous successful evidence', windowsOnly, () => {
  probe(String.raw`
$Directory = Join-Path $Fixture 'target/addons'
$Runtime = Join-Path $Fixture 'target/dxgi.dll'
$Source = Join-Path $Fixture 'sdk/electron_game_overlay.addon64'
$RuntimeHash = 'ab' * 32
$SourceHash = 'cd' * 32
$Valid = [pscustomobject][ordered]@{
    schemaVersion=1; kind='electron-game-overlay-reshade-addon-manager-result'; operation='prepare';
    status='installed'; addonPath=(Join-Path $Directory 'electron_game_overlay.addon64');
    markerPath=(Join-Path $Directory '.electron-game-overlay-addon.json'); reshadeModulePath=$Runtime;
    addonSha256=$SourceHash; expectedAddonSha256=$SourceHash; previousAddonSha256=$null;
    reshadeModuleSha256=$RuntimeHash; recoveredTransaction=$false; restartRequired=$true
}
$script:ManagerReply = $Valid
$script:ManagerExit = 0
$script:UseRawOutput = $false
function Invoke-SyntheticCapabilityManager {
    $script:CapturedArguments = @($args)
    $global:LASTEXITCODE = $script:ManagerExit
    if ($script:UseRawOutput) { $script:RawOutput }
    else { $script:ManagerReply | ConvertTo-Json -Depth 4 -Compress }
}
$Call = @{ Operation='prepare'; Manager='Invoke-SyntheticCapabilityManager'; Directory=$Directory;
    Runtime=$Runtime; RuntimeHash=$RuntimeHash; Source=$Source; SourceHash=$SourceHash }
$Result = Invoke-CapabilityAddonTransaction @Call
if ($Result.status -cne 'installed') { throw 'The valid native manager result was not returned.' }
$ExpectedArguments = @('prepare', '--directory', [IO.Path]::GetFullPath($Directory), '--reshade-module',
    [IO.Path]::GetFullPath($Runtime), '--reshade-module-sha256', $RuntimeHash.ToUpperInvariant(), '--source',
    [IO.Path]::GetFullPath($Source), '--source-sha256', $SourceHash.ToUpperInvariant())
if (($script:CapturedArguments -join '|') -cne ($ExpectedArguments -join '|')) {
    throw ('The transaction did not bind exact native arguments: ' + ($script:CapturedArguments -join '|'))
}
$Valid.status = 'already-current'
[void](Invoke-CapabilityAddonTransaction @Call)
$Valid.status = 'installed'
foreach ($Case in @(
    @{Field='schemaVersion'; Value=2}, @{Field='schemaVersion'; Value='1'}, @{Field='schemaVersion'; Value=1.5},
    @{Field='kind'; Value='foreign-result'}, @{Field='operation'; Value='remove'},
    @{Field='status'; Value='updated'}, @{Field='status'; Value='error'},
    @{Field='reshadeModulePath'; Value=(Join-Path $Fixture 'other.dll')},
    @{Field='reshadeModuleSha256'; Value=('ef' * 32)},
    @{Field='addonPath'; Value=(Join-Path $Fixture 'foreign.addon64')},
    @{Field='markerPath'; Value=(Join-Path $Fixture 'foreign-marker.json')},
    @{Field='addonSha256'; Value=('ef' * 32)}, @{Field='expectedAddonSha256'; Value=('ef' * 32)},
    @{Field='previousAddonSha256'; Value='malformed'}, @{Field='restartRequired'; Value='true'},
    @{Field='recoveredTransaction'; Value='false'})) {
    $script:ManagerReply = $Valid | ConvertTo-Json -Compress | ConvertFrom-Json
    $script:ManagerReply.($Case.Field) = $Case.Value
    Must-Reject { Invoke-CapabilityAddonTransaction @Call } ('wrong manager field ' + $Case.Field)
}
$script:ManagerReply = $Valid | ConvertTo-Json -Compress | ConvertFrom-Json
$script:ManagerReply | Add-Member -NotePropertyName Unexpected -NotePropertyValue 'extra'
Must-Reject { Invoke-CapabilityAddonTransaction @Call } 'extra manager schema field'
$script:ManagerReply = $Valid | Select-Object * -ExcludeProperty markerPath
Must-Reject { Invoke-CapabilityAddonTransaction @Call } 'missing manager schema field'
$script:ManagerReply = $Valid
$script:ManagerExit = 3
Must-Reject { Invoke-CapabilityAddonTransaction @Call } 'nonzero manager exit with optimistic JSON'
$script:ManagerExit = 2
$script:ManagerReply = [pscustomobject]@{schemaVersion=1;kind='electron-game-overlay-reshade-addon-manager-result';
    operation='prepare';status='error';code='invalid-request';message='Expected uppercase SHA-256 identity.';windowsError=0}
$Failure = $null
try { Invoke-CapabilityAddonTransaction @Call | Out-Null } catch { $Failure = $_.Exception.Message }
if ($Failure -notmatch 'exit 2; code=invalid-request; message=Expected uppercase SHA-256 identity\.') {
    throw ('A native manager failure lost its public code/message diagnostic: ' + $Failure)
}
$script:ManagerReply = $Valid
$script:ManagerExit = 0
$script:UseRawOutput = $true
foreach ($Raw in @(
    @{Value=@()}, @{Value=@('not JSON')}, @{Value=@(42)},
    @{Value=@(($Valid | ConvertTo-Json -Compress), ($Valid | ConvertTo-Json -Compress))},
    @{Value=@('diagnostic line', ($Valid | ConvertTo-Json -Compress))})) {
    $script:RawOutput = $Raw.Value
    Must-Reject { Invoke-CapabilityAddonTransaction @Call } 'ambiguous or malformed manager output'
}
$script:UseRawOutput = $false
$Call.Operation = 'remove'
$Valid.operation = 'remove'; $Valid.status = 'removed'; $Valid.addonSha256 = $null
$Valid.expectedAddonSha256 = $null; $Valid.previousAddonSha256 = $SourceHash
$script:ManagerReply = $Valid
[void](Invoke-CapabilityAddonTransaction @Call)
if (($script:CapturedArguments -join '|') -cne
    (@('remove', '--directory', [IO.Path]::GetFullPath($Directory), '--reshade-module',
        [IO.Path]::GetFullPath($Runtime), '--reshade-module-sha256', $RuntimeHash.ToUpperInvariant()) -join '|')) {
    throw 'Removal passed source/replacement arguments to the native transaction helper.'
}
$Valid.status = 'not-installed'; $Valid.previousAddonSha256 = $null
[void](Invoke-CapabilityAddonTransaction @Call)
$Valid.status = 'installed'
Must-Reject { Invoke-CapabilityAddonTransaction @Call } 'remove without removal status'
$Valid.status = 'not-installed'; $Valid.addonSha256 = $SourceHash
Must-Reject { Invoke-CapabilityAddonTransaction @Call } 'remove claiming an add-on remains'
$Call.RuntimeHash = 'bad'
Must-Reject { Invoke-CapabilityAddonTransaction @Call } 'malformed runtime identity'
$Call.RuntimeHash = $RuntimeHash; $Call.Directory = 'relative-addons'
Must-Reject { Invoke-CapabilityAddonTransaction @Call } 'relative transaction directory'
Write-Output 'CAPABILITY_HELPER_PROBE_PASS'
`);
});

test('the real capability controller requires stock rejection, isolated continuity and actual owned raw-input evidence', windowsOnly, () => {
  probe(String.raw`
$Tokens = $null; $Errors = $null
$Controller = [Management.Automation.Language.Parser]::ParseFile($env:EGO_CAPABILITY_CONTROLLER_SOURCE, [ref]$Tokens, [ref]$Errors)
if ($Errors) { throw $Errors }
function Controller-Function([string]$Name) {
    $Found = @($Controller.FindAll({ param($Node)
        $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name
    }, $true))
    if ($Found.Count -ne 1) { throw ('Expected one controller function ' + $Name) }
    return $Found[0]
}
function Controller-Guard([string]$Pattern) {
    $Found = @($Controller.FindAll({ param($Node)
        $Node -is [Management.Automation.Language.IfStatementAst] -and $Node.Clauses[0].Item1.Extent.Text -match $Pattern
    }, $true))
    if ($Found.Count -ne 1) { throw ('Expected one controller evidence guard ' + $Pattern) }
    return [scriptblock]::Create($Found[0].Extent.Text)
}
. ([scriptblock]::Create((Controller-Function 'Get-CapabilityInputMarkers').Extent.Text))
$StockMarkers = @('reshade-raw-wm-input-gate.enabled')
$OwnedMarkers = @('reshade-raw-buffer-input-gate.enabled', 'electron-game-overlay-startup-barrier.enabled', 'reshade-injection-wait.enabled')
if ((@(Get-CapabilityInputMarkers -HostMode stock) -join '|') -cne ($StockMarkers -join '|') -or
    (@(Get-CapabilityInputMarkers -HostMode owned) -join '|') -cne ($OwnedMarkers -join '|')) {
    throw 'Stock normal startup and owned injection barriers require different exact marker sets.'
}
Must-Reject { Get-CapabilityInputMarkers -HostMode unsupported } 'an unknown input marker lane'
$MarkerLoops = @($Controller.FindAll({param($Node)
    $Node -is [Management.Automation.Language.ForEachStatementAst] -and
    $Node.Variable.Extent.Text -eq '$InputMarker' -and
    $Node.Condition.Extent.Text -match 'Get-CapabilityInputMarkers -HostMode \$Mode'
}, $true))
$HostLaunches = @($Controller.FindAll({param($Node)
    $Node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $Node.Left.Extent.Text -eq '$HostEntry' -and $Node.Right.Extent.Text -match '^Start-Owned'
}, $true))
if ($MarkerLoops.Count -ne 1 -or $HostLaunches.Count -ne 1 -or
    $MarkerLoops[0].Extent.EndOffset -gt $HostLaunches[0].Extent.StartOffset) {
    throw 'The actual host launch must use the lane-specific marker helper before startup.'
}
$MarkerLoop = [scriptblock]::Create($MarkerLoops[0].Extent.Text)
foreach ($Mode in @('stock','owned')) {
    $TargetDirectory = Join-Path $Fixture ('markers-' + $Mode)
    [void][IO.Directory]::CreateDirectory($TargetDirectory)
    & $MarkerLoop
    $ActualMarkers = @([IO.Directory]::GetFiles($TargetDirectory) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
    $ExpectedMarkers = @(if ($Mode -eq 'stock') { $StockMarkers } else { $OwnedMarkers }) | Sort-Object
    if (($ActualMarkers -join '|') -cne ($ExpectedMarkers -join '|')) {
        throw ('Actual setup wrote incorrect ' + $Mode + ' markers: ' + ($ActualMarkers -join '|'))
    }
    if ($ActualMarkers -contains 'reshade-raw-registration-before-injection.enabled') {
        throw ('The ' + $Mode + ' capability lane incorrectly claimed pre-registration timing.')
    }
}
$BeforeMarkerLiterals = @($Controller.FindAll({param($Node)
    $Node -is [Management.Automation.Language.StringConstantExpressionAst] -and
    $Node.Value -eq 'reshade-raw-registration-before-injection.enabled'
}, $true))
if ($BeforeMarkerLiterals.Count -ne 0) {
    throw 'Neither capability lane may select the separate pre-registration fixture.'
}
$Start = (Controller-Function 'Start-App').Extent.Text
if ($Start -notmatch "'copied-raw-input-buffer'" -or $Start -notmatch "'copied-wm-input'" -or
    $Start -notmatch '\$Fixture' -or $Start -notmatch '--sdk-dist=\$SdkDist' -or
    $Start -notmatch '--target=\$TargetPath' -or $Start -notmatch '--pid=\$\(\$HostProcess.Id\)' -or
    $Start -match '--(?:fake|mock|capabilities|input-capabilities)=') {
    throw 'Both lanes must launch genuine SDK producers against the exact controlled target.'
}
$Text = $Controller.Extent.Text
if ($Text -notmatch "\[ValidateSet\('stock', 'owned'\)\]" -or
    $Text -notmatch "'reshade-raw-wm-input-gate.enabled'" -or
    $Text -notmatch "'reshade-raw-buffer-input-gate.enabled'" -or
    $Text -notmatch 'Start-App strict \$false' -or $Text -notmatch 'Start-App strict \$true' -or
    $Text -notmatch 'Start-App permissive \$false' -or
    $Text -notmatch '& \$Node \$Validator --report') { throw 'The stock/owned actual-target lanes or final evidence validator disappeared.' }
$InputProof = Controller-Function 'Input-Proof'
$Spaces = @($InputProof.FindAll({param($Node)
    $Node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $Node.Member.Value -eq 'SendSpace'
}, $true))
$Unicode = @($InputProof.FindAll({param($Node)
    $Node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $Node.Member.Value -eq 'SendUnicodeText'
}, $true))
if ($Spaces.Count -ne 1 -or $Spaces[0].Arguments.Count -ne 0 -or $Unicode.Count -ne 0 -or
    $InputProof.Extent.Text -notmatch '\$Text -cne '' ''') {
    throw 'The raw-keyboard proof must send exactly one actual VK_SPACE and reject Unicode-packet substitutes.'
}
$InputCalls = @($Controller.FindAll({param($Node)
    $Node -is [Management.Automation.Language.CommandAst] -and $Node.GetCommandName() -eq 'Input-Proof'
}, $true) | Sort-Object { $_.Extent.StartOffset })
if ($InputCalls.Count -ne 2 -or $InputCalls[0].CommandElements.Count -ne 4 -or
    $InputCalls[1].CommandElements.Count -ne 4 -or
    $InputCalls[0].CommandElements[1].Extent.Text -cne '$Active' -or
    $InputCalls[1].CommandElements[1].Extent.Text -cne 'permissive' -or
    $InputCalls[0].CommandElements[2].Value -cne ' ' -or $InputCalls[0].CommandElements[3].Value -cne ' ' -or
    $InputCalls[1].CommandElements[2].Value -cne ' ' -or $InputCalls[1].CommandElements[3].Value -cne '  ') {
    throw 'Initial and post-rejection proofs must require one fresh space and cumulative two-space DOM text.'
}
$DomWaits = @($InputProof.FindAll({param($Node)
    $Node -is [Management.Automation.Language.CommandAst] -and $Node.GetCommandName() -eq 'Wait-Condition'
}, $true))
if ($DomWaits.Count -ne 1 -or $DomWaits[0].CommandElements[1] -isnot [Management.Automation.Language.ScriptBlockExpressionAst]) {
    throw 'Expected the actual DOM delivery predicate.'
}
$DomPredicate = [scriptblock]::Create($DomWaits[0].CommandElements[1].ScriptBlock.EndBlock.Extent.Text)

# Execute only the actual rejection predicate with synthetic observed evidence.
. ([scriptblock]::Create((Controller-Function 'Assert-StrictRejected').Extent.Text))
$HostProcess = [pscustomobject]@{ Id=303 }
$TargetPath = Join-Path $Fixture 'target/d3d11_overlay_test_host.exe'
$Report = @{target=@{creationTime100ns='134389999999999999'}}
$Good = [pscustomobject]@{
    rejected=$true; attachError=[pscustomobject]@{code='target-input-capability-unsupported'};
    authenticationCount=0; connectionCount=0; renderingCount=0; trueAckCount=0;
    wire=[pscustomobject]@{helloCount=1;outboundBytes=0;outboundPackets=0;outboundFrames=0;interceptTruePackets=0};
    wireConnections=@([pscustomobject]@{actualBytesWritten=0});
    hello=[pscustomobject]@{pid=303;path=$TargetPath;creationTime100ns=$Report.target.creationTime100ns;
        capabilities=@('input-capabilities-v1','copied-wm-input-v1')}
}
$script:Observed = $Good
function Read-State([string]$Member) { return $script:Observed }
$Member = 'strict'; $Expected = ' '
$BeforeDom = [pscustomobject]@{keydowns=4;downs=2;ups=2;wheel=@([pscustomobject]@{dy=120})}
$BeforeWheel = 1
$Delivered = [pscustomobject]@{value=' ';keydowns=5;downs=3;ups=3;
    wheel=@([pscustomobject]@{dy=120},[pscustomobject]@{dy=120});heldKeys=@()}
$script:Observed = [pscustomobject]@{windows=[pscustomobject]@{main=$Delivered}}
if (-not (& $DomPredicate)) { throw 'Fresh raw mouse/key/wheel delivery was rejected.' }
foreach ($Field in @('keydowns','downs','ups')) {
    $Stale = $Delivered | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $Stale.$Field = $BeforeDom.$Field
    $script:Observed = [pscustomobject]@{windows=[pscustomobject]@{main=$Stale}}
    if (& $DomPredicate) { throw ('The input proof accepted stale DOM ' + $Field) }
}
foreach ($Case in @(@{field='value';value=''}, @{field='heldKeys';value=@('Space')},
    @{field='wheel';value=@([pscustomobject]@{dy=120})},
    @{field='wheel';value=@([pscustomobject]@{dy=0},[pscustomobject]@{dy=0})})) {
    $BadDelivery = $Delivered | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $BadDelivery.($Case.field) = $Case.value
    $script:Observed = [pscustomobject]@{windows=[pscustomobject]@{main=$BadDelivery}}
    if (& $DomPredicate) { throw ('The input proof accepted missing/released DOM evidence ' + $Case.field) }
}
$script:Observed = $Good
Assert-StrictRejected
foreach ($Field in @('authenticationCount','connectionCount','renderingCount','trueAckCount')) {
    $script:Observed = $Good | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $script:Observed.$Field = 1
    Must-Reject { Assert-StrictRejected } ('strict pre-rejection ' + $Field)
}
foreach ($Field in @('outboundBytes','outboundPackets','outboundFrames','interceptTruePackets')) {
    $script:Observed = $Good | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $script:Observed.wire.$Field = 1
    Must-Reject { Assert-StrictRejected } ('strict outbound ' + $Field)
}
$script:Observed = $Good | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$script:Observed.wire.helloCount = 0
Must-Reject { Assert-StrictRejected } 'rejection without an actual native hello'
$script:Observed = $Good | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$script:Observed.hello.pid = 999
Must-Reject { Assert-StrictRejected } 'another target hello'
$script:Observed = $Good | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$script:Observed.hello.path = Join-Path $Fixture 'another-target.exe'
Must-Reject { Assert-StrictRejected } 'another executable hello'
$script:Observed = $Good | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$script:Observed.hello.creationTime100ns = '134389999999999998'
Must-Reject { Assert-StrictRejected } 'another target process incarnation hello'
$script:Observed = $Good | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$script:Observed.wireConnections[0].actualBytesWritten = 1
Must-Reject { Assert-StrictRejected } 'actual socket write despite zero packet-observer counters'
$script:Observed = $Good | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$script:Observed.hello.capabilities += 'copied-raw-input-buffer-v1'
Must-Reject { Assert-StrictRejected } 'optimistic stock buffered input support'

# Exercise the actual TCP peer proof without opening a socket.
. ([scriptblock]::Create((Controller-Function 'Tcp-Evidence').Extent.Text))
$script:Observed = [pscustomobject]@{processId=101;transport=[pscustomobject]@{port=33001}}
$script:ClientSockets = @([pscustomobject]@{LocalAddress='127.0.0.1';RemoteAddress='127.0.0.1';LocalPort=33001;RemotePort=51000;OwningProcess=101;State='Established'})
$script:HostSockets = @([pscustomobject]@{LocalAddress='127.0.0.1';RemoteAddress='127.0.0.1';LocalPort=51000;RemotePort=33001;OwningProcess=303;State='Established'})
function Get-NetTCPConnection { param($State,$OwningProcess,$ErrorAction)
    if ($OwningProcess -eq 101) { return $script:ClientSockets }
    if ($OwningProcess -eq 303) { return $script:HostSockets }
    throw 'Unexpected process query.'
}
$Tcp = Tcp-Evidence permissive
$script:HostSockets = @()
Must-Reject { Tcp-Evidence permissive } 'private socket without its exact target peer'
. ([scriptblock]::Create((Controller-Function 'Snapshot').Extent.Text))
$script:SnapshotSaved = $null
function Save-Json($Value,$Path) { $script:SnapshotSaved = $Value }
$RunDirectory = $Fixture
$Authenticated = [pscustomobject]@{pid=303;executablePath=$TargetPath;creationTime100ns=$Report.target.creationTime100ns}
$script:Observed = [pscustomobject]@{processId=101;transport=[pscustomobject]@{port=33001};authenticatedTarget=$Authenticated}
$script:HostSockets = @([pscustomobject]@{LocalPort=51000;RemotePort=33001;OwningProcess=303;State='Established'})
[void](Snapshot permissive 'exact-authenticated-target')
if (-not $script:SnapshotSaved.tcp) { throw 'The authenticated snapshot did not retain its real TCP proof.' }
foreach ($Case in @(@{field='pid';value=999}, @{field='executablePath';value=(Join-Path $Fixture 'other.exe')},
    @{field='creationTime100ns';value='134389999999999998'})) {
    $BadIdentity = $Authenticated | ConvertTo-Json -Compress | ConvertFrom-Json
    $BadIdentity.($Case.field) = $Case.value
    $script:Observed = [pscustomobject]@{authenticatedTarget=$BadIdentity}
    Must-Reject { Snapshot permissive 'wrong-authenticated-target' } ('authenticated target ' + $Case.field)
}
$Continuity = Controller-Guard 'permissiveBefore\.tcp'
$Before = [pscustomobject]@{tcp=$Tcp;authenticationCount=1;connectionCount=1;transportLostCount=0;targetDisconnectedCount=0}
$Report = @{permissiveBefore=$Before;permissiveAfter=($Before | ConvertTo-Json -Depth 8 | ConvertFrom-Json)}
& $Continuity
foreach ($Field in @('authenticationCount','connectionCount','transportLostCount','targetDisconnectedCount')) {
    $Report.permissiveAfter = $Before | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $Report.permissiveAfter.$Field++
    Must-Reject { & $Continuity } ('permissive continuity ' + $Field)
}
$Report.permissiveAfter = $Before | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$Report.permissiveAfter.tcp.remotePort++
Must-Reject { & $Continuity } 'replacement permissive socket'

$RawGuard = Controller-Guard 'Released\.RawBufferError'
$Mode = 'owned'; $Baseline = [pscustomobject]@{RawBuffer=10}
$Released = [pscustomobject]@{RawBufferError=0;RawBuffer=11}
& $RawGuard
$Released.RawBuffer = 10
Must-Reject { & $RawGuard } 'owned raw-buffer lane without a real delivered record'
$Released.RawBuffer = 11; $Released.RawBufferError = 5
Must-Reject { & $RawGuard } 'GetRawInputBuffer error'
if ($Text -notmatch 'Wait-ForReleasedRawInput' -or $Text -notmatch 'releasedRawBufferAdvanced') {
    throw 'The positive lane must retain actual released raw-buffer evidence.'
}

# Evaluate only the pure RGB comparison, without loading or calling pixel APIs.
$PixelFunction = Controller-Function 'Assert-ScenePixel'
$PixelTests = @($PixelFunction.FindAll({param($Node)
    $Node -is [Management.Automation.Language.BinaryExpressionAst] -and
    $Node.Extent.Text -match 'observedRgb\[0\]' -and
    $Node.Extent.Text -match 'observedRgb\[1\]' -and
    $Node.Extent.Text -match 'observedRgb\[2\]'
}, $true))
if ($PixelTests.Count -ne 1) { throw 'Expected the actual three-channel pixel comparison.' }
$PixelPredicate = [scriptblock]::Create($PixelTests[0].Extent.Text)
$Expected = @(198,40,40); $Probe = @{observedRgb=@(206,48,48)}
if (-not (& $PixelPredicate)) { throw 'The documented eight-level pixel tolerance was rejected.' }
foreach ($Channel in @(0,1,2)) {
    $Probe.observedRgb = @(198,40,40)
    $Probe.observedRgb[$Channel] += 9
    if (& $PixelPredicate) { throw 'A rendered pixel outside the strict tolerance was accepted.' }
}

# Inspect cleanup order; never execute the controller, launchers, or native manager.
$Try = @($Controller.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
if ($Try.Count -ne 1 -or -not $Try[0].Finally) { throw 'Expected one protected acceptance lifecycle.' }
$Finally = $Try[0].Finally
$HostCleanup = @($Finally.Statements | Where-Object {
    $_ -is [Management.Automation.Language.IfStatementAst] -and $_.Clauses[0].Item1.Extent.Text -eq '$HostProcess'
})
$Remove = @($Finally.FindAll({ param($Node) $Node -is [Management.Automation.Language.CommandAst] -and
    $Node.GetCommandName() -eq 'Invoke-CapabilityAddonTransaction' -and $Node.Extent.Text -match '-Operation remove'
}, $true))
$Preserve = @($Finally.FindAll({ param($Node) $Node -is [Management.Automation.Language.CommandAst] -and
    $Node.GetCommandName() -eq 'Assert-CapabilityProtectedManifest'
}, $true))
if ($HostCleanup.Count -ne 1 -or $Remove.Count -ne 1 -or $Preserve.Count -ne 1 -or
    $HostCleanup[0].Extent.EndOffset -gt $Remove[0].Extent.StartOffset -or
    $Remove[0].Extent.EndOffset -gt $Preserve[0].Extent.StartOffset) {
    throw 'Protected files must be verified after host exit and manager-only reserved removal.'
}
$Stop = Controller-Function 'Stop-OwnedAppTree'
foreach ($Required in @('Get-CimInstance Win32_Process', '\$Descendants\.Contains',
    '\$Row.ExecutablePath, \$Electron', 'Join-Path \$Stage ''inject.exe''', '\$null = \$Child.Handle',
    '\$Child.StartTime -lt \$RootStarted', '\$Handles.Add\(\$Child\)', 'WaitForExit\(5000\)')) {
    if ($Stop.Extent.Text -notmatch $Required) { throw ('Owned cleanup lost its retained-identity guard: ' + $Required) }
}
foreach ($Kill in @($Controller.FindAll({param($Node)
    $Node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $Node.Member.Value -eq 'Kill'
}, $true))) {
    if ($Kill.Arguments.Count -ne 0) { throw 'Cleanup must use the Windows PowerShell 5-compatible Kill() overload.' }
}
if ($Finally.Extent.Text -notmatch '\.stdout.Wait\(5000\)' -or
    $Finally.Extent.Text -notmatch '\.stderr.Wait\(5000\)' -or
    $Finally.Extent.Text -notmatch '\$Report.status = ''failed''') {
    throw 'Stream closure must be bounded and cleanup failures must fail acceptance.'
}
foreach ($Command in @($Controller.FindAll({ param($Node) $Node -is [Management.Automation.Language.CommandAst] }, $true))) {
    if ($Command.GetCommandName() -in @('Stop-Process','taskkill','taskkill.exe') -or
        ($Command.GetCommandName() -eq 'Remove-Item' -and $Command.Extent.Text -match '-Recurse')) {
        throw 'The controller contains broad process or recursive directory cleanup.'
    }
    if ($Command.GetCommandName() -eq 'Copy-Item' -and
        $Command.Extent.Text -notmatch '-Destination \$(?:TargetPath|RuntimePath|ForeignPath)\b') {
        throw 'Controller seed writes must remain inside fresh owned target destinations.'
    }
}
Write-Output 'CAPABILITY_HELPER_PROBE_PASS'
`);
});
