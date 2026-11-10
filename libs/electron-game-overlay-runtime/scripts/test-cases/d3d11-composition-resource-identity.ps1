[CmdletBinding()]
param(
    [ValidateSet("x64", "x86")][string]$Architecture = "x64",
    [string]$Runtime,
    [string]$BaselineRuntime
)
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../../..")).Path
$Arguments = @((Join-Path $RepoRoot "libs/electron-game-overlay-runtime/tests/d3d11-resource-identity/run-gate.cjs"), "--architecture", $Architecture)
if ($Runtime) { $Arguments += @("--runtime", $Runtime) }
if ($BaselineRuntime) { $Arguments += @("--baseline-runtime", $BaselineRuntime) }
& node.exe @Arguments
if ($LASTEXITCODE -ne 0) { throw "Offscreen D3D11 resource identity regression failed: $LASTEXITCODE" }
