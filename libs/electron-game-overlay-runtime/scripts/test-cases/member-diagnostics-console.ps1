[CmdletBinding()]
param([ValidateSet('x64','x86')][string]$Architecture='x64')
$ErrorActionPreference='Stop'
$Repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Root=Join-Path $Repository 'build/member-diagnostics-console'
$Build=Join-Path $Root "compile-$Architecture"
$Injector=Join-Path $Repository 'build/candidate-gen24-cache/native/_deps/reshade-src/tools/injector.cpp'
$Text=[IO.File]::ReadAllText((Join-Path $Repository 'libs/electron-game-overlay-runtime/CMakeLists.txt'))
$Pin=[regex]::Match($Text,'set\(RESHAPE_ELEVATED_PRIVATE_INJECTOR_CONTENT_SHA256\s+"([0-9A-F]+)"').Groups[1].Value.ToLowerInvariant()
$Platform=if($Architecture -eq 'x86'){'Win32'}else{'x64'}
& cmake -S (Join-Path $Repository 'libs/electron-game-overlay-runtime/tests/member-diagnostics') -B $Build -G 'Visual Studio 17 2022' -A $Platform "-DINJECTOR_SOURCE=$($Injector.Replace('\','/'))" "-DEXPECTED_SOURCE_SHA=$Pin"
if($LASTEXITCODE -ne 0){throw 'Member diagnostics configure failed'}
& cmake --build $Build --config Release
if($LASTEXITCODE -ne 0){throw 'Member diagnostics build failed'}
& (Join-Path $Build 'Release/member_diagnostics.exe') | Tee-Object -FilePath (Join-Path $Root "$Architecture.stdout.log")
if($LASTEXITCODE -ne 0){throw 'Member diagnostics console failed'}
