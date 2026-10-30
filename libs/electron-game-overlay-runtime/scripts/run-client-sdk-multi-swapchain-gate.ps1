[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d11", "d3d12")]
    [string]$Backend,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# Reuse the production client/SDK, controlled-host, process, log, and cleanup
# helpers without running the larger interactive input gate.
. (Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1") `
    -Backend $Backend `
    -SkipBuild:$SkipBuild `
    -FunctionsOnly

$ReleasePrimaryFallbackMilliseconds = 300000
$StableObservationMilliseconds = 1250
$RunDirectory = Join-Path `
    $BuildRoot `
    "client-sdk-$Backend-multi-swapchain-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$TargetDirectory = Join-Path $RunDirectory "target"
$TargetExecutablePath = Join-Path $TargetDirectory $HostName
$UserData = Join-Path $RunDirectory "user-data"
$ClientStdout = Join-Path $RunDirectory "client.stdout.log"
$ClientStderr = Join-Path $RunDirectory "client.stderr.log"
$HostStdout = Join-Path $RunDirectory "host.stdout.log"
$HostStderr = Join-Path $RunDirectory "host.stderr.log"
$DestroyPrimarySurfaceRequestPath = Join-Path `
    $TargetDirectory `
    "electron-game-overlay-destroy-primary-surface.request"
$InputGatePath = Join-Path $TargetDirectory "reshade-input-gate.enabled"
$InjectionWaitPath = Join-Path `
    $TargetDirectory `
    "reshade-injection-wait.enabled"
$StartupBarrierPath = Join-Path `
    $TargetDirectory `
    "electron-game-overlay-startup-barrier.enabled"
$TargetDirectoryLog = Join-Path $TargetDirectory "ReShade.log"
$RuntimeDistribution = Join-Path $RuntimeRoot "dist\win32-x64"
$ResultMarker = "${BackendLabel}_REAL_CLIENT_SDK_MULTI_SWAPCHAIN_GATE_PASS"
$SharedGraphicsResourceMarker = if ($Backend -eq "d3d11") {
    "sharedContextAlive"
}
else {
    "sharedQueueAlive"
}
$ClientProcess = $null
$HostProcess = $null
$PrimaryWindow = [IntPtr]::Zero
$SecondaryWindow = [IntPtr]::Zero
$RunCompleted = $false
$Summary = $null

if (-not ("MultiSwapchainClientSdkGate.NativeMethods" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace MultiSwapchainClientSdkGate
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
    targetSurfaces: Array.isArray(state?.targetSurfaces)
      ? state.targetSurfaces
      : [],
    latestOverlayFps: state?.latestOverlayFps ?? null,
    overlayFpsEventCount: state?.overlayFpsEventCount ?? null,
    inputInterceptRequested: state?.inputInterceptRequested ?? null,
    inputInterceptEffective: state?.inputInterceptEffective ?? null,
    attachment: state?.attachment ?? null
  };
})()
"@
}

function Get-HostLogText {
    if (-not (Test-Path -LiteralPath $HostStdout -PathType Leaf)) {
        return ""
    }
    $Text = Get-Content -Raw -LiteralPath $HostStdout
    if ($null -eq $Text) {
        return ""
    }
    return $Text
}

function Convert-HexWindow {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value -notmatch '^0x[1-9a-f][0-9a-f]{0,15}$') {
        throw "The controlled host published an invalid HWND: $Value"
    }
    return [IntPtr]::new(
        [int64][Convert]::ToUInt64($Value.Substring(2), 16))
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

function Assert-InputInterceptState {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][bool]$Requested,
        [Parameter(Mandatory = $true)][bool]$Effective,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    if ($State.inputInterceptRequested -cne $Requested -or
        $State.inputInterceptEffective -cne $Effective) {
        throw "Unexpected demo input state during $Stage`: requested=$($State.inputInterceptRequested) effective=$($State.inputInterceptEffective)."
    }
}

function Assert-ControlledWindowsAlive {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Primary,
        [Parameter(Mandatory = $true)][IntPtr]$Secondary,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    if ($Primary -eq [IntPtr]::Zero -or
        -not [MultiSwapchainClientSdkGate.NativeMethods]::IsWindow($Primary)) {
        throw "The controlled primary HWND was destroyed during $Stage."
    }
    if ($Secondary -eq [IntPtr]::Zero -or
        -not [MultiSwapchainClientSdkGate.NativeMethods]::IsWindow($Secondary)) {
        throw "The controlled secondary HWND was destroyed during $Stage."
    }
}

function Assert-NoTargetDisconnect {
    param(
        [Parameter(Mandatory = $true)][int]$ExpectedPid,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    $ClientLog = Get-ClientLogText -Path $ClientStdout
    if ($null -ne $ClientLog -and
        $ClientLog -match
            "(?m)^RESHADE_CLIENT_TARGET_DISCONNECTED pid=$ExpectedPid\r?$") {
        throw "A target-process disconnect was observed during $Stage."
    }
}

function Wait-ForHostLogMatch {
    param(
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Marker,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Client,
        [Parameter(Mandatory = $true)][DateTime]$Deadline,
        [IntPtr]$Primary = [IntPtr]::Zero,
        [IntPtr]$Secondary = [IntPtr]::Zero
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        Assert-ProcessesAlive -Target $Target -Client $Client -Stage "host marker '$Marker'"
        if ($Primary -ne [IntPtr]::Zero -or $Secondary -ne [IntPtr]::Zero) {
            Assert-ControlledWindowsAlive `
                -Primary $Primary `
                -Secondary $Secondary `
                -Stage "host marker '$Marker'"
        }

        $HostLog = Get-HostLogText
        $Matches = [regex]::Matches($HostLog, $Pattern)
        if ($Matches.Count -gt 1) {
            throw "The controlled host published marker '$Marker' more than once."
        }
        if ($Matches.Count -eq 1) {
            return $Matches[0]
        }
        Start-Sleep -Milliseconds 25
    }

    throw "Timed out waiting for controlled-host marker '$Marker'. Inspect $HostStdout."
}

function Get-ReShadeMarkerCount {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Marker
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return 0
    }
    $Text = Get-Content -Raw -LiteralPath $Path
    return ([regex]::Matches($Text, [regex]::Escape($Marker))).Count
}

function Wait-ForClientMarkerCount {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Marker,
        [Parameter(Mandatory = $true)][int]$ExpectedCount,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Client,
        [Parameter(Mandatory = $true)][DateTime]$Deadline,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        $Text = Get-ClientLogText -Path $Path
        $Count = ([regex]::Matches($Text, [regex]::Escape($Marker))).Count
        if ($Count -gt $ExpectedCount) {
            throw "Found $Count '$Marker' marker(s) during $Stage; expected $ExpectedCount."
        }
        if ($Count -eq $ExpectedCount) {
            return $Count
        }

        $Client.Refresh()
        if ($Client.HasExited) {
            throw "The production Electron client exited during $Stage."
        }
        Start-Sleep -Milliseconds 25
    }

    $Text = Get-ClientLogText -Path $Path
    $FinalCount = ([regex]::Matches($Text, [regex]::Escape($Marker))).Count
    throw "Timed out waiting for $ExpectedCount '$Marker' marker(s) during $Stage; found $FinalCount."
}

function Wait-ForStableReShadeMarkerCount {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Marker,
        [Parameter(Mandatory = $true)][int]$ExpectedCount,
        [Parameter(Mandatory = $true)][int]$StableMilliseconds,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Client,
        [Parameter(Mandatory = $true)][IntPtr]$Primary,
        [Parameter(Mandatory = $true)][IntPtr]$Secondary,
        [Parameter(Mandatory = $true)][DateTime]$Deadline,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    $StableSince = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        Assert-ProcessesAlive -Target $Target -Client $Client -Stage $Stage
        Assert-ControlledWindowsAlive `
            -Primary $Primary `
            -Secondary $Secondary `
            -Stage $Stage

        $Count = Get-ReShadeMarkerCount -Path $Path -Marker $Marker
        if ($Count -gt $ExpectedCount) {
            throw "Found $Count compositor marker(s) during $Stage; expected exactly $ExpectedCount."
        }
        if ($Count -eq $ExpectedCount) {
            if ($null -eq $StableSince) {
                $StableSince = [DateTime]::UtcNow
            }
            elseif (([DateTime]::UtcNow - $StableSince).TotalMilliseconds -ge
                $StableMilliseconds) {
                return $Count
            }
        }
        else {
            $StableSince = $null
        }
        Start-Sleep -Milliseconds 25
    }

    $FinalCount = Get-ReShadeMarkerCount -Path $Path -Marker $Marker
    throw "Timed out waiting for exactly $ExpectedCount stable compositor marker(s) during $Stage; found $FinalCount. Inspect $Path."
}

function Invoke-InterceptedTextInputProof {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$TargetWindow,
        [Parameter(Mandatory = $true)][IntPtr]$OracleWindow,
        [Parameter(Mandatory = $true)]$TargetCenter,
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$ExpectedValue,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow(
            $TargetWindow)) {
        throw "The expected target HWND was not foreground during $Stage."
    }
    $BaselineTitle = Wait-ForStableHostTitle `
        -Window $OracleWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    if (-not $BaselineTitle.Contains("clip=off")) {
        throw "Cursor confinement remained active during $Stage`: $BaselineTitle"
    }

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $TargetCenter.X,
        $TargetCenter.Y)
    Start-Sleep -Milliseconds 100
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText($Text)
    $ValueMarker = "HUDHOOK_CLIENT_INPUT_VALUE value=$ExpectedValue"
    Wait-ForClientMarker `
        -Path $ClientStdout `
        -ClientProcess $ClientProcess `
        -Marker $ValueMarker `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Start-Sleep -Milliseconds 500

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow(
            $TargetWindow)) {
        throw "An Electron backing window stole foreground ownership during $Stage."
    }
    $InterceptedTitle =
        [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($OracleWindow)
    if ($InterceptedTitle -ne $BaselineTitle) {
        throw "The game input oracle changed during $Stage.`nBefore: $BaselineTitle`nAfter:  $InterceptedTitle"
    }

    return [pscustomobject]@{
        stage = $Stage
        targetHwnd = "0x$($TargetWindow.ToInt64().ToString('x'))"
        valueMarker = $ValueMarker
        oracleTitle = $InterceptedTitle
    }
}

function Assert-AdvertisedSurfaceState {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][int]$ExpectedPid,
        [Parameter(Mandatory = $true)][string]$ExpectedHwnd,
        [Parameter(Mandatory = $true)][int]$ExpectedWidth,
        [Parameter(Mandatory = $true)][int]$ExpectedHeight,
        [Parameter(Mandatory = $true)][long]$MinimumFpsEventCount,
        [string]$ExcludedSurfaceId = ""
    )

    $Surfaces = @($State.targetSurfaces)
    if ($Surfaces.Count -ne 1) {
        throw "Expected exactly one advertised process-primary surface, found $($Surfaces.Count)."
    }
    $Surface = $Surfaces[0]
    if ($null -eq $State.targetSurface -or
        $State.targetSurface.surfaceId -cne $Surface.surfaceId) {
        throw "The demo's selected target is not the sole advertised surface."
    }
    if ($Surface.pid -ne $ExpectedPid -or
        $Surface.graphicsApi -cne $Backend -or
        $Surface.hwnd -cne $ExpectedHwnd -or
        $Surface.renderSize.width -ne $ExpectedWidth -or
        $Surface.renderSize.height -ne $ExpectedHeight -or
        $Surface.surfaceId -notmatch '^0x[1-9a-f][0-9a-f]{0,15}$') {
        throw "The advertised surface does not match the expected exact-PID $Backend target."
    }
    if ($ExcludedSurfaceId -and $Surface.surfaceId -ceq $ExcludedSurfaceId) {
        throw "The post-release surface retained the destroyed primary surface identity."
    }
    if ($State.attachment.phase -cne "connected" -or
        $State.attachment.pid -ne $ExpectedPid) {
        throw "The production client attachment is not connected to PID $ExpectedPid."
    }
    if ($null -eq $State.latestOverlayFps -or
        [double]$State.latestOverlayFps -le 0) {
        throw "The advertised surface has no fresh positive process-primary FPS sample."
    }
    if ($null -eq $State.overlayFpsEventCount -or
        [long]$State.overlayFpsEventCount -lt $MinimumFpsEventCount) {
        throw "The process-primary FPS event count is not fresh enough."
    }
}

function Wait-ForAdvertisedSurface {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][int]$ExpectedPid,
        [Parameter(Mandatory = $true)][string]$ExpectedHwnd,
        [Parameter(Mandatory = $true)][int]$ExpectedWidth,
        [Parameter(Mandatory = $true)][int]$ExpectedHeight,
        [Parameter(Mandatory = $true)][long]$MinimumFpsEventCount,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Client,
        [Parameter(Mandatory = $true)][IntPtr]$Primary,
        [Parameter(Mandatory = $true)][IntPtr]$Secondary,
        [Parameter(Mandatory = $true)][DateTime]$Deadline,
        [Parameter(Mandatory = $true)][string]$Stage,
        [string]$ExcludedSurfaceId = ""
    )

    $LastState = $null
    $LastFailure = "state was not available"
    while ([DateTime]::UtcNow -lt $Deadline) {
        Assert-ProcessesAlive -Target $Target -Client $Client -Stage $Stage
        Assert-ControlledWindowsAlive `
            -Primary $Primary `
            -Secondary $Secondary `
            -Stage $Stage
        Assert-NoTargetDisconnect -ExpectedPid $ExpectedPid -Stage $Stage
        try {
            $LastState = Get-OverlayState -WebSocketUrl $WebSocketUrl
            Assert-AdvertisedSurfaceState `
                -State $LastState `
                -ExpectedPid $ExpectedPid `
                -ExpectedHwnd $ExpectedHwnd `
                -ExpectedWidth $ExpectedWidth `
                -ExpectedHeight $ExpectedHeight `
                -MinimumFpsEventCount $MinimumFpsEventCount `
                -ExcludedSurfaceId $ExcludedSurfaceId
            return $LastState
        }
        catch {
            $LastFailure = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 50
    }

    throw "Timed out waiting for $Stage. Last failure: $LastFailure Last state: $($LastState | ConvertTo-Json -Depth 10 -Compress)"
}

if (-not (Test-Path -LiteralPath $Electron -PathType Leaf)) {
    throw "Electron is unavailable: $Electron"
}
if (-not (Test-Path -LiteralPath $Nx -PathType Leaf)) {
    throw "The local Nx CLI is unavailable: $Nx"
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
        throw "The production client/SDK/runtime build failed with exit code $LASTEXITCODE."
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
        throw "Required multi-swap-chain artifact is missing: $RequiredFile"
    }
}

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination $TargetExecutablePath
New-Item -ItemType File -Path $InputGatePath -Force | Out-Null
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
Write-Host "Production client/SDK $BackendLabel multi-swap-chain gate"
Write-Host "  - One exact-PID target creates primary 1280x720 and secondary 960x540 swap chains."
Write-Host "  - The native runtime must advertise only the current process primary and publish its FPS."
Write-Host "  - The gate requests primary graphics release only after accepting the initial surface/FPS state."
Write-Host "  - A $ReleasePrimaryFallbackMilliseconds ms host delay remains only as a safety fallback."
Write-Host "  - Electron input and game-input blocking must follow primary ownership across failover."
Write-Host "  - The SDK must fail over to a composing secondary surface with sustained FPS and no disconnect."
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

    $HostArguments = @(
        "--multi-swapchain",
        "--release-primary-after-ms=$ReleasePrimaryFallbackMilliseconds"
    )
    $HostProcess = Start-Process `
        -FilePath $TargetExecutablePath `
        -ArgumentList $HostArguments `
        -WorkingDirectory $TargetDirectory `
        -PassThru `
        -RedirectStandardOutput $HostStdout `
        -RedirectStandardError $HostStderr
    # Start-Process may otherwise defer opening its query handle until after a
    # fast GUI shutdown, making ExitCode unavailable even after WaitForExit.
    $null = $HostProcess.Handle
    Wait-ForClientMarker `
        -Path $ClientStdout `
        -ClientProcess $ClientProcess `
        -Marker "RESHADE_CLIENT_INJECTOR_RETURNED" `
        -Deadline $StartupDeadline
    Remove-Item -LiteralPath $StartupBarrierPath -Force
    Remove-Item -LiteralPath $InjectionWaitPath -Force

    $ReadyPattern =
        "(?m)^EGO_CONTROLLED_HOST_MULTI_SWAPCHAIN_READY " +
        "backend=$Backend pid=(?<pid>\d+) " +
        "primaryHwnd=(?<primary>0x[1-9a-f][0-9a-f]{0,15}) " +
        "secondaryHwnd=(?<secondary>0x[1-9a-f][0-9a-f]{0,15}) " +
        "releasePrimaryAfterMs=(?<delay>\d+) " +
        "foregroundHwnd=(?<foreground>0x[0-9a-f]{1,16}) " +
        "primaryForeground=(?<primaryForeground>true|false)\r?$"
    $Ready = Wait-ForHostLogMatch `
        -Pattern $ReadyPattern `
        -Marker "EGO_CONTROLLED_HOST_MULTI_SWAPCHAIN_READY" `
        -Target $HostProcess `
        -Client $ClientProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(30))
    if ([int]$Ready.Groups['pid'].Value -ne $HostProcess.Id -or
        [long]$Ready.Groups['delay'].Value -ne
            $ReleasePrimaryFallbackMilliseconds) {
        throw "The controlled host's multi-swap-chain readiness identity is invalid."
    }

    $PrimaryHwnd = $Ready.Groups['primary'].Value
    $SecondaryHwnd = $Ready.Groups['secondary'].Value
    if ($PrimaryHwnd -ceq $SecondaryHwnd) {
        throw "The controlled host reused one HWND for both swap chains."
    }
    if ($Ready.Groups['primaryForeground'].Value -cne "true" -or
        $Ready.Groups['foreground'].Value -cne $PrimaryHwnd) {
        throw "The controlled host did not keep the initial primary HWND in the foreground."
    }
    $PrimaryWindow = Convert-HexWindow -Value $PrimaryHwnd
    $SecondaryWindow = Convert-HexWindow -Value $SecondaryHwnd
    Assert-ControlledWindowsAlive `
        -Primary $PrimaryWindow `
        -Secondary $SecondaryWindow `
        -Stage "multi-swap-chain readiness"
    $MainHostWindow = Wait-ForHostWindow `
        -HostProcess $HostProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(5))
    if ($MainHostWindow -ne $PrimaryWindow) {
        throw "The controlled host's main HWND is not its advertised primary HWND."
    }

    $PresentingPattern =
        "(?m)^EGO_CONTROLLED_HOST_MULTI_SWAPCHAIN_PRESENTING " +
        "backend=$Backend primaryPresentCount=(?<primary>\d+) " +
        "secondaryPresentCount=(?<secondary>\d+) " +
        "foregroundHwnd=(?<foreground>0x[0-9a-f]{1,16}) " +
        "primaryForeground=(?<primaryForeground>true|false)\r?$"
    $Presenting = Wait-ForHostLogMatch `
        -Pattern $PresentingPattern `
        -Marker "EGO_CONTROLLED_HOST_MULTI_SWAPCHAIN_PRESENTING" `
        -Target $HostProcess `
        -Client $ClientProcess `
        -Primary $PrimaryWindow `
        -Secondary $SecondaryWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15))
    if ([long]$Presenting.Groups['primary'].Value -le 0 -or
        [long]$Presenting.Groups['secondary'].Value -le 0 -or
        $Presenting.Groups['primaryForeground'].Value -cne "true" -or
        $Presenting.Groups['foreground'].Value -cne $PrimaryHwnd) {
        throw "The controlled host did not present both swap chains."
    }

    $StartupDeadline = [DateTime]::UtcNow.AddSeconds(120)
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
    $InitialState = Wait-ForAdvertisedSurface `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -ExpectedPid $ConnectedPid `
        -ExpectedHwnd $PrimaryHwnd `
        -ExpectedWidth 1280 `
        -ExpectedHeight 720 `
        -MinimumFpsEventCount 1 `
        -Target $HostProcess `
        -Client $ClientProcess `
        -Primary $PrimaryWindow `
        -Secondary $SecondaryWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20)) `
        -Stage "initial primary surface and FPS publication"
    $InitialSurfaceId = $InitialState.targetSurface.surfaceId
    $InitialFpsEventCount = [long]$InitialState.overlayFpsEventCount

    $CompositionMarker =
        "rendered its first transported multi-window scene (2 window(s))."
    $InitialCompositionMarkerCount = Wait-ForStableReShadeMarkerCount `
        -Path $ReShadeLog `
        -Marker $CompositionMarker `
        -ExpectedCount 1 `
        -StableMilliseconds 500 `
        -Target $HostProcess `
        -Client $ClientProcess `
        -Primary $PrimaryWindow `
        -Secondary $SecondaryWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15)) `
        -Stage "exclusive initial-primary composition"

    Wait-ForClientMarker `
        -Path $ClientStdout `
        -ClientProcess $ClientProcess `
        -Marker "OVERLAY_CLIENT_INPUT_TARGET role=main name=text" `
        -Deadline $StartupDeadline
    $ClientLog = Get-ClientLogText -Path $ClientStdout
    $MainTarget = Get-InputTarget -ClientLog $ClientLog -Role "main"
    $MainCenter = Get-InputTargetCenter -Target $MainTarget

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow(
            $PrimaryWindow)) {
        throw "Could not make the initial primary HWND foreground for its input proof."
    }
    Start-Sleep -Milliseconds 250
    [ReShadeClientSdkGate.NativeInputMethods]::SendControlI()
    Wait-ForClientMarker `
        -Path $ClientStdout `
        -ClientProcess $ClientProcess `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true" `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15))
    $PrimaryInterceptState = Get-OverlayState `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl
    Assert-InputInterceptState `
        -State $PrimaryInterceptState `
        -Requested $true `
        -Effective $true `
        -Stage "initial-primary interception acknowledgement"
    $PrimaryInputProof = Invoke-InterceptedTextInputProof `
        -TargetWindow $PrimaryWindow `
        -OracleWindow $PrimaryWindow `
        -TargetCenter $MainCenter `
        -Text "p" `
        -ExpectedValue "p" `
        -Stage "initial primary intercepted Electron input"
    $ClientLog = Get-ClientLogText -Path $ClientStdout
    Assert-MarkerCount `
        -Text $ClientLog `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true" `
        -Expected 1
    Assert-MarkerCount `
        -Text $ClientLog `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false" `
        -Expected 0

    [IO.File]::WriteAllText(
        $DestroyPrimarySurfaceRequestPath,
        "destroy`n",
        [Text.UTF8Encoding]::new($false))

    $ReleasePattern =
        "(?m)^EGO_CONTROLLED_HOST_PRIMARY_GRAPHICS_RELEASED " +
        "backend=$Backend primaryHwnd=$([regex]::Escape($PrimaryHwnd)) " +
        "secondaryHwnd=$([regex]::Escape($SecondaryHwnd)) " +
        "primaryPresentCount=(?<primary>\d+) " +
        "secondaryPresentCount=(?<secondary>\d+) " +
        "primaryHwndAlive=true secondaryHwndAlive=true " +
        "sharedDeviceAlive=true $SharedGraphicsResourceMarker=true " +
        "processAlive=true foregroundHwnd=(?<foreground>0x[0-9a-f]{1,16}) " +
        "secondaryForeground=(?<secondaryForeground>true|false) " +
        "trigger=request\r?$"
    $Release = Wait-ForHostLogMatch `
        -Pattern $ReleasePattern `
        -Marker "EGO_CONTROLLED_HOST_PRIMARY_GRAPHICS_RELEASED" `
        -Target $HostProcess `
        -Client $ClientProcess `
        -Primary $PrimaryWindow `
        -Secondary $SecondaryWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(30))
    if ($Release.Groups['secondaryForeground'].Value -cne "true" -or
        $Release.Groups['foreground'].Value -cne $SecondaryHwnd) {
        throw "The controlled host did not transfer foreground ownership to the surviving secondary HWND."
    }
    $PrimaryReleaseObservedUtc = [DateTime]::UtcNow
    Assert-NoTargetDisconnect `
        -ExpectedPid $ConnectedPid `
        -Stage "primary graphics release"

    $RemainingPattern =
        "(?m)^EGO_CONTROLLED_HOST_REMAINING_PRESENT " +
        "backend=$Backend remaining=secondary " +
        "hwnd=$([regex]::Escape($SecondaryHwnd)) " +
        "presentCount=(?<count>\d+) " +
        "presentsAfterPrimaryRelease=(?<after>\d+) " +
        "primarySwapchainAlive=false secondarySwapchainAlive=true " +
        "sharedDeviceAlive=true $SharedGraphicsResourceMarker=true " +
        "processAlive=true foregroundHwnd=(?<foreground>0x[0-9a-f]{1,16}) " +
        "secondaryForeground=(?<secondaryForeground>true|false)\r?$"
    $Remaining = Wait-ForHostLogMatch `
        -Pattern $RemainingPattern `
        -Marker "EGO_CONTROLLED_HOST_REMAINING_PRESENT" `
        -Target $HostProcess `
        -Client $ClientProcess `
        -Primary $PrimaryWindow `
        -Secondary $SecondaryWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15))
    if ([long]$Remaining.Groups['after'].Value -lt 3) {
        throw "The remaining swap chain did not prove continued presentation after failover."
    }
    if ($Remaining.Groups['secondaryForeground'].Value -cne "true" -or
        $Remaining.Groups['foreground'].Value -cne $SecondaryHwnd) {
        throw "The surviving secondary HWND did not retain foreground ownership."
    }

    $FailoverState = Wait-ForAdvertisedSurface `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -ExpectedPid $ConnectedPid `
        -ExpectedHwnd $SecondaryHwnd `
        -ExpectedWidth 960 `
        -ExpectedHeight 540 `
        -MinimumFpsEventCount ($InitialFpsEventCount + 1) `
        -ExcludedSurfaceId $InitialSurfaceId `
        -Target $HostProcess `
        -Client $ClientProcess `
        -Primary $PrimaryWindow `
        -Secondary $SecondaryWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20)) `
        -Stage "secondary surface and fresh post-failover FPS publication"
    $FailoverAcceptedUtc = [DateTime]::UtcNow
    $FailoverFpsEventCount = [long]$FailoverState.overlayFpsEventCount

    $FailoverCompositionMarkerCount = Wait-ForStableReShadeMarkerCount `
        -Path $ReShadeLog `
        -Marker $CompositionMarker `
        -ExpectedCount 2 `
        -StableMilliseconds 250 `
        -Target $HostProcess `
        -Client $ClientProcess `
        -Primary $PrimaryWindow `
        -Secondary $SecondaryWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15)) `
        -Stage "promoted-secondary composition"

    $null = Wait-ForClientMarkerCount `
        -Path $ClientStdout `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false" `
        -ExpectedCount 1 `
        -Client $ClientProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10)) `
        -Stage "destroyed-primary input release acknowledgement"
    $null = Wait-ForClientMarkerCount `
        -Path $ClientStdout `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true" `
        -ExpectedCount 2 `
        -Client $ClientProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10)) `
        -Stage "promoted-secondary input interception acknowledgement"
    $SecondaryInterceptState = Get-OverlayState `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl
    Assert-InputInterceptState `
        -State $SecondaryInterceptState `
        -Requested $true `
        -Effective $true `
        -Stage "promoted-secondary interception acknowledgement"

    $SecondaryInputProof = Invoke-InterceptedTextInputProof `
        -TargetWindow $SecondaryWindow `
        -OracleWindow $PrimaryWindow `
        -TargetCenter $MainCenter `
        -Text "s" `
        -ExpectedValue "ps" `
        -Stage "promoted secondary intercepted Electron input"

    Start-Sleep -Milliseconds $StableObservationMilliseconds
    $StableState = Wait-ForAdvertisedSurface `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -ExpectedPid $ConnectedPid `
        -ExpectedHwnd $SecondaryHwnd `
        -ExpectedWidth 960 `
        -ExpectedHeight 540 `
        -MinimumFpsEventCount ($FailoverFpsEventCount + 1) `
        -ExcludedSurfaceId $InitialSurfaceId `
        -Target $HostProcess `
        -Client $ClientProcess `
        -Primary $PrimaryWindow `
        -Secondary $SecondaryWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10)) `
        -Stage "sustained post-failover surface and FPS publication"
    Assert-NoTargetDisconnect `
        -ExpectedPid $ConnectedPid `
        -Stage "stable post-failover observation"

    [ReShadeClientSdkGate.NativeInputMethods]::SendControlI()
    $null = Wait-ForClientMarkerCount `
        -Path $ClientStdout `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false" `
        -ExpectedCount 2 `
        -Client $ClientProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15)) `
        -Stage "final promoted-secondary input release acknowledgement"
    $ReleasedInterceptState = Get-OverlayState `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl
    Assert-InputInterceptState `
        -State $ReleasedInterceptState `
        -Requested $false `
        -Effective $false `
        -Stage "promoted-secondary interception release"
    $ClientLog = Get-ClientLogText -Path $ClientStdout
    Assert-MarkerCount `
        -Text $ClientLog `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true" `
        -Expected 2
    Assert-MarkerCount `
        -Text $ClientLog `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false" `
        -Expected 2
    Assert-MarkerCount `
        -Text $ClientLog `
        -Marker "HUDHOOK_CLIENT_INPUT_CLICKED" `
        -Expected 2
    $Acknowledgements = [regex]::Matches(
        $ClientLog,
        '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=(true|false)\r?$')
    $AcknowledgementSequence = @(
        $Acknowledgements | ForEach-Object { $_.Groups[1].Value }
    ) -join ','
    if ($AcknowledgementSequence -cne 'true,false,true,false') {
        throw "The input ownership acknowledgements were out of order: $AcknowledgementSequence"
    }
    $PrimaryValueMatches = [regex]::Matches(
        $ClientLog,
        '(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=p\r?$')
    $SecondaryValueMatches = [regex]::Matches(
        $ClientLog,
        '(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=ps\r?$')
    $ClickMatches = [regex]::Matches(
        $ClientLog,
        '(?m)^HUDHOOK_CLIENT_INPUT_CLICKED\r?$')
    if ($PrimaryValueMatches.Count -ne 1 -or
        $SecondaryValueMatches.Count -ne 1 -or
        $ClickMatches.Count -ne 2 -or
        $PrimaryValueMatches[0].Index -le $Acknowledgements[0].Index -or
        $PrimaryValueMatches[0].Index -ge $Acknowledgements[1].Index -or
        $ClickMatches[0].Index -le $Acknowledgements[0].Index -or
        $ClickMatches[0].Index -ge $Acknowledgements[1].Index -or
        $SecondaryValueMatches[0].Index -le $Acknowledgements[2].Index -or
        $SecondaryValueMatches[0].Index -ge $Acknowledgements[3].Index -or
        $ClickMatches[1].Index -le $Acknowledgements[2].Index -or
        $ClickMatches[1].Index -ge $Acknowledgements[3].Index) {
        throw "Electron input evidence was not bounded by the owning swap chain's interception acknowledgements."
    }

    $ReleasedBaselineTitle = Wait-ForStableHostTitle `
        -Window $PrimaryWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    $ReleasedBaseline = Get-HostInputSnapshot -Title $ReleasedBaselineTitle
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $SecondaryWindow,
        900,
        500)
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    $ReleasedInput = Wait-ForReleasedMouseInput `
        -Window $PrimaryWindow `
        -Baseline $ReleasedBaseline `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    if (-not $ReleasedInput.Title.Contains("clip=on")) {
        throw "Cursor confinement was not restored on the promoted secondary HWND: $($ReleasedInput.Title)"
    }

    $ReShadeFault = Select-String `
        -LiteralPath $ReShadeLog `
        -Pattern "out of global sequence|router was reset|input.*(failed|error)|queue.*(failed|error)|FATAL" `
        -CaseSensitive:$false
    if ($ReShadeFault) {
        throw "The ReShade runtime reported an input/router fault. Inspect $ReShadeLog."
    }

    if (Test-Path -LiteralPath $TargetDirectoryLog -PathType Leaf) {
        throw "The isolated target wrote an unexpected game-directory log: $TargetDirectoryLog"
    }

    $Summary = [pscustomobject]@{
        backend = $Backend
        targetPid = $ConnectedPid
        electronPid = $ClientProcess.Id
        primaryHwnd = $PrimaryHwnd
        secondaryHwnd = $SecondaryHwnd
        releasePrimaryFallbackMilliseconds =
            $ReleasePrimaryFallbackMilliseconds
        destroyPrimarySurfaceRequestPath =
            $DestroyPrimarySurfaceRequestPath
        stableObservationMilliseconds = $StableObservationMilliseconds
        initialState = $InitialState
        failoverState = $FailoverState
        stableState = $StableState
        initialSurfaceId = $InitialSurfaceId
        failoverSurfaceId = $FailoverState.targetSurface.surfaceId
        initialFpsEventCount = $InitialFpsEventCount
        failoverFpsEventCount = $FailoverFpsEventCount
        stableFpsEventCount = [long]$StableState.overlayFpsEventCount
        initialCompositionMarkerCount = $InitialCompositionMarkerCount
        failoverCompositionMarkerCount = $FailoverCompositionMarkerCount
        primaryInterceptState = $PrimaryInterceptState
        secondaryInterceptState = $SecondaryInterceptState
        releasedInterceptState = $ReleasedInterceptState
        primaryInputProof = $PrimaryInputProof
        secondaryInputProof = $SecondaryInputProof
        inputAcknowledgementSequence = $AcknowledgementSequence
        releasedInputOracleTitle = $ReleasedInput.Title
        primaryReleaseToFailoverMilliseconds = [Math]::Round(
            ($FailoverAcceptedUtc - $PrimaryReleaseObservedUtc).TotalMilliseconds,
            3)
        targetAliveAtAcceptance = -not $HostProcess.HasExited
        primaryHwndAliveAtAcceptance =
            [MultiSwapchainClientSdkGate.NativeMethods]::IsWindow($PrimaryWindow)
        secondaryHwndAliveAtAcceptance =
            [MultiSwapchainClientSdkGate.NativeMethods]::IsWindow($SecondaryWindow)
        electronAliveAtAcceptance = -not $ClientProcess.HasExited
        processDisconnectObservedBeforeAcceptance = $false
        presentingMarker = $Presenting.Value
        releaseMarker = $Release.Value
        remainingPresentMarker = $Remaining.Value
        reshadeRunDirectory = $ReShadeRunDirectory
    }

    [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
    if (-not $HostProcess.WaitForExit(10000)) {
        throw "Released Escape did not close the promoted-secondary controlled host."
    }
    $HostProcess.WaitForExit()
    $HostProcess.Refresh()
    if ($null -eq $HostProcess.ExitCode) {
        throw "The controlled host exited but its retained process handle exposed no exit code."
    }
    if ($HostProcess.ExitCode -ne 0) {
        throw "The multi-swap-chain controlled host exited with code $($HostProcess.ExitCode)."
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
    throw "The $BackendLabel multi-swap-chain gate did not complete."
}

Start-Sleep -Milliseconds 250
$RemainingHosts = @(Get-MatchingHosts)
$RemainingClients = @(Get-MatchingClientProcesses)
$RemainingInjectors = @(Get-MatchingInjectors)
if ($RemainingHosts.Count -ne 0 -or
    $RemainingClients.Count -ne 0 -or
    $RemainingInjectors.Count -ne 0) {
    throw "The multi-swap-chain gate left controlled processes running."
}

$Summary |
    ConvertTo-Json -Depth 12 |
    Set-Content -LiteralPath (Join-Path $RunDirectory "summary.json") -Encoding UTF8
$ResultMarker |
    Set-Content -LiteralPath (Join-Path $RunDirectory "result.txt") -Encoding UTF8
Write-Host $ResultMarker
Write-Host "Evidence preserved in: $RunDirectory"
