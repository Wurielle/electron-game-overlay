[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Runner = (Resolve-Path (Join-Path $PSScriptRoot "..\run-electron-dx12.ps1")).Path

& $Runner -ClientMultiWindow -DeviceScaleFactor 1 -Wait
$ExitCode = $LASTEXITCODE
exit $ExitCode
