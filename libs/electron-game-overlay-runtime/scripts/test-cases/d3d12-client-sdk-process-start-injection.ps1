[CmdletBinding()]
param([switch]$SkipBuild)

# Deterministic process-exists-before-injection gate. The controlled process is
# created suspended; this is not an unsuspended arbitrary-game timing claim.
& (Join-Path $PSScriptRoot "..\run-client-sdk-process-start-injection-gate.ps1") `
    -Backend d3d12 `
    -SkipBuild:$SkipBuild
