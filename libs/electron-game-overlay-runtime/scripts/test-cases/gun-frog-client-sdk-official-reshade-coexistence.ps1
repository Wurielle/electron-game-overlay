[CmdletBinding()]
param(
    [string]$OfficialRuntimePath,
    [ValidateRange(60, 900)]
    [int]$InteractionTimeoutSeconds = 600,
    [switch]$SkipBuild
)

# Real-game coexistence gate for a stock full-add-on ReShade host. The runner
# aborts if Gun Frog already has any target-local ReShade/proxy/mod artifacts,
# seeds only uniquely owned test files, and restores the original clean game
# directory in its finally block.
& (Join-Path `
    $PSScriptRoot `
    "..\run-client-sdk-gun-frog-official-reshade-coexistence-gate.ps1") `
    -OfficialRuntimePath $OfficialRuntimePath `
    -InteractionTimeoutSeconds $InteractionTimeoutSeconds `
    -SkipBuild:$SkipBuild
