[CmdletBinding()]
param([ValidateSet("x64", "x86")][string]$Architecture = "x64")
$ErrorActionPreference = "Stop"
& node.exe (Join-Path $PSScriptRoot "../../tests/rendering-failure-probes/run-probe.cjs") on_demand_input $Architecture
if ($LASTEXITCODE -ne 0) { throw "On-demand input progress probe failed: $LASTEXITCODE" }
