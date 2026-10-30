[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "..\run-client-sdk-target-surface-drain-gate.ps1") `
    -Backend d3d11 `
    -SkipBuild:$SkipBuild
