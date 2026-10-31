param([string]$ElectronExecutable)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-native-pointer-gate.ps1') -Backend d3d9 -Architecture x86 -ElectronExecutable $ElectronExecutable
