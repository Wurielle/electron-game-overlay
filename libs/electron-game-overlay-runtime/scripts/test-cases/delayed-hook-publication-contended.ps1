param([ValidateSet("x64", "x86")][string]$Architecture="x64")
$ErrorActionPreference="Stop"
# This is a deliberately failing production gate on frozen candidate 1012.
# Exit 3 means the real device missed ReShade observation; it is not acceptance.
& node (Join-Path $PSScriptRoot "..\..\tests\delayed-hook-publication\run-gate.cjs") $Architecture contended
if($LASTEXITCODE -ne 0){throw "Contended delayed-hook device-observation gate failed; inspect the preserved reproduction report (exit $LASTEXITCODE)."}
