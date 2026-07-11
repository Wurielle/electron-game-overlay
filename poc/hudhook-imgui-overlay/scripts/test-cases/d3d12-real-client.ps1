[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Runner = (Resolve-Path (Join-Path $PSScriptRoot "..\run-electron-dx12.ps1")).Path

& $Runner -Client -Wait
$ExitCode = $LASTEXITCODE
exit $ExitCode
