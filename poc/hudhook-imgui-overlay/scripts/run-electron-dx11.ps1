[CmdletBinding(DefaultParameterSetName = "Diagnostic")]
param(
    [switch]$Wait,

    [Parameter()]
    [ValidateSet("d3d11", "d3d12")]
    [string]$Backend = "d3d11",

    [Parameter(ParameterSetName = "Client")]
    [switch]$Client,

    [Parameter(ParameterSetName = "ClientWindow")]
    [switch]$ClientWindow,

    [Parameter(ParameterSetName = "ClientInput")]
    [switch]$ClientInput,

    [Parameter(ParameterSetName = "ClientInputManual")]
    [switch]$ClientInputManual,

    [Parameter(ParameterSetName = "ClientMultiWindow")]
    [switch]$ClientMultiWindow,

    [Parameter(ParameterSetName = "ClientMultiWindowManual")]
    [switch]$ClientMultiWindowManual,

    [Parameter()]
    [ValidateSet(1, 1.25, 1.5, 2)]
    [double]$DeviceScaleFactor = 1
)

$ErrorActionPreference = "Stop"
$env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL"
$ClientInputMode = $ClientInput -or $ClientInputManual
$ClientMultiWindowMode = $ClientMultiWindow -or $ClientMultiWindowManual
$InteractiveProofMode = $ClientInputMode -or $ClientMultiWindowMode
$InvariantCulture = [System.Globalization.CultureInfo]::InvariantCulture
$DeviceScaleFactorInvariant = $DeviceScaleFactor.ToString("0.##", $InvariantCulture)
if ($DeviceScaleFactor -ne 1 -and -not $ClientMultiWindow) {
    throw "Non-1 device scale is currently supported only by the automated -ClientMultiWindow proof."
}

function Convert-DipPlacementToPhysical {
    param([double]$Value)

    return [int][Math]::Round(
        $Value * $DeviceScaleFactor,
        [MidpointRounding]::AwayFromZero
    )
}

function Convert-DipExtentToPhysical {
    param([double]$Value)

    if ($Value -lt 0) {
        throw "DIP extents and local coordinates must be nonnegative."
    }
    return [int][Math]::Floor($Value * $DeviceScaleFactor)
}

function Get-IntegerTolerancePattern {
    param([int]$Value)

    $Alternatives = @(
        [regex]::Escape(($Value - 1).ToString($InvariantCulture))
        [regex]::Escape($Value.ToString($InvariantCulture))
        [regex]::Escape(($Value + 1).ToString($InvariantCulture))
    )
    return '(?:' + ($Alternatives -join '|') + ')'
}

# Producer stdout markers. Keep these synchronized with the corresponding
# Electron entry points and the real client's opt-in startup flag.
$DiagnosticReadyMarker = "HUDHOOK_ELECTRON_DEMO_READY"
$ClientReadyMarker = "HUDHOOK_CLIENT_OVERLAY_SESSION_READY"
$ClientHudhookConfiguredMarker = "HUDHOOK_CLIENT_HUDHOOK_CONFIGURED"
$ClientHudhookInjectorStartedMarker = "HUDHOOK_CLIENT_HUDHOOK_INJECTOR_STARTED"
$ClientHudhookInjectorReturnedMarker = "HUDHOOK_CLIENT_HUDHOOK_INJECTOR_RETURNED"
$ClientHudhookInjectorFailedMarker = "HUDHOOK_CLIENT_HUDHOOK_INJECTOR_FAILED"
$ClientHudhookTargetConnectedMarker = "HUDHOOK_CLIENT_HUDHOOK_TARGET_CONNECTED"
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
$ClientMultiWindowReadyMarker = "HUDHOOK_CLIENT_MULTIWINDOW_READY"
$ClientMultiWindowTargetMarker = "HUDHOOK_CLIENT_MULTIWINDOW_TARGET"
$ClientMultiWindowDragHandleMarker = "HUDHOOK_CLIENT_MULTIWINDOW_DRAG_HANDLE"
$ClientMultiWindowDeviceScaleMarker = "HUDHOOK_CLIENT_MULTIWINDOW_DEVICE_SCALE"
$ClientMultiWindowProducerBoundsMarker = "HUDHOOK_CLIENT_MULTIWINDOW_PRODUCER_BOUNDS"
$ClientMultiWindowOverlapMarker = "HUDHOOK_CLIENT_MULTIWINDOW_OVERLAP"
$ClientMultiWindowInterceptRequestedMarker = "HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_REQUESTED"
$ClientMultiWindowInterceptEnabledMarker = "HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_ENABLED"
$ClientMultiWindowInterceptDisabledMarker = "HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_DISABLED"
$ClientMultiWindowLifecycleCompleteMarker = "HUDHOOK_CLIENT_MULTIWINDOW_LIFECYCLE_COMPLETE"
$ClientMultiWindowTranslationReadyMarker = "HUDHOOK_CLIENT_MULTIWINDOW_TRANSLATION_READY"
$ClientMultiWindowManualReadyMarker = "HUDHOOK_CLIENT_MULTIWINDOW_MANUAL_READY"
$ClientMultiWindowManualSuspendedMarker = "HUDHOOK_CLIENT_MULTIWINDOW_MANUAL_SUSPENDED"
$ClientMultiWindowManualResumedMarker = "HUDHOOK_CLIENT_MULTIWINDOW_MANUAL_RESUMED"
$ClientMultiWindowFrontValue = "hudhook-front-proof-2026"
$ClientMultiWindowBackValue = "hudhook-back-proof-2026"
$ClientMultiWindowFrontValueMarker = "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=front event=value value=$ClientMultiWindowFrontValue"
$ClientMultiWindowBackValueMarker = "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=value value=$ClientMultiWindowBackValue"
$ClientMultiWindowSceneMarker = "Electron overlay scene composed"
$ClientMultiWindowSceneInitialOrder = "order=ExampleMainOverlay>ExamplePopupOverlay"
$ClientMultiWindowSceneRaisedBackOrder = "order=ExamplePopupOverlay>ExampleMainOverlay"
$ClientMultiWindowCaptionMovedMarker = "Electron overlay moved by caption drag"
$ClientMultiWindowBackNameMarker = "window_name=ExampleMainOverlay"
$ClientMultiWindowFrontNameMarker = "window_name=ExamplePopupOverlay"
$ClientAutoStartFlag = "--start-overlay-session"
$ClientWindowRunnerFlag = "--hudhook-client-window-runner"
$ClientInputRunnerFlag = "--hudhook-client-input-runner"
$ClientInputManualFlag = "--hudhook-client-input-manual"
$ClientMultiWindowRunnerFlag = "--hudhook-client-multiwindow-runner"
$ClientMultiWindowManualFlag = "--hudhook-client-multiwindow-manual"

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
$BackendConfig = if ($Backend -eq "d3d12") {
    @{
        DisplayName = "D3D12"
        RunDirectoryName = "dx12"
        BuildScriptName = "build-dx12.ps1"
        HostExecutableName = "d3d12_overlay_test_host.exe"
        HostProcessName = "d3d12_overlay_test_host"
        PayloadName = "hudhook_imgui_overlay_dx12.dll"
        WindowTitle = "Controlled D3D12 overlay test host"
    }
}
else {
    @{
        DisplayName = "D3D11"
        RunDirectoryName = "dx11"
        BuildScriptName = "build-dx11.ps1"
        HostExecutableName = "d3d11_overlay_test_host.exe"
        HostProcessName = "d3d11_overlay_test_host"
        PayloadName = "hudhook_imgui_overlay_dx11.dll"
        WindowTitle = "Controlled D3D11 overlay test host"
    }
}
$BackendDisplayName = $BackendConfig.DisplayName
$HostProcessName = $BackendConfig.HostProcessName
$BuildScript = Join-Path $PSScriptRoot $BackendConfig.BuildScriptName
$RunDirectory = Join-Path $RepoRoot "build\hudhook-imgui-overlay\run\$($BackendConfig.RunDirectoryName)"
$HostExecutable = Join-Path $RunDirectory $BackendConfig.HostExecutableName
$Injector = Join-Path $RunDirectory "hudhook_overlay_injector.exe"
$Payload = Join-Path $RunDirectory $BackendConfig.PayloadName
$PayloadLogStem = [System.IO.Path]::GetFileNameWithoutExtension($BackendConfig.PayloadName)
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
$ClientMultiWindowRunToken = [Guid]::NewGuid().ToString("N")
$ClientMultiWindowUserDataDirectory = Join-Path $RunDirectory "electron-client-multiwindow-user-data-$ClientMultiWindowRunToken"
$ClientMultiWindowControlFile = Join-Path $RunDirectory "electron-client-multiwindow-$ClientMultiWindowRunToken.control"
$WindowTitle = $BackendConfig.WindowTitle
$OverlayIpcHostWindowTitle = "n_overlay_1a1y2o8l0b"

if ($Client) {
    $ProducerMode = "Client"
    $ElectronReadyMarker = $ClientReadyMarker
    $ElectronApplication = $RepoRoot
    $ElectronArguments = @(
        $RepoRoot,
        $ClientAutoStartFlag,
        "--hudhook-overlay",
        "--hudhook-backend=$Backend",
        "--hudhook-runtime-dir=$RunDirectory",
        "--hudhook-auto-target-process=$($BackendConfig.HostExecutableName)",
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
    $ExpectedResult = "the real ExampleMainOverlay is rendered at its native bounds inside the controlled $BackendDisplayName host."
}
elseif ($ClientMultiWindow) {
    $ProducerMode = "ClientMultiWindow"
    $ElectronReadyMarker = $ClientMultiWindowReadyMarker
    $ElectronApplication = $ClientWindowAppDirectory
    $ElectronArguments = @(
        $ClientWindowAppDirectory,
        $ClientMultiWindowRunnerFlag,
        "--hudhook-device-scale-factor=$DeviceScaleFactorInvariant",
        "--input-control-file=$ClientMultiWindowControlFile",
        "--user-data-dir=$ClientMultiWindowUserDataDirectory",
        "--no-sandbox"
    )
    # This per-run GUID is inherited by every Chromium child and remains the
    # sole process-discovery/cleanup token for the controlled producer tree.
    $ElectronCommandLineMarkers = @($ClientMultiWindowUserDataDirectory)
    $ElectronStdoutLog = Join-Path $RunDirectory "electron-client-multiwindow.stdout.log"
    $ElectronStderrLog = Join-Path $RunDirectory "electron-client-multiwindow.stderr.log"
    $ExpectedResult = "two overlapping real Electron windows compose, move by caption drag, and route focus, keyboard, capture, close, registration, and z-order deterministically."
}
elseif ($ClientMultiWindowManual) {
    $ProducerMode = "ClientMultiWindowManual"
    $ElectronReadyMarker = $ClientMultiWindowReadyMarker
    $ElectronApplication = $ClientWindowAppDirectory
    $ElectronArguments = @(
        $ClientWindowAppDirectory,
        $ClientMultiWindowManualFlag,
        "--hudhook-device-scale-factor=$DeviceScaleFactorInvariant",
        "--user-data-dir=$ClientMultiWindowUserDataDirectory",
        "--no-sandbox"
    )
    $ElectronCommandLineMarkers = @($ClientMultiWindowUserDataDirectory)
    $ElectronStdoutLog = Join-Path $RunDirectory "electron-client-multiwindow-manual.stdout.log"
    $ElectronStderrLog = Join-Path $RunDirectory "electron-client-multiwindow-manual.stderr.log"
    $ExpectedResult = "you can move, interact with, hide/show, and raise the overlapping BACK and FRONT Electron windows until closing the controlled host."
}
elseif ($ClientInput) {
    $ProducerMode = "ClientInput"
    $ElectronReadyMarker = $ClientWindowReadyMarker
    $ElectronApplication = $ClientWindowAppDirectory
    $ElectronArguments = @(
        $ClientWindowAppDirectory,
        $ClientInputRunnerFlag,
        "--hudhook-device-scale-factor=$DeviceScaleFactorInvariant",
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
        "--hudhook-device-scale-factor=$DeviceScaleFactorInvariant",
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
        "--hudhook-device-scale-factor=$DeviceScaleFactorInvariant",
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
    $ExpectedResult = "the diagnostic Electron demo window is rendered inside the controlled $BackendDisplayName host."
}

$RequiredPayloadProofMarkers = @($CommonPayloadProofMarkers)
$RequiredElectronProofMarkers = @()
if ($ClientMultiWindowMode) {
    $RequiredPayloadProofMarkers += @(
        $ClientMetadataSelectedProofMarker,
        $ClientMultiWindowBackNameMarker,
        $ClientMultiWindowFrontNameMarker,
        $ClientMultiWindowSceneMarker
    )
    $RequiredElectronProofMarkers += @(
        $ClientMultiWindowTargetMarker,
        $ClientMultiWindowDeviceScaleMarker,
        $ClientMultiWindowOverlapMarker,
        $ClientMultiWindowInterceptRequestedMarker,
        $ClientMultiWindowTranslationReadyMarker
    )
}
elseif ($ClientInputMode) {
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
    $RequiredElectronProofMarkers += @(
        $ClientReadyMarker,
        $ClientHudhookConfiguredMarker,
        $ClientHudhookInjectorStartedMarker,
        $ClientHudhookInjectorReturnedMarker
    )
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

        public static void SendLeftDown()
        {
            SendInputs(new [] { MouseInput(MOUSEEVENTF_LEFTDOWN, 0, 0, 0) });
        }

        public static void SendLeftUp()
        {
            SendInputs(new [] { MouseInput(MOUSEEVENTF_LEFTUP, 0, 0, 0) });
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

if (-not ("HudhookOverlayRunner.DpiMethods" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace HudhookOverlayRunner
{
    public static class DpiMethods
    {
        [DllImport("user32.dll")]
        private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);

        public static bool IsPerMonitorV2Aware(IntPtr window)
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is the pseudo-handle -4.
            return AreDpiAwarenessContextsEqual(
                GetWindowDpiAwarenessContext(window),
                new IntPtr(-4));
        }
    }
}
"@
}

function Invoke-WithLeftButtonDown {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Gesture
    )

    $GestureFailure = $null
    try {
        [HudhookOverlayRunner.NativeInputMethods]::SendLeftDown()
        & $Gesture
    }
    catch {
        $GestureFailure = $_
    }
    finally {
        try {
            # Always attempt the matching release, including when SendLeftDown
            # itself or any assertion inside the gesture throws.
            [HudhookOverlayRunner.NativeInputMethods]::SendLeftUp()
        }
        catch {
            if ($null -eq $GestureFailure) {
                throw
            }
            Write-Warning "Could not send the guarded left-button release: $($_.Exception.Message)"
        }
    }

    if ($null -ne $GestureFailure) {
        throw $GestureFailure
    }
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
        return [string](Get-Content -LiteralPath $Path -Raw -ErrorAction Stop)
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

function Get-ControlledHudhookInjectorProcesses {
    param(
        [int[]]$ElectronProcessIds = @()
    )

    $CapturedParentIds = @($ElectronProcessIds | Sort-Object -Unique)
    if ($CapturedParentIds.Count -eq 0) {
        return
    }

    $ExpectedInjectorPath = [System.IO.Path]::GetFullPath($Injector)
    foreach (
        $Candidate in @(
            Get-CimInstance `
                -ClassName Win32_Process `
                -Filter "Name = 'hudhook_overlay_injector.exe'" `
                -ErrorAction Stop
        )
    ) {
        if ([int]$Candidate.ParentProcessId -notin $CapturedParentIds) {
            continue
        }
        if (-not $Candidate.ExecutablePath) {
            throw "Cannot verify the executable path for controlled injector PID $($Candidate.ProcessId)."
        }

        $CandidatePath = [System.IO.Path]::GetFullPath($Candidate.ExecutablePath)
        if (
            $CandidatePath.Equals(
                $ExpectedInjectorPath,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        ) {
            $Candidate
        }
    }
}

function Stop-ControlledHudhookInjectors {
    param(
        [int[]]$ElectronProcessIds = @()
    )

    foreach ($Candidate in @(Get-ControlledHudhookInjectorProcesses $ElectronProcessIds)) {
        $Process = Get-Process -Id $Candidate.ProcessId -ErrorAction SilentlyContinue
        if ($Process) {
            Stop-LaunchedProcess $Process "client-owned hudhook injector"
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
    -not $ClientMultiWindow -and
    -not $ClientMultiWindowManual -and
    -not (Test-Path $DiagnosticEntry -PathType Leaf)
) {
    throw "Electron diagnostic entry point not found: $DiagnosticEntry"
}

if (
    ($ClientWindow -or $InteractiveProofMode) -and
    -not (Test-Path $ClientWindowEntry -PathType Leaf)
) {
    throw "Electron client-window entry point not found: $ClientWindowEntry"
}

$ExistingHosts = Get-Process -Name $HostProcessName -ErrorAction SilentlyContinue
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

if ($Client -or $InteractiveProofMode) {
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
    if ($InteractiveProofMode) {
        foreach ($Artifact in @($OverlaySdkBuiltEntry, $NodeAddonBuiltEntry)) {
            if (-not (Test-Path $Artifact -PathType Leaf)) {
                throw "The input-proof build completed without producing: $Artifact"
            }
        }
    }
}

function Get-RegexCount {
    param(
        [AllowEmptyString()]
        [string]$Content = "",
        [Parameter(Mandatory = $true)]
        [string]$Pattern
    )

    return [regex]::Matches($Content, $Pattern).Count
}

function Wait-ForProofRegexCounts {
    param(
        [hashtable]$PayloadMinimumCounts = @{},
        [hashtable]$ElectronMinimumCounts = @{},
        [Parameter(Mandatory = $true)]
        [string]$Phase,
        [int]$TimeoutSeconds = 15
    )

    $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $Missing = @()
    do {
        Start-Sleep -Milliseconds 50
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) {
            throw "The controlled host exited during proof phase '$Phase'."
        }

        $CurrentElectronProcessIds = @(
            Update-LaunchedElectronProcessIds `
                $ElectronProcessIds `
                $PreexistingElectronProcessIds `
                $ElectronCommandLineMarkers
        )
        if (@(Get-LiveProcessIds $CurrentElectronProcessIds).Count -eq 0) {
            throw "The Electron producer exited during proof phase '$Phase'."
        }

        $PayloadContent = Get-FileContent $PayloadLog
        $ElectronContent = Get-FileContent $ElectronStdoutLog
        $Missing = @(
            foreach ($Entry in $PayloadMinimumCounts.GetEnumerator()) {
                $Count = Get-RegexCount $PayloadContent $Entry.Key
                if ($Count -lt [int]$Entry.Value) {
                    "payload /$($Entry.Key)/ expected >= $($Entry.Value), observed $Count"
                }
            }
            foreach ($Entry in $ElectronMinimumCounts.GetEnumerator()) {
                $Count = Get-RegexCount $ElectronContent $Entry.Key
                if ($Count -lt [int]$Entry.Value) {
                    "Electron /$($Entry.Key)/ expected >= $($Entry.Value), observed $Count"
                }
            }
        )
    } while ($Missing.Count -gt 0 -and [DateTime]::UtcNow -lt $Deadline)

    if ($Missing.Count -gt 0) {
        throw "Timed out during proof phase '$Phase': $($Missing -join '; ')."
    }

    return [pscustomobject]@{
        Payload = $PayloadContent
        Electron = $ElectronContent
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
if ($ClientMultiWindowMode) {
    New-Item -ItemType Directory -Path $ClientMultiWindowUserDataDirectory -Force | Out-Null
}
if ($ClientInput) {
    if (Test-Path $ClientInputControlFile -PathType Leaf) {
        Remove-Item -LiteralPath $ClientInputControlFile -Force
    }
}
if ($ClientMultiWindow) {
    if (Test-Path $ClientMultiWindowControlFile -PathType Leaf) {
        Remove-Item -LiteralPath $ClientMultiWindowControlFile -Force
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
$ElectronWindowFilterWasPresent = Test-Path Env:HUDHOOK_ELECTRON_WINDOW
$ElectronWindowFilterOriginalValue = $env:HUDHOOK_ELECTRON_WINDOW
$ElectronWindowFilterTemporarilyCleared = $false

try {
    if ($ClientMultiWindowMode -and $ElectronWindowFilterWasPresent) {
        Remove-Item Env:HUDHOOK_ELECTRON_WINDOW
        $ElectronWindowFilterTemporarilyCleared = $true
        Write-Host "Temporarily cleared HUDHOOK_ELECTRON_WINDOW for the multi-window test."
    }

    Assert-NoOverlayIpcHost

    $UnexpectedHosts = Get-Process -Name $HostProcessName -ErrorAction SilentlyContinue
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

    if ($Client) {
        $HostProcess = Start-Process `
            -PassThru `
            -WorkingDirectory $RunDirectory `
            -FilePath $HostExecutable

        $HostDeadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 100
            $HostProcess.Refresh()

            if ($HostProcess.HasExited) {
                throw "The controlled host exited before the real client launched with code $($HostProcess.ExitCode)."
            }
        } while ($HostProcess.MainWindowTitle -ne $WindowTitle -and [DateTime]::UtcNow -lt $HostDeadline)

        if ($HostProcess.MainWindowTitle -ne $WindowTitle) {
            throw "Timed out waiting for the controlled host window before launching the real client."
        }

        $HostWindow = $HostProcess.MainWindowHandle
        if (
            $HostWindow -eq [IntPtr]::Zero -or
            -not [HudhookOverlayRunner.DpiMethods]::IsPerMonitorV2Aware($HostWindow)
        ) {
            throw "The controlled host window is not running with Per-Monitor-V2 DPI awareness."
        }
        Write-Host "Verified controlled host Per-Monitor-V2 DPI awareness."

        $PayloadLog = Join-Path $RunDirectory "$PayloadLogStem-$($HostProcess.Id).log"
        if (Test-Path $PayloadLog) {
            Remove-Item -LiteralPath $PayloadLog -Force
        }

        $ExpectedTargetMarker = "$ClientHudhookTargetConnectedMarker pid=$($HostProcess.Id)"
        $RequiredElectronProofMarkers += $ExpectedTargetMarker
        $ElectronArguments += "--hudhook-expected-target-pid=$($HostProcess.Id)"
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

        if ($Client) {
            $HostProcess.Refresh()
            if ($HostProcess.HasExited) {
                throw "The controlled host exited while the real client was starting."
            }
        }

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

    if (-not $Client) {
        $ExistingHosts = Get-Process -Name $HostProcessName -ErrorAction SilentlyContinue
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

        $HostWindow = $HostProcess.MainWindowHandle
        if (
            $HostWindow -eq [IntPtr]::Zero -or
            -not [HudhookOverlayRunner.DpiMethods]::IsPerMonitorV2Aware($HostWindow)
        ) {
            throw "The controlled host window is not running with Per-Monitor-V2 DPI awareness."
        }
        Write-Host "Verified controlled host Per-Monitor-V2 DPI awareness."

        $PayloadLog = Join-Path $RunDirectory "$PayloadLogStem-$($HostProcess.Id).log"
        if (Test-Path $PayloadLog) {
            Remove-Item -LiteralPath $PayloadLog -Force
        }

        & $Injector `
            --title $WindowTitle `
            --backend $Backend `
            --dll $Payload

        if ($LASTEXITCODE -ne 0) {
            throw "The injector failed with exit code $LASTEXITCODE."
        }
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
        throw "The PID-specific payload log is missing proof marker(s): $($MissingPayloadMarkers -join '; '). Log: $PayloadLog"
    }

    if (-not $HasAllElectronMarkers) {
        $MissingElectronMarkers = @(
            foreach ($Marker in $RequiredElectronProofMarkers) {
                if (-not $ObservedElectronMarkers[$Marker]) {
                    $Marker
                }
            }
        )
        throw "The Electron producer is missing lifecycle/orchestration proof marker(s): $($MissingElectronMarkers -join '; '). Log: $ElectronStdoutLog"
    }

    if ($Client) {
        $ElectronOutput = Get-FileContent $ElectronStdoutLog
        $ElectronErrorOutput = Get-FileContent $ElectronStderrLog
        $TargetLabelJson = ConvertTo-Json `
            -Compress `
            -InputObject "process:$($BackendConfig.HostExecutableName)"
        $RuntimeDirectoryJson = ConvertTo-Json -Compress -InputObject $RunDirectory
        $ExpectedConfiguredLine = (
            "$ClientHudhookConfiguredMarker " +
            "backend=$Backend runtime=$RuntimeDirectoryJson"
        )
        $ExpectedStartedLine = (
            "$ClientHudhookInjectorStartedMarker " +
            "backend=$Backend target=$TargetLabelJson"
        )
        $ExpectedReturnedLine = (
            "$ClientHudhookInjectorReturnedMarker " +
            "backend=$Backend target=$TargetLabelJson"
        )
        $ExactConfiguredPattern = (
            '(?m)^' + [regex]::Escape($ExpectedConfiguredLine) + '\r?$'
        )
        $ExactStartedPattern = (
            '(?m)^' + [regex]::Escape($ExpectedStartedLine) + '\r?$'
        )
        $ExactReturnedPattern = (
            '(?m)^' + [regex]::Escape($ExpectedReturnedLine) + '\r?$'
        )
        $ExactTargetPattern = (
            '(?m)^' + [regex]::Escape($ExpectedTargetMarker) + '\r?$'
        )
        $ReadyPattern = (
            '(?m)^' + [regex]::Escape($ClientReadyMarker) + '(?: .*)?\r?$'
        )
        $FailedPattern = (
            '(?m)^' + [regex]::Escape($ClientHudhookInjectorFailedMarker) +
            '(?: .*)?\r?$'
        )

        $ConfiguredMatches = [regex]::Matches($ElectronOutput, $ExactConfiguredPattern)
        $StartedMatches = [regex]::Matches($ElectronOutput, $ExactStartedPattern)
        $ReturnedMatches = [regex]::Matches($ElectronOutput, $ExactReturnedPattern)
        $TargetMatches = [regex]::Matches($ElectronOutput, $ExactTargetPattern)
        $ReadyMatch = [regex]::Match($ElectronOutput, $ReadyPattern)
        $FailedCount = (
            [regex]::Matches($ElectronOutput, $FailedPattern).Count +
            [regex]::Matches($ElectronErrorOutput, $FailedPattern).Count
        )

        if (
            $ConfiguredMatches.Count -ne 1 -or
            $StartedMatches.Count -ne 1 -or
            $ReturnedMatches.Count -ne 1 -or
            $TargetMatches.Count -ne 1 -or
            -not $ReadyMatch.Success -or
            $FailedCount -ne 0
        ) {
            throw (
                "The real client did not produce exactly one configured/start/return/exact-target sequence " +
                "with zero injector failures. configured=$($ConfiguredMatches.Count), " +
                "started=$($StartedMatches.Count), returned=$($ReturnedMatches.Count), " +
                "target=$($TargetMatches.Count), failed=$FailedCount."
            )
        }

        $SessionReadyIndex = $ReadyMatch.Index
        $ConfiguredIndex = $ConfiguredMatches[0].Index
        $InjectorStartedIndex = $StartedMatches[0].Index
        $InjectorReturnedIndex = $ReturnedMatches[0].Index
        $TargetConnectedIndex = $TargetMatches[0].Index

        if (
            $SessionReadyIndex -ge $InjectorStartedIndex -or
            $ConfiguredIndex -ge $InjectorStartedIndex
        ) {
            throw "The real client started its hudhook injector before its overlay session and runtime configuration were ready."
        }
        if (
            $InjectorStartedIndex -ge $InjectorReturnedIndex -or
            $InjectorStartedIndex -ge $TargetConnectedIndex
        ) {
            throw "The real client's injector-start marker did not precede both request return and exact-target connection."
        }

        Write-Host "Verified client-owned hudhook request ordering and exact target PID $($HostProcess.Id)."
    }

    if ($ClientMultiWindowMode) {
        $ElectronOutput = Get-FileContent $ElectronStdoutLog
        $MultiWindowTargetPattern = (
            'HUDHOOK_CLIENT_MULTIWINDOW_TARGET ' +
            'role=(?<role>back|front) ' +
            'windowId=(?<windowId>\d+) ' +
            'x=(?<x>-?\d+(?:\.\d+)?) ' +
            'y=(?<y>-?\d+(?:\.\d+)?) ' +
            'width=(?<width>\d+(?:\.\d+)?) ' +
            'height=(?<height>\d+(?:\.\d+)?) ' +
            'windowX=(?<windowX>-?\d+) ' +
            'windowY=(?<windowY>-?\d+) ' +
            'centerX=(?<centerX>-?\d+(?:\.\d+)?) ' +
            'centerY=(?<centerY>-?\d+(?:\.\d+)?)'
        )
        $MultiWindowTargetMatches = [regex]::Matches(
            $ElectronOutput,
            $MultiWindowTargetPattern
        )
        $MultiWindowDragHandlePattern = (
            [regex]::Escape($ClientMultiWindowDragHandleMarker) + ' ' +
            'role=(?<role>back|front) ' +
            'windowId=(?<windowId>\d+) ' +
            'x=(?<x>-?\d+(?:\.\d+)?) ' +
            'y=(?<y>-?\d+(?:\.\d+)?) ' +
            'width=(?<width>\d+(?:\.\d+)?) ' +
            'height=(?<height>\d+(?:\.\d+)?) ' +
            'windowX=(?<windowX>-?\d+) ' +
            'windowY=(?<windowY>-?\d+) ' +
            'centerX=(?<centerX>-?\d+(?:\.\d+)?) ' +
            'centerY=(?<centerY>-?\d+(?:\.\d+)?)'
        )
        $MultiWindowDragHandleMatches = [regex]::Matches(
            $ElectronOutput,
            $MultiWindowDragHandlePattern
        )
        $BackTargetMatches = @(
            $MultiWindowTargetMatches |
                Where-Object { $_.Groups["role"].Value -eq "back" }
        )
        $FrontTargetMatches = @(
            $MultiWindowTargetMatches |
                Where-Object { $_.Groups["role"].Value -eq "front" }
        )
        $BackDragHandleMatches = @(
            $MultiWindowDragHandleMatches |
                Where-Object { $_.Groups["role"].Value -eq "back" }
        )
        $FrontDragHandleMatches = @(
            $MultiWindowDragHandleMatches |
                Where-Object { $_.Groups["role"].Value -eq "front" }
        )
        if ($BackTargetMatches.Count -eq 0 -or $FrontTargetMatches.Count -eq 0) {
            throw "Could not parse both role-specific multi-window targets from $ElectronStdoutLog."
        }
        if ($BackDragHandleMatches.Count -eq 0 -or $FrontDragHandleMatches.Count -eq 0) {
            throw "Could not parse both role-specific caption drag handles from $ElectronStdoutLog."
        }

        $BackTargetMatch = $BackTargetMatches[$BackTargetMatches.Count - 1]
        $FrontTargetMatch = $FrontTargetMatches[$FrontTargetMatches.Count - 1]
        $FrontDragHandleMatch = $FrontDragHandleMatches[$FrontDragHandleMatches.Count - 1]
        $BackWindowId = [int]::Parse(
            $BackTargetMatch.Groups["windowId"].Value,
            $InvariantCulture
        )
        $FrontWindowId = [int]::Parse(
            $FrontTargetMatch.Groups["windowId"].Value,
            $InvariantCulture
        )
        if ($BackWindowId -eq $FrontWindowId) {
            throw "The multi-window producer reported the same native id for BACK and FRONT."
        }

        $BackWindowX = [int]::Parse(
            $BackTargetMatch.Groups["windowX"].Value,
            $InvariantCulture
        )
        $BackWindowY = [int]::Parse(
            $BackTargetMatch.Groups["windowY"].Value,
            $InvariantCulture
        )
        $FrontWindowX = [int]::Parse(
            $FrontTargetMatch.Groups["windowX"].Value,
            $InvariantCulture
        )
        $FrontWindowY = [int]::Parse(
            $FrontTargetMatch.Groups["windowY"].Value,
            $InvariantCulture
        )
        $BackTargetX = [double]::Parse(
            $BackTargetMatch.Groups["x"].Value,
            $InvariantCulture
        )
        $BackTargetY = [double]::Parse(
            $BackTargetMatch.Groups["y"].Value,
            $InvariantCulture
        )
        $BackTargetWidth = [double]::Parse(
            $BackTargetMatch.Groups["width"].Value,
            $InvariantCulture
        )
        $BackTargetHeight = [double]::Parse(
            $BackTargetMatch.Groups["height"].Value,
            $InvariantCulture
        )
        $FrontTargetX = [double]::Parse(
            $FrontTargetMatch.Groups["x"].Value,
            $InvariantCulture
        )
        $FrontTargetY = [double]::Parse(
            $FrontTargetMatch.Groups["y"].Value,
            $InvariantCulture
        )
        $FrontTargetWidth = [double]::Parse(
            $FrontTargetMatch.Groups["width"].Value,
            $InvariantCulture
        )
        $FrontTargetHeight = [double]::Parse(
            $FrontTargetMatch.Groups["height"].Value,
            $InvariantCulture
        )
        $BackCenterX = [double]::Parse(
            $BackTargetMatch.Groups["centerX"].Value,
            $InvariantCulture
        )
        $BackCenterY = [double]::Parse(
            $BackTargetMatch.Groups["centerY"].Value,
            $InvariantCulture
        )
        $FrontCenterX = [double]::Parse(
            $FrontTargetMatch.Groups["centerX"].Value,
            $InvariantCulture
        )
        $FrontCenterY = [double]::Parse(
            $FrontTargetMatch.Groups["centerY"].Value,
            $InvariantCulture
        )
        $FrontDragHandleCenterX = [double]::Parse(
            $FrontDragHandleMatch.Groups["centerX"].Value,
            $InvariantCulture
        )
        $FrontDragHandleCenterY = [double]::Parse(
            $FrontDragHandleMatch.Groups["centerY"].Value,
            $InvariantCulture
        )
        $FrontDragHandleX = [double]::Parse(
            $FrontDragHandleMatch.Groups["x"].Value,
            $InvariantCulture
        )
        $FrontDragHandleY = [double]::Parse(
            $FrontDragHandleMatch.Groups["y"].Value,
            $InvariantCulture
        )
        $FrontDragHandleWidth = [double]::Parse(
            $FrontDragHandleMatch.Groups["width"].Value,
            $InvariantCulture
        )
        $FrontDragHandleHeight = [double]::Parse(
            $FrontDragHandleMatch.Groups["height"].Value,
            $InvariantCulture
        )
        if (
            [Math]::Abs($BackCenterX - $FrontCenterX) -gt 0.5 -or
            [Math]::Abs($BackCenterY - $FrontCenterY) -gt 0.5
        ) {
            throw "The BACK and FRONT DOM targets do not share the same host-client center."
        }
        $BackPhysicalWindowX = Convert-DipPlacementToPhysical $BackWindowX
        $BackPhysicalWindowY = Convert-DipPlacementToPhysical $BackWindowY
        $FrontPhysicalWindowX = Convert-DipPlacementToPhysical $FrontWindowX
        $FrontPhysicalWindowY = Convert-DipPlacementToPhysical $FrontWindowY
        $BackPhysicalWindowWidth = Convert-DipExtentToPhysical 640
        $BackPhysicalWindowHeight = Convert-DipExtentToPhysical 360
        $FrontPhysicalWindowWidth = Convert-DipExtentToPhysical 320
        $FrontPhysicalWindowHeight = Convert-DipExtentToPhysical 220

        # DOM markers remain logical DIPs. Convert their positive local center
        # independently from the signed top-level window placement, matching
        # the SDK's explicit native-pixel policy.
        $BackTargetLocalX = Convert-DipExtentToPhysical (
            $BackTargetX + ($BackTargetWidth / 2)
        )
        $BackTargetLocalY = Convert-DipExtentToPhysical (
            $BackTargetY + ($BackTargetHeight / 2)
        )
        $FrontTargetLocalX = Convert-DipExtentToPhysical (
            $FrontTargetX + ($FrontTargetWidth / 2)
        )
        $FrontTargetLocalY = Convert-DipExtentToPhysical (
            $FrontTargetY + ($FrontTargetHeight / 2)
        )
        $BackTargetClientX = $BackPhysicalWindowX + $BackTargetLocalX
        $BackTargetClientY = $BackPhysicalWindowY + $BackTargetLocalY
        $FrontTargetClientX = $FrontPhysicalWindowX + $FrontTargetLocalX
        $FrontTargetClientY = $FrontPhysicalWindowY + $FrontTargetLocalY
        if (
            $BackTargetClientX -ne $FrontTargetClientX -or
            $BackTargetClientY -ne $FrontTargetClientY
        ) {
            throw "The independently scaled BACK and FRONT target centers are not aligned."
        }
        $TargetClientX = $FrontTargetClientX
        $TargetClientY = $FrontTargetClientY

        $FrontDragHandleLocalCenterX =
            $FrontDragHandleX + ($FrontDragHandleWidth / 2)
        $FrontDragHandleLocalCenterY =
            $FrontDragHandleY + ($FrontDragHandleHeight / 2)
        if (
            [Math]::Abs(
                $FrontDragHandleCenterX -
                    ($FrontWindowX + $FrontDragHandleLocalCenterX)
            ) -gt 0.5 -or
            [Math]::Abs(
                $FrontDragHandleCenterY -
                    ($FrontWindowY + $FrontDragHandleLocalCenterY)
            ) -gt 0.5 -or
            $FrontDragHandleLocalCenterX -ne 160 -or
            $FrontDragHandleLocalCenterY -ne 60
        ) {
            throw "The FRONT caption proof handle is not centered at logical local point (160,60)."
        }
        $FrontDragStartLocalX = Convert-DipExtentToPhysical $FrontDragHandleLocalCenterX
        $FrontDragStartLocalY = Convert-DipExtentToPhysical $FrontDragHandleLocalCenterY
        $FrontDragStartClientX = $FrontPhysicalWindowX + $FrontDragStartLocalX
        $FrontDragStartClientY = $FrontPhysicalWindowY + $FrontDragStartLocalY
        $FrontDragDeltaX = Convert-DipExtentToPhysical 96
        $FrontDragDeltaY = Convert-DipExtentToPhysical 72
        $FrontDragEndClientX = $FrontDragStartClientX + $FrontDragDeltaX
        $FrontDragEndClientY = $FrontDragStartClientY + $FrontDragDeltaY
        $MovedFrontWindowX = $FrontPhysicalWindowX + $FrontDragDeltaX
        $MovedFrontWindowY = $FrontPhysicalWindowY + $FrontDragDeltaY
        $MovedFrontTargetClientX = $TargetClientX + $FrontDragDeltaX
        $MovedFrontTargetClientY = $TargetClientY + $FrontDragDeltaY
        if (
            $FrontDragStartClientX -ge $MovedFrontWindowX -and
            $FrontDragStartClientX -lt (
                $MovedFrontWindowX + $FrontPhysicalWindowWidth
            ) -and
            $FrontDragStartClientY -ge $MovedFrontWindowY -and
            $FrontDragStartClientY -lt (
                $MovedFrontWindowY + $FrontPhysicalWindowHeight
            )
        ) {
            throw "The original FRONT caption point is not exclusive after the planned move."
        }
        $CaptureClientX = $BackPhysicalWindowX + (Convert-DipExtentToPhysical 20)
        $CaptureClientY = $TargetClientY
        $CaptureFrontLocalX = $CaptureClientX - $FrontPhysicalWindowX
        $CaptureFrontLocalY = $CaptureClientY - $FrontPhysicalWindowY
        if ($CaptureFrontLocalX -ge 0) {
            throw "The capture proof point is not outside the FRONT window."
        }
        $BackRaiseProbeLocalX = Convert-DipExtentToPhysical 16
        $BackRaiseProbeLocalY = Convert-DipExtentToPhysical 64
        $BackRaiseProbeClientX = $BackPhysicalWindowX + $BackRaiseProbeLocalX
        $BackRaiseProbeClientY = $BackPhysicalWindowY + $BackRaiseProbeLocalY
        if ($BackRaiseProbeClientX -ge $FrontPhysicalWindowX) {
            throw "The BACK click-to-front probe is not exposed to the left of FRONT."
        }
        $BackCaptionBottom =
            (Convert-DipExtentToPhysical 10) +
            (Convert-DipExtentToPhysical 40)
        if ($BackRaiseProbeLocalY -lt $BackCaptionBottom) {
            throw "The BACK click-to-front probe overlaps its SDK-declared caption."
        }

        $ExpectedDeviceScaleMarker = (
            "$ClientMultiWindowDeviceScaleMarker " +
            "requestedScale=$DeviceScaleFactorInvariant " +
            "displayScale=$DeviceScaleFactorInvariant " +
            "backDpr=$DeviceScaleFactorInvariant " +
            "frontDpr=$DeviceScaleFactorInvariant " +
            "backFrame=${BackPhysicalWindowWidth}x${BackPhysicalWindowHeight} " +
            "frontFrame=${FrontPhysicalWindowWidth}x${FrontPhysicalWindowHeight}"
        )
        if (
            (Get-RegexCount `
                $ElectronOutput `
                ([regex]::Escape($ExpectedDeviceScaleMarker))) -ne 1
        ) {
            throw "The producer did not report the exact requested screen, renderer, and OSR device scale contract."
        }

        $BackSelectedPattern = (
            [regex]::Escape("Electron overlay metadata selected") +
            '[^\r\n]*' +
            [regex]::Escape("window_name=ExampleMainOverlay")
        )
        $FrontSelectedPattern = (
            [regex]::Escape("Electron overlay metadata selected") +
            '[^\r\n]*' +
            [regex]::Escape("window_name=ExamplePopupOverlay")
        )
        $BackUploadedPattern = (
            [regex]::Escape("Electron frame uploaded to GPU") +
            '(?=[^\r\n]*window_id=' + $BackWindowId + '(?!\d))' +
            '(?=[^\r\n]*window_name=ExampleMainOverlay(?:\s|$))' +
            '(?=[^\r\n]*width=' + $BackPhysicalWindowWidth + '(?!\d))' +
            '(?=[^\r\n]*height=' + $BackPhysicalWindowHeight + '(?!\d))' +
            '[^\r\n]*'
        )
        $FrontUploadedPattern = (
            [regex]::Escape("Electron frame uploaded to GPU") +
            '(?=[^\r\n]*window_id=' + $FrontWindowId + '(?!\d))' +
            '(?=[^\r\n]*window_name=ExamplePopupOverlay(?:\s|$))' +
            '(?=[^\r\n]*width=' + $FrontPhysicalWindowWidth + '(?!\d))' +
            '(?=[^\r\n]*height=' + $FrontPhysicalWindowHeight + '(?!\d))' +
            '[^\r\n]*'
        )
        $BackComposedPattern = (
            [regex]::Escape($CompositorProofMarker) +
            '(?=[^\r\n]*window_id=' + $BackWindowId + '(?!\d))' +
            '(?=[^\r\n]*window_name=ExampleMainOverlay(?:\s|$))' +
            '(?=[^\r\n]*x=' + $BackPhysicalWindowX + '(?!\d))' +
            '(?=[^\r\n]*y=' + $BackPhysicalWindowY + '(?!\d))' +
            '(?=[^\r\n]*width=' + $BackPhysicalWindowWidth + '(?!\d))' +
            '(?=[^\r\n]*height=' + $BackPhysicalWindowHeight + '(?!\d))' +
            '[^\r\n]*'
        )
        $FrontComposedPattern = (
            [regex]::Escape($CompositorProofMarker) +
            '(?=[^\r\n]*window_id=' + $FrontWindowId + '(?!\d))' +
            '(?=[^\r\n]*window_name=ExamplePopupOverlay(?:\s|$))' +
            '(?=[^\r\n]*x=' + $FrontPhysicalWindowX + '(?!\d))' +
            '(?=[^\r\n]*y=' + $FrontPhysicalWindowY + '(?!\d))' +
            '(?=[^\r\n]*width=' + $FrontPhysicalWindowWidth + '(?!\d))' +
            '(?=[^\r\n]*height=' + $FrontPhysicalWindowHeight + '(?!\d))' +
            '[^\r\n]*'
        )
        $InitialScenePattern = (
            [regex]::Escape($ClientMultiWindowSceneMarker) +
            '[^\r\n]*' +
            [regex]::Escape($ClientMultiWindowSceneInitialOrder)
        )
        $RaisedBackScenePattern = (
            [regex]::Escape($ClientMultiWindowSceneMarker) +
            '[^\r\n]*' +
            [regex]::Escape($ClientMultiWindowSceneRaisedBackOrder)
        )
        $BackOnlyScenePattern = (
            [regex]::Escape($ClientMultiWindowSceneMarker) +
            '[^\r\n]*order=ExampleMainOverlay(?!>)'
        )

        $InitialSceneProof = Wait-ForProofRegexCounts `
            -Phase "initial two-window registration, upload, and composition" `
            -PayloadMinimumCounts @{
                $BackSelectedPattern = 1
                $FrontSelectedPattern = 1
                $BackUploadedPattern = 1
                $FrontUploadedPattern = 1
                $BackComposedPattern = 1
                $FrontComposedPattern = 1
                $InitialScenePattern = 1
            }
        $InitialBackSelected = [regex]::Match(
            $InitialSceneProof.Payload,
            $BackSelectedPattern
        )
        $InitialFrontSelected = [regex]::Match(
            $InitialSceneProof.Payload,
            $FrontSelectedPattern
        )
        $InitialBackUploaded = [regex]::Match(
            $InitialSceneProof.Payload,
            $BackUploadedPattern
        )
        $InitialFrontUploaded = [regex]::Match(
            $InitialSceneProof.Payload,
            $FrontUploadedPattern
        )
        $InitialScene = [regex]::Match(
            $InitialSceneProof.Payload,
            $InitialScenePattern
        )
        if (
            $InitialFrontSelected.Index -le $InitialBackSelected.Index -or
            $InitialScene.Index -le $InitialBackUploaded.Index -or
            $InitialScene.Index -le $InitialFrontUploaded.Index
        ) {
            throw "Initial payload ordering did not prove BACK registration before FRONT and both uploads before back-to-front composition."
        }

        $HostProcess.Refresh()
        $HostWindow = $HostProcess.MainWindowHandle
        if ($HostWindow -eq [IntPtr]::Zero) {
            throw "The controlled host has no window handle for multi-window input mode."
        }
        $HostActivated = $false
        for ($Attempt = 0; $Attempt -lt 5 -and -not $HostActivated; $Attempt++) {
            $HostActivated = [HudhookOverlayRunner.NativeInputMethods]::ActivateWindow($HostWindow)
            if (-not $HostActivated) {
                Start-Sleep -Milliseconds 100
            }
        }
        if (-not $HostActivated) {
            throw "Could not activate the controlled host before enabling multi-window input."
        }
        [HudhookOverlayRunner.NativeInputMethods]::NotifyWindow($HostWindow)

        $EnabledElectronMarkers = @($ClientMultiWindowInterceptEnabledMarker)
        if ($ClientMultiWindowManual) {
            $EnabledElectronMarkers += $ClientMultiWindowManualReadyMarker
        }
        Wait-ForInputProofMarkers `
            -Phase "multi-window interception activation" `
            -PayloadMarkers @(
                "Electron input intercept enabled",
                $ClientInputFilterEnabledProofMarker
            ) `
            -ElectronMarkers $EnabledElectronMarkers
        $ActivationPayloadOutput = Get-FileContent $PayloadLog
        $FilterEnabledMatches = [regex]::Matches(
            $ActivationPayloadOutput,
            [regex]::Escape($ClientInputFilterEnabledProofMarker)
        )
        $InterceptEnabledMatches = [regex]::Matches(
            $ActivationPayloadOutput,
            [regex]::Escape("Electron input intercept enabled")
        )
        if (
            $FilterEnabledMatches.Count -eq 0 -or
            $InterceptEnabledMatches.Count -eq 0 -or
            $InterceptEnabledMatches[0].Index -le $FilterEnabledMatches[0].Index
        ) {
            throw "Multi-window enabled acknowledgement did not follow a new applied-filter boundary."
        }

        if ($ClientMultiWindow) {
            if (-not [HudhookOverlayRunner.NativeInputMethods]::IsForegroundWindow($HostWindow)) {
                throw "The controlled host lost foreground ownership before the FRONT click."
            }
            [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                $HostWindow,
                $TargetClientX,
                $TargetClientY
            ) | Out-Null
            Start-Sleep -Milliseconds 100

            $FrontFocusPattern = (
                [regex]::Escape("Electron overlay focused for input") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$FrontWindowId")
            )
            $BackFocusPattern = (
                [regex]::Escape("Electron overlay focused for input") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$BackWindowId")
            )
            $FrontDownPattern = (
                [regex]::Escape("Electron pointer input forwarded") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$FrontWindowId") +
                '[^\r\n]*win32_message=513'
            )
            $FrontMovePattern = (
                [regex]::Escape("Electron pointer input forwarded") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$FrontWindowId") +
                '[^\r\n]*win32_message=512'
            )
            $FrontUpPattern = (
                [regex]::Escape("Electron pointer input forwarded") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$FrontWindowId") +
                '[^\r\n]*win32_message=514'
            )
            $BackDownPattern = (
                [regex]::Escape("Electron pointer input forwarded") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$BackWindowId") +
                '[^\r\n]*win32_message=513'
            )
            $BackMovePattern = (
                [regex]::Escape("Electron pointer input forwarded") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$BackWindowId") +
                '[^\r\n]*win32_message=512'
            )
            $BackUpPattern = (
                [regex]::Escape("Electron pointer input forwarded") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$BackWindowId") +
                '[^\r\n]*win32_message=514'
            )
            $FrontTargetDownPattern = (
                $FrontDownPattern +
                '[^\r\n]*x=' +
                    (Get-IntegerTolerancePattern $FrontTargetLocalX) +
                    '(?!\d)' +
                '[^\r\n]*y=' +
                    (Get-IntegerTolerancePattern $FrontTargetLocalY) +
                    '(?!\d)'
            )
            $FrontTargetUpPattern = (
                $FrontUpPattern +
                '[^\r\n]*x=' +
                    (Get-IntegerTolerancePattern $FrontTargetLocalX) +
                    '(?!\d)' +
                '[^\r\n]*y=' +
                    (Get-IntegerTolerancePattern $FrontTargetLocalY) +
                    '(?!\d)'
            )
            $BackTargetDownPattern = (
                $BackDownPattern +
                '[^\r\n]*x=' +
                    (Get-IntegerTolerancePattern $BackTargetLocalX) +
                    '(?!\d)' +
                '[^\r\n]*y=' +
                    (Get-IntegerTolerancePattern $BackTargetLocalY) +
                    '(?!\d)'
            )
            $BackTargetUpPattern = (
                $BackUpPattern +
                '[^\r\n]*x=' +
                    (Get-IntegerTolerancePattern $BackTargetLocalX) +
                    '(?!\d)' +
                '[^\r\n]*y=' +
                    (Get-IntegerTolerancePattern $BackTargetLocalY) +
                    '(?!\d)'
            )
            $FrontPageFocusPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=front event=focus"
            )
            $FrontPageDownPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=front event=down"
            )
            $FrontPageUpPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=front event=up"
            )
            $FrontPageClickPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=front event=click"
            )
            $BackPageFocusPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=focus"
            )
            $BackPageClickPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=click"
            )

            $BeforeFrontClickPayload = Get-FileContent $PayloadLog
            $BeforeFrontClickElectron = Get-FileContent $ElectronStdoutLog
            $FrontFocusBaseline = Get-RegexCount $BeforeFrontClickPayload $FrontFocusPattern
            $FrontDownBaseline = Get-RegexCount $BeforeFrontClickPayload $FrontTargetDownPattern
            $FrontUpBaseline = Get-RegexCount $BeforeFrontClickPayload $FrontTargetUpPattern
            $BackClickBaseline = Get-RegexCount $BeforeFrontClickElectron $BackPageClickPattern
            $BackValueBaseline = Get-RegexCount `
                $BeforeFrontClickElectron `
                ([regex]::Escape($ClientMultiWindowBackValueMarker))
            $FrontPageFocusBaseline = Get-RegexCount `
                $BeforeFrontClickElectron `
                $FrontPageFocusPattern
            $FrontPageDownBaseline = Get-RegexCount `
                $BeforeFrontClickElectron `
                $FrontPageDownPattern
            $FrontPageUpBaseline = Get-RegexCount `
                $BeforeFrontClickElectron `
                $FrontPageUpPattern
            $FrontPageClickBaseline = Get-RegexCount `
                $BeforeFrontClickElectron `
                $FrontPageClickPattern

            [HudhookOverlayRunner.NativeInputMethods]::SendLeftClick()
            $FrontClickProof = Wait-ForProofRegexCounts `
                -Phase "initial topmost FRONT click" `
                -PayloadMinimumCounts @{
                    $FrontFocusPattern = $FrontFocusBaseline + 1
                    $FrontTargetDownPattern = $FrontDownBaseline + 1
                    $FrontTargetUpPattern = $FrontUpBaseline + 1
                } `
                -ElectronMinimumCounts @{
                    $FrontPageFocusPattern = $FrontPageFocusBaseline + 1
                    $FrontPageDownPattern = $FrontPageDownBaseline + 1
                    $FrontPageUpPattern = $FrontPageUpBaseline + 1
                    $FrontPageClickPattern = $FrontPageClickBaseline + 1
                }
            $FrontFocusIndex = [regex]::Matches(
                $FrontClickProof.Payload,
                $FrontFocusPattern
            )[$FrontFocusBaseline].Index
            $FrontDownIndex = [regex]::Matches(
                $FrontClickProof.Payload,
                $FrontTargetDownPattern
            )[$FrontDownBaseline].Index
            $FrontUpIndex = [regex]::Matches(
                $FrontClickProof.Payload,
                $FrontTargetUpPattern
            )[$FrontUpBaseline].Index
            if ($FrontDownIndex -le $FrontFocusIndex -or $FrontUpIndex -le $FrontDownIndex) {
                throw "Initial overlap click did not prove FRONT focus before down and up."
            }
            if (
                (Get-RegexCount $FrontClickProof.Electron $BackPageClickPattern) -ne
                    $BackClickBaseline
            ) {
                throw "The occluded BACK page received the initial overlap click."
            }

            [HudhookOverlayRunner.NativeInputMethods]::SendUnicodeText(
                $ClientMultiWindowFrontValue
            )
            $FrontKeyboardPattern = (
                [regex]::Escape("Electron keyboard input forwarded") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$FrontWindowId")
            )
            $FrontValueProof = Wait-ForProofRegexCounts `
                -Phase "FRONT keyboard focus" `
                -PayloadMinimumCounts @{ $FrontKeyboardPattern = 1 } `
                -ElectronMinimumCounts @{
                    ([regex]::Escape($ClientMultiWindowFrontValueMarker)) = 1
                }
            if (
                (Get-RegexCount `
                    $FrontValueProof.Electron `
                    ([regex]::Escape($ClientMultiWindowBackValueMarker))) -ne
                    $BackValueBaseline
            ) {
                throw "Keyboard input reached BACK while FRONT owned Electron focus."
            }

            [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                $HostWindow,
                $TargetClientX,
                $TargetClientY
            ) | Out-Null
            Start-Sleep -Milliseconds 100
            $BeforeCapturePayload = Get-FileContent $PayloadLog
            $CaptureFrontDownBaseline = Get-RegexCount $BeforeCapturePayload $FrontDownPattern
            $CaptureFrontMoveBaseline = Get-RegexCount $BeforeCapturePayload $FrontMovePattern
            $CaptureFrontUpBaseline = Get-RegexCount $BeforeCapturePayload $FrontUpPattern
            $CaptureBackDownBaseline = Get-RegexCount $BeforeCapturePayload $BackDownPattern
            $CaptureBackMoveBaseline = Get-RegexCount $BeforeCapturePayload $BackMovePattern
            $CaptureBackUpBaseline = Get-RegexCount $BeforeCapturePayload $BackUpPattern

            Invoke-WithLeftButtonDown {
                Wait-ForProofRegexCounts `
                    -Phase "FRONT capture acquisition" `
                    -PayloadMinimumCounts @{
                        $FrontDownPattern = $CaptureFrontDownBaseline + 1
                    } | Out-Null
                [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                    $HostWindow,
                    $CaptureClientX,
                    $CaptureClientY
                ) | Out-Null
                Start-Sleep -Milliseconds 100
            }

            $CaptureMoveAtOutsidePointPattern = (
                $FrontMovePattern +
                '[^\r\n]*x=-\d+[^\r\n]*y=-?\d+'
            )
            $CaptureUpAtOutsidePointPattern = (
                $FrontUpPattern +
                '[^\r\n]*x=-\d+[^\r\n]*y=-?\d+'
            )
            $CaptureProof = Wait-ForProofRegexCounts `
                -Phase "out-of-bounds FRONT capture" `
                -PayloadMinimumCounts @{
                    $FrontMovePattern = $CaptureFrontMoveBaseline + 1
                    $FrontUpPattern = $CaptureFrontUpBaseline + 1
                    $CaptureMoveAtOutsidePointPattern = 1
                    $CaptureUpAtOutsidePointPattern = 1
                }
            if (
                (Get-RegexCount $CaptureProof.Payload $BackDownPattern) -ne
                    $CaptureBackDownBaseline -or
                (Get-RegexCount $CaptureProof.Payload $BackMovePattern) -ne
                    $CaptureBackMoveBaseline -or
                (Get-RegexCount $CaptureProof.Payload $BackUpPattern) -ne
                    $CaptureBackUpBaseline
            ) {
                throw "BACK received pointer input while FRONT held capture."
            }

            $BackClosePattern = (
                [regex]::Escape("Electron overlay window closed") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$BackWindowId") +
                '[^\r\n]*' +
                [regex]::Escape("window_name=ExampleMainOverlay")
            )
            $BackReselectPattern = (
                [regex]::Escape("Electron overlay metadata reselected") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$BackWindowId") +
                '[^\r\n]*' +
                [regex]::Escape("window_name=ExampleMainOverlay")
            )
            $BackRaisedAfterInputPattern = (
                [regex]::Escape("Electron overlay raised to top after input") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$BackWindowId")
            )
            $BackProbeDownPattern = (
                $BackDownPattern +
                '[^\r\n]*x=' +
                    (Get-IntegerTolerancePattern $BackRaiseProbeLocalX) +
                    '(?!\d)' +
                '[^\r\n]*y=' +
                    (Get-IntegerTolerancePattern $BackRaiseProbeLocalY) +
                    '(?!\d)'
            )
            $BackProbeUpPattern = (
                $BackUpPattern +
                '[^\r\n]*x=' +
                    (Get-IntegerTolerancePattern $BackRaiseProbeLocalX) +
                    '(?!\d)' +
                '[^\r\n]*y=' +
                    (Get-IntegerTolerancePattern $BackRaiseProbeLocalY) +
                    '(?!\d)'
            )
            $RaiseBackCommandPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_COMMAND command=raise-back"
            )
            $RaiseBackMarkerPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_BACK_RAISED"
            )

            $BeforeClickRaisePayload = Get-FileContent $PayloadLog
            $BeforeClickRaiseElectron = Get-FileContent $ElectronStdoutLog
            $ClickRaiseFocusBaseline = Get-RegexCount `
                $BeforeClickRaisePayload `
                $BackFocusPattern
            $ClickRaiseDownBaseline = Get-RegexCount `
                $BeforeClickRaisePayload `
                $BackProbeDownPattern
            $ClickRaiseUpBaseline = Get-RegexCount `
                $BeforeClickRaisePayload `
                $BackProbeUpPattern
            $ClickRaiseMarkerBaseline = Get-RegexCount `
                $BeforeClickRaisePayload `
                $BackRaisedAfterInputPattern
            $ClickRaiseSceneBaseline = Get-RegexCount `
                $BeforeClickRaisePayload `
                $RaisedBackScenePattern
            $ClickRaiseBackCloseBaseline = Get-RegexCount `
                $BeforeClickRaisePayload `
                $BackClosePattern
            $ClickRaiseBackReselectBaseline = Get-RegexCount `
                $BeforeClickRaisePayload `
                $BackReselectPattern
            $ClickRaiseFrontDownBaseline = Get-RegexCount `
                $BeforeClickRaisePayload `
                $FrontDownPattern
            $ClickRaiseFrontUpBaseline = Get-RegexCount `
                $BeforeClickRaisePayload `
                $FrontUpPattern
            $ClickRaiseCommandBaseline = Get-RegexCount `
                $BeforeClickRaiseElectron `
                $RaiseBackCommandPattern
            $ClickRaiseLifecycleMarkerBaseline = Get-RegexCount `
                $BeforeClickRaiseElectron `
                $RaiseBackMarkerPattern

            [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                $HostWindow,
                $BackRaiseProbeClientX,
                $BackRaiseProbeClientY
            ) | Out-Null
            Start-Sleep -Milliseconds 100
            [HudhookOverlayRunner.NativeInputMethods]::SendLeftClick()
            $ClickRaiseProof = Wait-ForProofRegexCounts `
                -Phase "click exposed BACK client surface to raise it above FRONT" `
                -PayloadMinimumCounts @{
                    $BackRaisedAfterInputPattern = $ClickRaiseMarkerBaseline + 1
                    $BackFocusPattern = $ClickRaiseFocusBaseline + 1
                    $BackProbeDownPattern = $ClickRaiseDownBaseline + 1
                    $BackProbeUpPattern = $ClickRaiseUpBaseline + 1
                    $RaisedBackScenePattern = $ClickRaiseSceneBaseline + 1
                }
            $ClickRaiseFocusIndex = [regex]::Matches(
                $ClickRaiseProof.Payload,
                $BackFocusPattern
            )[$ClickRaiseFocusBaseline].Index
            $ClickRaiseDownIndex = [regex]::Matches(
                $ClickRaiseProof.Payload,
                $BackProbeDownPattern
            )[$ClickRaiseDownBaseline].Index
            $ClickRaiseUpIndex = [regex]::Matches(
                $ClickRaiseProof.Payload,
                $BackProbeUpPattern
            )[$ClickRaiseUpBaseline].Index
            if (
                $ClickRaiseDownIndex -le $ClickRaiseFocusIndex -or
                $ClickRaiseUpIndex -le $ClickRaiseDownIndex
            ) {
                throw "The BACK click-to-front proof did not preserve focus, down, and up order."
            }
            if (
                (Get-RegexCount $ClickRaiseProof.Payload $BackClosePattern) -ne
                    $ClickRaiseBackCloseBaseline -or
                (Get-RegexCount $ClickRaiseProof.Payload $BackReselectPattern) -ne
                    $ClickRaiseBackReselectBaseline -or
                (Get-RegexCount $ClickRaiseProof.Payload $FrontDownPattern) -ne
                    $ClickRaiseFrontDownBaseline -or
                (Get-RegexCount $ClickRaiseProof.Payload $FrontUpPattern) -ne
                    $ClickRaiseFrontUpBaseline -or
                (Get-RegexCount $ClickRaiseProof.Electron $RaiseBackCommandPattern) -ne
                    $ClickRaiseCommandBaseline -or
                (Get-RegexCount $ClickRaiseProof.Electron $RaiseBackMarkerPattern) -ne
                    $ClickRaiseLifecycleMarkerBaseline
            ) {
                throw "The BACK click-to-front transition leaked to FRONT or used the producer lifecycle path."
            }

            $BeforeClickRaisedOverlapPayload = Get-FileContent $PayloadLog
            $BeforeClickRaisedOverlapElectron = Get-FileContent $ElectronStdoutLog
            $ClickRaisedBackDownBaseline = Get-RegexCount `
                $BeforeClickRaisedOverlapPayload `
                $BackTargetDownPattern
            $ClickRaisedBackUpBaseline = Get-RegexCount `
                $BeforeClickRaisedOverlapPayload `
                $BackTargetUpPattern
            $ClickRaisedFrontDownBaseline = Get-RegexCount `
                $BeforeClickRaisedOverlapPayload `
                $FrontDownPattern
            $ClickRaisedFrontUpBaseline = Get-RegexCount `
                $BeforeClickRaisedOverlapPayload `
                $FrontUpPattern
            $ClickRaisedBackPageClickBaseline = Get-RegexCount `
                $BeforeClickRaisedOverlapElectron `
                $BackPageClickPattern
            $ClickRaisedFrontPageClickBaseline = Get-RegexCount `
                $BeforeClickRaisedOverlapElectron `
                $FrontPageClickPattern
            [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                $HostWindow,
                $TargetClientX,
                $TargetClientY
            ) | Out-Null
            Start-Sleep -Milliseconds 100
            [HudhookOverlayRunner.NativeInputMethods]::SendLeftClick()
            $ClickRaisedOverlapProof = Wait-ForProofRegexCounts `
                -Phase "click-raised BACK overlap routing before producer lifecycle" `
                -PayloadMinimumCounts @{
                    $BackTargetDownPattern = $ClickRaisedBackDownBaseline + 1
                    $BackTargetUpPattern = $ClickRaisedBackUpBaseline + 1
                } `
                -ElectronMinimumCounts @{
                    $BackPageClickPattern = $ClickRaisedBackPageClickBaseline + 1
                }
            if (
                (Get-RegexCount $ClickRaisedOverlapProof.Payload $FrontDownPattern) -ne
                    $ClickRaisedFrontDownBaseline -or
                (Get-RegexCount $ClickRaisedOverlapProof.Payload $FrontUpPattern) -ne
                    $ClickRaisedFrontUpBaseline -or
                (Get-RegexCount $ClickRaisedOverlapProof.Electron $FrontPageClickPattern) -ne
                    $ClickRaisedFrontPageClickBaseline
            ) {
                throw "FRONT received the overlap click after BACK was raised by input."
            }

            $BeforeRaiseBackPayload = Get-FileContent $PayloadLog
            $BeforeRaiseBackElectron = Get-FileContent $ElectronStdoutLog
            $BackCloseBaseline = Get-RegexCount $BeforeRaiseBackPayload $BackClosePattern
            $BackReselectBaseline = Get-RegexCount $BeforeRaiseBackPayload $BackReselectPattern
            $RaisedBackSceneBaseline = Get-RegexCount `
                $BeforeRaiseBackPayload `
                $RaisedBackScenePattern
            $RaiseBackMarkerBaseline = Get-RegexCount `
                $BeforeRaiseBackElectron `
                $RaiseBackMarkerPattern
            Set-Content `
                -LiteralPath $ClientMultiWindowControlFile `
                -Value "raise-back" `
                -NoNewline `
                -Encoding Ascii
            $RaiseBackProof = Wait-ForProofRegexCounts `
                -Phase "raise BACK above FRONT" `
                -PayloadMinimumCounts @{
                    $BackClosePattern = $BackCloseBaseline + 1
                    $BackReselectPattern = $BackReselectBaseline + 1
                    $RaisedBackScenePattern = $RaisedBackSceneBaseline + 1
                } `
                -ElectronMinimumCounts @{
                    $RaiseBackMarkerPattern = $RaiseBackMarkerBaseline + 1
                }
            $BackCloseIndex = [regex]::Matches(
                $RaiseBackProof.Payload,
                $BackClosePattern
            )[$BackCloseBaseline].Index
            $BackReselectIndex = [regex]::Matches(
                $RaiseBackProof.Payload,
                $BackReselectPattern
            )[$BackReselectBaseline].Index
            $RaisedBackSceneIndex = [regex]::Matches(
                $RaiseBackProof.Payload,
                $RaisedBackScenePattern
            )[$RaisedBackSceneBaseline].Index
            if (
                $BackReselectIndex -le $BackCloseIndex -or
                $RaisedBackSceneIndex -le $BackReselectIndex
            ) {
                throw "BACK close/re-registration did not precede FRONT>BACK recomposition."
            }

            [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                $HostWindow,
                $TargetClientX,
                $TargetClientY
            ) | Out-Null
            Start-Sleep -Milliseconds 100
            $BeforeBackClickPayload = Get-FileContent $PayloadLog
            $BeforeBackClickElectron = Get-FileContent $ElectronStdoutLog
            $BackFocusBaseline = Get-RegexCount $BeforeBackClickPayload $BackFocusPattern
            $BackDownBaseline = Get-RegexCount $BeforeBackClickPayload $BackTargetDownPattern
            $BackUpBaseline = Get-RegexCount $BeforeBackClickPayload $BackTargetUpPattern
            $BackPageFocusBaseline = Get-RegexCount `
                $BeforeBackClickElectron `
                $BackPageFocusPattern
            $BackPageClickBaseline = Get-RegexCount `
                $BeforeBackClickElectron `
                $BackPageClickPattern
            $FrontClickBeforeBack = Get-RegexCount `
                $BeforeBackClickElectron `
                $FrontPageClickPattern
            [HudhookOverlayRunner.NativeInputMethods]::SendLeftClick()
            $BackClickProof = Wait-ForProofRegexCounts `
                -Phase "raised BACK click" `
                -PayloadMinimumCounts @{
                    $BackFocusPattern = $BackFocusBaseline + 1
                    $BackTargetDownPattern = $BackDownBaseline + 1
                    $BackTargetUpPattern = $BackUpBaseline + 1
                } `
                -ElectronMinimumCounts @{
                    $BackPageFocusPattern = $BackPageFocusBaseline + 1
                    $BackPageClickPattern = $BackPageClickBaseline + 1
                }
            if (
                (Get-RegexCount $BackClickProof.Electron $FrontPageClickPattern) -ne
                    $FrontClickBeforeBack
            ) {
                throw "FRONT received the overlap click after BACK was raised."
            }
            [HudhookOverlayRunner.NativeInputMethods]::SendUnicodeText(
                $ClientMultiWindowBackValue
            )
            Wait-ForProofRegexCounts `
                -Phase "BACK keyboard focus" `
                -ElectronMinimumCounts @{
                    ([regex]::Escape($ClientMultiWindowBackValueMarker)) = 1
                } | Out-Null

            $FrontClosePattern = (
                [regex]::Escape("Electron overlay window closed") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$FrontWindowId") +
                '[^\r\n]*' +
                [regex]::Escape("window_name=ExamplePopupOverlay")
            )
            $FrontReselectPattern = (
                [regex]::Escape("Electron overlay metadata reselected") +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$FrontWindowId") +
                '[^\r\n]*' +
                [regex]::Escape("window_name=ExamplePopupOverlay")
            )
            $BeforeRaiseFrontPayload = Get-FileContent $PayloadLog
            $BeforeRaiseFrontElectron = Get-FileContent $ElectronStdoutLog
            $FrontCloseBaseline = Get-RegexCount $BeforeRaiseFrontPayload $FrontClosePattern
            $FrontReselectBaseline = Get-RegexCount `
                $BeforeRaiseFrontPayload `
                $FrontReselectPattern
            $InitialOrderBaseline = Get-RegexCount `
                $BeforeRaiseFrontPayload `
                $InitialScenePattern
            $RaiseFrontMarkerPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_FRONT_RAISED"
            )
            $RaiseFrontMarkerBaseline = Get-RegexCount `
                $BeforeRaiseFrontElectron `
                $RaiseFrontMarkerPattern
            Set-Content `
                -LiteralPath $ClientMultiWindowControlFile `
                -Value "raise-front" `
                -NoNewline `
                -Encoding Ascii
            $RaiseFrontProof = Wait-ForProofRegexCounts `
                -Phase "raise FRONT above BACK" `
                -PayloadMinimumCounts @{
                    $FrontClosePattern = $FrontCloseBaseline + 1
                    $FrontReselectPattern = $FrontReselectBaseline + 1
                    $InitialScenePattern = $InitialOrderBaseline + 1
                } `
                -ElectronMinimumCounts @{
                    $RaiseFrontMarkerPattern = $RaiseFrontMarkerBaseline + 1
                }
            $RaisedFrontCloseIndex = [regex]::Matches(
                $RaiseFrontProof.Payload,
                $FrontClosePattern
            )[$FrontCloseBaseline].Index
            $RaisedFrontReselectIndex = [regex]::Matches(
                $RaiseFrontProof.Payload,
                $FrontReselectPattern
            )[$FrontReselectBaseline].Index
            $RaisedFrontSceneIndex = [regex]::Matches(
                $RaiseFrontProof.Payload,
                $InitialScenePattern
            )[$InitialOrderBaseline].Index
            if (
                $RaisedFrontReselectIndex -le $RaisedFrontCloseIndex -or
                $RaisedFrontSceneIndex -le $RaisedFrontReselectIndex
            ) {
                throw "FRONT close/re-registration did not precede BACK>FRONT recomposition."
            }

            [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                $HostWindow,
                $TargetClientX,
                $TargetClientY
            ) | Out-Null
            Start-Sleep -Milliseconds 100
            $FrontClickBeforeFinal = Get-RegexCount `
                (Get-FileContent $ElectronStdoutLog) `
                $FrontPageClickPattern
            $BackClickBeforeFinal = Get-RegexCount `
                (Get-FileContent $ElectronStdoutLog) `
                $BackPageClickPattern
            [HudhookOverlayRunner.NativeInputMethods]::SendLeftClick()
            $FinalFrontClickProof = Wait-ForProofRegexCounts `
                -Phase "restored FRONT topmost click" `
                -ElectronMinimumCounts @{
                    $FrontPageClickPattern = $FrontClickBeforeFinal + 1
                }
            if (
                (Get-RegexCount $FinalFrontClickProof.Electron $BackPageClickPattern) -ne
                    $BackClickBeforeFinal
            ) {
                throw "BACK received the overlap click after FRONT was restored."
            }

            $BeforeHideFrontPayload = Get-FileContent $PayloadLog
            $BeforeHideFrontElectron = Get-FileContent $ElectronStdoutLog
            $HideFrontCloseBaseline = Get-RegexCount `
                $BeforeHideFrontPayload `
                $FrontClosePattern
            $BackOnlySceneBaseline = Get-RegexCount `
                $BeforeHideFrontPayload `
                $BackOnlyScenePattern
            $FrontHiddenPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_FRONT_HIDDEN"
            )
            $FrontHiddenBaseline = Get-RegexCount `
                $BeforeHideFrontElectron `
                $FrontHiddenPattern
            Set-Content `
                -LiteralPath $ClientMultiWindowControlFile `
                -Value "hide-front" `
                -NoNewline `
                -Encoding Ascii
            Wait-ForProofRegexCounts `
                -Phase "hide FRONT while BACK survives" `
                -PayloadMinimumCounts @{
                    $FrontClosePattern = $HideFrontCloseBaseline + 1
                    $BackOnlyScenePattern = $BackOnlySceneBaseline + 1
                } `
                -ElectronMinimumCounts @{
                    $FrontHiddenPattern = $FrontHiddenBaseline + 1
                } | Out-Null

            $BeforeShowFrontPayload = Get-FileContent $PayloadLog
            $BeforeShowFrontElectron = Get-FileContent $ElectronStdoutLog
            $ShowFrontReselectBaseline = Get-RegexCount `
                $BeforeShowFrontPayload `
                $FrontReselectPattern
            $ShowFrontSceneBaseline = Get-RegexCount `
                $BeforeShowFrontPayload `
                $InitialScenePattern
            $FrontShownPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_FRONT_SHOWN"
            )
            $FrontShownBaseline = Get-RegexCount `
                $BeforeShowFrontElectron `
                $FrontShownPattern
            Set-Content `
                -LiteralPath $ClientMultiWindowControlFile `
                -Value "show-front" `
                -NoNewline `
                -Encoding Ascii
            Wait-ForProofRegexCounts `
                -Phase "re-register FRONT after surviving BACK scene" `
                -PayloadMinimumCounts @{
                    $FrontReselectPattern = $ShowFrontReselectBaseline + 1
                    $InitialScenePattern = $ShowFrontSceneBaseline + 1
                } `
                -ElectronMinimumCounts @{
                    $FrontShownPattern = $FrontShownBaseline + 1
                } | Out-Null

            # Caption movement is deliberately last among the compositor
            # phases: it changes FRONT's payload-local rect, while every prior
            # lifecycle assertion above relies on the producer's original
            # registration bounds.
            $CaptionMovedPattern = (
                [regex]::Escape($ClientMultiWindowCaptionMovedMarker) +
                '(?=[^\r\n]*window_id=' + $FrontWindowId + '(?!\d))' +
                '(?=[^\r\n]*x=' + $MovedFrontWindowX + '(?!\d))' +
                '(?=[^\r\n]*y=' + $MovedFrontWindowY + '(?!\d))' +
                '[^\r\n]*'
            )
            $FrontBoundsUpdatePattern = (
                [regex]::Escape($ClientWindowBoundsProofMarker) +
                '[^\r\n]*' +
                [regex]::Escape("window_id=$FrontWindowId")
            )
            $ProducerLifecycleCommandPattern = (
                [regex]::Escape("HUDHOOK_CLIENT_MULTIWINDOW_COMMAND command=") +
                '(?:hide-front|show-front|raise-front|raise-back)'
            )
            $PagePointerInputPattern = (
                [regex]::Escape("HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=") +
                '(?:back|front) event=(?:down|up|click|drag|capture-up)'
            )
            $CaptionDomPattern = [regex]::Escape(
                "HUDHOOK_CLIENT_MULTIWINDOW_CAPTION_DOM role="
            )
            $CaptionStartQueueBarrierPattern = (
                [regex]::Escape(
                    "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=front event=queue-barrier"
                ) +
                '[^\r\n]*x=(?:159|160|161)(?!\d)' +
                '[^\r\n]*y=(?:59|60|61)(?!\d)'
            )
            $CaptionStartQueueBarrierBaseline = Get-RegexCount `
                (Get-FileContent $ElectronStdoutLog) `
                $CaptionStartQueueBarrierPattern
            [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                $HostWindow,
                $FrontDragStartClientX,
                $FrontDragStartClientY
            ) | Out-Null
            $CaptionStartQueueBarrierProof = Wait-ForProofRegexCounts `
                -Phase "drain outbound input before the caption gesture" `
                -ElectronMinimumCounts @{
                    $CaptionStartQueueBarrierPattern = $CaptionStartQueueBarrierBaseline + 1
                }
            # The hover marker is produced only after its normal mouse packet
            # reaches the page through the same FIFO as every older packet.
            # Taking baselines after it prevents delayed prior clicks from
            # being mistaken for caption leakage.
            $BeforeCaptionDragPayload = $CaptionStartQueueBarrierProof.Payload
            $BeforeCaptionDragElectron = $CaptionStartQueueBarrierProof.Electron
            $CaptionMovedBaseline = Get-RegexCount `
                $BeforeCaptionDragPayload `
                $CaptionMovedPattern
            $CaptionFrontDownBaseline = Get-RegexCount `
                $BeforeCaptionDragPayload `
                $FrontDownPattern
            $CaptionFrontMoveBaseline = Get-RegexCount `
                $BeforeCaptionDragPayload `
                $FrontMovePattern
            $CaptionFrontUpBaseline = Get-RegexCount `
                $BeforeCaptionDragPayload `
                $FrontUpPattern
            $CaptionBackDownBaseline = Get-RegexCount `
                $BeforeCaptionDragPayload `
                $BackDownPattern
            $CaptionBackMoveBaseline = Get-RegexCount `
                $BeforeCaptionDragPayload `
                $BackMovePattern
            $CaptionBackUpBaseline = Get-RegexCount `
                $BeforeCaptionDragPayload `
                $BackUpPattern
            $CaptionBoundsUpdateBaseline = Get-RegexCount `
                $BeforeCaptionDragPayload `
                $FrontBoundsUpdatePattern
            $CaptionProducerLifecycleBaseline = Get-RegexCount `
                $BeforeCaptionDragElectron `
                $ProducerLifecycleCommandPattern
            $CaptionPagePointerBaseline = Get-RegexCount `
                $BeforeCaptionDragElectron `
                $PagePointerInputPattern
            $CaptionDomBaseline = Get-RegexCount `
                $BeforeCaptionDragElectron `
                $CaptionDomPattern

            Invoke-WithLeftButtonDown {
                Start-Sleep -Milliseconds 100
                [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                    $HostWindow,
                    $FrontDragEndClientX,
                    $FrontDragEndClientY
                ) | Out-Null
                Start-Sleep -Milliseconds 100
            }

            $CaptionDragProof = Wait-ForProofRegexCounts `
                -Phase "move FRONT by its payload-local caption handle" `
                -PayloadMinimumCounts @{
                    $CaptionMovedPattern = $CaptionMovedBaseline + 1
                }
            $CaptionEndQueueBarrierPattern = (
                [regex]::Escape(
                    "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=front event=queue-barrier"
                ) +
                '[^\r\n]*x=(?:149|150|151)(?!\d)' +
                '[^\r\n]*y=(?:97|98|99)(?!\d)'
            )
            $CaptionEndQueueBarrierBaseline = Get-RegexCount `
                $CaptionDragProof.Electron `
                $CaptionEndQueueBarrierPattern
            [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                $HostWindow,
                $MovedFrontTargetClientX,
                $MovedFrontTargetClientY
            ) | Out-Null
            $CaptionEndQueueBarrierProof = Wait-ForProofRegexCounts `
                -Phase "drain outbound input after the caption gesture" `
                -ElectronMinimumCounts @{
                    $CaptionEndQueueBarrierPattern = $CaptionEndQueueBarrierBaseline + 1
                }
            # The post-gesture hover is behind any accidentally forwarded
            # caption packets in the payload FIFO. Once it reaches the page,
            # both the payload diagnostics and renderer console markers for
            # older packets are safe to compare against the drained baseline.
            $CaptionDragPayloadAfter = $CaptionEndQueueBarrierProof.Payload
            $CaptionDragElectronAfter = $CaptionEndQueueBarrierProof.Electron
            if (
                (Get-RegexCount $CaptionDragPayloadAfter $FrontDownPattern) -ne
                    $CaptionFrontDownBaseline -or
                (Get-RegexCount $CaptionDragPayloadAfter $FrontMovePattern) -ne
                    $CaptionFrontMoveBaseline -or
                (Get-RegexCount $CaptionDragPayloadAfter $FrontUpPattern) -ne
                    $CaptionFrontUpBaseline -or
                (Get-RegexCount $CaptionDragPayloadAfter $BackDownPattern) -ne
                    $CaptionBackDownBaseline -or
                (Get-RegexCount $CaptionDragPayloadAfter $BackMovePattern) -ne
                    $CaptionBackMoveBaseline -or
                (Get-RegexCount $CaptionDragPayloadAfter $BackUpPattern) -ne
                    $CaptionBackUpBaseline -or
                (Get-RegexCount $CaptionDragPayloadAfter $FrontBoundsUpdatePattern) -ne
                    $CaptionBoundsUpdateBaseline -or
                (Get-RegexCount $CaptionDragElectronAfter $ProducerLifecycleCommandPattern) -ne
                    $CaptionProducerLifecycleBaseline -or
                (Get-RegexCount $CaptionDragElectronAfter $PagePointerInputPattern) -ne
                    $CaptionPagePointerBaseline -or
                (Get-RegexCount $CaptionDragElectronAfter $CaptionDomPattern) -ne
                    $CaptionDomBaseline
            ) {
                throw "The caption gesture leaked DOM/pointer input or used producer bounds/lifecycle traffic."
            }

            $ReportedFrontBoundsPattern = (
                [regex]::Escape($ClientMultiWindowProducerBoundsMarker) +
                '[^\r\n]*stage=reported[^\r\n]*role=front' +
                '[^\r\n]*' + [regex]::Escape("windowId=$FrontWindowId") +
                '[^\r\n]*x=' + $FrontWindowX + '(?!\d)' +
                '[^\r\n]*y=' + $FrontWindowY + '(?!\d)' +
                '[^\r\n]*width=320(?!\d)[^\r\n]*height=220(?!\d)'
            )
            $ReportedFrontBoundsBaseline = Get-RegexCount `
                (Get-FileContent $ElectronStdoutLog) `
                $ReportedFrontBoundsPattern
            Set-Content `
                -LiteralPath $ClientMultiWindowControlFile `
                -Value "report-bounds" `
                -NoNewline `
                -Encoding Ascii
            $ReportedBoundsProof = Wait-ForProofRegexCounts `
                -Phase "confirm caption movement remains payload-local" `
                -ElectronMinimumCounts @{
                    $ReportedFrontBoundsPattern = $ReportedFrontBoundsBaseline + 1
                }
            if (
                (Get-RegexCount `
                    $ReportedBoundsProof.Electron `
                    $ProducerLifecycleCommandPattern) -ne
                    $CaptionProducerLifecycleBaseline
            ) {
                throw "A producer hide/show/raise command occurred during caption movement."
            }

            $MovedFrontTargetDownPattern = (
                $FrontDownPattern +
                '[^\r\n]*x=' +
                    (Get-IntegerTolerancePattern $FrontTargetLocalX) +
                    '(?!\d)' +
                '[^\r\n]*y=' +
                    (Get-IntegerTolerancePattern $FrontTargetLocalY) +
                    '(?!\d)'
            )
            $MovedFrontTargetUpPattern = (
                $FrontUpPattern +
                '[^\r\n]*x=' +
                    (Get-IntegerTolerancePattern $FrontTargetLocalX) +
                    '(?!\d)' +
                '[^\r\n]*y=' +
                    (Get-IntegerTolerancePattern $FrontTargetLocalY) +
                    '(?!\d)'
            )
            $BeforeMovedTargetPayload = Get-FileContent $PayloadLog
            $BeforeMovedTargetElectron = Get-FileContent $ElectronStdoutLog
            $MovedFrontDownBaseline = Get-RegexCount `
                $BeforeMovedTargetPayload `
                $MovedFrontTargetDownPattern
            $MovedFrontUpBaseline = Get-RegexCount `
                $BeforeMovedTargetPayload `
                $MovedFrontTargetUpPattern
            $MovedTargetBackDownBaseline = Get-RegexCount `
                $BeforeMovedTargetPayload `
                $BackDownPattern
            $MovedTargetBackUpBaseline = Get-RegexCount `
                $BeforeMovedTargetPayload `
                $BackUpPattern
            $MovedTargetFrontPageClickBaseline = Get-RegexCount `
                $BeforeMovedTargetElectron `
                $FrontPageClickPattern
            $MovedTargetBackPageClickBaseline = Get-RegexCount `
                $BeforeMovedTargetElectron `
                $BackPageClickPattern
            Start-Sleep -Milliseconds 100
            [HudhookOverlayRunner.NativeInputMethods]::SendLeftClick()
            $MovedTargetProof = Wait-ForProofRegexCounts `
                -Phase "route input at FRONT's moved text target" `
                -PayloadMinimumCounts @{
                    $MovedFrontTargetDownPattern = $MovedFrontDownBaseline + 1
                    $MovedFrontTargetUpPattern = $MovedFrontUpBaseline + 1
                } `
                -ElectronMinimumCounts @{
                    $FrontPageClickPattern = $MovedTargetFrontPageClickBaseline + 1
                }
            if (
                (Get-RegexCount $MovedTargetProof.Payload $BackDownPattern) -ne
                    $MovedTargetBackDownBaseline -or
                (Get-RegexCount $MovedTargetProof.Payload $BackUpPattern) -ne
                    $MovedTargetBackUpBaseline -or
                (Get-RegexCount $MovedTargetProof.Electron $BackPageClickPattern) -ne
                    $MovedTargetBackPageClickBaseline
            ) {
                throw "BACK received input at FRONT's moved text target."
            }

            $OldCaptionBackLocalX =
                $FrontDragStartClientX - $BackPhysicalWindowX
            $OldCaptionBackLocalY =
                $FrontDragStartClientY - $BackPhysicalWindowY
            $OldCaptionBackDownPattern = (
                $BackDownPattern +
                '[^\r\n]*x=' +
                    (Get-IntegerTolerancePattern $OldCaptionBackLocalX) +
                    '(?!\d)' +
                '[^\r\n]*y=' +
                    (Get-IntegerTolerancePattern $OldCaptionBackLocalY) +
                    '(?!\d)'
            )
            $OldCaptionBackUpPattern = (
                $BackUpPattern +
                '[^\r\n]*x=' +
                    (Get-IntegerTolerancePattern $OldCaptionBackLocalX) +
                    '(?!\d)' +
                '[^\r\n]*y=' +
                    (Get-IntegerTolerancePattern $OldCaptionBackLocalY) +
                    '(?!\d)'
            )
            $BeforeOldCaptionProbe = Get-FileContent $PayloadLog
            $OldCaptionBackDownBaseline = Get-RegexCount `
                $BeforeOldCaptionProbe `
                $OldCaptionBackDownPattern
            $OldCaptionBackUpBaseline = Get-RegexCount `
                $BeforeOldCaptionProbe `
                $OldCaptionBackUpPattern
            $OldCaptionFrontDownBaseline = Get-RegexCount `
                $BeforeOldCaptionProbe `
                $FrontDownPattern
            $OldCaptionFrontUpBaseline = Get-RegexCount `
                $BeforeOldCaptionProbe `
                $FrontUpPattern
            [HudhookOverlayRunner.NativeInputMethods]::MoveMouseToClientPoint(
                $HostWindow,
                $FrontDragStartClientX,
                $FrontDragStartClientY
            ) | Out-Null
            Start-Sleep -Milliseconds 100
            [HudhookOverlayRunner.NativeInputMethods]::SendLeftClick()
            $OldCaptionProbeProof = Wait-ForProofRegexCounts `
                -Phase "route the original FRONT caption point to BACK" `
                -PayloadMinimumCounts @{
                    $OldCaptionBackDownPattern = $OldCaptionBackDownBaseline + 1
                    $OldCaptionBackUpPattern = $OldCaptionBackUpBaseline + 1
                }
            if (
                (Get-RegexCount $OldCaptionProbeProof.Payload $FrontDownPattern) -ne
                    $OldCaptionFrontDownBaseline -or
                (Get-RegexCount $OldCaptionProbeProof.Payload $FrontUpPattern) -ne
                    $OldCaptionFrontUpBaseline
            ) {
                throw "FRONT still received input at its original caption position after moving."
            }

            $BeforeReleasePayload = Get-FileContent $PayloadLog
            $FilterDisabledPattern = [regex]::Escape(
                $ClientInputFilterDisabledProofMarker
            )
            $InterceptDisabledPattern = [regex]::Escape(
                "Electron input intercept disabled"
            )
            $FilterDisabledBaseline = Get-RegexCount `
                $BeforeReleasePayload `
                $FilterDisabledPattern
            $InterceptDisabledBaseline = Get-RegexCount `
                $BeforeReleasePayload `
                $InterceptDisabledPattern
            Set-Content `
                -LiteralPath $ClientMultiWindowControlFile `
                -Value "release" `
                -NoNewline `
                -Encoding Ascii
            $ReleaseProof = Wait-ForProofRegexCounts `
                -Phase "multi-window interception release" `
                -PayloadMinimumCounts @{
                    $FilterDisabledPattern = $FilterDisabledBaseline + 1
                    $InterceptDisabledPattern = $InterceptDisabledBaseline + 1
                } `
                -ElectronMinimumCounts @{
                    ([regex]::Escape($ClientMultiWindowInterceptDisabledMarker)) = 1
                    ([regex]::Escape($ClientMultiWindowLifecycleCompleteMarker)) = 1
                }
            $FilterDisabledIndex = [regex]::Matches(
                $ReleaseProof.Payload,
                $FilterDisabledPattern
            )[$FilterDisabledBaseline].Index
            $InterceptDisabledIndex = [regex]::Matches(
                $ReleaseProof.Payload,
                $InterceptDisabledPattern
            )[$InterceptDisabledBaseline].Index
            if ($InterceptDisabledIndex -le $FilterDisabledIndex) {
                throw "Multi-window disabled acknowledgement did not follow a new pass-through filter boundary."
            }

            $ReleasedEscapeMarkerPattern = [regex]::Escape(
                'HUDHOOK_CLIENT_MULTIWINDOW_INPUT role='
            ) + '[^\r\n]*event=key[^\r\n]*key="Escape"'
            $ReleasedEscapeBaseline = Get-RegexCount `
                (Get-FileContent $ElectronStdoutLog) `
                $ReleasedEscapeMarkerPattern
            if (-not [HudhookOverlayRunner.NativeInputMethods]::ActivateWindow($HostWindow)) {
                throw "Could not reactivate the controlled host after releasing multi-window input."
            }
            [HudhookOverlayRunner.NativeInputMethods]::NotifyWindow($HostWindow)
            if (-not [HudhookOverlayRunner.NativeInputMethods]::IsForegroundWindow($HostWindow)) {
                throw "The controlled host was not foreground before released Escape."
            }
            [HudhookOverlayRunner.NativeInputMethods]::SendEscape()
            if (-not $HostProcess.WaitForExit(5000)) {
                throw "The controlled host did not exit after released multi-window Escape."
            }
            $HostExitCode = $HostProcess.ExitCode
            if ($HostExitCode -ne 0) {
                throw "The controlled host exited with code $HostExitCode after released Escape."
            }
            Start-Sleep -Milliseconds 250
            if (
                (Get-RegexCount `
                    (Get-FileContent $ElectronStdoutLog) `
                    $ReleasedEscapeMarkerPattern) -ne $ReleasedEscapeBaseline
            ) {
                throw "Released Escape was incorrectly forwarded to an Electron overlay window."
            }
            Write-Host "Verified deterministic two-window composition, caption movement, routing, capture, z-order, lifecycle, and release."
        }
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

    if ($ClientInput -or $ClientMultiWindow) {
        Write-Host "The deterministic input proof is complete; the runner will clean only its controlled process tree."
    }
    elseif ($ClientInputManual -or $ClientMultiWindowManual -or $Wait) {
        if ($ClientMultiWindowManual) {
            Write-Host ""
            Write-Host "Manual multi-window input is ready. FRONT (blue) initially overlaps BACK (green)."
            Write-Host "Drag either striped :: DRAG ROLE :: caption handle to move that composited window."
            Write-Host "Use Hide/Show/Raise, click either text field, type, and separately drag from a field outside its window to test pointer capture."
            Write-Host "When finished, close the controlled host with its title-bar X; Escape and Alt+F4 are intercepted."
            $ObservedManualSuspendedCount = 0
            $ObservedManualResumedCount = 0
        }
        elseif ($ClientInputManual) {
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

            if ($ClientInputManual -or $ClientMultiWindowManual) {
                $ManualElectronOutput = Get-FileContent $ElectronStdoutLog
                $ManualSuspendedMarker = if ($ClientMultiWindowManual) {
                    $ClientMultiWindowManualSuspendedMarker
                }
                else {
                    $ClientInputManualSuspendedMarker
                }
                $ManualResumedMarker = if ($ClientMultiWindowManual) {
                    $ClientMultiWindowManualResumedMarker
                }
                else {
                    $ClientInputManualResumedMarker
                }
                $ManualSuspendedCount = [regex]::Matches(
                    $ManualElectronOutput,
                    [regex]::Escape($ManualSuspendedMarker)
                ).Count
                $ManualResumedCount = [regex]::Matches(
                    $ManualElectronOutput,
                    [regex]::Escape($ManualResumedMarker)
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
    if ($ElectronWindowFilterTemporarilyCleared) {
        $env:HUDHOOK_ELECTRON_WINDOW = $ElectronWindowFilterOriginalValue
    }

    $CleanupRequested = -not $RunVerified -or $Wait -or $InteractiveProofMode
    if ($CleanupRequested) {
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
        Stop-ControlledHudhookInjectors $ElectronProcessIds
        Stop-LaunchedProcess $ElectronLauncherProcess "Electron launcher"
    }

    if ($ClientInput -and (Test-Path $ClientInputControlFile -PathType Leaf)) {
        Remove-Item -LiteralPath $ClientInputControlFile -Force
    }
    if ($ClientMultiWindow -and (Test-Path $ClientMultiWindowControlFile -PathType Leaf)) {
        Remove-Item -LiteralPath $ClientMultiWindowControlFile -Force
    }

    if ($CleanupRequested) {
        $RemainingElectronProcessIds = @(Get-DemoElectronProcessIds $ElectronCommandLineMarkers)
        $HostStillRunning = $HostProcess -and (Get-Process -Id $HostProcess.Id -ErrorAction SilentlyContinue)
        $RemainingInjectors = @(Get-ControlledHudhookInjectorProcesses $ElectronProcessIds)
        $OverlayIpcHostStillRunning = Test-OverlayIpcHost
        if (
            $RemainingElectronProcessIds.Count -gt 0 -or
            $HostStillRunning -or
            $RemainingInjectors.Count -gt 0 -or
            $OverlayIpcHostStillRunning
        ) {
            throw (
                "Controlled proof cleanup left process(es) alive. " +
                "Electron PID(s): $($RemainingElectronProcessIds -join ', '); " +
                "host PID: $(if ($HostStillRunning) { $HostProcess.Id } else { 'none' }); " +
                "injector PID(s): $(@($RemainingInjectors.ProcessId) -join ', '); " +
                "IPC host active: $OverlayIpcHostStillRunning."
            )
        }
    }
}

if ($Wait -or $InteractiveProofMode) {
    exit $HostExitCode
}
