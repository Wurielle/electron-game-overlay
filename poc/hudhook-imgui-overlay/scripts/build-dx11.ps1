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
        if ($Fallback -and (Test-Path $Fallback -PathType Leaf)) {
            return $Fallback
        }
    }

    throw "Required build tool not found: $Name"
}

$HudhookRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$CargoFallbacks = @()
if ($env:CARGO_HOME) {
    $CargoFallbacks += (Join-Path $env:CARGO_HOME "bin\cargo.exe")
}
$CargoFallbacks += (Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe")

$CMake = Resolve-Executable "cmake.exe" @(
    (Join-Path $env:ProgramFiles "CMake\bin\cmake.exe")
)
$Cargo = Resolve-Executable "cargo.exe" $CargoFallbacks
$VsWhere = Resolve-Executable "vswhere.exe" @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe")
)

$VsInstall = (& $VsWhere `
    -latest `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath).Trim()

if (-not $VsInstall) {
    throw "Visual Studio 2022 C++ Build Tools were not found."
}

$DevShellModule = Join-Path $VsInstall "Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
Import-Module $DevShellModule
Enter-VsDevShell `
    -VsInstallPath $VsInstall `
    -SkipAutomaticLocation `
    -DevCmdArguments "-arch=x64 -host_arch=x64" | Out-Null

$RuntimeRoot = Join-Path $RepoRoot "libs\electron-game-overlay-runtime"
Push-Location $RuntimeRoot
try {
    & $CMake --preset vs2022-x64
    if ($LASTEXITCODE -ne 0) {
        throw "Configuring the controlled D3D11 host failed with exit code $LASTEXITCODE."
    }

    & $CMake --build --preset relwithdebinfo
    if ($LASTEXITCODE -ne 0) {
        throw "Building the controlled D3D11 host failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$CargoTarget = Join-Path $RepoRoot "build\hudhook-imgui-overlay\cargo"
Push-Location $HudhookRoot
try {
    & $Cargo `
        build `
        --locked `
        --release `
        --target x86_64-pc-windows-msvc `
        --target-dir $CargoTarget

    if ($LASTEXITCODE -ne 0) {
        throw "Building the hudhook workspace failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$HostSource = Join-Path $RepoRoot "build\electron-game-overlay-runtime\RelWithDebInfo\d3d11_overlay_test_host.exe"
$CargoRelease = Join-Path $CargoTarget "x86_64-pc-windows-msvc\release"
$PayloadSource = Join-Path $CargoRelease "hudhook_imgui_overlay_dx11.dll"
$InjectorSource = Join-Path $CargoRelease "hudhook-overlay-injector.exe"
$NoticesSource = Join-Path $HudhookRoot "THIRD_PARTY_NOTICES.md"
$RunDirectory = Join-Path $RepoRoot "build\hudhook-imgui-overlay\run\dx11"

foreach ($Artifact in @($HostSource, $PayloadSource, $InjectorSource, $NoticesSource)) {
    if (-not (Test-Path $Artifact -PathType Leaf)) {
        throw "Expected build artifact not found: $Artifact"
    }
}

if (Test-Path $RunDirectory) {
    $ExpectedRunRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "build\hudhook-imgui-overlay\run"))
    $ResolvedRunDirectory = [System.IO.Path]::GetFullPath($RunDirectory)
    if (-not $ResolvedRunDirectory.StartsWith($ExpectedRunRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean an unexpected run directory: $ResolvedRunDirectory"
    }
    Remove-Item -LiteralPath $RunDirectory -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $RunDirectory | Out-Null

Copy-Item -Force $HostSource (Join-Path $RunDirectory "d3d11_overlay_test_host.exe")
Copy-Item -Force $PayloadSource (Join-Path $RunDirectory "hudhook_imgui_overlay_dx11.dll")
Copy-Item -Force $InjectorSource (Join-Path $RunDirectory "hudhook_overlay_injector.exe")
Copy-Item -Force $NoticesSource (Join-Path $RunDirectory "THIRD_PARTY_NOTICES.md")

Write-Host ""
Write-Host "hudhook D3D11 POC staged in:"
Write-Host "  $RunDirectory"
Write-Host ""
Write-Host "Run it with:"
Write-Host "  .\poc\hudhook-imgui-overlay\scripts\run-dx11.ps1"
