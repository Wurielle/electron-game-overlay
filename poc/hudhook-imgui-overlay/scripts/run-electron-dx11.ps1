[CmdletBinding(DefaultParameterSetName = "Diagnostic")]
param(
    [switch]$Wait,

    [Parameter(ParameterSetName = "Client")]
    [switch]$Client,

    [Parameter(ParameterSetName = "ClientWindow")]
    [switch]$ClientWindow
)

$ErrorActionPreference = "Stop"
$env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL"

# Producer stdout markers. Keep these synchronized with the corresponding
# Electron entry points and the real client's opt-in startup flag.
$DiagnosticReadyMarker = "HUDHOOK_ELECTRON_DEMO_READY"
$ClientReadyMarker = "HUDHOOK_CLIENT_OVERLAY_SESSION_READY"
$ClientWindowReadyMarker = "HUDHOOK_CLIENT_WINDOW_READY"
$ClientWindowLifecycleCompleteMarker = "HUDHOOK_CLIENT_WINDOW_LIFECYCLE_COMPLETE"
$ClientAutoStartFlag = "--start-overlay-session"
$ClientWindowRunnerFlag = "--hudhook-client-window-runner"

# Payload proof markers are intentionally centralized while the compositor
# lifecycle logging settles. Adjust these strings here if the Rust wording
# changes; every mode requires the common markers and the lifecycle producer
# additionally requires the five window-state markers.
$CompositorProofMarker = "Electron overlay composed at native bounds"
$ClientMetadataSelectedProofMarker = "Electron overlay metadata selected"
$ClientWindowNameProofMarker = "window_name=ExampleMainOverlay"
$ClientWindowBoundsProofMarker = "Electron overlay bounds updated"
$ClientWindowCloseProofMarker = "Electron overlay window closed"
$ClientWindowReselectProofMarker = "Electron overlay metadata reselected"
$ClientWindowCompositionClearedProofMarker = "Electron overlay composition cleared"
$ClientWindowCompositionResumedProofMarker = "Electron overlay composition resumed"
$ClientPayloadProofMarkers = @(
    $ClientMetadataSelectedProofMarker,
    $ClientWindowNameProofMarker
)
$CommonPayloadProofMarkers = @(
    "Electron frame received from node-game-overlay",
    "Electron frame uploaded to GPU",
    $CompositorProofMarker
)
$ClientWindowPayloadProofMarkers = @(
    $ClientWindowBoundsProofMarker,
    $ClientWindowCloseProofMarker,
    $ClientWindowReselectProofMarker,
    $ClientWindowCompositionClearedProofMarker,
    $ClientWindowCompositionResumedProofMarker
)

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$HudhookRoot = Split-Path -Parent $PSScriptRoot
$BuildScript = Join-Path $PSScriptRoot "build-dx11.ps1"
$RunDirectory = Join-Path $RepoRoot "build\hudhook-imgui-overlay\run\dx11"
$HostExecutable = Join-Path $RunDirectory "d3d11_overlay_test_host.exe"
$Injector = Join-Path $RunDirectory "hudhook_overlay_injector.exe"
$Payload = Join-Path $RunDirectory "hudhook_imgui_overlay_dx11.dll"
$ElectronExecutable = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
$DiagnosticEntry = Join-Path $HudhookRoot "electron-demo\main.cjs"
$DiagnosticAppDirectory = Split-Path -Parent $DiagnosticEntry
$ClientWindowEntry = Join-Path $HudhookRoot "electron-client-window-demo\main.cjs"
$ClientWindowAppDirectory = Split-Path -Parent $ClientWindowEntry
$ClientBuiltEntry = Join-Path $RepoRoot "apps\client\dist\main\main.js"
$ClientUserDataDirectory = Join-Path $RunDirectory "electron-client-user-data"
$WindowTitle = "Controlled D3D11 overlay test host"
$OverlayIpcHostWindowTitle = "n_overlay_1a1y2o8l0b"

if ($Client) {
    $ProducerMode = "Client"
    $ElectronReadyMarker = $ClientReadyMarker
    $ElectronApplication = $RepoRoot
    $ElectronArguments = @(
        $RepoRoot,
        $ClientAutoStartFlag,
        "--force-device-scale-factor=1",
        "--user-data-dir=$ClientUserDataDirectory",
        "--no-sandbox"
    )
    # The startup flag identifies the real client browser process. The unique
    # user-data switch is inherited by Chromium children and lets cleanup
    # safely discover only this controlled process tree.
    $ElectronCommandLineMarkers = @(
        $ClientAutoStartFlag,
        $ClientUserDataDirectory
    )
    $ElectronStdoutLog = Join-Path $RunDirectory "electron-client.stdout.log"
    $ElectronStderrLog = Join-Path $RunDirectory "electron-client.stderr.log"
    $ExpectedResult = "the real ExampleMainOverlay is rendered at its native bounds inside the controlled D3D11 host."
}
elseif ($ClientWindow) {
    $ProducerMode = "ClientWindow"
    $ElectronReadyMarker = $ClientWindowReadyMarker
    $ElectronApplication = $ClientWindowAppDirectory
    $ElectronArguments = @(
        $ClientWindowAppDirectory,
        $ClientWindowRunnerFlag,
        "--no-sandbox"
    )
    $ElectronCommandLineMarkers = @(
        $ClientWindowRunnerFlag,
        $ClientWindowAppDirectory
    )
    $ElectronStdoutLog = Join-Path $RunDirectory "electron-client-window.stdout.log"
    $ElectronStderrLog = Join-Path $RunDirectory "electron-client-window.stderr.log"
    $ExpectedResult = "the real transparent client window moves, closes, re-registers, and is composed at native bounds."
}
else {
    $ProducerMode = "Diagnostic"
    $ElectronReadyMarker = $DiagnosticReadyMarker
    $ElectronApplication = $DiagnosticAppDirectory
    $ElectronArguments = @($DiagnosticAppDirectory)
    $ElectronCommandLineMarkers = @($DiagnosticAppDirectory)
    $ElectronStdoutLog = Join-Path $RunDirectory "electron-demo.stdout.log"
    $ElectronStderrLog = Join-Path $RunDirectory "electron-demo.stderr.log"
    $ExpectedResult = "the diagnostic Electron demo window is rendered inside the controlled D3D11 host."
}

$RequiredPayloadProofMarkers = @($CommonPayloadProofMarkers)
$RequiredElectronProofMarkers = @()
if ($ClientWindow) {
    $RequiredPayloadProofMarkers += $ClientWindowPayloadProofMarkers
    $RequiredElectronProofMarkers += $ClientWindowLifecycleCompleteMarker
}
elseif ($Client) {
    $RequiredPayloadProofMarkers += $ClientPayloadProofMarkers
}

if (-not ("HudhookOverlayRunner.NativeMethods" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace HudhookOverlayRunner
{
    public static class NativeMethods
    {
        [DllImport("user32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        public static extern IntPtr FindWindow(string className, string windowName);
    }
}
"@
}

function Get-FileContent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path $Path -PathType Leaf)) {
        return ""
    }

    try {
        return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    }
    catch {
        # The producer or payload may be appending while the runner polls.
        return ""
    }
}

function Get-DemoElectronProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$CommandLineMarkers
    )

    $Processes = Get-CimInstance `
        -ClassName Win32_Process `
        -Filter "Name = 'electron.exe'" `
        -ErrorAction Stop

    foreach ($Candidate in $Processes) {
        if (-not $Candidate.CommandLine) {
            continue
        }

        $MatchesControlledInstance = $false
        foreach ($Marker in $CommandLineMarkers) {
            if (
                $Candidate.CommandLine.IndexOf(
                    $Marker,
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -ge 0
            ) {
                $MatchesControlledInstance = $true
                break
            }
        }

        if ($MatchesControlledInstance) {
            $Candidate
        }
    }
}

function Get-DemoElectronProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$CommandLineMarkers
    )

    foreach ($Candidate in @(Get-DemoElectronProcesses $CommandLineMarkers)) {
        [int]$Candidate.ProcessId
    }
}

function Get-LiveProcessIds {
    param(
        [int[]]$ProcessIds = @()
    )

    foreach ($CandidateId in $ProcessIds) {
        if (Get-Process -Id $CandidateId -ErrorAction SilentlyContinue) {
            $CandidateId
        }
    }
}

function Update-LaunchedElectronProcessIds {
    param(
        [int[]]$KnownProcessIds = @(),
        [int[]]$ExcludedProcessIds = @(),
        [Parameter(Mandatory = $true)]
        [string[]]$CommandLineMarkers
    )

    $DiscoveredProcessIds = @(
        Get-DemoElectronProcessIds $CommandLineMarkers |
            Where-Object { $_ -notin $ExcludedProcessIds }
    )

    @(
        @($KnownProcessIds) + @($DiscoveredProcessIds) |
            Sort-Object -Unique
    )
}

function Stop-LaunchedProcess {
    param(
        [System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if (-not $Process) {
        return
    }

    try {
        $Process.Refresh()
        if ($Process.HasExited) {
            return
        }

        Write-Verbose "Stopping launched $Description process $($Process.Id)."
        if ($Process.MainWindowHandle -ne [IntPtr]::Zero) {
            $Process.CloseMainWindow() | Out-Null
            if ($Process.WaitForExit(2000)) {
                return
            }
        }

        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $Process.WaitForExit(5000) | Out-Null
    }
    catch {
        Write-Warning "Could not stop launched $Description process $($Process.Id): $($_.Exception.Message)"
    }
}

function Stop-LaunchedElectronProcesses {
    param(
        [int[]]$ProcessIds = @(),
        [Parameter(Mandatory = $true)]
        [string[]]$CommandLineMarkers
    )

    $CapturedIds = @($ProcessIds | Sort-Object -Unique)

    # Re-check every stored PID's command line before acting on it. This avoids
    # touching an unrelated process if Windows reused an exited demo PID.
    $CapturedMatches = @(
        Get-DemoElectronProcesses $CommandLineMarkers |
            Where-Object { [int]$_.ProcessId -in $CapturedIds }
    )
    $MainProcessIds = @(
        $CapturedMatches |
            Where-Object {
                $_.CommandLine.IndexOf(
                    "--type=",
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -lt 0
            } |
            ForEach-Object { [int]$_.ProcessId }
    )
    $ChildProcessIds = @(
        $CapturedMatches |
            Where-Object {
                $_.CommandLine.IndexOf(
                    "--type=",
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -ge 0
            } |
            ForEach-Object { [int]$_.ProcessId }
    )

    # Stop the Electron browser process before its renderers. Otherwise the
    # demo observes a deliberate renderer kill as a renderer-gone failure.
    foreach ($CandidateId in $MainProcessIds) {
        $Candidate = Get-Process -Id $CandidateId -ErrorAction SilentlyContinue
        if ($Candidate) {
            Stop-LaunchedProcess $Candidate "Electron producer main"
        }
    }

    $ChildExitDeadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        $CurrentMatchingIds = @(Get-DemoElectronProcessIds $CommandLineMarkers)
        $RemainingChildIds = @(
            $ChildProcessIds |
                Where-Object {
                    $_ -in $CurrentMatchingIds -and
                    (Get-Process -Id $_ -ErrorAction SilentlyContinue)
                }
        )

        if ($RemainingChildIds.Count -eq 0) {
            break
        }

        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $ChildExitDeadline)

    # Force only captured children that still have this demo's command line.
    $CurrentMatchingIds = @(Get-DemoElectronProcessIds $CommandLineMarkers)
    foreach ($CandidateId in $ChildProcessIds) {
        if ($CandidateId -notin $CurrentMatchingIds) {
            continue
        }

        $Candidate = Get-Process -Id $CandidateId -ErrorAction SilentlyContinue
        if ($Candidate) {
            Stop-LaunchedProcess $Candidate "Electron producer child"
        }
    }
}

function Test-OverlayIpcHost {
    $HostWindow = [HudhookOverlayRunner.NativeMethods]::FindWindow(
        "STATIC",
        $OverlayIpcHostWindowTitle
    )
    return $HostWindow -ne [IntPtr]::Zero
}

function Assert-NoOverlayIpcHost {
    if (Test-OverlayIpcHost) {
        throw (
            "Close any running overlay client/producer before starting this test. " +
            "The fixed node-game-overlay IPC host '$OverlayIpcHostWindowTitle' is already active."
        )
    }
}

function Get-ExactTitleProcesses {
    @(Get-Process -ErrorAction SilentlyContinue) |
        Where-Object { $_.MainWindowTitle -eq $WindowTitle }
}

if (-not (Test-Path $BuildScript -PathType Leaf)) {
    throw "Build script not found: $BuildScript"
}

if (-not (Test-Path $ElectronExecutable -PathType Leaf)) {
    throw "Repository Electron executable not found: $ElectronExecutable. Run npm install first."
}

if (-not $Client -and -not $ClientWindow -and -not (Test-Path $DiagnosticEntry -PathType Leaf)) {
    throw "Electron diagnostic entry point not found: $DiagnosticEntry"
}

if ($ClientWindow -and -not (Test-Path $ClientWindowEntry -PathType Leaf)) {
    throw "Electron client-window entry point not found: $ClientWindowEntry"
}

$ExistingHosts = Get-Process -Name "d3d11_overlay_test_host" -ErrorAction SilentlyContinue
$ExactTitleHosts = @(Get-ExactTitleProcesses)
if ($ExistingHosts -or $ExactTitleHosts.Count -gt 0) {
    throw "Close the existing controlled host before starting this test. The injector uses the exact window title, and the runner verifies the launched host by PID."
}

Assert-NoOverlayIpcHost

$PreexistingElectronProcessIds = @(
    Get-DemoElectronProcessIds $ElectronCommandLineMarkers
)
if ($PreexistingElectronProcessIds.Count -gt 0) {
    throw "Close the existing Electron frame producer before starting this test. Matching PID(s): $($PreexistingElectronProcessIds -join ', ')"
}

if ($Client) {
    $NpmCommand = Get-Command "npm.cmd" -ErrorAction Stop
    Write-Host "Building the real Electron client..."

    Push-Location $RepoRoot
    try {
        & $NpmCommand.Source run build
        if ($LASTEXITCODE -ne 0) {
            throw "The real Electron client build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path $ClientBuiltEntry -PathType Leaf)) {
        throw "The client build completed without producing its main entry point: $ClientBuiltEntry"
    }
}

& $BuildScript

foreach ($Artifact in @($HostExecutable, $Injector, $Payload)) {
    if (-not (Test-Path $Artifact -PathType Leaf)) {
        throw "POC artifact not found after build: $Artifact"
    }
}

if ($Client) {
    New-Item -ItemType Directory -Path $ClientUserDataDirectory -Force | Out-Null
}

foreach ($LogPath in @($ElectronStdoutLog, $ElectronStderrLog)) {
    if (Test-Path $LogPath) {
        Remove-Item -LiteralPath $LogPath -Force
    }
}

$ElectronLauncherProcess = $null
$ElectronProcessIds = @()
$HostProcess = $null
$RunVerified = $false
$HostExitCode = 0

try {
    Assert-NoOverlayIpcHost

    $UnexpectedHosts = Get-Process -Name "d3d11_overlay_test_host" -ErrorAction SilentlyContinue
    $UnexpectedTitleHosts = @(Get-ExactTitleProcesses)
    if ($UnexpectedHosts -or $UnexpectedTitleHosts.Count -gt 0) {
        throw "A controlled host appeared before the runner launched its producer. Close it and retry."
    }

    $UnexpectedElectronProcessIds = @(
        Get-DemoElectronProcessIds $ElectronCommandLineMarkers
    )
    if ($UnexpectedElectronProcessIds.Count -gt 0) {
        throw "An Electron frame producer appeared before the runner launched its own instance. Matching PID(s): $($UnexpectedElectronProcessIds -join ', ')"
    }

    $ElectronLauncherProcess = Start-Process `
        -PassThru `
        -WorkingDirectory $RepoRoot `
        -FilePath $ElectronExecutable `
        -ArgumentList $ElectronArguments `
        -RedirectStandardOutput $ElectronStdoutLog `
        -RedirectStandardError $ElectronStderrLog

    $ElectronProcessIds = @($ElectronLauncherProcess.Id)

    $ElectronDeadline = [DateTime]::UtcNow.AddSeconds(30)
    $ElectronReady = $false
    do {
        Start-Sleep -Milliseconds 100

        $ElectronProcessIds = @(
            Update-LaunchedElectronProcessIds `
                $ElectronProcessIds `
                $PreexistingElectronProcessIds `
                $ElectronCommandLineMarkers
        )

        $ElectronOutput = Get-FileContent $ElectronStdoutLog
        $ElectronReady = $ElectronOutput.Contains($ElectronReadyMarker)
    } while (-not $ElectronReady -and [DateTime]::UtcNow -lt $ElectronDeadline)

    if (-not $ElectronReady) {
        throw "Timed out waiting for Electron readiness marker '$ElectronReadyMarker'. Logs: $ElectronStdoutLog and $ElectronStderrLog"
    }

    $ElectronProcessIds = @(
        Update-LaunchedElectronProcessIds `
            $ElectronProcessIds `
            $PreexistingElectronProcessIds `
            $ElectronCommandLineMarkers
    )
    $LiveElectronProcessIds = @(Get-LiveProcessIds $ElectronProcessIds)
    if ($LiveElectronProcessIds.Count -eq 0) {
        $ElectronError = Get-FileContent $ElectronStderrLog
        throw "Electron emitted its readiness marker, but no newly launched demo process remained alive. Stderr: $ElectronError"
    }

    $ExistingHosts = Get-Process -Name "d3d11_overlay_test_host" -ErrorAction SilentlyContinue
    $ExactTitleHosts = @(Get-ExactTitleProcesses)
    if ($ExistingHosts -or $ExactTitleHosts.Count -gt 0) {
        throw "A controlled host appeared before the runner launched its own instance. Close it and retry."
    }

    $HostProcess = Start-Process `
        -PassThru `
        -WorkingDirectory $RunDirectory `
        -FilePath $HostExecutable

    $HostDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 100
        $HostProcess.Refresh()

        if ($HostProcess.HasExited) {
            throw "The controlled host exited before injection with code $($HostProcess.ExitCode)."
        }
        $ElectronProcessIds = @(
            Update-LaunchedElectronProcessIds `
                $ElectronProcessIds `
                $PreexistingElectronProcessIds `
                $ElectronCommandLineMarkers
        )
        $LiveElectronProcessIds = @(Get-LiveProcessIds $ElectronProcessIds)
        if ($LiveElectronProcessIds.Count -eq 0) {
            throw "The Electron producer exited before injection."
        }
    } while ($HostProcess.MainWindowTitle -ne $WindowTitle -and [DateTime]::UtcNow -lt $HostDeadline)

    if ($HostProcess.MainWindowTitle -ne $WindowTitle) {
        throw "Timed out waiting for the controlled host window."
    }

    $PayloadLog = Join-Path $RunDirectory "hudhook_imgui_overlay_dx11-$($HostProcess.Id).log"
    if (Test-Path $PayloadLog) {
        Remove-Item -LiteralPath $PayloadLog -Force
    }

    & $Injector `
        --title $WindowTitle `
        --backend d3d11 `
        --dll $Payload

    if ($LASTEXITCODE -ne 0) {
        throw "The injector failed with exit code $LASTEXITCODE."
    }

    $ProofDeadline = [DateTime]::UtcNow.AddSeconds(30)
    $ObservedPayloadMarkers = @{}
    foreach ($Marker in $RequiredPayloadProofMarkers) {
        $ObservedPayloadMarkers[$Marker] = $false
    }
    $ObservedElectronMarkers = @{}
    foreach ($Marker in $RequiredElectronProofMarkers) {
        $ObservedElectronMarkers[$Marker] = $false
    }

    $HasAllPayloadMarkers = $false
    $HasAllElectronMarkers = $false
    do {
        Start-Sleep -Milliseconds 100
        $HostProcess.Refresh()

        if ($HostProcess.HasExited) {
            throw "The controlled host exited before mode '$ProducerMode' was verified."
        }
        $ElectronProcessIds = @(
            Update-LaunchedElectronProcessIds `
                $ElectronProcessIds `
                $PreexistingElectronProcessIds `
                $ElectronCommandLineMarkers
        )
        $LiveElectronProcessIds = @(Get-LiveProcessIds $ElectronProcessIds)
        if ($LiveElectronProcessIds.Count -eq 0) {
            throw "The Electron producer exited before mode '$ProducerMode' was verified."
        }

        $PayloadLogContent = Get-FileContent $PayloadLog
        foreach ($Marker in $RequiredPayloadProofMarkers) {
            if ($PayloadLogContent.Contains($Marker)) {
                $ObservedPayloadMarkers[$Marker] = $true
            }
        }

        $ElectronOutput = Get-FileContent $ElectronStdoutLog
        foreach ($Marker in $RequiredElectronProofMarkers) {
            if ($ElectronOutput.Contains($Marker)) {
                $ObservedElectronMarkers[$Marker] = $true
            }
        }

        $HasAllPayloadMarkers = $true
        foreach ($Marker in $RequiredPayloadProofMarkers) {
            if (-not $ObservedPayloadMarkers[$Marker]) {
                $HasAllPayloadMarkers = $false
                break
            }
        }

        $HasAllElectronMarkers = $true
        foreach ($Marker in $RequiredElectronProofMarkers) {
            if (-not $ObservedElectronMarkers[$Marker]) {
                $HasAllElectronMarkers = $false
                break
            }
        }
    } while (
        (-not $HasAllPayloadMarkers -or -not $HasAllElectronMarkers) -and
        [DateTime]::UtcNow -lt $ProofDeadline
    )

    if (-not $HasAllPayloadMarkers) {
        $MissingPayloadMarkers = @(
            foreach ($Marker in $RequiredPayloadProofMarkers) {
                if (-not $ObservedPayloadMarkers[$Marker]) {
                    $Marker
                }
            }
        )
        throw "Injection returned, but the PID-specific payload log is missing proof marker(s): $($MissingPayloadMarkers -join '; '). Log: $PayloadLog"
    }

    if (-not $HasAllElectronMarkers) {
        $MissingElectronMarkers = @(
            foreach ($Marker in $RequiredElectronProofMarkers) {
                if (-not $ObservedElectronMarkers[$Marker]) {
                    $Marker
                }
            }
        )
        throw "The Electron producer is missing lifecycle proof marker(s): $($MissingElectronMarkers -join '; '). Log: $ElectronStdoutLog"
    }

    $RunVerified = $true

    Write-Host ""
    Write-Host "Verified Electron-to-hudhook mode '$ProducerMode' in:"
    Write-Host "  $PayloadLog"
    Write-Host "Electron PID(s): $($LiveElectronProcessIds -join ', ')"
    Write-Host "Controlled host PID: $($HostProcess.Id)"
    Write-Host "Electron stdout: $ElectronStdoutLog"
    Write-Host "Electron stderr: $ElectronStderrLog"
    Write-Host "Expected result: $ExpectedResult"

    if ($Wait) {
        Write-Host "Press Escape in the host to finish; the runner will then stop only the Electron process it launched."

        while ($true) {
            Start-Sleep -Milliseconds 100
            $HostProcess.Refresh()

            if ($HostProcess.HasExited) {
                $HostExitCode = $HostProcess.ExitCode
                break
            }
            $ElectronProcessIds = @(
                Update-LaunchedElectronProcessIds `
                    $ElectronProcessIds `
                    $PreexistingElectronProcessIds `
                    $ElectronCommandLineMarkers
            )
            $LiveElectronProcessIds = @(Get-LiveProcessIds $ElectronProcessIds)
            if ($LiveElectronProcessIds.Count -eq 0) {
                throw "The Electron producer exited while the controlled host was still running."
            }
        }
    }
    else {
        Write-Host "This invocation is leaving both launched processes alive for visual inspection."
        Write-Host "Use -Wait on the next run to keep the runner attached and clean up Electron when the host exits."
    }
}
finally {
    if (-not $RunVerified -or $Wait) {
        Stop-LaunchedProcess $HostProcess "controlled host"
        Stop-LaunchedElectronProcesses `
            $ElectronProcessIds `
            $ElectronCommandLineMarkers
        Stop-LaunchedProcess $ElectronLauncherProcess "Electron launcher"
    }
}

if ($Wait) {
    exit $HostExitCode
}
