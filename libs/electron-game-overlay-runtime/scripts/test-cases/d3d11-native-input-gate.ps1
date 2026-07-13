$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "..\run-input-gate.ps1") -Backend d3d11
