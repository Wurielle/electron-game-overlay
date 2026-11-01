[CmdletBinding()]
param([string]$ElectronExecutable, [string]$SdkDist, [switch]$SkipBuild)

& (Join-Path $PSScriptRoot '..\run-client-sdk-input-capabilities-gate.ps1') -Mode owned @PSBoundParameters
