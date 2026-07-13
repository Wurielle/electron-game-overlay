[CmdletBinding()]
param(
    [switch]$ForceReShade
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
$ProductionBuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime-production"
$ReShadeOutputDirectory = Join-Path $NativeBuildRoot "_deps\reshade-src\bin\x64\Release"
$AddonOutputDirectory = Join-Path $ProductionBuildRoot "RelWithDebInfo"
$BuildReShadeScript = Join-Path $PSScriptRoot "build-reshade-runtime.ps1"
$DistributionDirectory = Join-Path $RuntimeRoot "dist\win32-x64"
$ExpectedReShadeCommit = "4a50d1eddace85734871d91792ff214f13f66c01"

$CMake = Resolve-Executable "cmake.exe"
if ($ForceReShade) {
    & $BuildReShadeScript -Force
}
else {
    & $BuildReShadeScript
}
if ($LASTEXITCODE -ne 0) {
    throw "Building the pinned ReShade runtime failed with exit code $LASTEXITCODE."
}

Push-Location $RuntimeRoot
try {
    & $CMake --preset vs2022-x64-production
    if ($LASTEXITCODE -ne 0) {
        throw "Configuring the production overlay runtime failed with exit code $LASTEXITCODE."
    }

    & $CMake `
        --build $ProductionBuildRoot `
        --config RelWithDebInfo `
        --target electron_game_overlay electron_overlay_transport_abi_smoke `
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
        Source = Join-Path $ReShadeOutputDirectory "ReShade64.dll"
        Name = "ReShade64.dll"
    },
    [pscustomobject]@{
        Source = Join-Path $ReShadeOutputDirectory "inject.exe"
        Name = "inject.exe"
    },
    [pscustomobject]@{
        Source = Join-Path $ReShadeOutputDirectory "ReShade64.build.json"
        Name = "ReShade64.build.json"
    },
    [pscustomobject]@{
        Source = Join-Path $AddonOutputDirectory "electron_game_overlay.addon64"
        Name = "electron_game_overlay.addon64"
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
        Get-FileHash -Algorithm SHA256 -LiteralPath $Artifact.Source
    ).Hash
}

$BuildStampPath = Join-Path $ReShadeOutputDirectory "ReShade64.build.json"
try {
    $BuildStamp = Get-Content -Raw -LiteralPath $BuildStampPath | ConvertFrom-Json
}
catch {
    throw "The pinned ReShade runtime build stamp is invalid: $BuildStampPath"
}
if ($BuildStamp.schemaVersion -ne 6 -or
    $BuildStamp.commit -ne $ExpectedReShadeCommit -or
    $BuildStamp.configuration -ne "Release" -or
    $BuildStamp.platform -ne "64-bit" -or
    $BuildStamp.addonLevel -ne 2) {
    throw "The pinned ReShade runtime build stamp has unexpected provenance: $BuildStampPath"
}
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.runtimeSha256) `
    -Actual $SourceHashes["ReShade64.dll"] `
    -Label "ReShade runtime provenance"
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.injectorSha256) `
    -Actual $SourceHashes["inject.exe"] `
    -Label "ReShade injector provenance"

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
        -Actual (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash `
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
