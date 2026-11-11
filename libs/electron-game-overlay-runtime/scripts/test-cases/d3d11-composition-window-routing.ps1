param(
    [ValidateSet("x64", "x86")][string]$Architecture = "x64",
    [string]$BuildCacheRoot = "build/candidate-gen24-cache",
    [switch]$AmbiguousWindows,
    [switch]$AllowSurfaceRecreation,
    [switch]$NonInteractiveToolPopup
)
$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
$Cache = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $BuildCacheRoot))
$HostPath = Join-Path $Cache "production-$Architecture\RelWithDebInfo\d3d11_composition_overlay_test_host.exe"
if (-not (Test-Path -LiteralPath $HostPath -PathType Leaf)) { throw "Build the d3d11_composition_overlay_test_host target first: $HostPath" }
$HostArguments = @()
if ($AmbiguousWindows) { $HostArguments += "--multi-swapchain" }
if ($AllowSurfaceRecreation) { $HostArguments += "--allow-surface-recreation" }
if ($NonInteractiveToolPopup) { $HostArguments += "--noninteractive-tool-popup" }
# An actual visible graphics host for a separately authorized renderer/input run.
# This launcher performs no injection and synthesizes no input.
& $HostPath @HostArguments
if ($LASTEXITCODE -ne 0) { throw "Composition graphics host failed with exit code $LASTEXITCODE." }
