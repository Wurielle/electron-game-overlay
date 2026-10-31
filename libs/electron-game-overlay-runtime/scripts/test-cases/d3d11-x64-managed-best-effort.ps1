param([string]$ElectronExecutable)
& (Join-Path $PSScriptRoot '..\run-managed-target-gate.ps1') -BestEffort -ElectronExecutable $ElectronExecutable
