[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$AddonPath,
    [ValidateSet('x64','Win32')][string]$Architecture = 'x64',
    [string]$SdkDist,
    [string]$ElectronPath,
    [ValidateRange(20000,120000)][int]$LifetimeMs = 30000,
    [switch]$GpuReadback,
    [switch]$SkipBuild
)
& (Join-Path $PSScriptRoot '..\run-late-d3d11-overlay-proof.ps1') @PSBoundParameters
