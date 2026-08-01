[CmdletBinding()]
param([switch]$SkipBuild)

# Closes the public SDK session while the controlled D3D11 target and Electron
# producer stay alive, then proves fail-open input and dormant resource cleanup.
& (Join-Path $PSScriptRoot "..\run-client-sdk-session-deactivation-gate.ps1") `
    -Backend d3d11 `
    -SkipBuild:$SkipBuild
