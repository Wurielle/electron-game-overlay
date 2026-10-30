[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d11", "d3d12")]
    [string]$Backend,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$InputGate = Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1"

$First = $true
foreach ($Mode in @("wm-input", "raw-buffer")) {
    & $InputGate `
        -Backend $Backend `
        -InputMode $Mode `
        -AttemptCountOverride 1 `
        -SkipBuild:($SkipBuild -or -not $First)
    $First = $false
}

Write-Host "$($Backend.ToUpperInvariant())_RAW_INPUT_CLIENT_SDK_GATE_PASS"
