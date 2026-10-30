[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OfficialRuntimePath,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
& (Join-Path `
    $PSScriptRoot `
    "..\run-official-reshade-addon-preflight-gate.ps1") `
    -OfficialRuntimePath $OfficialRuntimePath `
    -SkipBuild:$SkipBuild
