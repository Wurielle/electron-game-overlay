function Initialize-OverlayProcessEnvironmentInterop {
    if ('ElectronGameOverlay.RuntimeTests.ProcessEnvironment' -as [type]) {
        return
    }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace ElectronGameOverlay.RuntimeTests {
    public static class ProcessEnvironment {
        [DllImport("kernel32.dll", EntryPoint = "SetEnvironmentVariableW",
            CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool Set(string name, string value);

        [DllImport("kernel32.dll", EntryPoint = "GetEnvironmentVariableW",
            CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern uint Query(string name, IntPtr buffer, uint size);

        [DllImport("kernel32.dll", EntryPoint = "GetEnvironmentVariableW",
            CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern uint Read(string name, StringBuilder buffer, uint size);

        [DllImport("kernel32.dll", ExactSpelling = true)]
        private static extern void SetLastError(uint error);

        public static string Get(string name) {
            for (int attempt = 0; attempt < 4; ++attempt) {
                SetLastError(0);
                uint required = Query(name, IntPtr.Zero, 0);
                if (required == 0) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 203) return null;
                    if (error == 0) return String.Empty;
                    throw new Win32Exception(error);
                }
                var buffer = new StringBuilder(checked((int)required));
                SetLastError(0);
                uint written = Read(name, buffer, required);
                if (written >= required) continue;
                if (written != 0) return buffer.ToString();
                int readError = Marshal.GetLastWin32Error();
                if (readError == 203) return null;
                if (readError == 0) return String.Empty;
                throw new Win32Exception(readError);
            }
            throw new InvalidOperationException("Process environment changed repeatedly while being captured.");
        }
    }
}
'@
}

function Get-OverlayProcessEnvironmentVariable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    # The managed getter in Windows PowerShell collapses present-empty to null.
    # Preserve the distinction so the finally block can restore exact presence.
    Initialize-OverlayProcessEnvironmentInterop
    return [ElectronGameOverlay.RuntimeTests.ProcessEnvironment]::Get($Name)
}

function Set-OverlayProcessEnvironmentVariable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [AllowEmptyString()]
        [object]$Value
    )

    if ($null -eq $Value -or $Value -is [NullString]) {
        # PowerShell 7.6/.NET 10 coerces an untyped $null argument to a present
        # empty string. ReShade tests presence, so use an explicitly null string.
        [Environment]::SetEnvironmentVariable($Name, [NullString]::Value, 'Process')
        return
    }

    $Text = [string]$Value
    if ($Text.Length -ne 0) {
        [Environment]::SetEnvironmentVariable($Name, $Text, 'Process')
        return
    }

    # Windows PowerShell/.NET Framework deletes empty values through the managed
    # setter. Preserve a captured, present-empty entry exactly with the Win32 API.
    Initialize-OverlayProcessEnvironmentInterop
    if (-not [ElectronGameOverlay.RuntimeTests.ProcessEnvironment]::Set($Name, [string]::Empty)) {
        throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
}
