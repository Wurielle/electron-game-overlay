[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$BundledRuntimeDirectory)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$env:EGO_TEST_BUNDLED_RUNTIME = (Resolve-Path -LiteralPath $BundledRuntimeDirectory).Path
Push-Location $repo
try {
    & node --test --test-reporter=tap 'libs/electron-game-overlay/tests/native-policy-stdin.acceptance.cjs'
    if ($LASTEXITCODE -ne 0) { throw 'Native policy stdin acceptance failed.' }
} finally {
    Pop-Location
}
