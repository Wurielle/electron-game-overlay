[CmdletBinding()]
param(
    [string]$ElectronExecutable,
    [string]$SdkDistA,
    [string]$SdkDistB,
    [ValidateSet('a-first', 'b-first', 'both')][string]$StartupOrder = 'both',
    [ValidateSet('graceful', 'crash', 'both')][string]$FirstAppExit = 'both',
    [ValidatePattern('^$|^[a-fA-F0-9]{40}$')][string]$SourceRevisionA = '',
    [ValidatePattern('^$|^[a-fA-F0-9]{40}$')][string]$SourceRevisionB = '',
    [switch]$RequireDifferentImplementations
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-client-sdk-cooperative-two-app-game-gate.ps1') @PSBoundParameters
