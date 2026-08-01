[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "..\run-client-sdk-target-surface-drain-gate.ps1") `
    -Backend d3d12 `
    -SkipBuild:$SkipBuild
