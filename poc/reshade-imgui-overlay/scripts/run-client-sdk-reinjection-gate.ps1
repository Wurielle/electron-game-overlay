[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"

# Load the input gate's read-only log, window, and SendInput helpers without
# executing that gate. Keeping these primitives shared makes the two gates use
# the same coordinate conversion and controlled-host input oracle.
. (Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1") `
    -Backend d3d12 `
    -SkipBuild:$SkipBuild `
    -FunctionsOnly

$RunDirectory = Join-Path `
    $BuildRoot `
    "client-sdk-d3d12-reinjection-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$UserData = Join-Path $RunDirectory "user-data"
$ClientStdout = Join-Path $RunDirectory "client.stdout.log"
$ClientStderr = Join-Path $RunDirectory "client.stderr.log"
$FrontendActions = Join-Path $RunDirectory "frontend-actions.jsonl"
$ResultMarker = "D3D12_REAL_CLIENT_SDK_REINJECTION_GATE_PASS"
$ClientProcess = $null
$CurrentHostProcess = $null
$ReShadeRunDirectories = [Collections.Generic.List[string]]::new()
$CycleResults = [Collections.Generic.List[object]]::new()

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
        $SearchStart = [Math]::Min($Text.Length, [Math]::Max(0, $AfterIndex + 1))
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
        Start-Sleep -Milliseconds 100
    }

    throw "Timed out waiting for client pattern '$Pattern'. Inspect $Path."
}

function Assert-ClientRegexCount {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][int]$Expected
    )

    $Count = ([regex]::Matches($Text, $Pattern)).Count
    if ($Count -ne $Expected) {
        throw "Expected $Expected client marker(s) matching '$Pattern', found $Count."
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
            # Windows PowerShell returns a top-level JSON array from
            # Invoke-RestMethod as one pipeline object. Enumerate it explicitly
            # so Select-Object yields one DevTools page, not the whole array.
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

    throw "Timed out waiting for the production client's frontend at $Endpoint."
}

function Invoke-DevToolsExpression {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][string]$Expression
    )

    $Socket = [Net.WebSockets.ClientWebSocket]::new()
    $Cancellation = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(8))
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

function Get-FrontendSnapshot {
    param([Parameter(Mandatory = $true)][string]$WebSocketUrl)

    return Invoke-DevToolsExpression -WebSocketUrl $WebSocketUrl -Expression @"
(() => {
  const status = document.getElementById('status');
  const inject = document.getElementById('inject');
  const processName = document.getElementById('process-name');
  return {
    phase: status?.dataset.attachmentPhase ?? document.body.dataset.attachmentPhase ?? null,
    injectDisabled: inject?.disabled ?? null,
    processName: processName?.value ?? null,
    statusText: status?.textContent ?? null,
    title: document.title
  };
})()
"@
}

function Wait-ForFrontendIdle {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $LastSnapshot = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        try {
            $LastSnapshot = Get-FrontendSnapshot -WebSocketUrl $WebSocketUrl
            if ($LastSnapshot.phase -eq "idle" -and
                $LastSnapshot.injectDisabled -eq $false) {
                return $LastSnapshot
            }
        }
        catch {
            # The renderer may be between initial navigation and hydration.
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The production Electron client exited before the frontend returned to idle."
        }
        Start-Sleep -Milliseconds 100
    }

    throw "The frontend did not return to idle with injection enabled. Last state: $($LastSnapshot | ConvertTo-Json -Compress)"
}

function Invoke-FrontendInjection {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][string]$ProcessName,
        [Parameter(Mandatory = $true)][int]$Cycle
    )

    $ProcessNameJson = $ProcessName | ConvertTo-Json -Compress
    $Result = Invoke-DevToolsExpression -WebSocketUrl $WebSocketUrl -Expression @"
(() => {
  const input = document.getElementById('process-name');
  const button = document.getElementById('inject');
  if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) {
    throw new Error('The production injection controls are unavailable');
  }
  if (button.disabled) {
    throw new Error('The production Inject button is disabled');
  }
  input.value = $ProcessNameJson;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  button.click();
  return {
    processName: input.value,
    clickDispatched: true,
    buttonDisabledAfterClick: button.disabled
  };
})()
"@
    if (-not $Result.clickDispatched -or $Result.processName -ne $ProcessName) {
        throw "The frontend did not dispatch the requested injection for $ProcessName."
    }
    if (-not $Result.buttonDisabledAfterClick) {
        throw "The frontend Inject button remained enabled after cycle $Cycle dispatched its request."
    }
    [pscustomobject]@{
        Cycle = $Cycle
        Utc = [DateTime]::UtcNow.ToString("o")
        Action = "frontend-inject-click"
        ProcessName = $Result.processName
        ButtonDisabledAfterClick = $Result.buttonDisabledAfterClick
    } |
        ConvertTo-Json -Compress |
        Add-Content -LiteralPath $FrontendActions -Encoding UTF8
}

function Get-StagedRunDirectoryFromMatch {
    param([Parameter(Mandatory = $true)][Text.RegularExpressions.Match]$Match)

    $Directory = $Match.Groups['directory'].Value | ConvertFrom-Json
    if (-not [IO.Path]::IsPathRooted($Directory)) {
        throw "The SDK staged a non-absolute ReShade run directory: $Directory"
    }
    return $Directory
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
        throw "The authenticated target PID $ProcessId came from an unexpected path: $($Target.ExecutablePath)"
    }
}

function Start-FrontendInjectionCycle {
    param(
        [Parameter(Mandatory = $true)][int]$Cycle,
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][int]$AfterIndex
    )

    $CycleDirectory = Join-Path $RunDirectory "cycle-$Cycle"
    $TargetDirectory = Join-Path $CycleDirectory "target"
    $TargetExecutablePath = Join-Path $TargetDirectory $HostName
    New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $BuiltHost -Destination $TargetExecutablePath
    New-Item `
        -ItemType File `
        -Path (Join-Path $TargetDirectory "reshade-input-gate.enabled") `
        -Force | Out-Null
    New-Item `
        -ItemType File `
        -Path (Join-Path $TargetDirectory "reshade-injection-wait.enabled") `
        -Force | Out-Null

    Invoke-FrontendInjection `
        -WebSocketUrl $WebSocketUrl `
        -ProcessName $HostName `
        -Cycle $Cycle

    $AttachDeadline = [DateTime]::UtcNow.AddSeconds(120)
    $Attaching = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=attaching processName="d3d12_overlay_test_host\.exe" pid=none\r?$' `
        -AfterIndex $AfterIndex `
        -Deadline $AttachDeadline
    $Staged = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(?<directory>.+)\r?$' `
        -AfterIndex $AfterIndex `
        -Deadline $AttachDeadline
    $ReShadeRunDirectory = Get-StagedRunDirectoryFromMatch -Match $Staged
    $ReShadeRunDirectories.Add($ReShadeRunDirectory)
    $ReShadeRunDirectory |
        Set-Content `
            -LiteralPath (Join-Path $CycleDirectory "reshade-run-directory.txt") `
            -Encoding UTF8
    $InjectorStarted = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^RESHADE_CLIENT_INJECTOR_STARTED(?: .*)?\r?$' `
        -AfterIndex $AfterIndex `
        -Deadline $AttachDeadline

    $script:CurrentHostProcess = Start-Process `
        -FilePath $TargetExecutablePath `
        -WorkingDirectory $TargetDirectory `
        -PassThru
    $HostWindow = Wait-ForHostWindow `
        -HostProcess $CurrentHostProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))

    $Connected = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=(?<pid>\d+)\r?$' `
        -AfterIndex $AfterIndex `
        -Deadline $AttachDeadline
    $ConnectedPid = [int]$Connected.Groups['pid'].Value
    if ($ConnectedPid -ne $CurrentHostProcess.Id) {
        throw "Cycle $Cycle authenticated PID $ConnectedPid instead of controlled host PID $($CurrentHostProcess.Id)."
    }
    Assert-ExactTargetProcess `
        -ProcessId $ConnectedPid `
        -ExpectedPath $TargetExecutablePath

    $ConnectedState = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=connected processName=`"d3d12_overlay_test_host\.exe`" pid=$ConnectedPid\r?`$" `
        -AfterIndex $Attaching.Index `
        -Deadline $AttachDeadline
    $InjectorReturned = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^RESHADE_CLIENT_INJECTOR_RETURNED(?: .*)?\r?$' `
        -AfterIndex $InjectorStarted.Index `
        -Deadline $AttachDeadline

    $ReShadeLog = Join-Path $ReShadeRunDirectory "ReShade.log"
    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "Electron ReShade compositor initialized its transport/router core." `
        -Deadline $AttachDeadline `
        -HostProcess $CurrentHostProcess
    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "Redirecting ID3D12Device::CreateCommandQueue" `
        -Deadline $AttachDeadline `
        -HostProcess $CurrentHostProcess
    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "rendered its first transported multi-window scene (2 window(s))." `
        -Deadline $AttachDeadline `
        -HostProcess $CurrentHostProcess

    return [pscustomobject]@{
        Cycle = $Cycle
        CycleDirectory = $CycleDirectory
        TargetDirectory = $TargetDirectory
        TargetExecutablePath = $TargetExecutablePath
        HostProcess = $CurrentHostProcess
        HostWindow = $HostWindow
        HostPid = $ConnectedPid
        ReShadeRunDirectory = $ReShadeRunDirectory
        ReShadeLog = $ReShadeLog
        StartIndex = $AfterIndex
        AttachingIndex = $Attaching.Index
        ConnectedIndex = $Connected.Index
        ConnectedStateIndex = $ConnectedState.Index
        InjectorReturnedIndex = $InjectorReturned.Index
    }
}

function Close-CycleNormallyAndWaitForIdle {
    param(
        [Parameter(Mandatory = $true)]$Cycle,
        [Parameter(Mandatory = $true)][string]$WebSocketUrl
    )

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($Cycle.HostWindow)) {
        throw "Could not make cycle $($Cycle.Cycle) controlled host the foreground window."
    }
    Start-Sleep -Milliseconds 250
    [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
    if (-not $Cycle.HostProcess.WaitForExit(10000)) {
        throw "Released Escape did not normally close cycle $($Cycle.Cycle) controlled host."
    }
    $Cycle.HostProcess.Refresh()
    if ($Cycle.HostProcess.ExitCode -ne 0) {
        throw "Cycle $($Cycle.Cycle) controlled host exited with code $($Cycle.HostProcess.ExitCode)."
    }
    $script:CurrentHostProcess = $null

    $Disconnected = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^RESHADE_CLIENT_TARGET_DISCONNECTED pid=$($Cycle.HostPid)\r?`$" `
        -AfterIndex $Cycle.ConnectedIndex `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    $Idle = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=idle processName=`"d3d12_overlay_test_host\.exe`" pid=$($Cycle.HostPid) reason=target-disconnected\r?`$" `
        -AfterIndex $Cycle.ConnectedStateIndex `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    $FrontendIdle = Wait-ForFrontendIdle `
        -WebSocketUrl $WebSocketUrl `
        -Process $ClientProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))

    return [pscustomobject]@{
        DisconnectedMarkerIndex = $Disconnected.Index
        IdleMarkerIndex = $Idle.Index
        FrontendPhase = $FrontendIdle.phase
        InjectDisabled = $FrontendIdle.injectDisabled
        StatusText = $FrontendIdle.statusText
    }
}

function Test-ReinjectedInputPath {
    param([Parameter(Mandatory = $true)]$Cycle)

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($Cycle.HostWindow)) {
        throw "Could not make the reinjected controlled host the foreground window."
    }
    Start-Sleep -Milliseconds 250
    [ReShadeClientSdkGate.NativeInputMethods]::SendControlI()
    $Enabled = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true\r?$' `
        -AfterIndex $Cycle.ConnectedIndex `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15))

    $BaselineTitle = Wait-ForStableHostTitle `
        -Window $Cycle.HostWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    $BaselineSnapshot = Get-HostInputSnapshot -Title $BaselineTitle
    if (-not $BaselineTitle.Contains("clip=off")) {
        throw "Cursor confinement remained active during reinjected interception: $BaselineTitle"
    }
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($Cycle.HostWindow)) {
        throw "The reinjected target lost foreground ownership during interception."
    }

    $ClientLog = Get-ClientLogText -Path $ClientStdout
    $MainTarget = Get-InputTarget -ClientLog $ClientLog -Role "main"
    $StatusTarget = Get-InputTarget -ClientLog $ClientLog -Role "status"
    $MainCenter = Get-InputTargetCenter -Target $MainTarget
    $StatusCenter = Get-InputTargetCenter -Target $StatusTarget
    $CaptionDrag = Get-MainCaptionDrag -Target $MainTarget

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $Cycle.HostWindow,
        $MainCenter.X,
        $MainCenter.Y
    )
    Start-Sleep -Milliseconds 100
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("reinjected")

    # The status window starts inside the main window's bounds. Move the main
    # overlay aside through the same routed caption drag used by the input gate
    # before proving input against the second composited window.
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $Cycle.HostWindow,
        $CaptionDrag.StartX,
        $CaptionDrag.StartY
    )
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftDown()
    Start-Sleep -Milliseconds 100
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $Cycle.HostWindow,
        $CaptionDrag.EndX,
        $CaptionDrag.EndY
    )
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftUp()
    Start-Sleep -Milliseconds 150

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $Cycle.HostWindow,
        $StatusCenter.X,
        $StatusCenter.Y
    )
    Start-Sleep -Milliseconds 100
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("cycle2")

    $MainValue = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=reinjected\r?$' `
        -AfterIndex $Enabled.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    $StatusValue = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input target=hudhook-status-input-target value="cycle2"\r?$' `
        -AfterIndex $Enabled.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Start-Sleep -Milliseconds 500
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($Cycle.HostWindow)) {
        throw "An Electron backing window stole foreground ownership after reinjection."
    }
    $InterceptedTitle = [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle(
        $Cycle.HostWindow
    )
    if ($InterceptedTitle -ne $BaselineTitle) {
        throw "The reinjected target received overlay input.`nBefore: $BaselineTitle`nAfter:  $InterceptedTitle"
    }

    [ReShadeClientSdkGate.NativeInputMethods]::SendControlI()
    $Disabled = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false\r?$' `
        -AfterIndex $Enabled.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15))

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $Cycle.HostWindow,
        1150,
        650
    )
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    $ReleasedSnapshot = Wait-ForReleasedMouseInput `
        -Window $Cycle.HostWindow `
        -Baseline $BaselineSnapshot `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    if (-not $ReleasedSnapshot.Title.Contains("clip=on")) {
        throw "Cursor confinement was not restored after reinjected release: $($ReleasedSnapshot.Title)"
    }

    return [pscustomobject]@{
        BaselineTitle = $BaselineTitle
        ReleasedTitle = $ReleasedSnapshot.Title
        EnabledMarkerIndex = $Enabled.Index
        MainValueIndex = $MainValue.Index
        StatusValueIndex = $StatusValue.Index
        DisabledMarkerIndex = $Disabled.Index
    }
}

function Assert-CycleLogsClean {
    param([Parameter(Mandatory = $true)]$Cycle)

    $Fault = Select-String `
        -LiteralPath $Cycle.ReShadeLog `
        -Pattern "out of global sequence|router was reset|input.*(failed|error)|queue.*(failed|error)|FATAL" `
        -CaseSensitive:$false
    if ($Fault) {
        throw "Cycle $($Cycle.Cycle) ReShade log reported an input/router fault: $($Fault.Line -join ' | ')"
    }
    $TargetDirectoryLog = Join-Path $Cycle.TargetDirectory "ReShade.log"
    if (Test-Path -LiteralPath $TargetDirectoryLog -PathType Leaf) {
        throw "Cycle $($Cycle.Cycle) wrote an unexpected target-directory log: $TargetDirectoryLog"
    }
}

function Get-OwnedInjectorProcesses {
    $OwnedInjectorPaths = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($Directory in $ReShadeRunDirectories) {
        [void]$OwnedInjectorPaths.Add(
            [IO.Path]::GetFullPath((Join-Path $Directory "inject.exe"))
        )
    }

    # Recover a staged path from the client evidence if the gate failed between
    # the SDK marker and adding it to the in-memory cycle record.
    $ClientLog = Get-ClientLogText -Path $ClientStdout
    foreach ($Match in [regex]::Matches(
            $ClientLog,
            '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(?<directory>.+)\r?$')) {
        try {
            $Directory = $Match.Groups['directory'].Value | ConvertFrom-Json
            if ([IO.Path]::IsPathRooted($Directory)) {
                [void]$OwnedInjectorPaths.Add(
                    [IO.Path]::GetFullPath((Join-Path $Directory "inject.exe"))
                )
            }
        }
        catch {
            # An incomplete evidence line is not enough authority to kill a
            # process. Residual-process verification will report interference.
        }
    }

    @(
        Get-CimInstance Win32_Process -Filter "Name='inject.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                $OwnedInjectorPaths.Contains(
                    [IO.Path]::GetFullPath($_.ExecutablePath)
                )
            }
    )
}

function Stop-ExactReinjectionProcesses {
    if ($CurrentHostProcess) {
        $CurrentHostProcess.Refresh()
        if (-not $CurrentHostProcess.HasExited) {
            $null = $CurrentHostProcess.CloseMainWindow()
            Wait-Process -Id $CurrentHostProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
            $CurrentHostProcess.Refresh()
            if (-not $CurrentHostProcess.HasExited) {
                Stop-Process -Id $CurrentHostProcess.Id -Force -ErrorAction SilentlyContinue
                Wait-Process -Id $CurrentHostProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
            }
        }
    }

    $InjectorProcessIds = @(
        Get-OwnedInjectorProcesses | ForEach-Object { $_.ProcessId }
    )
    foreach ($ProcessId in $InjectorProcessIds) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }

    Stop-AttemptElectronProcesses -UserData $UserData
}

if (-not (Test-Path -LiteralPath $Electron -PathType Leaf)) {
    throw "Electron is unavailable: $Electron"
}
if (-not (Test-Path -LiteralPath $Nx -PathType Leaf)) {
    throw "The local Nx CLI is unavailable: $Nx"
}

$ExistingHosts = Get-MatchingHosts
$ExistingClients = Get-MatchingClientProcesses
$ExistingInjectors = Get-MatchingInjectors
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

    Push-Location $PocRoot
    try {
        & cmake.exe --preset vs2022-x64-electron-core
        if ($LASTEXITCODE -ne 0) {
            throw "CMake configure failed with exit code $LASTEXITCODE."
        }
        & cmake.exe --build $ElectronBuildRoot `
            --config RelWithDebInfo `
            --target $HostTarget `
            --parallel
        if ($LASTEXITCODE -ne 0) {
            throw "The controlled D3D12 host build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $BuiltHost -PathType Leaf)) {
    throw "The controlled D3D12 host is unavailable: $BuiltHost"
}

New-Item -ItemType Directory -Path $RunDirectory | Out-Null
Write-Host ""
Write-Host "Production client/SDK D3D12 same-client reinjection gate"
Write-Host "  - One production Electron client drives both injections through its frontend."
Write-Host "  - The first target exits normally and must return the SDK/UI to idle."
Write-Host "  - The second target must attach with a fresh isolated ReShade runtime."
Write-Host "  - The reinjected target must preserve two-window rendering and input routing."
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
    $DevToolsPort = Get-FreeTcpPort
    $ClientArguments = @(
        "`"$RepoRoot`"",
        "--no-sandbox",
        "--reshade-overlay",
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
    $OriginalClientProcessId = $ClientProcess.Id

    $StartupDeadline = [DateTime]::UtcNow.AddSeconds(120)
    [void](Wait-ForClientRegex `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^RESHADE_CLIENT_CONFIGURED(?: .*)?\r?$' `
            -Deadline $StartupDeadline)
    [void](Wait-ForClientRegex `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^RESHADE_CLIENT_OVERLAY_SESSION_READY(?: .*)?\r?$' `
            -Deadline $StartupDeadline)
    [void](Wait-ForClientRegex `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^OVERLAY_CLIENT_INPUT_TARGET role=main name=text(?: .*)?\r?$' `
            -Deadline $StartupDeadline)
    [void](Wait-ForClientRegex `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^OVERLAY_CLIENT_INPUT_TARGET role=status name=text(?: .*)?\r?$' `
            -Deadline $StartupDeadline)

    $DevToolsPage = Wait-ForDevToolsPage `
        -Port $DevToolsPort `
        -Process $ClientProcess `
        -Deadline $StartupDeadline
    $InitialFrontend = Wait-ForFrontendIdle `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -Process $ClientProcess `
        -Deadline $StartupDeadline

    $InitialClientLog = Get-ClientLogText -Path $ClientStdout
    $Cycle1 = Start-FrontendInjectionCycle `
        -Cycle 1 `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -AfterIndex ($InitialClientLog.Length - 1)
    $Cycle1Idle = Close-CycleNormallyAndWaitForIdle `
        -Cycle $Cycle1 `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl
    Assert-CycleLogsClean -Cycle $Cycle1
    "D3D12_REAL_CLIENT_SDK_REINJECTION_CYCLE_1_PASS" |
        Set-Content `
            -LiteralPath (Join-Path $Cycle1.CycleDirectory "result.txt") `
            -Encoding UTF8
    Write-Host "D3D12_REAL_CLIENT_SDK_REINJECTION_CYCLE_1_PASS"

    $ClientProcess.Refresh()
    if ($ClientProcess.HasExited -or $ClientProcess.Id -ne $OriginalClientProcessId) {
        throw "The production Electron client did not survive the first target lifecycle."
    }

    $AfterCycle1Log = Get-ClientLogText -Path $ClientStdout
    $Cycle2 = Start-FrontendInjectionCycle `
        -Cycle 2 `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -AfterIndex ($AfterCycle1Log.Length - 1)
    if ($Cycle2.HostPid -eq $Cycle1.HostPid) {
        throw "Windows reused target PID $($Cycle2.HostPid); the gate cannot prove PID-specific reinjection. Run it again."
    }
    if ([string]::Equals(
            $Cycle2.ReShadeRunDirectory,
            $Cycle1.ReShadeRunDirectory,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Both frontend injections reused the same ReShade run directory."
    }

    $InputProof = Test-ReinjectedInputPath -Cycle $Cycle2
    $Cycle2Idle = Close-CycleNormallyAndWaitForIdle `
        -Cycle $Cycle2 `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl
    Assert-CycleLogsClean -Cycle $Cycle2
    "D3D12_REAL_CLIENT_SDK_REINJECTION_CYCLE_2_PASS" |
        Set-Content `
            -LiteralPath (Join-Path $Cycle2.CycleDirectory "result.txt") `
            -Encoding UTF8
    Write-Host "D3D12_REAL_CLIENT_SDK_REINJECTION_CYCLE_2_PASS"

    $ClientProcess.Refresh()
    if ($ClientProcess.HasExited -or $ClientProcess.Id -ne $OriginalClientProcessId) {
        throw "The production Electron client did not remain alive through both target cycles."
    }

    $FinalClientLog = Get-ClientLogText -Path $ClientStdout
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^RESHADE_CLIENT_CONFIGURED(?: .*)?\r?$' `
        -Expected 1
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^RESHADE_CLIENT_RUNTIME_STAGED(?: .*)?\r?$' `
        -Expected 2
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^RESHADE_CLIENT_INJECTOR_STARTED(?: .*)?\r?$' `
        -Expected 2
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^RESHADE_CLIENT_INJECTOR_RETURNED(?: .*)?\r?$' `
        -Expected 2
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=\d+\r?$' `
        -Expected 2
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^RESHADE_CLIENT_TARGET_DISCONNECTED pid=\d+\r?$' `
        -Expected 2
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=attaching(?: .*)?\r?$' `
        -Expected 2
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=connected(?: .*)?\r?$' `
        -Expected 2
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=idle(?: .*)?reason=target-disconnected\r?$' `
        -Expected 2
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true\r?$' `
        -Expected 1
    Assert-ClientRegexCount `
        -Text $FinalClientLog `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false\r?$' `
        -Expected 1
    if ($FinalClientLog.Contains("RESHADE_CLIENT_INJECTOR_FAILED") -or
        $FinalClientLog.Contains("ReShade attachment failed")) {
        throw "The production client logged an attachment failure during the passing cycles."
    }

    $FrontendActionRecords = @(
        Get-Content -LiteralPath $FrontendActions | ConvertFrom-Json
    )
    if ($FrontendActionRecords.Count -ne 2 -or
        $FrontendActionRecords[0].Cycle -ne 1 -or
        $FrontendActionRecords[1].Cycle -ne 2 -or
        $FrontendActionRecords[0].ProcessName -ne $HostName -or
        $FrontendActionRecords[1].ProcessName -ne $HostName) {
        throw "Expected exactly one production frontend Inject click for each controlled cycle."
    }

    $CycleResults.Add([pscustomobject]@{
            Cycle = 1
            ClientProcessId = $OriginalClientProcessId
            HostProcessId = $Cycle1.HostPid
            ReShadeRunDirectory = $Cycle1.ReShadeRunDirectory
            FrontendIdle = $Cycle1Idle
        })
    $CycleResults.Add([pscustomobject]@{
            Cycle = 2
            ClientProcessId = $OriginalClientProcessId
            HostProcessId = $Cycle2.HostPid
            ReShadeRunDirectory = $Cycle2.ReShadeRunDirectory
            FrontendIdle = $Cycle2Idle
            InputProof = $InputProof
        })
    [pscustomobject]@{
        Result = $ResultMarker
        InitialFrontend = $InitialFrontend
        ClientProcessId = $OriginalClientProcessId
        Cycles = $CycleResults
    } |
        ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $RunDirectory "summary.json") -Encoding UTF8
}
finally {
    Stop-ExactReinjectionProcesses
    foreach ($VariableName in $ControlledEnvironmentVariables) {
        [Environment]::SetEnvironmentVariable(
            $VariableName,
            $PreviousEnvironment[$VariableName],
            "Process")
    }
}

Start-Sleep -Milliseconds 500
$RemainingElectron = @(
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$UserData*" }
)
$RemainingHosts = Get-MatchingHosts
$RemainingInjectors = Get-MatchingInjectors
if ($RemainingElectron.Count -ne 0 -or
    $RemainingHosts.Count -ne 0 -or
    $RemainingInjectors.Count -ne 0) {
    $ProcessIds = @(
        @($RemainingElectron.ProcessId) +
            @($RemainingHosts.ProcessId) +
            @($RemainingInjectors.ProcessId) |
            Where-Object { $null -ne $_ }
    )
    throw "The reinjection gate left a controlled client/host/injector process behind (PID: $($ProcessIds -join ', '))."
}

$ResultMarker |
    Set-Content -LiteralPath (Join-Path $RunDirectory "result.txt") -Encoding UTF8
Write-Host $ResultMarker
Write-Host "Evidence preserved in: $RunDirectory"
