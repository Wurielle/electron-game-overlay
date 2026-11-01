[CmdletBinding()]
param([switch]$SkipBuild, [ValidateRange(60, 900)][int]$InteractionTimeoutSeconds = 600)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$monitorRoot = Join-Path $repo ('build\device-loss-monitor\gun-frog-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
Write-Host "First-device-loss diagnostics: $monitorRoot"
& (Join-Path $PSScriptRoot 'gun-frog-client-sdk.ps1') -SkipBuild:$SkipBuild -InteractionTimeoutSeconds $InteractionTimeoutSeconds -DeviceLossMonitorDirectory $monitorRoot
