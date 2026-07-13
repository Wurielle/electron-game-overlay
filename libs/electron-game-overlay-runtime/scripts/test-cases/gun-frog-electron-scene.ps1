[CmdletBinding()]
param(
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "..\run-injected-electron-scene.ps1") `
    -DisplayName "Gun-Frog" `
    -TargetExecutableName "Gun Frog.exe" `
    -TargetExecutablePath "C:\Program Files (x86)\Steam\steamapps\common\Gun Frog\Gun Frog.exe" `
    -LaunchUri "steam://rungameid/3173130" `
    -GunFrogButtonProof `
    -NoLaunch:$NoLaunch
