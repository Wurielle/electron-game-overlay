$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "..\run-client-sdk-input-gate.ps1") -Backend d3d10
exit $LASTEXITCODE
