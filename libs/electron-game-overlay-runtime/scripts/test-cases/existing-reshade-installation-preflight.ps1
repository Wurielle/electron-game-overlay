[CmdletBinding()]
param(
    [string]$InjectorPath,
    [string]$ReShadePath
)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "..\run-existing-reshade-installation-preflight-gate.ps1") `
    @PSBoundParameters
