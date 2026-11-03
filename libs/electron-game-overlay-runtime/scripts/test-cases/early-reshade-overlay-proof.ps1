#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$AddonPath,
    [ValidateSet('x64','Win32')][string]$Architecture = 'x64',
    [string]$DetoursSourceDirectory,
    [string]$SdkDist,
    [string]$ElectronPath,
    [switch]$GpuReadback,
    [switch]$SkipBuild
)
& (Join-Path $PSScriptRoot '..\run-early-reshade-overlay-proof.ps1') @PSBoundParameters
