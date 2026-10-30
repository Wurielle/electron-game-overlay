[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d11", "d3d12")]
    [string]$Backend,
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $RuntimeRoot "..\..")).Path
$BuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
$ProductionBuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime-production"
$OutputDirectory = Join-Path $ProductionBuildRoot "RelWithDebInfo"
$Runtime = Join-Path $BuildRoot "_deps\reshade-src\bin\x64\Release\ReShade64.dll"
$HostName = "${Backend}_overlay_test_host.exe"
$HostTarget = "${Backend}_overlay_test_host"
$ProxyName = if ($Backend -eq "d3d11") { "d3d11.dll" } else { "dxgi.dll" }
$BackendLabel = if ($Backend -eq "d3d11") { "D3D11" } else { "D3D12" }
$BuiltHost = Join-Path $OutputDirectory $HostName
$Addon = Join-Path $OutputDirectory "electron_game_overlay.addon64"
$Config = Join-Path $RuntimeRoot "config\ReShade.ini"
$RunName = if ($NoLaunch) {
    "electron-scene-$Backend-staged"
}
else {
    "electron-scene-$Backend-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
}
$RunDirectory = Join-Path $BuildRoot $RunName
$Electron = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
$ElectronDemo = Join-Path $RepoRoot "tools\electron-overlay-scene-producer"
$Nx = Join-Path $RepoRoot "node_modules\.bin\nx.cmd"
$SdkDist = Join-Path $RepoRoot "libs\electron-game-overlay\dist\index.js"
$RunHost = Join-Path $RunDirectory $HostName

# Both controlled hosts use the same fixed transport name. Reject every stale copy
# rather than only the current backend or the copy in the current stage.
$ExistingHosts = @(
    foreach ($ControlledHostName in @(
            "d3d11_overlay_test_host.exe",
            "d3d12_overlay_test_host.exe")) {
        Get-CimInstance Win32_Process `
            -Filter "Name='$ControlledHostName'" `
            -ErrorAction SilentlyContinue
    }
)
$ExistingProducers = @(
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$ElectronDemo*" }
)
if ($ExistingHosts.Count -ne 0 -or $ExistingProducers.Count -ne 0) {
    $ProcessIds = @($ExistingHosts.ProcessId) + @($ExistingProducers.ProcessId)
    throw "Close the existing $BackendLabel host/overlay producer before this test (PID: $($ProcessIds -join ', '))."
}

if (-not (Test-Path -LiteralPath $Nx -PathType Leaf)) {
    throw "The local Nx CLI is missing: $Nx. Install the workspace dependencies first."
}

& $Nx run electron-game-overlay:build
if ($LASTEXITCODE -ne 0) {
    throw "electron-game-overlay build failed with exit code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $SdkDist -PathType Leaf)) {
    throw "electron-game-overlay build did not produce $SdkDist."
}

Push-Location $RuntimeRoot
try {
    & cmake.exe --preset vs2022-x64-production
    if ($LASTEXITCODE -ne 0) {
        throw "CMake configure failed with exit code $LASTEXITCODE."
    }

    & cmake.exe --build $ProductionBuildRoot `
        --config RelWithDebInfo `
        --target $HostTarget electron_game_overlay `
        --parallel
    if ($LASTEXITCODE -ne 0) {
        throw "$BackendLabel Electron scene build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

& (Join-Path $PSScriptRoot "build-reshade-runtime.ps1")

foreach ($RequiredFile in @($Runtime, $BuiltHost, $Addon, $Config, $Electron)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "Required $BackendLabel Electron scene artifact is missing: $RequiredFile"
    }
}
if (-not (Test-Path -LiteralPath $ElectronDemo -PathType Container)) {
    throw "Electron scene producer is missing: $ElectronDemo"
}

if (Test-Path -LiteralPath $RunDirectory) {
    $ResolvedRunDirectory = (Resolve-Path -LiteralPath $RunDirectory).Path
    $ResolvedBuildRoot = (Resolve-Path -LiteralPath $BuildRoot).Path
    if (-not $ResolvedRunDirectory.StartsWith(
            $ResolvedBuildRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean Electron scene directory outside the build root: $ResolvedRunDirectory"
    }
    $RunItem = Get-Item -LiteralPath $ResolvedRunDirectory -Force
    if (($RunItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to clean a reparse-point Electron scene directory: $ResolvedRunDirectory"
    }
    Remove-Item -LiteralPath $ResolvedRunDirectory -Recurse -Force
}

New-Item -ItemType Directory -Path $RunDirectory | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination (Join-Path $RunDirectory $HostName)
Copy-Item -LiteralPath $Addon -Destination (Join-Path $RunDirectory "electron_game_overlay.addon64")
Copy-Item -LiteralPath $Runtime -Destination (Join-Path $RunDirectory $ProxyName)
Copy-Item -LiteralPath $Config -Destination (Join-Path $RunDirectory "ReShade.ini")
New-Item -ItemType File -Path (Join-Path $RunDirectory "reshade-input-gate.enabled") | Out-Null

Write-Host ""
Write-Host "ReShade $BackendLabel Electron scene"
Write-Host "  - Drag either striped caption to move that Electron window."
Write-Host "  - Click/type in either input target; overlapping pixels select the front window."
Write-Host "  - The host title's game-input counters must remain frozen and clip must stay off."
Write-Host "  - Close the host with its title-bar X when finished."
Write-Host ""

if ($NoLaunch) {
    Write-Host "ReShade $BackendLabel Electron scene staged: $RunDirectory"
    return
}

$ProducerMarker = "electron-reshade-scene-$Backend-$([Guid]::NewGuid().ToString('N'))"
$UserData = Join-Path $RunDirectory $ProducerMarker
$ProducerStdout = Join-Path $RunDirectory "electron-producer.stdout.log"
$ProducerStderr = Join-Path $RunDirectory "electron-producer.stderr.log"
$Log = Join-Path $RunDirectory "ReShade.log"
$HostProcess = $null
$ProducerProcess = $null

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
    $HostProcess = Start-Process -FilePath $RunHost -PassThru

    $HostDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $HostDeadline) {
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) {
            throw "The $BackendLabel host exited before the Electron compositor initialized."
        }
        if ((Test-Path -LiteralPath $Log -PathType Leaf) -and
            (Select-String -LiteralPath $Log `
                -SimpleMatch "initialized its transport and input router" `
                -Quiet)) {
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $Log -PathType Leaf) -or
        -not (Select-String -LiteralPath $Log `
            -SimpleMatch "initialized its transport and input router" `
            -Quiet)) {
        throw "Timed out waiting for the ReShade Electron compositor. Inspect $Log."
    }

    $ProducerArguments = @(
        "`"$ElectronDemo`"",
        "--hudhook-client-multiwindow-manual",
        "--hudhook-device-scale-factor=1",
        "`"--user-data-dir=$UserData`"",
        "--no-sandbox"
    )
    $ProducerProcess = Start-Process `
        -FilePath $Electron `
        -ArgumentList $ProducerArguments `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $ProducerStdout `
        -RedirectStandardError $ProducerStderr

    $ProducerDeadline = [DateTime]::UtcNow.AddSeconds(30)
    $ProducerReady = $false
    $SceneReady = $false
    while ([DateTime]::UtcNow -lt $ProducerDeadline) {
        $ProducerProcess.Refresh()
        if ((Test-Path -LiteralPath $ProducerStdout -PathType Leaf) -and
            (Select-String -LiteralPath $ProducerStdout `
                -SimpleMatch "HUDHOOK_CLIENT_MULTIWINDOW_MANUAL_READY" `
                -Quiet)) {
            $ProducerReady = $true
        }
        if ((Test-Path -LiteralPath $Log -PathType Leaf) -and
            (Select-String -LiteralPath $Log `
                -SimpleMatch "rendered its first transported multi-window scene (2 window(s))" `
                -Quiet)) {
            $SceneReady = $true
        }
        if ($ProducerReady -and $SceneReady) {
            break
        }
        if ($ProducerProcess.HasExited) {
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ProducerReady) {
        throw "Electron producer did not become ready. Inspect $ProducerStdout and $ProducerStderr."
    }
    if (-not $SceneReady) {
        throw "ReShade did not render the two-window Electron scene. Inspect $Log."
    }

    Write-Host "Electron scene ready. Producer log: $ProducerStdout"
    Wait-Process -Id $HostProcess.Id
    $HostProcess.Refresh()
    if ($HostProcess.ExitCode -ne 0) {
        throw "Controlled $BackendLabel host exited with code $($HostProcess.ExitCode)."
    }
}
finally {
    # Only terminate this invocation's uniquely marked Electron tree and the exact
    # controlled host process that it started.
    $CleanupIds = @(
        Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*$ProducerMarker*" } |
            ForEach-Object { $_.ProcessId }
    )
    if ($ProducerProcess) {
        $ProducerProcess.Refresh()
        if (-not $ProducerProcess.HasExited) {
            $CleanupIds += $ProducerProcess.Id
        }
    }
    if ($HostProcess) {
        $HostProcess.Refresh()
        if (-not $HostProcess.HasExited) {
            $CleanupIds += $HostProcess.Id
        }
    }
    $CleanupIds = @($CleanupIds | Sort-Object -Unique)
    foreach ($ProcessId in $CleanupIds) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
    foreach ($ProcessId in $CleanupIds) {
        Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
    foreach ($VariableName in $ControlledEnvironmentVariables) {
        [Environment]::SetEnvironmentVariable(
            $VariableName,
            $PreviousEnvironment[$VariableName],
            "Process")
    }
}

Write-Host "ReShade log: $Log"
