param([string]$ElectronExecutable)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot '..\run-native-pointer-gate.ps1') -Backend d3d11 -Architecture x64 -ScaleFactor 1.5 -ElectronExecutable $ElectronExecutable
