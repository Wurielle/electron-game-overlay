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
$ExpectedArtifactNames = @(
    "electron_game_overlay.addon64"
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
if ($BuildStamp.schemaVersion -ne 9 -or
    $BuildStamp.commit -ne $ExpectedReShadeCommit -or
    $BuildStamp.configuration -ne "Release" -or
    $BuildStamp.platform -ne "64-bit" -or
    $BuildStamp.addonLevel -ne 2) {
    throw "The native runtime build stamp has unexpected provenance: $BuildStampPath"
}
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.runtimeSha256) `
    -Actual $SourceHashes["ReShade64.dll"] `
    -Label "runtime distribution"
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.injectorSha256) `
    -Actual $SourceHashes["inject.exe"] `
    -Label "injector distribution"

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
