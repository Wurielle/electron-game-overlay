[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "..\run-client-sdk-multi-swapchain-gate.ps1") `
    -Backend d3d11 `
    -SkipBuild:$SkipBuild
