[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RuntimeDirectory)
$ErrorActionPreference='Stop'
$Repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$FixtureDirectory=Join-Path $Repository 'build\unopened-target-selection-console\compile-x64\Release'
$Report=Join-Path $Repository 'build\unopened-target-selection-console\x64.native-refusal-negative-control.json'
& node (Join-Path $Repository 'libs\electron-game-overlay-runtime\tests\unopened-target-selection\native-gate.cjs') $FixtureDirectory (Join-Path $RuntimeDirectory 'inject.exe') $Report --negative-control
if($LASTEXITCODE -ne 0){throw 'Expected generation-24 preselection-refusal reproduction failed'}
