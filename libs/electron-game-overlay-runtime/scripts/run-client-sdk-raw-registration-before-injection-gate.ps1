[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d11", "d3d12")]
    [string]$Backend,
    [switch]$SkipBuild,
    [Parameter(DontShow = $true)]
    [ValidateSet("explicit-hwnd", "null-focus")]
    [string]$RawRegistrationTarget = "explicit-hwnd"
)

$ErrorActionPreference = "Stop"
$InputGate = Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1"

$First = $true
foreach ($Mode in @("wm-input", "raw-buffer")) {
    & $InputGate `
        -Backend $Backend `
        -InputMode $Mode `
        -RawRegistrationTiming before-injection `
        -RawRegistrationTarget $RawRegistrationTarget `
        -AttemptCountOverride 1 `
        -SkipBuild:($SkipBuild -or -not $First)
    $First = $false
}

$TargetMarker = if ($RawRegistrationTarget -eq "null-focus") {
    "NULL_TARGET_"
}
else {
    ""
}
Write-Host (
    "$($Backend.ToUpperInvariant())_${TargetMarker}" +
    "RAW_REGISTRATION_BEFORE_INJECTION_CLIENT_SDK_GATE_PASS"
)
