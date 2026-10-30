param([Parameter(Mandatory=$true)][string]$GameExecutable, [string]$ElectronExecutable, [switch]$PhysicalKeyboard)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-explicit-focus-gate.ps1') -GameExecutable $GameExecutable -ElectronExecutable $ElectronExecutable -PhysicalKeyboard:$PhysicalKeyboard
