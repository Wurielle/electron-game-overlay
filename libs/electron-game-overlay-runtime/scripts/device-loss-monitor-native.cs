using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace EgoDeviceLossDiagnostics
{
    public sealed class Identity
    {
        public int ProcessId { get; set; }
        public string ExecutablePath { get; set; }
        public string CreationTime100ns { get; set; }
    }

    public sealed class DumpResult
    {
        public bool Complete { get; set; }
        public int Win32Error { get; set; }
        public string Failure { get; set; }
        public long Bytes { get; set; }
        public uint Flags { get; set; }
    }

    // Diagnostic-only: never injects, suspends, resumes or terminates a target.
    public sealed class PinnedTarget : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct FileTime { public uint Low; public uint High; }
        [StructLayout(LayoutKind.Sequential)]
        private struct CallbackInfo { public IntPtr Routine; public IntPtr Parameter; }
        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate bool DumpCallback(IntPtr parameter, IntPtr input, IntPtr output);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetProcessId(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr handle, out FileTime creation,
            out FileTime exit, out FileTime kernel, out FileTime user);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(IntPtr handle, uint flags,
            StringBuilder path, ref uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("dbghelp.dll", SetLastError = true)]
        private static extern bool MiniDumpWriteDump(IntPtr process, uint processId,
            IntPtr file, uint flags, IntPtr exception, IntPtr streams, ref CallbackInfo callback);

        private IntPtr handle;
        private readonly Identity expected;
        // Data segments + referenced memory + unloaded modules + process/thread data,
        // thread info, inaccessible-page tolerance and module headers. No full-memory dump.
        public const uint DumpFlags = 0x000A1161;

        public static Identity ReadIdentity(IntPtr processHandle)
        {
            uint pid = GetProcessId(processHandle);
            FileTime created, exited, kernel, user;
            if (pid == 0 || !GetProcessTimes(processHandle, out created, out exited, out kernel, out user))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot query retained process identity.");
            var path = new StringBuilder(32768);
            uint length = (uint)path.Capacity;
            if (!QueryFullProcessImageName(processHandle, 0, path, ref length))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot query retained process image.");
            return new Identity { ProcessId = (int)pid, ExecutablePath = path.ToString(),
                CreationTime100ns = (((ulong)created.High << 32) | created.Low).ToString(CultureInfo.InvariantCulture) };
        }

        public PinnedTarget(int processId, string executablePath, string creationTime100ns)
        {
            expected = new Identity { ProcessId = processId, ExecutablePath = executablePath,
                CreationTime100ns = creationTime100ns };
            // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE.
            handle = OpenProcess(0x00100410, false, (uint)processId);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot retain diagnostic target.");
            try { Verify(); } catch { Dispose(); throw; }
        }

        public bool HasExited { get { return WaitForSingleObject(handle, 0) == 0; } }
        public Identity Verify()
        {
            var actual = ReadIdentity(handle);
            if (actual.ProcessId != expected.ProcessId ||
                !String.Equals(actual.ExecutablePath, expected.ExecutablePath, StringComparison.OrdinalIgnoreCase) ||
                actual.CreationTime100ns != expected.CreationTime100ns)
                throw new InvalidOperationException("Retained target PID/path/creation identity changed.");
            if (HasExited) throw new InvalidOperationException("The retained target has already exited.");
            return actual;
        }

        public Task<DumpResult> BeginDump(string path, int timeoutMilliseconds, long byteLimit)
        {
            Verify();
            return Task.Run(() => WriteDump(path, timeoutMilliseconds, byteLimit));
        }

        private DumpResult WriteDump(string path, int timeoutMilliseconds, long byteLimit)
        {
            var result = new DumpResult { Flags = DumpFlags };
            var watch = Stopwatch.StartNew();
            try
            {
                Verify(); // SAME retained handle, immediately before the diagnostic API.
                using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read))
                {
                    bool cancelled = false;
                    DumpCallback callback = (parameter, input, output) =>
                    {
                        // Windows SDK minidumpapiset.h uses pack(4): PID, HANDLE, type.
                        int kind = Marshal.ReadInt32(input, 4 + IntPtr.Size);
                        if (kind == 6) // CancelCallback / MINIDUMP_CALLBACK_OUTPUT.Cancel
                        {
                            cancelled = watch.ElapsedMilliseconds >= timeoutMilliseconds || stream.Length >= byteLimit;
                            Marshal.WriteInt32(output, 0, 1); // CheckCancel
                            Marshal.WriteInt32(output, 4, cancelled ? 1 : 0);
                        }
                        return true;
                    };
                    var info = new CallbackInfo { Routine = Marshal.GetFunctionPointerForDelegate(callback), Parameter = IntPtr.Zero };
                    bool okay = MiniDumpWriteDump(handle, (uint)expected.ProcessId,
                        stream.SafeFileHandle.DangerousGetHandle(), DumpFlags, IntPtr.Zero, IntPtr.Zero, ref info);
                    result.Win32Error = okay ? 0 : Marshal.GetLastWin32Error();
                    GC.KeepAlive(callback);
                    stream.Flush(true);
                    result.Bytes = stream.Length;
                    result.Complete = okay && !cancelled && result.Bytes > 32 && result.Bytes <= byteLimit;
                    if (!result.Complete) result.Failure = cancelled || result.Bytes > byteLimit
                        ? "dump-time-or-byte-limit" : "MiniDumpWriteDump-failed-or-empty";
                }
            }
            catch (Exception error) { result.Failure = error.ToString(); }
            return result;
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
        }
    }
}
