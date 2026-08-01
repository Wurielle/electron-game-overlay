[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d11", "d3d12")]
    [string]$Backend,
    [switch]$SkipBuild,
    [Parameter(DontShow = $true)]
    [switch]$FunctionsOnly,
    [Parameter(DontShow = $true)]
    [ValidateSet("legacy", "wm-input", "raw-buffer")]
    [string]$InputMode = "legacy",
    [Parameter(DontShow = $true)]
    [ValidateRange(1, 2)]
    [int]$AttemptCountOverride = 2
)

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $RuntimeRoot "..\..")).Path
$BuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
$ProductionBuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime-production"
$OutputDirectory = Join-Path $ProductionBuildRoot "RelWithDebInfo"
$BackendLabel = $Backend.ToUpperInvariant()
$HostName = "${Backend}_overlay_test_host.exe"
$HostTarget = "${Backend}_overlay_test_host"
$BuiltHost = Join-Path $OutputDirectory $HostName
$Electron = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
$Nx = Join-Path $RepoRoot "node_modules\.bin\nx.cmd"
$RunDirectory = Join-Path $BuildRoot "client-sdk-$Backend-$InputMode-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$ResultMarker = if ($InputMode -eq "legacy") {
    "${BackendLabel}_REAL_CLIENT_SDK_GATE_PASS"
}
else {
    "${BackendLabel}_$($InputMode.Replace('-', '_').ToUpperInvariant())_CLIENT_SDK_GATE_PASS"
}
$AttemptCount = $AttemptCountOverride

function Get-MatchingClientProcesses {
    @(
        Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -like "*$RepoRoot*" -and
                ($_.CommandLine -like "*--reshade-overlay*" -or
                    $_.CommandLine -like "*--hudhook-overlay*" -or
                    $_.CommandLine -like "*electron-overlay-scene-producer*")
            }
    )
}

function Get-MatchingInjectors {
    @(
        Get-CimInstance Win32_Process -Filter "Name='inject.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*$HostName*" }
    )
}

function Get-MatchingHosts {
    @(
        foreach ($ControlledHostName in @(
                "d3d11_overlay_test_host.exe",
                "d3d12_overlay_test_host.exe")) {
            Get-CimInstance Win32_Process `
                -Filter "Name='$ControlledHostName'" `
                -ErrorAction SilentlyContinue
        }
    )
}

function Get-ClientLogText {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return ""
    }
    return Get-Content -Raw -LiteralPath $Path
}

function Wait-ForClientMarker {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$ClientProcess,
        [Parameter(Mandatory = $true)][string]$Marker,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        $LogText = Get-ClientLogText -Path $Path
        if ($null -eq $LogText) {
            $LogText = ""
        }
        if ($LogText.Contains("RESHADE_CLIENT_INJECTOR_FAILED") -or
            $LogText.Contains("ReShade attachment failed")) {
            throw "The client reported a ReShade attachment failure. Inspect $Path."
        }
        if ($LogText.Contains($Marker)) {
            return
        }

        $ClientProcess.Refresh()
        if ($ClientProcess.HasExited) {
            throw "The client exited before marker '$Marker'. Inspect $Path."
        }
        Start-Sleep -Milliseconds 100
    }

    throw "Timed out waiting for client marker '$Marker'. Inspect $Path."
}

function Wait-ForReShadeMarker {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Marker,
        [Parameter(Mandatory = $true)][DateTime]$Deadline,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$HostProcess
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        if ((Test-Path -LiteralPath $Path -PathType Leaf) -and
            (Select-String -LiteralPath $Path -SimpleMatch $Marker -Quiet)) {
            return
        }

        $HostProcess.Refresh()
        if ($HostProcess.HasExited) {
            throw "The controlled host exited before ReShade marker '$Marker'. Inspect $Path."
        }
        Start-Sleep -Milliseconds 100
    }

    throw "Timed out waiting for ReShade marker '$Marker'. Inspect $Path."
}

function Get-ReShadeRunDirectory {
    param([Parameter(Mandatory = $true)][string]$ClientLog)

    $Matches = [regex]::Matches(
        $ClientLog,
        '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(.+)\r?$'
    )
    if ($Matches.Count -ne 1) {
        throw "Expected one staged ReShade runtime directory, found $($Matches.Count)."
    }
    return ($Matches[0].Groups[1].Value | ConvertFrom-Json)
}

function Get-ConnectedTargetProcessId {
    param([Parameter(Mandatory = $true)][string]$ClientLog)

    $Matches = [regex]::Matches(
        $ClientLog,
        '(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=(\d+)\r?$'
    )
    if ($Matches.Count -ne 1) {
        throw "Expected one authenticated ReShade target PID, found $($Matches.Count)."
    }
    return [int]$Matches[0].Groups[1].Value
}

function Convert-InvariantDouble {
    param([Parameter(Mandatory = $true)][string]$Value)

    return [double]::Parse(
        $Value,
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture
    )
}

function Get-InputTarget {
    param(
        [Parameter(Mandatory = $true)][string]$ClientLog,
        [Parameter(Mandatory = $true)][ValidateSet("main", "status")][string]$Role
    )

    $Number = '-?\d+(?:\.\d+)?'
    $Pattern = "(?m)^OVERLAY_CLIENT_INPUT_TARGET role=$Role name=text " +
        "targetX=(?<targetX>$Number) targetY=(?<targetY>$Number) " +
        "targetWidth=(?<targetWidth>$Number) targetHeight=(?<targetHeight>$Number) " +
        "windowX=(?<windowX>$Number) windowY=(?<windowY>$Number) " +
        "windowWidth=(?<windowWidth>$Number) windowHeight=(?<windowHeight>$Number) " +
        "scale=(?<scale>$Number)\r?$"
    $Matches = [regex]::Matches($ClientLog, $Pattern)
    if ($Matches.Count -ne 1) {
        throw "Expected one $Role input target marker, found $($Matches.Count)."
    }

    $Match = $Matches[0]
    return [pscustomobject]@{
        Role = $Role
        TargetX = Convert-InvariantDouble $Match.Groups['targetX'].Value
        TargetY = Convert-InvariantDouble $Match.Groups['targetY'].Value
        TargetWidth = Convert-InvariantDouble $Match.Groups['targetWidth'].Value
        TargetHeight = Convert-InvariantDouble $Match.Groups['targetHeight'].Value
        WindowX = Convert-InvariantDouble $Match.Groups['windowX'].Value
        WindowY = Convert-InvariantDouble $Match.Groups['windowY'].Value
        WindowWidth = Convert-InvariantDouble $Match.Groups['windowWidth'].Value
        WindowHeight = Convert-InvariantDouble $Match.Groups['windowHeight'].Value
        Scale = Convert-InvariantDouble $Match.Groups['scale'].Value
    }
}

function Convert-DipPlacementToPhysical {
    param(
        [Parameter(Mandatory = $true)][double]$Value,
        [Parameter(Mandatory = $true)][double]$Scale
    )

    $Scaled = $Value * $Scale
    $Magnitude = [Math]::Floor([Math]::Abs($Scaled) + 0.5)
    if ($Scaled -lt 0) {
        return -[int]$Magnitude
    }
    return [int]$Magnitude
}

function Convert-DipExtentToPhysical {
    param(
        [Parameter(Mandatory = $true)][double]$Value,
        [Parameter(Mandatory = $true)][double]$Scale
    )

    return [int][Math]::Floor($Value * $Scale)
}

function Get-InputTargetCenter {
    param([Parameter(Mandatory = $true)]$Target)

    return [pscustomobject]@{
        X = (Convert-DipPlacementToPhysical $Target.WindowX $Target.Scale) +
            (Convert-DipPlacementToPhysical `
                ($Target.TargetX + ($Target.TargetWidth / 2.0)) `
                $Target.Scale)
        Y = (Convert-DipPlacementToPhysical $Target.WindowY $Target.Scale) +
            (Convert-DipPlacementToPhysical `
                ($Target.TargetY + ($Target.TargetHeight / 2.0)) `
                $Target.Scale)
    }
}

function Get-MainCaptionDrag {
    param([Parameter(Mandatory = $true)]$Target)

    $StartX = (Convert-DipPlacementToPhysical $Target.WindowX $Target.Scale) +
        (Convert-DipExtentToPhysical 100 $Target.Scale)
    $StartY = (Convert-DipPlacementToPhysical $Target.WindowY $Target.Scale) +
        (Convert-DipExtentToPhysical 25 $Target.Scale)
    return [pscustomobject]@{
        StartX = $StartX
        StartY = $StartY
        EndX = $StartX + (Convert-DipExtentToPhysical 350 $Target.Scale)
        EndY = $StartY + (Convert-DipExtentToPhysical 100 $Target.Scale)
    }
}

function Assert-MarkerCount {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Marker,
        [Parameter(Mandatory = $true)][int]$Expected
    )

    $Count = ([regex]::Matches($Text, [regex]::Escape($Marker))).Count
    if ($Count -ne $Expected) {
        throw "Expected $Expected '$Marker' marker(s), found $Count."
    }
}

function Assert-ExactLineCount {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Line,
        [Parameter(Mandatory = $true)][int]$Expected
    )

    $Pattern = "(?m)^$([regex]::Escape($Line))\r?`$"
    $Count = ([regex]::Matches($Text, $Pattern)).Count
    if ($Count -ne $Expected) {
        throw "Expected $Expected exact '$Line' line(s), found $Count."
    }
}

function Assert-RegexCount {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][int]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $Count = ([regex]::Matches($Text, $Pattern)).Count
    if ($Count -ne $Expected) {
        throw "Expected $Expected $Label event(s), found $Count."
    }
}

function Assert-MarkerBetween {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Marker,
        [Parameter(Mandatory = $true)][int]$StartIndex,
        [Parameter(Mandatory = $true)][int]$EndIndex
    )

    $Index = $Text.IndexOf($Marker, [StringComparison]::Ordinal)
    if ($Index -le $StartIndex -or $Index -ge $EndIndex) {
        throw "Marker '$Marker' was not bounded by the interception acknowledgements."
    }
}

function Stop-AttemptElectronProcesses {
    param([Parameter(Mandatory = $true)][string]$UserData)

    $ProcessIds = @(
        Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*$UserData*" } |
            ForEach-Object { $_.ProcessId }
    )
    foreach ($ProcessId in $ProcessIds) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
    foreach ($ProcessId in $ProcessIds) {
        Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
}

if (-not ("ReShadeClientSdkGate.NativeInputMethods" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace ReShadeClientSdkGate
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
        private const ushort VK_CONTROL = 0x11;
        private const ushort VK_I = 0x49;
        private const ushort VK_ESCAPE = 0x1B;
        private const uint WM_CLOSE = 0x0010;

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

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessage(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam);

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

        public static bool IsForegroundWindow(IntPtr window)
        {
            return GetForegroundWindow() == window;
        }

        public static void RequestClose(IntPtr window)
        {
            if (!PostMessage(window, WM_CLOSE, UIntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "PostMessage(WM_CLOSE) failed.");
        }

        public static string WindowTitle(IntPtr window)
        {
            StringBuilder text = new StringBuilder(1024);
            if (GetWindowText(window, text, text.Capacity) == 0)
            {
                int error = Marshal.GetLastWin32Error();
                if (error != 0)
                    throw new Win32Exception(error, "GetWindowText failed.");
            }
            return text.ToString();
        }

        public static POINT MoveMouseToClientPoint(IntPtr window, int x, int y)
        {
            POINT point = new POINT { X = x, Y = y };
            if (!ClientToScreen(window, ref point))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ClientToScreen failed.");

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
            SendInputs(new [] {
                MouseInput(MOUSEEVENTF_WHEEL, unchecked((uint)delta), 0, 0)
            });
        }

        public static void SendUnicodeText(string value)
        {
            INPUT[] inputs = new INPUT[value.Length * 2];
            for (int index = 0; index < value.Length; index++)
            {
                int inputIndex = index * 2;
                inputs[inputIndex] = KeyboardInput(0, value[index], KEYEVENTF_UNICODE);
                inputs[inputIndex + 1] = KeyboardInput(
                    0,
                    value[index],
                    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
            }
            SendInputs(inputs);
        }

        public static void SendControlI()
        {
            SendInputs(new [] {
                KeyboardInput(VK_CONTROL, (char)0, 0),
                KeyboardInput(VK_I, (char)0, 0),
                KeyboardInput(VK_I, (char)0, KEYEVENTF_KEYUP),
                KeyboardInput(VK_CONTROL, (char)0, KEYEVENTF_KEYUP)
            });
        }

        public static void SendEscape()
        {
            SendInputs(new [] {
                KeyboardInput(VK_ESCAPE, (char)0, 0),
                KeyboardInput(VK_ESCAPE, (char)0, KEYEVENTF_KEYUP)
            });
        }

        public static void SendSpace()
        {
            SendInputs(new [] {
                KeyboardInput(0x20, (char)0, 0),
                KeyboardInput(0x20, (char)0, KEYEVENTF_KEYUP)
            });
        }

        public static void SendEscapeDown()
        {
            SendInputs(new [] {
                KeyboardInput(VK_ESCAPE, (char)0, 0)
            });
        }

        public static void SendEscapeUp()
        {
            SendInputs(new [] {
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

function Wait-ForHostWindow {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$HostProcess,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) {
            throw "The controlled host exited before creating its window."
        }
        if ($HostProcess.MainWindowHandle -ne [IntPtr]::Zero) {
            return $HostProcess.MainWindowHandle
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Timed out waiting for the controlled host window."
}

function Wait-ForStableHostTitle {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Window,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $Previous = $null
    $StableSince = [DateTime]::UtcNow
    while ([DateTime]::UtcNow -lt $Deadline) {
        $Title = [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($Window)
        if ($Title -and $Title.Contains("game input:") -and $Title -eq $Previous) {
            if (([DateTime]::UtcNow - $StableSince).TotalMilliseconds -ge 400) {
                return $Title
            }
        }
        else {
            $Previous = $Title
            $StableSince = [DateTime]::UtcNow
        }
        Start-Sleep -Milliseconds 100
    }
    throw "The controlled host input-oracle title did not stabilize."
}

function Get-HostInputSnapshot {
    param([Parameter(Mandatory = $true)][string]$Title)

    $Pattern = 'game input: move=(?<move>\d+) down=(?<down>\d+) ' +
        'up=(?<up>\d+) wheel=(?<wheel>\d+) key=(?<key>\d+) ' +
        'raw=(?<raw>\d+) ptr=(?<pointerUpdate>\d+)/(?<pointerDown>\d+)/(?<pointerUp>\d+) ' +
        'poll-left=(?<pollLeft>\d+) cursor-change=(?<cursorChange>\d+) ' +
        'raw-accepted=(?<rawMove>\d+)/(?<rawDown>\d+)/(?<rawUp>\d+)/(?<rawWheel>\d+)/(?<rawKeyDown>\d+)/(?<rawKeyUp>\d+) ' +
        'buffer=(?<buffer>\d+) buffer-error=(?<bufferError>\d+) ' +
        'mode=(?<mode>legacy|wm-input|raw-buffer) clip=(?<clip>on|off)$'
    $Match = [regex]::Match($Title, $Pattern)
    if (-not $Match.Success) {
        throw "Could not parse the controlled host input oracle: $Title"
    }

    return [pscustomobject]@{
        Title = $Title
        Move = [uint64]$Match.Groups['move'].Value
        Down = [uint64]$Match.Groups['down'].Value
        Up = [uint64]$Match.Groups['up'].Value
        Wheel = [uint64]$Match.Groups['wheel'].Value
        Key = [uint64]$Match.Groups['key'].Value
        Raw = [uint64]$Match.Groups['raw'].Value
        PointerUpdate = [uint64]$Match.Groups['pointerUpdate'].Value
        PointerDown = [uint64]$Match.Groups['pointerDown'].Value
        PointerUp = [uint64]$Match.Groups['pointerUp'].Value
        PollLeft = [uint64]$Match.Groups['pollLeft'].Value
        CursorChange = [uint64]$Match.Groups['cursorChange'].Value
        RawMove = [uint64]$Match.Groups['rawMove'].Value
        RawDown = [uint64]$Match.Groups['rawDown'].Value
        RawUp = [uint64]$Match.Groups['rawUp'].Value
        RawWheel = [uint64]$Match.Groups['rawWheel'].Value
        RawKeyDown = [uint64]$Match.Groups['rawKeyDown'].Value
        RawKeyUp = [uint64]$Match.Groups['rawKeyUp'].Value
        RawBuffer = [uint64]$Match.Groups['buffer'].Value
        RawBufferError = [uint32]$Match.Groups['bufferError'].Value
        Mode = $Match.Groups['mode'].Value
        Clip = $Match.Groups['clip'].Value
    }
}

function Wait-ForReleasedMouseInput {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Window,
        [Parameter(Mandatory = $true)]$Baseline,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        $Title = [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($Window)
        if ($Title -and $Title.Contains("game input:")) {
            $Current = Get-HostInputSnapshot -Title $Title
            if ($Current.Move -gt $Baseline.Move -and
                $Current.Down -gt $Baseline.Down -and
                $Current.Up -gt $Baseline.Up -and
                $Current.Raw -gt $Baseline.Raw -and
                $Current.PointerUpdate -gt $Baseline.PointerUpdate -and
                $Current.PointerDown -gt $Baseline.PointerDown -and
                $Current.PointerUp -gt $Baseline.PointerUp) {
                return $Current
            }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Released mouse move/down/up, raw input, and pointer input did not all resume."
}

function Wait-ForReleasedRawInput {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Window,
        [Parameter(Mandatory = $true)]$Baseline,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        $Title = [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($Window)
        if ($Title -and $Title.Contains("game input:")) {
            $Current = Get-HostInputSnapshot -Title $Title
            if ($Current.RawMove -gt $Baseline.RawMove -and
                $Current.RawDown -gt $Baseline.RawDown -and
                $Current.RawUp -gt $Baseline.RawUp -and
                $Current.RawWheel -gt $Baseline.RawWheel -and
                $Current.RawKeyDown -gt $Baseline.RawKeyDown -and
                $Current.RawKeyUp -gt $Baseline.RawKeyUp) {
                return $Current
            }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Released raw mouse move/down/up/wheel and keyboard down/up did not all resume."
}

function Invoke-ClientSdkAttempt {
    param([Parameter(Mandatory = $true)][int]$Attempt)

    $AttemptDirectory = Join-Path $RunDirectory "attempt-$Attempt"
    $TargetDirectory = Join-Path $AttemptDirectory "target"
    $TargetExecutablePath = Join-Path $TargetDirectory $HostName
    $UserData = Join-Path $AttemptDirectory "user-data"
    $ClientStdout = Join-Path $AttemptDirectory "client.stdout.log"
    $ClientStderr = Join-Path $AttemptDirectory "client.stderr.log"
    $TargetDirectoryLog = Join-Path $TargetDirectory "ReShade.log"
    $ClientProcess = $null
    $HostProcess = $null
    $ReShadeRunDirectory = $null
    $AttemptPassed = $false

    New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $BuiltHost -Destination $TargetExecutablePath
    $InputGateMarker = switch ($InputMode) {
        "wm-input" { "reshade-raw-wm-input-gate.enabled" }
        "raw-buffer" { "reshade-raw-buffer-input-gate.enabled" }
        default { "reshade-input-gate.enabled" }
    }
    New-Item `
        -ItemType File `
        -Path (Join-Path $TargetDirectory $InputGateMarker) `
        -Force | Out-Null
    New-Item `
        -ItemType File `
        -Path (Join-Path $TargetDirectory "reshade-injection-wait.enabled") `
        -Force | Out-Null

    try {
        $ClientArguments = @(
            "`"$RepoRoot`"",
            "--no-sandbox",
            "--reshade-overlay",
            "`"--reshade-auto-target-process=$HostName`"",
            "--start-overlay-session",
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

        $HostProcess = Start-Process `
            -FilePath $TargetExecutablePath `
            -WorkingDirectory $TargetDirectory `
            -PassThru
        $HostWindow = Wait-ForHostWindow `
            -HostProcess $HostProcess `
            -Deadline ([DateTime]::UtcNow.AddSeconds(20))

        Wait-ForClientMarker `
            -Path $ClientStdout `
            -ClientProcess $ClientProcess `
            -Marker "RESHADE_CLIENT_TARGET_CONNECTED" `
            -Deadline $StartupDeadline
        Wait-ForClientMarker `
            -Path $ClientStdout `
            -ClientProcess $ClientProcess `
            -Marker "RESHADE_CLIENT_INJECTOR_RETURNED" `
            -Deadline $StartupDeadline
        Wait-ForClientMarker `
            -Path $ClientStdout `
            -ClientProcess $ClientProcess `
            -Marker "OVERLAY_CLIENT_INPUT_TARGET role=main name=text" `
            -Deadline $StartupDeadline
        Wait-ForClientMarker `
            -Path $ClientStdout `
            -ClientProcess $ClientProcess `
            -Marker "OVERLAY_CLIENT_INPUT_TARGET role=status name=text" `
            -Deadline $StartupDeadline

        $ClientLog = Get-ClientLogText -Path $ClientStdout
        $ConnectedTargetProcessId = Get-ConnectedTargetProcessId -ClientLog $ClientLog
        if ($ConnectedTargetProcessId -ne $HostProcess.Id) {
            throw "The client authenticated PID $ConnectedTargetProcessId instead of the started host PID $($HostProcess.Id)."
        }
        $ConnectedTarget = Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId=$ConnectedTargetProcessId" `
            -ErrorAction SilentlyContinue
        if (-not $ConnectedTarget -or
            -not [string]::Equals(
                $ConnectedTarget.ExecutablePath,
                $TargetExecutablePath,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "The authenticated target came from an unexpected path: $($ConnectedTarget.ExecutablePath)"
        }

        $ReShadeRunDirectory = Get-ReShadeRunDirectory -ClientLog $ClientLog
        $ReShadeLog = Join-Path $ReShadeRunDirectory "ReShade.log"
        $ReShadeRunDirectory |
            Set-Content `
                -LiteralPath (Join-Path $AttemptDirectory "reshade-run-directory.txt") `
                -Encoding UTF8

        Wait-ForReShadeMarker `
            -Path $ReShadeLog `
            -Marker "Electron game overlay runtime initialized its transport and input router." `
            -Deadline $StartupDeadline `
            -HostProcess $HostProcess
        if ($Backend -eq "d3d12") {
            Wait-ForReShadeMarker `
                -Path $ReShadeLog `
                -Marker "Redirecting ID3D12Device::CreateCommandQueue" `
                -Deadline $StartupDeadline `
                -HostProcess $HostProcess
        }
        Wait-ForReShadeMarker `
            -Path $ReShadeLog `
            -Marker "rendered its first transported multi-window scene (2 window(s))." `
            -Deadline $StartupDeadline `
            -HostProcess $HostProcess

        if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($HostWindow)) {
            throw "Could not make the controlled host the foreground window."
        }
        Start-Sleep -Milliseconds 250
        [ReShadeClientSdkGate.NativeInputMethods]::SendControlI()
        Wait-ForClientMarker `
            -Path $ClientStdout `
            -ClientProcess $ClientProcess `
            -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true" `
            -Deadline ([DateTime]::UtcNow.AddSeconds(15))

        $BaselineTitle = Wait-ForStableHostTitle `
            -Window $HostWindow `
            -Deadline ([DateTime]::UtcNow.AddSeconds(8))
        $BaselineSnapshot = Get-HostInputSnapshot -Title $BaselineTitle
        Write-Host "  baseline host input: $BaselineTitle"
        if ($BaselineSnapshot.Mode -ne $InputMode) {
            throw "The controlled host selected input mode '$($BaselineSnapshot.Mode)' instead of '$InputMode'."
        }
        if ($BaselineSnapshot.RawBufferError -ne 0) {
            throw "GetRawInputBuffer failed with Win32 error $($BaselineSnapshot.RawBufferError)."
        }
        if (-not $BaselineTitle.Contains("clip=off")) {
            throw "Cursor confinement remained active during interception: $BaselineTitle"
        }
        if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($HostWindow)) {
            throw "The controlled host lost foreground ownership when interception became active."
        }

        $ClientLog = Get-ClientLogText -Path $ClientStdout
        $MainTarget = Get-InputTarget -ClientLog $ClientLog -Role "main"
        $StatusTarget = Get-InputTarget -ClientLog $ClientLog -Role "status"
        $MainCenter = Get-InputTargetCenter -Target $MainTarget
        $StatusCenter = Get-InputTargetCenter -Target $StatusTarget
        $CaptionDrag = Get-MainCaptionDrag -Target $MainTarget

        [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
            $HostWindow,
            $StatusCenter.X,
            $StatusCenter.Y
        )
        Start-Sleep -Milliseconds 100
        [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
        Start-Sleep -Milliseconds 150
        if ($InputMode -eq "legacy") {
            [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("s$Attempt")
        }
        else {
            [ReShadeClientSdkGate.NativeInputMethods]::SendSpace()
        }

        [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
            $HostWindow,
            $MainCenter.X,
            $MainCenter.Y
        )
        Start-Sleep -Milliseconds 100
        [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
        Start-Sleep -Milliseconds 150
        if ($InputMode -eq "legacy") {
            [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("m$Attempt")
        }
        else {
            [ReShadeClientSdkGate.NativeInputMethods]::SendWheel(120)
            [ReShadeClientSdkGate.NativeInputMethods]::SendSpace()
        }
        Start-Sleep -Milliseconds 200
        [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
        Start-Sleep -Milliseconds 250
        Write-Host "  intercepted host input: $([ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($HostWindow))"
        Wait-ForClientMarker `
            -Path $ClientStdout `
            -ClientProcess $ClientProcess `
            -Marker "HUDHOOK_CLIENT_INPUT_ESCAPE_FORWARDED" `
            -Deadline ([DateTime]::UtcNow.AddSeconds(10))
        Start-Sleep -Milliseconds 250
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) {
            throw "Intercepted Escape reached the controlled host."
        }

        [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
            $HostWindow,
            $CaptionDrag.StartX,
            $CaptionDrag.StartY
        )
        [ReShadeClientSdkGate.NativeInputMethods]::SendLeftDown()
        Start-Sleep -Milliseconds 100
        [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
            $HostWindow,
            $CaptionDrag.EndX,
            $CaptionDrag.EndY
        )
        Start-Sleep -Milliseconds 150
        [ReShadeClientSdkGate.NativeInputMethods]::SendLeftUp()

        $MovedMainCenter = [pscustomobject]@{
            X = $MainCenter.X + ($CaptionDrag.EndX - $CaptionDrag.StartX)
            Y = $MainCenter.Y + ($CaptionDrag.EndY - $CaptionDrag.StartY)
        }
        [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
            $HostWindow,
            $MovedMainCenter.X,
            $MovedMainCenter.Y
        )
        Start-Sleep -Milliseconds 100
        [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
        Start-Sleep -Milliseconds 150
        if ($InputMode -eq "legacy") {
            [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("d")
        }
        else {
            [ReShadeClientSdkGate.NativeInputMethods]::SendSpace()
        }

        [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
            $HostWindow,
            $StatusCenter.X,
            $StatusCenter.Y
        )
        Start-Sleep -Milliseconds 100
        [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
        Start-Sleep -Milliseconds 150
        if ($InputMode -eq "legacy") {
            [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText("z")
        }
        else {
            [ReShadeClientSdkGate.NativeInputMethods]::SendSpace()
        }

        $ExpectedMainValue = if ($InputMode -eq "legacy") {
            "HUDHOOK_CLIENT_INPUT_VALUE value=m${Attempt}d"
        }
        else {
            "HUDHOOK_CLIENT_INPUT_VALUE value=  "
        }
        $ExpectedStatusValue = if ($InputMode -eq "legacy") {
            "HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input " +
                "target=hudhook-status-input-target value=`"s${Attempt}z`""
        }
        else {
            "HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input " +
                "target=hudhook-status-input-target value=`"  `""
        }
        Wait-ForClientMarker `
            -Path $ClientStdout `
            -ClientProcess $ClientProcess `
            -Marker $ExpectedMainValue `
            -Deadline ([DateTime]::UtcNow.AddSeconds(10))
        Wait-ForClientMarker `
            -Path $ClientStdout `
            -ClientProcess $ClientProcess `
            -Marker $ExpectedStatusValue `
            -Deadline ([DateTime]::UtcNow.AddSeconds(10))
        Start-Sleep -Milliseconds 500
        if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($HostWindow)) {
            throw "An Electron backing window stole foreground ownership during intercepted interaction."
        }
        $InterceptedTitle = [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($HostWindow)
        if ($InterceptedTitle -ne $BaselineTitle) {
            throw "The game input oracle changed during overlay interaction.`nBefore: $BaselineTitle`nAfter:  $InterceptedTitle"
        }

        [ReShadeClientSdkGate.NativeInputMethods]::SendControlI()
        Wait-ForClientMarker `
            -Path $ClientStdout `
            -ClientProcess $ClientProcess `
            -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false" `
            -Deadline ([DateTime]::UtcNow.AddSeconds(15))

        $ClientLog = Get-ClientLogText -Path $ClientStdout
        $EnabledMarker = "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true"
        $DisabledMarker = "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false"
        Assert-MarkerCount -Text $ClientLog -Marker $EnabledMarker -Expected 1
        Assert-MarkerCount -Text $ClientLog -Marker $DisabledMarker -Expected 1
        $EnabledIndex = $ClientLog.IndexOf($EnabledMarker, [StringComparison]::Ordinal)
        $DisabledIndex = $ClientLog.IndexOf($DisabledMarker, [StringComparison]::Ordinal)
        if ($EnabledIndex -lt 0 -or $DisabledIndex -le $EnabledIndex) {
            throw "The interception acknowledgement markers are out of order."
        }
        $ActionEndMarker =
            "HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC keyup " +
            "target=hudhook-status-input-target"
        $ActionEndIndex = $ClientLog.LastIndexOf(
            $ActionEndMarker,
            $DisabledIndex,
            $DisabledIndex - $EnabledIndex,
            [StringComparison]::Ordinal
        )
        if ($ActionEndIndex -lt $EnabledIndex) {
            throw "The final scripted status-field key release was not observed."
        }
        $ActionEndExclusive = $ActionEndIndex + $ActionEndMarker.Length
        $InterceptedLog = $ClientLog.Substring(
            $EnabledIndex,
            $ActionEndExclusive - $EnabledIndex
        )
        Assert-MarkerCount `
            -Text $ClientLog `
            -Marker "RESHADE_CLIENT_RUNTIME_STAGED" `
            -Expected 1
        Assert-MarkerCount `
            -Text $ClientLog `
            -Marker "RESHADE_CLIENT_INJECTOR_STARTED" `
            -Expected 1
        Assert-MarkerCount `
            -Text $ClientLog `
            -Marker "RESHADE_CLIENT_TARGET_CONNECTED" `
            -Expected 1
        Assert-MarkerCount `
            -Text $ClientLog `
            -Marker "RESHADE_CLIENT_INJECTOR_RETURNED" `
            -Expected 1
        Assert-MarkerCount `
            -Text $InterceptedLog `
            -Marker "HUDHOOK_CLIENT_INPUT_CLICKED" `
            -Expected 2
        Assert-ExactLineCount -Text $InterceptedLog -Line $ExpectedMainValue -Expected 1
        if ($InputMode -ne "legacy") {
            Assert-ExactLineCount `
                -Text $InterceptedLog `
                -Line "HUDHOOK_CLIENT_INPUT_WHEEL deltaY=-120" `
                -Expected 1
        }
        Assert-MarkerCount `
            -Text $InterceptedLog `
            -Marker "HUDHOOK_CLIENT_INPUT_ESCAPE_FORWARDED" `
            -Expected 1
        $StatusClickMarker =
            "HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC click " +
            "target=hudhook-status-input-target"
        Assert-MarkerCount -Text $InterceptedLog -Marker $StatusClickMarker -Expected 2
        Assert-ExactLineCount -Text $InterceptedLog -Line $ExpectedStatusValue -Expected 1

        $MainKeyCount = if ($InputMode -eq "legacy") { 4 } else { 3 }
        $StatusKeyCount = if ($InputMode -eq "legacy") { 3 } else { 2 }
        $InputEventCount = if ($InputMode -eq "legacy") { 3 } else { 2 }
        Assert-RegexCount `
            -Text $InterceptedLog `
            -Pattern '(?m)^HUDHOOK_CLIENT_INPUT_DIAGNOSTIC input target=hudhook-client-input-target value=.*\r?$' `
            -Expected $InputEventCount `
            -Label "main-field input"
        Assert-RegexCount `
            -Text $InterceptedLog `
            -Pattern '(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC input target=hudhook-status-input-target value=.*\r?$' `
            -Expected $InputEventCount `
            -Label "status-field input"
        foreach ($MouseEvent in @("mousedown", "mouseup")) {
            Assert-RegexCount `
                -Text $InterceptedLog `
                -Pattern "(?m)^HUDHOOK_CLIENT_INPUT_DIAGNOSTIC $MouseEvent target=hudhook-client-input-target @ -?\d+,-?\d+\r?`$" `
                -Expected 2 `
                -Label "main-field $MouseEvent"
            Assert-RegexCount `
                -Text $InterceptedLog `
                -Pattern "(?m)^HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC $MouseEvent target=hudhook-status-input-target @ -?\d+,-?\d+\r?`$" `
                -Expected 2 `
                -Label "status-field $MouseEvent"
        }
        foreach ($KeyEvent in @("keydown", "keyup")) {
            Assert-ExactLineCount `
                -Text $InterceptedLog `
                -Line "HUDHOOK_CLIENT_INPUT_DIAGNOSTIC $KeyEvent target=hudhook-client-input-target" `
                -Expected $MainKeyCount
            Assert-ExactLineCount `
                -Text $InterceptedLog `
                -Line "HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC $KeyEvent target=hudhook-status-input-target" `
                -Expected $StatusKeyCount
            Assert-RegexCount `
                -Text $InterceptedLog `
                -Pattern "(?m)^HUDHOOK_CLIENT_(?:STATUS_)?INPUT_DIAGNOSTIC $KeyEvent target=[^ ]+\r?`$" `
                -Expected ($MainKeyCount + $StatusKeyCount) `
                -Label "total $KeyEvent"
        }

        $InterceptedMarkers = @(
                $StatusClickMarker,
                "HUDHOOK_CLIENT_INPUT_CLICKED",
                $ExpectedMainValue,
                "HUDHOOK_CLIENT_INPUT_ESCAPE_FORWARDED",
                $ExpectedStatusValue)
        if ($InputMode -ne "legacy") {
            $InterceptedMarkers += "HUDHOOK_CLIENT_INPUT_WHEEL deltaY=-120"
        }
        foreach ($Marker in $InterceptedMarkers) {
            Assert-MarkerBetween `
                -Text $ClientLog `
                -Marker $Marker `
                -StartIndex $EnabledIndex `
                -EndIndex $DisabledIndex
        }
        if ($ClientLog.LastIndexOf(
                $StatusClickMarker,
                [StringComparison]::Ordinal) -ge $DisabledIndex) {
            throw "The final status-window click was not intercepted."
        }

        [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
            $HostWindow,
            1150,
            650
        )
        [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
        if ($InputMode -eq "legacy") {
            $ReleasedSnapshot = Wait-ForReleasedMouseInput `
                -Window $HostWindow `
                -Baseline $BaselineSnapshot `
                -Deadline ([DateTime]::UtcNow.AddSeconds(8))
        }
        else {
            [ReShadeClientSdkGate.NativeInputMethods]::SendWheel(120)
            [ReShadeClientSdkGate.NativeInputMethods]::SendSpace()
            $ReleasedSnapshot = Wait-ForReleasedRawInput `
                -Window $HostWindow `
                -Baseline $BaselineSnapshot `
                -Deadline ([DateTime]::UtcNow.AddSeconds(8))
            if ($InputMode -eq "raw-buffer" -and
                $ReleasedSnapshot.RawBuffer -le $BaselineSnapshot.RawBuffer) {
                throw "Released input did not traverse GetRawInputBuffer."
            }
            if ($ReleasedSnapshot.RawBufferError -ne 0) {
                throw "GetRawInputBuffer failed with Win32 error $($ReleasedSnapshot.RawBufferError) after interception was released."
            }
        }
        $ReleasedTitle = $ReleasedSnapshot.Title
        if (-not $ReleasedTitle.Contains("clip=on")) {
            throw "Cursor confinement was not restored after release: $ReleasedTitle"
        }

        if ($InputMode -eq "legacy") {
            [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
        }
        else {
            [ReShadeClientSdkGate.NativeInputMethods]::RequestClose($HostWindow)
        }
        if (-not $HostProcess.WaitForExit(10000)) {
            throw "Released Escape did not close the controlled host."
        }
        $HostProcess.Refresh()
        if ($HostProcess.ExitCode -ne 0) {
            throw "The controlled host exited with code $($HostProcess.ExitCode)."
        }
        Start-Sleep -Milliseconds 500

        $ReShadeFault = Select-String `
            -LiteralPath $ReShadeLog `
            -Pattern "out of global sequence|router was reset|input.*(failed|error)|queue.*(failed|error)|FATAL" `
            -CaseSensitive:$false
        if ($ReShadeFault) {
            throw "ReShade reported an input/router fault: $($ReShadeFault.Line -join ' | ')"
        }
        if (Test-Path -LiteralPath $TargetDirectoryLog -PathType Leaf) {
            throw "The SDK run wrote an unexpected target-directory log: $TargetDirectoryLog"
        }

        "${BackendLabel}_REAL_CLIENT_SDK_ATTEMPT_${Attempt}_PASS" |
            Set-Content `
                -LiteralPath (Join-Path $AttemptDirectory "result.txt") `
                -Encoding UTF8
        $AttemptPassed = $true
        Write-Host "${BackendLabel}_REAL_CLIENT_SDK_ATTEMPT_${Attempt}_PASS"
        return [pscustomobject]@{
            Attempt = $Attempt
            UserData = $UserData
            ClientLog = $ClientStdout
            ReShadeLog = $ReShadeLog
            ReShadeRunDirectory = $ReShadeRunDirectory
            BaselineTitle = $BaselineTitle
            ReleasedTitle = $ReleasedTitle
        }
    }
    finally {
        Stop-AttemptElectronProcesses -UserData $UserData

        $InjectorProcessIds = @(
            Get-MatchingInjectors |
                Where-Object {
                    -not $ReShadeRunDirectory -or
                    $_.ExecutablePath -like "$ReShadeRunDirectory*" -or
                    $_.CommandLine -like "*$ReShadeRunDirectory*"
                } |
                ForEach-Object { $_.ProcessId }
        )
        foreach ($ProcessId in $InjectorProcessIds) {
            Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        }

        if ($HostProcess) {
            $HostProcess.Refresh()
            if (-not $HostProcess.HasExited) {
                if (-not $AttemptPassed) {
                    $null = $HostProcess.CloseMainWindow()
                    Wait-Process -Id $HostProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
                }
                $HostProcess.Refresh()
                if (-not $HostProcess.HasExited) {
                    Stop-Process -Id $HostProcess.Id -Force -ErrorAction SilentlyContinue
                    Wait-Process -Id $HostProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
                }
            }
        }
    }
}

if ($FunctionsOnly) {
    return
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

if (-not (Test-Path -LiteralPath $BuiltHost -PathType Leaf)) {
    throw "The controlled $BackendLabel host is unavailable: $BuiltHost"
}

New-Item -ItemType Directory -Path $RunDirectory | Out-Null
Write-Host ""
Write-Host "Production client/SDK $BackendLabel input gate"
Write-Host "  - The client is armed before each controlled host launch."
Write-Host "  - ReShade must select $BackendLabel from the target, not a client backend flag."
Write-Host "  - $AttemptCount fresh client/host cycle(s) prove isolated cleanup and relaunch."
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
    $Attempts = @()
    for ($Attempt = 1; $Attempt -le $AttemptCount; ++$Attempt) {
        Write-Host "Starting $BackendLabel client/SDK attempt $Attempt of $AttemptCount ..."
        $AttemptResult = Invoke-ClientSdkAttempt -Attempt $Attempt
        $Attempts += $AttemptResult

        Start-Sleep -Milliseconds 500
        $RemainingAttemptElectronProcesses = @(
            Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -like "*$($AttemptResult.UserData)*" }
        )
        $RemainingHosts = Get-MatchingHosts
        $RemainingClients = Get-MatchingClientProcesses
        $RemainingInjectors = Get-MatchingInjectors
        if ($RemainingAttemptElectronProcesses.Count -ne 0 -or
            $RemainingHosts.Count -ne 0 -or
            $RemainingClients.Count -ne 0 -or
            $RemainingInjectors.Count -ne 0) {
            $ProcessIds = @(
                @($RemainingAttemptElectronProcesses.ProcessId) +
                    @($RemainingHosts.ProcessId) +
                    @($RemainingClients.ProcessId) +
                    @($RemainingInjectors.ProcessId) |
                    Where-Object { $null -ne $_ }
            )
            throw "Attempt $Attempt left a host/client/injector process behind (PID: $($ProcessIds -join ', '))."
        }
    }

    $DistinctReShadeRunDirectories = @(
        $Attempts.ReShadeRunDirectory |
            Sort-Object -Unique
    )
    if ($DistinctReShadeRunDirectories.Count -ne $AttemptCount) {
        throw "The fresh attempts did not receive distinct isolated ReShade run directories."
    }

    $Attempts |
        ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $RunDirectory "summary.json") -Encoding UTF8
    $ResultMarker |
        Set-Content -LiteralPath (Join-Path $RunDirectory "result.txt") -Encoding UTF8
    Write-Host $ResultMarker
    Write-Host "Evidence preserved in: $RunDirectory"
}
finally {
    foreach ($VariableName in $ControlledEnvironmentVariables) {
        [Environment]::SetEnvironmentVariable(
            $VariableName,
            $PreviousEnvironment[$VariableName],
            "Process")
    }
}
