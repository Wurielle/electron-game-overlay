#requires -Version 7.2
# First post-load Present/adoption runs on a worker while the HWND owner is
# deliberately busy for 2.8 seconds; all input below remains synthetic.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$AddonPath,
    [ValidateSet('x64', 'Win32')][string]$Architecture = 'x64',
    [string]$SdkDist,
    [string]$ElectronPath,
    [ValidateRange(20000, 180000)][int]$LifetimeMs = 60000,
    [ValidateRange(250, 1000)][int]$HoldMilliseconds = 400,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-late-d3d11-same-hwnd-proof.ps1') -Case primary-paused -UiBusyMilliseconds 2800 @PSBoundParameters
