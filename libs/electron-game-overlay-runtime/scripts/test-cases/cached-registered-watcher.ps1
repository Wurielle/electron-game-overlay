[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
    [Parameter(Mandatory = $true)][string]$PreloadPackageRoot,
    [ValidateSet('x64', 'Win32')][string]$Architecture = 'x64',
    [string]$NodePath = 'node.exe',
    [switch]$Logging
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'cached-runtime-watcher.ps1') -RuntimeDirectory $RuntimeDirectory `
    -PreloadPackageRoot $PreloadPackageRoot -Architecture $Architecture -NodePath $NodePath -Headless -Logging:$Logging
