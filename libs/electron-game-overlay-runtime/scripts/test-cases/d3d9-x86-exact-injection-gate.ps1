$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "..\run-x86-exact-injection-gate.ps1") `
    -Backend d3d9
