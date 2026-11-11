[CmdletBinding()]
param(
    [ValidateSet("x64", "x86")]
    [string]$Architecture = "x64"
)

$ErrorActionPreference = "Stop"

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
        throw "Refusing to stage the game overlay runtime through a reparse point: $Path"
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
    throw "The bundled game overlay runtime can only be staged on Windows."
}
if (-not [Environment]::Is64BitOperatingSystem -or
    -not [Environment]::Is64BitProcess) {
    throw "The bundled game overlay runtime requires a 64-bit Windows process."
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$ArchitectureConfig = if ($Architecture -eq "x86") {
    [pscustomobject]@{
        PackagePlatform = "win32-ia32"
        RuntimeName = "ReShade32.dll"
        BuildStampName = "ReShade32.build.json"
        AddonName = "electron_game_overlay.addon32"
        RuntimePlatform = "32-bit"
    }
}
else {
    [pscustomobject]@{
        PackagePlatform = "win32-x64"
        RuntimeName = "ReShade64.dll"
        BuildStampName = "ReShade64.build.json"
        AddonName = "electron_game_overlay.addon64"
        RuntimePlatform = "64-bit"
    }
}
$RuntimeDistribution = Join-Path `
    $RepoRoot `
    ("libs\electron-game-overlay-runtime\dist\" +
        $ArchitectureConfig.PackagePlatform)
$LibraryDistRoot = Join-Path $RepoRoot "libs\electron-game-overlay\dist"
$LibraryEntry = Join-Path $LibraryDistRoot "index.js"
$SdkRuntimeRoot = Join-Path $LibraryDistRoot "runtime"
$PlatformRuntimeDirectory = Join-Path `
    $SdkRuntimeRoot `
    "win32-x64"
$DestinationDirectory = Join-Path $PlatformRuntimeDirectory "reshade"
$ExpectedReShadeCommit = "4a50d1eddace85734871d91792ff214f13f66c01"
$ExpectedAddonBuildId = "CCE20935ADD44EF6A5A7973014B2E07F"
# Keep these exact mirrors of the runtime build manifest. Protocol-family v1
# must retain literal target transport v1 as its advertised minimum.
$ExpectedRuntimeGeneration = 37
$ExpectedTargetTransportMin = 1
$ExpectedTargetTransportMax = 1
$RuntimeSourceRoot = Join-Path $RepoRoot "libs\electron-game-overlay-runtime"
$ExpectedPatchProvenance = [ordered]@{
    presentDestinationsPatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-present-destinations.patch"
    ownedDeferredD3d11PatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-owned-deferred-d3d11.patch"
    ownedCompositionAuxiliaryLifetimePatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-owned-composition-auxiliary-lifetime.patch"
    ownedCompositionWindowEligibilityPatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-owned-composition-window-eligibility.patch"
    ownedCompositionBindingDiagnosticsPatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-owned-composition-binding-diagnostics.patch"
    ownedCompositionPolicyPatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-owned-composition-policy.patch"
    compatibilitySnapshotPatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-compatibility-snapshot.patch"
    steamLoadedModuleHookOrderPatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-steam-loaded-module-hook-order.patch"
    injectorPrivateStageDiagnosticsPatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-injector-private-stage-diagnostics.patch"
    d3d11SwapchainResourceIdentityPatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-d3d11-swapchain-resource-identity.patch"
    observerPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-input-observer.patch"
    injectorBasePathPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-base-path.patch"
    pointerInputPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-pointer-input-block.patch"
    rawInputNormalizationPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-raw-input-normalization.patch"
    rawInputRegistrationReconciliationPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-raw-input-registration-reconciliation.patch"
    rawInputFocusFollowingRootPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-raw-input-focus-following-root.patch"
    injectorExactPidPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-exact-pid.patch"
    injectorPathWatcherPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-path-watcher.patch"
    injectorPathWatcherIdentityPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-path-watcher-process-identity.patch"
    injectorProcessObserverPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-persistent-path-observer.patch"
    injectorResilientProcessObserverPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-resilient-path-observer.patch"
    injectorConflictPreflightPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-conflict-preflight.patch"
    injectorPerPidClaimPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-per-pid-claim.patch"
    sharedRuntimeHostPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-shared-runtime-host.patch"
    injectorExportReadBoundsPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-export-read-bounds.patch"
    injectorExistingInstallationPreflightPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-existing-installation-preflight.patch"
    injectorOfficialAddonHostPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-official-addon-host.patch"
    injectorGlobalLayerPreflightPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-global-layer-preflight.patch"
    sharedRuntimeHardeningPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-shared-runtime-hardening.patch"
    suppressSplashPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-suppress-splash.patch"
    x86RuntimePatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-x86-runtime.patch"
    x86TargetArchitectureDiagnosticPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-x86-target-architecture-diagnostic.patch"
    injectorExactTargetPathPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-exact-target-path.patch"
    injectorNameWatcherReadyPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-name-watcher-ready.patch"
    injectorProcessPolicyPatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-injector-process-policy.patch"
    injectorCooperativeMembersPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-cooperative-members.patch"
    ownedLateD3d11PatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-owned-late-d3d11.patch"
    injectorFirstHostResultPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-first-host-result.patch"
    injectorAddonPreloadPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-preloaded-addon.patch"
    injectorPreloadedFirstHostPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-preloaded-first-host.patch"
    injectorPreloadLongPathPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-preload-long-path.patch"
    ownedLateD3d11AdapterReadyLongPathPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-owned-late-d3d11-adapter-ready-long-path.patch"
    injectorInitialInspectionRecoveryPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-initial-inspection-recovery.patch"
    injectorSharedAddonDirectoryPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-shared-addon-directory.patch"
    injectorInspectionContextPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-inspection-context.patch"
    injectorSelectionBeforeOpenPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-selection-before-open.patch"
    injectorMemberDiagnosticsPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-member-diagnostics.patch"
    injectorStartupReadinessPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-startup-readiness.patch"
    injectorElevatedPrivatePatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-elevated-private-authorization.patch"
    ownedLateD3d11ForeignAddonIsolationPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-owned-late-d3d11-addon-failure-isolation.patch"
    injectorFutureTargetsPatchSha256 = Join-Path $RuntimeSourceRoot "patches\reshade-injector-future-targets.patch"
    injectorProcessInstanceBindingPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-process-instance-binding.patch"
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
$ExpectedArtifactNames = @(
    $ArchitectureConfig.AddonName
    "electron_game_overlay_reshade_manager.exe"
    "electron_game_overlay_runtime.build.json"
    "inject.exe"
    "ReShade.ini"
    $ArchitectureConfig.BuildStampName
    $ArchitectureConfig.RuntimeName
) | Sort-Object
$DestinationArtifactNames = @{}
foreach ($ArtifactName in $ExpectedArtifactNames) {
    $DestinationArtifactNames[$ArtifactName] = $ArtifactName
}
if ($Architecture -eq "x86") {
    $DestinationArtifactNames["inject.exe"] = "inject32.exe"
    $DestinationArtifactNames["electron_game_overlay_reshade_manager.exe"] =
        "electron_game_overlay_reshade_manager32.exe"
    $DestinationArtifactNames["electron_game_overlay_runtime.build.json"] =
        "electron_game_overlay_runtime32.build.json"
    $DestinationArtifactNames["ReShade.ini"] = $null
}
$ExpectedX64DestinationNames = @(
    "electron_game_overlay.addon64"
    "electron_game_overlay_reshade_manager.exe"
    "electron_game_overlay_runtime.build.json"
    "inject.exe"
    "ReShade.ini"
    "ReShade64.build.json"
    "ReShade64.dll"
)
$ExpectedX86DestinationNames = @(
    "electron_game_overlay.addon32"
    "electron_game_overlay_reshade_manager32.exe"
    "electron_game_overlay_runtime32.build.json"
    "inject32.exe"
    "ReShade32.build.json"
    "ReShade32.dll"
)
$ExpectedDestinationNames = if ($Architecture -eq "x86") {
    @($ExpectedX64DestinationNames + $ExpectedX86DestinationNames | Sort-Object)
}
else {
    @($ExpectedX64DestinationNames | Sort-Object)
}

if (-not (Test-Path -LiteralPath $LibraryEntry -PathType Leaf)) {
    throw "Build the electron-game-overlay TypeScript library before staging its runtime: $LibraryEntry"
}
if (-not (Test-Path -LiteralPath $RuntimeDistribution -PathType Container)) {
    throw "Build the electron-game-overlay-runtime Nx project first: $RuntimeDistribution"
}

foreach ($PathToVerify in @(
        $RuntimeDistribution,
        $LibraryDistRoot,
        $SdkRuntimeRoot,
        $PlatformRuntimeDirectory,
        $DestinationDirectory)) {
    Assert-NotReparsePoint $PathToVerify
}

$ActualSourceNames = @(
    Get-ChildItem -LiteralPath $RuntimeDistribution -File |
        Select-Object -ExpandProperty Name |
        Sort-Object
)
if (@(Compare-Object $ExpectedArtifactNames $ActualSourceNames).Count -ne 0) {
    throw "The native runtime distribution does not contain exactly the expected artifacts: $($ActualSourceNames -join ', ')"
}

$SourceHashes = @{}
foreach ($ArtifactName in $ExpectedArtifactNames) {
    $Source = Join-Path $RuntimeDistribution $ArtifactName
    Assert-NotReparsePoint $Source
    $SourceHashes[$ArtifactName] = (
        Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Source
    ).Hash
}

$BuildStampPath = Join-Path `
    $RuntimeDistribution `
    $ArchitectureConfig.BuildStampName
try {
    $BuildStamp = Get-Content -Raw -LiteralPath $BuildStampPath | ConvertFrom-Json
}
catch {
    throw "The native runtime build stamp is invalid: $BuildStampPath"
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
    throw "The native runtime build stamp has unexpected provenance: $BuildStampPath"
}
foreach ($PatchEntry in $ExpectedPatchProvenance.GetEnumerator()) {
    Assert-Sha256Equal `
        -Expected (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $PatchEntry.Value).Hash `
        -Actual ([string]$BuildStamp.($PatchEntry.Key)) `
        -Label "native runtime $($PatchEntry.Key) provenance"
}
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.runtimeSha256) `
    -Actual $SourceHashes[$ArchitectureConfig.RuntimeName] `
    -Label "runtime distribution"
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.injectorSha256) `
    -Actual $SourceHashes["inject.exe"] `
    -Label "injector distribution"

$PackageBuildStampPath = Join-Path `
    $RuntimeDistribution `
    "electron_game_overlay_runtime.build.json"
try {
    $PackageBuildStamp =
        Get-Content -Raw -LiteralPath $PackageBuildStampPath |
            ConvertFrom-Json
}
catch {
    throw "The Electron Game Overlay runtime build stamp is invalid: $PackageBuildStampPath"
}
$ExpectedPackageBuildStampProperties = @(
    "addonBuildId"
    "addonPreloadProtocol"
    "privateElevatedAuthorization"
    "addonSha256"
    "configuration"
    "cooperativeAddonProtocol"
    "injectorSha256"
    "injectorProcessInstanceBinding"
    "injectorFutureTargets"
    "kind"
    "managerProtocolSchemaVersion"
    "managerSha256"
    "managerSourceSha256"
    "platform"
    "reshadeBuildStampSha256"
    "reshadeConfigSha256"
    "reshadeRuntimeSha256"
    "runtimeGeneration"
    "schemaVersion"
    "targetTransportMax"
    "targetTransportMin"
) | Sort-Object
$ActualPackageBuildStampProperties = @(
    $PackageBuildStamp.PSObject.Properties |
        Select-Object -ExpandProperty Name |
        Sort-Object
)
if (@(
        Compare-Object `
            $ExpectedPackageBuildStampProperties `
            $ActualPackageBuildStampProperties
    ).Count -ne 0 -or
    $PackageBuildStamp.schemaVersion -ne 4 -or
    $PackageBuildStamp.cooperativeAddonProtocol -ne 1 -or
    $PackageBuildStamp.injectorProcessInstanceBinding -ne 1 -or
    $PackageBuildStamp.injectorFutureTargets -ne 2 -or
    ($PackageBuildStamp.addonPreloadProtocol -isnot [int] -and $PackageBuildStamp.addonPreloadProtocol -isnot [long]) -or
    $PackageBuildStamp.addonPreloadProtocol -ne 1 -or
    $PackageBuildStamp.privateElevatedAuthorization -ne 2 -or
    ($PackageBuildStamp.privateElevatedAuthorization -isnot [int] -and $PackageBuildStamp.privateElevatedAuthorization -isnot [long]) -or
    $PackageBuildStamp.kind -ne "electron-game-overlay-runtime-build" -or
    $PackageBuildStamp.platform -ne $ArchitectureConfig.PackagePlatform -or
    $PackageBuildStamp.configuration -ne "RelWithDebInfo" -or
    $PackageBuildStamp.addonBuildId -cne $ExpectedAddonBuildId -or
    ([string]$PackageBuildStamp.addonBuildId) -cnotmatch
        '^[0-9A-F]{32}$' -or
    $PackageBuildStamp.managerProtocolSchemaVersion -ne 1 -or
    $PackageBuildStamp.runtimeGeneration -ne $ExpectedRuntimeGeneration -or
    $PackageBuildStamp.targetTransportMin -ne $ExpectedTargetTransportMin -or
    $PackageBuildStamp.targetTransportMax -ne $ExpectedTargetTransportMax) {
    throw "The Electron Game Overlay runtime build stamp has unexpected provenance: $PackageBuildStampPath"
}
$ManagerSourcePath = Join-Path `
    $RuntimeSourceRoot `
    "src\electron_game_overlay_reshade_manager.cpp"
if (-not (Test-Path -LiteralPath $ManagerSourcePath -PathType Leaf)) {
    throw "The ReShade add-on manager source is missing: $ManagerSourcePath"
}
Assert-NotReparsePoint $ManagerSourcePath
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.managerSourceSha256) `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $ManagerSourcePath).Hash `
    -Label "ReShade add-on manager source provenance"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.managerSha256) `
    -Actual $SourceHashes["electron_game_overlay_reshade_manager.exe"] `
    -Label "ReShade add-on manager distribution"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.addonSha256) `
    -Actual $SourceHashes[$ArchitectureConfig.AddonName] `
    -Label "Electron Game Overlay add-on distribution"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.injectorSha256) `
    -Actual $SourceHashes["inject.exe"] `
    -Label "runtime package injector"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.reshadeRuntimeSha256) `
    -Actual $SourceHashes[$ArchitectureConfig.RuntimeName] `
    -Label "runtime package ReShade DLL"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.reshadeConfigSha256) `
    -Actual $SourceHashes["ReShade.ini"] `
    -Label "runtime package ReShade configuration"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.reshadeBuildStampSha256) `
    -Actual $SourceHashes[$ArchitectureConfig.BuildStampName] `
    -Label "runtime package ReShade build stamp"

$ResolvedSdkRuntimeRoot = [IO.Path]::GetFullPath($SdkRuntimeRoot)
$ResolvedPlatformRuntimeDirectory = [IO.Path]::GetFullPath($PlatformRuntimeDirectory)
$ResolvedDestinationDirectory = [IO.Path]::GetFullPath($DestinationDirectory)
$ExpectedPlatformPrefix = $ResolvedSdkRuntimeRoot.TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
) + [IO.Path]::DirectorySeparatorChar
if (-not $ResolvedPlatformRuntimeDirectory.StartsWith(
        $ExpectedPlatformPrefix,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stage outside the SDK runtime root: $ResolvedPlatformRuntimeDirectory"
}
$ExpectedDestinationPrefix = $ResolvedPlatformRuntimeDirectory.TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
) + [IO.Path]::DirectorySeparatorChar
if (-not $ResolvedDestinationDirectory.StartsWith(
        $ExpectedDestinationPrefix,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stage outside the SDK platform runtime: $ResolvedDestinationDirectory"
}

if ($Architecture -eq "x64" -and
    (Test-Path -LiteralPath $ResolvedPlatformRuntimeDirectory)) {
    Remove-Item -LiteralPath $ResolvedPlatformRuntimeDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $ResolvedDestinationDirectory -Force | Out-Null
Assert-NotReparsePoint $ResolvedDestinationDirectory

if ($Architecture -eq "x86") {
    $CurrentDestinationNames = @(
        Get-ChildItem -LiteralPath $ResolvedDestinationDirectory -File |
            Select-Object -ExpandProperty Name |
            Sort-Object
    )
    if (@(
            Compare-Object `
                (@($ExpectedX64DestinationNames | Sort-Object)) `
                $CurrentDestinationNames
        ).Count -ne 0) {
        throw "Stage the x64 SDK runtime before composing the x86 payload."
    }
    $SharedConfigPath = Join-Path $ResolvedDestinationDirectory "ReShade.ini"
    Assert-Sha256Equal `
        -Expected ([string]$PackageBuildStamp.reshadeConfigSha256) `
    -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $SharedConfigPath).Hash `
        -Label "composed x86 runtime package ReShade configuration"
}

foreach ($ArtifactName in $ExpectedArtifactNames) {
    $DestinationName = $DestinationArtifactNames[$ArtifactName]
    if (-not $DestinationName) {
        continue
    }
    $Destination = Join-Path $ResolvedDestinationDirectory $DestinationName
    Copy-Item `
        -LiteralPath (Join-Path $RuntimeDistribution $ArtifactName) `
        -Destination $Destination `
        -Force
    Assert-NotReparsePoint $Destination
    Assert-Sha256Equal `
        -Expected $SourceHashes[$ArtifactName] `
        -Actual (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Destination).Hash `
        -Label $Destination
}

$ActualDestinationNames = @(
    Get-ChildItem -LiteralPath $ResolvedDestinationDirectory -File |
        Select-Object -ExpandProperty Name |
        Sort-Object
)
if (@(Compare-Object $ExpectedDestinationNames $ActualDestinationNames).Count -ne 0) {
    throw "The staged SDK runtime does not contain exactly the expected artifacts: $($ActualDestinationNames -join ', ')"
}

Write-Host "ELECTRON_GAME_OVERLAY_SDK_RUNTIME_STAGED directory=$ResolvedDestinationDirectory"
