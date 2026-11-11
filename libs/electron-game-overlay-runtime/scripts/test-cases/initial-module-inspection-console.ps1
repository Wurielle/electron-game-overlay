[CmdletBinding()]
param([ValidateSet('x64','x86')][string]$Architecture = 'x64')
$ErrorActionPreference = 'Stop'
$Repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Root = Join-Path $Repository 'build\initial-module-inspection-console'
$Source = Join-Path $Root 'source'
$Build = Join-Path $Root "compile-$Architecture"
New-Item -ItemType Directory -Force -Path $Root | Out-Null
if (-not (Test-Path -LiteralPath $Source)) {
    & node (Join-Path $Repository 'libs\electron-game-overlay\tests\helpers\reconstruct-inspection-injector.cjs') $Source
    if ($LASTEXITCODE -ne 0) { throw 'Production injector source reconstruction failed.' }
}
$Injector = Join-Path $Source 'tools\injector.cpp'
# Fail on stale or edited source; never rewrite an existing evidence directory.
$CMakeText = [IO.File]::ReadAllText((Join-Path $Repository 'libs\electron-game-overlay-runtime\CMakeLists.txt'))
$Expected = [regex]::Match($CMakeText, 'set\(RESHAPE_INSPECTION_CONTEXT_INJECTOR_CONTENT_SHA256\s+"([0-9A-F]+)"').Groups[1].Value
$Hasher = [Security.Cryptography.SHA256]::Create()
try { $Actual = [BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($Injector).Replace("`r`n", "`n")))).Replace('-', '') } finally { $Hasher.Dispose() }
if ($Actual -cne $Expected) { throw 'Retained injector source differs from the current production pin; preserve it and choose a fresh owned build directory.' }
$Platform = if ($Architecture -eq 'x86') { 'Win32' } else { 'x64' }
& cmake -S (Join-Path $Repository 'libs\electron-game-overlay-runtime\tests\inspection-context-console') -B $Build -G 'Visual Studio 17 2022' -A $Platform "-DINJECTOR_SOURCE=$($Injector.Replace('\','/'))"
if ($LASTEXITCODE -ne 0) { throw 'Console fixture configure failed.' }
& cmake --build $Build --config Release
if ($LASTEXITCODE -ne 0) { throw 'Console fixture build failed.' }
$Output = Join-Path $Root "$Architecture.stdout.log"
& (Join-Path $Build 'Release\initial_module_inspection.exe') | Tee-Object -FilePath $Output
if ($LASTEXITCODE -ne 0) { throw 'Read-only initial inspection console gate failed.' }
$Lines = Get-Content -LiteralPath $Output
$Prefix = 'EGO_TARGET_INSPECTION_CONTEXT_V1 '
$Contexts = @($Lines | Where-Object { $_.StartsWith($Prefix) } | ForEach-Object { $_.Substring($Prefix.Length) | ConvertFrom-Json })
if ($Contexts.Count -ne 6) { throw 'Expected three pairs of suspended/resumed context records.' }
for ($Index = 0; $Index -lt 6; $Index += 2) {
    $Before = $Contexts[$Index]; $After = $Contexts[$Index + 1]
    if ($Before.pid -ne $Before.handlePid -or $After.pid -ne $Before.pid -or
        $Before.creationTime100ns -cne $After.creationTime100ns -or
        $Before.loaderState -cnotin @('not-created','not-initialized') -or $After.loaderState -cne 'initialized' -or
        $Before.architectureWindowsError -ne 0 -or $After.loaderWindowsError -ne 0) { throw 'Same-handle loader transition evidence failed.' }
}
Write-Output "Passed ${Architecture}: three owned suspended/resumed/exited process lifecycles; no injection or graphics."
$IdentityOutput = Join-Path $Root "$Architecture.image-identity.log"
& (Join-Path $Build 'Release\private_image_identity.exe') (Join-Path $Build 'Release\private_image_marker.dll') (Join-Path $Root ('owned-image-probe-' + [Guid]::NewGuid().ToString('N'))) | Tee-Object -FilePath $IdentityOutput
if ($LASTEXITCODE -ne 0) { throw 'Private image identity gate failed.' }
