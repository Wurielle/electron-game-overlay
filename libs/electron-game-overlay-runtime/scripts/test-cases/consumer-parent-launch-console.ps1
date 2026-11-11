[CmdletBinding()]
param([ValidateSet('x64','x86')][string]$Architecture='x64',[string]$Report)
$ErrorActionPreference='Stop'
$Repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Source=Join-Path $Repository 'libs/electron-game-overlay-runtime/src/electron_game_overlay_reshade_manager.cpp'
$Hasher=[Security.Cryptography.SHA256]::Create()
try{$Pin=[BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($Source).Replace("`r`n","`n")))).Replace('-','').ToLowerInvariant()}finally{$Hasher.Dispose()}
$Build=Join-Path $Repository "build/consumer-parent-launch/compile-$Architecture"
$Platform=if($Architecture -eq 'x86'){'Win32'}else{'x64'}
& cmake -S (Join-Path $Repository 'libs/electron-game-overlay-runtime/tests/consumer-parent-launch') -B $Build -G 'Visual Studio 17 2022' -A $Platform "-DMANAGER_SOURCE=$($Source.Replace('\','/'))" "-DEXPECTED_SOURCE_SHA=$Pin"
if($LASTEXITCODE -ne 0){throw 'Consumer parent fixture configure failed'}
& cmake --build $Build --config Release
if($LASTEXITCODE -ne 0){throw 'Consumer parent fixture build failed'}
$Manager=Join-Path $Repository "build/candidate-gen24-cache/production-$Architecture/RelWithDebInfo/electron_game_overlay_reshade_manager.exe"
if(-not $Report){$Report=Join-Path $Repository "build/consumer-parent-$Architecture-$([Guid]::NewGuid().ToString('N')).json"}
& node (Join-Path $Repository 'libs/electron-game-overlay-runtime/tests/consumer-parent-launch/fixture.cjs') (Join-Path $Build 'Release/consumer_parent_launch.exe') $Manager ([IO.Path]::GetFullPath($Report))
if($LASTEXITCODE -ne 0){throw 'Owned medium desktop-parent fixture failed'}
