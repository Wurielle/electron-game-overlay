[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"

# Human-facing acceptance case: two independent production Electron app
# processes concurrently publish colliding local window IDs into one controlled
# D3D11 target, then prove shared input ownership survives an abrupt app exit.
& (Join-Path `
        $PSScriptRoot `
        "..\run-client-sdk-two-app-one-target-gate.ps1") `
    -SkipBuild:$SkipBuild
