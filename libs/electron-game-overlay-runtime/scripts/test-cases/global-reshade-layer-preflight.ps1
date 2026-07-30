[CmdletBinding()]
param(
    [string]$InjectorPath,
    [string]$ReShadePath,
    [string]$HostPath
)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "..\run-global-reshade-layer-preflight-gate.ps1") `
    @PSBoundParameters
