[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Runner = (Resolve-Path (Join-Path $PSScriptRoot "..\run-electron-dx11.ps1")).Path

& $Runner -Client -Wait
$ExitCode = $LASTEXITCODE
exit $ExitCode
