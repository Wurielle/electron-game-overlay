[CmdletBinding()]
param([ValidateSet('x64','x86')][string]$Architecture='x64',[switch]$RequireElevated)
$ErrorActionPreference='Stop'
$Repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Source=Join-Path $Repository 'build/candidate-gen24-cache/native/_deps/reshade-src/tools/injector.cpp'
$Text=[IO.File]::ReadAllText((Join-Path $Repository 'libs/electron-game-overlay-runtime/CMakeLists.txt'))
$Pin=[regex]::Match($Text,'set\(RESHAPE_ELEVATED_PRIVATE_INJECTOR_CONTENT_SHA256\s+"([0-9A-F]+)"').Groups[1].Value.ToLowerInvariant()
$Build=Join-Path $Repository "build/elevated-private-authorization/compile-$Architecture"
$Platform=if($Architecture -eq 'x86'){'Win32'}else{'x64'}
& cmake -S (Join-Path $Repository 'libs/electron-game-overlay-runtime/tests/elevated-private-authorization') -B $Build -G 'Visual Studio 17 2022' -A $Platform "-DINJECTOR_SOURCE=$($Source.Replace('\','/'))" "-DEXPECTED_SOURCE_SHA=$Pin"
if($LASTEXITCODE -ne 0){throw 'Authorization fixture configure failed'}
& cmake --build $Build --config Release
if($LASTEXITCODE -ne 0){throw 'Authorization fixture build failed'}
$Launcher=Join-Path $Repository 'libs/electron-game-overlay-runtime/tests/elevated-private-authorization/run.cjs'
& node $Launcher $Architecture ([int]$RequireElevated.IsPresent)
if($LASTEXITCODE -ne 0){throw 'Owned authorization console failed'}
