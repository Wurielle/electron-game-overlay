param(
    [ValidateSet("x64", "x86")][string]$Architecture = "x64",
    [string]$BuildCacheRoot = "build/candidate-gen24-cache"
)
$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "d3d11-composition-window-routing.ps1") -Architecture $Architecture -BuildCacheRoot $BuildCacheRoot -NonInteractiveToolPopup
if ($LASTEXITCODE -ne 0) { throw "Composition popup lifetime graphics host failed." }
