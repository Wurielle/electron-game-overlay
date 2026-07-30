[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OfficialRuntimePath,
    [switch]$SkipBuild
)

# End-to-end production gate for version-agnostic official-ReShade coexistence:
# a benign runtime identity change must still use the managed public add-on,
# connect through the real Steam watcher, and preserve the whole installation.
& (Join-Path `
    $PSScriptRoot `
    "..\run-client-sdk-existing-reshade-upgrade-gate.ps1") `
    -OfficialRuntimePath $OfficialRuntimePath `
    -SkipBuild:$SkipBuild
