$ErrorActionPreference = "Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\owned-composition-policy\source-cache-gate.cjs")
if ($LASTEXITCODE -ne 0) { throw "Owned composition policy source-cache gate failed." }
