[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d9", "d3d10", "d3d11", "d3d12")]
    [string]$Backend,
    [ValidateSet("x64", "x86")]
    [string]$Architecture = "x64",
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $RuntimeRoot "..\..")).Path
$SharedBuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
$BuildRoot = if ($Architecture -eq "x86") {
    Join-Path $RepoRoot "build\electron-game-overlay-runtime-x86"
}
else {
    $SharedBuildRoot
}
$OutputDirectory = Join-Path $BuildRoot "RelWithDebInfo"
$Runtime = if ($Architecture -eq "x86") {
    Join-Path $SharedBuildRoot "_deps\reshade-src\bin\Win32\Release\ReShade32.dll"
}
else {
    Join-Path $SharedBuildRoot "_deps\reshade-src\bin\x64\Release\ReShade64.dll"
}
$AddonName = if ($Architecture -eq "x86") {
    "native_input_gate_addon.addon32"
}
else {
    "native_input_gate_addon.addon64"
}
$Addon = Join-Path $OutputDirectory $AddonName
$Config = Join-Path $RuntimeRoot "config\ReShade.ini"
if ($Architecture -eq "x86" -and $Backend -notin @("d3d9", "d3d10")) {
    throw "The controlled x86 gate currently covers D3D9 and D3D10."
}
$BackendConfig = switch ($Backend) {
    "d3d9" {
        [pscustomobject]@{
            Preset = if ($Architecture -eq "x86") {
                "relwithdebinfo-x86-dx9"
            }
            else {
                "relwithdebinfo-dx9"
            }
            ProxyName = "d3d9.dll"
        }
    }
    "d3d10" {
        [pscustomobject]@{
            Preset = if ($Architecture -eq "x86") {
                "relwithdebinfo-x86-dx10"
            }
            else {
                "relwithdebinfo-dx10"
            }
            ProxyName = "d3d10.dll"
        }
    }
    "d3d11" {
        [pscustomobject]@{ Preset = "relwithdebinfo"; ProxyName = "d3d11.dll" }
    }
    "d3d12" {
        [pscustomobject]@{ Preset = "relwithdebinfo-dx12"; ProxyName = "dxgi.dll" }
    }
}
$Preset = $BackendConfig.Preset
$ProxyName = $BackendConfig.ProxyName
$HostName = "${Backend}_overlay_test_host.exe"
$BuiltHost = Join-Path $OutputDirectory $HostName
$RunDirectoryName = if ($Architecture -eq "x86") {
    "input-gate-$Backend-x86"
}
else {
    "input-gate-$Backend"
}
$RunDirectory = Join-Path $BuildRoot $RunDirectoryName

Push-Location $RuntimeRoot
try {
    & cmake.exe --preset $(
        if ($Architecture -eq "x86") { "vs2022-x86" } else { "vs2022-x64" })
    if ($LASTEXITCODE -ne 0) {
        throw "CMake configure failed with exit code $LASTEXITCODE."
    }
    & cmake.exe --build --preset $Preset
    if ($LASTEXITCODE -ne 0) {
        throw "Controlled $Backend input-gate build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

& (Join-Path $PSScriptRoot "build-reshade-runtime.ps1") `
    -Architecture $Architecture

foreach ($RequiredFile in @($Runtime, $Addon, $Config, $BuiltHost)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "Required input-gate artifact is missing: $RequiredFile"
    }
}

if (Test-Path -LiteralPath $RunDirectory) {
    $ResolvedRunDirectory = (Resolve-Path -LiteralPath $RunDirectory).Path
    $ResolvedBuildRoot = (Resolve-Path -LiteralPath $BuildRoot).Path
    if (-not $ResolvedRunDirectory.StartsWith(
            $ResolvedBuildRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean input-gate directory outside the build root: $ResolvedRunDirectory"
    }
    $RunItem = Get-Item -LiteralPath $ResolvedRunDirectory -Force
    if (($RunItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to clean a reparse-point input-gate directory: $ResolvedRunDirectory"
    }
    Remove-Item -LiteralPath $ResolvedRunDirectory -Recurse -Force
}

New-Item -ItemType Directory -Path $RunDirectory | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination (Join-Path $RunDirectory $HostName)
Copy-Item -LiteralPath $Addon -Destination (Join-Path $RunDirectory (Split-Path $Addon -Leaf))
Copy-Item -LiteralPath $Runtime -Destination (Join-Path $RunDirectory $ProxyName)
Copy-Item -LiteralPath $Config -Destination (Join-Path $RunDirectory "ReShade.ini")
New-Item -ItemType File -Path (Join-Path $RunDirectory "reshade-input-gate.enabled") | Out-Null

$RunHost = Join-Path $RunDirectory $HostName
Write-Host ""
Write-Host "ReShade-owned $Architecture $Backend input gate"
Write-Host "  1. Move/click with pass-through active; the title counters should change."
Write-Host "  2. Press Ctrl+I; the panel must show RESHADE-OWNED."
Write-Host "  3. Click, type, drag, and wheel in the probes; title counters must stop."
Write-Host "  4. Resize while intercepted; ownership and controls must survive."
Write-Host "  5. Press Ctrl+I again; title counters and cursor clip should resume."
Write-Host "  6. Press Escape to close the host."
Write-Host ""

if ($NoLaunch) {
    Write-Host "ReShade-owned $Backend input gate staged: $RunDirectory"
    return
}

$ControlledEnvironmentVariables = @(
    "RESHADE_BASE_PATH_OVERRIDE",
    "RESHADE_DISABLE_GRAPHICS_HOOK",
    "RESHADE_DISABLE_INPUT_HOOK",
    "RESHADE_DISABLE_LOGGING"
)
$PreviousEnvironment = @{}
foreach ($VariableName in $ControlledEnvironmentVariables) {
    $PreviousEnvironment[$VariableName] =
        [Environment]::GetEnvironmentVariable($VariableName, "Process")
    [Environment]::SetEnvironmentVariable($VariableName, $null, "Process")
}

try {
    & $RunHost
    $HostExitCode = $LASTEXITCODE
}
finally {
    foreach ($VariableName in $ControlledEnvironmentVariables) {
        [Environment]::SetEnvironmentVariable(
            $VariableName,
            $PreviousEnvironment[$VariableName],
            "Process")
    }
}

$Log = Join-Path $RunDirectory "ReShade.log"
if (Test-Path -LiteralPath $Log -PathType Leaf) {
    Write-Host "ReShade log: $Log"
}
if ($HostExitCode -ne 0) {
    throw "Controlled $Backend input-gate host exited with code $HostExitCode."
}
