param([ValidateSet("x64", "x86")][string]$Architecture="x64")
$ErrorActionPreference="Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\composition-auxiliary-lifetime\run-gate.cjs") $Architecture
if($LASTEXITCODE -ne 0){throw "Composition auxiliary lifetime console gate failed."}
