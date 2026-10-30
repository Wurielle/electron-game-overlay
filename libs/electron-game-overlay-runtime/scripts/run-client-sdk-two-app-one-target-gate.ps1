[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"

# Reuse the controlled D3D11 host, input oracle, SendInput, process cleanup,
# coordinate conversion, and production build paths without running the normal
# single-producer acceptance sequence.
. (Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1") `
    -Backend d3d11 `
    -SkipBuild:$SkipBuild `
    -FunctionsOnly

$D3D11HostName = "d3d11_overlay_test_host.exe"
$D3D11HostTarget = "d3d11_overlay_test_host"
$D3D11BuiltHost = Join-Path $OutputDirectory $D3D11HostName
$RunDirectory = Join-Path `
    $BuildRoot `
    "client-sdk-two-app-one-target-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$ResultMarker = "TWO_APP_ONE_TARGET_REAL_CLIENT_SDK_GATE_PASS"
$Summary = $null
$Failure = $null
$HostProcess = $null
$ClientA = $null
$ClientB = $null
$ClientAMainPage = $null
$ClientBMainPage = $null
$RunDirectories = [Collections.Generic.List[string]]::new()
$BrokerPipeName =
    "electron-game-overlay-acceptance-$PID-$([Guid]::NewGuid().ToString('N'))"
$BrokerPipePath = "\\.\pipe\$BrokerPipeName"

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
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ErrorPath,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][DateTime]$Deadline,
        [int]$AfterIndex = -1,
        [switch]$SamePidConnection
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        $Text = Get-ClientLogText -Path $Path
        $ErrorText = Get-ClientLogText -Path $ErrorPath
        if ($null -eq $Text) {
            $Text = ""
        }
        if ($null -eq $ErrorText) {
            $ErrorText = ""
        }
        foreach ($Match in [regex]::Matches($Text, $Pattern)) {
            if ($Match.Index -gt $AfterIndex) {
                return $Match
            }
        }

        $Combined = "$Text`n$ErrorText"
        if ($Combined.Contains("RESHADE_CLIENT_INJECTOR_FAILED") -or
            $Combined.Contains("ReShade attachment failed")) {
            $KnownBlocker = [regex]::Match(
                $Combined,
                '(target-injection-already-claimed|' +
                    'target-runtime-reuse-too-late|' +
                    'target-runtime-reuse-raced|' +
                    'Overlay target discovery endpoint is already active|' +
                    'Overlay transport discovery endpoint is already active)'
            )
            if ($SamePidConnection -and $KnownBlocker.Success) {
                throw (
                    "Same-PID multi-application acceptance is blocked while " +
                    "waiting for ${Label}: the public SDK could not join the " +
                    "already-owned target session ($($KnownBlocker.Value)). " +
                    "A shared broker/target channel is still required. " +
                    "Inspect $Path and $ErrorPath."
                )
            }
            throw "$Label reported a ReShade attachment failure. Inspect $Path and $ErrorPath."
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "$Label exited while waiting for '$Pattern'. Inspect $Path and $ErrorPath."
        }
        Start-Sleep -Milliseconds 50
    }

    if ($SamePidConnection) {
        throw (
            "Timed out waiting for $Label to join the same target PID. " +
            "This is the same-PID broker acceptance boundary. Inspect $Path " +
            "and $ErrorPath."
        )
    }
    throw "Timed out waiting for $Label pattern '$Pattern'. Inspect $Path."
}

function Wait-ForInjectionOwnerReady {
    param([Parameter(Mandatory = $true)][DateTime]$Deadline)

    while ([DateTime]::UtcNow -lt $Deadline) {
        foreach ($Candidate in @(
                @{
                    Label = "App A"
                    Process = $ClientA
                    Log = $ClientAStdout
                    ErrorLog = $ClientAStderr
                },
                @{
                    Label = "App B"
                    Process = $ClientB
                    Log = $ClientBStdout
                    ErrorLog = $ClientBStderr
                }
            )) {
            $Text = Get-ClientLogText -Path $Candidate.Log
            if ($Text -match
                '(?m)^RESHADE_CLIENT_INJECTOR_RETURNED(?: .*)?\r?$') {
                return $Candidate.Label
            }
            $ErrorText = Get-ClientLogText -Path $Candidate.ErrorLog
            if ($Text.Contains("RESHADE_CLIENT_INJECTOR_FAILED") -or
                $Text.Contains("ReShade attachment failed") -or
                $ErrorText.Contains("ReShade attachment failed")) {
                throw "$($Candidate.Label) failed before the injection owner was ready."
            }
            $Candidate.Process.Refresh()
            if ($Candidate.Process.HasExited) {
                throw "$($Candidate.Label) exited before the injection owner was ready."
            }
        }
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) {
            throw "The controlled target exited before the injection owner was ready."
        }
        Start-Sleep -Milliseconds 50
    }
    throw "Neither producer completed the one permitted target injection."
}

function Wait-ForDevToolsTarget {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Title,
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
                    $_.title -eq $Title -and
                    $_.webSocketDebuggerUrl
                } |
                Select-Object -First 1
            if ($Page) {
                return $Page
            }
        }
        catch {
            # Chromium may still be opening or navigating the target.
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The production Electron client exited before '$Title' became inspectable."
        }
        Start-Sleep -Milliseconds 100
    }

    throw "Timed out waiting for '$Title' at $Endpoint."
}

function Invoke-DevToolsCommand {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][string]$Method,
        [hashtable]$Params = @{}
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
            method = $Method
            params = $Params
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
                        throw "The DevTools socket closed before returning an evaluation result."
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
                throw "DevTools rejected '$Method': $($Response.error.message)"
            }
            return $Response.result
        }
    }
    finally {
        $Cancellation.Dispose()
        $Socket.Dispose()
    }
}

function Invoke-DevToolsExpression {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][string]$Expression
    )

    $Response = Invoke-DevToolsCommand `
        -WebSocketUrl $WebSocketUrl `
        -Method "Runtime.evaluate" `
        -Params @{
            expression = $Expression
            awaitPromise = $true
            returnByValue = $true
        }
    if ($Response.exceptionDetails) {
        $Description = $Response.exceptionDetails.exception.description
        throw "Electron target evaluation failed: $Description"
    }
    return $Response.result.value
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

function Set-ClientOverlayWindowBounds {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][string]$WindowName,
        [Parameter(Mandatory = $true)][int]$X,
        [Parameter(Mandatory = $true)][int]$Y
    )

    $WindowNameJson = $WindowName | ConvertTo-Json -Compress
    return Invoke-DevToolsExpression `
        -WebSocketUrl $WebSocketUrl `
        -Expression @"
(async () => {
  return await window.require('electron').ipcRenderer.invoke(
    'overlay:test-configure-window',
    $WindowNameJson,
    $X,
    $Y
  );
})()
"@
}

function Wait-ForFrontendInputState {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][int]$TargetPid,
        [Parameter(Mandatory = $true)][bool]$Requested,
        [Parameter(Mandatory = $true)][bool]$Effective,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $LastState = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        try {
            $LastState = Get-FrontendState -WebSocketUrl $WebSocketUrl
            if ($LastState.attachment.phase -eq "connected" -and
                [int]$LastState.attachment.pid -eq $TargetPid -and
                [bool]$LastState.inputInterceptRequested -eq $Requested -and
                [bool]$LastState.inputInterceptEffective -eq $Effective) {
                return $LastState
            }
        }
        catch {
            # Renderer hydration or an acknowledgement may still be in flight.
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "$Label exited before reaching the requested/effective input state."
        }
        Start-Sleep -Milliseconds 50
    }

    throw (
        "${Label} did not reach requested=$Requested/effective=${Effective}: " +
        ($LastState | ConvertTo-Json -Depth 6 -Compress)
    )
}

function Configure-ProducerWindow {
    param(
        [Parameter(Mandatory = $true)][string]$ControllerWebSocketUrl,
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][string]$WindowName,
        [Parameter(Mandatory = $true)][string]$ProducerLabel,
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][int]$X,
        [Parameter(Mandatory = $true)][int]$Y,
        [Parameter(Mandatory = $true)][string]$Color,
        [switch]$InputTarget
    )

    $LabelJson = $ProducerLabel | ConvertTo-Json -Compress
    $RoleJson = $Role | ConvertTo-Json -Compress
    $ColorJson = $Color | ConvertTo-Json -Compress
    $TargetIdJson = if ($InputTarget) {
        '"hudhook-client-input-target"'
    }
    else {
        'null'
    }
    $WindowProof = Set-ClientOverlayWindowBounds `
        -WebSocketUrl $ControllerWebSocketUrl `
        -WindowName $WindowName `
        -X $X `
        -Y $Y
    $ContentProof = Invoke-DevToolsExpression `
        -WebSocketUrl $WebSocketUrl `
        -Expression @"
(() => {
  const producerLabel = $LabelJson;
  const role = $RoleJson;
  const color = $ColorJson;

  let badge = document.getElementById('same-pid-producer-label');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'same-pid-producer-label';
    document.body.appendChild(badge);
  }
  badge.textContent = producerLabel + ' / ' + role;
  Object.assign(badge.style, {
    position: 'fixed',
    top: '4px',
    right: '4px',
    zIndex: '2147483647',
    padding: '4px 8px',
    border: '2px solid #ffffff',
    borderRadius: '4px',
    background: color,
    color: '#ffffff',
    font: 'bold 14px monospace',
    pointerEvents: 'none',
  });
  document.title = producerLabel + ' / ' + role;

  const targetId = $TargetIdJson;
  const target = targetId === null ? null : document.getElementById(targetId);
  const targetRect = target ? target.getBoundingClientRect() : null;
  return {
    producerLabel,
    role,
    scale: window.devicePixelRatio,
    target: targetRect ? {
      x: targetRect.x,
      y: targetRect.y,
      width: targetRect.width,
      height: targetRect.height,
    } : null,
  };
})()
"@
    if ([int]$WindowProof.bounds.x -ne $X -or
        [int]$WindowProof.bounds.y -ne $Y) {
        throw (
            "Electron did not move $ProducerLabel/$Role to $X,$Y; " +
            "reported $($WindowProof.bounds.x),$($WindowProof.bounds.y)."
        )
    }
    return [pscustomobject]@{
        producerLabel = $ContentProof.producerLabel
        role = $ContentProof.role
        windowId = [int]$WindowProof.windowId
        bounds = [pscustomobject]@{
            x = [int]$WindowProof.bounds.x
            y = [int]$WindowProof.bounds.y
            width = [int]$WindowProof.bounds.width
            height = [int]$WindowProof.bounds.height
        }
        scale = [double]$ContentProof.scale
        target = $ContentProof.target
    }
}

function Convert-WindowProofToInputTarget {
    param([Parameter(Mandatory = $true)]$Proof)

    if (-not $Proof.target) {
        throw "$($Proof.producerLabel) did not expose its main input target."
    }
    return [pscustomobject]@{
        Role = "main"
        TargetX = [double]$Proof.target.x
        TargetY = [double]$Proof.target.y
        TargetWidth = [double]$Proof.target.width
        TargetHeight = [double]$Proof.target.height
        WindowX = [double]$Proof.bounds.x
        WindowY = [double]$Proof.bounds.y
        WindowWidth = [double]$Proof.bounds.width
        WindowHeight = [double]$Proof.bounds.height
        Scale = [double]$Proof.scale
    }
}

function Reset-ProducerInput {
    param([Parameter(Mandatory = $true)][string]$WebSocketUrl)

    [void](Invoke-DevToolsExpression `
            -WebSocketUrl $WebSocketUrl `
            -Expression @"
(() => {
  const target = document.getElementById('hudhook-client-input-target');
  if (!(target instanceof HTMLInputElement)) {
    throw new Error('The producer input target is unavailable');
  }
  target.value = '';
  target.blur();
  return true;
})()
"@)
}

function Assert-InterceptionMatrixState {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][bool]$ARequested,
        [Parameter(Mandatory = $true)][bool]$BRequested,
        [Parameter(Mandatory = $true)][bool]$Effective,
        [Parameter(Mandatory = $true)][int]$TargetPid
    )

    $Deadline = [DateTime]::UtcNow.AddSeconds(15)
    [void](Wait-ForFrontendInputState `
            -Label "App A" `
            -WebSocketUrl $ClientAMainPage.webSocketDebuggerUrl `
            -Process $ClientA `
            -TargetPid $TargetPid `
            -Requested $ARequested `
            -Effective $Effective `
            -Deadline $Deadline)
    [void](Wait-ForFrontendInputState `
            -Label "App B" `
            -WebSocketUrl $ClientBMainPage.webSocketDebuggerUrl `
            -Process $ClientB `
            -TargetPid $TargetPid `
            -Requested $BRequested `
            -Effective $Effective `
            -Deadline $Deadline)
    return [pscustomobject]@{
        Name = $Name
        AppARequested = $ARequested
        AppBRequested = $BRequested
        TargetEffective = $Effective
    }
}

function Assert-TargetForeground {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$TargetWindow,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow(
            $TargetWindow)) {
        throw "Could not foreground the controlled target before $Label."
    }
    Start-Sleep -Milliseconds 250
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow(
            $TargetWindow)) {
        throw "The controlled target did not retain foreground ownership before $Label."
    }
}

function Test-ProducerInput {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Client,
        [Parameter(Mandatory = $true)][string]$ClientLogPath,
        [Parameter(Mandatory = $true)][string]$ClientErrorPath,
        [Parameter(Mandatory = $true)][string]$OverlayWebSocketUrl,
        [Parameter(Mandatory = $true)]$InputTarget,
        [Parameter(Mandatory = $true)][IntPtr]$TargetWindow,
        [Parameter(Mandatory = $true)][string]$UniqueValue,
        [string]$OtherClientLogPath
    )

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow(
            $TargetWindow)) {
        throw "$Label could not foreground the controlled target."
    }
    Start-Sleep -Milliseconds 250
    $BaselineTitle = Wait-ForStableHostTitle `
        -Window $TargetWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    $Baseline = Get-HostInputSnapshot -Title $BaselineTitle
    if ($Baseline.Clip -ne "off") {
        throw "$Label target retained cursor confinement during interception: $BaselineTitle"
    }

    Reset-ProducerInput -WebSocketUrl $OverlayWebSocketUrl
    $BeforeOwnerLog = Get-ClientLogText -Path $ClientLogPath
    $BeforeOtherLog = if ($OtherClientLogPath) {
        Get-ClientLogText -Path $OtherClientLogPath
    }
    else {
        ""
    }
    $Center = Get-InputTargetCenter -Target $InputTarget
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $Center.X,
        $Center.Y
    )
    Start-Sleep -Milliseconds 100
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 100
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText($UniqueValue)

    $EscapedValue = [regex]::Escape($UniqueValue)
    $ValueMarker = Wait-ForClientRegex `
        -Label $Label `
        -Path $ClientLogPath `
        -ErrorPath $ClientErrorPath `
        -Process $Client `
        -Pattern "(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=$EscapedValue\r?`$" `
        -AfterIndex ($BeforeOwnerLog.Length - 1) `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Start-Sleep -Milliseconds 300

    $InterceptedTitle =
        [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($TargetWindow)
    if ($InterceptedTitle -ne $BaselineTitle) {
        throw "$Label input reached the game.`nBefore: $BaselineTitle`nAfter:  $InterceptedTitle"
    }
    if ($OtherClientLogPath) {
        $OtherLog = Get-ClientLogText -Path $OtherClientLogPath
        $OtherTail = $OtherLog.Substring(
            [Math]::Min($BeforeOtherLog.Length, $OtherLog.Length)
        )
        if ($OtherTail.Contains("HUDHOOK_CLIENT_INPUT_VALUE value=$UniqueValue")) {
            throw "$Label input was delivered to the other Electron producer."
        }
    }

    return [pscustomobject]@{
        Label = $Label
        UniqueValue = $UniqueValue
        LocalWindowId = [int]$InputTarget.LocalWindowId
        Center = $Center
        BaselineTitle = $BaselineTitle
        InterceptedTitle = $InterceptedTitle
        ValueMarkerIndex = $ValueMarker.Index
        GameInputStayedUnchanged = $true
        OtherProducerStayedIsolated = [bool]$OtherClientLogPath
    }
}

function Get-RunDirectoriesFromClientLog {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Text = Get-ClientLogText -Path $Path
    foreach ($Match in [regex]::Matches(
            $Text,
            '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(?<directory>.+)\r?$')) {
        try {
            $Directory = $Match.Groups['directory'].Value | ConvertFrom-Json
            if ([IO.Path]::IsPathRooted($Directory)) {
                [IO.Path]::GetFullPath($Directory)
            }
        }
        catch {
            # Partial log evidence is ignored; later module checks are authoritative.
        }
    }
}

function Get-RegisteredWindowIds {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $Ids = [Collections.Generic.List[int]]::new()
    $Seen = [Collections.Generic.HashSet[int]]::new()
    foreach ($Match in [regex]::Matches(
            (Get-ClientLogText -Path $Path),
            'code=producer-window-registered .*\{ windowId: (?<id>\d+) \}')) {
        $Id = [int]$Match.Groups['id'].Value
        if ($Seen.Add($Id)) {
            $Ids.Add($Id)
        }
    }
    if ($Ids.Count -ne 2) {
        throw "$Label exposed $($Ids.Count) registered overlay window IDs; expected the main and status windows."
    }
    return $Ids.ToArray()
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
    foreach ($LogPath in @($ClientAStdout, $ClientBStdout)) {
        if (-not $LogPath) {
            continue
        }
        foreach ($Directory in @(Get-RunDirectoriesFromClientLog -Path $LogPath)) {
            [void]$Paths.Add(
                [IO.Path]::GetFullPath((Join-Path $Directory "inject.exe"))
            )
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

function Wait-ForRuntimeModuleEvidence {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $LastError = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        try {
            $Process.Refresh()
            if ($Process.HasExited) {
                throw "The controlled host exited before module inspection."
            }
            $Modules = @($Process.Modules | ForEach-Object {
                    [pscustomobject]@{
                        Name = $_.ModuleName
                        Path = $_.FileName
                    }
                })
            $RuntimeModules = @(
                $Modules | Where-Object { $_.Name -ieq "ReShade64.dll" }
            )
            $AddonModules = @(
                $Modules |
                    Where-Object {
                        $_.Name -ieq "electron_game_overlay.addon64"
                    }
            )
            if ($RuntimeModules.Count -eq 1 -and
                $AddonModules.Count -eq 1) {
                return [pscustomobject]@{
                    RuntimeModules = $RuntimeModules
                    AddonModules = $AddonModules
                }
            }
            if ($RuntimeModules.Count -gt 1 -or $AddonModules.Count -gt 1) {
                throw (
                    "The target loaded duplicate overlay runtime/add-on modules: " +
                    "runtime=$($RuntimeModules.Count), addon=$($AddonModules.Count)."
                )
            }
        }
        catch {
            if ($_.Exception.Message -like "The target loaded duplicate*") {
                throw
            }
            $LastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 100
    }
    throw "The controlled fixture did not expose one runtime and one add-on module. Last error: $LastError"
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

function Wait-ForBrokerPipeClosure {
    param([Parameter(Mandatory = $true)][DateTime]$Deadline)

    while ([DateTime]::UtcNow -lt $Deadline) {
        # Test-Path opens a named pipe and would itself reset the broker's idle
        # shutdown timer. Namespace enumeration observes it without connecting.
        $PipeExists = @(
            Get-ChildItem "\\.\pipe\" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq $BrokerPipeName }
        ).Count -ne 0
        if (-not $PipeExists) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "The isolated acceptance broker did not close $BrokerPipePath after its clients exited."
}

function Stop-OwnedProcesses {
    if ($StartupBarrier -and
        (Test-Path -LiteralPath $StartupBarrier -PathType Leaf)) {
        Remove-Item -LiteralPath $StartupBarrier -Force -ErrorAction SilentlyContinue
    }
    if ($HostProcess) {
        try {
            $HostProcess.Refresh()
            if (-not $HostProcess.HasExited) {
                $HostProcess.Kill()
                $null = $HostProcess.WaitForExit(5000)
            }
        }
        catch {
            # Residual-process verification remains authoritative.
        }
    }
    try {
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
    }
    catch {
        # Residual-process verification remains authoritative.
    }
    foreach ($UserData in @($ClientAUserData, $ClientBUserData)) {
        if ($UserData) {
            try {
                Stop-AttemptElectronProcesses -UserData $UserData
            }
            catch {
                # Residual-process verification remains authoritative.
            }
        }
    }
    try {
        Wait-ForBrokerPipeClosure `
            -Deadline ([DateTime]::UtcNow.AddSeconds(45))
    }
    catch {
        if (-not $Failure) {
            throw
        }
        Write-Warning $_.Exception.Message
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
        Where-Object { $_.CommandLine -like "*$D3D11HostName*" }
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
            --target $D3D11HostTarget `
            --parallel
        if ($LASTEXITCODE -ne 0) {
            throw "The controlled D3D11 host build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $D3D11BuiltHost -PathType Leaf)) {
    throw "The controlled D3D11 host is unavailable: $D3D11BuiltHost"
}

$TargetDirectory = Join-Path $RunDirectory "target"
$TargetPath = Join-Path $TargetDirectory $D3D11HostName
$StartupBarrier = Join-Path `
    $TargetDirectory `
    "electron-game-overlay-startup-barrier.enabled"
$ClientADirectory = Join-Path $RunDirectory "app-a"
$ClientBDirectory = Join-Path $RunDirectory "app-b"
$ClientAUserData = Join-Path $ClientADirectory "user-data"
$ClientBUserData = Join-Path $ClientBDirectory "user-data"
$ClientAStdout = Join-Path $ClientADirectory "client.stdout.log"
$ClientAStderr = Join-Path $ClientADirectory "client.stderr.log"
$ClientBStdout = Join-Path $ClientBDirectory "client.stdout.log"
$ClientBStderr = Join-Path $ClientBDirectory "client.stderr.log"
$ClientADevToolsPort = Get-FreeTcpPort
$ClientBDevToolsPort = Get-FreeTcpPort -Excluded @($ClientADevToolsPort)

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $ClientADirectory -Force | Out-Null
New-Item -ItemType Directory -Path $ClientBDirectory -Force | Out-Null
Copy-Item -LiteralPath $D3D11BuiltHost -Destination $TargetPath
New-Item `
    -ItemType File `
    -Path (Join-Path $TargetDirectory "reshade-input-gate.enabled") `
    -Force | Out-Null
New-Item -ItemType File -Path $StartupBarrier -Force | Out-Null

Write-Host ""
Write-Host "Production client/SDK two-app, one-target acceptance gate"
Write-Host "  - Two independent Electron producers attach to one exact D3D11 PID."
Write-Host "  - Process-local BrowserWindow ID collisions are required and recorded."
Write-Host "  - Both labeled scenes, input routing, interception ownership, and abrupt App A loss are proved."
Write-Host "  - The controlled target must load one ReShade runtime and one Electron add-on."
Write-Host "  - Evidence is preserved in: $RunDirectory"
Write-Host ""

$ControlledEnvironmentVariables = @(
    "RESHADE_BASE_PATH_OVERRIDE",
    "RESHADE_DISABLE_GRAPHICS_HOOK",
    "RESHADE_DISABLE_INPUT_HOOK",
    "RESHADE_DISABLE_LOGGING",
    "ELECTRON_GAME_OVERLAY_BROKER_PIPE"
)
$PreviousEnvironment = @{}
foreach ($VariableName in $ControlledEnvironmentVariables) {
    $PreviousEnvironment[$VariableName] =
        [Environment]::GetEnvironmentVariable($VariableName, "Process")
    [Environment]::SetEnvironmentVariable($VariableName, $null, "Process")
}
[Environment]::SetEnvironmentVariable(
    "ELECTRON_GAME_OVERLAY_BROKER_PIPE",
    $BrokerPipePath,
    "Process"
)

try {
    $HostProcess = Start-Process `
        -FilePath $TargetPath `
        -WorkingDirectory $TargetDirectory `
        -PassThru
    Start-Sleep -Milliseconds 250
    $HostProcess.Refresh()
    if ($HostProcess.HasExited) {
        throw "The controlled D3D11 target exited before attachment."
    }

    $TargetIdentity = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId=$($HostProcess.Id)" `
        -ErrorAction SilentlyContinue
    if (-not $TargetIdentity -or
        -not [string]::Equals(
            $TargetIdentity.ExecutablePath,
            $TargetPath,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The controlled target PID resolved to an unexpected executable."
    }

    $CommonArguments = @(
        "`"$RepoRoot`"",
        "--no-sandbox",
        "--reshade-overlay",
        "`"--reshade-auto-target-process=$D3D11HostName`"",
        "--reshade-expected-target-pid=$($HostProcess.Id)",
        "--start-overlay-session",
        "--same-pid-acceptance-test",
        "--remote-allow-origins=*"
    )
    $ClientAArguments = @(
        $CommonArguments +
            "--remote-debugging-port=$ClientADevToolsPort" +
            "`"--user-data-dir=$ClientAUserData`""
    )
    $ClientBArguments = @(
        $CommonArguments +
            "--remote-debugging-port=$ClientBDevToolsPort" +
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

    $StartupDeadline = [DateTime]::UtcNow.AddSeconds(120)
    foreach ($ClientCase in @(
            @{
                Label = "App A"
                Process = $ClientA
                Log = $ClientAStdout
                ErrorLog = $ClientAStderr
            },
            @{
                Label = "App B"
                Process = $ClientB
                Log = $ClientBStdout
                ErrorLog = $ClientBStderr
            }
        )) {
        [void](Wait-ForClientRegex `
                -Label $ClientCase.Label `
                -Path $ClientCase.Log `
                -ErrorPath $ClientCase.ErrorLog `
                -Process $ClientCase.Process `
                -Pattern '(?m)^RESHADE_CLIENT_OVERLAY_SESSION_READY(?: .*)?\r?$' `
                -Deadline $StartupDeadline)
        [void](Wait-ForClientRegex `
                -Label $ClientCase.Label `
                -Path $ClientCase.Log `
                -ErrorPath $ClientCase.ErrorLog `
                -Process $ClientCase.Process `
                -Pattern '(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay severity=info code=producer-frame-publication-started(?: .*)?\r?$' `
                -Deadline $StartupDeadline)
    }

    $ClientAMainPage = Wait-ForDevToolsTarget `
        -Port $ClientADevToolsPort `
        -Title "Electron Game Overlay Demo" `
        -Process $ClientA `
        -Deadline $StartupDeadline
    $ClientBMainPage = Wait-ForDevToolsTarget `
        -Port $ClientBDevToolsPort `
        -Title "Electron Game Overlay Demo" `
        -Process $ClientB `
        -Deadline $StartupDeadline
    $ClientAOverlayPage = Wait-ForDevToolsTarget `
        -Port $ClientADevToolsPort `
        -Title "Example Main Overlay" `
        -Process $ClientA `
        -Deadline $StartupDeadline
    $ClientBOverlayPage = Wait-ForDevToolsTarget `
        -Port $ClientBDevToolsPort `
        -Title "Example Main Overlay" `
        -Process $ClientB `
        -Deadline $StartupDeadline
    $ClientAStatusPage = Wait-ForDevToolsTarget `
        -Port $ClientADevToolsPort `
        -Title "Example Status Overlay" `
        -Process $ClientA `
        -Deadline $StartupDeadline
    $ClientBStatusPage = Wait-ForDevToolsTarget `
        -Port $ClientBDevToolsPort `
        -Title "Example Status Overlay" `
        -Process $ClientB `
        -Deadline $StartupDeadline
    $ClientAWindowIds = Get-RegisteredWindowIds `
        -Label "App A" `
        -Path $ClientAStdout
    $ClientBWindowIds = Get-RegisteredWindowIds `
        -Label "App B" `
        -Path $ClientBStdout

    $AppAMainProof = Configure-ProducerWindow `
        -ControllerWebSocketUrl $ClientAMainPage.webSocketDebuggerUrl `
        -WebSocketUrl $ClientAOverlayPage.webSocketDebuggerUrl `
        -WindowName "example-main-overlay" `
        -ProducerLabel "APP A" `
        -Role "MAIN" `
        -X 40 `
        -Y 80 `
        -Color "#b91c1c" `
        -InputTarget
    $AppBMainProof = Configure-ProducerWindow `
        -ControllerWebSocketUrl $ClientBMainPage.webSocketDebuggerUrl `
        -WebSocketUrl $ClientBOverlayPage.webSocketDebuggerUrl `
        -WindowName "example-main-overlay" `
        -ProducerLabel "APP B" `
        -Role "MAIN" `
        -X 600 `
        -Y 300 `
        -Color "#1d4ed8" `
        -InputTarget
    $AppAStatusProof = Configure-ProducerWindow `
        -ControllerWebSocketUrl $ClientAMainPage.webSocketDebuggerUrl `
        -WebSocketUrl $ClientAStatusPage.webSocketDebuggerUrl `
        -WindowName "example-status-overlay" `
        -ProducerLabel "APP A" `
        -Role "STATUS" `
        -X 40 `
        -Y 12 `
        -Color "#b91c1c"
    $AppBStatusProof = Configure-ProducerWindow `
        -ControllerWebSocketUrl $ClientBMainPage.webSocketDebuggerUrl `
        -WebSocketUrl $ClientBStatusPage.webSocketDebuggerUrl `
        -WindowName "example-status-overlay" `
        -ProducerLabel "APP B" `
        -Role "STATUS" `
        -X 1040 `
        -Y 12 `
        -Color "#1d4ed8"

    if ($AppAMainProof.windowId -notin $ClientAWindowIds -or
        $AppAStatusProof.windowId -notin $ClientAWindowIds -or
        $AppBMainProof.windowId -notin $ClientBWindowIds -or
        $AppBStatusProof.windowId -notin $ClientBWindowIds) {
        throw "A configured BrowserWindow ID was absent from its public SDK registration diagnostics."
    }
    if ([int]$AppAMainProof.windowId -ne [int]$AppBMainProof.windowId -or
        [int]$AppAStatusProof.windowId -ne [int]$AppBStatusProof.windowId) {
        throw (
            "The two independent producers did not expose the deliberate " +
            "process-local BrowserWindow ID collisions: " +
            "A=$($AppAMainProof.windowId),$($AppAStatusProof.windowId); " +
            "B=$($AppBMainProof.windowId),$($AppBStatusProof.windowId)."
        )
    }
    $AppAInputTarget = Convert-WindowProofToInputTarget $AppAMainProof
    $AppBInputTarget = Convert-WindowProofToInputTarget $AppBMainProof
    $AppAInputTarget | Add-Member `
        -NotePropertyName LocalWindowId `
        -NotePropertyValue ([int]$AppAMainProof.windowId)
    $AppBInputTarget | Add-Member `
        -NotePropertyName LocalWindowId `
        -NotePropertyValue ([int]$AppBMainProof.windowId)

    foreach ($Directory in @(
            Get-RunDirectoriesFromClientLog -Path $ClientAStdout
            Get-RunDirectoriesFromClientLog -Path $ClientBStdout
        )) {
        if ($Directory -and -not $RunDirectories.Contains($Directory)) {
            $RunDirectories.Add($Directory)
        }
    }

    # The fixture barrier holds device creation so both producers can publish
    # their initial scene and exact-PID lease before ReShade initializes. A
    # staging marker immediately precedes the public target authorization; wait
    # for both, then give the two local pipe writes one bounded scheduling turn
    # before accepting the elected owner's completed injection.
    foreach ($ClientCase in @(
            @{
                Label = "App A"
                Process = $ClientA
                Log = $ClientAStdout
                ErrorLog = $ClientAStderr
            },
            @{
                Label = "App B"
                Process = $ClientB
                Log = $ClientBStdout
                ErrorLog = $ClientBStderr
            }
        )) {
        [void](Wait-ForClientRegex `
                -Label $ClientCase.Label `
                -Path $ClientCase.Log `
                -ErrorPath $ClientCase.ErrorLog `
                -Process $ClientCase.Process `
                -Pattern '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=.+\r?$' `
                -Deadline $StartupDeadline)
    }
    Start-Sleep -Milliseconds 500
    $InjectionOwnerLabel = Wait-ForInjectionOwnerReady `
        -Deadline $StartupDeadline
    Remove-Item -LiteralPath $StartupBarrier -Force
    $TargetWindow = Wait-ForHostWindow `
        -HostProcess $HostProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))

    foreach ($ClientCase in @(
            @{
                Label = "App A"
                Process = $ClientA
                Log = $ClientAStdout
                ErrorLog = $ClientAStderr
            },
            @{
                Label = "App B"
                Process = $ClientB
                Log = $ClientBStdout
                ErrorLog = $ClientBStderr
            }
        )) {
        [void](Wait-ForClientRegex `
                -Label $ClientCase.Label `
                -Path $ClientCase.Log `
                -ErrorPath $ClientCase.ErrorLog `
                -Process $ClientCase.Process `
                -Pattern "(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=$($HostProcess.Id)\r?`$" `
                -Deadline $StartupDeadline `
                -SamePidConnection)
    }

    foreach ($Directory in @(
            Get-RunDirectoriesFromClientLog -Path $ClientAStdout
            Get-RunDirectoriesFromClientLog -Path $ClientBStdout
        )) {
        if ($Directory -and -not $RunDirectories.Contains($Directory)) {
            $RunDirectories.Add($Directory)
        }
    }

    $ModuleEvidence = Wait-ForRuntimeModuleEvidence `
        -Process $HostProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    $ReShadeLogCandidates = @(
        foreach ($Directory in $RunDirectories) {
            Join-Path $Directory "ReShade.log"
        }
        foreach ($RuntimeModule in $ModuleEvidence.RuntimeModules) {
            Join-Path (Split-Path -Parent $RuntimeModule.Path) "ReShade.log"
        }
    )
    $ReShadeLog = $null
    $LogDeadline = [DateTime]::UtcNow.AddSeconds(120)
    while ([DateTime]::UtcNow -lt $LogDeadline -and -not $ReShadeLog) {
        $ReShadeLog = $ReShadeLogCandidates |
            Where-Object {
                (Test-Path -LiteralPath $_ -PathType Leaf) -and
                (Select-String `
                    -LiteralPath $_ `
                    -SimpleMatch "Redirecting D3D11CreateDeviceAndSwapChain" `
                    -Quiet)
            } |
            Select-Object -First 1
        if (-not $ReShadeLog) {
            $HostProcess.Refresh()
            if ($HostProcess.HasExited) {
                throw "The controlled target exited before publishing ReShade evidence."
            }
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $ReShadeLog) {
        throw "No staged run exposed the controlled target's ReShade log."
    }
    # Executable validation intentionally defers each producer's target scene
    # until the runtime authenticates. The native runtime's one-shot marker can
    # sample either the elected app's two-window scene or the fully merged
    # four-window scene. Treat it only as render readiness; the app-local input
    # and crash-survivor proofs below verify both producers were materialized.
    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "rendered its first transported multi-window scene (" `
        -Deadline $LogDeadline `
        -HostProcess $HostProcess

    $ReShadeLogText = Get-Content -Raw -LiteralPath $ReShadeLog
    $AddonRegistrationCount = ([regex]::Matches(
            $ReShadeLogText,
            'Registered add-on "Electron Game Overlay Runtime"'
        )).Count
    $RuntimeInitializationCount = ([regex]::Matches(
            $ReShadeLogText,
            'Electron game overlay runtime initialized its transport and input router\.'
        )).Count
    if ($AddonRegistrationCount -ne 1 -or
        $RuntimeInitializationCount -ne 1) {
        throw (
            "The controlled target did not expose exactly one runtime/add-on " +
            "initialization (registration=$AddonRegistrationCount, " +
            "initialization=$RuntimeInitializationCount)."
        )
    }

    $Matrix = [Collections.Generic.List[object]]::new()
    $Matrix.Add((Assert-InterceptionMatrixState `
                -Name "00" `
                -ARequested $false `
                -BRequested $false `
                -Effective $false `
                -TargetPid $HostProcess.Id))

    Assert-TargetForeground `
        -TargetWindow $TargetWindow `
        -Label "App A interception"
    [void](Set-FrontendIntercept `
            -WebSocketUrl $ClientAMainPage.webSocketDebuggerUrl `
            -Intercept $true)
    $Matrix.Add((Assert-InterceptionMatrixState `
                -Name "10" `
                -ARequested $true `
                -BRequested $false `
                -Effective $true `
                -TargetPid $HostProcess.Id))
    $AppAInputProof = Test-ProducerInput `
        -Label "App A" `
        -Client $ClientA `
        -ClientLogPath $ClientAStdout `
        -ClientErrorPath $ClientAStderr `
        -OverlayWebSocketUrl $ClientAOverlayPage.webSocketDebuggerUrl `
        -InputTarget $AppAInputTarget `
        -TargetWindow $TargetWindow `
        -UniqueValue "alpha" `
        -OtherClientLogPath $ClientBStdout

    Assert-TargetForeground `
        -TargetWindow $TargetWindow `
        -Label "App B interception"
    [void](Set-FrontendIntercept `
            -WebSocketUrl $ClientBMainPage.webSocketDebuggerUrl `
            -Intercept $true)
    $Matrix.Add((Assert-InterceptionMatrixState `
                -Name "11" `
                -ARequested $true `
                -BRequested $true `
                -Effective $true `
                -TargetPid $HostProcess.Id))

    [void](Set-FrontendIntercept `
            -WebSocketUrl $ClientAMainPage.webSocketDebuggerUrl `
            -Intercept $false)
    $Matrix.Add((Assert-InterceptionMatrixState `
                -Name "01" `
                -ARequested $false `
                -BRequested $true `
                -Effective $true `
                -TargetPid $HostProcess.Id))
    $AppBInputProof = Test-ProducerInput `
        -Label "App B" `
        -Client $ClientB `
        -ClientLogPath $ClientBStdout `
        -ClientErrorPath $ClientBStderr `
        -OverlayWebSocketUrl $ClientBOverlayPage.webSocketDebuggerUrl `
        -InputTarget $AppBInputTarget `
        -TargetWindow $TargetWindow `
        -UniqueValue "bravo" `
        -OtherClientLogPath $ClientAStdout

    [void](Set-FrontendIntercept `
            -WebSocketUrl $ClientAMainPage.webSocketDebuggerUrl `
            -Intercept $true)
    $Matrix.Add((Assert-InterceptionMatrixState `
                -Name "11-before-app-a-crash" `
                -ARequested $true `
                -BRequested $true `
                -Effective $true `
                -TargetPid $HostProcess.Id))

    $ClientBLogBeforeCrash = Get-ClientLogText -Path $ClientBStdout
    Stop-Process -Id $ClientA.Id -Force
    if (-not $ClientA.WaitForExit(10000)) {
        throw "App A did not terminate after the forced crash."
    }
    Stop-AttemptElectronProcesses -UserData $ClientAUserData

    $ClientB.Refresh()
    $HostProcess.Refresh()
    if ($ClientB.HasExited -or $HostProcess.HasExited) {
        throw "App B or the target exited when App A was force-killed."
    }
    [void](Wait-ForFrontendInputState `
            -Label "App B after App A crash" `
            -WebSocketUrl $ClientBMainPage.webSocketDebuggerUrl `
            -Process $ClientB `
            -TargetPid $HostProcess.Id `
            -Requested $true `
            -Effective $true `
            -Deadline ([DateTime]::UtcNow.AddSeconds(15)))
    $ClientBLogAfterCrash = Get-ClientLogText -Path $ClientBStdout
    $ClientBTailAfterCrash = $ClientBLogAfterCrash.Substring(
        [Math]::Min(
            $ClientBLogBeforeCrash.Length,
            $ClientBLogAfterCrash.Length
        )
    )
    if ($ClientBTailAfterCrash.Contains(
            "RESHADE_CLIENT_TARGET_DISCONNECTED pid=$($HostProcess.Id)")) {
        throw "App B disconnected from the target when App A crashed."
    }
    $AppBSurvivorInputProof = Test-ProducerInput `
        -Label "App B after App A crash" `
        -Client $ClientB `
        -ClientLogPath $ClientBStdout `
        -ClientErrorPath $ClientBStderr `
        -OverlayWebSocketUrl $ClientBOverlayPage.webSocketDebuggerUrl `
        -InputTarget $AppBInputTarget `
        -TargetWindow $TargetWindow `
        -UniqueValue "survivor"

    [void](Set-FrontendIntercept `
            -WebSocketUrl $ClientBMainPage.webSocketDebuggerUrl `
            -Intercept $false)
    [void](Wait-ForFrontendInputState `
            -Label "App B final release" `
            -WebSocketUrl $ClientBMainPage.webSocketDebuggerUrl `
            -Process $ClientB `
            -TargetPid $HostProcess.Id `
            -Requested $false `
            -Effective $false `
            -Deadline ([DateTime]::UtcNow.AddSeconds(15)))
    $Matrix.Add([pscustomobject]@{
            Name = "00-after-app-a-crash"
            AppARequested = $false
            AppBRequested = $false
            TargetEffective = $false
        })

    $ReleasedBaselineTitle = Wait-ForStableHostTitle `
        -Window $TargetWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    $ReleasedBaseline = Get-HostInputSnapshot -Title $ReleasedBaselineTitle
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        1150,
        690
    )
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    $Released = Wait-ForReleasedMouseInput `
        -Window $TargetWindow `
        -Baseline $ReleasedBaseline `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    if ($Released.Clip -ne "on") {
        throw "The surviving producer did not restore game cursor confinement."
    }

    $HostProcess.Kill()
    if (-not $HostProcess.WaitForExit(10000)) {
        throw "The controlled target did not exit after the acceptance proof."
    }
    [void](Wait-ForClientRegex `
            -Label "App B" `
            -Path $ClientBStdout `
            -ErrorPath $ClientBStderr `
            -Process $ClientB `
            -Pattern "(?m)^RESHADE_CLIENT_TARGET_DISCONNECTED pid=$($HostProcess.Id)\r?`$" `
            -Deadline ([DateTime]::UtcNow.AddSeconds(20)))

    $Summary = [ordered]@{
        Result = $ResultMarker
        TargetPid = $HostProcess.Id
        TargetPath = $TargetPath
        ProducerProcesses = [ordered]@{
            AppA = $ClientA.Id
            AppB = $ClientB.Id
        }
        LocalWindowIds = [ordered]@{
            AppA = @(
                [int]$AppAMainProof.windowId,
                [int]$AppAStatusProof.windowId
            )
            AppB = @(
                [int]$AppBMainProof.windowId,
                [int]$AppBStatusProof.windowId
            )
            CollisionsProved = $true
        }
        Labels = @(
            $AppAMainProof.producerLabel,
            $AppBMainProof.producerLabel
        )
        RuntimeOwnership = [ordered]@{
            IsolatedBrokerPipe = $BrokerPipePath
            InjectionOwner = $InjectionOwnerLabel
            RuntimeModules = @($ModuleEvidence.RuntimeModules.Path)
            AddonModules = @($ModuleEvidence.AddonModules.Path)
            AddonRegistrationCount = $AddonRegistrationCount
            RuntimeInitializationCount = $RuntimeInitializationCount
            ReShadeLog = $ReShadeLog
        }
        InterceptionMatrix = @($Matrix)
        InputProofs = @(
            $AppAInputProof,
            $AppBInputProof,
            $AppBSurvivorInputProof
        )
        AppAWasForceKilled = $true
        AppBStayedConnectedAfterAppACrash = $true
        AppBStayedInteractiveAfterAppACrash = $true
        ReleasedGameInput = $Released.Title
        EvidenceDirectory = $RunDirectory
    }
    $Summary |
        ConvertTo-Json -Depth 10 |
        Set-Content -LiteralPath (Join-Path $RunDirectory "summary.json")

    Close-ClientThroughDevTools `
        -WebSocketUrl $ClientBMainPage.webSocketDebuggerUrl `
        -Process $ClientB
}
catch {
    $Failure = [ordered]@{
        Result = "TWO_APP_ONE_TARGET_REAL_CLIENT_SDK_GATE_FAIL"
        Message = $_.Exception.Message
        TargetPid = if ($HostProcess) { $HostProcess.Id } else { $null }
        ClientAPid = if ($ClientA) { $ClientA.Id } else { $null }
        ClientBPid = if ($ClientB) { $ClientB.Id } else { $null }
        EvidenceDirectory = $RunDirectory
        ClientALog = $ClientAStdout
        ClientAErrorLog = $ClientAStderr
        ClientBLog = $ClientBStdout
        ClientBErrorLog = $ClientBStderr
        StagedRunDirectories = @($RunDirectories)
        TimestampUtc = [DateTime]::UtcNow.ToString("o")
    }
    try {
        New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null
        $Failure |
            ConvertTo-Json -Depth 6 |
            Set-Content -LiteralPath (Join-Path $RunDirectory "failure.json")
    }
    catch {
        # Preserve the original acceptance failure.
    }
    throw
}
finally {
    try {
        Stop-OwnedProcesses
    }
    finally {
        foreach ($VariableName in $ControlledEnvironmentVariables) {
            [Environment]::SetEnvironmentVariable(
                $VariableName,
                $PreviousEnvironment[$VariableName],
                "Process"
            )
        }
    }
}

if (-not $Summary) {
    throw "The two-app/one-target gate did not complete."
}

$ResidualHosts = Get-MatchingHosts
$ResidualClients = @(
    Get-CimInstance `
        Win32_Process `
        -Filter "Name='electron.exe'" `
        -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -like "*$ClientAUserData*" -or
            $_.CommandLine -like "*$ClientBUserData*"
        }
)
$ResidualInjectors = @(Get-ScopedInjectors)
if ($ResidualHosts.Count -ne 0 -or
    $ResidualClients.Count -ne 0 -or
    $ResidualInjectors.Count -ne 0) {
    $ProcessIds = @(
        @($ResidualHosts.ProcessId) +
            @($ResidualClients.ProcessId) +
            @($ResidualInjectors.ProcessId) |
            Where-Object { $null -ne $_ }
    )
    throw "The two-app/one-target gate left an owned process behind (PID: $($ProcessIds -join ', '))."
}

$Summary | ConvertTo-Json -Depth 10
Write-Host $ResultMarker
