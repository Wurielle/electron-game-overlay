[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d11", "d3d12")]
    [string]$Backend,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# Reuse the production client gate's window, input-oracle, coordinate, and
# process-cleanup helpers without running that gate.
#
# Scope: this deterministic gate proves the target process exists before the
# production exact-PID request and that injection finishes before its primary
# thread runs. It does not claim that an external watcher can suspend arbitrary
# games quickly enough, or that unsuspended post-swapchain injection works.
. (Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1") `
    -Backend $Backend `
    -SkipBuild:$SkipBuild `
    -FunctionsOnly

$RunDirectory = Join-Path `
    $BuildRoot `
    "client-sdk-$Backend-process-start-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$TargetDirectory = Join-Path $RunDirectory "target"
$TargetExecutablePath = Join-Path $TargetDirectory $HostName
$UserData = Join-Path $RunDirectory "user-data"
$ClientStdout = Join-Path $RunDirectory "client.stdout.log"
$ClientStderr = Join-Path $RunDirectory "client.stderr.log"
$FrontendActions = Join-Path $RunDirectory "frontend-actions.jsonl"
$ResultMarker = "${BackendLabel}_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS"
$ClientProcess = $null
$SuspendedHost = $null
$HostProcess = $null
$ReShadeRunDirectory = $null
$HostExitedNormally = $false

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
        Start-Sleep -Milliseconds 50
    }

    throw "Timed out waiting for client pattern '$Pattern'. Inspect $Path."
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
        [Parameter(Mandatory = $true)][string]$ExpectedPath,
        [switch]$AllowUninitializedImage
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
    if ($AllowUninitializedImage -and $Target -and
        [string]::Equals(
            $Target.Name,
            [IO.Path]::GetFileName($ExpectedPath),
            [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals(
            $Target.CommandLine,
            "`"$ExpectedPath`"",
            [StringComparison]::OrdinalIgnoreCase)) {
        # CREATE_SUSPENDED returns before the initial user-mode loader pass, so
        # Win32_Process.ExecutablePath is empty. The exact CreateProcess command
        # and PID are authoritative until the resumed image publishes its path.
        return
    }
    throw "Controlled target PID $ProcessId came from an unexpected path/command: path=$($Target.ExecutablePath) command=$($Target.CommandLine)"
}

if (-not ("ReShadeProcessStartGate.SuspendedProcess" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace ReShadeProcessStartGate
{
    public sealed class SuspendedProcess : IDisposable
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private IntPtr processHandle;
        private IntPtr primaryThreadHandle;
        private bool resumed;

        private SuspendedProcess(
            Process process,
            IntPtr processHandle,
            IntPtr primaryThreadHandle)
        {
            Process = process;
            this.processHandle = processHandle;
            this.primaryThreadHandle = primaryThreadHandle;
        }

        public Process Process { get; private set; }

        public static SuspendedProcess Start(string executablePath, string workingDirectory)
        {
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            PROCESS_INFORMATION information;
            StringBuilder commandLine = new StringBuilder(
                "\"" + executablePath.Replace("\"", "\\\"") + "\"");
            bool created = CreateProcess(
                executablePath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_SUSPENDED,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out information);
            if (!created)
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "CreateProcess(CREATE_SUSPENDED) failed.");

            try
            {
                Process process = Process.GetProcessById((int)information.dwProcessId);
                return new SuspendedProcess(
                    process,
                    information.hProcess,
                    information.hThread);
            }
            catch (Exception startError)
            {
                Exception cleanupError = null;
                if (!TerminateProcess(information.hProcess, 1))
                {
                    cleanupError = new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Failed to terminate the suspended process after its .NET wrapper could not be created.");
                }
                else
                {
                    uint wait = WaitForSingleObject(information.hProcess, 5000);
                    if (wait != 0)
                    {
                        cleanupError = new Win32Exception(
                            wait == 0xFFFFFFFF ? Marshal.GetLastWin32Error() : 1460,
                            "The suspended process did not terminate after its .NET wrapper could not be created.");
                    }
                }
                CloseHandle(information.hThread);
                CloseHandle(information.hProcess);
                if (cleanupError != null)
                    throw new AggregateException(startError, cleanupError);
                throw;
            }
        }

        public void Resume()
        {
            if (resumed)
                return;
            uint previous = ResumeThread(primaryThreadHandle);
            if (previous == uint.MaxValue)
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "ResumeThread failed.");
            resumed = true;
        }

        public uint WaitForExitAndGetCode(uint timeoutMilliseconds)
        {
            if (processHandle == IntPtr.Zero)
                throw new ObjectDisposedException("SuspendedProcess");

            uint wait = WaitForSingleObject(processHandle, timeoutMilliseconds);
            if (wait == 258)
                throw new TimeoutException("The controlled process did not exit before the timeout.");
            if (wait == 0xFFFFFFFF)
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "WaitForSingleObject failed for the controlled process.");
            if (wait != 0)
                throw new InvalidOperationException(
                    "Unexpected process wait result: " + wait + ".");

            uint exitCode;
            if (!GetExitCodeProcess(processHandle, out exitCode))
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "GetExitCodeProcess failed for the controlled process.");
            return exitCode;
        }

        public void Dispose()
        {
            if (primaryThreadHandle != IntPtr.Zero)
            {
                CloseHandle(primaryThreadHandle);
                primaryThreadHandle = IntPtr.Zero;
            }
            if (processHandle != IntPtr.Zero)
            {
                CloseHandle(processHandle);
                processHandle = IntPtr.Zero;
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
"@
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

    # Prove the initially topmost status window before focusing the main window.
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $StatusCenter.X,
        $StatusCenter.Y
    )
    Start-Sleep -Milliseconds 100
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("exactpid")
    $StatusValueBeforeDrag = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input target=hudhook-status-input-target value="exactpid"\r?$' `
        -AfterIndex $Enabled.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $MainCenter.X,
        $MainCenter.Y
    )
    Start-Sleep -Milliseconds 100
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("processstart")
    $MainValueBeforeDrag = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=processstart\r?$' `
        -AfterIndex $StatusValueBeforeDrag.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))

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
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("moved")
    $MainValueAfterDrag = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_VALUE value=processstartmoved\r?$' `
        -AfterIndex $MainValueBeforeDrag.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Start-Sleep -Milliseconds 300

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $TargetWindow,
        $StatusCenter.X,
        $StatusCenter.Y
    )
    Start-Sleep -Milliseconds 100
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("again")
    $StatusValueAfterDrag = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input target=hudhook-status-input-target value="exactpidagain"\r?$' `
        -AfterIndex $StatusValueBeforeDrag.Index `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    Start-Sleep -Milliseconds 500
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($TargetWindow)) {
        throw "An Electron backing window stole foreground ownership."
    }
    $InterceptedTitle = [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle(
        $TargetWindow
    )
    if ($InterceptedTitle -ne $BaselineTitle) {
        throw "The controlled target received intercepted overlay input.`nBefore: $BaselineTitle`nAfter:  $InterceptedTitle"
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
        ReleasedTitle = $ReleasedSnapshot.Title
        EnabledMarkerIndex = $Enabled.Index
        MainValueBeforeDragMarkerIndex = $MainValueBeforeDrag.Index
        StatusValueBeforeDragMarkerIndex = $StatusValueBeforeDrag.Index
        MainValueAfterDragMarkerIndex = $MainValueAfterDrag.Index
        StatusValueAfterDragMarkerIndex = $StatusValueAfterDrag.Index
        DisabledMarkerIndex = $Disabled.Index
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

    try {
        foreach ($Injector in @(Get-OwnedInjectorProcesses)) {
            Stop-Process -Id $Injector.ProcessId -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $Injector.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        }

        Stop-AttemptElectronProcesses -UserData $UserData
    }
    finally {
        if ($SuspendedHost) {
            $SuspendedHost.Dispose()
        }
    }
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

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination $TargetExecutablePath
New-Item `
    -ItemType File `
    -Path (Join-Path $TargetDirectory "reshade-input-gate.enabled") `
    -Force | Out-Null

Write-Host ""
Write-Host "Production client/SDK $BackendLabel process-start exact-PID injection gate"
Write-Host "  - The real Electron client/session starts without an automatic target."
Write-Host "  - The controlled host process is created first with CREATE_SUSPENDED."
Write-Host "  - Its exact PID is entered in the production frontend immediately."
Write-Host "  - ReShade is proved loaded before the primary thread is resumed."
Write-Host "  - This is a process-creation case, not the known +3 s post-swapchain case."
Write-Host "  - It does not prove unsuspended watcher latency or arbitrary-game timing."
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

    $DevToolsPage = Wait-ForDevToolsPage `
        -Port $DevToolsPort `
        -Process $ClientProcess `
        -Deadline $StartupDeadline
    $InitialFrontend = Wait-ForFrontendIdle `
        -WebSocketUrl $DevToolsPage.webSocketDebuggerUrl `
        -Process $ClientProcess `
        -Deadline $StartupDeadline
    $BeforeTargetLog = Get-ClientLogText -Path $ClientStdout
    $AfterIndex = $BeforeTargetLog.Length - 1

    $CreateRequestUtc = [DateTime]::UtcNow
    $SuspendedHost = [ReShadeProcessStartGate.SuspendedProcess]::Start(
        $TargetExecutablePath,
        $TargetDirectory
    )
    $HostProcess = $SuspendedHost.Process
    $ProcessCreatedUtc = [DateTime]::UtcNow
    $HostStartTimeUtc = $HostProcess.StartTime.ToUniversalTime()
    Assert-ExactTargetProcess `
        -ProcessId $HostProcess.Id `
        -ExpectedPath $TargetExecutablePath `
        -AllowUninitializedImage

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
    if ($ProcessCreateToClickMilliseconds -lt 0 -or
        $ProcessCreateToClickMilliseconds -ge 2000) {
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
    $InjectorReturned = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^RESHADE_CLIENT_INJECTOR_RETURNED(?: .*)?\r?$' `
        -AfterIndex $InjectorStarted.Index `
        -Deadline $AttachDeadline
    Assert-ExactTargetProcess `
        -ProcessId $HostPid `
        -ExpectedPath $TargetExecutablePath `
        -AllowUninitializedImage
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

    $ReShadeLog = Join-Path $ReShadeRunDirectory "ReShade.log"
    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "Initialized." `
        -Deadline $AttachDeadline `
        -HostProcess $HostProcess
    $ExpectedRuntimePath = [IO.Path]::GetFullPath(
        (Join-Path $ReShadeRunDirectory "ReShade64.dll")
    )
    $LoadedRuntime = @($HostProcess.Modules) |
        Where-Object {
            $_.FileName -and
            [string]::Equals(
                [IO.Path]::GetFullPath($_.FileName),
                $ExpectedRuntimePath,
                [StringComparison]::OrdinalIgnoreCase)
        }
    if ($LoadedRuntime.Count -ne 1) {
        throw "The exact ReShade runtime was not loaded in suspended PID $HostPid before resume: $ExpectedRuntimePath"
    }
    $RuntimeLoadedBeforeResumeUtc = [DateTime]::UtcNow

    $ConnectedLine = "RESHADE_CLIENT_TARGET_CONNECTED pid=$HostPid"
    $ConnectedStateLine =
        "RESHADE_CLIENT_ATTACHMENT_STATE phase=connected processName=`"$HostName`" pid=$HostPid"
    $PreResumeClientLog = Get-ClientLogText -Path $ClientStdout
    $PreResumeClientTail = $PreResumeClientLog.Substring(
        [Math]::Min($PreResumeClientLog.Length, [Math]::Max(0, $AfterIndex + 1))
    )
    if ($PreResumeClientTail.Contains($ConnectedLine) -or
        $PreResumeClientTail.Contains($ConnectedStateLine)) {
        throw "The target transport connected before the controlled primary thread was resumed."
    }
    $PreResumeReShadeLog = Get-Content -Raw -LiteralPath $ReShadeLog
    foreach ($ForbiddenMarker in @(
            "Searching for add-ons",
            "Loading add-on from",
            "Electron ReShade compositor initialized its transport/router core.",
            "Redirecting D3D11CreateDeviceAndSwapChain",
            "Redirecting D3D12CreateDevice"
        )) {
        if ($PreResumeReShadeLog.Contains($ForbiddenMarker)) {
            throw "ReShade graphics/add-on marker '$ForbiddenMarker' appeared before ResumeThread."
        }
    }
    $PreResumeClientLogBoundaryIndex = $PreResumeClientLog.Length - 1
    $PreResumeBoundaryUtc = [DateTime]::UtcNow

    $ResumeRequestUtc = [DateTime]::UtcNow
    $SuspendedHost.Resume()
    $PrimaryThreadResumedUtc = [DateTime]::UtcNow

    # The runtime is loaded while suspended, but its add-on transport is
    # graphics-lifecycle driven and cannot connect until the primary thread is
    # resumed and creates the device/swap chain.
    $Connected = Wait-ForClientRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^$([regex]::Escape($ConnectedLine))\r?`$" `
        -AfterIndex $PreResumeClientLogBoundaryIndex `
        -Deadline $AttachDeadline
    $TargetConnectedObservedUtc = [DateTime]::UtcNow
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
        -Marker "Electron ReShade compositor initialized its transport/router core." `
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

    $InputProof = Test-OverlayInputAndRelease `
        -TargetWindow $HostWindow `
        -ConnectedMarkerIndex $Connected.Index

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($HostWindow)) {
        throw "Could not foreground the controlled host for its normal exit."
    }
    Start-Sleep -Milliseconds 250
    [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
    try {
        $HostExitCode = $SuspendedHost.WaitForExitAndGetCode(10000)
    }
    catch [TimeoutException] {
        throw "Released Escape did not normally close the controlled host."
    }
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
    $TargetDirectoryLog = Join-Path $TargetDirectory "ReShade.log"
    if (Test-Path -LiteralPath $TargetDirectoryLog -PathType Leaf) {
        throw "The run wrote an unexpected target-directory log: $TargetDirectoryLog"
    }

    $Summary = [pscustomobject]@{
        Result = $ResultMarker
        Backend = $Backend
        Case = "process-start-exact-pid"
        LateInjectionBoundary = [pscustomobject]@{
            Classification = "early-after-process-create"
            StartupBarrier = "CREATE_SUSPENDED"
            OrderingProof =
                "exact injector argv, injector return, runtime log, and loaded module observed before ResumeThread; transport/API/add-on markers were absent at the pre-resume boundary and observed only after ResumeThread"
            ExcludesKnownCase = "+3s post-swapchain injection"
            DoesNotProve =
                "unsuspended external-watcher latency or arbitrary-game startup timing"
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
            RuntimeLoadedBeforeResumeUtc =
                $RuntimeLoadedBeforeResumeUtc.ToString("o")
            PreResumeClientLogBoundaryIndex =
                $PreResumeClientLogBoundaryIndex
            PreResumeBoundaryUtc = $PreResumeBoundaryUtc.ToString("o")
            TargetConnectedMarkerIndex = $Connected.Index
            TargetConnectedObservedUtc =
                $TargetConnectedObservedUtc.ToString("o")
            ResumeRequestUtc = $ResumeRequestUtc.ToString("o")
            PrimaryThreadResumedUtc = $PrimaryThreadResumedUtc.ToString("o")
        }
        ExactPidProof = [pscustomobject]@{
            FrontendProcessName = $FrontendAction.ProcessName
            FrontendProcessId = $FrontendAction.ProcessId
            AttachingStateMarkerIndex = $Attaching.Index
            ConnectedStateMarkerIndex = $ConnectedState.Index
            InjectorSelection = "Found a matching process with PID $HostPid!"
            InjectorStdout = $InjectorStdout
        }
        GraphicsApiProof = [pscustomobject]@{
            Expected = $BackendLabel
            ReShadeLogMarker = $ApiEvidenceMarker
        }
        SceneWindowCount = 2
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
$ResultMarker |
    Set-Content -LiteralPath (Join-Path $RunDirectory "result.txt") -Encoding UTF8
Write-Host $ResultMarker
Write-Host "Evidence preserved in: $RunDirectory"
