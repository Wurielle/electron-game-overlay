$ErrorActionPreference="Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\owned-deferred-bootstrap\run-gate.cjs") x64 contended
if($LASTEXITCODE -ne 0){throw "Owned deferred D3D11 contended gate failed."}
