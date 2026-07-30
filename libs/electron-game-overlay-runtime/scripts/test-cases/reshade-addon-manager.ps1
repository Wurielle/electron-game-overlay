[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

& (Join-Path $PSScriptRoot '..\run-reshade-addon-manager-gate.ps1')
exit $LASTEXITCODE
