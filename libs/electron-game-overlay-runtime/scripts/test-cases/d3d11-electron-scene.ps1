[CmdletBinding()]
param(
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "..\run-electron-scene.ps1") `
    -Backend d3d11 `
    -NoLaunch:$NoLaunch
