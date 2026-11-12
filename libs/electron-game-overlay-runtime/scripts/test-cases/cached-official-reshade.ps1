[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
    [Parameter(Mandatory = $true)][string]$OfficialRuntimePath,
    [Parameter(Mandatory = $true)][string]$PreviousAddonPath,
    [string]$NodePath = 'node.exe',
    [switch]$Logging
)

$ErrorActionPreference = 'Stop'
$Fixture = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\tests\cache-bootstrap')).Path
$BuildRoot = (New-Item -ItemType Directory -Force -Path (Join-Path $Fixture '..\..\..\..\build\cached-official-reshade')).FullName
$env:EGO_OFFICIAL_FIXTURE_ROOT = $BuildRoot
$env:EGO_OFFICIAL_FIXTURE_RUNTIME = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$env:EGO_OFFICIAL_FIXTURE_STOCK = (Resolve-Path -LiteralPath $OfficialRuntimePath).Path
$env:EGO_OFFICIAL_FIXTURE_PREVIOUS = (Resolve-Path -LiteralPath $PreviousAddonPath).Path
$env:EGO_OFFICIAL_FIXTURE_LOGGING = if ($Logging) { '1' } else { '0' }
& cmake.exe -S $Fixture -B $BuildRoot -G 'Visual Studio 17 2022' -A x64
if ($LASTEXITCODE -ne 0) { throw 'Official cache fixture configuration failed.' }
& cmake.exe --build $BuildRoot --config Release
if ($LASTEXITCODE -ne 0) { throw 'Official cache fixture build failed.' }
$env:EGO_OFFICIAL_FIXTURE_HOST = Join-Path $BuildRoot 'Release\cache_graphics_host.exe'
& $NodePath --test --test-reporter=tap (Join-Path $Fixture 'official-cache.acceptance.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Official ReShade cache gate failed.' }
