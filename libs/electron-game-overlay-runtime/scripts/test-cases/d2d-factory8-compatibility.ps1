[CmdletBinding()]
param([ValidateSet("x64", "x86")][string]$Architecture = "x64")
$ErrorActionPreference = "Stop"
& node.exe (Join-Path $PSScriptRoot "../../tests/rendering-failure-probes/run-probe.cjs") d2d_factory8 $Architecture
if ($LASTEXITCODE -ne 0) { throw "Direct2D factory compatibility probe failed: $LASTEXITCODE" }
