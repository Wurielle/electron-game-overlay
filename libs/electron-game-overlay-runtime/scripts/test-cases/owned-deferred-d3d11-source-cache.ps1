$ErrorActionPreference="Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\owned-deferred-bootstrap\source-cache-gate.cjs")
if($LASTEXITCODE -ne 0){throw "Owned deferred D3D11 source-cache gate failed."}
