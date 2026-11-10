$ErrorActionPreference="Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\composition-auxiliary-lifetime\source-cache-gate.cjs")
if($LASTEXITCODE -ne 0){throw "Composition auxiliary lifetime source-cache gate failed."}
