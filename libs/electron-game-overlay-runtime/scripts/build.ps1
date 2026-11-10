[CmdletBinding()]
param(
    [switch]$ForceReShade,
    [ValidateSet("x64", "x86")]
    [string]$Architecture = "x64",
    # Optional isolated, reusable source/build cache. Leaves the default cache intact.
    [string]$BuildCacheRoot
)

$ErrorActionPreference = "Stop"
$env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL"

function Resolve-Executable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $Command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue
    if ($Command) {
        return $Command.Source
    }

    throw "Required build tool not found: $Name"
}

function Assert-NotReparsePoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $Item = Get-Item -LiteralPath $Path -Force
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to package the game overlay runtime through a reparse point: $Path"
    }
}

function Assert-Sha256Equal {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Expected,
        [Parameter(Mandatory = $true)]
        [string]$Actual,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if (-not $Expected.Equals($Actual, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label SHA-256 mismatch. Expected $Expected, received $Actual."
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "The Electron game overlay runtime can only be built on Windows."
}
if (-not [Environment]::Is64BitOperatingSystem -or
    -not [Environment]::Is64BitProcess) {
    throw "The Electron game overlay runtime requires a 64-bit Windows build process."
}

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $RuntimeRoot "..\..")).Path
$NativeBuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
$ArchitectureConfig = if ($Architecture -eq "x86") {
    [pscustomobject]@{
        ProductionBuildDirectory = "build\electron-game-overlay-runtime-production-x86"
        ReShadeOutputDirectory = "_deps\reshade-src\bin\Win32\Release"
        ReShadeRuntimeName = "ReShade32.dll"
        ReShadeBuildStampName = "ReShade32.build.json"
        AddonName = "electron_game_overlay.addon32"
        CMakePreset = "vs2022-x86-production"
        RuntimePlatform = "32-bit"
        PackagePlatform = "win32-ia32"
    }
}
else {
    [pscustomobject]@{
        ProductionBuildDirectory = "build\electron-game-overlay-runtime-production"
        ReShadeOutputDirectory = "_deps\reshade-src\bin\x64\Release"
        ReShadeRuntimeName = "ReShade64.dll"
        ReShadeBuildStampName = "ReShade64.build.json"
        AddonName = "electron_game_overlay.addon64"
        CMakePreset = "vs2022-x64-production"
        RuntimePlatform = "64-bit"
        PackagePlatform = "win32-x64"
    }
}
$ProductionBuildRoot = Join-Path $RepoRoot $ArchitectureConfig.ProductionBuildDirectory
if ($BuildCacheRoot) {
    if (-not [IO.Path]::IsPathRooted($BuildCacheRoot)) { $BuildCacheRoot = Join-Path $RepoRoot $BuildCacheRoot }
    $BuildCacheRoot = [IO.Path]::GetFullPath($BuildCacheRoot)
    $NativeBuildRoot = Join-Path $BuildCacheRoot "native"
    $ProductionBuildRoot = Join-Path $BuildCacheRoot "production-$Architecture"
}
$ReShadeOutputDirectory = Join-Path `
    $NativeBuildRoot `
    $ArchitectureConfig.ReShadeOutputDirectory
$AddonOutputDirectory = Join-Path $ProductionBuildRoot "RelWithDebInfo"
$ManagerSourcePath = Join-Path $RuntimeRoot "src\electron_game_overlay_reshade_manager.cpp"
$PackageBuildStampPath = Join-Path $ProductionBuildRoot "electron_game_overlay_runtime.build.json"
$BuildReShadeScript = Join-Path $PSScriptRoot "build-reshade-runtime.ps1"
$DistributionDirectory = Join-Path `
    $RuntimeRoot `
    ("dist\" + $ArchitectureConfig.PackagePlatform)
$ExpectedReShadeCommit = "4a50d1eddace85734871d91792ff214f13f66c01"
$ExpectedAddonBuildId = "CCE20935ADD44EF6A5A7973014B2E07F"
# Bump when the runtime provider or injector implementation changes, never for package semver.
$RuntimeGeneration = 30
# Protocol-family v1 providers must always retain literal transport v1 in their
# advertised range; backwards-compatible releases may raise only the maximum.
$TargetTransportMin = 1
$TargetTransportMax = 1
if ($ExpectedAddonBuildId -cnotmatch '^[0-9A-F]{32}$') {
    throw "The configured Electron Game Overlay add-on build ID is invalid."
}
$ExpectedPatchProvenance = [ordered]@{
    injectorPrivateStageDiagnosticsPatchSha256 = Join-Path $RuntimeRoot "patches\reshade-injector-private-stage-diagnostics.patch"
    d3d11SwapchainResourceIdentityPatchSha256 = Join-Path $RuntimeRoot "patches\reshade-d3d11-swapchain-resource-identity.patch"
    observerPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-input-observer.patch"
    injectorBasePathPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-base-path.patch"
    pointerInputPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-pointer-input-block.patch"
    rawInputNormalizationPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-raw-input-normalization.patch"
    rawInputRegistrationReconciliationPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-raw-input-registration-reconciliation.patch"
    rawInputFocusFollowingRootPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-raw-input-focus-following-root.patch"
    injectorExactPidPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-exact-pid.patch"
    injectorPathWatcherPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-path-watcher.patch"
    injectorPathWatcherIdentityPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-path-watcher-process-identity.patch"
    injectorProcessObserverPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-persistent-path-observer.patch"
    injectorResilientProcessObserverPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-resilient-path-observer.patch"
    injectorConflictPreflightPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-conflict-preflight.patch"
    injectorPerPidClaimPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-per-pid-claim.patch"
    sharedRuntimeHostPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-shared-runtime-host.patch"
    injectorExportReadBoundsPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-export-read-bounds.patch"
    injectorExistingInstallationPreflightPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-existing-installation-preflight.patch"
    injectorOfficialAddonHostPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-official-addon-host.patch"
    injectorGlobalLayerPreflightPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-global-layer-preflight.patch"
    sharedRuntimeHardeningPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-shared-runtime-hardening.patch"
    suppressSplashPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-suppress-splash.patch"
    x86RuntimePatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-x86-runtime.patch"
    x86TargetArchitectureDiagnosticPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-x86-target-architecture-diagnostic.patch"
    injectorExactTargetPathPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-exact-target-path.patch"
    injectorNameWatcherReadyPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-name-watcher-ready.patch"
    injectorProcessPolicyPatchSha256 = Join-Path $RuntimeRoot "patches\reshade-injector-process-policy.patch"
    injectorCooperativeMembersPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-cooperative-members.patch"
    ownedLateD3d11PatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-owned-late-d3d11.patch"
    injectorFirstHostResultPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-first-host-result.patch"
    injectorAddonPreloadPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-preloaded-addon.patch"
    injectorPreloadedFirstHostPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-preloaded-first-host.patch"
    injectorPreloadLongPathPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-preload-long-path.patch"
    ownedLateD3d11AdapterReadyLongPathPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-owned-late-d3d11-adapter-ready-long-path.patch"
    injectorInitialInspectionRecoveryPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-initial-inspection-recovery.patch"
    injectorSharedAddonDirectoryPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-shared-addon-directory.patch"
    injectorInspectionContextPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-inspection-context.patch"
    injectorSelectionBeforeOpenPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-selection-before-open.patch"
    injectorMemberDiagnosticsPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-member-diagnostics.patch"
    injectorStartupReadinessPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-startup-readiness.patch"
    injectorElevatedPrivatePatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-elevated-private-authorization.patch"
    ownedLateD3d11ForeignAddonIsolationPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-owned-late-d3d11-addon-failure-isolation.patch"
    injectorFutureTargetsPatchSha256 = Join-Path $RuntimeRoot "patches\reshade-injector-future-targets.patch"
    injectorProcessInstanceBindingPatchSha256 =
        Join-Path $RuntimeRoot "patches\reshade-injector-process-instance-binding.patch"
}
Assert-Sha256Equal `
    -Expected "51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE" `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ExpectedPatchProvenance.ownedLateD3d11PatchSha256).Hash `
    -Label "frozen owned late D3D11 production patch"
Assert-Sha256Equal `
    -Expected "B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554" `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ExpectedPatchProvenance.injectorFirstHostResultPatchSha256).Hash `
    -Label "frozen injector first-host result patch"
Assert-Sha256Equal `
    -Expected "E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D" `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ExpectedPatchProvenance.injectorAddonPreloadPatchSha256).Hash `
    -Label "frozen injector add-on preload patch"
Assert-Sha256Equal `
    -Expected "A8C494EF02E08E5084D7EDC27ABCB73639C18D23469F244F99F090A27DB46309" `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ExpectedPatchProvenance.injectorPreloadedFirstHostPatchSha256).Hash `
    -Label "frozen injector preloaded first-host patch"
Assert-Sha256Equal `
    -Expected "FFFF684D2E60D36F1CEC4D073B91A014B7F497A50C4F5B00F7B7F2A57714397B" `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ExpectedPatchProvenance.injectorPreloadLongPathPatchSha256).Hash `
    -Label "frozen injector preload long-path patch"
Assert-Sha256Equal `
    -Expected "BCC0F0CD455B80DB3ED6D850B63600116B1D9881F1C85602CF76CEF7B23C35A6" `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ExpectedPatchProvenance.ownedLateD3d11AdapterReadyLongPathPatchSha256).Hash `
    -Label "frozen owned late D3D11 adapter-ready long-path patch"
Assert-Sha256Equal `
    -Expected "5E9E7D2C8A2EE66F9A478CA193B5962C4F635943D040B121593AD70A3177D8A7" `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ExpectedPatchProvenance.injectorInitialInspectionRecoveryPatchSha256).Hash `
    -Label "frozen injector initial-inspection recovery patch"
Assert-Sha256Equal `
    -Expected "54AE1F9ABCE02CBB66481C7C2AB30E4D3E7925CD83F27F31D8551D76DEF85125" `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ExpectedPatchProvenance.injectorSharedAddonDirectoryPatchSha256).Hash `
    -Label "frozen injector shared add-on directory patch"
Assert-Sha256Equal `
    -Expected "2A1FF13D7F76258ECF9D5CFB565D68C2522BEE772053A5373A3645823D310F99" `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ExpectedPatchProvenance.ownedLateD3d11ForeignAddonIsolationPatchSha256).Hash `
    -Label "frozen owned late D3D11 foreign add-on isolation patch"

$CMake = Resolve-Executable "cmake.exe"
$ReShadeBuildOptions = @{ Architecture = $Architecture }
if ($BuildCacheRoot) { $ReShadeBuildOptions.BuildCacheRoot = $BuildCacheRoot }
if ($ForceReShade) {
    & $BuildReShadeScript -Force @ReShadeBuildOptions
}
else {
    & $BuildReShadeScript @ReShadeBuildOptions
}
if ($LASTEXITCODE -ne 0) {
    throw "Building the pinned ReShade runtime failed with exit code $LASTEXITCODE."
}

Push-Location $RuntimeRoot
try {
    $ConfigureOptions = @('--preset', $ArchitectureConfig.CMakePreset)
    if ($BuildCacheRoot) {
        # Share the one validated source checkout across both production builds.
        $ConfigureOptions += @('-B', $ProductionBuildRoot,
            "-DFETCHCONTENT_SOURCE_DIR_RESHADE=$NativeBuildRoot/_deps/reshade-src",
            "-DFETCHCONTENT_SOURCE_DIR_IMGUI=$NativeBuildRoot/_deps/imgui-src")
    }
    & $CMake @ConfigureOptions
    if ($LASTEXITCODE -ne 0) {
        throw "Configuring the production overlay runtime failed with exit code $LASTEXITCODE."
    }

    & $CMake `
        --build $ProductionBuildRoot `
        --config RelWithDebInfo `
        --target electron_game_overlay electron_game_overlay_reshade_manager `
            electron_overlay_transport_abi_smoke `
        --parallel
    if ($LASTEXITCODE -ne 0) {
        throw "Building the production overlay runtime failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$Artifacts = @(
    [pscustomobject]@{
        Source = Join-Path `
            $ReShadeOutputDirectory `
            $ArchitectureConfig.ReShadeRuntimeName
        Name = $ArchitectureConfig.ReShadeRuntimeName
    },
    [pscustomobject]@{
        Source = Join-Path $ReShadeOutputDirectory "inject.exe"
        Name = "inject.exe"
    },
    [pscustomobject]@{
        Source = Join-Path `
            $ReShadeOutputDirectory `
            $ArchitectureConfig.ReShadeBuildStampName
        Name = $ArchitectureConfig.ReShadeBuildStampName
    },
    [pscustomobject]@{
        Source = Join-Path $AddonOutputDirectory $ArchitectureConfig.AddonName
        Name = $ArchitectureConfig.AddonName
    },
    [pscustomobject]@{
        Source = Join-Path $AddonOutputDirectory "electron_game_overlay_reshade_manager.exe"
        Name = "electron_game_overlay_reshade_manager.exe"
    },
    [pscustomobject]@{
        Source = Join-Path $RuntimeRoot "config\ReShade.ini"
        Name = "ReShade.ini"
    }
)

$SourceHashes = @{}
foreach ($Artifact in $Artifacts) {
    if (-not (Test-Path -LiteralPath $Artifact.Source -PathType Leaf)) {
        throw "Expected production runtime artifact not found: $($Artifact.Source)"
    }
    Assert-NotReparsePoint $Artifact.Source
    $SourceHashes[$Artifact.Name] = (
        Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Artifact.Source
    ).Hash
}

$BuildStampPath = Join-Path `
    $ReShadeOutputDirectory `
    $ArchitectureConfig.ReShadeBuildStampName
try {
    $BuildStamp = Get-Content -Raw -LiteralPath $BuildStampPath | ConvertFrom-Json
}
catch {
    throw "The pinned ReShade runtime build stamp is invalid: $BuildStampPath"
}
if ($BuildStamp.schemaVersion -ne 30 -or
    $BuildStamp.cooperativeAddonProtocol -ne 1 -or
    $BuildStamp.injectorProcessInstanceBinding -ne 1 -or
    $BuildStamp.injectorFutureTargets -ne 2 -or
    ($BuildStamp.addonPreloadProtocol -isnot [int] -and $BuildStamp.addonPreloadProtocol -isnot [long]) -or
    $BuildStamp.addonPreloadProtocol -ne 1 -or
    $BuildStamp.commit -ne $ExpectedReShadeCommit -or
    $BuildStamp.configuration -ne "Release" -or
    $BuildStamp.platform -ne $ArchitectureConfig.RuntimePlatform -or
    $BuildStamp.addonLevel -ne 2) {
    throw "The pinned ReShade runtime build stamp has unexpected provenance: $BuildStampPath"
}
foreach ($PatchEntry in $ExpectedPatchProvenance.GetEnumerator()) {
    Assert-Sha256Equal `
        -Expected (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $PatchEntry.Value).Hash `
        -Actual ([string]$BuildStamp.($PatchEntry.Key)) `
        -Label "ReShade $($PatchEntry.Key) provenance"
}
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.runtimeSha256) `
    -Actual $SourceHashes[$ArchitectureConfig.ReShadeRuntimeName] `
    -Label "ReShade runtime provenance"
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.injectorSha256) `
    -Actual $SourceHashes["inject.exe"] `
    -Label "ReShade injector provenance"

if (-not (Test-Path -LiteralPath $ManagerSourcePath -PathType Leaf)) {
    throw "The ReShade add-on manager source is missing: $ManagerSourcePath"
}
Assert-NotReparsePoint $ManagerSourcePath
$PackageBuildStamp = [ordered]@{
    schemaVersion = 4
    kind = "electron-game-overlay-runtime-build"
    platform = $ArchitectureConfig.PackagePlatform
    configuration = "RelWithDebInfo"
    addonBuildId = $ExpectedAddonBuildId
    cooperativeAddonProtocol = 1
    injectorProcessInstanceBinding = 1
    injectorFutureTargets = 2
    addonPreloadProtocol = 1
    privateElevatedAuthorization = 2
    managerProtocolSchemaVersion = 1
    runtimeGeneration = $RuntimeGeneration
    targetTransportMin = $TargetTransportMin
    targetTransportMax = $TargetTransportMax
    managerSourceSha256 = (
        Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ManagerSourcePath
    ).Hash
    managerSha256 = $SourceHashes["electron_game_overlay_reshade_manager.exe"]
    addonSha256 = $SourceHashes[$ArchitectureConfig.AddonName]
    injectorSha256 = $SourceHashes["inject.exe"]
    reshadeRuntimeSha256 = $SourceHashes[$ArchitectureConfig.ReShadeRuntimeName]
    reshadeConfigSha256 = $SourceHashes["ReShade.ini"]
    reshadeBuildStampSha256 =
        $SourceHashes[$ArchitectureConfig.ReShadeBuildStampName]
}
$PackageBuildStamp |
    ConvertTo-Json |
    Set-Content -LiteralPath $PackageBuildStampPath -Encoding UTF8
Assert-NotReparsePoint $PackageBuildStampPath
$Artifacts += [pscustomobject]@{
    Source = $PackageBuildStampPath
    Name = "electron_game_overlay_runtime.build.json"
}
$SourceHashes["electron_game_overlay_runtime.build.json"] = (
    Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $PackageBuildStampPath
).Hash

$ResolvedRuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$ResolvedDistributionDirectory = [IO.Path]::GetFullPath($DistributionDirectory)
$ExpectedDistributionPrefix = $ResolvedRuntimeRoot.TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
) + [IO.Path]::DirectorySeparatorChar
if (-not $ResolvedDistributionDirectory.StartsWith(
        $ExpectedDistributionPrefix,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to package the runtime outside its project: $ResolvedDistributionDirectory"
}

foreach ($PathToVerify in @(
        (Join-Path $RuntimeRoot "dist"),
        $ResolvedDistributionDirectory)) {
    Assert-NotReparsePoint $PathToVerify
}
if (Test-Path -LiteralPath $ResolvedDistributionDirectory) {
    Remove-Item -LiteralPath $ResolvedDistributionDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $ResolvedDistributionDirectory -Force | Out-Null
Assert-NotReparsePoint $ResolvedDistributionDirectory

foreach ($Artifact in $Artifacts) {
    $Destination = Join-Path $ResolvedDistributionDirectory $Artifact.Name
    Copy-Item -LiteralPath $Artifact.Source -Destination $Destination -Force
    Assert-NotReparsePoint $Destination
    Assert-Sha256Equal `
        -Expected $SourceHashes[$Artifact.Name] `
        -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Destination).Hash `
        -Label $Destination
}

$ExpectedArtifactNames = @($Artifacts.Name | Sort-Object)
$ActualArtifactNames = @(
    Get-ChildItem -LiteralPath $ResolvedDistributionDirectory -File |
        Select-Object -ExpandProperty Name |
        Sort-Object
)
if (@(Compare-Object $ExpectedArtifactNames $ActualArtifactNames).Count -ne 0) {
    throw "The runtime distribution does not contain exactly the expected artifacts: $($ActualArtifactNames -join ', ')"
}

Write-Host "ELECTRON_GAME_OVERLAY_RUNTIME_BUILT directory=$ResolvedDistributionDirectory"
