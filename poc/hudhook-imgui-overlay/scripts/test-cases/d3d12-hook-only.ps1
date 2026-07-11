[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$BuildScript = (Resolve-Path (Join-Path $PSScriptRoot "..\build-dx12.ps1")).Path
$Runner = (Resolve-Path (Join-Path $PSScriptRoot "..\run-dx12.ps1")).Path

& $BuildScript
& $Runner -Wait
$ExitCode = $LASTEXITCODE
exit $ExitCode
