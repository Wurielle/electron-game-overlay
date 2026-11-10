[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../../..")).Path
& node.exe (Join-Path $RepoRoot "libs/electron-game-overlay-runtime/tests/compatibility-snapshot/source-cache-gate.cjs")
if ($LASTEXITCODE -ne 0) { throw "Compatibility snapshot source-cache gate failed: $LASTEXITCODE" }
