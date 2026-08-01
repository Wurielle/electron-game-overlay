[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d11", "d3d12")]
    [string]$Backend,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# Reuse the controlled-host build, process, log, and cleanup helpers without
# running the larger input gate.
. (Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1") `
    -Backend $Backend `
    -SkipBuild:$SkipBuild `
    -FunctionsOnly

$DrainBoundMilliseconds = 2000
$RunDirectory = Join-Path `
    $BuildRoot `
    "client-sdk-$Backend-target-surface-drain-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$TargetDirectory = Join-Path $RunDirectory "target"
$TargetExecutablePath = Join-Path $TargetDirectory $HostName
$UserData = Join-Path $RunDirectory "user-data"
$ClientStdout = Join-Path $RunDirectory "client.stdout.log"
$ClientStderr = Join-Path $RunDirectory "client.stderr.log"
$DestroyRequestPath = Join-Path `
    $TargetDirectory `
    "electron-game-overlay-destroy-final-surface.request"
$DestroyedAckPath = Join-Path `
    $TargetDirectory `
    "electron-game-overlay-final-surface-destroyed.ack"
$InjectionWaitPath = Join-Path `
    $TargetDirectory `
    "reshade-injection-wait.enabled"
$StartupBarrierPath = Join-Path `
    $TargetDirectory `
    "electron-game-overlay-startup-barrier.enabled"
$TargetDirectoryLog = Join-Path $TargetDirectory "ReShade.log"
$RuntimeDistribution = Join-Path $RuntimeRoot "dist\win32-x64"
$ResultMarker = "${BackendLabel}_REAL_CLIENT_SDK_TARGET_SURFACE_DRAIN_GATE_PASS"
$ClientProcess = $null
$HostProcess = $null
$HostWindow = [IntPtr]::Zero
$RunCompleted = $false
$Summary = $null

if (-not ("TargetSurfaceDrainGate.NativeMethods" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace TargetSurfaceDrainGate
{
    public static class NativeMethods
    {
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindow(IntPtr window);
    }
}
"@
}

function Get-FreeTcpPort {
    $Listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $Listener.Start()
        return ([Net.IPEndPoint]$Listener.LocalEndpoint).Port
    }
    finally {
        $Listener.Stop()
    }
}

function Wait-ForDevToolsPage {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $Endpoint = "http://127.0.0.1:$Port/json/list"
    while ([DateTime]::UtcNow -lt $Deadline) {
        try {
            $Response = Invoke-RestMethod -Uri $Endpoint -TimeoutSec 2
            $Page = @($Response.GetEnumerator()) |
                Where-Object {
                    $_.type -eq "page" -and
                    $_.title -eq "Electron Game Overlay Demo" -and
                    $_.webSocketDebuggerUrl
                } |
                Select-Object -First 1
            if ($Page) {
                return $Page
            }
        }
        catch {
            # Chromium may not have opened its debugging endpoint yet.
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The production Electron client exited before its frontend became inspectable."
        }
        Start-Sleep -Milliseconds 100
    }

    throw "Timed out waiting for the production client DevTools page at $Endpoint."
}

function Invoke-DevToolsExpression {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][string]$Expression,
        [int]$TimeoutMilliseconds = 750
    )

    $Socket = [Net.WebSockets.ClientWebSocket]::new()
    $Cancellation = [Threading.CancellationTokenSource]::new(
        [TimeSpan]::FromMilliseconds($TimeoutMilliseconds))
    try {
        [void]$Socket.ConnectAsync([Uri]$WebSocketUrl, $Cancellation.Token).
            GetAwaiter().GetResult()
        $Request = @{
            id = 1
            method = "Runtime.evaluate"
            params = @{
                expression = $Expression
                awaitPromise = $true
                returnByValue = $true
            }
        } | ConvertTo-Json -Depth 5 -Compress
        $Bytes = [Text.Encoding]::UTF8.GetBytes($Request)
        [void]$Socket.SendAsync(
            [ArraySegment[byte]]::new($Bytes),
            [Net.WebSockets.WebSocketMessageType]::Text,
            $true,
            $Cancellation.Token
        ).GetAwaiter().GetResult()

        while ($true) {
            $Stream = [IO.MemoryStream]::new()
            try {
                do {
                    $Buffer = [byte[]]::new(65536)
                    $Receive = $Socket.ReceiveAsync(
                        [ArraySegment[byte]]::new($Buffer),
                        $Cancellation.Token
                    ).GetAwaiter().GetResult()
                    if ($Receive.MessageType -eq
                        [Net.WebSockets.WebSocketMessageType]::Close) {
                        throw "The Electron DevTools socket closed before returning an evaluation result."
                    }
                    $Stream.Write($Buffer, 0, $Receive.Count)
                } while (-not $Receive.EndOfMessage)
                $ResponseText = [Text.Encoding]::UTF8.GetString($Stream.ToArray())
            }
            finally {
                $Stream.Dispose()
            }

            $Response = $ResponseText | ConvertFrom-Json
            if ($Response.id -ne 1) {
                continue
            }
            if ($Response.error) {
                throw "Electron DevTools rejected the evaluation: $($Response.error.message)"
            }
            if ($Response.result.exceptionDetails) {
                $Description = $Response.result.exceptionDetails.exception.description
                throw "Electron frontend evaluation failed: $Description"
            }
            return $Response.result.result.value
        }
    }
    finally {
        $Cancellation.Dispose()
        $Socket.Dispose()
    }
}

function Get-OverlayState {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [int]$TimeoutMilliseconds = 750
    )

    return Invoke-DevToolsExpression `
        -WebSocketUrl $WebSocketUrl `
        -TimeoutMilliseconds $TimeoutMilliseconds `
        -Expression @"
(async () => {
  const { ipcRenderer } = require('electron');
  const state = await ipcRenderer.invoke('overlay:get-state');
  return {
    targetSurface: state?.targetSurface ?? null,
    attachment: state?.attachment ?? null
  };
})()
"@
}

function Assert-ProcessesAlive {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Client,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    $Target.Refresh()
    $Client.Refresh()
    if ($Target.HasExited) {
        throw "The controlled target exited during $Stage."
    }
    if ($Client.HasExited) {
        throw "The production Electron client exited during $Stage."
    }
}

function Assert-ControlledWindowAlive {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Window,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    if ($Window -eq [IntPtr]::Zero -or
        -not [TargetSurfaceDrainGate.NativeMethods]::IsWindow($Window)) {
        throw "The controlled target HWND was destroyed during $Stage."
    }
}

function Wait-ForInitialTargetSurface {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][int]$ExpectedPid,
        [Parameter(Mandatory = $true)][string]$ExpectedHwnd,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)][IntPtr]$Window,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Client,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $LastState = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        Assert-ProcessesAlive -Target $Target -Client $Client -Stage "initial target-surface publication"
        Assert-ControlledWindowAlive `
            -Window $Window `
            -Stage "initial target-surface publication"
        try {
            $LastState = Get-OverlayState -WebSocketUrl $WebSocketUrl
            $Surface = $LastState.targetSurface
            if ($null -ne $Surface -and
                $Surface.pid -eq $ExpectedPid -and
                $Surface.graphicsApi -ceq $Backend -and
                $Surface.renderSize.width -eq 1280 -and
                $Surface.renderSize.height -eq 720 -and
                $Surface.surfaceId -match '^0x[1-9a-f][0-9a-f]{0,15}$' -and
                $Surface.hwnd -ceq $ExpectedHwnd -and
                $LastState.attachment.phase -ceq "connected" -and
                $LastState.attachment.pid -eq $ExpectedPid) {
                return $LastState
            }
        }
        catch {
            # The renderer may be between initial navigation and state publication.
        }
        Start-Sleep -Milliseconds 50
    }

    throw "Timed out waiting for the initial exact-PID target surface. Last state: $($LastState | ConvertTo-Json -Depth 8 -Compress)"
}

function Wait-ForDestructionAck {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)][IntPtr]$Window,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Client,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $AckObserved = $false
    $LastText = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        Assert-ProcessesAlive -Target $Target -Client $Client -Stage "final graphics-surface destruction"
        Assert-ControlledWindowAlive `
            -Window $Window `
            -Stage "final graphics-surface destruction"
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $AckObserved = $true
            try {
                $LastText = [IO.File]::ReadAllText($Path)
            }
            catch {
                $LastText = $null
            }
            if ($LastText -ceq "graphics-destroyed`n") {
                if ([DateTime]::UtcNow -gt $Deadline) {
                    break
                }
                return
            }
        }
        Start-Sleep -Milliseconds 10
    }

    if ($AckObserved) {
        throw "The controlled host did not finish a valid final-surface acknowledgement inside the $DrainBoundMilliseconds ms bound: $Path"
    }
    throw "The controlled host did not destroy its final graphics surface inside the $DrainBoundMilliseconds ms bound."
}

function Wait-ForDrainedTargetSurface {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][int]$ExpectedPid,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)][IntPtr]$Window,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Client,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $LastState = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        Assert-ProcessesAlive -Target $Target -Client $Client -Stage "explicit target-surface drain"
        Assert-ControlledWindowAlive `
            -Window $Window `
            -Stage "explicit target-surface drain"
        try {
            $RemainingMilliseconds = [Math]::Max(
                100,
                [int][Math]::Ceiling(($Deadline - [DateTime]::UtcNow).TotalMilliseconds))
            $LastState = Get-OverlayState `
                -WebSocketUrl $WebSocketUrl `
                -TimeoutMilliseconds ([Math]::Min(500, $RemainingMilliseconds))
            if ($null -eq $LastState.targetSurface -and
                $LastState.attachment.phase -ceq "connected" -and
                $LastState.attachment.pid -eq $ExpectedPid -and
                [DateTime]::UtcNow -le $Deadline) {
                return $LastState
            }
        }
        catch {
            # Retry within the single end-to-end deadline.
        }
        Start-Sleep -Milliseconds 25
    }

    throw "The SDK retained the final target surface beyond $DrainBoundMilliseconds ms. Last state: $($LastState | ConvertTo-Json -Depth 8 -Compress)"
}

$ExistingHosts = @(Get-MatchingHosts)
$ExistingClients = @(Get-MatchingClientProcesses)
$ExistingInjectors = @(Get-MatchingInjectors)
if ($ExistingHosts.Count -ne 0 -or
    $ExistingClients.Count -ne 0 -or
    $ExistingInjectors.Count -ne 0) {
    $ProcessIds = @(
        @($ExistingHosts.ProcessId) +
            @($ExistingClients.ProcessId) +
            @($ExistingInjectors.ProcessId) |
            Where-Object { $null -ne $_ }
    )
    throw "Close the existing controlled host/ReShade client run before this test (PID: $($ProcessIds -join ', '))."
}

if (-not $SkipBuild) {
    & $Nx run client:build
    if ($LASTEXITCODE -ne 0) {
        throw "The production client/SDK build failed with exit code $LASTEXITCODE."
    }

    Push-Location $RuntimeRoot
    try {
        & cmake.exe --preset vs2022-x64-production
        if ($LASTEXITCODE -ne 0) {
            throw "CMake configure failed with exit code $LASTEXITCODE."
        }
        & cmake.exe --build $ProductionBuildRoot `
            --config RelWithDebInfo `
            --target $HostTarget `
            --parallel
        if ($LASTEXITCODE -ne 0) {
            throw "The controlled $BackendLabel host build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

foreach ($RequiredFile in @(
        $BuiltHost,
        $Electron,
        (Join-Path $RuntimeDistribution "ReShade64.dll"),
        (Join-Path $RuntimeDistribution "inject.exe"),
        (Join-Path $RuntimeDistribution "electron_game_overlay.addon64"),
        (Join-Path $RuntimeDistribution "ReShade.ini"))) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "Required target-surface drain artifact is missing: $RequiredFile"
    }
}

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination $TargetExecutablePath
New-Item -ItemType File -Path $InjectionWaitPath -Force | Out-Null
New-Item -ItemType File -Path $StartupBarrierPath -Force | Out-Null

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

Write-Host ""
Write-Host "Production client/SDK $BackendLabel final target-surface drain gate"
Write-Host "  - The controlled host destroys its final swap chain/device but keeps its HWND and process alive."
Write-Host "  - The initial exact-PID surface must become null within $DrainBoundMilliseconds ms while target and Electron remain alive."
Write-Host "  - A process-disconnect notification cannot satisfy the gate."
Write-Host "  - Evidence is preserved in: $RunDirectory"
Write-Host ""

try {
    $DevToolsPort = Get-FreeTcpPort
    $ClientArguments = @(
        "`"$RepoRoot`"",
        "--no-sandbox",
        "--reshade-overlay",
        "`"--reshade-auto-target-process=$HostName`"",
        "--start-overlay-session",
        "--remote-debugging-port=$DevToolsPort",
        "--remote-allow-origins=*",
        "`"--user-data-dir=$UserData`""
    )
    $ClientProcess = Start-Process `
        -FilePath $Electron `
        -ArgumentList $ClientArguments `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $ClientStdout `
        -RedirectStandardError $ClientStderr

    $StartupDeadline = [DateTime]::UtcNow.AddSeconds(120)
    Wait-ForClientMarker `
        -Path $ClientStdout `
        -ClientProcess $ClientProcess `
        -Marker "RESHADE_CLIENT_INJECTOR_STARTED" `
        -Deadline $StartupDeadline
    $DevToolsPage = Wait-ForDevToolsPage `
        -Port $DevToolsPort `
        -Process $ClientProcess `
        -Deadline $StartupDeadline

    $HostProcess = Start-Process `
        -FilePath $TargetExecutablePath `
        -WorkingDirectory $TargetDirectory `
        -PassThru
    Wait-ForClientMarker `
        -Path $ClientStdout `
        -ClientProcess $ClientProcess `
        -Marker "RESHADE_CLIENT_INJECTOR_RETURNED" `
        -Deadline $StartupDeadline
    Remove-Item -LiteralPath $StartupBarrierPath -Force
    Remove-Item -LiteralPath $InjectionWaitPath -Force

    $StartupDeadline = [DateTime]::UtcNow.AddSeconds(120)
    $HostWindow = Wait-ForHostWindow `
        -HostProcess $HostProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    $ExpectedHwnd = "0x$($HostWindow.ToInt64().ToString(
            'x',
            [Globalization.CultureInfo]::InvariantCulture))"
    Wait-ForClientMarker `
        -Path $ClientStdout `
        -ClientProcess $ClientProcess `
        -Marker "RESHADE_CLIENT_TARGET_CONNECTED" `
        -Deadline $StartupDeadline

    $ClientLog = Get-ClientLogText -Path $ClientStdout
    $ConnectedPid = Get-ConnectedTargetProcessId -ClientLog $ClientLog
    if ($ConnectedPid -ne $HostProcess.Id) {
        throw "The client authenticated PID $ConnectedPid instead of controlled PID $($HostProcess.Id)."
    }
    $Target = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId=$ConnectedPid" `
        -ErrorAction SilentlyContinue
    if (-not $Target -or
        -not [string]::Equals(
            $Target.ExecutablePath,
            $TargetExecutablePath,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The authenticated target came from an unexpected path: $($Target.ExecutablePath)"
    }

    $ReShadeRunDirectory = Get-ReShadeRunDirectory -ClientLog $ClientLog
    $ReShadeLog = Join-Path $ReShadeRunDirectory "ReShade.log"
    $ReShadeRunDirectory |
        Set-Content `
            -LiteralPath (Join-Path $RunDirectory "reshade-run-directory.txt") `
            -Encoding UTF8
    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "rendered its first transported multi-window scene (2 window(s))." `
        -Deadline $StartupDeadline `
        -HostProcess $HostProcess

    $InitialState = Wait-ForInitialTargetSurface `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -ExpectedPid $ConnectedPid `
        -ExpectedHwnd $ExpectedHwnd `
        -Target $HostProcess `
        -Window $HostWindow `
        -Client $ClientProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))

    $BeforeDrainLog = Get-ClientLogText -Path $ClientStdout
    $DrainLogBoundary = $BeforeDrainLog.Length - 1
    $BeforeDrainReShadeLog = Get-Content -Raw -LiteralPath $ReShadeLog
    if ($null -eq $BeforeDrainReShadeLog) {
        $BeforeDrainReShadeLog = ""
    }
    $ReShadeDrainLogBoundary = $BeforeDrainReShadeLog.Length - 1
    $DrainRequestedUtc = [DateTime]::UtcNow
    $DrainStopwatch = [Diagnostics.Stopwatch]::StartNew()
    [IO.File]::WriteAllText(
        $DestroyRequestPath,
        "destroy`n",
        [Text.UTF8Encoding]::new($false))
    $DrainDeadline = $DrainRequestedUtc.AddMilliseconds($DrainBoundMilliseconds)

    Wait-ForDestructionAck `
        -Path $DestroyedAckPath `
        -Target $HostProcess `
        -Window $HostWindow `
        -Client $ClientProcess `
        -Deadline $DrainDeadline
    $AckElapsedMilliseconds = $DrainStopwatch.Elapsed.TotalMilliseconds
    $DrainedState = Wait-ForDrainedTargetSurface `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -ExpectedPid $ConnectedPid `
        -Target $HostProcess `
        -Window $HostWindow `
        -Client $ClientProcess `
        -Deadline $DrainDeadline
    $DrainElapsedMilliseconds = $DrainStopwatch.Elapsed.TotalMilliseconds
    $DrainStopwatch.Stop()
    if ($DrainElapsedMilliseconds -gt $DrainBoundMilliseconds) {
        throw "The SDK observed a null final target surface after the strict $DrainBoundMilliseconds ms bound."
    }

    Start-Sleep -Milliseconds 250
    Assert-ProcessesAlive `
        -Target $HostProcess `
        -Client $ClientProcess `
        -Stage "post-drain stability observation"
    Assert-ControlledWindowAlive `
        -Window $HostWindow `
        -Stage "post-drain stability observation"
    $StableState = Get-OverlayState `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl
    if ($null -ne $StableState.targetSurface -or
        $StableState.attachment.phase -cne "connected" -or
        $StableState.attachment.pid -ne $ConnectedPid) {
        throw "The drained target surface or connected live-target state did not remain stable: $($StableState | ConvertTo-Json -Depth 8 -Compress)"
    }

    $DrainClientLog = Get-ClientLogText -Path $ClientStdout
    $DrainTail = $DrainClientLog.Substring(
        [Math]::Min(
            $DrainClientLog.Length,
            [Math]::Max(0, $DrainLogBoundary + 1)))
    if ($DrainTail -match
        "(?m)^RESHADE_CLIENT_TARGET_DISCONNECTED pid=$ConnectedPid\r?$" ) {
        throw "A process-disconnect notification arrived before explicit target-surface drain acceptance."
    }

    $DrainReShadeLog = Get-Content -Raw -LiteralPath $ReShadeLog
    if ($null -eq $DrainReShadeLog) {
        $DrainReShadeLog = ""
    }
    $DrainReShadeTail = $DrainReShadeLog.Substring(
        [Math]::Min(
            $DrainReShadeLog.Length,
            [Math]::Max(0, $ReShadeDrainLogBoundary + 1)))
    if ($DrainReShadeTail.Contains(
            "Electron game overlay runtime final outbound transport drain failed")) {
        throw "The final outbound transport barrier failed even though the SDK observed the surface tombstone. Inspect $ReShadeLog."
    }

    if (Test-Path -LiteralPath $TargetDirectoryLog -PathType Leaf) {
        throw "The isolated target wrote an unexpected game-directory log: $TargetDirectoryLog"
    }

    $Summary = [pscustomobject]@{
        backend = $Backend
        targetPid = $ConnectedPid
        electronPid = $ClientProcess.Id
        targetHwnd = $ExpectedHwnd
        initialTargetSurface = $InitialState.targetSurface
        drainedTargetSurface = $DrainedState.targetSurface
        attachmentAfterDrain = $DrainedState.attachment
        drainBoundMilliseconds = $DrainBoundMilliseconds
        graphicsDestroyedAckMilliseconds = [Math]::Round($AckElapsedMilliseconds, 3)
        targetSurfaceNullMilliseconds = [Math]::Round($DrainElapsedMilliseconds, 3)
        targetAliveAtAcceptance = -not $HostProcess.HasExited
        targetWindowAliveAtAcceptance =
            [TargetSurfaceDrainGate.NativeMethods]::IsWindow($HostWindow)
        electronAliveAtAcceptance = -not $ClientProcess.HasExited
        processDisconnectObservedBeforeAcceptance = $false
        transportDrainFailureObserved = $false
        requestPath = $DestroyRequestPath
        acknowledgementPath = $DestroyedAckPath
        reshadeRunDirectory = $ReShadeRunDirectory
    }
    $null = $HostProcess.CloseMainWindow()
    if (-not $HostProcess.WaitForExit(10000)) {
        throw "The surface-less controlled host did not close normally."
    }
    $HostProcess.WaitForExit()
    $HostProcess.Refresh()
    if ($HostProcess.ExitCode -ne 0) {
        throw "The surface-less controlled host exited with code $($HostProcess.ExitCode)."
    }
    $RunCompleted = $true
}
finally {
    Stop-AttemptElectronProcesses -UserData $UserData

    if ($HostProcess) {
        $HostProcess.Refresh()
        if (-not $HostProcess.HasExited) {
            $null = $HostProcess.CloseMainWindow()
            Wait-Process -Id $HostProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
            $HostProcess.Refresh()
            if (-not $HostProcess.HasExited) {
                Stop-Process -Id $HostProcess.Id -Force -ErrorAction SilentlyContinue
                Wait-Process -Id $HostProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
            }
        }
    }
    Get-MatchingInjectors |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $_.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        }
    foreach ($VariableName in $ControlledEnvironmentVariables) {
        [Environment]::SetEnvironmentVariable(
            $VariableName,
            $PreviousEnvironment[$VariableName],
            "Process")
    }
}

if (-not $RunCompleted) {
    throw "The $BackendLabel target-surface drain gate did not complete."
}

$RemainingHosts = @(Get-MatchingHosts)
$RemainingClients = @(Get-MatchingClientProcesses)
$RemainingInjectors = @(Get-MatchingInjectors)
if ($RemainingHosts.Count -ne 0 -or
    $RemainingClients.Count -ne 0 -or
    $RemainingInjectors.Count -ne 0) {
    throw "The target-surface drain gate left controlled processes running."
}

$Summary |
    ConvertTo-Json -Depth 10 |
    Set-Content -LiteralPath (Join-Path $RunDirectory "summary.json") -Encoding UTF8
$ResultMarker |
    Set-Content -LiteralPath (Join-Path $RunDirectory "result.txt") -Encoding UTF8
Write-Host $ResultMarker
Write-Host "Evidence preserved in: $RunDirectory"
