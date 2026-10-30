[CmdletBinding()]
param([switch]$SkipBuild)

# Holds a controlled target before device creation, loads a compatible project
# runtime, then proves the production SDK reuses it and loads only its add-on.
& (Join-Path $PSScriptRoot "..\run-client-sdk-process-start-injection-gate.ps1") `
    -Backend d3d11 `
    -ExistingCompatibleRuntime `
    -SkipBuild:$SkipBuild
