[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OfficialRuntimePath,
    [Parameter(Mandatory = $true)][string]$ForeignAddonPath,
    [string]$ElectronExecutable,
    [string]$SdkDist,
    [switch]$SkipBuild
)

& (Join-Path $PSScriptRoot '..\run-client-sdk-input-capabilities-gate.ps1') -Mode stock @PSBoundParameters
