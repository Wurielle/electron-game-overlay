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
$InjectorProcessObserverPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-persistent-path-observer.patch"
$InjectorProcessObserverPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorProcessObserverPatch).Hash
$InjectorResilientProcessObserverPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-resilient-path-observer.patch"
$InjectorResilientProcessObserverPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorResilientProcessObserverPatch).Hash
$InjectorConflictPreflightPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-conflict-preflight.patch"
$InjectorConflictPreflightPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorConflictPreflightPatch).Hash
$InjectorPerPidClaimPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-per-pid-claim.patch"
$InjectorPerPidClaimPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorPerPidClaimPatch).Hash
$SharedRuntimeHostPatch =
    Join-Path $RuntimeRoot "patches\reshade-shared-runtime-host.patch"
$SharedRuntimeHostPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $SharedRuntimeHostPatch).Hash
$InjectorExportReadBoundsPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-export-read-bounds.patch"
$InjectorExportReadBoundsPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorExportReadBoundsPatch).Hash
$InjectorExistingInstallationPreflightPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-existing-installation-preflight.patch"
$InjectorExistingInstallationPreflightPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorExistingInstallationPreflightPatch).Hash
$InjectorOfficialAddonHostPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-official-addon-host.patch"
$InjectorOfficialAddonHostPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorOfficialAddonHostPatch).Hash
$InjectorGlobalLayerPreflightPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-global-layer-preflight.patch"
$InjectorGlobalLayerPreflightPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorGlobalLayerPreflightPatch).Hash
$SharedRuntimeHardeningPatch =
    Join-Path $RuntimeRoot "patches\reshade-shared-runtime-hardening.patch"
$SharedRuntimeHardeningPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $SharedRuntimeHardeningPatch).Hash
$SuppressSplashPatch = Join-Path $RuntimeRoot "patches\reshade-suppress-splash.patch"
$SuppressSplashPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $SuppressSplashPatch).Hash
$ExpectedPatchedFiles = @(
    "include/reshade.hpp"
    "include/reshade_api.hpp"
    "include/reshade_events.hpp"
    "source/addon_manager.cpp"
    "source/addon_manager.hpp"
    "source/input.cpp"
    "source/input.hpp"
    "source/runtime_gui.cpp"
    "tools/injector.cpp"
)
$ExpectedPatchedContentSha256 = [ordered]@{
    "include/reshade.hpp" = "CC102FA21D311B85713ED167F0E182A4EECCD40CDF3FBE360AD9F83A0CF40767"
    "include/reshade_api.hpp" = "80E9F0CBC06BF96943DC79CA2D133DB5D8E69D3A4CD516B6D89D675B8B965218"
    "include/reshade_events.hpp" = "8090912CD69854818C294F7C0F848EBAB7C712AB6D601E6889E62514249EE6A7"
    "source/addon_manager.cpp" = "28A0E7C805FC8D006E0B21BB9D3B7712ADBCDA771999F48ECD2ACAE3AC6F6488"
    "source/addon_manager.hpp" = "C1D27EA4C9996F1EAD408FAD0D0DB3AEEAE16A4BEFEB4A0F71EC6C616116989B"
    "source/input.cpp" = "4C53B31266E281479348913E2911CB7182843CFCB6D4063B571BECECF3F5BB2F"
    "source/input.hpp" = "C772470BC1AA003E3D6BD0C6E29B01CCE3B0F6CCF4F42E60B73EA9FCA6D12B2C"
    "source/runtime_gui.cpp" = "84887E6387FE9B72DB04969C953C3245F69B9471D76DCD14A05DEF18CCA80F40"
    "tools/injector.cpp" = "E2427FDE2BE57F198C83B06363D35BB4A9DD587418249E5D26E9885F52E2912D"
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

function Test-GitPatchApplied([string]$Patch) {
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        # A failed reverse check is expected on a clean or superseded cache.
        # Windows PowerShell otherwise promotes git's redirected stderr to a
        # terminating NativeCommandError while the script is in Stop mode.
        $ErrorActionPreference = "Continue"
        & git.exe -C $ReShadeSource apply --reverse --check $Patch 2>$null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
}

function Test-ReShadePatchedSourceState {
    if (-not (Test-Path -LiteralPath $ReShadeSource -PathType Container)) {
        return $false
    }

    # The global-layer preflight is terminal over the injector stack, so lower
    # injector patches cannot all be reverse-checked independently in the final
    # tree. This terminal patch plus exact content hashes below proves that
    # complete ordered stack instead.
    foreach ($Patch in @(
        $PointerInputPatch,
        $InjectorGlobalLayerPreflightPatch,
        $SuppressSplashPatch
    )) {
        if (-not (Test-GitPatchApplied $Patch)) {
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
        return $Stamp.schemaVersion -eq 20 -and
            $Stamp.commit -eq $ExpectedReShadeCommit -and
            $Stamp.observerPatchSha256 -eq $ObserverPatchHash -and
            $Stamp.injectorBasePathPatchSha256 -eq $InjectorBasePathPatchHash -and
            $Stamp.pointerInputPatchSha256 -eq $PointerInputPatchHash -and
            $Stamp.injectorExactPidPatchSha256 -eq $InjectorExactPidPatchHash -and
            $Stamp.injectorPathWatcherPatchSha256 -eq $InjectorPathWatcherPatchHash -and
            $Stamp.injectorPathWatcherIdentityPatchSha256 -eq $InjectorPathWatcherIdentityPatchHash -and
            $Stamp.injectorProcessObserverPatchSha256 -eq $InjectorProcessObserverPatchHash -and
            $Stamp.injectorResilientProcessObserverPatchSha256 -eq $InjectorResilientProcessObserverPatchHash -and
            $Stamp.injectorConflictPreflightPatchSha256 -eq $InjectorConflictPreflightPatchHash -and
            $Stamp.injectorPerPidClaimPatchSha256 -eq $InjectorPerPidClaimPatchHash -and
            $Stamp.sharedRuntimeHostPatchSha256 -eq $SharedRuntimeHostPatchHash -and
            $Stamp.injectorExportReadBoundsPatchSha256 -eq $InjectorExportReadBoundsPatchHash -and
            $Stamp.injectorExistingInstallationPreflightPatchSha256 -eq $InjectorExistingInstallationPreflightPatchHash -and
            $Stamp.injectorOfficialAddonHostPatchSha256 -eq $InjectorOfficialAddonHostPatchHash -and
            $Stamp.injectorGlobalLayerPreflightPatchSha256 -eq $InjectorGlobalLayerPreflightPatchHash -and
            $Stamp.sharedRuntimeHardeningPatchSha256 -eq $SharedRuntimeHardeningPatchHash -and
            $Stamp.suppressSplashPatchSha256 -eq $SuppressSplashPatchHash -and
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
    schemaVersion = 20
    commit = $ActualReShadeCommit
    observerPatchSha256 = $ObserverPatchHash
    injectorBasePathPatchSha256 = $InjectorBasePathPatchHash
    pointerInputPatchSha256 = $PointerInputPatchHash
    injectorExactPidPatchSha256 = $InjectorExactPidPatchHash
    injectorPathWatcherPatchSha256 = $InjectorPathWatcherPatchHash
    injectorPathWatcherIdentityPatchSha256 = $InjectorPathWatcherIdentityPatchHash
    injectorProcessObserverPatchSha256 = $InjectorProcessObserverPatchHash
    injectorResilientProcessObserverPatchSha256 = $InjectorResilientProcessObserverPatchHash
    injectorConflictPreflightPatchSha256 = $InjectorConflictPreflightPatchHash
    injectorPerPidClaimPatchSha256 = $InjectorPerPidClaimPatchHash
    sharedRuntimeHostPatchSha256 = $SharedRuntimeHostPatchHash
    injectorExportReadBoundsPatchSha256 = $InjectorExportReadBoundsPatchHash
    injectorExistingInstallationPreflightPatchSha256 = $InjectorExistingInstallationPreflightPatchHash
    injectorOfficialAddonHostPatchSha256 = $InjectorOfficialAddonHostPatchHash
    injectorGlobalLayerPreflightPatchSha256 = $InjectorGlobalLayerPreflightPatchHash
    sharedRuntimeHardeningPatchSha256 = $SharedRuntimeHardeningPatchHash
    suppressSplashPatchSha256 = $SuppressSplashPatchHash
    configuration = "Release"
    platform = "64-bit"
    addonLevel = 2
    runtimeSha256 = $RuntimeHash
    injectorSha256 = $InjectorHash
} | ConvertTo-Json | Set-Content -LiteralPath $BuildStamp -Encoding UTF8

Write-Host "RESHade full-add-on runtime built: $Runtime"
Write-Host "ReShade x64 injector built: $Injector"
