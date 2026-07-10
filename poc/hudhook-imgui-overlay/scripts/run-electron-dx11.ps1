[CmdletBinding()]
param(
    [switch]$Wait
)

$ErrorActionPreference = "Stop"
$env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL"

# Keep these strings synchronized with electron-demo/main.cjs and the Rust bridge.
$ElectronReadyMarker = "HUDHOOK_ELECTRON_DEMO_READY"
$BridgeProofMarkers = @(
    "Electron frame received from node-game-overlay",
    "Electron frame uploaded to GPU"
)

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$HudhookRoot = Split-Path -Parent $PSScriptRoot
$BuildScript = Join-Path $PSScriptRoot "build-dx11.ps1"
$RunDirectory = Join-Path $RepoRoot "build\hudhook-imgui-overlay\run\dx11"
$HostExecutable = Join-Path $RunDirectory "d3d11_overlay_test_host.exe"
$Injector = Join-Path $RunDirectory "hudhook_overlay_injector.exe"
$Payload = Join-Path $RunDirectory "hudhook_imgui_overlay_dx11.dll"
$ElectronExecutable = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
$ElectronEntry = Join-Path $HudhookRoot "electron-demo\main.cjs"
$ElectronAppDirectory = Split-Path -Parent $ElectronEntry
$ElectronCommandLineMarker = $ElectronAppDirectory
$ElectronStdoutLog = Join-Path $RunDirectory "electron-demo.stdout.log"
$ElectronStderrLog = Join-Path $RunDirectory "electron-demo.stderr.log"
$WindowTitle = "Controlled D3D11 overlay test host"

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
        [string]$CommandLineMarker
    )

    $Processes = Get-CimInstance `
        -ClassName Win32_Process `
        -Filter "Name = 'electron.exe'" `
        -ErrorAction Stop

    foreach ($Candidate in $Processes) {
        if (
            $Candidate.CommandLine -and
            $Candidate.CommandLine.IndexOf(
                $CommandLineMarker,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0
        ) {
            $Candidate
        }
    }
}

function Get-DemoElectronProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandLineMarker
    )

    foreach ($Candidate in @(Get-DemoElectronProcesses $CommandLineMarker)) {
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
        [string]$CommandLineMarker
    )

    $DiscoveredProcessIds = @(
        Get-DemoElectronProcessIds $CommandLineMarker |
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
        [string]$CommandLineMarker
    )

    $CapturedIds = @($ProcessIds | Sort-Object -Unique)

    # Re-check every stored PID's command line before acting on it. This avoids
    # touching an unrelated process if Windows reused an exited demo PID.
    $CapturedMatches = @(
        Get-DemoElectronProcesses $CommandLineMarker |
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
        $CurrentMatchingIds = @(Get-DemoElectronProcessIds $CommandLineMarker)
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
    $CurrentMatchingIds = @(Get-DemoElectronProcessIds $CommandLineMarker)
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

if (-not (Test-Path $BuildScript -PathType Leaf)) {
    throw "Build script not found: $BuildScript"
}

if (-not (Test-Path $ElectronExecutable -PathType Leaf)) {
    throw "Repository Electron executable not found: $ElectronExecutable. Run npm install first."
}

if (-not (Test-Path $ElectronEntry -PathType Leaf)) {
    throw "Electron demo entry point not found: $ElectronEntry"
}

$ExistingHosts = Get-Process -Name "d3d11_overlay_test_host" -ErrorAction SilentlyContinue
if ($ExistingHosts) {
    throw "Close the existing controlled host before starting this test. The injector uses the exact window title, and the runner verifies the launched host by PID."
}

$PreexistingElectronProcessIds = @(
    Get-DemoElectronProcessIds $ElectronCommandLineMarker
)
if ($PreexistingElectronProcessIds.Count -gt 0) {
    throw "Close the existing Electron frame producer before starting this test. Matching PID(s): $($PreexistingElectronProcessIds -join ', ')"
}

& $BuildScript

foreach ($Artifact in @($HostExecutable, $Injector, $Payload)) {
    if (-not (Test-Path $Artifact -PathType Leaf)) {
        throw "POC artifact not found after build: $Artifact"
    }
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
    $UnexpectedElectronProcessIds = @(
        Get-DemoElectronProcessIds $ElectronCommandLineMarker
    )
    if ($UnexpectedElectronProcessIds.Count -gt 0) {
        throw "An Electron frame producer appeared before the runner launched its own instance. Matching PID(s): $($UnexpectedElectronProcessIds -join ', ')"
    }

    $ElectronLauncherProcess = Start-Process `
        -PassThru `
        -WorkingDirectory $RepoRoot `
        -FilePath $ElectronExecutable `
        -ArgumentList @($ElectronAppDirectory) `
        -RedirectStandardOutput $ElectronStdoutLog `
        -RedirectStandardError $ElectronStderrLog

    $ElectronDeadline = [DateTime]::UtcNow.AddSeconds(15)
    $ElectronReady = $false
    do {
        Start-Sleep -Milliseconds 100

        $ElectronProcessIds = @(
            Update-LaunchedElectronProcessIds `
                $ElectronProcessIds `
                $PreexistingElectronProcessIds `
                $ElectronCommandLineMarker
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
            $ElectronCommandLineMarker
    )
    $LiveElectronProcessIds = @(Get-LiveProcessIds $ElectronProcessIds)
    if ($LiveElectronProcessIds.Count -eq 0) {
        $ElectronError = Get-FileContent $ElectronStderrLog
        throw "Electron emitted its readiness marker, but no newly launched demo process remained alive. Stderr: $ElectronError"
    }

    $ExistingHosts = Get-Process -Name "d3d11_overlay_test_host" -ErrorAction SilentlyContinue
    if ($ExistingHosts) {
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
                $ElectronCommandLineMarker
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

    $ProofDeadline = [DateTime]::UtcNow.AddSeconds(15)
    $ObservedMarkers = @{}
    foreach ($Marker in $BridgeProofMarkers) {
        $ObservedMarkers[$Marker] = $false
    }

    do {
        Start-Sleep -Milliseconds 100
        $HostProcess.Refresh()

        if ($HostProcess.HasExited) {
            throw "The controlled host exited before the Electron frame bridge was verified."
        }
        $ElectronProcessIds = @(
            Update-LaunchedElectronProcessIds `
                $ElectronProcessIds `
                $PreexistingElectronProcessIds `
                $ElectronCommandLineMarker
        )
        $LiveElectronProcessIds = @(Get-LiveProcessIds $ElectronProcessIds)
        if ($LiveElectronProcessIds.Count -eq 0) {
            throw "The Electron producer exited before the Electron frame bridge was verified."
        }

        $PayloadLogContent = Get-FileContent $PayloadLog
        foreach ($Marker in $BridgeProofMarkers) {
            if ($PayloadLogContent.Contains($Marker)) {
                $ObservedMarkers[$Marker] = $true
            }
        }

        $HasAllMarkers = $true
        foreach ($Marker in $BridgeProofMarkers) {
            if (-not $ObservedMarkers[$Marker]) {
                $HasAllMarkers = $false
                break
            }
        }
    } while (-not $HasAllMarkers -and [DateTime]::UtcNow -lt $ProofDeadline)

    if (-not $HasAllMarkers) {
        $MissingMarkers = @(
            foreach ($Marker in $BridgeProofMarkers) {
                if (-not $ObservedMarkers[$Marker]) {
                    $Marker
                }
            }
        )
        throw "Injection returned, but the PID-specific payload log is missing bridge proof marker(s): $($MissingMarkers -join '; '). Log: $PayloadLog"
    }

    $RunVerified = $true

    Write-Host ""
    Write-Host "Verified Electron-to-hudhook frame delivery and GPU upload in:"
    Write-Host "  $PayloadLog"
    Write-Host "Electron PID(s): $($LiveElectronProcessIds -join ', ')"
    Write-Host "Controlled host PID: $($HostProcess.Id)"
    Write-Host "Electron stdout: $ElectronStdoutLog"
    Write-Host "Electron stderr: $ElectronStderrLog"
    Write-Host "Expected result: the Electron demo window is rendered inside the controlled D3D11 host."

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
                    $ElectronCommandLineMarker
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
            $ElectronCommandLineMarker
        Stop-LaunchedProcess $ElectronLauncherProcess "Electron launcher"
    }
}

if ($Wait) {
    exit $HostExitCode
}
