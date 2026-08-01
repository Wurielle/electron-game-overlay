[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d11", "d3d12")]
    [string]$Backend,
    [switch]$ExistingCompatibleRuntime,
    [string]$OfficialRuntimePath,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ExpectedAddonBuildId = "35F42D2906734EBC86A250968E1EB0EE"

# Reuse the production client gate's window, input-oracle, coordinate, and
# process-cleanup helpers without running that gate.
#
# Scope: this deterministic gate proves the normally initialized target process
# exists before the production exact-PID request and that injection finishes
# behind a pre-device startup barrier. It does not claim arbitrary games expose
# that barrier or that post-swapchain injection works.
. (Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1") `
    -Backend $Backend `
    -SkipBuild:$SkipBuild `
    -FunctionsOnly

$OfficialAddonMode =
    -not [string]::IsNullOrWhiteSpace($OfficialRuntimePath)
if ($OfficialAddonMode -and $Backend -ne "d3d11") {
    throw "The controlled official ReShade add-on gate currently supports D3D11 only."
}
if ($OfficialAddonMode -and $ExistingCompatibleRuntime) {
    throw "OfficialRuntimePath cannot be combined with ExistingCompatibleRuntime."
}

$GateSlug = if ($OfficialAddonMode) {
    "official-reshade-addon"
}
elseif ($ExistingCompatibleRuntime) {
    "shared-runtime"
}
else {
    "process-start"
}
$RunDirectory = Join-Path `
    $BuildRoot `
    "client-sdk-$Backend-$GateSlug-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$TargetDirectory = Join-Path $RunDirectory "target"
$TargetExecutablePath = Join-Path $TargetDirectory $HostName
$StartupBarrierPath =
    Join-Path $TargetDirectory "electron-game-overlay-startup-barrier.enabled"
$ExistingRuntimeDirectory = if ($ExistingCompatibleRuntime -or $OfficialAddonMode) {
    $TargetDirectory
}
else {
    Join-Path $RunDirectory "existing-runtime"
}
$RuntimeDistributionDirectory = Join-Path $RuntimeRoot "dist\win32-x64"
$AddonManagerPath = Join-Path `
    $RuntimeDistributionDirectory `
    "electron_game_overlay_reshade_manager.exe"
$ProductionAddonPath =
    Join-Path $OutputDirectory "electron_game_overlay.addon64"
$OfficialTargetRuntimePath = Join-Path $TargetDirectory "dxgi.dll"
$OfficialTargetAddonPath =
    Join-Path $TargetDirectory "electron_game_overlay.addon64"
$OfficialTargetOwnershipMarkerPath =
    Join-Path $TargetDirectory ".electron-game-overlay-addon.json"
$OfficialTargetConfigurationPath = Join-Path $TargetDirectory "ReShade.ini"
$OfficialTargetPresetPath =
    Join-Path $TargetDirectory "ReShadePreset.ini"
$OfficialTargetForeignAddonPath =
    Join-Path $TargetDirectory "existing-installation-canary.addon64"
$OfficialTargetEffectsDirectory =
    Join-Path $TargetDirectory "existing-effects\nested"
$OfficialTargetTexturesDirectory =
    Join-Path $TargetDirectory "existing-textures\nested"
$OfficialManagedRelativePaths = @(
    [IO.Path]::GetFileName($OfficialTargetAddonPath)
    [IO.Path]::GetFileName($OfficialTargetOwnershipMarkerPath)
)
$OfficialAllowedRuntimeCreatedRelativePaths = @(
    $OfficialManagedRelativePaths
    "ReShade.log"
)
$OfficialStaticDiscoveryPath = $null
$OfficialTargetSeedManifest = $null
$OfficialTargetPreparedManifest = $null
$UserData = Join-Path $RunDirectory "user-data"
$ClientStdout = Join-Path $RunDirectory "client.stdout.log"
$ClientStderr = Join-Path $RunDirectory "client.stderr.log"
$FrontendActions = Join-Path $RunDirectory "frontend-actions.jsonl"
$RuntimeStartupFileName = ".electron-game-overlay-runtime-startup.json"
$ResultMarker = if ($OfficialAddonMode) {
    "${BackendLabel}_REAL_CLIENT_SDK_OFFICIAL_RESHADE_ADDON_GATE_PASS"
}
elseif ($ExistingCompatibleRuntime) {
    "${BackendLabel}_REAL_CLIENT_SDK_SHARED_RUNTIME_GATE_PASS"
}
else {
    "${BackendLabel}_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS"
}
$OfficialQuickInputFailureMarker =
    "${BackendLabel}_REAL_CLIENT_SDK_OFFICIAL_RESHADE_INPUT_GATE_FAIL"
$ClientProcess = $null
$HostProcess = $null
$ReShadeRunDirectory = $null
$ExistingRuntimeArtifactHashes = $null
$HostExitedNormally = $false
$OfficialQuickInputFailure = $null
$OfficialInputIsolationFailure = $null
$OfficialGateFailure = $null

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

    $InspectOnce = $true
    while ($InspectOnce -or [DateTime]::UtcNow -lt $Deadline) {
        $InspectOnce = $false
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
        Start-Sleep -Milliseconds 50
    }

    throw "Timed out waiting for client pattern '$Pattern'. Inspect $Path."
}

function Find-ClientRegexUntil {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][DateTime]$Deadline,
        [int]$AfterIndex = -1
    )

    $InspectOnce = $true
    while ($InspectOnce -or [DateTime]::UtcNow -lt $Deadline) {
        $InspectOnce = $false
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
        if ([DateTime]::UtcNow -ge $Deadline) {
            break
        }
        Start-Sleep -Milliseconds 25
    }
    return $null
}

function Wait-ForRuntimeStartupRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $AllowedCodes = @(
        "bridge-thread-started",
        "bridge-thread-create-failed",
        "bridge-window-create-failed",
        "bridge-window-ready",
        "discovery-not-ready",
        "discovery-document-invalid",
        "discovery-version-mismatch",
        "discovery-target-mismatch",
        "loopback-connect-failed",
        "loopback-configuration-failed",
        "process-hello-build-failed",
        "network-worker-start-failed",
        "network-worker-started",
        "network-connection-lost",
        "bridge-message-pump-failed"
    )
    $LastCode = "not-observed"

    while ([DateTime]::UtcNow -lt $Deadline) {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $Bytes = [IO.File]::ReadAllBytes($Path)
            if ($Bytes.Length -gt 256) {
                throw "The runtime startup record exceeded its 256-byte protocol bound: $Path"
            }
            $RecordText = [Text.Encoding]::UTF8.GetString($Bytes)
            if ($RecordText.Contains('\')) {
                throw "The runtime startup record used a non-canonical JSON escape: $Path"
            }
            $Record = $RecordText | ConvertFrom-Json
            $PropertyNames = @(
                $Record.PSObject.Properties.Name |
                    Sort-Object
            )
            if (($PropertyNames -join ",") -ne
                "code,pid,schemaVersion,source") {
                throw "The runtime startup record did not contain the exact fixed schema: $Path"
            }
            foreach ($PropertyName in @(
                    "schemaVersion",
                    "source",
                    "pid",
                    "code"
                )) {
                $PropertyPattern =
                    '"' + [regex]::Escape($PropertyName) + '"\s*:'
                if ([regex]::Matches(
                        $RecordText,
                        $PropertyPattern
                    ).Count -ne 1) {
                    throw "The runtime startup record repeated or omitted a fixed field: $Path"
                }
            }
            if ($Record -isnot [pscustomobject] -or
                $Record.schemaVersion -isnot [int] -or
                $Record.schemaVersion -ne 1 -or
                $Record.source -isnot [string] -or
                $Record.source -cne "electron-game-overlay-runtime" -or
                $Record.pid -isnot [int] -or
                $Record.pid -ne $ExpectedProcessId -or
                $Record.code -isnot [string] -or
                $AllowedCodes -cnotcontains $Record.code) {
                throw "The runtime startup record failed fixed field validation: $Path"
            }

            $LastCode = [string]$Record.code
            if ($LastCode -eq "network-worker-started") {
                return $Record
            }
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The controlled host exited while waiting for runtime startup evidence (last code: $LastCode)."
        }
        Start-Sleep -Milliseconds 50
    }

    throw "Timed out waiting for the runtime network worker startup record (last code: $LastCode). Inspect $Path."
}

function Wait-ForDevToolsPage {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][DateTime]$Deadline,
        [string]$Title = "Electron Game Overlay Demo"
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
            # Chromium may not have opened its debugging endpoint yet.
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The production Electron client exited before its frontend became inspectable."
        }
        Start-Sleep -Milliseconds 100
    }

    throw "Timed out waiting for the production client page '$Title' at $Endpoint."
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
  const processPid = document.getElementById('process-pid');
  return {
    phase: status?.dataset.attachmentPhase ?? document.body.dataset.attachmentPhase ?? null,
    injectDisabled: inject?.disabled ?? null,
    processName: processName?.value ?? null,
    processPid: processPid?.value ?? null,
    statusText: status?.textContent ?? null
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
            throw "The production Electron client exited before the frontend became idle."
        }
        Start-Sleep -Milliseconds 100
    }

    throw "The frontend did not become idle with injection enabled. Last state: $($LastSnapshot | ConvertTo-Json -Compress)"
}

function Invoke-ExactFrontendInjection {
    param(
        [Parameter(Mandatory = $true)][string]$WebSocketUrl,
        [Parameter(Mandatory = $true)][string]$ProcessName,
        [Parameter(Mandatory = $true)][int]$ProcessId
    )

    $ProcessNameJson = $ProcessName | ConvertTo-Json -Compress
    $ProcessIdJson = $ProcessId | ConvertTo-Json -Compress
    $Result = Invoke-DevToolsExpression -WebSocketUrl $WebSocketUrl -Expression @"
(() => {
  const processName = document.getElementById('process-name');
  const processPid = document.getElementById('process-pid');
  const button = document.getElementById('inject');
  if (!(processName instanceof HTMLInputElement) ||
      !(processPid instanceof HTMLInputElement) ||
      !(button instanceof HTMLButtonElement)) {
    throw new Error('The production exact-PID injection controls are unavailable');
  }
  if (button.disabled) {
    throw new Error('The production Inject button is disabled');
  }
  processName.value = $ProcessNameJson;
  processName.dispatchEvent(new Event('input', { bubbles: true }));
  processPid.value = String($ProcessIdJson);
  processPid.dispatchEvent(new Event('input', { bubbles: true }));
  const clickedUtc = new Date().toISOString();
  button.click();
  return {
    processName: processName.value,
    processPid: processPid.value,
    clickedUtc,
    buttonDisabledAfterClick: button.disabled
  };
})()
"@

    if ($Result.processName -ne $ProcessName -or
        [int]$Result.processPid -ne $ProcessId -or
        -not $Result.buttonDisabledAfterClick) {
        throw "The production frontend did not dispatch an exact-PID injection for $ProcessName PID $ProcessId."
    }
    $Record = [pscustomobject]@{
        Utc = $Result.clickedUtc
        Action = "frontend-exact-pid-inject-click"
        ProcessName = $Result.processName
        ProcessId = [int]$Result.processPid
        ButtonDisabledAfterClick = $Result.buttonDisabledAfterClick
    }
    $Record | ConvertTo-Json -Compress |
        Add-Content -LiteralPath $FrontendActions -Encoding UTF8
    return $Record
}

function Get-StagedRunDirectoryFromMatch {
    param([Parameter(Mandatory = $true)][Text.RegularExpressions.Match]$Match)

    $Directory = $Match.Groups['directory'].Value | ConvertFrom-Json
    if (-not [IO.Path]::IsPathRooted($Directory)) {
        throw "The SDK staged a non-absolute ReShade run directory: $Directory"
    }
    return [IO.Path]::GetFullPath($Directory)
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
    if ($Target -and
        [string]::Equals(
            $Target.ExecutablePath,
            $ExpectedPath,
            [StringComparison]::OrdinalIgnoreCase)) {
        return
    }
    throw "Controlled target PID $ProcessId came from an unexpected path/command: path=$($Target.ExecutablePath) command=$($Target.CommandLine)"
}

function Get-TargetFileManifest {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Root = [IO.Path]::GetFullPath($Path)
    $RootPrefix = $Root
    if (-not $RootPrefix.EndsWith(
            [string][IO.Path]::DirectorySeparatorChar,
            [StringComparison]::Ordinal)) {
        $RootPrefix += [IO.Path]::DirectorySeparatorChar
    }
    return @(
        Get-ChildItem -LiteralPath $Root -Recurse -File |
            Sort-Object FullName |
            ForEach-Object {
                $FullPath = [IO.Path]::GetFullPath($_.FullName)
                if (-not $FullPath.StartsWith(
                        $RootPrefix,
                        [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Target manifest escaped its controlled root: $FullPath"
                }
                [pscustomobject]@{
                    RelativePath = $FullPath.Substring($RootPrefix.Length)
                    Length = [int64]$_.Length
                    Attributes = [string]$_.Attributes
                    LastWriteTimeUtc = $_.LastWriteTimeUtc.ToString("o")
                    Sha256 = (
                        Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName
                    ).Hash
                }
            }
    )
}

function Assert-OfficialTargetFilesPreserved {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object[]]$Before,
        [string[]]$AllowedRemovedRelativePaths = @(
            [IO.Path]::GetFileName($StartupBarrierPath)
        ),
        [string[]]$AllowedCreatedRelativePaths = @("ReShade.log")
    )

    $AllowedRemoved = @($AllowedRemovedRelativePaths)
    $AllowedCreated = @($AllowedCreatedRelativePaths)
    $After = @(Get-TargetFileManifest -Path $Path)
    $AfterByPath = @{}
    foreach ($Entry in $After) {
        $AfterByPath[$Entry.RelativePath] = $Entry
    }
    foreach ($Entry in $Before) {
        if ($AllowedRemoved -icontains $Entry.RelativePath) {
            continue
        }
        $Actual = $AfterByPath[$Entry.RelativePath]
        if ($null -eq $Actual) {
            throw "Official ReShade gate removed pre-existing target file '$($Entry.RelativePath)'."
        }
        if ($Actual.Length -ne $Entry.Length -or
            $Actual.Attributes -cne $Entry.Attributes -or
            $Actual.LastWriteTimeUtc -cne $Entry.LastWriteTimeUtc -or
            $Actual.Sha256 -cne $Entry.Sha256) {
            throw "Official ReShade gate modified pre-existing target file '$($Entry.RelativePath)'."
        }
    }

    $BeforePaths = @{}
    foreach ($Entry in $Before) {
        $BeforePaths[$Entry.RelativePath] = $true
    }
    foreach ($Entry in $After) {
        if ($BeforePaths.ContainsKey($Entry.RelativePath) -or
            $AllowedCreated -icontains $Entry.RelativePath) {
            continue
        }
        throw (
            "Official ReShade gate created unexpected target file " +
            "'$($Entry.RelativePath)'; allowed creations are: " +
            ($AllowedCreated -join ", ")
        )
    }
}

function Wait-ForStaticDiscoveryRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int]$ExpectedProducerPid,
        [Parameter(Mandatory = $true)][int]$ExpectedTargetPid,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $Bytes = [IO.File]::ReadAllBytes($Path)
            if ($Bytes.Length -gt 4096) {
                throw "The static exact-PID discovery record exceeded its bounded schema: $Path"
            }
            $Record = [Text.Encoding]::UTF8.GetString($Bytes) |
                ConvertFrom-Json
            $Properties = @($Record.PSObject.Properties.Name | Sort-Object)
            if (($Properties -join ",") -cne
                "pid,port,targetPid,token,version") {
                throw "The static exact-PID discovery schema was not exact: $($Properties -join ',')"
            }
            if ($Record.version -ne 1 -or
                $Record.pid -ne $ExpectedProducerPid -or
                $Record.targetPid -ne $ExpectedTargetPid -or
                $Record.port -isnot [int] -or
                $Record.port -le 0 -or
                $Record.port -gt 65535 -or
                $Record.token -isnot [string] -or
                $Record.token -notmatch '^[0-9a-f]{64}$') {
                throw "The static exact-PID discovery record failed validation: $($Record | ConvertTo-Json -Compress)"
            }
            return $Record
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The production Electron client exited before publishing static exact-PID discovery."
        }
        Start-Sleep -Milliseconds 25
    }

    throw "Timed out waiting for static exact-PID discovery: $Path"
}

function Wait-ForOfficialTelemetry {
    param(
        [Parameter(Mandatory = $true)][string]$MainWebSocketUrl,
        [Parameter(Mandatory = $true)][string]$StatusWebSocketUrl,
        [Parameter(Mandatory = $true)][int]$ExpectedTargetPid,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $LastSurface = $null
    $LastFpsText = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        try {
            $LastSurface = Invoke-DevToolsExpression `
                -WebSocketUrl $MainWebSocketUrl `
                -Expression @"
(async () => {
  const { ipcRenderer } = require('electron');
  const state = await ipcRenderer.invoke('overlay:get-state');
  return state?.targetSurface ?? null;
})()
"@
            $LastFpsText = Invoke-DevToolsExpression `
                -WebSocketUrl $StatusWebSocketUrl `
                -Expression @"
(() => document.getElementById('label')?.textContent ?? null)()
"@
            $FpsMatch = [regex]::Match(
                [string]$LastFpsText,
                '^fps:\s*(?<fps>\d+(?:\.\d+)?)$'
            )
            if ($null -ne $LastSurface -and
                $LastSurface.pid -eq $ExpectedTargetPid -and
                $LastSurface.graphicsApi -ceq "d3d11" -and
                $LastSurface.renderSize.width -eq 1280 -and
                $LastSurface.renderSize.height -eq 720 -and
                $LastSurface.surfaceId -match '^0x[1-9a-f][0-9a-f]{0,15}$' -and
                $LastSurface.hwnd -match '^0x[1-9a-f][0-9a-f]{0,15}$' -and
                $FpsMatch.Success -and
                [double]::Parse(
                    $FpsMatch.Groups['fps'].Value,
                    [Globalization.CultureInfo]::InvariantCulture
                ) -gt 0) {
                return [pscustomobject]@{
                    TargetSurface = $LastSurface
                    FpsText = [string]$LastFpsText
                    Fps = [double]::Parse(
                        $FpsMatch.Groups['fps'].Value,
                        [Globalization.CultureInfo]::InvariantCulture
                    )
                }
            }
        }
        catch {
            # Offscreen renderer state may be between frame publications.
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The production Electron client exited before target surface/FPS telemetry was observed."
        }
        Start-Sleep -Milliseconds 100
    }

    throw "Timed out waiting for official ReShade target telemetry. Last surface=$($LastSurface | ConvertTo-Json -Compress) fps=$LastFpsText"
}

if ($OfficialAddonMode -and
    -not ("OfficialReShadeGate.PresentBoundary" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace OfficialReShadeGate
{
    public static class PresentBoundary
    {
        private const uint THREAD_SUSPEND_RESUME = 0x0002;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(
            IntPtr window,
            IntPtr processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenThread(
            uint desiredAccess,
            bool inheritHandle,
            uint threadId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint SuspendThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        public static IntPtr SuspendWindowThread(IntPtr window)
        {
            uint threadId = GetWindowThreadProcessId(window, IntPtr.Zero);
            if (threadId == 0)
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "GetWindowThreadProcessId failed.");

            IntPtr thread = OpenThread(THREAD_SUSPEND_RESUME, false, threadId);
            if (thread == IntPtr.Zero)
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "OpenThread failed.");
            if (SuspendThread(thread) == UInt32.MaxValue)
            {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(thread);
                throw new Win32Exception(error, "SuspendThread failed.");
            }
            return thread;
        }

        public static void ResumeWindowThread(IntPtr thread)
        {
            try
            {
                if (ResumeThread(thread) == UInt32.MaxValue)
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "ResumeThread failed.");
            }
            finally
            {
                CloseHandle(thread);
            }
        }
    }
}
"@
}

function Send-OverlayOracleLeftClick {
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
}

function Send-OverlayOracleEscape {
    [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
}

function Test-OverlayInputAndRelease {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$TargetWindow,
        [Parameter(Mandatory = $true)][int]$ConnectedMarkerIndex
    )

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($TargetWindow)) {
        throw "Could not make the controlled $BackendLabel host the foreground window."
    }
    Start-Sleep -Milliseconds 250
    [ReShadeClientSdkGate.NativeInputMethods]::SendControlI()
    $Enabled = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true\r?$' `
        -AfterIndex $ConnectedMarkerIndex `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15))

    $BaselineTitle = Wait-ForStableHostTitle `
        -Window $TargetWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    $BaselineSnapshot = Get-HostInputSnapshot -Title $BaselineTitle
    if (-not $BaselineTitle.Contains("clip=off")) {
        throw "Cursor confinement remained active during interception: $BaselineTitle"
    }
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($TargetWindow)) {
        throw "The controlled target lost foreground ownership during interception."
    }

    $ClientLog = Get-ClientLogText -Path $ClientStdout
    $MainTarget = Get-InputTarget -ClientLog $ClientLog -Role "main"
    $StatusTarget = Get-InputTarget -ClientLog $ClientLog -Role "status"
    $MainCenter = Get-InputTargetCenter -Target $MainTarget
    $StatusCenter = Get-InputTargetCenter -Target $StatusTarget
    $CaptionDrag = Get-MainCaptionDrag -Target $MainTarget
    $QuickBetweenPresentsProof = $null
    $MainValuePrefix = "processstart"
    $StatusValuePrefix = "exactpid"

    if ($OfficialAddonMode) {
        # The controlled host has one UI/render thread. Suspending it while
        # SendInput queues a complete click (including the host's enabled
        # mouse-to-pointer promotion) plus Unicode key down/up while this
        # thread cannot present. That guarantees those events are drained
        # between presentations.
        # This is stricter than merely sending a fast pair at normal frame rate
        # while avoiding a production-only throttle knob in the host.
        [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
            $TargetWindow,
            $StatusCenter.X,
            $StatusCenter.Y
        )
        Start-Sleep -Milliseconds 100
        Send-OverlayOracleLeftClick
        $QuickFocus = Wait-ForClientRegex `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC focusin target=hudhook-status-input-target\r?$' `
            -AfterIndex $Enabled.Index `
            -Deadline ([DateTime]::UtcNow.AddSeconds(10))
        Start-Sleep -Milliseconds 100
        $QuickBoundaryIndex =
            (Get-ClientLogText -Path $ClientStdout).Length - 1
        $SuspendedAt = [DateTime]::UtcNow
        $WindowThread =
            [OfficialReShadeGate.PresentBoundary]::SuspendWindowThread(
                $TargetWindow
        )
        try {
            [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
            [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("q")
            $QueuedAt = [DateTime]::UtcNow
        }
        finally {
            [OfficialReShadeGate.PresentBoundary]::ResumeWindowThread(
                $WindowThread
            )
            $ResumedAt = [DateTime]::UtcNow
        }

        $QuickDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $QuickClick = Find-ClientRegexUntil `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC click target=hudhook-status-input-target @ \d+,\d+\r?$' `
            -AfterIndex $QuickBoundaryIndex `
            -Deadline $QuickDeadline
        $QuickKey = Find-ClientRegexUntil `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC keydown target=hudhook-status-input-target\r?$' `
            -AfterIndex $QuickBoundaryIndex `
            -Deadline $QuickDeadline
        $QuickValue = Find-ClientRegexUntil `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input target=hudhook-status-input-target value="q"\r?$' `
            -AfterIndex $QuickBoundaryIndex `
            -Deadline $QuickDeadline
        if ($null -ne $QuickValue) {
            $StatusValuePrefix = "qexactpid"
        }
        $MissingQuickEvents = @(
            if ($null -eq $QuickClick) { "click" }
            if ($null -eq $QuickKey) { "keydown" }
            if ($null -eq $QuickValue) { "text" }
        )
        if ($MissingQuickEvents.Count -ne 0) {
            $script:OfficialQuickInputFailure =
                "Official ReShade lost rapid between-presents event(s): " +
                ($MissingQuickEvents -join ", ")
        }
        $PointerSequenceMarker =
            "Electron game overlay official-host message hook observed and " +
            "withheld a primary pointer update/down/up sequence."
        Wait-ForReShadeMarker `
            -Path $OfficialReShadeLog `
            -Marker $PointerSequenceMarker `
            -Deadline ([DateTime]::UtcNow.AddSeconds(5)) `
            -HostProcess $HostProcess
        $QuickBetweenPresentsProof = [pscustomobject]@{
            Method =
                "queued SendInput mouse down/up with enabled mouse-to-pointer promotion and Unicode key down/up while the target UI/present thread was suspended"
            LowFpsThrottleAvailable = $false
            InputProcessing = 0
            MessagePumpHooks = "WH_GETMESSAGE plus same-thread window subclass"
            FocusEstablishedBeforeSuspension = $true
            PointerUpdateDownUpObserved = $true
            PointerSequenceLogMarker = $PointerSequenceMarker
            PointerFocusMarkerIndex = $QuickFocus.Index
            PointerClickMarkerIndex = if ($null -eq $QuickClick) {
                $null
            }
            else {
                $QuickClick.Index
            }
            PreQueueClientLogBoundaryIndex = $QuickBoundaryIndex
            SuspendedUtc = $SuspendedAt.ToString("o")
            QueuedUtc = $QueuedAt.ToString("o")
            ResumedUtc = $ResumedAt.ToString("o")
            ClickDelivered = $null -ne $QuickClick
            KeyDownDelivered = $null -ne $QuickKey
            TextDelivered = $null -ne $QuickValue
            ClickMarkerIndex = if ($null -eq $QuickClick) {
                $null
            }
            else {
                $QuickClick.Index
            }
            KeyDownMarkerIndex = if ($null -eq $QuickKey) {
                $null
            }
            else {
                $QuickKey.Index
            }
            TextMarkerIndex = if ($null -eq $QuickValue) {
                $null
            }
            else {
                $QuickValue.Index
            }
        }
    }

    # Prove the initially topmost status window before focusing the main window.
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $StatusCenter.X,
        $StatusCenter.Y
    )
    Start-Sleep -Milliseconds 100
    Send-OverlayOracleLeftClick
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("exactpid")
    $StatusValueBeforeDrag = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input target=hudhook-status-input-target value=`"$StatusValuePrefix`"\r?`$" `
        -AfterIndex $Enabled.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $MainCenter.X,
        $MainCenter.Y
    )
    Start-Sleep -Milliseconds 100
    Send-OverlayOracleLeftClick
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("processstart")
    $MainValueBeforeDrag = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=$MainValuePrefix\r?`$" `
        -AfterIndex $StatusValueBeforeDrag.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))

    Send-OverlayOracleEscape
    $EscapeForwarded = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_ESCAPE_FORWARDED\r?$' `
        -AfterIndex $MainValueBeforeDrag.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Start-Sleep -Milliseconds 250
    $HostProcess.Refresh()
    if ($HostProcess.HasExited) {
        throw "Intercepted Escape reached the controlled $BackendLabel host."
    }

    # Move the focused main overlay away from the status overlay. The follow-up
    # click at the moved text-field coordinates proves the new main placement;
    # the subsequent status click proves the stale main bounds no longer cover it.
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $CaptionDrag.StartX,
        $CaptionDrag.StartY
    )
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftDown()
    Start-Sleep -Milliseconds 100
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $CaptionDrag.EndX,
        $CaptionDrag.EndY
    )
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftUp()
    Start-Sleep -Milliseconds 500

    $MovedMainCenter = [pscustomobject]@{
        X = $MainCenter.X + ($CaptionDrag.EndX - $CaptionDrag.StartX)
        Y = $MainCenter.Y + ($CaptionDrag.EndY - $CaptionDrag.StartY)
    }
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $MovedMainCenter.X,
        $MovedMainCenter.Y
    )
    Start-Sleep -Milliseconds 100
    Send-OverlayOracleLeftClick
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("moved")
    $MovedMainValue = "${MainValuePrefix}moved"
    $MainValueAfterDrag = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=$MovedMainValue\r?`$" `
        -AfterIndex $MainValueBeforeDrag.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Start-Sleep -Milliseconds 300

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $StatusCenter.X,
        $StatusCenter.Y
    )
    Start-Sleep -Milliseconds 100
    Send-OverlayOracleLeftClick
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("again")
    $StatusValueAfterDragExpected = "${StatusValuePrefix}again"
    $StatusValueAfterDrag = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input target=hudhook-status-input-target value=`"$StatusValueAfterDragExpected`"\r?`$" `
        -AfterIndex $StatusValueBeforeDrag.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Start-Sleep -Milliseconds 500
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($TargetWindow)) {
        throw "An Electron backing window stole foreground ownership."
    }
    $InterceptedTitle = [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle(
        $TargetWindow
    )
    $InterceptedSnapshot = Get-HostInputSnapshot -Title $InterceptedTitle
    $GameMessageInputSuppressed =
        $InterceptedSnapshot.Move -eq $BaselineSnapshot.Move -and
        $InterceptedSnapshot.Down -eq $BaselineSnapshot.Down -and
        $InterceptedSnapshot.Up -eq $BaselineSnapshot.Up -and
        $InterceptedSnapshot.Wheel -eq $BaselineSnapshot.Wheel -and
        $InterceptedSnapshot.Key -eq $BaselineSnapshot.Key -and
        $InterceptedSnapshot.Raw -eq $BaselineSnapshot.Raw -and
        $InterceptedSnapshot.PointerUpdate -eq
            $BaselineSnapshot.PointerUpdate -and
        $InterceptedSnapshot.PointerDown -eq
            $BaselineSnapshot.PointerDown -and
        $InterceptedSnapshot.PointerUp -eq
            $BaselineSnapshot.PointerUp -and
        $InterceptedSnapshot.Clip -ceq $BaselineSnapshot.Clip
    $PollingInputUnchanged =
        $InterceptedSnapshot.PollLeft -eq $BaselineSnapshot.PollLeft
    $CursorMutationUnchanged =
        $InterceptedSnapshot.CursorChange -eq
            $BaselineSnapshot.CursorChange
    if (-not $GameMessageInputSuppressed) {
        $IsolationFailure =
            "The controlled target received intercepted message/raw/pointer input. " +
            "Before: $BaselineTitle After: $InterceptedTitle"
        if ($OfficialAddonMode) {
            $script:OfficialInputIsolationFailure = $IsolationFailure
        }
        else {
            throw $IsolationFailure
        }
    }

    [ReShadeClientSdkGate.NativeInputMethods]::SendControlI()
    $Disabled = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false\r?$' `
        -AfterIndex $Enabled.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15))

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        1150,
        650
    )
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    $ReleasedSnapshot = Wait-ForReleasedMouseInput `
        -Window $TargetWindow `
        -Baseline $BaselineSnapshot `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    if (-not $ReleasedSnapshot.Title.Contains("clip=on")) {
        throw "Cursor confinement was not restored after release: $($ReleasedSnapshot.Title)"
    }

    return [pscustomobject]@{
        BaselineTitle = $BaselineTitle
        InterceptedTitle = $InterceptedTitle
        GameInputSuppressed = $GameMessageInputSuppressed
        GameMessageInputSuppressed = $GameMessageInputSuppressed
        PollingInputUnchanged = $PollingInputUnchanged
        CursorMutationUnchanged = $CursorMutationUnchanged
        ReleasedTitle = $ReleasedSnapshot.Title
        EnabledMarkerIndex = $Enabled.Index
        MainValueBeforeDragMarkerIndex = $MainValueBeforeDrag.Index
        StatusValueBeforeDragMarkerIndex = $StatusValueBeforeDrag.Index
        EscapeForwardedMarkerIndex = $EscapeForwarded.Index
        MainValueAfterDragMarkerIndex = $MainValueAfterDrag.Index
        StatusValueAfterDragMarkerIndex = $StatusValueAfterDrag.Index
        DisabledMarkerIndex = $Disabled.Index
        QuickBetweenPresentsProof = $QuickBetweenPresentsProof
    }
}

function Get-OwnedInjectorProcesses {
    $Paths = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    if ($ReShadeRunDirectory) {
        [void]$Paths.Add(
            [IO.Path]::GetFullPath((Join-Path $ReShadeRunDirectory "inject.exe"))
        )
    }

    $ClientLog = Get-ClientLogText -Path $ClientStdout
    foreach ($Match in [regex]::Matches(
            $ClientLog,
            '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(?<directory>.+)\r?$')) {
        try {
            $Directory = $Match.Groups['directory'].Value | ConvertFrom-Json
            if ([IO.Path]::IsPathRooted($Directory)) {
                [void]$Paths.Add(
                    [IO.Path]::GetFullPath((Join-Path $Directory "inject.exe"))
                )
            }
        }
        catch {
            # Partial evidence is not authority to terminate another process.
        }
    }

    @(
        Get-CimInstance Win32_Process -Filter "Name='inject.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                $Paths.Contains([IO.Path]::GetFullPath($_.ExecutablePath))
            }
    )
}

function Stop-OwnedProcesses {
    $HostCleanupError = $null
    try {
        if ($HostProcess) {
            $HostProcess.Refresh()
            if (-not $HostProcess.HasExited) {
                # This Process object and handle came directly from this gate's
                # CreateProcess call, so it is stronger cleanup authority than
                # a name search (and remains valid before image initialization).
                $HostProcess.Kill()
                $null = $HostProcess.WaitForExit(5000)
            }
        }
    }
    catch {
        $HostCleanupError = $_
    }

    foreach ($Injector in @(Get-OwnedInjectorProcesses)) {
        Stop-Process -Id $Injector.ProcessId -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $Injector.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
    Stop-AttemptElectronProcesses -UserData $UserData
    if ($HostCleanupError) {
        throw $HostCleanupError
    }
}

if (-not (Test-Path -LiteralPath $Electron -PathType Leaf)) {
    throw "Electron is unavailable: $Electron"
}
if (-not (Test-Path -LiteralPath $Nx -PathType Leaf)) {
    throw "The local Nx CLI is unavailable: $Nx"
}
if ($OfficialAddonMode) {
    if (-not (Test-Path -LiteralPath $OfficialRuntimePath -PathType Leaf)) {
        throw "The official/stock ReShade runtime is unavailable: $OfficialRuntimePath"
    }
    $OfficialRuntimePath = (
        Resolve-Path -LiteralPath $OfficialRuntimePath -ErrorAction Stop
    ).Path
    if ([IO.Path]::GetExtension($OfficialRuntimePath) -ine ".dll") {
        throw "OfficialRuntimePath must identify the official x64 ReShade DLL: $OfficialRuntimePath"
    }
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

    Push-Location $RuntimeRoot
    try {
        & cmake.exe --preset vs2022-x64-production
        if ($LASTEXITCODE -ne 0) {
            throw "CMake configure failed with exit code $LASTEXITCODE."
        }
        $BuildTargets = @($HostTarget)
        if ($OfficialAddonMode) {
            $BuildTargets += "electron_game_overlay"
        }
        & cmake.exe --build $ProductionBuildRoot `
            --config RelWithDebInfo `
            --target $BuildTargets `
            --parallel
        if ($LASTEXITCODE -ne 0) {
            throw "The controlled $BackendLabel host build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $BuiltHost -PathType Leaf)) {
    throw "The controlled $BackendLabel host is unavailable: $BuiltHost"
}
if ($OfficialAddonMode -and
    -not (Test-Path -LiteralPath $ProductionAddonPath -PathType Leaf)) {
    throw "The production Electron overlay add-on is unavailable: $ProductionAddonPath"
}
if ($OfficialAddonMode -and
    -not (Test-Path -LiteralPath $AddonManagerPath -PathType Leaf)) {
    throw "The packaged ReShade add-on manager is unavailable: $AddonManagerPath"
}
if ($ExistingCompatibleRuntime) {
    foreach ($ArtifactName in @("ReShade64.dll", "ReShade.ini")) {
        $ArtifactPath = Join-Path $RuntimeDistributionDirectory $ArtifactName
        if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) {
            throw "The shared-runtime fixture artifact is unavailable: $ArtifactPath"
        }
    }
}

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination $TargetExecutablePath
New-Item `
    -ItemType File `
    -Path (Join-Path $TargetDirectory "reshade-input-gate.enabled") `
    -Force | Out-Null
New-Item -ItemType File -Path $StartupBarrierPath -Force | Out-Null
if ($ExistingCompatibleRuntime) {
    # Model a game that already ships a compatible ReShade installation:
    # loading the runtime as the local DXGI proxy happens before the controlled
    # entry-point barrier, just as it does for an existing modded game.
    Copy-Item `
        -LiteralPath (Join-Path $RuntimeDistributionDirectory "ReShade64.dll") `
        -Destination (Join-Path $ExistingRuntimeDirectory "dxgi.dll")
    Copy-Item `
        -LiteralPath (Join-Path $RuntimeDistributionDirectory "ReShade.ini") `
        -Destination (Join-Path $ExistingRuntimeDirectory "ReShade.ini")
}
elseif ($OfficialAddonMode) {
    # Model a game with the official full-add-on ReShade proxy already
    # installed. The add-on uses ReShade's default base/add-on directory and
    # is present before process start, which is the supported stock lifecycle.
    Copy-Item `
        -LiteralPath $OfficialRuntimePath `
        -Destination $OfficialTargetRuntimePath
    New-Item `
        -ItemType Directory `
        -Path $OfficialTargetEffectsDirectory `
        -Force | Out-Null
    New-Item `
        -ItemType Directory `
        -Path (Join-Path $OfficialTargetEffectsDirectory "include") `
        -Force | Out-Null
    New-Item `
        -ItemType Directory `
        -Path $OfficialTargetTexturesDirectory `
        -Force | Out-Null
    @"
[INSTALL]
BasePath=.

[ADDON]
AddonPath=.
DisabledAddons=Existing Installation Canary@existing-installation-canary.addon64

[GENERAL]
EffectSearchPaths=.\existing-effects
IntermediateCachePath=.\cache
NoDebugInfo=1
PerformanceMode=0
PresetPath=.\ReShadePreset.ini
SkipLoadingDisabledEffects=1
TextureSearchPaths=.\existing-textures

[INPUT]
InputProcessing=0

[OVERLAY]
ShowFPS=0
TutorialProgress=4
"@ | Set-Content `
        -LiteralPath $OfficialTargetConfigurationPath `
        -Encoding UTF8
    @"
[GENERAL]
PreprocessorDefinitions=
Techniques=
TechniqueSorting=
"@ | Set-Content `
        -LiteralPath $OfficialTargetPresetPath `
        -Encoding UTF8
    @"
Existing installation add-on canary.
The seeded ReShade configuration disables this filename before discovery.
"@ | Set-Content `
        -LiteralPath $OfficialTargetForeignAddonPath `
        -Encoding UTF8
    @"
// Existing installation effect canary in a recursive asset directory.
// The empty preset and SkipLoadingDisabledEffects keep it inactive.
"@ | Set-Content `
        -LiteralPath (
            Join-Path `
                $OfficialTargetEffectsDirectory `
                "existing-installation-canary.fx"
        ) `
        -Encoding UTF8
    @"
// Existing installation nested include canary.
"@ | Set-Content `
        -LiteralPath (
            Join-Path `
                $OfficialTargetEffectsDirectory `
                "include\existing-installation-canary.fxh"
        ) `
        -Encoding UTF8
    $OfficialOnePixelPng = [Convert]::FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    [IO.File]::WriteAllBytes(
        (Join-Path `
            $OfficialTargetTexturesDirectory `
            "existing-installation-canary.png"),
        $OfficialOnePixelPng
    )
    # Stock ReShade serializes normalized defaults on shutdown. Make only its
    # pre-existing configuration and preset immutable so the gate isolates
    # project writes while every other installation canary remains writable.
    Set-ItemProperty `
        -LiteralPath $OfficialTargetConfigurationPath `
        -Name IsReadOnly `
        -Value $true
    Set-ItemProperty `
        -LiteralPath $OfficialTargetPresetPath `
        -Name IsReadOnly `
        -Value $true
    $OfficialTargetSeedManifest =
        @(Get-TargetFileManifest -Path $TargetDirectory)
    $OfficialTargetSeedManifest |
        ConvertTo-Json -Depth 3 |
        Set-Content `
            -LiteralPath (
                Join-Path `
                    $RunDirectory `
                    "official-target-manifest-before-preparation.json"
            ) `
            -Encoding UTF8
    $OfficialRuntimeHash = (
        Get-FileHash `
            -LiteralPath $OfficialTargetRuntimePath `
            -Algorithm SHA256
    ).Hash
    $ProductionAddonHash = (
        Get-FileHash `
            -LiteralPath $ProductionAddonPath `
            -Algorithm SHA256
    ).Hash
    $ManagerOutput = @(
        & $AddonManagerPath `
            prepare `
            --directory $TargetDirectory `
            --source $ProductionAddonPath `
            --source-sha256 $ProductionAddonHash `
            --reshade-module $OfficialTargetRuntimePath `
            --reshade-module-sha256 $OfficialRuntimeHash
    )
    $ManagerExitCode = $LASTEXITCODE
    if ($ManagerExitCode -ne 0 -or $ManagerOutput.Count -ne 1) {
        throw (
            "The packaged add-on manager could not seed the controlled " +
            "official ReShade installation (exit $ManagerExitCode): " +
            ($ManagerOutput -join "`n")
        )
    }
    try {
        $ManagerResult = $ManagerOutput[0] | ConvertFrom-Json
    }
    catch {
        throw (
            "The packaged add-on manager returned invalid JSON: " +
            $ManagerOutput[0]
        )
    }
    if ($ManagerResult.schemaVersion -ne 1 -or
        $ManagerResult.kind -cne
            "electron-game-overlay-reshade-addon-manager-result" -or
        $ManagerResult.operation -cne "prepare" -or
        $ManagerResult.status -cne "installed" -or
        $ManagerResult.addonSha256 -cne $ProductionAddonHash -or
        $ManagerResult.expectedAddonSha256 -cne $ProductionAddonHash -or
        $ManagerResult.reshadeModuleSha256 -cne $OfficialRuntimeHash -or
        -not ([string]$ManagerResult.addonPath).Equals(
            [IO.Path]::GetFullPath($OfficialTargetAddonPath),
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not ([string]$ManagerResult.markerPath).Equals(
            [IO.Path]::GetFullPath($OfficialTargetOwnershipMarkerPath),
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not ([string]$ManagerResult.reshadeModulePath).Equals(
            [IO.Path]::GetFullPath($OfficialTargetRuntimePath),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw (
            "The packaged add-on manager returned an unexpected install " +
            "contract: " +
            ($ManagerResult | ConvertTo-Json -Compress)
        )
    }
    try {
        $OwnershipMarker =
            Get-Content `
                -LiteralPath $OfficialTargetOwnershipMarkerPath `
                -Raw |
                ConvertFrom-Json
    }
    catch {
        throw (
            "The packaged manager did not create a valid ownership marker: " +
            $OfficialTargetOwnershipMarkerPath
        )
    }
    if ($OwnershipMarker.schemaVersion -ne 1 -or
        $OwnershipMarker.kind -cne
            "electron-game-overlay-reshade-addon" -or
        $OwnershipMarker.addonFileName -cne
            "electron_game_overlay.addon64" -or
        $OwnershipMarker.addonSha256 -cne $ProductionAddonHash -or
        $OwnershipMarker.reshadeModuleSha256 -cne $OfficialRuntimeHash -or
        -not ([string]$OwnershipMarker.addonPath).Equals(
            [IO.Path]::GetFullPath($OfficialTargetAddonPath),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw (
            "The packaged manager created an unexpected ownership marker: " +
            ($OwnershipMarker | ConvertTo-Json -Compress)
        )
    }
    Assert-OfficialTargetFilesPreserved `
        -Path $TargetDirectory `
        -Before $OfficialTargetSeedManifest `
        -AllowedRemovedRelativePaths @() `
        -AllowedCreatedRelativePaths $OfficialManagedRelativePaths
    $OfficialTargetPreparedManifest =
        @(Get-TargetFileManifest -Path $TargetDirectory)
    $OfficialTargetPreparedManifest |
        ConvertTo-Json -Depth 3 |
        Set-Content `
            -LiteralPath (
                Join-Path `
                    $RunDirectory `
                    "official-target-manifest-after-preparation.json"
            ) `
            -Encoding UTF8
}

Write-Host ""
Write-Host "Production client/SDK $BackendLabel $GateSlug exact-PID injection gate"
Write-Host "  - The real Electron client/session starts without an automatic target."
Write-Host "  - The controlled host starts normally behind a pre-device startup barrier."
if ($OfficialAddonMode) {
    Write-Host "  - Exact official ReShade 6.7.3 full x64 and the production API-18 add-on are installed before target launch."
    Write-Host "  - Existing configuration, preset, nested effects/textures, and a disabled foreign add-on were fingerprinted before manager preparation."
    Write-Host "  - The host reaches graphics startup before the production exact-PID attach."
    Write-Host "  - The injector must report runtimeMode=official-addon and must not load the project ReShade64.dll."
    Write-Host "  - InputProcessing=0 proves suppression is owned by the add-on, not ReShade's configured blocker."
    Write-Host "  - A rapid pointer click/key pair is queued while the present thread is suspended."
}
elseif ($ExistingCompatibleRuntime) {
    Write-Host "  - A compatible local DXGI proxy is already loaded without the Electron add-on."
    Write-Host "  - The SDK must reuse that runtime and load only its staged add-on."
}
Write-Host "  - Its exact PID is entered in the production frontend immediately."
if (-not $OfficialAddonMode) {
    Write-Host "  - ReShade is proved loaded before device creation is released."
    Write-Host "  - This is a process-creation case, not the known +3 s post-swapchain case."
    Write-Host "  - It does not prove real external-watcher latency or arbitrary-game timing."
}
Write-Host "  - Evidence is preserved in: $RunDirectory"
Write-Host ""

$ControlledEnvironmentVariables = @(
    "ELECTRON_GAME_OVERLAY_RUN_DIRECTORY",
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

$Summary = $null
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
    $ProducerWindowRegisteredDiagnostic = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay severity=info code=producer-window-registered(?: .*)?\r?$' `
        -Deadline $StartupDeadline
    $ProducerFramePublicationStartedDiagnostic = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay severity=info code=producer-frame-publication-started(?: .*)?\r?$' `
        -Deadline $StartupDeadline

    $DevToolsPage = Wait-ForDevToolsPage `
        -Port $DevToolsPort `
        -Process $ClientProcess `
        -Deadline $StartupDeadline
    $StatusDevToolsPage = if ($OfficialAddonMode) {
        Wait-ForDevToolsPage `
            -Port $DevToolsPort `
            -Process $ClientProcess `
            -Deadline $StartupDeadline `
            -Title "Example Status Overlay"
    }
    else {
        $null
    }
    $InitialFrontend = Wait-ForFrontendIdle `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -Process $ClientProcess `
        -Deadline $StartupDeadline
    $BeforeTargetLog = Get-ClientLogText -Path $ClientStdout
    $AfterIndex = $BeforeTargetLog.Length - 1

    $CreateRequestUtc = [DateTime]::UtcNow
    $HostProcess = Start-Process `
        -FilePath $TargetExecutablePath `
        -WorkingDirectory $TargetDirectory `
        -PassThru
    $ProcessCreatedUtc = [DateTime]::UtcNow
    $HostStartTimeUtc = $HostProcess.StartTime.ToUniversalTime()
    Assert-ExactTargetProcess `
        -ProcessId $HostProcess.Id `
        -ExpectedPath $TargetExecutablePath

    if ($OfficialAddonMode) {
        $ExpectedOfficialRuntimePath =
            [IO.Path]::GetFullPath($OfficialTargetRuntimePath)
        $ExpectedOfficialAddonPath =
            [IO.Path]::GetFullPath($OfficialTargetAddonPath)
        $OfficialReShadeLog = Join-Path $TargetDirectory "ReShade.log"
        $OfficialStartupDeadline = [DateTime]::UtcNow.AddSeconds(30)
        while ([DateTime]::UtcNow -lt $OfficialStartupDeadline) {
            $LoadedBeforeRelease = @(
                ([Diagnostics.Process]::GetProcessById($HostProcess.Id)).Modules
            )
            $OfficialRuntimeBeforeRelease = @(
                $LoadedBeforeRelease |
                    Where-Object {
                        $_.FileName -and
                        [string]::Equals(
                            [IO.Path]::GetFullPath($_.FileName),
                            $ExpectedOfficialRuntimePath,
                            [StringComparison]::OrdinalIgnoreCase)
                    }
            )
            if ($OfficialRuntimeBeforeRelease.Count -eq 1) {
                break
            }
            $HostProcess.Refresh()
            if ($HostProcess.HasExited) {
                throw "The controlled host exited before loading official ReShade."
            }
            Start-Sleep -Milliseconds 25
        }
        if ($OfficialRuntimeBeforeRelease.Count -ne 1) {
            throw "The controlled host did not load official ReShade behind the startup barrier: $ExpectedOfficialRuntimePath"
        }
        $OfficialAddonBeforeRelease = @(
            $LoadedBeforeRelease |
                Where-Object {
                    $_.FileName -and
                    [string]::Equals(
                        [IO.Path]::GetFullPath($_.FileName),
                        $ExpectedOfficialAddonPath,
                        [StringComparison]::OrdinalIgnoreCase)
                }
        )
        if ($OfficialAddonBeforeRelease.Count -ne 0) {
            throw "The official ReShade add-on loaded before graphics startup was released."
        }

        $StartupReleaseRequestUtc = [DateTime]::UtcNow
        Remove-Item -LiteralPath $StartupBarrierPath -Force
        $StartupReleasedUtc = [DateTime]::UtcNow
        $HostWindow = Wait-ForHostWindow `
            -HostProcess $HostProcess `
            -Deadline $OfficialStartupDeadline
        Wait-ForReShadeMarker `
            -Path $OfficialReShadeLog `
            -Marker "Registered add-on `"Electron Game Overlay Runtime`"" `
            -Deadline $OfficialStartupDeadline `
            -HostProcess $HostProcess
        Wait-ForReShadeMarker `
            -Path $OfficialReShadeLog `
            -Marker "using ReShade API version 18" `
            -Deadline $OfficialStartupDeadline `
            -HostProcess $HostProcess
        Wait-ForReShadeMarker `
            -Path $OfficialReShadeLog `
            -Marker "Electron game overlay runtime initialized its transport and input router." `
            -Deadline $OfficialStartupDeadline `
            -HostProcess $HostProcess
        Wait-ForReShadeMarker `
            -Path $OfficialReShadeLog `
            -Marker "Electron game overlay installed its official-ReShade WH_GETMESSAGE and window-subclass input hooks" `
            -Deadline $OfficialStartupDeadline `
            -HostProcess $HostProcess
        $OfficialLoadedModules = @(
            ([Diagnostics.Process]::GetProcessById($HostProcess.Id)).Modules
        )
        $OfficialAddonLoaded = @(
            $OfficialLoadedModules |
                Where-Object {
                    $_.FileName -and
                    [string]::Equals(
                        [IO.Path]::GetFullPath($_.FileName),
                        $ExpectedOfficialAddonPath,
                        [StringComparison]::OrdinalIgnoreCase)
                }
        )
        if ($OfficialAddonLoaded.Count -ne 1) {
            throw "Official ReShade did not load the production add-on from its default add-on directory: $ExpectedOfficialAddonPath"
        }
        $OfficialAddonLoadedBeforeAttachUtc = [DateTime]::UtcNow
    }
    elseif ($ExistingCompatibleRuntime) {
        $ExistingRuntimeLog =
            Join-Path $ExistingRuntimeDirectory "ReShade.log"
        $ExistingRuntimeReadyDeadline = [DateTime]::UtcNow.AddSeconds(20)
        Wait-ForReShadeMarker `
            -Path $ExistingRuntimeLog `
            -Marker "Initialized." `
            -Deadline $ExistingRuntimeReadyDeadline `
            -HostProcess $HostProcess
        $ExpectedExistingRuntimePath = [IO.Path]::GetFullPath(
            (Join-Path $ExistingRuntimeDirectory "dxgi.dll")
        )
        $LoadedExistingRuntime = @($HostProcess.Modules) |
            Where-Object {
                $_.FileName -and
                [string]::Equals(
                    [IO.Path]::GetFullPath($_.FileName),
                    $ExpectedExistingRuntimePath,
                    [StringComparison]::OrdinalIgnoreCase)
            }
        if ($LoadedExistingRuntime.Count -ne 1) {
            throw "The controlled target did not load the compatible DXGI proxy: $ExpectedExistingRuntimePath"
        }
        $ExistingRuntimeArtifactHashes = @{}
        foreach ($ArtifactName in @("dxgi.dll", "ReShade.ini")) {
            $ExistingRuntimeArtifactHashes[$ArtifactName] = (
                Get-FileHash `
                    -Algorithm SHA256 `
                    -LiteralPath (Join-Path $ExistingRuntimeDirectory $ArtifactName)
            ).Hash
        }
    }

    $FrontendAction = Invoke-ExactFrontendInjection `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -ProcessName $HostName `
        -ProcessId $HostProcess.Id
    $InjectionClickUtc = [DateTimeOffset]::Parse(
        $FrontendAction.Utc,
        [Globalization.CultureInfo]::InvariantCulture
    ).UtcDateTime
    $ProcessCreateToClickMilliseconds =
        ($InjectionClickUtc - $ProcessCreatedUtc).TotalMilliseconds
    if (-not $ExistingCompatibleRuntime -and
        -not $OfficialAddonMode -and
        ($ProcessCreateToClickMilliseconds -lt 0 -or
            $ProcessCreateToClickMilliseconds -ge 2000)) {
        throw "The exact-PID request was not dispatched in the early process-start window ($([Math]::Round($ProcessCreateToClickMilliseconds, 1)) ms)."
    }

    $AttachDeadline = [DateTime]::UtcNow.AddSeconds(120)
    $EscapedHostName = [regex]::Escape($HostName)
    $HostPid = $HostProcess.Id
    $Attaching = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=attaching processName=`"$EscapedHostName`" pid=$HostPid\r?`$" `
        -AfterIndex $AfterIndex `
        -Deadline $AttachDeadline
    $Staged = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(?<directory>.+)\r?$' `
        -AfterIndex $AfterIndex `
        -Deadline $AttachDeadline
    $ReShadeRunDirectory = Get-StagedRunDirectoryFromMatch -Match $Staged
    $ReShadeRunDirectory |
        Set-Content `
            -LiteralPath (Join-Path $RunDirectory "reshade-run-directory.txt") `
            -Encoding UTF8
    $ExpectedInjectorArguments = ConvertTo-Json `
        -InputObject ([object[]]@($HostName, "--pid", [string]$HostPid)) `
        -Compress
    $ExpectedInjectorStarted =
        "RESHADE_CLIENT_INJECTOR_STARTED target=$($HostName | ConvertTo-Json -Compress) arguments=$ExpectedInjectorArguments"
    $InjectorStarted = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^$([regex]::Escape($ExpectedInjectorStarted))\r?`$" `
        -AfterIndex $AfterIndex `
        -Deadline $AttachDeadline
    $StaticDiscoveryRecord = $null
    if ($OfficialAddonMode) {
        $OfficialStaticDiscoveryPath = Join-Path `
            (Join-Path ([IO.Path]::GetTempPath()) "electron-game-overlay") `
            "electron-overlay-transport-v1.pid-$HostPid.json"
        $StaticDiscoveryRecord = Wait-ForStaticDiscoveryRecord `
            -Path $OfficialStaticDiscoveryPath `
            -ExpectedProducerPid $ClientProcess.Id `
            -ExpectedTargetPid $HostPid `
            -Process $ClientProcess `
            -Deadline $AttachDeadline
        [IO.File]::ReadAllText($OfficialStaticDiscoveryPath) |
            Set-Content `
                -LiteralPath (
                    Join-Path $RunDirectory "static-target-discovery.json"
                ) `
                -Encoding UTF8
    }
    $InjectorReturned = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^RESHADE_CLIENT_INJECTOR_RETURNED(?: .*)?\r?$' `
        -AfterIndex $InjectorStarted.Index `
        -Deadline $AttachDeadline
    Assert-ExactTargetProcess `
        -ProcessId $HostPid `
        -ExpectedPath $TargetExecutablePath
    $InjectorStdout = Join-Path $ReShadeRunDirectory "inject.stdout.log"
    if (-not (Test-Path -LiteralPath $InjectorStdout -PathType Leaf)) {
        throw "The SDK did not preserve injector stdout: $InjectorStdout"
    }
    $InjectorLog = Get-Content -Raw -LiteralPath $InjectorStdout
    $SelectionMatches = [regex]::Matches(
        $InjectorLog,
        "(?m)^Found a matching process with PID $HostPid!"
    )
    if ($SelectionMatches.Count -ne 1) {
        throw "The injector did not select exact controlled PID $HostPid exactly once. Inspect $InjectorStdout."
    }
    $ExpectedRuntimeMode = if ($OfficialAddonMode) {
        "official-addon"
    }
    elseif ($ExistingCompatibleRuntime) {
        "existing-runtime"
    }
    else {
        "injected-runtime"
    }
    if (-not $InjectorLog.Contains(
            "ELECTRON_GAME_OVERLAY_INJECTOR_RESULT") -or
        -not $InjectorLog.Contains(
            "`"runtimeMode`":`"$ExpectedRuntimeMode`"")) {
        throw "The SDK injector did not report runtime mode '$ExpectedRuntimeMode'. Inspect $InjectorStdout."
    }
    $OfficialInjectorResult = $null
    if ($OfficialAddonMode) {
        $InjectorResultPrefix =
            "ELECTRON_GAME_OVERLAY_INJECTOR_RESULT "
        $InjectorResultLines = @(
            $InjectorLog -split '\r?\n' |
                Where-Object {
                    $_.StartsWith(
                        $InjectorResultPrefix,
                        [StringComparison]::Ordinal)
                }
        )
        if ($InjectorResultLines.Count -ne 1) {
            throw "Expected exactly one structured official-add-on injector result. Inspect $InjectorStdout."
        }
        $OfficialInjectorResult = $InjectorResultLines[0].Substring(
            $InjectorResultPrefix.Length
        ) | ConvertFrom-Json
        $OfficialResultProperties = @(
            $OfficialInjectorResult.PSObject.Properties.Name |
                Sort-Object
        )
        if (($OfficialResultProperties -join ",") -cne
            "addonAbi,addonBuildId,addonDirectoryPath,addonModulePath,electronGameOverlayAddonDisabled,pid,reshadeBasePath,runtimeMode,runtimeModulePath,schemaVersion,targetExecutablePath") {
            throw "The official-add-on injector result schema was not exact: $($OfficialResultProperties -join ',')"
        }
        $ExpectedEffectiveDirectory = [IO.Path]::GetFullPath(
            $TargetDirectory
        )
        if ($OfficialInjectorResult.schemaVersion -ne 1 -or
            $OfficialInjectorResult.pid -ne $HostPid -or
            $OfficialInjectorResult.runtimeMode -cne "official-addon" -or
            $OfficialInjectorResult.addonAbi -ne 1 -or
            $OfficialInjectorResult.addonBuildId -cne
                $ExpectedAddonBuildId -or
            ([string]$OfficialInjectorResult.addonBuildId) -cnotmatch
                '^[0-9A-F]{32}$' -or
            $OfficialInjectorResult.electronGameOverlayAddonDisabled -ne
                $false -or
            -not ([string]$OfficialInjectorResult.targetExecutablePath).Equals(
                [IO.Path]::GetFullPath($TargetExecutablePath),
                [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$OfficialInjectorResult.reshadeBasePath).Equals(
                $ExpectedEffectiveDirectory,
                [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$OfficialInjectorResult.addonDirectoryPath).Equals(
                $ExpectedEffectiveDirectory,
                [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$OfficialInjectorResult.runtimeModulePath).Equals(
                [IO.Path]::GetFullPath($OfficialTargetRuntimePath),
                [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$OfficialInjectorResult.addonModulePath).Equals(
                [IO.Path]::GetFullPath($OfficialTargetAddonPath),
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "The official-add-on injector result identified unexpected modules: $($OfficialInjectorResult | ConvertTo-Json -Compress)"
        }
        $EffectiveAddonPrefix = $ExpectedEffectiveDirectory
        if (-not $EffectiveAddonPrefix.EndsWith(
                [IO.Path]::DirectorySeparatorChar
            )) {
            $EffectiveAddonPrefix += [IO.Path]::DirectorySeparatorChar
        }
        $LoadedAddonPath = [IO.Path]::GetFullPath(
            $OfficialTargetAddonPath
        )
        if (-not $LoadedAddonPath.StartsWith(
                $EffectiveAddonPrefix,
                [StringComparison]::OrdinalIgnoreCase) -and
            -not $LoadedAddonPath.Equals(
                $ExpectedEffectiveDirectory,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "The loaded official add-on was outside the effective add-on directory."
        }
        if ($InjectorLog.Contains(
                "ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ") -or
            $InjectorLog.Contains("ReShade injection not started.")) {
            throw "The official-add-on injector success contract was ambiguous. Inspect $InjectorStdout."
        }
    }

    $ReShadeLog = if ($OfficialAddonMode) {
        Join-Path $TargetDirectory "ReShade.log"
    }
    elseif ($ExistingCompatibleRuntime) {
        Join-Path $ExistingRuntimeDirectory "ReShade.log"
    }
    else {
        Join-Path $ReShadeRunDirectory "ReShade.log"
    }
    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "Initialized." `
        -Deadline $AttachDeadline `
        -HostProcess $HostProcess
    $ExpectedRuntimePath = if ($OfficialAddonMode) {
        [IO.Path]::GetFullPath($OfficialTargetRuntimePath)
    }
    elseif ($ExistingCompatibleRuntime) {
        [IO.Path]::GetFullPath(
            (Join-Path $ExistingRuntimeDirectory "dxgi.dll")
        )
    }
    else {
        [IO.Path]::GetFullPath(
            (Join-Path $ReShadeRunDirectory "ReShade64.dll")
        )
    }
    # Process.Modules is cached by the .NET Process wrapper. Reopen the PID
    # after injection so the add-on loaded moments ago is present in this
    # authoritative snapshot.
    $LoadedModules = @(
        ([Diagnostics.Process]::GetProcessById($HostPid)).Modules
    )
    $LoadedRuntime = $LoadedModules |
        Where-Object {
            $_.FileName -and
            [string]::Equals(
                [IO.Path]::GetFullPath($_.FileName),
                $ExpectedRuntimePath,
                [StringComparison]::OrdinalIgnoreCase)
        }
    if ($LoadedRuntime.Count -ne 1) {
        throw "The exact ReShade runtime was not loaded in controlled PID $HostPid before startup release: $ExpectedRuntimePath"
    }
    if ($OfficialAddonMode) {
        $ExpectedAddonPath =
            [IO.Path]::GetFullPath($OfficialTargetAddonPath)
        $LoadedAddon = @(
            $LoadedModules |
                Where-Object {
                    $_.FileName -and
                    [string]::Equals(
                        [IO.Path]::GetFullPath($_.FileName),
                        $ExpectedAddonPath,
                        [StringComparison]::OrdinalIgnoreCase)
                }
        )
        if ($LoadedAddon.Count -ne 1) {
            throw "The production Electron add-on was not loaded by official ReShade: $ExpectedAddonPath"
        }
        $UnexpectedProjectRuntime = @(
            $LoadedModules |
                Where-Object {
                    $_.FileName -and
                    [IO.Path]::GetFileName($_.FileName) -ieq "ReShade64.dll"
                }
        )
        if ($UnexpectedProjectRuntime.Count -ne 0) {
            throw "The SDK loaded a project ReShade64.dll instead of preserving the official DXGI proxy: $($UnexpectedProjectRuntime.FileName -join ', ')"
        }
    }
    elseif ($ExistingCompatibleRuntime) {
        $ExpectedAddonPath = [IO.Path]::GetFullPath(
            (Join-Path $ReShadeRunDirectory "electron_game_overlay.addon64")
        )
        $LoadedAddon = $LoadedModules |
            Where-Object {
                $_.FileName -and
                [string]::Equals(
                    [IO.Path]::GetFullPath($_.FileName),
                    $ExpectedAddonPath,
                    [StringComparison]::OrdinalIgnoreCase)
            }
        if ($LoadedAddon.Count -ne 1) {
            throw "The staged Electron add-on was not loaded into the compatible runtime before startup release: $ExpectedAddonPath"
        }
        $UnexpectedSdkRuntimePath = [IO.Path]::GetFullPath(
            (Join-Path $ReShadeRunDirectory "ReShade64.dll")
        )
        $UnexpectedSdkRuntime = $LoadedModules |
            Where-Object {
                $_.FileName -and
                [string]::Equals(
                    [IO.Path]::GetFullPath($_.FileName),
                    $UnexpectedSdkRuntimePath,
                    [StringComparison]::OrdinalIgnoreCase)
            }
        if ($UnexpectedSdkRuntime.Count -ne 0) {
            throw "The SDK loaded a second ReShade runtime instead of reusing the compatible host."
        }
        if (Test-Path `
                -LiteralPath (Join-Path $ExistingRuntimeDirectory "electron_game_overlay.addon64")) {
            throw "Shared-runtime attachment copied the Electron add-on into the existing runtime directory."
        }
        foreach ($ArtifactName in @("dxgi.dll", "ReShade.ini")) {
            $ActualHash = (
                Get-FileHash `
                    -Algorithm SHA256 `
                    -LiteralPath (Join-Path $ExistingRuntimeDirectory $ArtifactName)
            ).Hash
            if ($ActualHash -ne $ExistingRuntimeArtifactHashes[$ArtifactName]) {
                throw "Shared-runtime attachment modified existing artifact '$ArtifactName'."
            }
        }
    }
    $RuntimeLoadedBeforeStartupReleaseUtc = [DateTime]::UtcNow

    $ConnectedLine = "RESHADE_CLIENT_TARGET_CONNECTED pid=$HostPid"
    $ConnectedStateLine =
        "RESHADE_CLIENT_ATTACHMENT_STATE phase=connected processName=`"$HostName`" pid=$HostPid"
    if ($OfficialAddonMode) {
        # A stock ReShade add-on is loaded during graphics initialization, so
        # this path intentionally releases the pre-device barrier before the
        # exact-PID request. Static per-PID authorization then lets the already
        # running add-on authenticate without target environment variables.
        $PreResumeClientLogBoundaryIndex = $AfterIndex
        $PreResumeBoundaryUtc = $OfficialAddonLoadedBeforeAttachUtc
    }
    else {
        $PreResumeClientLog = Get-ClientLogText -Path $ClientStdout
        $PreResumeClientTail = $PreResumeClientLog.Substring(
            [Math]::Min(
                $PreResumeClientLog.Length,
                [Math]::Max(0, $AfterIndex + 1)
            )
        )
        if ($PreResumeClientTail.Contains($ConnectedLine) -or
            $PreResumeClientTail.Contains($ConnectedStateLine)) {
            throw "The target transport connected before the controlled startup barrier was released."
        }
        $PreResumeReShadeLog = Get-Content -Raw -LiteralPath $ReShadeLog
        foreach ($ForbiddenMarker in @(
                "Searching for add-ons",
                "Loading add-on from",
                "Electron game overlay runtime initialized its transport and input router.",
                "Redirecting D3D11CreateDeviceAndSwapChain",
                "Redirecting D3D12CreateDevice"
            )) {
            if ($PreResumeReShadeLog.Contains($ForbiddenMarker)) {
                throw "ReShade graphics/add-on marker '$ForbiddenMarker' appeared before startup release."
            }
        }
        $PreResumeClientLogBoundaryIndex = $PreResumeClientLog.Length - 1
        $PreResumeBoundaryUtc = [DateTime]::UtcNow

        $StartupReleaseRequestUtc = [DateTime]::UtcNow
        Remove-Item -LiteralPath $StartupBarrierPath -Force
        $StartupReleasedUtc = [DateTime]::UtcNow
    }

    # In injected/shared mode the transport starts after graphics release. In
    # official mode the already-running add-on connects after static exact-PID
    # discovery is published by the production session.
    $Connected = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^$([regex]::Escape($ConnectedLine))\r?`$" `
        -AfterIndex $PreResumeClientLogBoundaryIndex `
        -Deadline $AttachDeadline
    $TargetConnectedObservedUtc = [DateTime]::UtcNow
    $TargetAuthenticatedDiagnostic = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-overlay-transport severity=info code=target-authenticated pid=$HostPid(?: .*)?\r?`$" `
        -AfterIndex $PreResumeClientLogBoundaryIndex `
        -Deadline $AttachDeadline
    $ConnectedState = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^$([regex]::Escape($ConnectedStateLine))\r?`$" `
        -AfterIndex $PreResumeClientLogBoundaryIndex `
        -Deadline $AttachDeadline
    $HostWindow = Wait-ForHostWindow `
        -HostProcess $HostProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    Assert-ExactTargetProcess `
        -ProcessId $HostPid `
        -ExpectedPath $TargetExecutablePath

    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "Electron game overlay runtime initialized its transport and input router." `
        -Deadline $AttachDeadline `
        -HostProcess $HostProcess
    if ($Backend -eq "d3d11") {
        Wait-ForReShadeMarker `
            -Path $ReShadeLog `
            -Marker "Redirecting D3D11CreateDeviceAndSwapChain" `
            -Deadline $AttachDeadline `
            -HostProcess $HostProcess
        $ApiEvidenceMarker = "Redirecting D3D11CreateDeviceAndSwapChain"
    }
    else {
        Wait-ForReShadeMarker `
            -Path $ReShadeLog `
            -Marker "Redirecting D3D12CreateDevice" `
            -Deadline $AttachDeadline `
            -HostProcess $HostProcess
        Wait-ForReShadeMarker `
            -Path $ReShadeLog `
            -Marker "Redirecting ID3D12Device::CreateCommandQueue" `
            -Deadline $AttachDeadline `
            -HostProcess $HostProcess
        $ApiEvidenceMarker = "Redirecting D3D12CreateDevice + ID3D12Device::CreateCommandQueue"
    }
    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "rendered its first transported multi-window scene (2 window(s))." `
        -Deadline $AttachDeadline `
        -HostProcess $HostProcess
    $RuntimeReadyDiagnostic = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay-runtime severity=info code=runtime-ready pid=$HostPid(?: .*)?\r?`$" `
        -AfterIndex $TargetAuthenticatedDiagnostic.Index `
        -Deadline $AttachDeadline
    $SwapchainReadyDiagnostic = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay-runtime severity=info code=runtime-swapchain-ready pid=$HostPid(?: .*)?\r?`$" `
        -AfterIndex $TargetAuthenticatedDiagnostic.Index `
        -Deadline $AttachDeadline
    $SceneRenderingDiagnostic = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay-runtime severity=info code=runtime-scene-rendering-started pid=$HostPid(?: .*)?\r?`$" `
        -AfterIndex $TargetAuthenticatedDiagnostic.Index `
        -Deadline $AttachDeadline
    $OfficialTelemetry = $null
    if ($OfficialAddonMode) {
        $OfficialTelemetry = Wait-ForOfficialTelemetry `
            -MainWebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
            -StatusWebSocketUrl $StatusDevToolsPage.webSocketDebuggerUrl `
            -ExpectedTargetPid $HostPid `
            -Process $ClientProcess `
            -Deadline $AttachDeadline
        $RuntimeStartupPath = $null
        $RuntimeStartupRecord = $null
    }
    else {
        $RuntimeStartupPath =
            Join-Path $ReShadeRunDirectory $RuntimeStartupFileName
        $RuntimeStartupRecord = Wait-ForRuntimeStartupRecord `
            -Path $RuntimeStartupPath `
            -ExpectedProcessId $HostPid `
            -Process $HostProcess `
            -Deadline $AttachDeadline
    }

    $InputProof = Test-OverlayInputAndRelease `
        -TargetWindow $HostWindow `
        -ConnectedMarkerIndex $Connected.Index

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($HostWindow)) {
        throw "Could not foreground the controlled host for its normal exit."
    }
    Start-Sleep -Milliseconds 250
    [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
    if (-not $HostProcess.WaitForExit(10000)) {
        throw "Released Escape did not normally close the controlled host."
    }
    $HostProcess.WaitForExit()
    $HostProcess.Refresh()
    $HostExitCode = $HostProcess.ExitCode
    if ($HostExitCode -ne 0) {
        throw "The controlled host exited with code $HostExitCode."
    }
    $HostExitedNormally = $true

    $Disconnected = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^RESHADE_CLIENT_TARGET_DISCONNECTED pid=$HostPid\r?`$" `
        -AfterIndex $Connected.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    $Idle = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=idle processName=`"$EscapedHostName`" pid=$HostPid reason=target-disconnected\r?`$" `
        -AfterIndex $ConnectedState.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    $FinalFrontend = Wait-ForFrontendIdle `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -Process $ClientProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    if ($OfficialAddonMode) {
        $DiscoveryCleanupDeadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $DiscoveryCleanupDeadline -and
            (Test-Path -LiteralPath $OfficialStaticDiscoveryPath -PathType Leaf)) {
            Start-Sleep -Milliseconds 50
        }
        if (Test-Path -LiteralPath $OfficialStaticDiscoveryPath -PathType Leaf) {
            throw "The production session did not release its owned static exact-PID discovery record: $OfficialStaticDiscoveryPath"
        }
        Assert-OfficialTargetFilesPreserved `
            -Path $TargetDirectory `
            -Before $OfficialTargetSeedManifest `
            -AllowedCreatedRelativePaths (
                $OfficialAllowedRuntimeCreatedRelativePaths
            )
        @(Get-TargetFileManifest -Path $TargetDirectory) |
            ConvertTo-Json -Depth 3 |
            Set-Content `
                -LiteralPath (
                    Join-Path `
                        $RunDirectory `
                        "official-target-manifest-after-target-exit.json"
                ) `
                -Encoding UTF8
    }

    $ClientLog = Get-ClientLogText -Path $ClientStdout
    if ($ClientLog.Contains("RESHADE_CLIENT_INJECTOR_FAILED") -or
        $ClientLog.Contains("ReShade attachment failed")) {
        throw "The production client logged an attachment failure."
    }
    $Fault = Select-String `
        -LiteralPath $ReShadeLog `
        -Pattern "out of global sequence|router was reset|input.*(failed|error)|queue.*(failed|error)|FATAL" `
        -CaseSensitive:$false
    if ($Fault) {
        throw "The ReShade log reported an input/router fault: $($Fault.Line -join ' | ')"
    }
    $RuntimeDiagnosticFault = Select-String `
        -LiteralPath $ClientStdout `
        -Pattern "OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay-runtime severity=(warning|error) code=runtime-" `
        -CaseSensitive
    if ($RuntimeDiagnosticFault) {
        throw "The injected runtime reported a warning/error diagnostic: $($RuntimeDiagnosticFault.Line -join ' | ')"
    }
    $ProducerDiagnosticFault = Select-String `
        -LiteralPath $ClientStdout `
        -Pattern "OVERLAY_SESSION_DIAGNOSTIC source=electron-game-overlay severity=(warning|error) code=producer-" `
        -CaseSensitive
    if ($ProducerDiagnosticFault) {
        throw "The Electron producer reported a warning/error diagnostic: $($ProducerDiagnosticFault.Line -join ' | ')"
    }
    $TargetPacketRejection = Select-String `
        -LiteralPath $ClientStdout `
        -Pattern "OVERLAY_SESSION_DIAGNOSTIC source=electron-overlay-transport severity=warning code=target-packet-rejected pid=$HostPid" `
        -CaseSensitive
    if ($TargetPacketRejection) {
        throw "The transport rejected an authenticated target packet, including a possible invalid game.input envelope: $($TargetPacketRejection.Line -join ' | ')"
    }
    $TargetDirectoryLog = Join-Path $TargetDirectory "ReShade.log"
    if (-not $ExistingCompatibleRuntime -and
        -not $OfficialAddonMode -and
        (Test-Path -LiteralPath $TargetDirectoryLog -PathType Leaf)) {
        throw "The run wrote an unexpected target-directory log: $TargetDirectoryLog"
    }

    $OfficialGateFailures = @(
        @(
            $OfficialQuickInputFailure
            $OfficialInputIsolationFailure
        ) |
            Where-Object {
                -not [string]::IsNullOrWhiteSpace($_)
            }
    )
    $OfficialGateFailure = $OfficialGateFailures -join " "

    $Summary = [pscustomobject]@{
        Result = if ($OfficialGateFailure) {
            $OfficialQuickInputFailureMarker
        }
        else {
            $ResultMarker
        }
        Backend = $Backend
        Case = if ($OfficialAddonMode) {
            "official-reshade-preinstalled-addon-exact-pid"
        }
        elseif ($ExistingCompatibleRuntime) {
            "process-start-shared-runtime-exact-pid"
        }
        else {
            "process-start-exact-pid"
        }
        LateInjectionBoundary = [pscustomobject]@{
            Classification = if ($OfficialAddonMode) {
                "official-addon-already-loaded"
            }
            else {
                "early-after-process-create"
            }
            StartupBarrier = "pre-device marker"
            OrderingProof = if ($OfficialAddonMode) {
                "official runtime and API-18 add-on were loaded from the target directory after startup release and before the production exact-PID request; the native injector then returned an exact official-addon result without loading ReShade64.dll"
            }
            else {
                "exact injector result and loaded runtime modules were observed before removal of the pre-device marker; transport, graphics-API hook, add-on initialization, and first-scene markers appeared only after that startup release"
            }
            ExcludesKnownCase = if ($OfficialAddonMode) {
                "hot-loading an add-on into a running official ReShade host"
            }
            else {
                "+3s post-swapchain injection"
            }
            DoesNotProve = if ($OfficialAddonMode) {
                "signed/limited ReShade builds, non-matching ImGui adapter versions, GetRawInputBuffer, DirectInput, XInput, or other polling-only game input APIs"
            }
            else {
                "real external-watcher latency or arbitrary-game startup timing"
            }
        }
        ClientProcessId = $ClientProcess.Id
        ClientStartup = [pscustomobject]@{
            Arguments = $ClientArguments
            AutomaticTargetConfigured = $false
        }
        TargetProcessId = $HostPid
        TargetExecutablePath = $TargetExecutablePath
        Timeline = [pscustomobject]@{
            CreateRequestUtc = $CreateRequestUtc.ToString("o")
            HostStartTimeUtc = $HostStartTimeUtc.ToString("o")
            ProcessCreatedUtc = $ProcessCreatedUtc.ToString("o")
            FrontendInjectionClickUtc = $InjectionClickUtc.ToString("o")
            ProcessCreateToClickMilliseconds =
                [Math]::Round($ProcessCreateToClickMilliseconds, 3)
            InjectorReturnedMarkerIndex = $InjectorReturned.Index
            RuntimeLoadedBeforeStartupReleaseUtc =
                $RuntimeLoadedBeforeStartupReleaseUtc.ToString("o")
            PreResumeClientLogBoundaryIndex =
                $PreResumeClientLogBoundaryIndex
            PreResumeBoundaryUtc = $PreResumeBoundaryUtc.ToString("o")
            TargetConnectedMarkerIndex = $Connected.Index
            TargetConnectedObservedUtc =
                $TargetConnectedObservedUtc.ToString("o")
            StartupReleaseRequestUtc =
                $StartupReleaseRequestUtc.ToString("o")
            StartupReleasedUtc = $StartupReleasedUtc.ToString("o")
        }
        ExactPidProof = [pscustomobject]@{
            FrontendProcessName = $FrontendAction.ProcessName
            FrontendProcessId = $FrontendAction.ProcessId
            AttachingStateMarkerIndex = $Attaching.Index
            ConnectedStateMarkerIndex = $ConnectedState.Index
            TargetAuthenticatedMarkerIndex =
                $TargetAuthenticatedDiagnostic.Index
            InjectorSelection = "Found a matching process with PID $HostPid!"
            InjectorStdout = $InjectorStdout
        }
        GraphicsApiProof = [pscustomobject]@{
            Expected = $BackendLabel
            ReShadeLogMarker = $ApiEvidenceMarker
        }
        RuntimeDiagnosticProof = [pscustomobject]@{
            RuntimeReadyMarkerIndex = $RuntimeReadyDiagnostic.Index
            SwapchainReadyMarkerIndex = $SwapchainReadyDiagnostic.Index
            SceneRenderingStartedMarkerIndex =
                $SceneRenderingDiagnostic.Index
        }
        RuntimeStartupProof = if ($OfficialAddonMode) {
            $null
        }
        else {
            [pscustomobject]@{
                Path = $RuntimeStartupPath
                ProcessId = [int]$RuntimeStartupRecord.pid
                Code = [string]$RuntimeStartupRecord.code
            }
        }
        ProducerDiagnosticProof = [pscustomobject]@{
            WindowRegisteredMarkerIndex =
                $ProducerWindowRegisteredDiagnostic.Index
            FramePublicationStartedMarkerIndex =
                $ProducerFramePublicationStartedDiagnostic.Index
        }
        SceneWindowCount = 2
        OfficialReShadeProof = if ($OfficialAddonMode) {
            [pscustomobject]@{
                SourceRuntimePath = $OfficialRuntimePath
                LoadedRuntimePath = $ExpectedRuntimePath
                LoadedAddonPath = $ExpectedAddonPath
                RuntimeMode = [string]$OfficialInjectorResult.runtimeMode
                AddonAbi = [int]$OfficialInjectorResult.addonAbi
                AddonApi = 18
                ProjectReShade64Loaded = $false
                StaticDiscoveryPath = $OfficialStaticDiscoveryPath
                StaticDiscoveryRecord = $StaticDiscoveryRecord
                StaticDiscoveryReleased = $true
                PreExistingTargetFilesPreserved = $true
                InputProcessing = 0
                InputOwner =
                    "add-on WH_GETMESSAGE hook plus same-thread window subclass"
            }
        }
        else {
            $null
        }
        TelemetryProof = $OfficialTelemetry
        InputProof = $InputProof
        NormalExit = [pscustomobject]@{
            ExitCode = $HostExitCode
            DisconnectedMarkerIndex = $Disconnected.Index
            IdleMarkerIndex = $Idle.Index
            FrontendPhase = $FinalFrontend.phase
            InjectDisabled = $FinalFrontend.injectDisabled
        }
        ReShadeRunDirectory = $ReShadeRunDirectory
        ReShadeLog = $ReShadeLog
        InitialFrontend = $InitialFrontend
    }
}
finally {
    try {
        Stop-OwnedProcesses
        if ($OfficialAddonMode -and
            $null -ne $OfficialTargetSeedManifest -and
            (Test-Path -LiteralPath $TargetDirectory -PathType Container)) {
            Assert-OfficialTargetFilesPreserved `
                -Path $TargetDirectory `
                -Before $OfficialTargetSeedManifest `
                -AllowedCreatedRelativePaths (
                    $OfficialAllowedRuntimeCreatedRelativePaths
                )
            @(Get-TargetFileManifest -Path $TargetDirectory) |
                ConvertTo-Json -Depth 3 |
                Set-Content `
                    -LiteralPath (
                        Join-Path `
                            $RunDirectory `
                            "official-target-manifest-after-cleanup.json"
                    ) `
                    -Encoding UTF8
            "OFFICIAL_TARGET_FILES_BYTE_IDENTICAL" |
                Set-Content `
                    -LiteralPath (
                        Join-Path $RunDirectory (
                            "official-target-preservation.txt"
                        )
                    ) `
                    -Encoding UTF8
        }
    }
    finally {
        foreach ($VariableName in $ControlledEnvironmentVariables) {
            [Environment]::SetEnvironmentVariable(
                $VariableName,
                $PreviousEnvironment[$VariableName],
                "Process")
        }
    }
}

Start-Sleep -Milliseconds 500
$RemainingElectron = @(
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$UserData*" }
)
$RemainingHost = @()
if ($HostProcess) {
    $RemainingHost = @(
        Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId=$($HostProcess.Id)" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                [string]::Equals(
                    $_.ExecutablePath,
                    $TargetExecutablePath,
                    [StringComparison]::OrdinalIgnoreCase) -or
                [string]::Equals(
                    $_.CommandLine,
                    "`"$TargetExecutablePath`"",
                    [StringComparison]::OrdinalIgnoreCase)
            }
    )
}
$RemainingInjectors = @(Get-OwnedInjectorProcesses)
if ($RemainingElectron.Count -ne 0 -or
    $RemainingHost.Count -ne 0 -or
    $RemainingInjectors.Count -ne 0) {
    $ProcessIds = @(
        @($RemainingElectron.ProcessId) +
            @($RemainingHost.ProcessId) +
            @($RemainingInjectors.ProcessId) |
            Where-Object { $null -ne $_ }
    )
    throw "The process-start gate left an owned client/host/injector process behind (PID: $($ProcessIds -join ', '))."
}
if (-not $HostExitedNormally -or -not $Summary) {
    throw "The process-start gate did not complete its normal-exit proof."
}

$Summary |
    ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath (Join-Path $RunDirectory "summary.json") -Encoding UTF8
if ($OfficialGateFailure) {
    $OfficialQuickInputFailureMarker |
        Set-Content `
            -LiteralPath (Join-Path $RunDirectory "result.txt") `
            -Encoding UTF8
    throw "$OfficialGateFailure Evidence preserved in: $RunDirectory"
}
$ResultMarker |
    Set-Content -LiteralPath (Join-Path $RunDirectory "result.txt") -Encoding UTF8
Write-Host $ResultMarker
Write-Host "Evidence preserved in: $RunDirectory"
