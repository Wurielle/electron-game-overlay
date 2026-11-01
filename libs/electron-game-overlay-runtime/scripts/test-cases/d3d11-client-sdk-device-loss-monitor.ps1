[CmdletBinding()]
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$monitorRoot = Join-Path $repo ('build\device-loss-monitor\d3d11-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
Write-Host "First-device-loss diagnostics: $monitorRoot"
& (Join-Path $PSScriptRoot '..\run-client-sdk-input-gate.ps1') -Backend d3d11 -SkipBuild:$SkipBuild -DeviceLossMonitorDirectory $monitorRoot
