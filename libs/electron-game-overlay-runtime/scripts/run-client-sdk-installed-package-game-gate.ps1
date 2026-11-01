[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PairReport,
    [string]$GameExecutable = 'C:/Program Files (x86)/Steam/steamapps/common/Gun Frog/Gun Frog.exe',
    [string]$ElectronExecutable,
    [ValidateSet('a-first', 'b-first', 'both')][string]$StartupOrder = 'both',
    [ValidateSet('graceful', 'crash', 'both')][string]$FirstAppExit = 'both'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$PairReport = (Resolve-Path -LiteralPath $PairReport).Path
$Node = (Get-Command node.exe -CommandType Application -All -ErrorAction Stop | Select-Object -First 1).Source
$Helper = Join-Path $RepoRoot 'apps\client\scripts\installed-cooperative-sdk.cjs'
# This helper only inspects files and package resolution; it never imports SDK
# implementation code, starts Electron, observes a desktop or loads a DLL.
$ObservedText = & $Node $Helper --pair-report $PairReport
if ($LASTEXITCODE -ne 0) { throw 'Installed package provenance failed before starting game acceptance.' }
$Observed = ($ObservedText -join [Environment]::NewLine) | ConvertFrom-Json
$ObservationPath = Join-Path (Split-Path -Parent $PairReport) ('game-entrypoint-preflight-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff') + '.json')
[IO.File]::WriteAllText($ObservationPath, (($Observed | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
Write-Host "Installed development-package provenance: $ObservationPath"

$Arguments = @{
    GameExecutable = $GameExecutable
    SdkDistA = $Observed.participants.a.sdkDist
    SdkDistB = $Observed.participants.b.sdkDist
    AppRootA = $Observed.participants.a.consumerRoot
    AppRootB = $Observed.participants.b.consumerRoot
    FixturePath = (Join-Path $RepoRoot 'apps\client\scripts\installed-two-app-game-fixture.cjs')
    StartupOrder = $StartupOrder
    FirstAppExit = $FirstAppExit
    RequireDifferentImplementations = $true
}
if ($ElectronExecutable) { $Arguments.ElectronExecutable = $ElectronExecutable }
# Reuse every real module, pixel, input, crash/survivor and relaunch oracle.
& (Join-Path $PSScriptRoot 'run-client-sdk-cooperative-two-app-game-gate.ps1') @Arguments
