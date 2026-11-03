#requires -Version 7.2
[CmdletBinding()]
param(
    [string]$RuntimePath,
    [ValidateSet('x64', 'Win32')][string]$Architecture = 'x64',
    [switch]$Warp,
    [switch]$SkipBuild
)

& (Join-Path $PSScriptRoot '..\run-d3d12-initial-upload-queue-gate.ps1') @PSBoundParameters
