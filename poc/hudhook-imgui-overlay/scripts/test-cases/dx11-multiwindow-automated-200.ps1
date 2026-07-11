[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Runner = (Resolve-Path (Join-Path $PSScriptRoot "..\run-electron-dx11.ps1")).Path

& $Runner -ClientMultiWindow -DeviceScaleFactor 2 -Wait
$ExitCode = $LASTEXITCODE
exit $ExitCode
