[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TargetExecutable,
    [string[]]$TargetArguments = @(),
    [string]$ElectronExecutable,
    [string]$SdkDist,
    [ValidateRange(1, 64)][int]$Cycles = 8
)

& (Join-Path $PSScriptRoot '..\run-client-sdk-cooperative-resource-soak-gate.ps1') @PSBoundParameters
