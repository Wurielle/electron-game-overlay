$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "..\run-client-sdk-input-gate.ps1") `
    -Backend d3d9 `
    -Architecture x86 `
    @args
exit $LASTEXITCODE
