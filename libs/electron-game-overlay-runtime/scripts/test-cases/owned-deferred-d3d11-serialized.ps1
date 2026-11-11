$ErrorActionPreference="Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\owned-deferred-bootstrap\run-gate.cjs") x64 serialized
if($LASTEXITCODE -ne 0){throw "Owned deferred D3D11 serialized gate failed."}
