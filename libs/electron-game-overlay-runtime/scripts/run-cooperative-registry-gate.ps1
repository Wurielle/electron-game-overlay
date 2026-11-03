[CmdletBinding()]
param(
    [ValidateSet('x64', 'x86', 'all')]
    [string]$Architecture = 'all'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$Source = Join-Path $RepoRoot 'experiments\cooperative-registry'
$Header = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\src\ego_cooperative_registry.hpp'
$Cases = if ($Architecture -eq 'all') { @('x64', 'x86') } else { @($Architecture) }
$Results = @()
foreach ($Case in $Cases) {
    $Build = Join-Path $RepoRoot "build\cooperative-registry-$Case"
    $Platform = if ($Case -eq 'x86') { 'Win32' } else { 'x64' }
    $BeforeHash = (Get-FileHash -LiteralPath $Header -Algorithm SHA256).Hash
    & cmake.exe -S $Source -B $Build -G 'Visual Studio 17 2022' -A $Platform
    if ($LASTEXITCODE -ne 0) { throw "Cooperative registry $Case configure failed." }
    & cmake.exe --build $Build --config RelWithDebInfo
    if ($LASTEXITCODE -ne 0) { throw "Cooperative registry $Case build failed." }
    & ctest.exe --test-dir $Build -C RelWithDebInfo --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw "Cooperative registry $Case protocol tests failed." }
    if ((Get-FileHash -LiteralPath $Header -Algorithm SHA256).Hash -ne $BeforeHash) {
        throw 'The registry source changed during validation; rerun against a stable source.'
    }
    $Results += [ordered]@{ architecture = $Case; headerSha256 = $BeforeHash; passed = $true }
}
$Evidence = Join-Path $RepoRoot 'build\cooperative-registry-evidence.json'
[ordered]@{
    schemaVersion = 1
    scope = 'Same-process cooperative registry protocol; no native injection, graphics, or game acceptance.'
    results = $Results
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Evidence -Encoding UTF8
Write-Host "Cooperative registry protocol gate passed: $Evidence"
