$ErrorActionPreference = "Stop"
& node (Join-Path $PSScriptRoot "..\..\tests\snapshot-destinations\source-cache-gate.cjs")
if ($LASTEXITCODE -ne 0) { throw "Present destination validation failed." }
