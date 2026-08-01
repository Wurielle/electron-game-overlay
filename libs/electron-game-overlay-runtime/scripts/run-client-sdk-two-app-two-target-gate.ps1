[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"

# Reuse the production client gate's controlled-host, log, window, coordinate,
# and SendInput helpers without running its sequential two-attempt scenario.
. (Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1") `
    -Backend d3d12 `
    -SkipBuild:$SkipBuild `
    -FunctionsOnly

$D3D11HostName = "d3d11_overlay_test_host.exe"
$D3D12HostName = "d3d12_overlay_test_host.exe"
$D3D11HostTarget = "d3d11_overlay_test_host"
$D3D12HostTarget = "d3d12_overlay_test_host"
$D3D11BuiltHost = Join-Path $OutputDirectory $D3D11HostName
$D3D12BuiltHost = Join-Path $OutputDirectory $D3D12HostName
$RunDirectory = Join-Path `
    $BuildRoot `
    "client-sdk-two-app-two-target-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$ResultMarker = "TWO_APP_TWO_TARGET_REAL_CLIENT_SDK_GATE_PASS"
$DiscoveryFileName = "electron-overlay-transport-v1.json"
$TargetDiscoveryPrefix = "electron-overlay-transport-v1.pid-"
$GlobalDiscoveryDirectory = Join-Path `
    ([IO.Path]::GetTempPath()) `
    "electron-game-overlay"
$GlobalDiscoveryPath = Join-Path `
    $GlobalDiscoveryDirectory `
    $DiscoveryFileName
$Summary = $null
$HostA = $null
$HostB = $null
$ClientA = $null
$ClientB = $null
$RunDirectories = [Collections.Generic.List[string]]::new()

function Get-FreeTcpPort {
    param([int[]]$Excluded = @())

    for ($Attempt = 0; $Attempt -lt 20; ++$Attempt) {
        $Listener = [Net.Sockets.TcpListener]::new(
            [Net.IPAddress]::Loopback,
            0
        )
        try {
            $Listener.Start()
            $Port = ([Net.IPEndPoint]$Listener.LocalEndpoint).Port
        }
        finally {
            $Listener.Stop()
        }
        if ($Port -notin $Excluded) {
            return $Port
        }
    }
    throw "Could not reserve a distinct local DevTools port."
}

function Wait-ForClientRegex {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][DateTime]$Deadline,
        [int]$AfterIndex = -1
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        $Text = Get-ClientLogText -Path $Path
        if ($null -eq $Text) {
            $Text = ""
        }
        $SearchStart = [Math]::Min(
            $Text.Length,
            [Math]::Max(0, $AfterIndex + 1)
        )
        $Tail = $Text.Substring($SearchStart)
        if ($Tail.Contains("RESHADE_CLIENT_INJECTOR_FAILED") -or
            $Tail.Contains("ReShade attachment failed")) {
            throw "The client reported a ReShade attachment failure. Inspect $Path."
        }
        foreach ($Match in [regex]::Matches($Text, $Pattern)) {
            if ($Match.Index -gt $AfterIndex) {
                return $Match
            }
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The production Electron client exited while waiting for '$Pattern'. Inspect $Path."
        }
        Start-Sleep -Milliseconds 50
    }

    throw "Timed out waiting for client pattern '$Pattern'. Inspect $Path."
}

function Wait-ForClientRegexCount {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][int]$Expected,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        $Text = Get-ClientLogText -Path $Path
        if ($null -eq $Text) {
            $Text = ""
        }
        if ($Text.Contains("RESHADE_CLIENT_INJECTOR_FAILED") -or
            $Text.Contains("ReShade attachment failed")) {
            throw "The client reported a ReShade attachment failure. Inspect $Path."
        }
        $Count = ([regex]::Matches($Text, $Pattern)).Count
        if ($Count -eq $Expected) {
            return
        }
        if ($Count -gt $Expected) {
            throw "Expected $Expected client marker(s) matching '$Pattern', found $Count in $Path."
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The production Electron client exited while waiting for $Expected '$Pattern' marker(s)."
        }
        Start-Sleep -Milliseconds 50
    }

    $FinalText = Get-ClientLogText -Path $Path
    $FinalCount = ([regex]::Matches($FinalText, $Pattern)).Count
    throw "Timed out waiting for $Expected client marker(s) matching '$Pattern'; found $FinalCount in $Path."
}

function Assert-ClientRegexCount {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][int]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $Count = ([regex]::Matches($Text, $Pattern)).Count
    if ($Count -ne $Expected) {
        throw "$Label expected $Expected marker(s) matching '$Pattern', found $Count."
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
            $Targets = @($Response.GetEnumerator())
            $Page = $Targets |
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

    throw "Timed out waiting for the production client frontend at $Endpoint."
}

function Invoke-DevToolsExpression {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][string]$Expression
    )

    $Socket = [Net.WebSockets.ClientWebSocket]::new()
    $Cancellation = [Threading.CancellationTokenSource]::new(
        [TimeSpan]::FromSeconds(8)
    )
    try {
        [void]$Socket.ConnectAsync(
            [Uri]$WebSocketUrl,
            $Cancellation.Token
        ).GetAwaiter().GetResult()
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
                $ResponseText = [Text.Encoding]::UTF8.GetString(
                    $Stream.ToArray()
                )
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
                $Description =
                    $Response.result.exceptionDetails.exception.description
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

function Get-FrontendState {
    param([Parameter(Mandatory = $true)][string]$WebSocketUrl)

    return Invoke-DevToolsExpression `
        -WebSocketUrl $WebSocketUrl `
        -Expression @"
(async () => {
  return await window.require('electron').ipcRenderer.invoke('overlay:get-state');
})()
"@
}

function Set-FrontendIntercept {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][bool]$Intercept
    )

    $Value = if ($Intercept) { "true" } else { "false" }
    return Invoke-DevToolsExpression `
        -WebSocketUrl $WebSocketUrl `
        -Expression @"
(async () => {
  return await window.require('electron').ipcRenderer.invoke(
    'overlay:set-input-intercept',
    $Value
  );
})()
"@
}

function Create-FrontendPopup {
    param([Parameter(Mandatory = $true)][string]$WebSocketUrl)

    return Invoke-DevToolsExpression `
        -WebSocketUrl $WebSocketUrl `
        -Expression @"
(() => {
  const button = document.getElementById('show-popup-overlay');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('The popup overlay control is unavailable');
  }
  button.click();
  return true;
})()
"@
}

function Close-ClientThroughDevTools {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process
    )

    $Socket = [Net.WebSockets.ClientWebSocket]::new()
    $Cancellation = [Threading.CancellationTokenSource]::new(
        [TimeSpan]::FromSeconds(8)
    )
    try {
        [void]$Socket.ConnectAsync(
            [Uri]$WebSocketUrl,
            $Cancellation.Token
        ).GetAwaiter().GetResult()
        $Request = @{
            id = 1
            method = "Browser.close"
        } | ConvertTo-Json -Compress
        $Bytes = [Text.Encoding]::UTF8.GetBytes($Request)
        [void]$Socket.SendAsync(
            [ArraySegment[byte]]::new($Bytes),
            [Net.WebSockets.WebSocketMessageType]::Text,
            $true,
            $Cancellation.Token
        ).GetAwaiter().GetResult()
        Start-Sleep -Milliseconds 100
    }
    finally {
        $Cancellation.Dispose()
        $Socket.Dispose()
    }

    if (-not $Process.WaitForExit(10000)) {
        throw "The production Electron client did not honor DevTools Browser.close."
    }
}

function Wait-ForFrontendState {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][int]$TargetPid,
        [Parameter(Mandatory = $true)][bool]$InterceptRequested,
        [Parameter(Mandatory = $true)][bool]$InterceptEffective,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $LastState = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        try {
            $LastState = Get-FrontendState -WebSocketUrl $WebSocketUrl
            if ($LastState.attachment.phase -eq "connected" -and
                [int]$LastState.attachment.pid -eq $TargetPid -and
                [bool]$LastState.inputInterceptRequested -eq
                    $InterceptRequested -and
                [bool]$LastState.inputInterceptEffective -eq
                    $InterceptEffective) {
                return $LastState
            }
        }
        catch {
            # The renderer may be between initial navigation and hydration.
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The client exited before its frontend reached the expected isolated state."
        }
        Start-Sleep -Milliseconds 50
    }

    throw "The frontend did not reach the expected target/input state: $($LastState | ConvertTo-Json -Depth 5 -Compress)"
}

function Get-RendezvousPath {
    param(
        [Parameter(Mandatory = $true)][string]$ClientLog,
        [Parameter(Mandatory = $true)][int]$TargetPid
    )

    $Matches = [regex]::Matches(
        $ClientLog,
        "(?m)^RESHADE_CLIENT_TARGET_RENDEZVOUS_AUTHORIZED pid=$TargetPid path=(?<path>.+)\r?`$"
    )
    if ($Matches.Count -ne 1) {
        throw "Expected one target rendezvous marker for PID $TargetPid, found $($Matches.Count)."
    }
    $Path = $Matches[0].Groups['path'].Value | ConvertFrom-Json
    if (-not [IO.Path]::IsPathRooted($Path)) {
        throw "The target rendezvous path was not absolute: $Path"
    }
    return [IO.Path]::GetFullPath($Path)
}

function Wait-ForDiscoveryRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        try {
            if (Test-Path -LiteralPath $Path -PathType Leaf) {
                $Bytes = [IO.File]::ReadAllBytes($Path)
                if ($Bytes.Length -gt 4096) {
                    throw "The discovery record exceeded its bounded schema: $Path"
                }
                $RecordText = [Text.Encoding]::UTF8.GetString($Bytes)
                return $RecordText | ConvertFrom-Json
            }
        }
        catch {
            if ($_.Exception.Message -like
                "The discovery record exceeded*") {
                throw
            }
            # Atomic publication may be in flight. Retry the bounded read.
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The client exited before publishing discovery at $Path."
        }
        Start-Sleep -Milliseconds 25
    }
    throw "Timed out waiting for target discovery at $Path."
}

function Assert-TargetDiscoveryRecord {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)][int]$ClientPid,
        [Parameter(Mandatory = $true)][int]$TargetPid,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $Properties = @($Record.PSObject.Properties.Name | Sort-Object)
    if (($Properties -join ",") -ne "pid,port,targetPid,token,version") {
        throw "$Label discovery schema was not exact: $($Properties -join ',')."
    }
    if ([int]$Record.version -ne 1 -or
        [int]$Record.pid -ne $ClientPid -or
        [int]$Record.targetPid -ne $TargetPid -or
        [int]$Record.port -lt 1 -or
        [int]$Record.port -gt 65535 -or
        -not ([string]$Record.token -cmatch '^[0-9a-f]{64}$')) {
        throw "$Label discovery record failed validation: $($Record | ConvertTo-Json -Compress)"
    }
}

function Assert-GlobalDiscoveryRecord {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)][int[]]$AllowedClientPids
    )

    $Properties = @($Record.PSObject.Properties.Name | Sort-Object)
    if (($Properties -join ",") -ne "pid,port,token,version") {
        throw "Global discovery schema was not exact: $($Properties -join ',')."
    }
    if ([int]$Record.version -ne 1 -or
        [int]$Record.pid -notin $AllowedClientPids -or
        [int]$Record.port -lt 1 -or
        [int]$Record.port -gt 65535 -or
        -not ([string]$Record.token -cmatch '^[0-9a-f]{64}$')) {
        throw "Global discovery was replaced by an unrelated or invalid record: $($Record | ConvertTo-Json -Compress)"
    }
}

function Get-TokenFingerprint {
    param([Parameter(Mandatory = $true)][string]$Token)

    $Sha = [Security.Cryptography.SHA256]::Create()
    try {
        $Bytes = [Text.Encoding]::ASCII.GetBytes($Token)
        return (
            [BitConverter]::ToString($Sha.ComputeHash($Bytes)).
                Replace("-", "").
                Substring(0, 16)
        )
    }
    finally {
        $Sha.Dispose()
    }
}

function Wait-ForPathRemoval {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        if (-not (Test-Path -LiteralPath $Path)) {
            return
        }
        Start-Sleep -Milliseconds 50
    }
    throw "The owned transport rendezvous was not removed: $Path"
}

function Assert-ExactTargetProcess {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedPath
    )

    $Target = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId=$ProcessId" `
        -ErrorAction SilentlyContinue
    if (-not $Target -or
        -not [string]::Equals(
            $Target.ExecutablePath,
            $ExpectedPath,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Target PID $ProcessId came from an unexpected path: $($Target.ExecutablePath)"
    }
}

function Get-ScopedInjectors {
    $Paths = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($Directory in $RunDirectories) {
        [void]$Paths.Add(
            [IO.Path]::GetFullPath((Join-Path $Directory "inject.exe"))
        )
    }
    foreach ($ClientLogPath in @($ClientAStdout, $ClientBStdout)) {
        $ClientLog = Get-ClientLogText -Path $ClientLogPath
        foreach ($Match in [regex]::Matches(
                $ClientLog,
                '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(?<directory>.+)\r?$')) {
            try {
                $Directory =
                    $Match.Groups['directory'].Value | ConvertFrom-Json
                if ([IO.Path]::IsPathRooted($Directory)) {
                    [void]$Paths.Add(
                        [IO.Path]::GetFullPath(
                            (Join-Path $Directory "inject.exe")
                        )
                    )
                }
            }
            catch {
                # Partial evidence is not authority to terminate a process.
            }
        }
    }

    @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name='inject.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                $Paths.Contains([IO.Path]::GetFullPath($_.ExecutablePath))
            }
    )
}

function Stop-OwnedProcesses {
    foreach ($OwnedHost in @($HostA, $HostB)) {
        if (-not $OwnedHost) {
            continue
        }
        try {
            $OwnedHost.Refresh()
            if (-not $OwnedHost.HasExited) {
                $OwnedHost.Kill()
                $null = $OwnedHost.WaitForExit(5000)
            }
        }
        catch {
            # Residual-process verification below remains authoritative.
        }
    }

    foreach ($Injector in @(Get-ScopedInjectors)) {
        Stop-Process `
            -Id $Injector.ProcessId `
            -Force `
            -ErrorAction SilentlyContinue
        Wait-Process `
            -Id $Injector.ProcessId `
            -Timeout 5 `
            -ErrorAction SilentlyContinue
    }
    foreach ($UserData in @($ClientAUserData, $ClientBUserData)) {
        Stop-AttemptElectronProcesses -UserData $UserData
    }
}

function Test-IsolatedClientInput {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Client,
        [Parameter(Mandatory = $true)][string]$ClientLogPath,
        [Parameter(Mandatory = $true)][string]$ClientWebSocketUrl,
        [Parameter(Mandatory = $true)][int]$TargetPid,
        [Parameter(Mandatory = $true)][IntPtr]$TargetWindow,
        [Parameter(Mandatory = $true)][IntPtr]$OtherTargetWindow,
        [Parameter(Mandatory = $true)][string]$OtherClientLogPath,
        [Parameter(Mandatory = $true)][string]$OtherClientWebSocketUrl,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$OtherClient,
        [Parameter(Mandatory = $true)][int]$OtherTargetPid,
        [Parameter(Mandatory = $true)][string]$UniqueValue
    )

    $BeforeClientLog = Get-ClientLogText -Path $ClientLogPath
    $BeforeOtherLog = Get-ClientLogText -Path $OtherClientLogPath
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow(
            $TargetWindow)) {
        throw "$Label could not foreground its controlled target."
    }
    Start-Sleep -Milliseconds 250
    $OtherTitleBefore =
        [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle(
            $OtherTargetWindow
        )
    $OtherSnapshotBefore = Get-HostInputSnapshot -Title $OtherTitleBefore

    $RequestedState = Set-FrontendIntercept `
        -WebSocketUrl $ClientWebSocketUrl `
        -Intercept $true
    if (-not [bool]$RequestedState.inputInterceptRequested) {
        throw "$Label did not record its interception request."
    }
    $Enabled = Wait-ForClientRegex `
        -Path $ClientLogPath `
        -Process $Client `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true\r?$' `
        -AfterIndex ($BeforeClientLog.Length - 1) `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15))
    [void](Wait-ForFrontendState `
            -WebSocketUrl $ClientWebSocketUrl `
            -Process $Client `
            -TargetPid $TargetPid `
            -InterceptRequested $true `
            -InterceptEffective $true `
            -Deadline ([DateTime]::UtcNow.AddSeconds(10)))
    $OtherState = Wait-ForFrontendState `
        -WebSocketUrl $OtherClientWebSocketUrl `
        -Process $OtherClient `
        -TargetPid $OtherTargetPid `
        -InterceptRequested $false `
        -InterceptEffective $false `
        -Deadline ([DateTime]::UtcNow.AddSeconds(5))

    $OtherLogAfterEnable = Get-ClientLogText -Path $OtherClientLogPath
    if ($OtherLogAfterEnable.Substring(
            [Math]::Min($BeforeOtherLog.Length, $OtherLogAfterEnable.Length)
        ).Contains("HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true")) {
        throw "$Label interception leaked into the other Electron session."
    }

    $BaselineTitle = Wait-ForStableHostTitle `
        -Window $TargetWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    $Baseline = Get-HostInputSnapshot -Title $BaselineTitle
    if (-not $BaselineTitle.Contains("clip=off")) {
        throw "$Label target retained cursor confinement during interception: $BaselineTitle"
    }

    $ClientLog = Get-ClientLogText -Path $ClientLogPath
    $MainTarget = Get-InputTarget -ClientLog $ClientLog -Role "main"
    $MainCenter = Get-InputTargetCenter -Target $MainTarget
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $MainCenter.X,
        $MainCenter.Y
    )
    Start-Sleep -Milliseconds 100
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText($UniqueValue)

    $EscapedValue = [regex]::Escape($UniqueValue)
    $Value = Wait-ForClientRegex `
        -Path $ClientLogPath `
        -Process $Client `
        -Pattern "(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=$EscapedValue\r?`$" `
        -AfterIndex $Enabled.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Start-Sleep -Milliseconds 300
    $InterceptedTitle =
        [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($TargetWindow)
    if ($InterceptedTitle -ne $BaselineTitle) {
        throw "$Label target received its overlay input.`nBefore: $BaselineTitle`nAfter:  $InterceptedTitle"
    }
    $OtherTitleAfter =
        [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle(
            $OtherTargetWindow
        )
    $OtherSnapshotAfter = Get-HostInputSnapshot -Title $OtherTitleAfter
    foreach ($Counter in @(
            "Move",
            "Down",
            "Up",
            "Wheel",
            "Key",
            "Raw",
            "PointerUpdate",
            "PointerDown",
            "PointerUp"
        )) {
        if ($OtherSnapshotAfter.$Counter -ne $OtherSnapshotBefore.$Counter) {
            throw "$Label routed foreground window/raw/pointer input into the other controlled target ($Counter changed).`nBefore: $OtherTitleBefore`nAfter:  $OtherTitleAfter"
        }
    }
    $OtherLog = Get-ClientLogText -Path $OtherClientLogPath
    if ($OtherLog.Contains(
            "HUDHOOK_CLIENT_INPUT_VALUE value=$UniqueValue")) {
        throw "$Label overlay input was delivered to the other Electron session."
    }
    if ([bool]$OtherState.inputInterceptRequested -or
        [bool]$OtherState.inputInterceptEffective) {
        throw "$Label caused the other frontend to enter interception."
    }

    $ReleasedRequest = Set-FrontendIntercept `
        -WebSocketUrl $ClientWebSocketUrl `
        -Intercept $false
    if ([bool]$ReleasedRequest.inputInterceptRequested) {
        throw "$Label did not clear its interception request."
    }
    $Disabled = Wait-ForClientRegex `
        -Path $ClientLogPath `
        -Process $Client `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false\r?$' `
        -AfterIndex $Value.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15))
    [void](Wait-ForFrontendState `
            -WebSocketUrl $ClientWebSocketUrl `
            -Process $Client `
            -TargetPid $TargetPid `
            -InterceptRequested $false `
            -InterceptEffective $false `
            -Deadline ([DateTime]::UtcNow.AddSeconds(10)))

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        1150,
        650
    )
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    $Released = Wait-ForReleasedMouseInput `
        -Window $TargetWindow `
        -Baseline $Baseline `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    if (-not $Released.Title.Contains("clip=on")) {
        throw "$Label did not restore cursor confinement after release: $($Released.Title)"
    }

    return [pscustomobject]@{
        Label = $Label
        TargetProcessId = $TargetPid
        UniqueValue = $UniqueValue
        BaselineTitle = $BaselineTitle
        InterceptedTitle = $InterceptedTitle
        ReleasedTitle = $Released.Title
        EnabledMarkerIndex = $Enabled.Index
        ValueMarkerIndex = $Value.Index
        DisabledMarkerIndex = $Disabled.Index
        OtherSessionStayedReleased = $true
        OtherTargetMessageInputStayedUnchanged = $true
        OtherTargetGlobalPollingExcluded = @(
            "GetAsyncKeyState",
            "GetCursorPos",
            "cursor clip"
        )
    }
}

if (-not (Test-Path -LiteralPath $Electron -PathType Leaf)) {
    throw "Electron is unavailable: $Electron"
}
if (-not (Test-Path -LiteralPath $Nx -PathType Leaf)) {
    throw "The local Nx CLI is unavailable: $Nx"
}

$ExistingHosts = Get-MatchingHosts
$ExistingClients = Get-MatchingClientProcesses
$ExistingInjectors = @(
    Get-CimInstance `
        Win32_Process `
        -Filter "Name='inject.exe'" `
        -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -like "*$D3D11HostName*" -or
            $_.CommandLine -like "*$D3D12HostName*"
        }
)
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
if (Test-Path -LiteralPath $GlobalDiscoveryPath -PathType Leaf) {
    try {
        $ExistingGlobalRecord =
            Get-Content -Raw -LiteralPath $GlobalDiscoveryPath |
                ConvertFrom-Json
        $ExistingGlobalPid = [int]$ExistingGlobalRecord.pid
        if ($ExistingGlobalPid -gt 0 -and
            (Get-Process `
                -Id $ExistingGlobalPid `
                -ErrorAction SilentlyContinue)) {
            throw "Close the active overlay transport that owns global discovery before this test (PID: $ExistingGlobalPid)."
        }
    }
    catch {
        if ($_.Exception.Message -like "Close the active overlay transport*") {
            throw
        }
        # A stale or malformed record has no live owner. The first test client
        # atomically replaces it and graceful teardown removes that owned copy.
    }
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
            --target $D3D11HostTarget $D3D12HostTarget `
            --parallel
        if ($LASTEXITCODE -ne 0) {
            throw "The controlled D3D11/D3D12 host build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

foreach ($RequiredHost in @($D3D11BuiltHost, $D3D12BuiltHost)) {
    if (-not (Test-Path -LiteralPath $RequiredHost -PathType Leaf)) {
        throw "A controlled host is unavailable: $RequiredHost"
    }
}

$ClientADirectory = Join-Path $RunDirectory "app-a-d3d11"
$ClientBDirectory = Join-Path $RunDirectory "app-b-d3d12"
$TargetADirectory = Join-Path $ClientADirectory "target"
$TargetBDirectory = Join-Path $ClientBDirectory "target"
$TargetAPath = Join-Path $TargetADirectory $D3D11HostName
$TargetBPath = Join-Path $TargetBDirectory $D3D12HostName
$TargetABarrier = Join-Path `
    $TargetADirectory `
    "electron-game-overlay-startup-barrier.enabled"
$TargetBBarrier = Join-Path `
    $TargetBDirectory `
    "electron-game-overlay-startup-barrier.enabled"
$ClientAUserData = Join-Path $ClientADirectory "user-data"
$ClientBUserData = Join-Path $ClientBDirectory "user-data"
$ClientAStdout = Join-Path $ClientADirectory "client.stdout.log"
$ClientAStderr = Join-Path $ClientADirectory "client.stderr.log"
$ClientBStdout = Join-Path $ClientBDirectory "client.stdout.log"
$ClientBStderr = Join-Path $ClientBDirectory "client.stderr.log"
$ClientADevToolsPort = Get-FreeTcpPort
$ClientBDevToolsPort = Get-FreeTcpPort -Excluded @($ClientADevToolsPort)

New-Item -ItemType Directory -Path $TargetADirectory -Force | Out-Null
New-Item -ItemType Directory -Path $TargetBDirectory -Force | Out-Null
Copy-Item -LiteralPath $D3D11BuiltHost -Destination $TargetAPath
Copy-Item -LiteralPath $D3D12BuiltHost -Destination $TargetBPath
New-Item `
    -ItemType File `
    -Path (Join-Path $TargetADirectory "reshade-input-gate.enabled") `
    -Force | Out-Null
New-Item `
    -ItemType File `
    -Path (Join-Path $TargetBDirectory "reshade-input-gate.enabled") `
    -Force | Out-Null
New-Item -ItemType File -Path $TargetABarrier -Force | Out-Null
New-Item -ItemType File -Path $TargetBBarrier -Force | Out-Null

Write-Host ""
Write-Host "Production client/SDK two-app, two-target isolation gate"
Write-Host "  - App A attaches by exact PID to a controlled D3D11 target."
Write-Host "  - App B attaches concurrently by exact PID to a controlled D3D12 target."
Write-Host "  - Per-run credentials, scenes, input, disconnects, and cleanup must stay isolated."
Write-Host "  - Evidence is preserved in: $RunDirectory"
Write-Host ""

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
    $HostA = Start-Process `
        -FilePath $TargetAPath `
        -WorkingDirectory $TargetADirectory `
        -PassThru
    $HostB = Start-Process `
        -FilePath $TargetBPath `
        -WorkingDirectory $TargetBDirectory `
        -PassThru
    Start-Sleep -Milliseconds 300
    foreach ($OwnedHost in @($HostA, $HostB)) {
        $OwnedHost.Refresh()
        if ($OwnedHost.HasExited) {
            throw "A controlled target exited before exact-PID attachment."
        }
    }
    Assert-ExactTargetProcess -ProcessId $HostA.Id -ExpectedPath $TargetAPath
    Assert-ExactTargetProcess -ProcessId $HostB.Id -ExpectedPath $TargetBPath

    $ClientAArguments = @(
        "`"$RepoRoot`"",
        "--no-sandbox",
        "--reshade-overlay",
        "`"--reshade-auto-target-process=$D3D11HostName`"",
        "--reshade-expected-target-pid=$($HostA.Id)",
        "--start-overlay-session",
        "--remote-debugging-port=$ClientADevToolsPort",
        "--remote-allow-origins=*",
        "`"--user-data-dir=$ClientAUserData`""
    )
    $ClientBArguments = @(
        "`"$RepoRoot`"",
        "--no-sandbox",
        "--reshade-overlay",
        "`"--reshade-auto-target-process=$D3D12HostName`"",
        "--reshade-expected-target-pid=$($HostB.Id)",
        "--start-overlay-session",
        "--remote-debugging-port=$ClientBDevToolsPort",
        "--remote-allow-origins=*",
        "`"--user-data-dir=$ClientBUserData`""
    )
    $ClientA = Start-Process `
        -FilePath $Electron `
        -ArgumentList $ClientAArguments `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $ClientAStdout `
        -RedirectStandardError $ClientAStderr
    $ClientB = Start-Process `
        -FilePath $Electron `
        -ArgumentList $ClientBArguments `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $ClientBStdout `
        -RedirectStandardError $ClientBStderr

    $AttachDeadline = [DateTime]::UtcNow.AddSeconds(120)
    foreach ($ClientCase in @(
            @{
                Label = "App A"
                Process = $ClientA
                Log = $ClientAStdout
            },
            @{
                Label = "App B"
                Process = $ClientB
                Log = $ClientBStdout
            }
        )) {
        [void](Wait-ForClientRegex `
                -Path $ClientCase.Log `
                -Process $ClientCase.Process `
                -Pattern '(?m)^RESHADE_CLIENT_OVERLAY_SESSION_READY(?: .*)?\r?$' `
                -Deadline $AttachDeadline)
        [void](Wait-ForClientRegex `
                -Path $ClientCase.Log `
                -Process $ClientCase.Process `
                -Pattern '(?m)^RESHADE_CLIENT_INJECTOR_RETURNED(?: .*)?\r?$' `
                -Deadline $AttachDeadline)
    }

    $ClientALog = Get-ClientLogText -Path $ClientAStdout
    $ClientBLog = Get-ClientLogText -Path $ClientBStdout
    $RunDirectoryA = Get-ReShadeRunDirectory -ClientLog $ClientALog
    $RunDirectoryB = Get-ReShadeRunDirectory -ClientLog $ClientBLog
    $RunDirectories.Add($RunDirectoryA)
    $RunDirectories.Add($RunDirectoryB)
    if ([string]::Equals(
            $RunDirectoryA,
            $RunDirectoryB,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Both independent apps received the same staged ReShade run directory."
    }

    $RendezvousPathA = Get-RendezvousPath `
        -ClientLog $ClientALog `
        -TargetPid $HostA.Id
    $RendezvousPathB = Get-RendezvousPath `
        -ClientLog $ClientBLog `
        -TargetPid $HostB.Id
    if ([string]::Equals(
            $RendezvousPathA,
            $RendezvousPathB,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Both independent apps published the same target rendezvous path."
    }
    if (-not [string]::Equals(
            $RendezvousPathA,
            [IO.Path]::GetFullPath(
                (Join-Path $RunDirectoryA $DiscoveryFileName)
            ),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals(
            $RendezvousPathB,
            [IO.Path]::GetFullPath(
                (Join-Path $RunDirectoryB $DiscoveryFileName)
            ),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "A client published target discovery outside its own staged run directory."
    }

    $DiscoveryA = Wait-ForDiscoveryRecord `
        -Path $RendezvousPathA `
        -Process $ClientA `
        -Deadline $AttachDeadline
    $DiscoveryB = Wait-ForDiscoveryRecord `
        -Path $RendezvousPathB `
        -Process $ClientB `
        -Deadline $AttachDeadline
    Assert-TargetDiscoveryRecord `
        -Record $DiscoveryA `
        -ClientPid $ClientA.Id `
        -TargetPid $HostA.Id `
        -Label "App A"
    Assert-TargetDiscoveryRecord `
        -Record $DiscoveryB `
        -ClientPid $ClientB.Id `
        -TargetPid $HostB.Id `
        -Label "App B"
    if ([string]::Equals(
            [string]$DiscoveryA.token,
            [string]$DiscoveryB.token,
            [StringComparison]::Ordinal) -or
        [int]$DiscoveryA.port -eq [int]$DiscoveryB.port) {
        throw "The independent sessions did not receive distinct target credentials and loopback endpoints."
    }

    $StaticDiscoveryPathA = Join-Path `
        $GlobalDiscoveryDirectory `
        "$TargetDiscoveryPrefix$($HostA.Id).json"
    $StaticDiscoveryPathB = Join-Path `
        $GlobalDiscoveryDirectory `
        "$TargetDiscoveryPrefix$($HostB.Id).json"
    $StaticDiscoveryA = Wait-ForDiscoveryRecord `
        -Path $StaticDiscoveryPathA `
        -Process $ClientA `
        -Deadline $AttachDeadline
    $StaticDiscoveryB = Wait-ForDiscoveryRecord `
        -Path $StaticDiscoveryPathB `
        -Process $ClientB `
        -Deadline $AttachDeadline
    Assert-TargetDiscoveryRecord `
        -Record $StaticDiscoveryA `
        -ClientPid $ClientA.Id `
        -TargetPid $HostA.Id `
        -Label "App A static"
    Assert-TargetDiscoveryRecord `
        -Record $StaticDiscoveryB `
        -ClientPid $ClientB.Id `
        -TargetPid $HostB.Id `
        -Label "App B static"
    if ([string]$StaticDiscoveryA.token -cne [string]$DiscoveryA.token -or
        [string]$StaticDiscoveryB.token -cne [string]$DiscoveryB.token) {
        throw "A static exact-PID route did not match its per-run credential."
    }

    $GlobalDiscovery = Wait-ForDiscoveryRecord `
        -Path $GlobalDiscoveryPath `
        -Process $ClientA `
        -Deadline $AttachDeadline
    Assert-GlobalDiscoveryRecord `
        -Record $GlobalDiscovery `
        -AllowedClientPids @($ClientA.Id, $ClientB.Id)
    if ([string]$GlobalDiscovery.token -ceq [string]$DiscoveryA.token -or
        [string]$GlobalDiscovery.token -ceq [string]$DiscoveryB.token) {
        throw "A target reused the backward-compatible global discovery credential instead of its exact-PID rendezvous."
    }

    Remove-Item -LiteralPath $TargetABarrier -Force
    Remove-Item -LiteralPath $TargetBBarrier -Force
    $WindowA = Wait-ForHostWindow `
        -HostProcess $HostA `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    $WindowB = Wait-ForHostWindow `
        -HostProcess $HostB `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))

    $ConnectedA = Wait-ForClientRegex `
        -Path $ClientAStdout `
        -Process $ClientA `
        -Pattern "(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=$($HostA.Id)\r?`$" `
        -Deadline $AttachDeadline
    $ConnectedB = Wait-ForClientRegex `
        -Path $ClientBStdout `
        -Process $ClientB `
        -Pattern "(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=$($HostB.Id)\r?`$" `
        -Deadline $AttachDeadline
    foreach ($ClientCase in @(
            @{
                Process = $ClientA
                Log = $ClientAStdout
                Pid = $HostA.Id
            },
            @{
                Process = $ClientB
                Log = $ClientBStdout
                Pid = $HostB.Id
            }
        )) {
        [void](Wait-ForClientRegex `
                -Path $ClientCase.Log `
                -Process $ClientCase.Process `
                -Pattern "(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-overlay-transport severity=info code=target-authenticated pid=$($ClientCase.Pid)(?: .*)?\r?`$" `
                -Deadline $AttachDeadline)
        [void](Wait-ForClientRegex `
                -Path $ClientCase.Log `
                -Process $ClientCase.Process `
                -Pattern "(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay-runtime severity=info code=runtime-scene-rendering-started pid=$($ClientCase.Pid)(?: .*)?\r?`$" `
                -Deadline $AttachDeadline)
        [void](Wait-ForClientRegex `
                -Path $ClientCase.Log `
                -Process $ClientCase.Process `
                -Pattern '(?m)^OVERLAY_CLIENT_INPUT_TARGET role=main name=text(?: .*)?\r?$' `
                -Deadline $AttachDeadline)
    }

    $ReShadeLogA = Join-Path $RunDirectoryA "ReShade.log"
    $ReShadeLogB = Join-Path $RunDirectoryB "ReShade.log"
    Wait-ForReShadeMarker `
        -Path $ReShadeLogA `
        -Marker "Redirecting D3D11CreateDeviceAndSwapChain" `
        -Deadline $AttachDeadline `
        -HostProcess $HostA
    Wait-ForReShadeMarker `
        -Path $ReShadeLogB `
        -Marker "Redirecting ID3D12Device::CreateCommandQueue" `
        -Deadline $AttachDeadline `
        -HostProcess $HostB
    foreach ($RuntimeCase in @(
            @{
                Path = $ReShadeLogA
                Process = $HostA
            },
            @{
                Path = $ReShadeLogB
                Process = $HostB
            }
        )) {
        Wait-ForReShadeMarker `
            -Path $RuntimeCase.Path `
            -Marker "rendered its first transported multi-window scene (2 window(s))." `
            -Deadline $AttachDeadline `
            -HostProcess $RuntimeCase.Process
    }

    $DevToolsPageA = Wait-ForDevToolsPage `
        -Port $ClientADevToolsPort `
        -Process $ClientA `
        -Deadline $AttachDeadline
    $DevToolsPageB = Wait-ForDevToolsPage `
        -Port $ClientBDevToolsPort `
        -Process $ClientB `
        -Deadline $AttachDeadline
    $InitialFrontendA = Wait-ForFrontendState `
        -WebSocketUrl $DevToolsPageA.webSocketDebuggerUrl `
        -Process $ClientA `
        -TargetPid $HostA.Id `
        -InterceptRequested $false `
        -InterceptEffective $false `
        -Deadline $AttachDeadline
    $InitialFrontendB = Wait-ForFrontendState `
        -WebSocketUrl $DevToolsPageB.webSocketDebuggerUrl `
        -Process $ClientB `
        -TargetPid $HostB.Id `
        -InterceptRequested $false `
        -InterceptEffective $false `
        -Deadline $AttachDeadline

    $InputProofA = Test-IsolatedClientInput `
        -Label "App A / D3D11" `
        -Client $ClientA `
        -ClientLogPath $ClientAStdout `
        -ClientWebSocketUrl $DevToolsPageA.webSocketDebuggerUrl `
        -TargetPid $HostA.Id `
        -TargetWindow $WindowA `
        -OtherTargetWindow $WindowB `
        -OtherClientLogPath $ClientBStdout `
        -OtherClientWebSocketUrl $DevToolsPageB.webSocketDebuggerUrl `
        -OtherClient $ClientB `
        -OtherTargetPid $HostB.Id `
        -UniqueValue "alpha11"
    $InputProofB = Test-IsolatedClientInput `
        -Label "App B / D3D12" `
        -Client $ClientB `
        -ClientLogPath $ClientBStdout `
        -ClientWebSocketUrl $DevToolsPageB.webSocketDebuggerUrl `
        -TargetPid $HostB.Id `
        -TargetWindow $WindowB `
        -OtherTargetWindow $WindowA `
        -OtherClientLogPath $ClientAStdout `
        -OtherClientWebSocketUrl $DevToolsPageA.webSocketDebuggerUrl `
        -OtherClient $ClientA `
        -OtherTargetPid $HostA.Id `
        -UniqueValue "bravo12"

    $ProducerWindowPattern =
        '(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay severity=info code=producer-window-registered(?: .*)?\r?$'
    $ProducerFramePattern =
        '(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay severity=info code=producer-frame-publication-started(?: .*)?\r?$'
    Wait-ForClientRegexCount `
        -Path $ClientAStdout `
        -Process $ClientA `
        -Pattern $ProducerWindowPattern `
        -Expected 2 `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Wait-ForClientRegexCount `
        -Path $ClientBStdout `
        -Process $ClientB `
        -Pattern $ProducerWindowPattern `
        -Expected 2 `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    [void](Create-FrontendPopup `
            -WebSocketUrl $DevToolsPageA.webSocketDebuggerUrl)
    Wait-ForClientRegexCount `
        -Path $ClientAStdout `
        -Process $ClientA `
        -Pattern $ProducerWindowPattern `
        -Expected 3 `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Wait-ForClientRegexCount `
        -Path $ClientAStdout `
        -Process $ClientA `
        -Pattern $ProducerFramePattern `
        -Expected 3 `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Start-Sleep -Milliseconds 500
    $ClientBSceneLog = Get-ClientLogText -Path $ClientBStdout
    Assert-ClientRegexCount `
        -Text $ClientBSceneLog `
        -Pattern $ProducerWindowPattern `
        -Expected 2 `
        -Label "App B scene"
    Assert-ClientRegexCount `
        -Text $ClientBSceneLog `
        -Pattern $ProducerFramePattern `
        -Expected 2 `
        -Label "App B scene"

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow(
            $WindowA)) {
        throw "Could not foreground App A's target for its normal exit."
    }
    Start-Sleep -Milliseconds 250
    [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
    if (-not $HostA.WaitForExit(10000)) {
        throw "App A's released Escape did not close its controlled target."
    }
    $HostA.Refresh()
    if ($HostA.ExitCode -ne 0) {
        throw "App A's controlled target exited with code $($HostA.ExitCode)."
    }
    $DisconnectedA = Wait-ForClientRegex `
        -Path $ClientAStdout `
        -Process $ClientA `
        -Pattern "(?m)^RESHADE_CLIENT_TARGET_DISCONNECTED pid=$($HostA.Id)\r?`$" `
        -AfterIndex $ConnectedA.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    [void](Wait-ForClientRegex `
            -Path $ClientAStdout `
            -Process $ClientA `
            -Pattern "(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=idle processName=`"$([regex]::Escape($D3D11HostName))`" pid=$($HostA.Id) reason=target-disconnected\r?`$" `
            -AfterIndex $ConnectedA.Index `
            -Deadline ([DateTime]::UtcNow.AddSeconds(20)))
    $HostB.Refresh()
    $ClientB.Refresh()
    if ($HostB.HasExited -or $ClientB.HasExited) {
        throw "App A target shutdown terminated App B's independent session."
    }
    $ClientBMidLog = Get-ClientLogText -Path $ClientBStdout
    if ($ClientBMidLog.Contains(
            "RESHADE_CLIENT_TARGET_DISCONNECTED pid=$($HostB.Id)")) {
        throw "App B disconnected when App A's target exited."
    }

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow(
            $WindowB)) {
        throw "Could not foreground App B's target for its normal exit."
    }
    Start-Sleep -Milliseconds 250
    [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
    if (-not $HostB.WaitForExit(10000)) {
        throw "App B's released Escape did not close its controlled target."
    }
    $HostB.Refresh()
    if ($HostB.ExitCode -ne 0) {
        throw "App B's controlled target exited with code $($HostB.ExitCode)."
    }
    $DisconnectedB = Wait-ForClientRegex `
        -Path $ClientBStdout `
        -Process $ClientB `
        -Pattern "(?m)^RESHADE_CLIENT_TARGET_DISCONNECTED pid=$($HostB.Id)\r?`$" `
        -AfterIndex $ConnectedB.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    [void](Wait-ForClientRegex `
            -Path $ClientBStdout `
            -Process $ClientB `
            -Pattern "(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=idle processName=`"$([regex]::Escape($D3D12HostName))`" pid=$($HostB.Id) reason=target-disconnected\r?`$" `
            -AfterIndex $ConnectedB.Index `
            -Deadline ([DateTime]::UtcNow.AddSeconds(20)))

    foreach ($OwnedPath in @(
            $RendezvousPathA,
            $RendezvousPathB,
            $StaticDiscoveryPathA,
            $StaticDiscoveryPathB
        )) {
        Wait-ForPathRemoval `
            -Path $OwnedPath `
            -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    }

    $ClientALog = Get-ClientLogText -Path $ClientAStdout
    $ClientBLog = Get-ClientLogText -Path $ClientBStdout
    foreach ($ClientProof in @(
            @{
                Label = "App A"
                Text = $ClientALog
                OwnPid = $HostA.Id
                OtherPid = $HostB.Id
                OwnValue = "alpha11"
                OtherValue = "bravo12"
            },
            @{
                Label = "App B"
                Text = $ClientBLog
                OwnPid = $HostB.Id
                OtherPid = $HostA.Id
                OwnValue = "bravo12"
                OtherValue = "alpha11"
            }
        )) {
        Assert-ClientRegexCount `
            -Text $ClientProof.Text `
            -Pattern "(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=$($ClientProof.OwnPid)\r?`$" `
            -Expected 1 `
            -Label $ClientProof.Label
        Assert-ClientRegexCount `
            -Text $ClientProof.Text `
            -Pattern "(?m)^RESHADE_CLIENT_TARGET_DISCONNECTED pid=$($ClientProof.OwnPid)\r?`$" `
            -Expected 1 `
            -Label $ClientProof.Label
        Assert-ClientRegexCount `
            -Text $ClientProof.Text `
            -Pattern "(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=$($ClientProof.OtherPid)\r?`$" `
            -Expected 0 `
            -Label $ClientProof.Label
        Assert-ClientRegexCount `
            -Text $ClientProof.Text `
            -Pattern "(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=$([regex]::Escape($ClientProof.OwnValue))\r?`$" `
            -Expected 1 `
            -Label $ClientProof.Label
        Assert-ClientRegexCount `
            -Text $ClientProof.Text `
            -Pattern "(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=$([regex]::Escape($ClientProof.OtherValue))\r?`$" `
            -Expected 0 `
            -Label $ClientProof.Label
        Assert-ClientRegexCount `
            -Text $ClientProof.Text `
            -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true\r?$' `
            -Expected 1 `
            -Label $ClientProof.Label
        Assert-ClientRegexCount `
            -Text $ClientProof.Text `
            -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false\r?$' `
            -Expected 1 `
            -Label $ClientProof.Label
        if ($ClientProof.Text.Contains("RESHADE_CLIENT_INJECTOR_FAILED") -or
            $ClientProof.Text.Contains("ReShade attachment failed") -or
            $ClientProof.Text.Contains(
                "severity=error code=transport-discovery-failed") -or
            $ClientProof.Text.Contains(
                "severity=warning code=target-packet-rejected")) {
            throw "$($ClientProof.Label) logged an attachment or authenticated-packet failure."
        }
    }

    foreach ($RuntimeLog in @($ReShadeLogA, $ReShadeLogB)) {
        $Fault = Select-String `
            -LiteralPath $RuntimeLog `
            -Pattern "out of global sequence|router was reset|input.*(failed|error)|queue.*(failed|error)|FATAL" `
            -CaseSensitive:$false
        if ($Fault) {
            throw "A runtime reported a scene/input fault: $($Fault.Line -join ' | ')"
        }
    }
    foreach ($UnexpectedTargetLog in @(
            (Join-Path $TargetADirectory "ReShade.log"),
            (Join-Path $TargetBDirectory "ReShade.log")
        )) {
        if (Test-Path -LiteralPath $UnexpectedTargetLog -PathType Leaf) {
            throw "Custom injection wrote an unexpected target-directory log: $UnexpectedTargetLog"
        }
    }

    $Summary = [pscustomobject]@{
        Result = $ResultMarker
        Apps = @(
            [pscustomobject]@{
                Label = "A"
                ClientProcessId = $ClientA.Id
                UserData = $ClientAUserData
                TargetProcessId = $HostA.Id
                TargetExecutablePath = $TargetAPath
                Backend = "D3D11"
                ReShadeRunDirectory = $RunDirectoryA
                RendezvousPath = $RendezvousPathA
                LoopbackPort = [int]$DiscoveryA.port
                TokenFingerprint = Get-TokenFingerprint `
                    -Token ([string]$DiscoveryA.token)
                SceneWindowsInitially = 2
                SceneWindowsAfterOwnPopup = 3
                InputProof = $InputProofA
                InitialFrontend = $InitialFrontendA
                NormalExitCode = $HostA.ExitCode
            },
            [pscustomobject]@{
                Label = "B"
                ClientProcessId = $ClientB.Id
                UserData = $ClientBUserData
                TargetProcessId = $HostB.Id
                TargetExecutablePath = $TargetBPath
                Backend = "D3D12"
                ReShadeRunDirectory = $RunDirectoryB
                RendezvousPath = $RendezvousPathB
                LoopbackPort = [int]$DiscoveryB.port
                TokenFingerprint = Get-TokenFingerprint `
                    -Token ([string]$DiscoveryB.token)
                SceneWindowsInitially = 2
                SceneWindowsAfterOtherPopup = 2
                InputProof = $InputProofB
                InitialFrontend = $InitialFrontendB
                NormalExitCode = $HostB.ExitCode
            }
        )
        IsolationProof = [pscustomobject]@{
            ConcurrentIndependentElectronProcesses =
                $ClientA.Id -ne $ClientB.Id
            ConcurrentIndependentTargetProcesses =
                $HostA.Id -ne $HostB.Id
            DistinctRunDirectories = $true
            DistinctRendezvousPaths = $true
            DistinctLoopbackPorts = $true
            DistinctCredentials = $true
            ExactPidStaticRoutes = @(
                $StaticDiscoveryPathA,
                $StaticDiscoveryPathB
            )
            GlobalDiscoveryOwnerDuringRun = [int]$GlobalDiscovery.pid
            GlobalDiscoveryWasNotUsedForExactPidRuntimeRendezvous = $true
            CrossTargetConnections = 0
            CrossSessionInputDeliveries = 0
            AppASceneMutationObservedByAppB = $false
            AppATargetExitDisconnectedAppB = $false
            OwnedRendezvousReleased = $true
        }
    }

    # Close the non-owner first, then the current global-discovery owner. CDP
    # Browser.close takes Electron through before-quit, so each overlay session
    # can remove only records it still owns instead of relying on forced
    # process termination.
    $ShutdownOrder = if ([int]$GlobalDiscovery.pid -eq $ClientA.Id) {
        @(
            @{
                Process = $ClientB
                WebSocketUrl = $DevToolsPageB.webSocketDebuggerUrl
            },
            @{
                Process = $ClientA
                WebSocketUrl = $DevToolsPageA.webSocketDebuggerUrl
            }
        )
    }
    else {
        @(
            @{
                Process = $ClientA
                WebSocketUrl = $DevToolsPageA.webSocketDebuggerUrl
            },
            @{
                Process = $ClientB
                WebSocketUrl = $DevToolsPageB.webSocketDebuggerUrl
            }
        )
    }
    foreach ($ClientShutdown in $ShutdownOrder) {
        Close-ClientThroughDevTools `
            -WebSocketUrl $ClientShutdown.WebSocketUrl `
            -Process $ClientShutdown.Process
    }
    Wait-ForPathRemoval `
        -Path $GlobalDiscoveryPath `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
}
finally {
    Stop-OwnedProcesses
    foreach ($VariableName in $ControlledEnvironmentVariables) {
        [Environment]::SetEnvironmentVariable(
            $VariableName,
            $PreviousEnvironment[$VariableName],
            "Process"
        )
    }
}

Start-Sleep -Milliseconds 500
$RemainingElectron = @(
    Get-CimInstance `
        Win32_Process `
        -Filter "Name='electron.exe'" `
        -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -like "*$ClientAUserData*" -or
            $_.CommandLine -like "*$ClientBUserData*"
        }
)
$RemainingHosts = @(
    foreach ($OwnedHostCase in @(
            @{
                Process = $HostA
                ExpectedPath = $TargetAPath
            },
            @{
                Process = $HostB
                ExpectedPath = $TargetBPath
            }
        )) {
        if ($OwnedHostCase.Process) {
            Get-CimInstance `
                Win32_Process `
                -Filter "ProcessId=$($OwnedHostCase.Process.Id)" `
                -ErrorAction SilentlyContinue |
                Where-Object {
                    [string]::Equals(
                        $_.ExecutablePath,
                        $OwnedHostCase.ExpectedPath,
                        [StringComparison]::OrdinalIgnoreCase
                    )
                }
        }
    }
)
$RemainingInjectors = @(Get-ScopedInjectors)
if ($RemainingElectron.Count -ne 0 -or
    $RemainingHosts.Count -ne 0 -or
    $RemainingInjectors.Count -ne 0) {
    $ProcessIds = @(
        @($RemainingElectron.ProcessId) +
            @($RemainingHosts.ProcessId) +
            @($RemainingInjectors.ProcessId) |
            Where-Object { $null -ne $_ }
    )
    throw "The two-app/two-target gate left an owned process behind (PID: $($ProcessIds -join ', '))."
}
if (-not $Summary) {
    throw "The two-app/two-target gate did not complete its isolation proof."
}
Wait-ForPathRemoval `
    -Path $GlobalDiscoveryPath `
    -Deadline ([DateTime]::UtcNow.AddSeconds(10))

$Summary |
    ConvertTo-Json -Depth 9 |
    Set-Content -LiteralPath (Join-Path $RunDirectory "summary.json") -Encoding UTF8
$ResultMarker |
    Set-Content -LiteralPath (Join-Path $RunDirectory "result.txt") -Encoding UTF8
Write-Host $ResultMarker
Write-Host "Evidence preserved in: $RunDirectory"
