[CmdletBinding()]
param(
    [ValidateSet('x64','x86')][string]$Architecture='x64',
    [switch]$RequireElevated,
    [string]$ReShadeSourceDirectory,
    [string]$RuntimeDirectory,
    [string]$NodePath='node.exe'
)
$ErrorActionPreference='Stop'
$Repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Build=Join-Path $Repository "build/elevated-private-authorization/current-$Architecture"
if (-not $ReShadeSourceDirectory) {
    $ReShadeSourceDirectory=Join-Path $Repository 'build/electron-game-overlay-runtime-production/_deps/reshade-src'
}
$Stage=Join-Path $Build 'injector-source'
& (Join-Path $PSScriptRoot '..\stage-reshade-injector-source.ps1') -SourceDirectory $ReShadeSourceDirectory -OutputDirectory $Stage
$Source=Join-Path $Stage 'tools/injector.cpp'
$Pin=(Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant()
$Platform=if($Architecture -eq 'x86'){'Win32'}else{'x64'}
& cmake -S (Join-Path $Repository 'libs/electron-game-overlay-runtime/tests/elevated-private-authorization') -B $Build -G 'Visual Studio 17 2022' -A $Platform "-DINJECTOR_SOURCE=$($Source.Replace('\','/'))" "-DEXPECTED_SOURCE_SHA=$Pin"
if($LASTEXITCODE -ne 0){throw 'Authorization fixture configure failed'}
& cmake --build $Build --config Release
if($LASTEXITCODE -ne 0){throw 'Authorization fixture build failed'}
$Launcher=Join-Path $Repository 'libs/electron-game-overlay-runtime/tests/elevated-private-authorization/run.cjs'
if ($RuntimeDirectory) {
    $RuntimeDirectory=(Resolve-Path -LiteralPath $RuntimeDirectory).Path
} else {
    $NativePlatform=if($Architecture -eq 'x86'){'win32-ia32'}else{'win32-x64'}
    $RuntimeDirectory=Join-Path $Repository "libs/electron-game-overlay-runtime/dist/$NativePlatform"
}
& $NodePath $Launcher $Architecture ([int]$RequireElevated.IsPresent) $Build $RuntimeDirectory
if($LASTEXITCODE -ne 0){throw 'Owned authorization console failed'}
