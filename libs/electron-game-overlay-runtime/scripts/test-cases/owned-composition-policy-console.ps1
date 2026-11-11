param([ValidateSet("x64", "x86")][string]$Architecture = "x64")
$ErrorActionPreference = "Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\owned-composition-policy\run-gate.cjs") $Architecture
if ($LASTEXITCODE -ne 0) { throw "Owned composition policy console gate failed." }
