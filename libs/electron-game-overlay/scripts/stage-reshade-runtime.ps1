[CmdletBinding()]
param()

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
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to stage ReShade through a reparse point: $Path"
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

    if (-not $Expected.Equals($Actual, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label SHA-256 mismatch. Expected $Expected, received $Actual."
    }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "The bundled ReShade runtime can only be built on Windows."
}
if (-not [System.Environment]::Is64BitOperatingSystem -or
    -not [System.Environment]::Is64BitProcess) {
    throw "The bundled ReShade runtime requires a 64-bit Windows build process."
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$ReShadePocRoot = Join-Path $RepoRoot "poc\reshade-imgui-overlay"
$RuntimeBuildScript = Join-Path $ReShadePocRoot "scripts\build-runtime.ps1"
$RuntimeBuildRoot = Join-Path $RepoRoot "build\reshade-imgui-overlay"
$RuntimeOutputDirectory = Join-Path $RuntimeBuildRoot "_deps\reshade-src\bin\x64\Release"
$ElectronBuildRoot = Join-Path $RepoRoot "build\reshade-imgui-overlay-electron-core"
$AddonOutputDirectory = Join-Path $ElectronBuildRoot "RelWithDebInfo"
$LibraryDistRoot = Join-Path $RepoRoot "libs\electron-game-overlay\dist"
$LibraryEntry = Join-Path $LibraryDistRoot "index.js"
$RuntimeRoot = Join-Path $LibraryDistRoot "runtime"
$PlatformRuntimeDirectory = Join-Path $RuntimeRoot "win32-x64"
$ReShadeRuntimeDirectory = Join-Path $PlatformRuntimeDirectory "reshade"
$LegacyHudhookInjector = Join-Path $PlatformRuntimeDirectory "hudhook_overlay_injector.exe"
$ExpectedReShadeCommit = "4a50d1eddace85734871d91792ff214f13f66c01"

if (-not (Test-Path -LiteralPath $LibraryEntry -PathType Leaf)) {
    throw "Build the electron-game-overlay TypeScript library before staging ReShade: $LibraryEntry"
}
if (-not (Test-Path -LiteralPath $LegacyHudhookInjector -PathType Leaf)) {
    throw "Stage the legacy hudhook runtime before ReShade: $LegacyHudhookInjector"
}
if (-not (Test-Path -LiteralPath $RuntimeBuildScript -PathType Leaf)) {
    throw "The pinned ReShade runtime build script is missing: $RuntimeBuildScript"
}

foreach ($PathToVerify in @(
        $LibraryDistRoot,
        $RuntimeRoot,
        $PlatformRuntimeDirectory,
        $ReShadeRuntimeDirectory,
        $RuntimeBuildScript)) {
    Assert-NotReparsePoint $PathToVerify
}

$CMake = Resolve-Executable "cmake.exe"

& $RuntimeBuildScript
if ($LASTEXITCODE -ne 0) {
    throw "Building the pinned ReShade runtime failed with exit code $LASTEXITCODE."
}

Push-Location $ReShadePocRoot
try {
    & $CMake --preset vs2022-x64-electron-core
    if ($LASTEXITCODE -ne 0) {
        throw "Configuring the Electron ReShade add-on failed with exit code $LASTEXITCODE."
    }

    & $CMake `
        --build $ElectronBuildRoot `
        --config RelWithDebInfo `
        --target electron_reshade_overlay_poc `
        --parallel
    if ($LASTEXITCODE -ne 0) {
        throw "Building the Electron ReShade add-on failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$Artifacts = @(
    [pscustomobject]@{
        Source = Join-Path $RuntimeOutputDirectory "ReShade64.dll"
        Name = "ReShade64.dll"
    },
    [pscustomobject]@{
        Source = Join-Path $RuntimeOutputDirectory "inject.exe"
        Name = "inject.exe"
    },
    [pscustomobject]@{
        Source = Join-Path $RuntimeOutputDirectory "ReShade64.build.json"
        Name = "ReShade64.build.json"
    },
    [pscustomobject]@{
        Source = Join-Path $AddonOutputDirectory "electron_reshade_overlay_poc.addon64"
        Name = "electron_reshade_overlay_poc.addon64"
    },
    [pscustomobject]@{
        Source = Join-Path $ReShadePocRoot "config\ReShade.ini"
        Name = "ReShade.ini"
    }
)

$SourceHashes = @{}
foreach ($Artifact in $Artifacts) {
    if (-not (Test-Path -LiteralPath $Artifact.Source -PathType Leaf)) {
        throw "Expected ReShade runtime artifact not found: $($Artifact.Source)"
    }
    Assert-NotReparsePoint $Artifact.Source
    $SourceHashes[$Artifact.Name] = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $Artifact.Source
    ).Hash
}

$RuntimeSource = Join-Path $RuntimeOutputDirectory "ReShade64.dll"
$InjectorSource = Join-Path $RuntimeOutputDirectory "inject.exe"
$BuildStampSource = Join-Path $RuntimeOutputDirectory "ReShade64.build.json"
try {
    $BuildStamp = Get-Content -Raw -LiteralPath $BuildStampSource | ConvertFrom-Json
}
catch {
    throw "The pinned ReShade runtime build stamp is invalid: $BuildStampSource"
}
if ($BuildStamp.schemaVersion -ne 5 -or
    $BuildStamp.commit -ne $ExpectedReShadeCommit -or
    $BuildStamp.configuration -ne "Release" -or
    $BuildStamp.platform -ne "64-bit" -or
    $BuildStamp.addonLevel -ne 2) {
    throw "The pinned ReShade runtime build stamp has unexpected provenance: $BuildStampSource"
}
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.runtimeSha256) `
    -Actual $SourceHashes["ReShade64.dll"] `
    -Label $RuntimeSource
Assert-Sha256Equal `
    -Expected ([string]$BuildStamp.injectorSha256) `
    -Actual $SourceHashes["inject.exe"] `
    -Label $InjectorSource

$ResolvedPlatformRuntimeDirectory = [System.IO.Path]::GetFullPath(
    $PlatformRuntimeDirectory
)
$ResolvedReShadeRuntimeDirectory = [System.IO.Path]::GetFullPath(
    $ReShadeRuntimeDirectory
)
$ExpectedReShadePrefix = $ResolvedPlatformRuntimeDirectory.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
if (-not $ResolvedReShadeRuntimeDirectory.StartsWith(
        $ExpectedReShadePrefix,
        [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stage ReShade outside the SDK platform runtime: $ResolvedReShadeRuntimeDirectory"
}

foreach ($PathToVerify in @(
        $LibraryDistRoot,
        $RuntimeRoot,
        $PlatformRuntimeDirectory,
        $ReShadeRuntimeDirectory)) {
    Assert-NotReparsePoint $PathToVerify
}
if (Test-Path -LiteralPath $ResolvedReShadeRuntimeDirectory) {
    Remove-Item -LiteralPath $ResolvedReShadeRuntimeDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $ResolvedReShadeRuntimeDirectory | Out-Null
Assert-NotReparsePoint $ResolvedReShadeRuntimeDirectory

foreach ($Artifact in $Artifacts) {
    $Destination = Join-Path $ResolvedReShadeRuntimeDirectory $Artifact.Name
    Copy-Item -LiteralPath $Artifact.Source -Destination $Destination -Force
    Assert-NotReparsePoint $Destination
    $StagedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash
    Assert-Sha256Equal `
        -Expected $SourceHashes[$Artifact.Name] `
        -Actual $StagedHash `
        -Label $Destination
}

$ExpectedArtifactNames = @($Artifacts.Name | Sort-Object)
$ActualArtifactNames = @(
    Get-ChildItem -LiteralPath $ResolvedReShadeRuntimeDirectory -File |
        Select-Object -ExpandProperty Name |
        Sort-Object
)
$ArtifactDifference = @(
    Compare-Object $ExpectedArtifactNames $ActualArtifactNames
)
if ($ArtifactDifference.Count -ne 0) {
    throw "The staged ReShade runtime does not contain exactly the expected artifacts: $($ActualArtifactNames -join ', ')"
}

$StagedBuildStampPath = Join-Path $ResolvedReShadeRuntimeDirectory "ReShade64.build.json"
$StagedBuildStamp = Get-Content -Raw -LiteralPath $StagedBuildStampPath | ConvertFrom-Json
Assert-Sha256Equal `
    -Expected ([string]$StagedBuildStamp.runtimeSha256) `
    -Actual $SourceHashes["ReShade64.dll"] `
    -Label "staged ReShade runtime provenance"
Assert-Sha256Equal `
    -Expected ([string]$StagedBuildStamp.injectorSha256) `
    -Actual $SourceHashes["inject.exe"] `
    -Label "staged ReShade injector provenance"

Write-Host "RESHADE_SDK_RUNTIME_STAGED directory=$ResolvedReShadeRuntimeDirectory"
