[CmdletBinding()]
param([ValidateSet('x64','x86')][string]$Architecture='x64')
$ErrorActionPreference='Stop'
$Repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Source=Join-Path $Repository 'build/candidate-gen24-cache/native/_deps/reshade-src/tools/injector.cpp'
$Text=[IO.File]::ReadAllText((Join-Path $Repository 'libs/electron-game-overlay-runtime/CMakeLists.txt'))
$Pin=[regex]::Match($Text,'set\(RESHAPE_ELEVATED_PRIVATE_INJECTOR_CONTENT_SHA256\s+"([0-9A-F]+)"').Groups[1].Value
$Hasher=[Security.Cryptography.SHA256]::Create()
try{$Actual=[BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($Source).Replace("`r`n","`n")))).Replace('-','')}finally{$Hasher.Dispose()}
if($Actual -cne $Pin){throw 'Production source does not match the frozen startup-readiness pin'}
$Build=Join-Path $Repository "build/startup-readiness-console/compile-$Architecture"
$Platform=if($Architecture -eq 'x86'){'Win32'}else{'x64'}
& cmake -S (Join-Path $Repository 'libs/electron-game-overlay-runtime/tests/inspection-context-console') -B $Build -G 'Visual Studio 17 2022' -A $Platform "-DINJECTOR_SOURCE=$($Source.Replace('\','/'))"
if($LASTEXITCODE -ne 0){throw 'Startup fixture configure failed'}
& cmake --build $Build --config Release --target startup_readiness startup_readiness_seams
if($LASTEXITCODE -ne 0){throw 'Startup fixture build failed'}
& (Join-Path $Build 'Release/startup_readiness.exe') | Tee-Object -FilePath (Join-Path $Repository "build/startup-readiness-console/$Architecture.stdout.log")
if($LASTEXITCODE -ne 0){throw 'Owned startup-readiness fixture failed'}
& (Join-Path $Build 'Release/startup_readiness_seams.exe')
if($LASTEXITCODE -ne 0){throw 'Deterministic startup-readiness fixture failed'}
