[CmdletBinding()]
param([ValidateSet("x64", "x86")][string]$Architecture = "x64")
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../../..")).Path
& node.exe (Join-Path $RepoRoot "libs/electron-game-overlay-runtime/tests/present-forwarding/run-gate.cjs") $Architecture
if ($LASTEXITCODE -ne 0) { throw "Source-pinned Present forwarding contract failed: $LASTEXITCODE" }
