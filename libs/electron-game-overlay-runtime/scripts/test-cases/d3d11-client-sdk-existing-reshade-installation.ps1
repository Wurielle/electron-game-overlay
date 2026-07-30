[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OfficialRuntimePath,
    [switch]$SkipBuild
)

# Copies a user-supplied official/stock x64 ReShade runtime under an inactive
# DLL name in an isolated controlled D3D11 target, then proves the production
# exact-PID SDK path refuses injection without breaking or modifying that
# installation.
& (Join-Path `
    $PSScriptRoot `
    "..\run-client-sdk-existing-reshade-installation-gate.ps1") `
    -OfficialRuntimePath $OfficialRuntimePath `
    -SkipBuild:$SkipBuild
