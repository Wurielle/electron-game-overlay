[CmdletBinding()]
param([switch]$VisibleFixture)
$ErrorActionPreference = "Stop"
$Arguments = @((Join-Path $PSScriptRoot "../../tests/rendering-failure-probes/run-owned-ego.cjs"))
if ($VisibleFixture) { $Arguments += '--visible' }
& node.exe @Arguments
if ($LASTEXITCODE -ne 0) { throw "Owned EGO input progress fixture failed: $LASTEXITCODE" }
