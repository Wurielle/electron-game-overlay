[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $RuntimeRoot "..\..")).Path
$BuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
$ReShadeSource = Join-Path $BuildRoot "_deps\reshade-src"
$Runtime = Join-Path $ReShadeSource "bin\x64\Release\ReShade64.dll"
$Injector = Join-Path $ReShadeSource "bin\x64\Release\inject.exe"
$BuildStamp = Join-Path $ReShadeSource "bin\x64\Release\ReShade64.build.json"
$ExpectedReShadeCommit = "4a50d1eddace85734871d91792ff214f13f66c01"
$ObserverPatch = Join-Path $RuntimeRoot "patches\reshade-input-observer.patch"
$ObserverPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ObserverPatch).Hash
$InjectorBasePathPatch = Join-Path $RuntimeRoot "patches\reshade-injector-base-path.patch"
$InjectorBasePathPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorBasePathPatch).Hash
$PointerInputPatch = Join-Path $RuntimeRoot "patches\reshade-pointer-input-block.patch"
$PointerInputPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $PointerInputPatch).Hash
$InjectorExactPidPatch = Join-Path $RuntimeRoot "patches\reshade-injector-exact-pid.patch"
$InjectorExactPidPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorExactPidPatch).Hash
$InjectorPathWatcherPatch = Join-Path $RuntimeRoot "patches\reshade-injector-path-watcher.patch"
$InjectorPathWatcherPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorPathWatcherPatch).Hash
$InjectorPathWatcherIdentityPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-path-watcher-process-identity.patch"
$InjectorPathWatcherIdentityPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorPathWatcherIdentityPatch).Hash
$ExpectedPatchedFiles = @(
    "include/reshade.hpp"
    "include/reshade_api.hpp"
    "include/reshade_events.hpp"
    "source/addon_manager.cpp"
    "source/addon_manager.hpp"
    "source/input.cpp"
    "source/input.hpp"
    "tools/injector.cpp"
)
$ExpectedPatchedContentSha256 = [ordered]@{
    "include/reshade.hpp" = "CC102FA21D311B85713ED167F0E182A4EECCD40CDF3FBE360AD9F83A0CF40767"
    "include/reshade_api.hpp" = "80E9F0CBC06BF96943DC79CA2D133DB5D8E69D3A4CD516B6D89D675B8B965218"
    "include/reshade_events.hpp" = "8090912CD69854818C294F7C0F848EBAB7C712AB6D601E6889E62514249EE6A7"
    "source/addon_manager.cpp" = "1023CA3F0A271855CAF9B3D47B03D54443B60433B16EB0C2ED5023B26046046C"
    "source/addon_manager.hpp" = "C1D27EA4C9996F1EAD408FAD0D0DB3AEEAE16A4BEFEB4A0F71EC6C616116989B"
    "source/input.cpp" = "4C53B31266E281479348913E2911CB7182843CFCB6D4063B571BECECF3F5BB2F"
    "source/input.hpp" = "C772470BC1AA003E3D6BD0C6E29B01CCE3B0F6CCF4F42E60B73EA9FCA6D12B2C"
    "tools/injector.cpp" = "4EFC2A96B4D6CDF5BF5C7994A4C8151188C599C99CC755801EC47F568D3F04D6"
}

function Get-NormalizedTextSha256([string]$Path) {
    $Text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n").Replace("`r", "`n")
    $Sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $Bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return ($Sha256.ComputeHash($Bytes) |
            ForEach-Object { $_.ToString("X2") }) -join ""
    }
    finally {
        $Sha256.Dispose()
    }
}

function Test-ReShadePatchedSourceState {
    if (-not (Test-Path -LiteralPath $ReShadeSource -PathType Container)) {
        return $false
    }

    # The pointer patch layers over the observer, while the path-watcher patch
    # layers over the exact-PID and base-path patches. Those stacks cannot be
    # reverse-checked independently in the final tree. The terminal patches
    # plus exact content hashes below prove the complete ordered stack instead.
    foreach ($Patch in @(
        $PointerInputPatch,
        $InjectorPathWatcherIdentityPatch
    )) {
        & git.exe -C $ReShadeSource apply --reverse --check $Patch 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $false
        }
    }

    $SourceChanges = @(
        & git.exe -C $ReShadeSource status --porcelain --untracked-files=all --ignore-submodules=none 2>$null
    )
    if ($LASTEXITCODE -ne 0 -or $SourceChanges.Count -ne $ExpectedPatchedFiles.Count) {
        return $false
    }

    $ChangedFiles = @(
        $SourceChanges | ForEach-Object {
            if ($_.Length -lt 4) {
                return ""
            }
            $_.Substring(3).Replace("\", "/")
        }
    )
    if (@($ChangedFiles | Where-Object { $_ -notin $ExpectedPatchedFiles }).Count -ne 0) {
        return $false
    }

    foreach ($Entry in $ExpectedPatchedContentSha256.GetEnumerator()) {
        $PatchedFile = Join-Path $ReShadeSource $Entry.Key
        if (-not (Test-Path -LiteralPath $PatchedFile -PathType Leaf) -or
            (Get-NormalizedTextSha256 $PatchedFile) -ne $Entry.Value) {
            return $false
        }
    }
    return $true
}

function Test-RuntimeBuildCache {
    if (-not (Test-Path -LiteralPath $Runtime -PathType Leaf) -or
        -not (Test-Path -LiteralPath $Injector -PathType Leaf) -or
        -not (Test-Path -LiteralPath $BuildStamp -PathType Leaf)) {
        return $false
    }

    $CachedCommit = (& git.exe -C $ReShadeSource rev-parse HEAD 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or -not $CachedCommit -or
        $CachedCommit.Trim() -ne $ExpectedReShadeCommit) {
        return $false
    }

    if (-not (Test-ReShadePatchedSourceState)) {
        return $false
    }

    try {
        $Stamp = Get-Content -Raw -LiteralPath $BuildStamp | ConvertFrom-Json
        $RuntimeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Runtime).Hash
        $InjectorHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Injector).Hash
        return $Stamp.schemaVersion -eq 8 -and
            $Stamp.commit -eq $ExpectedReShadeCommit -and
            $Stamp.observerPatchSha256 -eq $ObserverPatchHash -and
            $Stamp.injectorBasePathPatchSha256 -eq $InjectorBasePathPatchHash -and
            $Stamp.pointerInputPatchSha256 -eq $PointerInputPatchHash -and
            $Stamp.injectorExactPidPatchSha256 -eq $InjectorExactPidPatchHash -and
            $Stamp.injectorPathWatcherPatchSha256 -eq $InjectorPathWatcherPatchHash -and
            $Stamp.injectorPathWatcherIdentityPatchSha256 -eq $InjectorPathWatcherIdentityPatchHash -and
            $Stamp.configuration -eq "Release" -and
            $Stamp.platform -eq "64-bit" -and
            $Stamp.addonLevel -eq 2 -and
            $Stamp.runtimeSha256 -eq $RuntimeHash -and
            $Stamp.injectorSha256 -eq $InjectorHash
    }
    catch {
        return $false
    }
}

if ((Test-RuntimeBuildCache) -and -not $Force) {
    Write-Host "RESHade full-add-on runtime already built: $Runtime"
    Write-Host "ReShade x64 injector already built: $Injector"
    return
}

Push-Location $RuntimeRoot
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

if (-not (Test-ReShadePatchedSourceState)) {
    throw "Pinned ReShade source does not contain exactly the expected source patches."
}

$ReShadeProject = Join-Path $ReShadeSource "ReShade.vcxproj"
$ProjectText = Get-Content -Raw -LiteralPath $ReShadeProject
if ($ProjectText -notmatch "RESHADE_ADDON=2") {
    throw "Pinned ReShade Release project no longer declares full add-on support."
}
$InjectorProject = Join-Path $ReShadeSource "ReShadeInject.vcxproj"
if (-not (Test-Path -LiteralPath $InjectorProject -PathType Leaf)) {
    throw "Pinned ReShade injector project was not found: $InjectorProject"
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
if (Test-Path -LiteralPath $Injector -PathType Leaf) {
    Remove-Item -LiteralPath $Injector -Force
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

& $MsBuild $InjectorProject `
    /m `
    /p:Configuration=Release `
    /p:Platform=x64 `
    /verbosity:minimal
if ($LASTEXITCODE -ne 0) {
    throw "ReShade injector build failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $Runtime -PathType Leaf)) {
    throw "ReShade build completed without producing $Runtime."
}
if (-not (Test-Path -LiteralPath $Injector -PathType Leaf)) {
    throw "ReShade injector build completed without producing $Injector."
}

$RuntimeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Runtime).Hash
$InjectorHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Injector).Hash
[ordered]@{
    schemaVersion = 8
    commit = $ActualReShadeCommit
    observerPatchSha256 = $ObserverPatchHash
    injectorBasePathPatchSha256 = $InjectorBasePathPatchHash
    pointerInputPatchSha256 = $PointerInputPatchHash
    injectorExactPidPatchSha256 = $InjectorExactPidPatchHash
    injectorPathWatcherPatchSha256 = $InjectorPathWatcherPatchHash
    injectorPathWatcherIdentityPatchSha256 = $InjectorPathWatcherIdentityPatchHash
    configuration = "Release"
    platform = "64-bit"
    addonLevel = 2
    runtimeSha256 = $RuntimeHash
    injectorSha256 = $InjectorHash
} | ConvertTo-Json | Set-Content -LiteralPath $BuildStamp -Encoding UTF8

Write-Host "RESHade full-add-on runtime built: $Runtime"
Write-Host "ReShade x64 injector built: $Injector"
