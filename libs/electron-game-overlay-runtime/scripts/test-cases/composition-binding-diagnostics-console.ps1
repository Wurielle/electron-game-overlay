param([ValidateSet("x64", "x86")][string]$Architecture="x64")
$ErrorActionPreference="Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\composition-binding-diagnostics\run-gate.cjs") $Architecture
if($LASTEXITCODE -ne 0){throw "Composition binding diagnostic console gate failed."}
