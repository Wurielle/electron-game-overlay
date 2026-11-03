#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$AddonPath,
    [ValidateSet('x64', 'Win32')][string]$Architecture = 'x64',
    [string]$ReshadeIncludeDirectory,
    [ValidateRange(1000, 600000)][int]$LifetimeMs = 20000
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-late-d3d11-adoption-prototype.ps1') @PSBoundParameters
