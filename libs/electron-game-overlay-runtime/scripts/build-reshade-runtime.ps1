[CmdletBinding()]
param(
    [switch]$Force,
    [ValidateSet("x64", "x86")]
    [string]$Architecture = "x64"
)

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $RuntimeRoot "..\..")).Path
$BuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
$ReShadeSource = Join-Path $BuildRoot "_deps\reshade-src"
$ArchitectureConfig = if ($Architecture -eq "x86") {
    [pscustomobject]@{
        OutputDirectory = "bin\Win32\Release"
        RuntimeName = "ReShade32.dll"
        StampName = "ReShade32.build.json"
        RuntimePlatform = "32-bit"
        InjectorPlatform = "Win32"
    }
}
else {
    [pscustomobject]@{
        OutputDirectory = "bin\x64\Release"
        RuntimeName = "ReShade64.dll"
        StampName = "ReShade64.build.json"
        RuntimePlatform = "64-bit"
        InjectorPlatform = "x64"
    }
}
$Runtime = Join-Path $ReShadeSource (
    Join-Path $ArchitectureConfig.OutputDirectory $ArchitectureConfig.RuntimeName)
$Injector = Join-Path $ReShadeSource (
    Join-Path $ArchitectureConfig.OutputDirectory "inject.exe")
$BuildStamp = Join-Path $ReShadeSource (
    Join-Path $ArchitectureConfig.OutputDirectory $ArchitectureConfig.StampName)
$ExpectedReShadeCommit = "4a50d1eddace85734871d91792ff214f13f66c01"
$ObserverPatch = Join-Path $RuntimeRoot "patches\reshade-input-observer.patch"
$ObserverPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ObserverPatch).Hash
$InjectorBasePathPatch = Join-Path $RuntimeRoot "patches\reshade-injector-base-path.patch"
$InjectorBasePathPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorBasePathPatch).Hash
$PointerInputPatch = Join-Path $RuntimeRoot "patches\reshade-pointer-input-block.patch"
$PointerInputPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $PointerInputPatch).Hash
$RawInputNormalizationPatch =
    Join-Path $RuntimeRoot "patches\reshade-raw-input-normalization.patch"
$RawInputNormalizationPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $RawInputNormalizationPatch).Hash
$RawInputRegistrationReconciliationPatch =
    Join-Path $RuntimeRoot "patches\reshade-raw-input-registration-reconciliation.patch"
$RawInputRegistrationReconciliationPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $RawInputRegistrationReconciliationPatch).Hash
$RawInputFocusFollowingRootPatch =
    Join-Path $RuntimeRoot "patches\reshade-raw-input-focus-following-root.patch"
$RawInputFocusFollowingRootPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $RawInputFocusFollowingRootPatch).Hash
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
$X86RuntimePatch = Join-Path $RuntimeRoot "patches\reshade-x86-runtime.patch"
$X86RuntimePatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $X86RuntimePatch).Hash
$X86TargetArchitectureDiagnosticPatch =
    Join-Path $RuntimeRoot "patches\reshade-x86-target-architecture-diagnostic.patch"
$X86TargetArchitectureDiagnosticPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $X86TargetArchitectureDiagnosticPatch).Hash
$InjectorExactTargetPathPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-exact-target-path.patch"
$InjectorExactTargetPathPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorExactTargetPathPatch).Hash
$InjectorNameWatcherReadyPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-name-watcher-ready.patch"
$InjectorNameWatcherReadyPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorNameWatcherReadyPatch).Hash
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
    "source/input.cpp" = "3DCE0AB44CB798EAB7A1D61926A6FF1450015208E75A4FA1D57451AD18E7D7AF"
    "source/input.hpp" = "FCE52F33FE6B0865DAEBDE02037AE8A37B1BD16799CFC5E21E8C1602FA164352"
    "source/runtime_gui.cpp" = "84887E6387FE9B72DB04969C953C3245F69B9471D76DCD14A05DEF18CCA80F40"
    "tools/injector.cpp" = "B6F4CCF164AB75CBD9D55AEF3EC4191E89A533F703B20D7A04BCD2EF534E2FCD"
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

function Test-GitPatchApplied([string]$Patch, [int]$Strip = 1) {
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        # A failed reverse check is expected on a clean or superseded cache.
        # Windows PowerShell otherwise promotes git's redirected stderr to a
        # terminating NativeCommandError while the script is in Stop mode.
        $ErrorActionPreference = "Continue"
        & git.exe -C $ReShadeSource apply "-p$Strip" --reverse --check $Patch 2>$null
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

    # Terminal injector patches overlap the historical stack, so lower patches
    # cannot all be reverse-checked independently in the final tree. The
    # independently reversible terminal seams below plus exact content hashes
    # prove the complete ordered stack instead.
    foreach ($Patch in @(
        $RawInputFocusFollowingRootPatch,
        $SuppressSplashPatch,
        $X86RuntimePatch,
        $X86TargetArchitectureDiagnosticPatch,
        $InjectorExactTargetPathPatch,
        $InjectorNameWatcherReadyPatch
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
        $RuntimeHash = (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Runtime).Hash
        $InjectorHash = (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Injector).Hash
        return $Stamp.schemaVersion -eq 27 -and
            $Stamp.commit -eq $ExpectedReShadeCommit -and
            $Stamp.observerPatchSha256 -eq $ObserverPatchHash -and
            $Stamp.injectorBasePathPatchSha256 -eq $InjectorBasePathPatchHash -and
            $Stamp.pointerInputPatchSha256 -eq $PointerInputPatchHash -and
            $Stamp.rawInputNormalizationPatchSha256 -eq $RawInputNormalizationPatchHash -and
            $Stamp.rawInputRegistrationReconciliationPatchSha256 -eq $RawInputRegistrationReconciliationPatchHash -and
            $Stamp.rawInputFocusFollowingRootPatchSha256 -eq $RawInputFocusFollowingRootPatchHash -and
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
            $Stamp.x86RuntimePatchSha256 -eq $X86RuntimePatchHash -and
            $Stamp.x86TargetArchitectureDiagnosticPatchSha256 -eq $X86TargetArchitectureDiagnosticPatchHash -and
            $Stamp.injectorExactTargetPathPatchSha256 -eq $InjectorExactTargetPathPatchHash -and
            $Stamp.injectorNameWatcherReadyPatchSha256 -eq $InjectorNameWatcherReadyPatchHash -and
            $Stamp.configuration -eq "Release" -and
            $Stamp.platform -eq $ArchitectureConfig.RuntimePlatform -and
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
    Write-Host "ReShade $Architecture injector already built: $Injector"
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
    /p:Platform=$($ArchitectureConfig.RuntimePlatform) `
    /verbosity:minimal
if ($LASTEXITCODE -ne 0) {
    throw "ReShade runtime build failed with exit code $LASTEXITCODE."
}

& $MsBuild $InjectorProject `
    /m `
    /p:Configuration=Release `
    /p:Platform=$($ArchitectureConfig.InjectorPlatform) `
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

$RuntimeHash = (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Runtime).Hash
$InjectorHash = (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Injector).Hash
[ordered]@{
    schemaVersion = 27
    commit = $ActualReShadeCommit
    observerPatchSha256 = $ObserverPatchHash
    injectorBasePathPatchSha256 = $InjectorBasePathPatchHash
    pointerInputPatchSha256 = $PointerInputPatchHash
    rawInputNormalizationPatchSha256 = $RawInputNormalizationPatchHash
    rawInputRegistrationReconciliationPatchSha256 = $RawInputRegistrationReconciliationPatchHash
    rawInputFocusFollowingRootPatchSha256 = $RawInputFocusFollowingRootPatchHash
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
    x86RuntimePatchSha256 = $X86RuntimePatchHash
    x86TargetArchitectureDiagnosticPatchSha256 = $X86TargetArchitectureDiagnosticPatchHash
    injectorExactTargetPathPatchSha256 = $InjectorExactTargetPathPatchHash
    injectorNameWatcherReadyPatchSha256 = $InjectorNameWatcherReadyPatchHash
    configuration = "Release"
    platform = $ArchitectureConfig.RuntimePlatform
    addonLevel = 2
    runtimeSha256 = $RuntimeHash
    injectorSha256 = $InjectorHash
} | ConvertTo-Json | Set-Content -LiteralPath $BuildStamp -Encoding UTF8

Write-Host "RESHade full-add-on runtime built: $Runtime"
Write-Host "ReShade $Architecture injector built: $Injector"
