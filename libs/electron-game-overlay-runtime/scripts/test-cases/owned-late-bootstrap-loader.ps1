[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InjectorPath,
    [Parameter(Mandatory = $true)][string]$InjectorSourcePath,
    [Parameter(Mandatory = $true)][ValidateSet('x64','Win32')][string]$Architecture,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-F]{32}$')][string]$AddonBuildId,
    [switch]$SkipBuild
)
& (Join-Path $PSScriptRoot '..\run-owned-late-bootstrap-loader-gate.ps1') @PSBoundParameters
exit $LASTEXITCODE
