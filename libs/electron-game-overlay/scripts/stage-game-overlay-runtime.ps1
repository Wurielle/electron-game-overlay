[CmdletBinding()]
param()

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
$RuntimeDistribution = Join-Path $RepoRoot "libs\electron-game-overlay-runtime\dist\win32-x64"
$LibraryDistRoot = Join-Path $RepoRoot "libs\electron-game-overlay\dist"
$LibraryEntry = Join-Path $LibraryDistRoot "index.js"
$SdkRuntimeRoot = Join-Path $LibraryDistRoot "runtime"
$PlatformRuntimeDirectory = Join-Path $SdkRuntimeRoot "win32-x64"
$DestinationDirectory = Join-Path $PlatformRuntimeDirectory "reshade"
$ExpectedReShadeCommit = "4a50d1eddace85734871d91792ff214f13f66c01"
$ExpectedAddonBuildId = "202F40B8B4B04C519BF12F693BE2B94F"
$RuntimeSourceRoot = Join-Path $RepoRoot "libs\electron-game-overlay-runtime"
$ExpectedPatchProvenance = [ordered]@{
    observerPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-input-observer.patch"
    injectorBasePathPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-injector-base-path.patch"
    pointerInputPatchSha256 =
        Join-Path $RuntimeSourceRoot "patches\reshade-pointer-input-block.patch"
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
}
$ExpectedArtifactNames = @(
    "electron_game_overlay.addon64"
    "electron_game_overlay_reshade_manager.exe"
    "electron_game_overlay_runtime.build.json"
    "inject.exe"
    "ReShade.ini"
    "ReShade64.build.json"
    "ReShade64.dll"
) | Sort-Object

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
        Get-FileHash -Algorithm SHA256 -LiteralPath $Source
    ).Hash
}

$BuildStampPath = Join-Path $RuntimeDistribution "ReShade64.build.json"
try {
    $BuildStamp = Get-Content -Raw -LiteralPath $BuildStampPath | ConvertFrom-Json
}
catch {
    throw "The native runtime build stamp is invalid: $BuildStampPath"
}
if ($BuildStamp.schemaVersion -ne 20 -or
    $BuildStamp.commit -ne $ExpectedReShadeCommit -or
    $BuildStamp.configuration -ne "Release" -or
    $BuildStamp.platform -ne "64-bit" -or
    $BuildStamp.addonLevel -ne 2) {
    throw "The native runtime build stamp has unexpected provenance: $BuildStampPath"
}
foreach ($PatchEntry in $ExpectedPatchProvenance.GetEnumerator()) {
    Assert-Sha256Equal `
        -Expected (Get-FileHash -Algorithm SHA256 -LiteralPath $PatchEntry.Value).Hash `
        -Actual ([string]$BuildStamp.($PatchEntry.Key)) `
        -Label "native runtime $($PatchEntry.Key) provenance"
}
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.runtimeSha256) `
    -Actual $SourceHashes["ReShade64.dll"] `
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
    "addonSha256"
    "configuration"
    "injectorSha256"
    "kind"
    "managerProtocolSchemaVersion"
    "managerSha256"
    "managerSourceSha256"
    "platform"
    "reshadeBuildStampSha256"
    "reshadeConfigSha256"
    "reshadeRuntimeSha256"
    "schemaVersion"
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
    $PackageBuildStamp.schemaVersion -ne 2 -or
    $PackageBuildStamp.kind -ne "electron-game-overlay-runtime-build" -or
    $PackageBuildStamp.platform -ne "win32-x64" -or
    $PackageBuildStamp.configuration -ne "RelWithDebInfo" -or
    $PackageBuildStamp.addonBuildId -cne $ExpectedAddonBuildId -or
    ([string]$PackageBuildStamp.addonBuildId) -cnotmatch
        '^[0-9A-F]{32}$' -or
    $PackageBuildStamp.managerProtocolSchemaVersion -ne 1) {
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
    -Actual (Get-FileHash -Algorithm SHA256 -LiteralPath $ManagerSourcePath).Hash `
    -Label "ReShade add-on manager source provenance"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.managerSha256) `
    -Actual $SourceHashes["electron_game_overlay_reshade_manager.exe"] `
    -Label "ReShade add-on manager distribution"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.addonSha256) `
    -Actual $SourceHashes["electron_game_overlay.addon64"] `
    -Label "Electron Game Overlay add-on distribution"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.injectorSha256) `
    -Actual $SourceHashes["inject.exe"] `
    -Label "runtime package injector"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.reshadeRuntimeSha256) `
    -Actual $SourceHashes["ReShade64.dll"] `
    -Label "runtime package ReShade DLL"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.reshadeConfigSha256) `
    -Actual $SourceHashes["ReShade.ini"] `
    -Label "runtime package ReShade configuration"
Assert-Sha256Equal `
    -Expected ([string]$PackageBuildStamp.reshadeBuildStampSha256) `
    -Actual $SourceHashes["ReShade64.build.json"] `
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

if (Test-Path -LiteralPath $ResolvedPlatformRuntimeDirectory) {
    Remove-Item -LiteralPath $ResolvedPlatformRuntimeDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $ResolvedDestinationDirectory -Force | Out-Null
Assert-NotReparsePoint $ResolvedDestinationDirectory

foreach ($ArtifactName in $ExpectedArtifactNames) {
    $Destination = Join-Path $ResolvedDestinationDirectory $ArtifactName
    Copy-Item `
        -LiteralPath (Join-Path $RuntimeDistribution $ArtifactName) `
        -Destination $Destination `
        -Force
    Assert-NotReparsePoint $Destination
    Assert-Sha256Equal `
        -Expected $SourceHashes[$ArtifactName] `
        -Actual (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash `
        -Label $Destination
}

$ActualDestinationNames = @(
    Get-ChildItem -LiteralPath $ResolvedDestinationDirectory -File |
        Select-Object -ExpandProperty Name |
        Sort-Object
)
if (@(Compare-Object $ExpectedArtifactNames $ActualDestinationNames).Count -ne 0) {
    throw "The staged SDK runtime does not contain exactly the expected artifacts: $($ActualDestinationNames -join ', ')"
}

Write-Host "ELECTRON_GAME_OVERLAY_SDK_RUNTIME_STAGED directory=$ResolvedDestinationDirectory"
