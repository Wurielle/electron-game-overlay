[CmdletBinding()]
param([string]$ReportPath)
$ErrorActionPreference='Stop'
$Repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Launcher=Join-Path $Repository 'libs/electron-game-overlay-runtime/tests/elevated-private-authorization/public-prepare.cjs'
if($ReportPath){& node $Launcher $ReportPath}else{& node $Launcher}
if($LASTEXITCODE -ne 0){throw 'Actual high public prepare console failed'}
