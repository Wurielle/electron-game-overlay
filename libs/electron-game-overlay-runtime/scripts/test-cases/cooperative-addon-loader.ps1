[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InjectorPath,
    [Parameter(Mandatory = $true)][ValidateSet('x64','Win32')][string]$Architecture,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-F]{32}$')][string]$AddonBuildId,
    [string]$InjectorSourcePath
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-cooperative-addon-loader-gate.ps1') @PSBoundParameters
