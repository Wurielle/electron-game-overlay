param([string]$ElectronExecutable)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-native-pointer-gate.ps1') -Backend d3d12 -Architecture x64 -ElectronExecutable $ElectronExecutable
