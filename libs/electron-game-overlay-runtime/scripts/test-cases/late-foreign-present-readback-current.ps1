param([ValidateSet("x64", "x86")][string]$Architecture = "x64")
$ErrorActionPreference = "Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\foreign-present\run-gate.cjs") $Architecture all production
if ($LASTEXITCODE -ne 0) { throw "Present destination validation failed." }
