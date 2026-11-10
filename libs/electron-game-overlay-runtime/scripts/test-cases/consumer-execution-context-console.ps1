[CmdletBinding()]
param([ValidateSet('x64','x86')][string]$Architecture='x64',[string]$Report)
$ErrorActionPreference='Stop'
$Repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Manager=Join-Path $Repository "build/candidate-gen24-cache/production-$Architecture/RelWithDebInfo/electron_game_overlay_reshade_manager.exe"
if(-not $Report){$Report=Join-Path $Repository "build/consumer-context-$Architecture-$([Guid]::NewGuid().ToString('N')).json"}
& node (Join-Path $Repository 'libs/electron-game-overlay-runtime/tests/inspection-context-console/consumer-context.cjs') $Manager ([IO.Path]::GetFullPath($Report))
if($LASTEXITCODE -ne 0){throw 'Consumer execution context fixture failed'}
