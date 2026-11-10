[CmdletBinding()]
param([ValidateSet('x64','x86')][string]$Architecture = 'x64')
$ErrorActionPreference = 'Stop'
$Repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Root = Join-Path $Repository 'build\unopened-target-selection-console'
$Build = Join-Path $Root "compile-$Architecture"
$Injector = Join-Path $Repository 'build\candidate-gen24-cache\native\_deps\reshade-src\tools\injector.cpp'
$Text = [IO.File]::ReadAllText((Join-Path $Repository 'libs\electron-game-overlay-runtime\CMakeLists.txt'))
$Pin = [regex]::Match($Text, 'set\(RESHAPE_STARTUP_READINESS_INJECTOR_CONTENT_SHA256\s+"([0-9A-F]+)"').Groups[1].Value.ToLowerInvariant()
$Platform = if ($Architecture -eq 'x86') {'Win32'} else {'x64'}
& cmake -S (Join-Path $Repository 'libs\electron-game-overlay-runtime\tests\unopened-target-selection') -B $Build -G 'Visual Studio 17 2022' -A $Platform "-DINJECTOR_SOURCE=$($Injector.Replace('\','/'))" "-DEXPECTED_INJECTOR_SHA256=$Pin"
if ($LASTEXITCODE -ne 0) {throw 'Owned open-refusal fixture configure failed'}
& cmake --build $Build --config Release
if ($LASTEXITCODE -ne 0) {throw 'Owned open-refusal fixture build failed'}
$Output = Join-Path $Root "$Architecture.stdout.log"
& (Join-Path $Build 'Release\unopened_target_selection.exe') | Tee-Object -FilePath $Output
if ($LASTEXITCODE -ne 0) {throw 'Owned open-refusal fixture failed'}
$Lines = Get-Content -LiteralPath $Output
$Cases = @($Lines | Where-Object {$_.StartsWith('EGO_OPEN_REFUSAL_CASE ')} | ForEach-Object {$_.Substring('EGO_OPEN_REFUSAL_CASE '.Length) | ConvertFrom-Json})
if ($Cases.Count -ne 2 -or @($Lines | Where-Object {$_ -match '^EGO_TARGET_SELECTED\t'}).Count -ne 0) {throw 'Expected two refused selections and no legacy/full-handle selection'}
$All = $Lines -join "`n"
foreach ($Case in $Cases) {
    $Identity = "EGO_TARGET_SELECTED_V2`t$($Case.pid)`t$($Case.creationTime100ns)`t"
    if ($All.IndexOf($Identity) -lt 0 -or $Case.fullOpenAttempts -ne 1 -or -not $Case.authoritativeExit -or $Case.injection) {throw 'Exact refused-instance proof failed'}
    $After = $All.Substring($All.IndexOf($Identity))
    if ($After.IndexOf('Failed to open target application process!') -lt 0) {throw 'V2 must precede the full-open refusal'}
}
Write-Output "Passed ${Architecture}: live denied and owned fast-exit selections publish exact V2 before full-open refusal; no injection or graphics."
