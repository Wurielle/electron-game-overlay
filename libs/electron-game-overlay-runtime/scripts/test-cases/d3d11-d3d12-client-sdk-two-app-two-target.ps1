[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"

# Human-facing acceptance case: two independent production Electron app
# processes concurrently own isolated overlay sessions against separate
# controlled D3D11 and D3D12 target PIDs.
& (Join-Path `
        $PSScriptRoot `
        "..\run-client-sdk-two-app-two-target-gate.ps1") `
    -SkipBuild:$SkipBuild
