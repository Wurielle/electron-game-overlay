param([string]$ElectronExecutable, [switch]$PhysicalKeyboard)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-explicit-focus-gate.ps1') -ElectronExecutable $ElectronExecutable -PhysicalKeyboard:$PhysicalKeyboard -FutureTarget -IdleSeconds 130
