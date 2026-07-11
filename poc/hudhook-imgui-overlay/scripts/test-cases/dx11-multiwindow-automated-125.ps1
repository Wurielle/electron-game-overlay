[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Runner = (Resolve-Path (Join-Path $PSScriptRoot "..\run-electron-dx11.ps1")).Path

& $Runner -ClientMultiWindow -DeviceScaleFactor 1.25 -Wait
$ExitCode = $LASTEXITCODE
exit $ExitCode
