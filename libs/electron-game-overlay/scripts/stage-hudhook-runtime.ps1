[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL"

function Resolve-Executable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string[]]$Fallbacks = @()
    )

    $Command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue
    if ($Command) {
        return $Command.Source
    }

    foreach ($Fallback in $Fallbacks) {
        if ($Fallback -and (Test-Path -LiteralPath $Fallback -PathType Leaf)) {
            return $Fallback
        }
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
        throw "Refusing to stage hudhook through a reparse point: $Path"
    }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "The bundled hudhook runtime can only be built on Windows."
}
if (-not [System.Environment]::Is64BitOperatingSystem -or -not [System.Environment]::Is64BitProcess) {
    throw "The bundled hudhook runtime requires a 64-bit Windows build process."
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$HudhookRoot = Join-Path $RepoRoot "poc\hudhook-imgui-overlay"
$LibraryDistRoot = Join-Path $RepoRoot "libs\electron-game-overlay\dist"
$LibraryEntry = Join-Path $LibraryDistRoot "index.js"
$RuntimeRoot = Join-Path $LibraryDistRoot "runtime"
$RuntimeDirectory = Join-Path $RuntimeRoot "win32-x64"
$CargoTarget = Join-Path $RepoRoot "build\hudhook-imgui-overlay\cargo"

if (-not (Test-Path -LiteralPath $LibraryEntry -PathType Leaf)) {
    throw "Build the electron-game-overlay TypeScript library before staging hudhook: $LibraryEntry"
}

foreach ($PathToVerify in @($LibraryDistRoot, $RuntimeRoot, $RuntimeDirectory)) {
    Assert-NotReparsePoint $PathToVerify
}

$CargoFallbacks = @()
if ($env:CARGO_HOME) {
    $CargoFallbacks += (Join-Path $env:CARGO_HOME "bin\cargo.exe")
}
$CargoFallbacks += (Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe")

$Cargo = Resolve-Executable "cargo.exe" $CargoFallbacks
$VsWhere = Resolve-Executable "vswhere.exe" @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe")
)

$VsInstall = (& $VsWhere `
    -latest `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath | Select-Object -First 1)
if (-not $VsInstall) {
    throw "Visual Studio 2022 C++ Build Tools were not found."
}
$VsInstall = $VsInstall.Trim()

$DevShellModule = Join-Path $VsInstall "Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
if (-not (Test-Path -LiteralPath $DevShellModule -PathType Leaf)) {
    throw "Visual Studio developer shell module was not found: $DevShellModule"
}
Import-Module $DevShellModule
Enter-VsDevShell `
    -VsInstallPath $VsInstall `
    -SkipAutomaticLocation `
    -DevCmdArguments "-arch=x64 -host_arch=x64" | Out-Null

Push-Location $HudhookRoot
try {
    & $Cargo `
        build `
        --locked `
        --release `
        --target x86_64-pc-windows-msvc `
        --target-dir $CargoTarget `
        --package hudhook-overlay-injector `
        --package hudhook-imgui-overlay-dx11 `
        --package hudhook-imgui-overlay-dx12

    if ($LASTEXITCODE -ne 0) {
        throw "Building the bundled hudhook runtime failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$CargoRelease = Join-Path $CargoTarget "x86_64-pc-windows-msvc\release"
$Artifacts = @(
    @{
        Source = Join-Path $CargoRelease "hudhook-overlay-injector.exe"
        Name = "hudhook_overlay_injector.exe"
    },
    @{
        Source = Join-Path $CargoRelease "hudhook_imgui_overlay_dx11.dll"
        Name = "hudhook_imgui_overlay_dx11.dll"
    },
    @{
        Source = Join-Path $CargoRelease "hudhook_imgui_overlay_dx12.dll"
        Name = "hudhook_imgui_overlay_dx12.dll"
    },
    @{
        Source = Join-Path $HudhookRoot "THIRD_PARTY_NOTICES.md"
        Name = "THIRD_PARTY_NOTICES.md"
    }
)

foreach ($Artifact in $Artifacts) {
    if (-not (Test-Path -LiteralPath $Artifact.Source -PathType Leaf)) {
        throw "Expected hudhook runtime artifact not found: $($Artifact.Source)"
    }
}

$ResolvedRuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$ResolvedRuntimeDirectory = [System.IO.Path]::GetFullPath($RuntimeDirectory)
$ExpectedRuntimePrefix = $ResolvedRuntimeRoot.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
if (-not $ResolvedRuntimeDirectory.StartsWith(
    $ExpectedRuntimePrefix,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw "Refusing to stage hudhook outside the library runtime root: $ResolvedRuntimeDirectory"
}

foreach ($PathToVerify in @($LibraryDistRoot, $RuntimeRoot, $RuntimeDirectory)) {
    Assert-NotReparsePoint $PathToVerify
}
if (Test-Path -LiteralPath $ResolvedRuntimeDirectory) {
    Remove-Item -LiteralPath $ResolvedRuntimeDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $ResolvedRuntimeDirectory | Out-Null

foreach ($Artifact in $Artifacts) {
    Copy-Item `
        -LiteralPath $Artifact.Source `
        -Destination (Join-Path $ResolvedRuntimeDirectory $Artifact.Name) `
        -Force
}

Write-Host "HUDHOOK_SDK_RUNTIME_STAGED directory=$ResolvedRuntimeDirectory"
