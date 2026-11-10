[CmdletBinding()]
param([ValidateSet('x64','x86')][string]$Architecture = 'x64')
$ErrorActionPreference = 'Stop'
$Repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$FixtureDirectory = Join-Path $Repository "build\unopened-target-selection-console\compile-$Architecture\Release"
$Platform = if ($Architecture -eq 'x86') {'win32-ia32'} else {'win32-x64'}
$Injector = Join-Path $Repository "libs\electron-game-overlay-runtime\dist\$Platform\inject.exe"
$Report = Join-Path $Repository "build\unopened-target-selection-console\$Architecture.native-refusal.json"
# Build once with unopened-target-selection-console.ps1 before running this case.
& node (Join-Path $Repository 'libs\electron-game-overlay-runtime\tests\unopened-target-selection\native-gate.cjs') $FixtureDirectory $Injector $Report
if ($LASTEXITCODE -ne 0) {throw 'Owned process-access refusal gate failed'}
