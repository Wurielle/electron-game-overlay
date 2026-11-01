# Read-only acceptance helper. No registry/debug export is added to production.
# Registry metadata is copied under its existing mutex. OS module/thread/resource
# observations follow that copy; callers must wait for quiescent exact counts.
function Get-CooperativeResourceSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][ValidatePattern('^[1-9][0-9]{0,19}$')][string]$ExpectedCreationTime100ns
    )
    if (-not [Environment]::Is64BitProcess) { throw 'The genuine SDK resource snapshot requires a 64-bit controller and target.' }
    [UInt64]$CreationTime = 0
    if (-not [UInt64]::TryParse($ExpectedCreationTime100ns, [ref]$CreationTime) -or $CreationTime -eq 0) { throw 'Expected creation time is not a positive uint64 FILETIME.' }
    if (-not ('EgoCooperativeResourceSnapshotV1' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class EgoCooperativeResourceSnapshotV1
{
    const uint SYNCHRONIZE = 0x00100000, MUTEX_MODIFY_STATE = 0x0001;
    const uint FILE_MAP_READ = 0x0004, TH32CS_SNAPTHREAD = 0x00000004;
    const uint THREAD_QUERY_LIMITED_INFORMATION = 0x0800, LIST_MODULES_ALL = 3;
    const uint WAIT_OBJECT_0 = 0, WAIT_ABANDONED = 0x80, WAIT_TIMEOUT = 0x102;
    const int MaxParticipants = 512, MaxWindows = 8192, MaxModules = 2048;
    const int ParticipantOffset = 144, ParticipantStride = 96;
    const int WindowOffset = ParticipantOffset + MaxParticipants * ParticipantStride;
    const int FrameOffset = WindowOffset + MaxWindows * 80;
    const int DecisionOffset = FrameOffset + 64 * 16;
    const int SourceOffset = DecisionOffset + 8192 * 40;
    const int RankOffset = SourceOffset + 8192 * 32;
    const int WatermarkOffset = RankOffset + MaxWindows * 32;
    const int SurfaceOffset = WatermarkOffset + 8;
    const int RegistryBytes = SurfaceOffset + 512 * 16;
    static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; }
    [StructLayout(LayoutKind.Sequential)] struct ModuleInfo { public IntPtr baseAddress; public uint size; public IntPtr entryPoint; }
    [StructLayout(LayoutKind.Sequential)] struct ThreadEntry
    {
        public uint size, usage, threadId, ownerProcessId;
        public int basePriority, deltaPriority;
        public uint flags;
    }
    [StructLayout(LayoutKind.Sequential)] struct MemoryCounters
    {
        public uint size, pageFaultCount;
        public UIntPtr peakWorkingSetSize, workingSetSize, quotaPeakPagedPoolUsage, quotaPagedPoolUsage;
        public UIntPtr quotaPeakNonPagedPoolUsage, quotaNonPagedPoolUsage, pagefileUsage, peakPagefileUsage, privateUsage;
    }
    public sealed class ModuleRecord
    {
        public string path { get; internal set; }
        public string baseAddress { get; internal set; }
        public uint size { get; internal set; }
        internal ulong numericBase;
    }
    public sealed class ThreadRecord
    {
        public uint id { get; internal set; }
        public string description { get; internal set; }
    }
    public sealed class ParticipantRecord
    {
        public int slot { get; internal set; }
        public ulong id { get; internal set; }
        public uint reserved { get; internal set; }
        public uint interception { get; internal set; }
        public string prepareAddress { get; internal set; }
        public string modulePath { get; internal set; }
        public int windows { get; internal set; }
        public int ranks { get; internal set; }
    }
    public sealed class WindowKey
    {
        public ulong participant { get; internal set; }
        public uint windowId { get; internal set; }
        public ulong incarnation { get; internal set; }
    }
    public sealed class RegistryRecord
    {
        public string mappingName { get; internal set; }
        public int bytes { get; internal set; }
        public ulong revision { get; internal set; }
        public ulong nextParticipant { get; internal set; }
        public int activeParticipants { get; internal set; }
        public int lifetimeSlots { get; internal set; }
        public int windows { get; internal set; }
        public int ranks { get; internal set; }
        public WindowKey focus { get; internal set; }
        public WindowKey capture { get; internal set; }
        public uint captureButtons { get; internal set; }
        public ParticipantRecord[] participants { get; internal set; }
    }
    public sealed class Snapshot
    {
        public string scope { get; internal set; }
        public uint processId { get; internal set; }
        public string creationTime100ns { get; internal set; }
        public string capturedAtUtc { get; internal set; }
        public RegistryRecord registry { get; internal set; }
        public ModuleRecord[] modules { get; internal set; }
        public ThreadRecord[] threads { get; internal set; }
        public uint[] frameThreadIds { get; internal set; }
        public uint[] tcpThreadIds { get; internal set; }
        public int frameThreads { get { return frameThreadIds.Length; } }
        public int tcpThreads { get { return tcpThreadIds.Length; } }
        public uint handles { get; internal set; }
        public ulong privateBytes { get; internal set; }
    }

    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenMutex(uint access, bool inheritHandle, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReleaseMutex(IntPtr mutex);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenFileMapping(uint access, bool inheritHandle, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr MapViewOfFile(IntPtr mapping, uint access, uint offsetHigh, uint offsetLow, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UnmapViewOfFile(IntPtr view);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessHandleCount(IntPtr process, out uint count);
    [DllImport("psapi.dll", SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr process, ref MemoryCounters counters, uint size);
    [DllImport("psapi.dll", SetLastError=true)] static extern bool EnumProcessModulesEx(IntPtr process, [Out] IntPtr[] modules, uint bytes, out uint needed, uint filter);
    [DllImport("psapi.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetModuleFileNameEx(IntPtr process, IntPtr module, StringBuilder name, uint size);
    [DllImport("psapi.dll", SetLastError=true)] static extern bool GetModuleInformation(IntPtr process, IntPtr module, out ModuleInfo information, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool Thread32First(IntPtr snapshot, ref ThreadEntry entry);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool Thread32Next(IntPtr snapshot, ref ThreadEntry entry);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenThread(uint access, bool inheritHandle, uint threadId);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessIdOfThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern int GetThreadDescription(IntPtr thread, out IntPtr description);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);

    static Exception Error(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static ulong Address(IntPtr pointer) { return unchecked((ulong)pointer.ToInt64()); }
    static string Hex(ulong value) { return "0x" + value.ToString("x16", CultureInfo.InvariantCulture); }
    static ulong U64(byte[] data, int offset) { return BitConverter.ToUInt64(data, offset); }
    static uint U32(byte[] data, int offset) { return BitConverter.ToUInt32(data, offset); }
    static void ValidateProcess(IntPtr process, uint processId, ulong expectedCreation)
    {
        if (process == IntPtr.Zero || process == InvalidHandle || GetProcessId(process) != processId) throw new InvalidOperationException("Retained process handle no longer names the exact owned target.");
        FileTime created, exited, kernel, user;
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) throw Error("GetProcessTimes failed.");
        ulong actual = ((ulong)created.high << 32) | created.low;
        if (actual != expectedCreation || WaitForSingleObject(process, 0) != WAIT_TIMEOUT) throw new InvalidOperationException("Exact owned target exited or its creation identity mismatched.");
    }
    static byte[] ReadRegistry(string mappingName)
    {
        IntPtr mutex = OpenMutex(SYNCHRONIZE | MUTEX_MODIFY_STATE, false, mappingName + "-lock");
        if (mutex == IntPtr.Zero) throw Error("Existing cooperative registry mutex is unavailable.");
        bool acquired = false;
        try
        {
            uint status = WaitForSingleObject(mutex, 1000);
            acquired = status == WAIT_OBJECT_0 || status == WAIT_ABANDONED;
            if (status != WAIT_OBJECT_0) throw new InvalidOperationException("Cooperative registry mutex is unavailable or abandoned; snapshot failed closed.");
            IntPtr mapping = OpenFileMapping(FILE_MAP_READ, false, mappingName);
            if (mapping == IntPtr.Zero) throw Error("Existing cooperative registry mapping is unavailable.");
            try
            {
                IntPtr view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, new UIntPtr((uint)RegistryBytes));
                if (view == IntPtr.Zero) throw Error("Read-only cooperative registry view failed.");
                try
                {
                    byte[] data = new byte[RegistryBytes];
                    Marshal.Copy(view, data, 0, data.Length);
                    if (U64(data, 0) != 0x3147455243504f45UL || U32(data, 8) != 1 || U32(data, 12) != RegistryBytes || U32(data, 16) != 64) throw new InvalidOperationException("Unknown cooperative registry magic, version, size or pointer layout.");
                    return data;
                }
                finally { UnmapViewOfFile(view); }
            }
            finally { CloseHandle(mapping); }
        }
        finally { if (acquired) ReleaseMutex(mutex); CloseHandle(mutex); }
    }
    static ModuleRecord[] ReadModules(IntPtr process)
    {
        IntPtr[] handles = new IntPtr[MaxModules];
        uint needed;
        if (!EnumProcessModulesEx(process, handles, (uint)(handles.Length * IntPtr.Size), out needed, LIST_MODULES_ALL)) throw Error("OS module enumeration failed.");
        if (needed == 0 || needed % IntPtr.Size != 0 || needed > handles.Length * IntPtr.Size) throw new InvalidOperationException("OS module enumeration exceeded its fixed bound.");
        List<ModuleRecord> result = new List<ModuleRecord>();
        HashSet<string> paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < needed / IntPtr.Size; ++index)
        {
            StringBuilder name = new StringBuilder(32768);
            uint length = GetModuleFileNameEx(process, handles[index], name, (uint)name.Capacity);
            if (length == 0) throw Error("OS module filename query failed.");
            if (length >= name.Capacity - 1 || !System.IO.Path.IsPathRooted(name.ToString()) || !paths.Add(name.ToString())) throw new InvalidOperationException("OS module paths are truncated, relative or repeated.");
            ModuleInfo info;
            if (!GetModuleInformation(process, handles[index], out info, (uint)Marshal.SizeOf(typeof(ModuleInfo)))) throw Error("OS module bounds query failed.");
            ulong address = Address(info.baseAddress);
            if (address == 0 || info.size == 0 || address + info.size < address) throw new InvalidOperationException("OS module bounds are invalid.");
            result.Add(new ModuleRecord { path = name.ToString(), baseAddress = Hex(address), numericBase = address, size = info.size });
        }
        result.Sort(delegate(ModuleRecord a, ModuleRecord b) { return StringComparer.OrdinalIgnoreCase.Compare(a.path, b.path); });
        return result.ToArray();
    }
    static ThreadRecord[] ReadThreads(uint processId)
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if (snapshot == InvalidHandle) throw Error("OS thread enumeration failed.");
        try
        {
            List<ThreadRecord> result = new List<ThreadRecord>();
            ThreadEntry entry = new ThreadEntry(); entry.size = (uint)Marshal.SizeOf(typeof(ThreadEntry));
            if (!Thread32First(snapshot, ref entry)) throw Error("OS first thread query failed.");
            int scanned = 0;
            do
            {
                if (++scanned > 65536) throw new InvalidOperationException("OS thread enumeration exceeded its fixed bound.");
                if (entry.ownerProcessId != processId) continue;
                IntPtr thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, entry.threadId);
                if (thread == IntPtr.Zero) throw Error("Owned target thread changed during snapshot.");
                try
                {
                    if (GetProcessIdOfThread(thread) != processId || WaitForSingleObject(thread, 0) != WAIT_TIMEOUT) throw new InvalidOperationException("Target thread identity changed during snapshot.");
                    IntPtr description;
                    int status = GetThreadDescription(thread, out description);
                    if (status < 0) Marshal.ThrowExceptionForHR(status);
                    try { result.Add(new ThreadRecord { id = entry.threadId, description = Marshal.PtrToStringUni(description) ?? "" }); }
                    finally { if (description != IntPtr.Zero) LocalFree(description); }
                }
                finally { CloseHandle(thread); }
            } while (Thread32Next(snapshot, ref entry));
            if (Marshal.GetLastWin32Error() != 18) throw Error("OS next thread query failed.");
            result.Sort(delegate(ThreadRecord a, ThreadRecord b) { return a.id.CompareTo(b.id); });
            return result.ToArray();
        }
        finally { CloseHandle(snapshot); }
    }
    static WindowKey Key(byte[] data, int offset)
    {
        return new WindowKey { participant = U64(data, offset), windowId = U32(data, offset + 8), incarnation = U64(data, offset + 16) };
    }
    static RegistryRecord DecodeRegistry(byte[] data, string mappingName, ModuleRecord[] modules)
    {
        List<ParticipantRecord> records = new List<ParticipantRecord>();
        Dictionary<ulong, ParticipantRecord> active = new Dictionary<ulong, ParticipantRecord>();
        for (int slot = 0; slot < MaxParticipants; ++slot)
        {
            int offset = ParticipantOffset + slot * ParticipantStride;
            ulong id = U64(data, offset), prepare = U64(data, offset + 24);
            uint reserved = U32(data, offset + 92);
            if (id == 0 && reserved == 0) continue;
            if (id != 0 && (reserved == 0 || U32(data, offset + 16) != 72 || U32(data, offset + 20) != 1 || prepare == 0)) throw new InvalidOperationException("Published participant callback metadata is invalid.");
            string modulePath = null;
            if (prepare != 0)
            {
                foreach (ModuleRecord module in modules)
                    if (prepare >= module.numericBase && prepare - module.numericBase < module.size)
                    {
                        if (modulePath != null) throw new InvalidOperationException("Participant callback matches overlapping OS modules.");
                        modulePath = module.path;
                    }
                if (modulePath == null) throw new InvalidOperationException("Participant callback does not belong to a mapped target module.");
            }
            ParticipantRecord record = new ParticipantRecord { slot = slot, id = id, reserved = reserved, interception = U32(data, offset + 88), prepareAddress = Hex(prepare), modulePath = modulePath };
            records.Add(record);
            if (id != 0)
            {
                if (active.ContainsKey(id)) throw new InvalidOperationException("Published participant IDs repeat.");
                active.Add(id, record);
            }
        }
        int windows = 0, ranks = 0;
        for (int slot = 0; slot < MaxWindows; ++slot)
        {
            WindowKey window = Key(data, WindowOffset + slot * 80);
            if (window.participant != 0)
            {
                ParticipantRecord owner;
                if (window.windowId == 0 || window.incarnation == 0 || !active.TryGetValue(window.participant, out owner)) throw new InvalidOperationException("Published window has no exact live participant owner.");
                ++owner.windows; ++windows;
            }
            WindowKey rank = Key(data, RankOffset + slot * 32);
            if (rank.participant != 0)
            {
                ParticipantRecord owner;
                if (rank.windowId == 0 || rank.incarnation == 0 || !active.TryGetValue(rank.participant, out owner)) throw new InvalidOperationException("Registered rank has no exact live participant owner.");
                ++owner.ranks; ++ranks;
            }
        }
        return new RegistryRecord { mappingName = mappingName, bytes = RegistryBytes, revision = U64(data, 40), nextParticipant = U64(data, 24), activeParticipants = active.Count, lifetimeSlots = records.Count, windows = windows, ranks = ranks, focus = Key(data, 48), capture = Key(data, 72), captureButtons = U32(data, 96), participants = records.ToArray() };
    }
    public static Snapshot Capture(IntPtr process, uint processId, ulong expectedCreation)
    {
        if (IntPtr.Size != 8) throw new InvalidOperationException("The resource snapshot supports the explicit 64-bit registry layout only.");
        ValidateProcess(process, processId, expectedCreation);
        string mappingName = "Local\\ElectronGameOverlay-Cooperative-v1-" + processId.ToString(CultureInfo.InvariantCulture) + "-" + expectedCreation.ToString("x16", CultureInfo.InvariantCulture) + "-64";
        byte[] registry = ReadRegistry(mappingName);
        ModuleRecord[] modules = ReadModules(process);
        ThreadRecord[] threads = ReadThreads(processId);
        List<uint> frame = new List<uint>(), tcp = new List<uint>();
        foreach (ThreadRecord thread in threads)
        {
            if (thread.description == "electron-overlay-frame") frame.Add(thread.id);
            if (thread.description == "electron-overlay-tcp") tcp.Add(thread.id);
        }
        uint handles;
        if (!GetProcessHandleCount(process, out handles)) throw Error("Target handle count query failed.");
        MemoryCounters memory = new MemoryCounters(); memory.size = (uint)Marshal.SizeOf(typeof(MemoryCounters));
        if (!GetProcessMemoryInfo(process, ref memory, memory.size)) throw Error("Target memory query failed.");
        RegistryRecord decoded = DecodeRegistry(registry, mappingName, modules);
        ValidateProcess(process, processId, expectedCreation);
        return new Snapshot { scope = "Read-only exact-process registry/module/named-thread observations; registry copy is locked, OS observations require controller quiescence. Private bytes and total handles are diagnostic only.", processId = processId, creationTime100ns = expectedCreation.ToString(CultureInfo.InvariantCulture), capturedAtUtc = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture), registry = decoded, modules = modules, threads = threads, frameThreadIds = frame.ToArray(), tcpThreadIds = tcp.ToArray(), handles = handles, privateBytes = memory.privateUsage.ToUInt64() };
    }
}
'@
    }
    # The caller retains this exact process object/handle from its own launch.
    # Do not re-open an arbitrary PID, terminate anything, or modify the mapping.
    return [EgoCooperativeResourceSnapshotV1]::Capture($Process.Handle, [UInt32]$Process.Id, $CreationTime)
}
