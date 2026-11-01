[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OfficialRuntimePath,
    [Parameter(Mandatory = $true)]
    [string]$ReShadeIncludeDirectory
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\..\..\..\experiments\reshade-addon-isolation\run.ps1') `
    -OfficialRuntimePath $OfficialRuntimePath `
    -ReShadeIncludeDirectory $ReShadeIncludeDirectory
