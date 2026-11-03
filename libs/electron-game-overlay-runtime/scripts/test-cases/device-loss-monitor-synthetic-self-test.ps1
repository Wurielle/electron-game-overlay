[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\device-loss-monitor-self-test.ps1') -OutputDirectory $OutputDirectory
