[CmdletBinding()]
param([switch]$SkipBuild, [string]$ElectronExecutable, [string]$SdkDistA, [string]$SdkDistB)

& (Join-Path $PSScriptRoot '..\run-client-sdk-cooperative-surface-lifecycle-gate.ps1') @PSBoundParameters
