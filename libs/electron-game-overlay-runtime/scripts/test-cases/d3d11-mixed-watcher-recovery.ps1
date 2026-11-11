#requires -Version 7.2
[CmdletBinding()]
param([switch]$SkipBuild)
& (Join-Path $PSScriptRoot '..\run-mixed-watcher-recovery-gate.ps1') -SkipBuild:$SkipBuild
