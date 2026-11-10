param([ValidateSet("x64", "x86")][string]$Architecture="x64")
$ErrorActionPreference="Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\delayed-hook-publication\run-gate.cjs") $Architecture serialized
if($LASTEXITCODE -ne 0){throw "Serialized delayed-hook device-observation control failed."}
