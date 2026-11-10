$ErrorActionPreference="Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\composition-binding-diagnostics\source-cache-gate.cjs")
if($LASTEXITCODE -ne 0){throw "Composition binding diagnostic source-cache gate failed."}
