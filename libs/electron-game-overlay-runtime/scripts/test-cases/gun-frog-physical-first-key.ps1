param([Parameter(Mandatory=$true)][string]$GameExecutable, [string]$ElectronExecutable)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'gun-frog-explicit-keyboard-focus.ps1') -GameExecutable $GameExecutable -ElectronExecutable $ElectronExecutable -PhysicalFirstKeys
