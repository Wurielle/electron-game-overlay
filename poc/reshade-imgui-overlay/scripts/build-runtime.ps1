[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$PocRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $PocRoot "..\..")).Path
$BuildRoot = Join-Path $RepoRoot "build\reshade-imgui-overlay"
$ReShadeSource = Join-Path $BuildRoot "_deps\reshade-src"
$Runtime = Join-Path $ReShadeSource "bin\x64\Release\ReShade64.dll"
$BuildStamp = Join-Path $ReShadeSource "bin\x64\Release\ReShade64.build.json"
$ExpectedReShadeCommit = "4a50d1eddace85734871d91792ff214f13f66c01"

function Test-RuntimeBuildCache {
    if (-not (Test-Path -LiteralPath $Runtime -PathType Leaf) -or
        -not (Test-Path -LiteralPath $BuildStamp -PathType Leaf)) {
        return $false
    }

    $CachedCommit = (& git.exe -C $ReShadeSource rev-parse HEAD 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or -not $CachedCommit -or
        $CachedCommit.Trim() -ne $ExpectedReShadeCommit) {
        return $false
    }

    $CachedSourceChanges = @(
        & git.exe -C $ReShadeSource status --porcelain --untracked-files=all --ignore-submodules=none 2>$null
    )
    if ($LASTEXITCODE -ne 0 -or $CachedSourceChanges.Count -ne 0) {
        return $false
    }

    try {
        $Stamp = Get-Content -Raw -LiteralPath $BuildStamp | ConvertFrom-Json
        $RuntimeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Runtime).Hash
        return $Stamp.schemaVersion -eq 1 -and
            $Stamp.commit -eq $ExpectedReShadeCommit -and
            $Stamp.configuration -eq "Release" -and
            $Stamp.platform -eq "64-bit" -and
            $Stamp.addonLevel -eq 2 -and
            $Stamp.runtimeSha256 -eq $RuntimeHash
    }
    catch {
        return $false
    }
}

if ((Test-RuntimeBuildCache) -and -not $Force) {
    Write-Host "RESHade full-add-on runtime already built: $Runtime"
    return
}

Push-Location $PocRoot
try {
    & cmake.exe --preset vs2022-x64
    if ($LASTEXITCODE -ne 0) {
        throw "CMake configure failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath (Join-Path $ReShadeSource "ReShade.sln") -PathType Leaf)) {
    throw "Pinned ReShade source was not fetched into $ReShadeSource."
}

$ActualReShadeCommit = (& git.exe -C $ReShadeSource rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualReShadeCommit -ne $ExpectedReShadeCommit) {
    throw "Fetched ReShade source is $ActualReShadeCommit, expected pinned commit $ExpectedReShadeCommit."
}

& git.exe -C $ReShadeSource submodule update --init --recursive --depth 1
if ($LASTEXITCODE -ne 0) {
    throw "ReShade dependency checkout failed with exit code $LASTEXITCODE."
}

$SourceChanges = @(& git.exe -C $ReShadeSource status --porcelain --untracked-files=all --ignore-submodules=none)
if ($LASTEXITCODE -ne 0) {
    throw "Unable to verify the pinned ReShade source worktree."
}
if ($SourceChanges.Count -ne 0) {
    throw "Pinned ReShade source or submodules contain tracked changes; refusing to build an unverifiable runtime."
}

$ReShadeProject = Join-Path $ReShadeSource "ReShade.vcxproj"
$ProjectText = Get-Content -Raw -LiteralPath $ReShadeProject
if ($ProjectText -notmatch "RESHADE_ADDON=2") {
    throw "Pinned ReShade Release project no longer declares full add-on support."
}

$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) {
    throw "Visual Studio locator was not found: $VsWhere"
}

$VsInstall = (& $VsWhere `
    -latest `
    -products * `
    -requires Microsoft.Component.MSBuild `
    -property installationPath | Select-Object -First 1)
if (-not $VsInstall) {
    throw "Visual Studio 2022 C++ Build Tools were not found."
}

$MsBuild = Join-Path $VsInstall.Trim() "MSBuild\Current\Bin\MSBuild.exe"
if (Test-Path -LiteralPath $Runtime -PathType Leaf) {
    Remove-Item -LiteralPath $Runtime -Force
}
if (Test-Path -LiteralPath $BuildStamp -PathType Leaf) {
    Remove-Item -LiteralPath $BuildStamp -Force
}
& $MsBuild (Join-Path $ReShadeSource "ReShade.sln") `
    /t:ReShade `
    /m `
    /p:Configuration=Release `
    /p:Platform=64-bit `
    /verbosity:minimal
if ($LASTEXITCODE -ne 0) {
    throw "ReShade runtime build failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $Runtime -PathType Leaf)) {
    throw "ReShade build completed without producing $Runtime."
}

$RuntimeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Runtime).Hash
[ordered]@{
    schemaVersion = 1
    commit = $ActualReShadeCommit
    configuration = "Release"
    platform = "64-bit"
    addonLevel = 2
    runtimeSha256 = $RuntimeHash
} | ConvertTo-Json | Set-Content -LiteralPath $BuildStamp -Encoding UTF8

Write-Host "RESHade full-add-on runtime built: $Runtime"
