$ErrorActionPreference="Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\composition-window-eligibility\source-cache-gate.cjs")
if($LASTEXITCODE -ne 0){throw "Composition window eligibility source-cache gate failed."}
