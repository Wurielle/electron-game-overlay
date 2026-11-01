[CmdletBinding()]
param(
    [string]$GameExecutable = 'C:/Program Files (x86)/Steam/steamapps/common/Gun Frog/Gun Frog.exe',
    [string]$ElectronExecutable,
    [string]$SdkDistA,
    [string]$SdkDistB,
    [ValidateSet('a-first', 'b-first', 'both')][string]$StartupOrder = 'both',
    [ValidateSet('graceful', 'crash', 'both')][string]$FirstAppExit = 'both',
    [ValidatePattern('^$|^[a-fA-F0-9]{40}$')][string]$SourceRevisionA = '',
    [ValidatePattern('^$|^[a-fA-F0-9]{40}$')][string]$SourceRevisionB = '',
    [switch]$RequireDifferentImplementations,
    [string]$FixturePath,
    [string]$AppRootA,
    [string]$AppRootB
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cooperative-native-evidence.ps1')
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
if (-not $ElectronExecutable) { $ElectronExecutable = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' }
if (-not $SdkDistA) { $SdkDistA = Join-Path $RepoRoot 'libs\electron-game-overlay\dist' }
if (-not $SdkDistB) { $SdkDistB = $SdkDistA }
$GameExecutable = (Resolve-Path -LiteralPath $GameExecutable).Path
if ([IO.Path]::GetFileName($GameExecutable) -ine 'Gun Frog.exe') { throw 'This calibrated real-game gate supports Gun Frog.exe only.' }
$ElectronExecutable = (Resolve-Path -LiteralPath $ElectronExecutable).Path
$SdkDistA = (Resolve-Path -LiteralPath $SdkDistA).Path
$SdkDistB = (Resolve-Path -LiteralPath $SdkDistB).Path
if ([bool]$AppRootA -ne [bool]$AppRootB) { throw 'Installed-package acceptance requires both consumer roots.' }
if ($AppRootA -and -not $FixturePath) { throw 'Installed-package acceptance requires its explicit public-entrypoint fixture.' }
if ($AppRootA) {
    $AppRootA = (Resolve-Path -LiteralPath $AppRootA).Path
    $AppRootB = (Resolve-Path -LiteralPath $AppRootB).Path
    if ([string]::Equals($AppRootA, $AppRootB, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installed applications must have independent consumer roots.' }
}
$Node = (Get-Command node.exe -CommandType Application -All -ErrorAction Stop | Select-Object -First 1).Source
$Fixture = if ($FixturePath) { (Resolve-Path -LiteralPath $FixturePath).Path } else { Join-Path $RepoRoot 'apps\client\scripts\cooperative-two-app-game-fixture.cjs' }
$EvidenceHelper = Join-Path $RepoRoot 'apps\client\scripts\cooperative-game-evidence.cjs'
$RunDirectory = Join-Path $RepoRoot ('build\cooperative-two-app-game-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $RunDirectory -ErrorAction Stop | Out-Null
$Report = [ordered]@{ schemaVersion = 1; status = 'failed'; scope = 'Actual Gun Frog, two genuine Electron/public-SDK processes and independent native add-ons'; inputSource = 'Windows SendInput, not human physical-key evidence'; cases = @(); error = $null }
if ($AppRootA) { $Report.installedPackageAcceptance = @{ consumerRootA = $AppRootA; consumerRootB = $AppRootB; fixture = $Fixture; releasedPackageCompatibilityClaimed = $false } }
$script:Sequence = 0
$script:MouseHeld = $false

if (-not ('EgoCooperativeGameInput' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EgoCooperativeGameInput {
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] struct RECT { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit,Size=32)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
 [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public uint size,flags; public IntPtr cursor; public POINT point; }
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] input,int size);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h,IntPtr dc);
 [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc,int x,int y);
 [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO c);
 [DllImport("user32.dll")] static extern IntPtr LoadCursor(IntPtr module,IntPtr id);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr p);
 [DllImport("user32.dll",EntryPoint="GetWindowThreadProcessId")] static extern uint QueryWindowProcess(IntPtr h,out uint processId);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a,uint b,bool attach);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 public static bool Activate(IntPtr h) {
  uint own=GetCurrentThreadId(),target=GetWindowThreadProcessId(h,IntPtr.Zero),foreground=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
  bool a=target!=0&&target!=own&&AttachThreadInput(own,target,true),b=foreground!=0&&foreground!=own&&foreground!=target&&AttachThreadInput(own,foreground,true);
  try{ShowWindow(h,9);BringWindowToTop(h);SetForegroundWindow(h);}finally{if(b)AttachThreadInput(own,foreground,false);if(a)AttachThreadInput(own,target,false);}
  return GetForegroundWindow()==h;
 }
 public static bool Foreground(IntPtr h) { return GetForegroundWindow()==h; }
 public static bool OwnedWindow(IntPtr h,int processId) { uint owner;return h!=IntPtr.Zero&&IsWindow(h)&&QueryWindowProcess(h,out owner)!=0&&owner==(uint)processId; }
 public static bool LargeEnough(IntPtr h,int width,int height) { RECT r;return GetClientRect(h,out r)&&r.right-r.left>=width&&r.bottom-r.top>=height; }
 public static void Place(IntPtr h,int x,int y) { var p=new POINT{x=x,y=y};if(!ClientToScreen(h,ref p)||!SetCursorPos(p.x,p.y))throw new Exception("Pointer placement failed"); }
 public static uint Pixel(IntPtr h,int x,int y) { var p=new POINT{x=x,y=y};if(!ClientToScreen(h,ref p))throw new Exception("ClientToScreen failed");var dc=GetDC(IntPtr.Zero);try{return GetPixel(dc,p.x,p.y);}finally{ReleaseDC(IntPtr.Zero,dc);} }
 public static bool CursorIs(int id) { var c=new CURSORINFO{size=(uint)Marshal.SizeOf(typeof(CURSORINFO))};return GetCursorInfo(ref c)&&c.flags==1&&c.cursor==LoadCursor(IntPtr.Zero,new IntPtr(id)); }
 static void Send(INPUT i) { if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("SendInput failed"); }
 public static void Button(bool down) { Send(new INPUT{data=new UNION{mouse=new MOUSE{flags=down?2u:4u}}}); }
 public static void Wheel(int delta,bool horizontal) { Send(new INPUT{data=new UNION{mouse=new MOUSE{flags=horizontal?0x1000u:0x800u,data=unchecked((uint)delta)}}}); }
 public static void Letter(ushort vk) { Send(new INPUT{type=1,data=new UNION{key=new KEY{vk=vk}}});Send(new INPUT{type=1,data=new UNION{key=new KEY{vk=vk,flags=2}}}); }
}
'@
}

function Save-Json([object]$Value, [string]$Path) {
    $Value | ConvertTo-Json -Depth 18 | Set-Content -LiteralPath $Path -Encoding UTF8
}
function Read-State([string]$Member) {
    $Stream = $null
    $Reader = $null
    try {
        # Keep an atomic producer rename possible while reading its snapshot.
        $Stream = [IO.FileStream]::new((Join-Path $script:CaseDirectory "$Member-state.json"), [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        if ($Stream.Length -le 0 -or $Stream.Length -gt 4MB) { throw 'Producer state size is out of bounds.' }
        $Reader = [IO.StreamReader]::new($Stream, [Text.Encoding]::UTF8, $true, 4096, $false)
        $Text = $Reader.ReadToEnd()
        if ($Text.Length -gt 4MB) { throw 'Producer state size is out of bounds.' }
        return $Text | ConvertFrom-Json
    }
    catch { return $null }
    finally { if ($Reader) { $Reader.Dispose() }; if ($Stream) { $Stream.Dispose() } }
}
function Wait-Condition([scriptblock]$Predicate, [string]$Label, [int]$Seconds = 30) {
    $Deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        foreach ($ObservedMember in @('a', 'b')) {
            $ObservedState = Read-State $ObservedMember
            if ($ObservedState -and $ObservedState.error) { throw "App $ObservedMember failed: $($ObservedState.error)" }
        }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 50
    }
    throw "Timed out: $Label. Evidence: $script:CaseDirectory"
}
function Command([string]$Member, [string]$Action, [string]$Window = 'main') {
    $script:Sequence++
    $Sequence = $script:Sequence
    $Destination = Join-Path $script:CaseDirectory "$Member-command.json"
    $Temporary = "$Destination.tmp"
    Save-Json @{ sequence = $Sequence; action = $Action; window = $Window } $Temporary
    Move-Item -LiteralPath $Temporary -Destination $Destination -Force
    Wait-Condition { (Read-State $Member).commandSequence -eq $Sequence } "$Member command $Action"
}
function Start-OwnedProcess([Diagnostics.ProcessStartInfo]$StartInfo, [string]$Label) {
    $Process = [Diagnostics.Process]::new()
    $Process.StartInfo = $StartInfo
    if (-not $Process.Start()) { throw "Could not start $Label." }
    $null = $Process.Handle
    return $Process
}
function Assert-InstalledPackageEvidence([object]$SdkEvidence, [string]$ConsumerRoot, [string]$SdkDist) {
    $Installed = $SdkEvidence.installedPackage
    if (-not $Installed -or ($Installed.schemaVersion -isnot [int] -and $Installed.schemaVersion -isnot [long]) -or $Installed.schemaVersion -ne 1 -or
        $Installed.releasedPackageCompatibilityClaimed -isnot [bool] -or $Installed.releasedPackageCompatibilityClaimed -ne $false -or
        $Installed.loadMethod -cne "createRequire(consumer/package.json)('electron-game-overlay')" -or
        $Installed.packageVersion -cne $SdkEvidence.packageVersion -or
        $Installed.packageVersion -cnotmatch '^\d+\.\d+\.\d+-development\.[0-9A-Za-z.-]+$') {
        throw 'The producer did not prove loading its installed development SDK public entrypoint.'
    }
    foreach ($Pair in @(
        @($Installed.consumerRoot, $ConsumerRoot),
        @($Installed.packageRoot, (Join-Path $ConsumerRoot 'node_modules\electron-game-overlay')),
        @($Installed.sdkDist, $SdkDist), @($SdkEvidence.sdkDist, $SdkDist),
        @($Installed.entrypoint, (Join-Path $SdkDist 'index.js')))) {
        if (-not $Pair[0] -or -not [IO.Path]::IsPathRooted($Pair[0]) -or
            -not [string]::Equals([IO.Path]::GetFullPath($Pair[0]), [IO.Path]::GetFullPath($Pair[1]), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Installed producer provenance resolved outside its own consumer package.'
        }
    }
    foreach ($Pair in @(@($Installed.installedManifestSha256, 'overlay-manifest.json'), @($Installed.entrySha256, 'index.js'))) {
        $File = Join-Path $SdkDist $Pair[1]
        $Info = Get-Item -LiteralPath $File
        if ($Info.Length -le 0 -or $Info.Length -gt 4MB) { throw 'Installed producer evidence file size is out of bounds.' }
        $Hasher = [Security.Cryptography.SHA256]::Create()
        try { $Hash = [BitConverter]::ToString($Hasher.ComputeHash([IO.File]::ReadAllBytes($File))).Replace('-', '').ToLowerInvariant() }
        finally { $Hasher.Dispose() }
        if ($Pair[0] -cnotmatch '^[a-f0-9]{64}$' -or $Pair[0] -cne $Hash) { throw 'Installed producer entrypoint or seal changed after package verification.' }
    }
    return $Installed
}
function Start-App([string]$Member, [string]$Slot, [int]$TargetPid = 0) {
    $StartInfo = [Diagnostics.ProcessStartInfo]::new()
    $StartInfo.FileName = $ElectronExecutable
    $ConsumerRoot = if ($Member -eq 'a') { $AppRootA } else { $AppRootB }
    $StartInfo.WorkingDirectory = if ($ConsumerRoot) { $ConsumerRoot } else { $RepoRoot }
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true
    $Arguments = @('--force-device-scale-factor=1', $Fixture, "--evidence=$script:CaseDirectory", "--member=$Member", "--slot=$Slot", "--game=$GameExecutable", "--sdk-dist=$(if ($Member -eq 'a') { $SdkDistA } else { $SdkDistB })")
    if ($ConsumerRoot) { $Arguments += "--app-root=$ConsumerRoot" }
    if ($TargetPid) { $Arguments += "--pid=$TargetPid" }
    # These arguments contain validated local paths and no embedded quotes.
    foreach ($Argument in $Arguments) { if ($Argument.Contains('"')) { throw 'A fixture path contains an unsupported quote.' } }
    $StartInfo.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $StartInfo.Environment.Remove('ELECTRON_RUN_AS_NODE') | Out-Null
    $StartInfo.Environment['ELECTRON_GAME_OVERLAY_BROKER_PIPE'] = $script:CasePipe
    $Process = Start-OwnedProcess $StartInfo "app $Member"
    $script:Apps[$Member] = @{ process = $Process; startedAt = $Process.StartTime; children = [Collections.Generic.List[Diagnostics.Process]]::new(); childIds = [Collections.Generic.HashSet[int]]::new(); stdout = $Process.StandardOutput.ReadToEndAsync(); stderr = $Process.StandardError.ReadToEndAsync() }
    Wait-Condition { (Read-State $Member).ready } "app $Member public SDK readiness" 120
    if ($ConsumerRoot) {
        $ObservedSdk = Get-Content -LiteralPath (Join-Path $script:CaseDirectory "$Member-sdk.json") -Raw | ConvertFrom-Json
        $ExpectedDist = if ($Member -eq 'a') { $SdkDistA } else { $SdkDistB }
        $script:CaseResult.installedPackages[$Member] = Assert-InstalledPackageEvidence $ObservedSdk $ConsumerRoot $ExpectedDist
    }
}
function Start-Game {
    Assert-NoRunningGame
    $StartInfo = [Diagnostics.ProcessStartInfo]::new()
    $StartInfo.FileName = $GameExecutable
    $StartInfo.WorkingDirectory = Split-Path -Parent $GameExecutable
    $StartInfo.UseShellExecute = $false
    $StartInfo.Environment['SteamAppId'] = '3173130'
    $StartInfo.Environment['SteamGameId'] = '3173130'
    # This game window must be visible for actual composited-pixel/input proof.
    $StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
    $script:Game = Start-OwnedProcess $StartInfo 'Gun Frog'
    $script:Games.Add($script:Game)
    return [ordered]@{ pid = $script:Game.Id; creationTime100ns = $script:Game.StartTime.ToFileTimeUtc().ToString(); executable = $GameExecutable }
}
function Assert-NoRunningGame {
    $Existing = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($GameExecutable)) -ErrorAction SilentlyContinue)
    if ($Existing.Count) { throw 'Gun Frog is already running; refusing to take ownership of an existing game.' }
}
function Activate-Game([ValidateRange(1, 10)][int]$TimeoutSeconds = 10) {
    $script:GameHwnd = [IntPtr]::Zero
    Wait-Condition {
        $script:Game.Refresh()
        if ($script:Game.HasExited) { throw 'The owned game exited before a foreground-ready window was available.' }
        $CandidateWindow = $script:Game.MainWindowHandle
        if (-not [EgoCooperativeGameInput]::OwnedWindow($CandidateWindow, $script:Game.Id) -or
            -not [EgoCooperativeGameInput]::LargeEnough($CandidateWindow, 640, 540)) { return $false }
        if (-not [EgoCooperativeGameInput]::Activate($CandidateWindow)) { return $false }
        if (-not [EgoCooperativeGameInput]::OwnedWindow($CandidateWindow, $script:Game.Id) -or
            -not [EgoCooperativeGameInput]::LargeEnough($CandidateWindow, 640, 540) -or
            -not [EgoCooperativeGameInput]::Foreground($CandidateWindow)) { return $false }
        $script:GameHwnd = $CandidateWindow
        return $true
    } 'a live owned game HWND with a 640x540 client and verified foreground ownership' $TimeoutSeconds
}
function Assert-Foreground {
    if (-not [EgoCooperativeGameInput]::Foreground($script:GameHwnd)) { throw 'The desktop foreground changed during controlled game input.' }
}
function Pixel([int]$X, [int]$Y, [uint32]$Expected, [string]$Label) {
    Assert-Foreground
    Wait-Condition { [EgoCooperativeGameInput]::Pixel($script:GameHwnd, $X, $Y) -eq $Expected } $Label 15
    $script:CaseResult.checks += $Label
}
function Move-Pointer([int]$X, [int]$Y) {
    Assert-Foreground
    [EgoCooperativeGameInput]::Place($script:GameHwnd, $X, $Y)
    Start-Sleep -Milliseconds 100
}
function Mouse-Button([bool]$Down) {
    Assert-Foreground
    [EgoCooperativeGameInput]::Button($Down)
    $script:MouseHeld = $Down
}
function Click([int]$X, [int]$Y) {
    Move-Pointer $X $Y
    Mouse-Button $true
    Start-Sleep -Milliseconds 80
    Mouse-Button $false
}
function Type-Text([string]$Member, [string]$Text, [string]$Window = 'main') {
    Command $Member clear $Window
    Command $Member focus $Window
    Wait-Condition { $State = Read-State $Member; $State.intercepting -and $State.focusedWindowId -eq $State.windows.$Window.id } "$Member native focus $Window"
    foreach ($Character in $Text.ToCharArray()) { Assert-Foreground; [EgoCooperativeGameInput]::Letter([uint16][char]$Character.ToString().ToUpperInvariant()); Start-Sleep -Milliseconds 60 }
    Wait-Condition { $State = Read-State $Member; $State.windows.$Window.value -ceq $Text -and @($State.windows.$Window.heldKeys).Count -eq 0 } "$Member actual typed $Text"
    $script:CaseResult.checks += "$Member/$Window received exact '$Text' and all key releases"
}
function Interception([bool]$First, [bool]$Late) {
    Command $script:FirstMember $(if ($First) { 'intercept' } else { 'release' })
    Command $script:LateMember $(if ($Late) { 'intercept' } else { 'release' })
    $Effective = $First -or $Late
    Wait-Condition { (Read-State $script:FirstMember).requestedInterception -eq $First -and (Read-State $script:LateMember).requestedInterception -eq $Late -and (Read-State 'a').intercepting -eq $Effective -and (Read-State 'b').intercepting -eq $Effective } "interception matrix $First/$Late -> $Effective"
    $script:CaseResult.interception += @{ first = $First; late = $Late; effective = $Effective }
}
function Module-Evidence([string]$Label, [string]$Survivor = '') {
    $script:Game.Refresh()
    $Records = @($script:Game.Modules | ForEach-Object { @{ path = $_.FileName; baseAddress = $_.BaseAddress.ToInt64().ToString(); bytes = $_.ModuleMemorySize } })
    $SnapshotPath = Join-Path $script:CaseDirectory "$Label-modules.json"
    $OutputPath = Join-Path $script:CaseDirectory "$Label-native-evidence.json"
    Save-Json $Records $SnapshotPath
    $Arguments = @($EvidenceHelper, '--sdk-a', $SdkDistA, '--sdk-b', $SdkDistB, '--modules-json', $SnapshotPath, '--output', $OutputPath)
    if ($Survivor) { $Arguments += @('--survivor', $Survivor) }
    & $Node @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$Label native module identity validation failed." }
    $Evidence = Get-Content -LiteralPath $OutputPath -Raw | ConvertFrom-Json
    Assert-CooperativeRuntimeHash -Observed $Evidence.mapped.runtime.sha256 -Expected @($Evidence.sdkA.runtimeManifest.reshadeRuntimeSha256, $Evidence.sdkB.runtimeManifest.reshadeRuntimeSha256)
    return $Evidence
}
function Assert-NativeLogs([string]$Phase) {
    $Paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($Member in @('a', 'b')) {
        $State = Read-State $Member
        $Path = $State.attachment.reshadeLogPath
        if ($Path -and [IO.Path]::IsPathRooted($Path) -and (Test-Path -LiteralPath $Path -PathType Leaf)) { $null = $Paths.Add($Path) }
    }
    if (-not $Paths.Count) { throw 'No attached engine supplied an existing authoritative runtime log for native fault review.' }
    $Index = 0
    foreach ($Path in $Paths) {
        $Text = Get-Content -LiteralPath $Path -Raw
        [IO.File]::WriteAllText((Join-Path $script:CaseDirectory "$Phase-native-log-$Index.txt"), $Text)
        if ($Text -match '(?i)out of global sequence|router was reset|input[^\r\n]*(failed|error)|queue[^\r\n]*(failed|error)|FATAL') { throw "Native input/router/queue fault invalidated $Phase acceptance: $Path" }
        $Index++
    }
}
function Assert-CleanGameDirectory {
    $Artifacts = @(Get-ChildItem -LiteralPath (Split-Path -Parent $GameExecutable) -Force | Where-Object { $_.Name -match '^(ReShade.*|dxgi\.dll|d3d(8|9|10|10_1|11|12)\.dll|opengl32\.dll|.*\.addon(32|64)?|electron[_-].*overlay.*|\.electron-game-overlay.*)$' })
    if ($Artifacts.Count) { throw "This clean-host case found game-local ReShade/overlay artifacts: $($Artifacts.Name -join ', '). Existing-installation acceptance is a separate gate." }
}
function Retain-OwnedElectronChildren([string]$Member) {
    if (-not $script:Apps.ContainsKey($Member)) { return }
    $Entry = $script:Apps[$Member]
    $KnownParents = [Collections.Generic.HashSet[int]]::new()
    $null = $KnownParents.Add($Entry.process.Id)
    $Snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    do {
        $Changed = $false
        foreach ($Record in $Snapshot) {
            if ($KnownParents.Contains([int]$Record.ParentProcessId) -and $KnownParents.Add([int]$Record.ProcessId)) { $Changed = $true }
        }
    } while ($Changed)
    foreach ($Record in $Snapshot) {
        if ($Record.ProcessId -eq $Entry.process.Id -or
            -not $KnownParents.Contains([int]$Record.ProcessId) -or
            $Entry.childIds.Contains([int]$Record.ProcessId) -or
            -not [string]::Equals($Record.ExecutablePath, $ElectronExecutable, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $Child = Get-Process -Id $Record.ProcessId -ErrorAction SilentlyContinue
        if (-not $Child) { continue }
        try {
            $null = $Child.Handle
            if ($Child.StartTime -lt $Entry.startedAt) { $Child.Dispose(); continue }
            $Entry.children.Add($Child)
            $null = $Entry.childIds.Add($Child.Id)
        }
        catch { $Child.Dispose(); throw }
    }
}
function Stop-OwnedApp([string]$Member) {
    if (-not $script:Apps.ContainsKey($Member)) { return }
    $Entry = $script:Apps[$Member]
    $Process = $Entry.process
    $DiscoveryFailure = $null
    try { Retain-OwnedElectronChildren $Member } catch { $DiscoveryFailure = $_.Exception.Message }
    try {
        if (-not $Process.HasExited) {
            try { Command $Member exit; $null = $Process.WaitForExit(5000) } catch {}
        }
        if (-not $Process.HasExited) { $Process.Kill(); $Process.WaitForExit() }
        $ChildFailures = @()
        foreach ($Child in $Entry.children) {
            try { if (-not $Child.HasExited) { $Child.Kill(); if (-not $Child.WaitForExit(5000)) { throw "Owned Electron child $($Child.Id) did not exit." } } }
            catch { $ChildFailures += $_.Exception.Message }
            finally { $Child.Dispose() }
        }
        if ($ChildFailures.Count) { throw "Owned Electron child cleanup failed: $($ChildFailures -join ' | ')" }
        foreach ($Stream in @('stdout', 'stderr')) {
            if (-not $Entry[$Stream].Wait(5000)) { throw "App $Member $Stream stream did not close after its owned process exited." }
            [IO.File]::WriteAllText((Join-Path $script:CaseDirectory "$Member-$Stream.txt"), $Entry[$Stream].GetAwaiter().GetResult())
        }
        if ($DiscoveryFailure) { throw "Owned app child-process discovery failed: $DiscoveryFailure" }
    }
    finally {
        $Process.Dispose()
        $script:Apps.Remove($Member)
    }
}

try {
    Assert-NoRunningGame
    Assert-CleanGameDirectory
    $SdkAPath = Join-Path $RunDirectory 'sdk-a.json'
    $SdkBPath = Join-Path $RunDirectory 'sdk-b.json'
    & $Node $EvidenceHelper --sdk $SdkDistA --output $SdkAPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'App A candidate provenance failed.' }
    & $Node $EvidenceHelper --sdk $SdkDistB --output $SdkBPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'App B candidate provenance failed.' }
    $SdkA = (Get-Content -LiteralPath $SdkAPath -Raw | ConvertFrom-Json).sdk
    $SdkB = (Get-Content -LiteralPath $SdkBPath -Raw | ConvertFrom-Json).sdk
    $Different = $SdkA.javascriptGraphSha256 -cne $SdkB.javascriptGraphSha256 -or $SdkA.addon.sha256 -cne $SdkB.addon.sha256
    if ($RequireDifferentImplementations -and -not $Different) { throw 'Both candidates have identical JavaScript/native implementation bytes; version labels cannot establish a mixed implementation run.' }
    $Report.provenance = @{ a = $SdkA; b = $SdkB; declaredSourceRevisionA = $SourceRevisionA; declaredSourceRevisionB = $SourceRevisionB; differentImplementationBytes = $Different; releasedPackageCompatibilityClaimed = $false }
    $Orders = if ($StartupOrder -eq 'both') { @('a-first', 'b-first') } else { @($StartupOrder) }
    $ExitModes = if ($FirstAppExit -eq 'both') { @('graceful', 'crash') } else { @($FirstAppExit) }
    foreach ($Order in $Orders) { foreach ($ExitMode in $ExitModes) {
        $script:CaseDirectory = Join-Path $RunDirectory "$Order-$ExitMode"
        New-Item -ItemType Directory -Path $script:CaseDirectory | Out-Null
        $script:Apps = @{}
        $script:Games = [Collections.Generic.List[Diagnostics.Process]]::new()
        $script:Game = $null
        $script:CasePipe = '\\.\pipe\ego-cooperative-game-' + [Guid]::NewGuid().ToString('N')
        $script:FirstMember = if ($Order -eq 'a-first') { 'a' } else { 'b' }
        $script:LateMember = if ($script:FirstMember -eq 'a') { 'b' } else { 'a' }
        $script:CaseResult = [ordered]@{ order = $Order; firstAppExit = $ExitMode; initialAttachment = 'exact-path native prearm before controller launch; authenticated PID and creation identity checked afterward'; lateAttachment = 'exact-PID attachment after first-app rendering'; status = 'failed'; checks = @(); interception = @() }
        if ($AppRootA) { $script:CaseResult.installedPackages = @{} }
        try {
            Assert-NoRunningGame
            Start-App $script:FirstMember first
            Wait-Condition { (Read-State $script:FirstMember).watcherReady } 'first app native watcher ready' 120
            $script:CaseResult.target = Start-Game
            Activate-Game
            Wait-Condition { $State = Read-State $script:FirstMember; $State.attached -and $State.rendering -and $State.targetPid -eq $script:Game.Id } 'first app exact-PID authenticated rendering' 150
            Activate-Game
            Pixel 55 130 0x2828c6 'first app actual red surface'
            Start-App $script:LateMember late $script:Game.Id
            Wait-Condition { $State = Read-State $script:LateMember; $State.attached -and $State.rendering -and $State.targetPid -eq $script:Game.Id } 'late app authenticated rendering on same target' 90
            $AState = Read-State 'a'
            $BState = Read-State 'b'
            if ($AState.transport.port -eq $BState.transport.port -or $AState.transport.tokenFingerprint -ceq $BState.transport.tokenFingerprint -or
                $AState.transport.producerPid -ne $script:Apps['a'].process.Id -or $BState.transport.producerPid -ne $script:Apps['b'].process.Id -or
                $AState.transport.port -ne $AState.transportPort -or $BState.transport.port -ne $BState.transportPort -or
                $AState.authenticatedTarget.pid -ne $script:Game.Id -or $BState.authenticatedTarget.pid -ne $script:Game.Id -or
                $AState.authenticatedTarget.creationTime100ns -cne $script:CaseResult.target.creationTime100ns -or
                $BState.authenticatedTarget.creationTime100ns -cne $script:CaseResult.target.creationTime100ns -or
                -not [string]::Equals($AState.authenticatedTarget.executablePath, $GameExecutable, [StringComparison]::OrdinalIgnoreCase) -or
                -not [string]::Equals($BState.authenticatedTarget.executablePath, $GameExecutable, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'The two engines did not establish distinct private authenticated application endpoints to the exact owned game.'
            }
            $script:CaseResult.privateTransports = @{ a = $AState.transport; b = $BState.transport }
            if ((Read-State 'a').windows.main.id -ne (Read-State 'b').windows.main.id) { throw 'The two genuine Electron processes did not produce the required colliding local window IDs.' }
            Pixel 430 210 0xc06515 'late app actual blue surface'
            Command $script:FirstMember create-extra
            Wait-Condition { $State = Read-State $script:FirstMember; $State.windows.extra.alphaProbe.hole -eq 0 -and $State.windows.extra.alphaProbe.opaque -eq 255 } 'genuine Electron paint has a transparent cutout and opaque backing'
            Pixel 230 235 0xc06515 'late app window is above first app main'
            Pixel 480 350 0x327d2e 'first app extra is above late app window'
            Pixel 470 430 0xc06515 'transparent extra cutout reveals late app pixels'
            $script:CaseResult.native = Module-Evidence 'both-active'
            Assert-NativeLogs 'both-active'
            Interception $true $true
            Type-Text $script:FirstMember alpha
            if ((Read-State $script:LateMember).windows.main.value -cne '') { throw 'First app typing leaked to the late app.' }
            Type-Text $script:LateMember bravo
            if ((Read-State $script:FirstMember).windows.main.value -cne 'alpha') { throw 'Late app typing altered the first app.' }
            Click 100 350
            Pixel 340 335 0x2828c6 'click raises one existing first-app window across peer windows'
            $ExtraDowns = (Read-State $script:FirstMember).windows.extra.downs
            $LateDowns = (Read-State $script:LateMember).windows.main.downs
            Click 470 430
            Wait-Condition { (Read-State $script:LateMember).windows.main.downs -eq $LateDowns + 1 } 'transparent cutout routes one click to peer'
            if ((Read-State $script:FirstMember).windows.extra.downs -ne $ExtraDowns) { throw 'Transparent upper window consumed a peer click.' }
            Click 510 350
            Pixel 480 350 0x327d2e 'extra window raises independently'
            Wait-Condition { (Read-State $script:FirstMember).windows.extra.downs -eq $ExtraDowns + 1 -and (Read-State $script:FirstMember).windows.extra.ups -gt 0 } 'extra raise click completed exactly once'
            $CaptureDowns = (Read-State $script:FirstMember).windows.extra.downs
            $ExtraUps = (Read-State $script:FirstMember).windows.extra.ups
            $LateUps = (Read-State $script:LateMember).windows.main.ups
            Move-Pointer 510 350
            Mouse-Button $true
            Wait-Condition { (Read-State $script:FirstMember).windows.extra.downs -eq $CaptureDowns + 1 } 'extra owns pointer-down before capture movement'
            Move-Pointer 200 430
            Mouse-Button $false
            Wait-Condition { (Read-State $script:FirstMember).windows.extra.ups -gt $ExtraUps } 'pointer capture delivers release outside original window'
            if ((Read-State $script:LateMember).windows.main.ups -ne $LateUps) { throw 'Captured pointer release leaked to the peer.' }
            foreach ($Cursor in @(@(300,295,32513,'text'), @(290,340,32649,'hand'), @(410,340,32644,'ew-resize'))) {
                Move-Pointer $Cursor[0] $Cursor[1]
                $CursorId = [int]$Cursor[2]
                Wait-Condition { [EgoCooperativeGameInput]::CursorIs($CursorId) } "actual owner cursor $($Cursor[3])" 10
                $script:CaseResult.checks += "actual Windows cursor $($Cursor[3])"
            }
            Move-Pointer 310 410
            [EgoCooperativeGameInput]::Wheel(-120, $false)
            Wait-Condition { (Read-State $script:FirstMember).windows.extra.scroll.y -gt 0 } 'owner nested vertical wheel'
            [EgoCooperativeGameInput]::Wheel(120, $true)
            Wait-Condition { (Read-State $script:FirstMember).windows.extra.scroll.x -gt 0 } 'owner nested horizontal wheel'
            if ((Read-State $script:LateMember).windows.main.scroll.x -ne 0 -or (Read-State $script:LateMember).windows.main.scroll.y -ne 0) { throw 'Owner wheel input scrolled the peer.' }
            if ((Read-State $script:FirstMember).windows.main.scroll.x -ne 0 -or (Read-State $script:FirstMember).windows.main.scroll.y -ne 0) { throw 'Owner wheel input scrolled another local window.' }
            Move-Pointer 360 250
            Mouse-Button $true
            Start-Sleep -Milliseconds 100
            Move-Pointer 420 290
            Mouse-Button $false
            Pixel 565 325 0x327d2e 'caption drag changes native placement'
            Command $script:LateMember focus
            Command $script:LateMember create-extra
            Command $script:LateMember close-extra
            Pixel 565 325 0x327d2e 'dragged placement survives peer focus and window publication'
            Interception $true $false
            Interception $false $true
            Interception $false $false
            Interception $true $true
            Command $script:FirstMember focus extra
            Retain-OwnedElectronChildren $script:FirstMember
            if ($ExitMode -eq 'graceful') { Command $script:FirstMember exit }
            else { $script:Apps[$script:FirstMember].process.Kill() }
            if (-not $script:Apps[$script:FirstMember].process.WaitForExit(10000)) { throw 'First app did not exit.' }
            Stop-OwnedApp $script:FirstMember
            Wait-Condition { (Read-State $script:LateMember).intercepting } 'survivor retains interception request'
            if ($script:Game.HasExited -or $script:Apps[$script:LateMember].process.HasExited) { throw 'The game or surviving app exited with its peer.' }
            Pixel 430 210 0xc06515 'surviving app remains composited after peer exit'
            Wait-Condition { [EgoCooperativeGameInput]::Pixel($script:GameHwnd, 565, 325) -ne 0x327d2e } 'retired app surface disappears' 15
            Type-Text $script:LateMember survivor
            $script:CaseResult.survivorNative = Module-Evidence 'survivor' $script:LateMember
            Assert-NativeLogs 'survivor'
            Command $script:LateMember release
            Wait-Condition { -not (Read-State $script:LateMember).intercepting } 'last member release restores game input'
            $OldTarget = $script:Game
            if (-not $OldTarget.CloseMainWindow() -or -not $OldTarget.WaitForExit(10000)) { throw 'Owned game did not close normally after input release.' }
            Assert-NoRunningGame
            Command $script:LateMember arm-next
            Wait-Condition { (Read-State $script:LateMember).watcherReady } 'surviving app rearms for next game' 120
            $script:CaseResult.relaunchTarget = Start-Game
            Activate-Game
            Wait-Condition { $State = Read-State $script:LateMember; $State.attached -and $State.rendering -and $State.targetPid -eq $script:Game.Id } 'same surviving app attaches new game instance' 150
            if ((Read-State $script:LateMember).authenticatedTarget.creationTime100ns -cne $script:CaseResult.relaunchTarget.creationTime100ns) { throw 'Relaunched native hello did not identify the exact controller-owned game incarnation.' }
            Activate-Game
            Command $script:LateMember intercept
            Pixel 430 210 0xc06515 'survivor renders after game relaunch'
            Type-Text $script:LateMember relaunch
            $script:CaseResult.relaunchNative = Module-Evidence 'relaunch' $script:LateMember
            if (@($script:CaseResult.relaunchNative.mapped.addons).Count -ne 1) { throw 'A fresh game with one surviving app must contain exactly its one private EGO add-on.' }
            Assert-NativeLogs 'relaunch'
            Command $script:LateMember release
            Wait-Condition { -not (Read-State $script:LateMember).intercepting } 'relaunch release'
            if (-not $script:Game.CloseMainWindow() -or -not $script:Game.WaitForExit(10000)) { throw 'Relaunched owned game did not close normally.' }
            $script:CaseResult.finalStates = @{ a = Read-State 'a'; b = Read-State 'b' }
            Assert-CleanGameDirectory
            $script:CaseResult.status = 'passed'
        }
        catch { $script:CaseResult.error = $_.Exception.Message; throw }
        finally {
            $CleanupErrors = @()
            if ($script:MouseHeld) { try { [EgoCooperativeGameInput]::Button($false) } catch { $CleanupErrors += $_.Exception.Message }; $script:MouseHeld = $false }
            foreach ($Member in @('a', 'b')) { try { Stop-OwnedApp $Member } catch { $CleanupErrors += $_.Exception.Message } }
            foreach ($OwnedGame in $script:Games) {
                try { if (-not $OwnedGame.HasExited) { $null = $OwnedGame.CloseMainWindow(); if (-not $OwnedGame.WaitForExit(5000)) { $OwnedGame.Kill(); $OwnedGame.WaitForExit() } } }
                catch { $CleanupErrors += $_.Exception.Message }
                finally { $OwnedGame.Dispose() }
            }
            if ($CleanupErrors.Count) { $script:CaseResult.status = 'failed'; $script:CaseResult.cleanupErrors = $CleanupErrors }
            Save-Json $script:CaseResult (Join-Path $script:CaseDirectory 'result.json')
            $Report.cases += $script:CaseResult
            if ($CleanupErrors.Count) { throw "Owned case cleanup failed: $($CleanupErrors -join ' | ')" }
        }
    } }
    $Report.status = 'passed'
    Write-Host 'GUN_FROG_COOPERATIVE_TWO_APP_GAME_GATE_PASS'
}
catch { $Report.error = $_.Exception.Message; throw }
finally {
    Save-Json $Report (Join-Path $RunDirectory 'report.json')
    Write-Host "Cooperative two-app game evidence: $RunDirectory"
}
