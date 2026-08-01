[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "..\run-client-sdk-raw-registration-before-injection-gate.ps1") `
    -Backend d3d11 `
    -SkipBuild:$SkipBuild
