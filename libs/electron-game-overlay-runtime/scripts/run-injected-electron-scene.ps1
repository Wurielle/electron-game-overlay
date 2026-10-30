[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DisplayName,
    [Parameter(Mandatory = $true)]
    [string]$TargetExecutableName,
    [Parameter(Mandatory = $true)]
    [string]$TargetExecutablePath,
    [Parameter(Mandatory = $true)]
    [string]$LaunchUri,
    [switch]$GunFrogButtonProof,
    [switch]$NoLaunch,
    [ValidateRange(30, 600)]
    [int]$LaunchTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $RuntimeRoot "..\..")).Path
$BuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
$ProductionBuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime-production"
$OutputDirectory = Join-Path $ProductionBuildRoot "RelWithDebInfo"
$Runtime = Join-Path $BuildRoot "_deps\reshade-src\bin\x64\Release\ReShade64.dll"
$Injector = Join-Path $BuildRoot "_deps\reshade-src\bin\x64\Release\inject.exe"
$Addon = Join-Path $OutputDirectory "electron_game_overlay.addon64"
$Config = Join-Path $RuntimeRoot "config\ReShade.ini"
$Electron = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
$ElectronDemo = Join-Path $RepoRoot "tools\electron-overlay-scene-producer"
$Nx = Join-Path $RepoRoot "node_modules\.bin\nx.cmd"
$SdkDist = Join-Path $RepoRoot "libs\electron-game-overlay\dist\index.js"
$SafeName = ($DisplayName -replace '[^A-Za-z0-9._-]', '-').Trim('-')
$RunName = if ($NoLaunch) {
    "injected-$SafeName-staged"
}
else {
    "injected-$SafeName-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
}
$RunDirectory = Join-Path $BuildRoot $RunName

if (-not (Test-Path -LiteralPath $TargetExecutablePath -PathType Leaf)) {
    throw "$DisplayName executable was not found: $TargetExecutablePath"
}
if (-not [string]::Equals(
        (Split-Path -Leaf $TargetExecutablePath),
        $TargetExecutableName,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw "Target executable name/path mismatch: $TargetExecutableName / $TargetExecutablePath"
}

$ExistingTargets = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq $TargetExecutableName }
)
$ExistingProducers = @(
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$ElectronDemo*" }
)
$ExistingInjectors = @(
    Get-CimInstance Win32_Process -Filter "Name='inject.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$TargetExecutableName*" }
)
if ($ExistingTargets.Count -ne 0 -or
    $ExistingProducers.Count -ne 0 -or
    $ExistingInjectors.Count -ne 0) {
    $ProcessIds = @($ExistingTargets.ProcessId) +
        @($ExistingProducers.ProcessId) +
        @($ExistingInjectors.ProcessId)
    throw "Close the existing target/overlay test before this run (PID: $($ProcessIds -join ', '))."
}

if (-not (Test-Path -LiteralPath $Nx -PathType Leaf)) {
    throw "The local Nx CLI is missing: $Nx. Install the workspace dependencies first."
}

& $Nx run electron-game-overlay:build
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $SdkDist -PathType Leaf)) {
    throw "electron-game-overlay build failed or did not produce $SdkDist."
}

Push-Location $RuntimeRoot
try {
    & cmake.exe --preset vs2022-x64-production
    if ($LASTEXITCODE -ne 0) {
        throw "CMake configure failed with exit code $LASTEXITCODE."
    }
    & cmake.exe --build $ProductionBuildRoot `
        --config RelWithDebInfo `
        --target electron_game_overlay `
        --parallel
    if ($LASTEXITCODE -ne 0) {
        throw "Electron ReShade add-on build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

& (Join-Path $PSScriptRoot "build-reshade-runtime.ps1")

foreach ($RequiredFile in @(
        $Runtime,
        $Injector,
        $Addon,
        $Config,
        $Electron,
        $TargetExecutablePath)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "Required injected-scene artifact is missing: $RequiredFile"
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
        throw "Refusing to clean injected scene directory outside the build root: $ResolvedRunDirectory"
    }
    $RunItem = Get-Item -LiteralPath $ResolvedRunDirectory -Force
    if (($RunItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to clean a reparse-point injected scene directory: $ResolvedRunDirectory"
    }
    Remove-Item -LiteralPath $ResolvedRunDirectory -Recurse -Force
}

New-Item -ItemType Directory -Path $RunDirectory | Out-Null
Copy-Item -LiteralPath $Runtime -Destination (Join-Path $RunDirectory "ReShade64.dll")
Copy-Item -LiteralPath $Injector -Destination (Join-Path $RunDirectory "inject.exe")
Copy-Item -LiteralPath $Addon -Destination (Join-Path $RunDirectory "electron_game_overlay.addon64")
Copy-Item -LiteralPath $Config -Destination (Join-Path $RunDirectory "ReShade.ini")

Write-Host ""
Write-Host "ReShade injected Electron scene: $DisplayName"
Write-Host "  - Runtime, add-on, configuration, and logs stay in: $RunDirectory"
Write-Host "  - The launcher never accepts Steam/session prompts for you."
Write-Host "  - Keep the game focused while interception is enabled."
if ($GunFrogButtonProof) {
    Write-Host "  - Four Electron buttons must cover Continue, New Game, Settings, and Quit."
}
Write-Host "  - Close the game normally when testing is finished."
Write-Host ""

if ($NoLaunch) {
    Write-Host "Injected Electron scene staged: $RunDirectory"
    return
}

$TargetDirectoryLog = Join-Path (Split-Path -Parent $TargetExecutablePath) "ReShade.log"
if (Test-Path -LiteralPath $TargetDirectoryLog) {
    throw "The target directory already contains ReShade.log; refusing an ambiguous isolation test: $TargetDirectoryLog"
}

$InjectorStdout = Join-Path $RunDirectory "inject.stdout.log"
$InjectorStderr = Join-Path $RunDirectory "inject.stderr.log"
$ProducerStdout = Join-Path $RunDirectory "electron-producer.stdout.log"
$ProducerStderr = Join-Path $RunDirectory "electron-producer.stderr.log"
$ReShadeLog = Join-Path $RunDirectory "ReShade.log"
$ProducerMarker = "electron-reshade-injected-$SafeName-$([Guid]::NewGuid().ToString('N'))"
$UserData = Join-Path $RunDirectory $ProducerMarker
$InjectorProcess = $null
$ProducerProcess = $null
$TargetProcessId = 0
$RunCompleted = $false

try {
    $InjectorProcess = Start-Process `
        -FilePath (Join-Path $RunDirectory "inject.exe") `
        -ArgumentList "`"$TargetExecutableName`"" `
        -WorkingDirectory $RunDirectory `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $InjectorStdout `
        -RedirectStandardError $InjectorStderr

    Start-Process -FilePath $LaunchUri | Out-Null

    $LaunchDeadline = [DateTime]::UtcNow.AddSeconds($LaunchTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $LaunchDeadline) {
        $TargetProcess = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq $TargetExecutableName } |
            Select-Object -First 1
        if ($TargetProcess) {
            $TargetProcessId = $TargetProcess.ProcessId
        }
        if ($TargetProcessId -ne 0 -and
            (Test-Path -LiteralPath $ReShadeLog -PathType Leaf) -and
            (Select-String -LiteralPath $ReShadeLog `
                -SimpleMatch "initialized its transport and input router" `
                -Quiet)) {
            break
        }
        if ($TargetProcessId -ne 0 -and
            -not (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) {
            throw "$DisplayName exited before the ReShade compositor initialized."
        }
        Start-Sleep -Milliseconds 100
    }
    if ($TargetProcessId -eq 0 -or
        -not (Test-Path -LiteralPath $ReShadeLog -PathType Leaf) -or
        -not (Select-String -LiteralPath $ReShadeLog `
            -SimpleMatch "initialized its transport and input router" `
            -Quiet)) {
        throw "Timed out waiting for $DisplayName/ReShade. Inspect $InjectorStdout and $InjectorStderr."
    }

    if (-not $InjectorProcess.WaitForExit(5000)) {
        throw "The injector did not finish after the ReShade compositor initialized."
    }
    # Complete redirected-stream draining and refresh the process snapshot before
    # reading ExitCode. Start-Process can otherwise expose a transient null value
    # even though the bounded wait already observed process termination.
    $InjectorProcess.WaitForExit()
    $InjectorProcess.Refresh()
    $InjectorExitCode = $InjectorProcess.ExitCode
    if ($null -ne $InjectorExitCode -and $InjectorExitCode -ne 0) {
        throw "The injector exited with code $InjectorExitCode. Inspect $InjectorStdout."
    }
    if (-not (Test-Path -LiteralPath $InjectorStdout -PathType Leaf) -or
        -not (Select-String -LiteralPath $InjectorStdout `
            -SimpleMatch "Injecting ReShade ... Succeeded!" `
            -Quiet)) {
        throw "The injector did not report successful injection. Inspect $InjectorStdout."
    }

    $ProducerArguments = @(
        "`"$ElectronDemo`"",
        "--hudhook-client-multiwindow-manual",
        "--hudhook-device-scale-factor=1",
        "`"--user-data-dir=$UserData`"",
        "--no-sandbox"
    )
    if ($GunFrogButtonProof) {
        $ProducerArguments += "--hudhook-gun-frog-buttons"
    }
    $ProducerProcess = Start-Process `
        -FilePath $Electron `
        -ArgumentList $ProducerArguments `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $ProducerStdout `
        -RedirectStandardError $ProducerStderr

    $ProducerDeadline = [DateTime]::UtcNow.AddSeconds(45)
    $ProducerReady = $false
    $SceneReady = $false
    $ButtonProofReady = -not $GunFrogButtonProof
    while ([DateTime]::UtcNow -lt $ProducerDeadline) {
        $ProducerProcess.Refresh()
        if ((Test-Path -LiteralPath $ProducerStdout -PathType Leaf) -and
            (Select-String -LiteralPath $ProducerStdout `
                -SimpleMatch "HUDHOOK_CLIENT_MULTIWINDOW_MANUAL_READY" `
                -Quiet)) {
            $ProducerReady = $true
        }
        if ($GunFrogButtonProof -and
            (Test-Path -LiteralPath $ProducerStdout -PathType Leaf) -and
            (Select-String -LiteralPath $ProducerStdout `
                -SimpleMatch "HUDHOOK_GUN_FROG_BUTTONS_READY" `
                -Quiet)) {
            $ButtonProofReady = $true
        }
        if ((Test-Path -LiteralPath $ReShadeLog -PathType Leaf) -and
            (Select-String -LiteralPath $ReShadeLog `
                -SimpleMatch "rendered its first transported multi-window scene (2 window(s))" `
                -Quiet)) {
            $SceneReady = $true
        }
        if ($ProducerReady -and $SceneReady -and $ButtonProofReady) {
            break
        }
        if ($ProducerProcess.HasExited -or
            -not (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) {
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ProducerReady -or -not $SceneReady -or -not $ButtonProofReady) {
        throw "The injected Electron scene did not become ready. Inspect $ProducerStdout, $ProducerStderr, and $ReShadeLog."
    }

    Write-Host "Injected Electron scene ready for $DisplayName (PID $TargetProcessId)."
    Write-Host "Producer log: $ProducerStdout"
    Write-Host "ReShade log: $ReShadeLog"
    Wait-Process -Id $TargetProcessId
    $RunCompleted = $true
}
finally {
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
    $CleanupIds = @($CleanupIds | Sort-Object -Unique)
    foreach ($ProcessId in $CleanupIds) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
    foreach ($ProcessId in $CleanupIds) {
        Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
    if ($InjectorProcess) {
        $InjectorProcess.Refresh()
        if (-not $InjectorProcess.HasExited) {
            Stop-Process -Id $InjectorProcess.Id -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $InjectorProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
        }
    }
    if (-not $RunCompleted -and $TargetProcessId -ne 0) {
        $TargetHandle = Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue
        if ($TargetHandle) {
            $null = $TargetHandle.CloseMainWindow()
            Wait-Process -Id $TargetProcessId -Timeout 5 -ErrorAction SilentlyContinue
            if (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue) {
                Stop-Process -Id $TargetProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

if (Test-Path -LiteralPath $TargetDirectoryLog) {
    throw "The injected run wrote an unexpected target-directory log: $TargetDirectoryLog"
}

Write-Host "Injected scene logs preserved in: $RunDirectory"
