$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "..\run-input-gate.ps1") `
    -Backend d3d9 `
    -Architecture x86
