[CmdletBinding(DefaultParameterSetName = "Diagnostic")]
param(
    [switch]$Wait,

    [Parameter(ParameterSetName = "Client")]
    [switch]$Client,

    [Parameter(ParameterSetName = "ClientWindow")]
    [switch]$ClientWindow,

    [Parameter(ParameterSetName = "ClientInput")]
    [switch]$ClientInput,

    [Parameter(ParameterSetName = "ClientInputManual")]
    [switch]$ClientInputManual
)

$ErrorActionPreference = "Stop"
$env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL"
$ClientInputMode = $ClientInput -or $ClientInputManual

# Producer stdout markers. Keep these synchronized with the corresponding
# Electron entry points and the real client's opt-in startup flag.
$DiagnosticReadyMarker = "HUDHOOK_ELECTRON_DEMO_READY"
$ClientReadyMarker = "HUDHOOK_CLIENT_OVERLAY_SESSION_READY"
$ClientWindowReadyMarker = "HUDHOOK_CLIENT_WINDOW_READY"
$ClientWindowLifecycleCompleteMarker = "HUDHOOK_CLIENT_WINDOW_LIFECYCLE_COMPLETE"
$ClientInputTargetMarker = "HUDHOOK_CLIENT_INPUT_TARGET"
$ClientInputInterceptRequestedMarker = "HUDHOOK_CLIENT_INPUT_INTERCEPT_REQUESTED"
$ClientInputInterceptEnabledMarker = "HUDHOOK_CLIENT_INPUT_INTERCEPT_ENABLED"
$ClientInputInterceptDisabledMarker = "HUDHOOK_CLIENT_INPUT_INTERCEPT_DISABLED"
$ClientInputLifecycleCompleteMarker = "HUDHOOK_CLIENT_INPUT_LIFECYCLE_COMPLETE"
$ClientInputTranslationReadyMarker = "HUDHOOK_CLIENT_INPUT_TRANSLATION_READY"
$ClientInputManualReadyMarker = "HUDHOOK_CLIENT_INPUT_MANUAL_READY"
$ClientInputManualSuspendedMarker = "HUDHOOK_CLIENT_INPUT_MANUAL_SUSPENDED"
$ClientInputManualResumedMarker = "HUDHOOK_CLIENT_INPUT_MANUAL_RESUMED"
$ClientInputFocusedMarker = "HUDHOOK_CLIENT_INPUT_FOCUSED"
$ClientInputClickedMarker = "HUDHOOK_CLIENT_INPUT_CLICKED"
$ClientInputWheelMarker = "HUDHOOK_CLIENT_INPUT_WHEEL"
$ClientInputEscapeMarker = "HUDHOOK_CLIENT_INPUT_ESCAPE_FORWARDED"
$ClientInputExpectedValue = "hudhook-input-proof-2026"
$ClientInputValueMarker = "HUDHOOK_CLIENT_INPUT_VALUE value=$ClientInputExpectedValue"
$ClientInputFilterEnabledProofMarker = "hudhook input filter enabled at render boundary"
$ClientInputFilterDisabledProofMarker = "hudhook input filter disabled at render boundary"
$ClientInputMouseDownProofMarker = "Electron left mouse down forwarded"
$ClientInputMouseUpProofMarker = "Electron left mouse up forwarded"
$ClientAutoStartFlag = "--start-overlay-session"
$ClientWindowRunnerFlag = "--hudhook-client-window-runner"
$ClientInputRunnerFlag = "--hudhook-client-input-runner"
$ClientInputManualFlag = "--hudhook-client-input-manual"

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
$OverlaySdkBuiltEntry = Join-Path $RepoRoot "libs\electron-game-overlay\dist\index.js"
$NodeAddonBuiltEntry = Join-Path $RepoRoot "libs\node-game-overlay\node-game-overlay.node"
$ClientUserDataDirectory = Join-Path $RunDirectory "electron-client-user-data"
$ClientInputRunToken = [Guid]::NewGuid().ToString("N")
$ClientInputUserDataDirectory = Join-Path $RunDirectory "electron-client-input-user-data-$ClientInputRunToken"
$ClientInputControlFile = Join-Path $RunDirectory "electron-client-input-$ClientInputRunToken.control"
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
elseif ($ClientInput) {
    $ProducerMode = "ClientInput"
    $ElectronReadyMarker = $ClientWindowReadyMarker
    $ElectronApplication = $ClientWindowAppDirectory
    $ElectronArguments = @(
        $ClientWindowAppDirectory,
        $ClientInputRunnerFlag,
        "--input-control-file=$ClientInputControlFile",
        "--user-data-dir=$ClientInputUserDataDirectory",
        "--no-sandbox"
    )
    # The per-run user-data switch is inherited by Chromium children and is
    # the sole cleanup token, so another invocation cannot share it.
    $ElectronCommandLineMarkers = @($ClientInputUserDataDirectory)
    $ElectronStdoutLog = Join-Path $RunDirectory "electron-client-input.stdout.log"
    $ElectronStderrLog = Join-Path $RunDirectory "electron-client-input.stderr.log"
    $ExpectedResult = "click, text, wheel, and intercepted Escape reach the real overlay; released Escape closes the controlled host."
}
elseif ($ClientInputManual) {
    $ProducerMode = "ClientInputManual"
    $ElectronReadyMarker = $ClientWindowReadyMarker
    $ElectronApplication = $ClientWindowAppDirectory
    $ElectronArguments = @(
        $ClientWindowAppDirectory,
        $ClientInputManualFlag,
        "--user-data-dir=$ClientInputUserDataDirectory",
        "--no-sandbox"
    )
    # The unique user-data switch is inherited by Chromium children and is the
    # sole cleanup token for this attached manual session.
    $ElectronCommandLineMarkers = @($ClientInputUserDataDirectory)
    $ElectronStdoutLog = Join-Path $RunDirectory "electron-client-input-manual.stdout.log"
    $ElectronStderrLog = Join-Path $RunDirectory "electron-client-input-manual.stderr.log"
    $ExpectedResult = "you can click, type, scroll, and press keys in the real composited ExampleMainOverlay until closing the controlled host."
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
if ($ClientInputMode) {
    $RequiredPayloadProofMarkers += $ClientPayloadProofMarkers
    $RequiredElectronProofMarkers += @(
        $ClientInputTargetMarker,
        $ClientInputInterceptRequestedMarker,
        $ClientInputTranslationReadyMarker
    )
}
elseif ($ClientWindow) {
    $RequiredPayloadProofMarkers += $ClientWindowPayloadProofMarkers
    $RequiredElectronProofMarkers += $ClientWindowLifecycleCompleteMarker
}
elseif ($Client) {
    $RequiredPayloadProofMarkers += $ClientPayloadProofMarkers
}

if (-not ("HudhookOverlayRunner.NativeInputMethods" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace HudhookOverlayRunner
{
    public static class NativeInputMethods
    {
        private const uint INPUT_MOUSE = 0;
        private const uint INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;
        private const uint MOUSEEVENTF_MOVE = 0x0001;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_WHEEL = 0x0800;
        private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        private const int SM_XVIRTUALSCREEN = 76;
        private const int SM_YVIRTUALSCREEN = 77;
        private const int SM_CXVIRTUALSCREEN = 78;
        private const int SM_CYVIRTUALSCREEN = 79;
        private const int SW_RESTORE = 9;
        private const ushort VK_ESCAPE = 0x1B;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint Type;
            public INPUTUNION Data;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT Mouse;
            [FieldOffset(0)] public KEYBDINPUT Keyboard;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int Dx;
            public int Dy;
            public uint MouseData;
            public uint Flags;
            public uint Time;
            public UIntPtr ExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort VirtualKey;
            public ushort ScanCode;
            public uint Flags;
            public uint Time;
            public UIntPtr ExtraInfo;
        }

        [DllImport("user32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        public static extern IntPtr FindWindow(string className, string windowName);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool ClientToScreen(IntPtr window, ref POINT point);

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool AttachThreadInput(uint firstThread, uint secondThread, bool attach);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool BringWindowToTop(IntPtr window);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetFocus(IntPtr window);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, INPUT[] inputs, int size);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessage(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam);

        public static bool IsForegroundWindow(IntPtr window)
        {
            return GetForegroundWindow() == window;
        }

        public static void NotifyWindow(IntPtr window)
        {
            if (!PostMessage(window, 0, UIntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not post WM_NULL to the target window.");
        }

        public static POINT GetClientScreenPoint(IntPtr window, int x, int y)
        {
            POINT point = new POINT { X = x, Y = y };
            if (!ClientToScreen(window, ref point))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ClientToScreen failed.");
            return point;
        }

        public static bool ActivateWindow(IntPtr window)
        {
            ShowWindow(window, SW_RESTORE);

            uint currentThread = GetCurrentThreadId();
            uint targetThread = GetWindowThreadProcessId(window, IntPtr.Zero);
            IntPtr foregroundWindow = GetForegroundWindow();
            uint foregroundThread = foregroundWindow == IntPtr.Zero
                ? 0
                : GetWindowThreadProcessId(foregroundWindow, IntPtr.Zero);
            bool attachedTarget = targetThread != 0 && targetThread != currentThread &&
                AttachThreadInput(currentThread, targetThread, true);
            bool attachedForeground = foregroundThread != 0 &&
                foregroundThread != currentThread && foregroundThread != targetThread &&
                AttachThreadInput(currentThread, foregroundThread, true);

            try
            {
                BringWindowToTop(window);
                SetForegroundWindow(window);
                SetFocus(window);
            }
            finally
            {
                if (attachedForeground)
                    AttachThreadInput(currentThread, foregroundThread, false);
                if (attachedTarget)
                    AttachThreadInput(currentThread, targetThread, false);
            }

            return GetForegroundWindow() == window;
        }

        public static POINT MoveMouseToClientPoint(IntPtr window, int x, int y)
        {
            POINT point = GetClientScreenPoint(window, x, y);
            int virtualX = GetSystemMetrics(SM_XVIRTUALSCREEN);
            int virtualY = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int virtualWidth = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            int virtualHeight = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if (virtualWidth <= 1 || virtualHeight <= 1)
                throw new InvalidOperationException("The virtual desktop has invalid dimensions.");

            int normalizedX = NormalizeAbsolute(point.X, virtualX, virtualWidth);
            int normalizedY = NormalizeAbsolute(point.Y, virtualY, virtualHeight);
            SendInputs(new [] { MouseInput(
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                0,
                normalizedX,
                normalizedY) });
            return point;
        }

        public static void SendLeftClick()
        {
            SendInputs(new [] {
                MouseInput(MOUSEEVENTF_LEFTDOWN, 0, 0, 0),
                MouseInput(MOUSEEVENTF_LEFTUP, 0, 0, 0)
            });
        }

        public static void SendWheel(int delta)
        {
            SendInputs(new [] { MouseInput(MOUSEEVENTF_WHEEL, unchecked((uint)delta), 0, 0) });
        }

        public static void SendUnicodeText(string value)
        {
            INPUT[] inputs = new INPUT[value.Length * 2];
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                int inputIndex = index * 2;
                inputs[inputIndex] = KeyboardInput(0, character, KEYEVENTF_UNICODE);
                inputs[inputIndex + 1] = KeyboardInput(
                    0,
                    character,
                    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
            }

            SendInputs(inputs);
        }

        public static void SendEscape()
        {
            SendInputs(new [] {
                KeyboardInput(VK_ESCAPE, (char)0, 0),
                KeyboardInput(VK_ESCAPE, (char)0, KEYEVENTF_KEYUP)
            });
        }

        private static int NormalizeAbsolute(int coordinate, int origin, int extent)
        {
            long value = ((long)coordinate - origin) * 65535L / (extent - 1);
            return (int)Math.Max(0L, Math.Min(65535L, value));
        }

        private static INPUT MouseInput(uint flags, uint data, int x, int y)
        {
            return new INPUT {
                Type = INPUT_MOUSE,
                Data = new INPUTUNION {
                    Mouse = new MOUSEINPUT {
                        Dx = x,
                        Dy = y,
                        MouseData = data,
                        Flags = flags
                    }
                }
            };
        }

        private static INPUT KeyboardInput(ushort virtualKey, char scanCode, uint flags)
        {
            return new INPUT {
                Type = INPUT_KEYBOARD,
                Data = new INPUTUNION {
                    Keyboard = new KEYBDINPUT {
                        VirtualKey = virtualKey,
                        ScanCode = scanCode,
                        Flags = flags
                    }
                }
            };
        }

        private static void SendInputs(INPUT[] inputs)
        {
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != (uint)inputs.Length)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput did not send every event.");
        }
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
    $HostWindow = [HudhookOverlayRunner.NativeInputMethods]::FindWindow(
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

if (
    -not $Client -and
    -not $ClientWindow -and
    -not $ClientInput -and
    -not $ClientInputManual -and
    -not (Test-Path $DiagnosticEntry -PathType Leaf)
) {
    throw "Electron diagnostic entry point not found: $DiagnosticEntry"
}

if (
    ($ClientWindow -or $ClientInputMode) -and
    -not (Test-Path $ClientWindowEntry -PathType Leaf)
) {
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

if ($Client -or $ClientInputMode) {
    $NpmCommand = Get-Command "npm.cmd" -ErrorAction Stop
    if ($Client) {
        Write-Host "Building the real Electron client..."
    }
    else {
        Write-Host "Building the Electron overlay SDK and native add-on for the input proof..."
    }

    Push-Location $RepoRoot
    try {
        if ($Client) {
            & $NpmCommand.Source run build
        }
        else {
            $NpxCommand = Get-Command "npx.cmd" -ErrorAction Stop
            & $NpxCommand.Source nx run electron-game-overlay:build
        }
        if ($LASTEXITCODE -ne 0) {
            throw "The Electron build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    if ($Client -and -not (Test-Path $ClientBuiltEntry -PathType Leaf)) {
        throw "The client build completed without producing its main entry point: $ClientBuiltEntry"
    }
    if ($ClientInputMode) {
        foreach ($Artifact in @($OverlaySdkBuiltEntry, $NodeAddonBuiltEntry)) {
            if (-not (Test-Path $Artifact -PathType Leaf)) {
                throw "The input-proof build completed without producing: $Artifact"
            }
        }
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

function Wait-ForInputProofMarkers {
    param(
        [string[]]$PayloadMarkers = @(),
        [string[]]$ElectronMarkers = @(),
        [Parameter(Mandatory = $true)]
        [string]$Phase,
        [int]$TimeoutSeconds = 15
    )

    $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $MissingPayloadMarkers = @($PayloadMarkers)
    $MissingElectronMarkers = @($ElectronMarkers)

    do {
        Start-Sleep -Milliseconds 50
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) {
            throw "The controlled host exited during input proof phase '$Phase'."
        }

        $CurrentElectronProcessIds = @(
            Update-LaunchedElectronProcessIds `
                $ElectronProcessIds `
                $PreexistingElectronProcessIds `
                $ElectronCommandLineMarkers
        )
        if (@(Get-LiveProcessIds $CurrentElectronProcessIds).Count -eq 0) {
            throw "The Electron producer exited during input proof phase '$Phase'."
        }

        $PayloadLogContent = Get-FileContent $PayloadLog
        $ElectronLogContent = Get-FileContent $ElectronStdoutLog
        $MissingPayloadMarkers = @(
            foreach ($Marker in $PayloadMarkers) {
                if (-not $PayloadLogContent.Contains($Marker)) {
                    $Marker
                }
            }
        )
        $MissingElectronMarkers = @(
            foreach ($Marker in $ElectronMarkers) {
                if (-not $ElectronLogContent.Contains($Marker)) {
                    $Marker
                }
            }
        )
    } while (
        ($MissingPayloadMarkers.Count -gt 0 -or $MissingElectronMarkers.Count -gt 0) -and
        [DateTime]::UtcNow -lt $Deadline
    )

    if ($MissingPayloadMarkers.Count -gt 0 -or $MissingElectronMarkers.Count -gt 0) {
        throw (
            "Timed out during input proof phase '$Phase'. " +
            "Missing payload marker(s): $($MissingPayloadMarkers -join '; '); " +
            "missing Electron marker(s): $($MissingElectronMarkers -join '; ')."
        )
    }
}
if ($ClientInputMode) {
    New-Item -ItemType Directory -Path $ClientInputUserDataDirectory -Force | Out-Null
}
if ($ClientInput) {
    if (Test-Path $ClientInputControlFile -PathType Leaf) {
        Remove-Item -LiteralPath $ClientInputControlFile -Force
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

    if ($ClientInputMode) {
        $ElectronOutput = Get-FileContent $ElectronStdoutLog
        $TargetPattern = (
            'HUDHOOK_CLIENT_INPUT_TARGET ' +
            'x=(?<x>-?\d+(?:\.\d+)?) ' +
            'y=(?<y>-?\d+(?:\.\d+)?) ' +
            'width=(?<width>\d+(?:\.\d+)?) ' +
            'height=(?<height>\d+(?:\.\d+)?) ' +
            'windowX=(?<windowX>-?\d+) ' +
            'windowY=(?<windowY>-?\d+)'
        )
        $TargetMatches = [regex]::Matches($ElectronOutput, $TargetPattern)
        if ($TargetMatches.Count -eq 0) {
            throw "Could not parse the DOM-reported input target from $ElectronStdoutLog."
        }

        $TargetMatch = $TargetMatches[$TargetMatches.Count - 1]
        $InvariantCulture = [System.Globalization.CultureInfo]::InvariantCulture
        $TargetX = [double]::Parse($TargetMatch.Groups["x"].Value, $InvariantCulture)
        $TargetY = [double]::Parse($TargetMatch.Groups["y"].Value, $InvariantCulture)
        $TargetWidth = [double]::Parse($TargetMatch.Groups["width"].Value, $InvariantCulture)
        $TargetHeight = [double]::Parse($TargetMatch.Groups["height"].Value, $InvariantCulture)
        $OverlayX = [int]::Parse($TargetMatch.Groups["windowX"].Value, $InvariantCulture)
        $OverlayY = [int]::Parse($TargetMatch.Groups["windowY"].Value, $InvariantCulture)
        $TargetClientX = [int][Math]::Round(
            $OverlayX + $TargetX + ($TargetWidth / 2),
            [MidpointRounding]::AwayFromZero
        )
        $TargetClientY = [int][Math]::Round(
            $OverlayY + $TargetY + ($TargetHeight / 2),
            [MidpointRounding]::AwayFromZero
        )

        $HostProcess.Refresh()
        $HostWindow = $HostProcess.MainWindowHandle
        if ($HostWindow -eq [IntPtr]::Zero) {
            throw "The controlled host has no window handle for input mode."
        }

        $HostActivated = $false
        for ($Attempt = 0; $Attempt -lt 5 -and -not $HostActivated; $Attempt++) {
            $HostActivated = [HudhookOverlayRunner.NativeInputMethods]::ActivateWindow($HostWindow)
            if (-not $HostActivated) {
                Start-Sleep -Milliseconds 100
            }
        }
        if (-not $HostActivated) {
            throw "Could not activate the controlled host before enabling overlay input."
        }
        [HudhookOverlayRunner.NativeInputMethods]::NotifyWindow($HostWindow)

        $EnabledElectronMarkers = @($ClientInputInterceptEnabledMarker)
        if ($ClientInputManual) {
            $EnabledElectronMarkers += $ClientInputManualReadyMarker
        }
        Wait-ForInputProofMarkers `
            -Phase "interception activation" `
            -PayloadMarkers @(
                "Electron input intercept enabled",
                $ClientInputFilterEnabledProofMarker
            ) `
            -ElectronMarkers $EnabledElectronMarkers

        $ActivationPayloadOutput = Get-FileContent $PayloadLog
        $FilterEnabledIndex = $ActivationPayloadOutput.IndexOf($ClientInputFilterEnabledProofMarker)
        $InterceptEnabledIndex = $ActivationPayloadOutput.IndexOf("Electron input intercept enabled")
        if ($FilterEnabledIndex -lt 0 -or $InterceptEnabledIndex -le $FilterEnabledIndex) {
            throw "Enabled acknowledgement did not follow the applied-filter boundary."
        }

        if ($ClientInput) {
            if (-not [HudhookOverlayRunner.NativeInputMethods]::IsForegroundWindow($HostWindow)) {
                throw "The controlled host lost foreground ownership before mouse movement."
            }
            $TargetScreenPoint = [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                $HostWindow,
                $TargetClientX,
                $TargetClientY
            )
            Write-Verbose (
                "DOM target center maps to host client ($TargetClientX, $TargetClientY) " +
                "and screen ($($TargetScreenPoint.X), $($TargetScreenPoint.Y))."
            )
            Start-Sleep -Milliseconds 100
            if (-not [HudhookOverlayRunner.NativeInputMethods]::IsForegroundWindow($HostWindow)) {
                throw "The controlled host lost foreground ownership before the left click."
            }
            [HudhookOverlayRunner.NativeInputMethods]::SendLeftClick()

            Wait-ForInputProofMarkers `
                -Phase "click and focus" `
                -PayloadMarkers @(
                    "Electron overlay focused for input",
                    "Electron mouse input forwarded",
                    $ClientInputMouseDownProofMarker,
                    $ClientInputMouseUpProofMarker
                ) `
                -ElectronMarkers @(
                    $ClientInputFocusedMarker,
                    $ClientInputClickedMarker
                )

            $ClickPayloadOutput = Get-FileContent $PayloadLog
            $FocusPacketIndex = $ClickPayloadOutput.IndexOf("Electron overlay focused for input")
            $MouseDownIndex = $ClickPayloadOutput.IndexOf($ClientInputMouseDownProofMarker)
            $MouseUpIndex = $ClickPayloadOutput.IndexOf($ClientInputMouseUpProofMarker)
            if (
                $FocusPacketIndex -lt 0 -or
                $MouseDownIndex -le $FocusPacketIndex -or
                $MouseUpIndex -le $MouseDownIndex
            ) {
                throw "Payload packet order did not prove focus before mouse down and mouse up."
            }

            if (-not [HudhookOverlayRunner.NativeInputMethods]::IsForegroundWindow($HostWindow)) {
                throw "The controlled host lost foreground ownership before text input."
            }
            [HudhookOverlayRunner.NativeInputMethods]::SendUnicodeText($ClientInputExpectedValue)
            Start-Sleep -Milliseconds 100
            if (-not [HudhookOverlayRunner.NativeInputMethods]::IsForegroundWindow($HostWindow)) {
                throw "The controlled host lost foreground ownership before the wheel input."
            }
            [HudhookOverlayRunner.NativeInputMethods]::SendWheel(120)

            Wait-ForInputProofMarkers `
                -Phase "text and wheel" `
                -PayloadMarkers @("Electron keyboard input forwarded") `
                -ElectronMarkers @(
                    $ClientInputValueMarker,
                    $ClientInputWheelMarker
                )

            if (-not [HudhookOverlayRunner.NativeInputMethods]::IsForegroundWindow($HostWindow)) {
                throw "The controlled host lost foreground ownership before intercepted Escape."
            }
            [HudhookOverlayRunner.NativeInputMethods]::SendEscape()
            Wait-ForInputProofMarkers `
                -Phase "intercepted Escape forwarding" `
                -ElectronMarkers @($ClientInputEscapeMarker)

            $EscapeForwardCountBeforeRelease = [regex]::Matches(
                (Get-FileContent $ElectronStdoutLog),
                [regex]::Escape($ClientInputEscapeMarker)
            ).Count
            if ($EscapeForwardCountBeforeRelease -lt 1) {
                throw "The intercepted Escape did not produce a forwarded Electron marker."
            }

            Start-Sleep -Milliseconds 750
            $HostProcess.Refresh()
            if ($HostProcess.HasExited) {
                throw "Escape reached the controlled host while input interception was enabled."
            }
            Write-Host "Verified that Escape was blocked while interception was enabled."

            Set-Content `
                -LiteralPath $ClientInputControlFile `
                -Value "release" `
                -NoNewline `
                -Encoding Ascii

            Wait-ForInputProofMarkers `
                -Phase "interception release" `
                -PayloadMarkers @(
                    "Electron input intercept disabled",
                    $ClientInputFilterDisabledProofMarker
                ) `
                -ElectronMarkers @(
                    $ClientInputInterceptDisabledMarker,
                    $ClientInputLifecycleCompleteMarker
                )
            $ReleasePayloadOutput = Get-FileContent $PayloadLog
            $FilterDisabledIndex = $ReleasePayloadOutput.LastIndexOf($ClientInputFilterDisabledProofMarker)
            $InterceptDisabledIndex = $ReleasePayloadOutput.LastIndexOf("Electron input intercept disabled")
            if ($FilterDisabledIndex -lt 0 -or $InterceptDisabledIndex -le $FilterDisabledIndex) {
                throw "Disabled acknowledgement did not follow the pass-through filter boundary."
            }
            if (-not [HudhookOverlayRunner.NativeInputMethods]::ActivateWindow($HostWindow)) {
                throw "Could not reactivate the controlled host after releasing interception."
            }
            [HudhookOverlayRunner.NativeInputMethods]::NotifyWindow($HostWindow)
            if (-not [HudhookOverlayRunner.NativeInputMethods]::IsForegroundWindow($HostWindow)) {
                throw "The controlled host was not foreground before released Escape."
            }
            [HudhookOverlayRunner.NativeInputMethods]::SendEscape()
            if (-not $HostProcess.WaitForExit(5000)) {
                throw "The controlled host did not exit after released Escape."
            }

            $HostExitCode = $HostProcess.ExitCode
            if ($HostExitCode -ne 0) {
                throw "The controlled host exited with code $HostExitCode after released Escape."
            }
            Start-Sleep -Milliseconds 250
            $EscapeForwardCountAfterRelease = [regex]::Matches(
                (Get-FileContent $ElectronStdoutLog),
                [regex]::Escape($ClientInputEscapeMarker)
            ).Count
            if ($EscapeForwardCountAfterRelease -ne $EscapeForwardCountBeforeRelease) {
                throw "Released Escape was incorrectly forwarded to Electron."
            }
            Write-Host "Verified that released Escape closed the controlled host normally."
        }
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

    if ($ClientInput) {
        Write-Host "The deterministic input proof is complete; the runner will clean only its controlled process tree."
    }
    elseif ($ClientInputManual -or $Wait) {
        if ($ClientInputManual) {
            Write-Host ""
            Write-Host "Manual input is ready. Click the composited overlay, then type, scroll, and try its controls."
            Write-Host "When finished, close the controlled host with its title-bar X; Escape and Alt+F4 are intercepted."
            $ObservedManualSuspendedCount = 0
            $ObservedManualResumedCount = 0
        }
        else {
            Write-Host "Press Escape in the host to finish; the runner will then stop only the Electron process it launched."
        }

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

            if ($ClientInputManual) {
                $ManualElectronOutput = Get-FileContent $ElectronStdoutLog
                $ManualSuspendedCount = [regex]::Matches(
                    $ManualElectronOutput,
                    [regex]::Escape($ClientInputManualSuspendedMarker)
                ).Count
                $ManualResumedCount = [regex]::Matches(
                    $ManualElectronOutput,
                    [regex]::Escape($ClientInputManualResumedMarker)
                ).Count

                if ($ManualSuspendedCount -gt $ObservedManualSuspendedCount) {
                    Write-Host "Manual input suspended while the controlled host is not active."
                }
                if ($ManualResumedCount -gt $ObservedManualResumedCount) {
                    Write-Host "Manual input resumed after the guarded filter was reapplied."
                }

                $ObservedManualSuspendedCount = [Math]::Max(
                    $ObservedManualSuspendedCount,
                    $ManualSuspendedCount
                )
                $ObservedManualResumedCount = [Math]::Max(
                    $ObservedManualResumedCount,
                    $ManualResumedCount
                )
            }
        }
    }
    else {
        Write-Host "This invocation is leaving both launched processes alive for visual inspection."
        Write-Host "Use -Wait on the next run to keep the runner attached and clean up Electron when the host exits."
    }
}
finally {
    if (-not $RunVerified -or $Wait -or $ClientInputMode) {
        $ElectronProcessIds = @(
            Update-LaunchedElectronProcessIds `
                $ElectronProcessIds `
                $PreexistingElectronProcessIds `
                $ElectronCommandLineMarkers
        )
        Stop-LaunchedProcess $HostProcess "controlled host"
        Stop-LaunchedElectronProcesses `
            $ElectronProcessIds `
            $ElectronCommandLineMarkers
        Stop-LaunchedProcess $ElectronLauncherProcess "Electron launcher"
    }

    if ($ClientInput -and (Test-Path $ClientInputControlFile -PathType Leaf)) {
        Remove-Item -LiteralPath $ClientInputControlFile -Force
    }

    if ($ClientInputMode) {
        $RemainingElectronProcessIds = @(Get-DemoElectronProcessIds $ElectronCommandLineMarkers)
        $HostStillRunning = $HostProcess -and (Get-Process -Id $HostProcess.Id -ErrorAction SilentlyContinue)
        if ($RemainingElectronProcessIds.Count -gt 0 -or $HostStillRunning) {
            throw (
                "Controlled input-proof cleanup left process(es) alive. " +
                "Electron PID(s): $($RemainingElectronProcessIds -join ', '); " +
                "host PID: $(if ($HostStillRunning) { $HostProcess.Id } else { 'none' })."
            )
        }
    }
}

if ($Wait -or $ClientInputMode) {
    exit $HostExitCode
}
