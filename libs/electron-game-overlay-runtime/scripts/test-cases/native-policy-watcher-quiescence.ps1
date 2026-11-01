param([string]$Report)
$ErrorActionPreference='Stop'
$RepoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
if(-not $Report){$Report=Join-Path $RepoRoot 'build/rc7-native-policy-quiescence.json'}
& node (Join-Path $RepoRoot 'libs/electron-game-overlay/tests/policy-watcher-quiescence.acceptance.cjs') $Report
if($LASTEXITCODE -ne 0){throw "Native watcher quiescence failed: $Report"}
