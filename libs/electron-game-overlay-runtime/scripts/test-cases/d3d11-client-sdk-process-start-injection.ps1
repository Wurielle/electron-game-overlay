[CmdletBinding()]
param([switch]$SkipBuild)

# Deterministic process-exists-before-injection gate. The controlled process
# starts normally, then waits at a test-only pre-device barrier; this is not an
# arbitrary-game timing claim.
& (Join-Path $PSScriptRoot "..\run-client-sdk-process-start-injection-gate.ps1") `
    -Backend d3d11 `
    -SkipBuild:$SkipBuild
