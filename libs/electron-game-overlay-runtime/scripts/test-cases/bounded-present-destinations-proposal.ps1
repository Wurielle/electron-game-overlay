param([ValidateSet("x64", "x86")][string]$Architecture = "x64")
$ErrorActionPreference = "Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\snapshot-destinations\run-gate.cjs") $Architecture
if ($LASTEXITCODE -ne 0) { throw "Bounded Present destination proposal gate failed." }
