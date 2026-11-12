[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
    [ValidateSet('x64', 'Win32')][string]$Architecture = 'x64',
    [string]$NodePath = 'node.exe',
    [switch]$Logging,
    [switch]$RequireElevated,
    [switch]$Headless,
    [string]$PreloadPackageRoot
)

$ErrorActionPreference = 'Stop'
$Fixture = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\tests\cache-bootstrap')).Path
$BuildRoot = (New-Item -ItemType Directory -Force -Path (Join-Path $Fixture "..\..\..\..\build\cached-runtime-watcher\$Architecture")).FullName
$env:EGO_CACHE_FIXTURE_ROOT = $BuildRoot
$env:EGO_CACHE_FIXTURE_RUNTIME = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$env:EGO_CACHE_FIXTURE_LOGGING = if ($Logging) { '1' } else { '0' }
$env:EGO_CACHE_FIXTURE_REQUIRE_ELEVATED = if ($RequireElevated) { '1' } else { '0' }
$env:EGO_CACHE_FIXTURE_HEADLESS = if ($Headless) { '1' } else { '0' }
$env:EGO_CACHE_FIXTURE_ARCH = $Architecture
$env:EGO_CACHE_FIXTURE_PRELOAD_PACKAGE = if ($PreloadPackageRoot) { (Resolve-Path -LiteralPath $PreloadPackageRoot).Path } else { '' }
& cmake.exe -S $Fixture -B $BuildRoot -G 'Visual Studio 17 2022' -A $Architecture
if ($LASTEXITCODE -ne 0) { throw 'Cached runtime graphics fixture configure failed.' }
& cmake.exe --build $BuildRoot --config Release
if ($LASTEXITCODE -ne 0) { throw 'Cached runtime graphics fixture build failed.' }
$env:EGO_CACHE_FIXTURE_HOST = Join-Path $BuildRoot 'Release\cache_graphics_host.exe'
& $NodePath --test --test-reporter=tap (Join-Path $Fixture 'watcher.acceptance.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Cached runtime watcher and graphics test failed.' }
