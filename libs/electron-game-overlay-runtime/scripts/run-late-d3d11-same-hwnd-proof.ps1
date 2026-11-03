#requires -Version 7.2
# The resize case calls real ResizeBuffers at unchanged 800x600 dimensions.
# It isolates active input-consumer ownership from DPI/geometry projection.
# Each invocation owns a fresh target; this is synthetic foreground input, not
# a physical-key gate or automatic process-attachment acceptance.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$AddonPath,
    [Parameter(Mandatory = $true)][ValidateSet('primary-resize', 'primary-final-destroy', 'primary-paused')][string]$Case,
    [ValidateSet('x64', 'Win32')][string]$Architecture = 'x64',
    [string]$SdkDist,
    [string]$ElectronPath,
    [ValidateRange(20000, 180000)][int]$LifetimeMs = 60000,
    [ValidateRange(250, 1000)][int]$HoldMilliseconds = 400,
    [switch]$SkipBuild,
    [Parameter(DontShow)][ValidateSet(0, 2800)][int]$UiBusyMilliseconds = 0,
    [Parameter(DontShow)][switch]$Prototype,
    [Parameter(DontShow)][switch]$DiagnosticInputOnly
)

$ErrorActionPreference = 'Stop'
if ($Prototype -and -not $DiagnosticInputOnly) { throw 'Prototype mode is an internal baseline diagnostic; also specify -DiagnosticInputOnly.' }
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$BuildRoot = Join-Path $RepoRoot 'build\late-d3d11-same-hwnd'
$Fixture = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\late-d3d11-same-hwnd'
$SceneFixture = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\late-d3d11-adoption'
$Compile = Join-Path $BuildRoot "compile-$Architecture"
if (-not $SdkDist) { $SdkDist = Join-Path $RepoRoot 'libs\electron-game-overlay\dist' }
if (-not $ElectronPath) { $ElectronPath = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' }
$Runtime = (Resolve-Path -LiteralPath $RuntimePath).Path
$Addon = (Resolve-Path -LiteralPath $AddonPath).Path
$Sdk = (Resolve-Path -LiteralPath $SdkDist).Path
$Electron = (Resolve-Path -LiteralPath $ElectronPath).Path
if (-not $SkipBuild) {
    & cmake -S $Fixture -B $Compile -G 'Visual Studio 17 2022' -A $Architecture
    if ($LASTEXITCODE -ne 0) { throw 'Same-HWND standalone host configure failed.' }
    & cmake --build $Compile --config Release --target late_d3d11_same_hwnd_host
    if ($LASTEXITCODE -ne 0) { throw 'Same-HWND standalone host build failed.' }
}
$BuiltHost = Join-Path $Compile 'Release\late_d3d11_same_hwnd_host.exe'
foreach ($File in @($BuiltHost, (Join-Path $Fixture 'host.cpp'), (Join-Path $Sdk 'index.js'), (Join-Path $SceneFixture 'scene-producer.cjs'))) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Required proof file is missing: $File" }
}

$ProofCase = if ($UiBusyMilliseconds -ne 0) { 'ui-busy-hook-recovery' } else { $Case }
$Run = Join-Path $BuildRoot ('proof-' + $ProofCase + '-' + $Architecture + '-' + [Guid]::NewGuid().ToString('N'))
$Stage = Join-Path $Run 'stage'
$TargetDirectory = Join-Path $Run 'target'
$ProducerEvidence = Join-Path $Run 'producer'
New-Item -ItemType Directory -Path $Stage, $TargetDirectory, $ProducerEvidence | Out-Null
$RuntimeLeaf = if ($Architecture -eq 'x64') { 'ReShade64.dll' } else { 'ReShade32.dll' }
$AddonLeaf = if ($Architecture -eq 'x64') { 'electron_game_overlay.addon64' } else { 'electron_game_overlay.addon32' }
$HostPath = Join-Path $TargetDirectory 'late_d3d11_same_hwnd_host.exe'
$RuntimeHash = (Get-FileHash -LiteralPath $Runtime -Algorithm SHA256).Hash
$AddonHash = (Get-FileHash -LiteralPath $Addon -Algorithm SHA256).Hash
$HostHash = (Get-FileHash -LiteralPath $BuiltHost -Algorithm SHA256).Hash
foreach ($Copy in @(
    @($Runtime, (Join-Path $Stage $RuntimeLeaf), $RuntimeHash),
    @($Addon, (Join-Path $Stage $AddonLeaf), $AddonHash),
    @($BuiltHost, $HostPath, $HostHash)
)) {
    Copy-Item -LiteralPath $Copy[0] -Destination $Copy[1]
    if ((Get-FileHash -LiteralPath $Copy[1] -Algorithm SHA256).Hash -ne $Copy[2]) {
        throw 'Same-HWND staging changed the supplied file bytes.'
    }
}
Copy-Item -LiteralPath (Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\config\ReShade.ini') -Destination (Join-Path $Stage 'ReShade.ini')
if ($Prototype) {
    [IO.File]::WriteAllText((Join-Path $Stage 'ego-owned-late-d3d11-prototype.marker'), "EGO_OWNED_LATE_D3D11_PROTOTYPE_V1`n", [Text.Encoding]::ASCII)
}
else {
    [IO.File]::WriteAllText((Join-Path $Stage 'electron-game-overlay-owned-runtime-v1.marker'), "ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1`n", [Text.Encoding]::ASCII)
}
$TemplateHashBefore = (Get-FileHash -LiteralPath (Join-Path $Stage 'ReShade.ini') -Algorithm SHA256).Hash
. (Join-Path $PSScriptRoot 'owned-stage-marker.ps1')
. (Join-Path $PSScriptRoot 'late-d3d11-child-environment.ps1')
Write-OwnedOverlayRunMarker -RunDirectory $Stage -BuildRoot $BuildRoot

$HostReport = Join-Path $Stage 'host-report.json'
$HostCommandFile = Join-Path $Stage 'same-hwnd-command.txt'
$StateFile = Join-Path $ProducerEvidence 'scene-state.json'
$CommandFile = Join-Path $ProducerEvidence 'scene-command.json'
$EvidenceFile = Join-Path $Run 'evidence.json'
$TargetProcess = $null
$Producer = $null
$ProducerExpectedExited = $false
$HostChild = $null
$ProducerChild = $null
$TargetWindow = [IntPtr]::Zero
$SceneSequence = 0L
$HostSequence = 0L
$HeldKeyDown = $false
$TestVirtualKey = [ushort]0x41
$Utf8 = [Text.UTF8Encoding]::new($false)
$Proof = [ordered]@{
    schemaVersion = 1
    fixture = 'late-d3d11-same-hwnd-input-lifetime'
    case = $Case
    scenario = $ProofCase
    uiBusyMilliseconds = $UiBusyMilliseconds
    uiBusyHookRecoveryProven = $false
    bootstrapMode = if ($Prototype) { 'prototype' } else { 'production-owned' }
    productionOwnedAbiProven = $false
    architecture = $Architecture
    status = 'failed'
    automaticProcessAttachmentProven = $false
    physicalInputProven = $false
    inputSource = 'Windows SendInput bounded held virtual key A'
    sameHwndInputPromotionProven = $false
    renderedOverlayPixelsProven = $false
    diagnosticInputOnly = [bool]$DiagnosticInputOnly
    diagnosticInputOraclesPassed = $false
    diagnosticPixelFailures = @()
    runtimeSha256 = $RuntimeHash
    addonSha256 = $AddonHash
    stagedTemplateSha256Before = $TemplateHashBefore
    hostSha256 = $HostHash
    hostSourceSha256 = (Get-FileHash -LiteralPath (Join-Path $Fixture 'host.cpp') -Algorithm SHA256).Hash
    controllerSourceSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
    producerSourceSha256 = (Get-FileHash -LiteralPath (Join-Path $SceneFixture 'scene-producer.cjs') -Algorithm SHA256).Hash
    sdkEntrySha256 = (Get-FileHash -LiteralPath (Join-Path $Sdk 'index.js') -Algorithm SHA256).Hash
    holdMilliseconds = $HoldMilliseconds
    lifecycleDescription = if ($Case -eq 'primary-resize') {
        'Real primary ResizeBuffers at unchanged 800x600 dimensions while the same-HWND peer remains live.'
    } elseif ($Case -eq 'primary-paused') {
        'Primary A remains alive without Present; exact same-HWND peer B alone drives new registrations, commands, input and producer withdrawal.'
    } else {
        'Final primary native swapchain release while the same-HWND peer keeps presenting.'
    }
    pollingWindows = [ordered]@{}
}

function Save-Proof {
    [IO.File]::WriteAllText($EvidenceFile, ($Proof | ConvertTo-Json -Depth 20), $Utf8)
}

function Read-SharedJson([string]$File) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $null }
    $Stream = $null
    $Reader = $null
    try {
        $Stream = [IO.FileStream]::new($File, [IO.FileMode]::Open, [IO.FileAccess]::Read,
            ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $Reader = [IO.StreamReader]::new($Stream)
        return ($Reader.ReadToEnd() | ConvertFrom-Json)
    }
    finally {
        if ($Reader) { $Reader.Dispose() }
        elseif ($Stream) { $Stream.Dispose() }
    }
}

function Get-ProofSnapshot {
    Assert-TargetAlive 'snapshot'
    if ($Producer -and $Producer.HasExited -and -not $ProducerExpectedExited) { throw 'The private scene producer exited before acceptance completed.' }
    $Scene = Read-SharedJson $StateFile
    $Native = Read-SharedJson $HostReport
    if ($Scene -and $Scene.PSObject.Properties['error'] -and $Scene.error) { throw "Scene producer fault: $($Scene.error)" }
    if ($Native -and $Native.status -eq 'failed') { throw "Native host fault: $($Native.failure)" }
    if ($TargetProcess -and $Native -and $Native.pid -ne $TargetProcess.Id) { throw 'The native report identifies a different process.' }
    if ($TargetProcess -and $Scene -and $null -ne $Scene.targetPid -and $Scene.targetPid -ne $TargetProcess.Id) { throw 'The private route authenticated a different process.' }
    return [pscustomobject]@{ Scene = $Scene; Native = $Native }
}

function Assert-TargetAlive([string]$Phase) {
    if ($TargetProcess -and $TargetProcess.HasExited) {
        $Report = Read-SharedJson $HostReport
        $Proof.earlyTargetExit = @{ phase = $Phase; exitCode = $TargetProcess.ExitCode; report = $Report }
        Save-Proof
        throw "The retained native target exited at $Phase (exit $($TargetProcess.ExitCode)); host failure='$($Report.failure)', publication='$($Report.reportPublicationOperation)', Win32=$($Report.reportPublicationLastError), retries=$($Report.reportPublicationRetries)."
    }
}

function Get-PrivateConnectionIdentity($Snapshot) {
    $Connections = @(Get-NetTCPConnection -OwningProcess $TargetProcess.Id -State Established -ErrorAction Stop |
        Where-Object { $_.RemotePort -eq [int]$Snapshot.Scene.transport.port })
    if ($Connections.Count -ne 1) { throw 'Expected exactly one established target socket for this private producer port.' }
    $Connection = $Connections[0]
    return "$($Connection.LocalAddress):$($Connection.LocalPort)>$($Connection.RemoteAddress):$($Connection.RemotePort)"
}

function Wait-Proof([scriptblock]$Predicate, [int]$Seconds, [string]$Failure) {
    $Deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        $Snapshot = Get-ProofSnapshot
        if (& $Predicate $Snapshot.Scene $Snapshot.Native) { return $Snapshot }
        Start-Sleep -Milliseconds 30
    }
    throw $Failure
}

function Send-SceneCommand([string]$Action) {
    $script:SceneSequence++
    $Temporary = $CommandFile + '.tmp'
    [IO.File]::WriteAllText($Temporary, (@{ sequence = $SceneSequence; action = $Action } | ConvertTo-Json -Compress), $Utf8)
    [IO.File]::Move($Temporary, $CommandFile, $true)
    if ($Action -ne 'exit') {
        $null = Wait-Proof { param($Scene, $Native) $Scene -and $Scene.commandSequence -eq $SceneSequence } 10 "Scene command was not acknowledged: $Action"
    }
}

function Send-HostCommand([string]$Action, [switch]$NoWait) {
    $script:HostSequence++
    $Temporary = $HostCommandFile + '.tmp'
    [IO.File]::WriteAllText($Temporary, "EGO_SAME_HWND_COMMAND_V1 $HostSequence $Action`n", [Text.Encoding]::ASCII)
    [IO.File]::Move($Temporary, $HostCommandFile, $true)
    if (-not $NoWait) {
        $null = Wait-Proof { param($Scene, $Native) $Native -and $Native.commandSequence -eq $HostSequence } 10 "Native command was not acknowledged: $Action"
    }
    return $HostSequence
}

function Start-ProofChild([string]$File, [string[]]$Arguments, [string]$Directory, [string]$LogName, [bool]$Visible) {
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = $File
    $Info.WorkingDirectory = $Directory
    $Info.UseShellExecute = $false
    $Info.CreateNoWindow = -not $Visible
    $Info.WindowStyle = if ($Visible) { [Diagnostics.ProcessWindowStyle]::Normal } else { [Diagnostics.ProcessWindowStyle]::Hidden }
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    foreach ($Argument in $Arguments) { $Info.ArgumentList.Add($Argument) }
    foreach ($Name in @($Info.Environment.Keys)) {
        if ($Name.Equals('ELECTRON_RUN_AS_NODE', [StringComparison]::OrdinalIgnoreCase) -or
            $Name.Equals('RESHADE_BASE_PATH_OVERRIDE', [StringComparison]::OrdinalIgnoreCase) -or
            $Name.StartsWith('RESHADE_DISABLE_', [StringComparison]::OrdinalIgnoreCase) -or
            $Name.StartsWith('ELECTRON_GAME_OVERLAY', [StringComparison]::OrdinalIgnoreCase) -or
            $Name.StartsWith('EGO_', [StringComparison]::OrdinalIgnoreCase)) {
            $Info.Environment.Remove($Name) | Out-Null
        }
    }
    if ($Visible) {
        $EnvironmentProof = Set-LateD3D11OwnedStageChildEnvironment -StartInfo $Info -StageDirectory $Stage -FixtureRoot $BuildRoot
        $Proof.childOwnedBasePath = $EnvironmentProof.stageDirectory
    }
    $Child = [Diagnostics.Process]::new()
    $Child.StartInfo = $Info
    try {
        if (-not $Child.Start()) { throw "Could not start owned proof child: $File" }
        return [pscustomobject]@{
            Process = $Child
            Out = $Child.StandardOutput.ReadToEndAsync()
            Err = $Child.StandardError.ReadToEndAsync()
            Name = $LogName
        }
    }
    catch {
        try {
            if ($Child.Id -gt 0 -and -not $Child.HasExited) {
                $Child.Kill($true)
                $null = $Child.WaitForExit(5000)
            }
        }
        catch {}
        $Child.Dispose()
        throw
    }
}

if (-not ('EgoSameHwndD3D11ProofInputV1' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EgoSameHwndD3D11ProofInputV1 {
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public uint size,flags; public IntPtr cursor; public POINT point; }
 [StructLayout(LayoutKind.Sequential)] struct RECT { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr pid);
 [DllImport("user32.dll",EntryPoint="GetWindowThreadProcessId")] static extern uint GetWindowOwner(IntPtr h,out uint pid);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref POINT point);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO cursor);
 [DllImport("user32.dll")] static extern IntPtr LoadCursor(IntPtr module,IntPtr id);
 [DllImport("user32.dll")] static extern bool GetClipCursor(out RECT rectangle);
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h,IntPtr dc);
 [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc,int x,int y);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
 public static bool OwnsWindow(IntPtr h,int expectedPid) { uint pid; return GetWindowOwner(h,out pid)!=0&&pid==(uint)expectedPid; }
 public static bool Foreground(IntPtr h,int expectedPid) {
  if(!OwnsWindow(h,expectedPid))return false;
  uint current=GetCurrentThreadId(),target=GetWindowThreadProcessId(h,IntPtr.Zero),prior=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
  bool a=target!=0&&target!=current&&AttachThreadInput(current,target,true);
  bool b=prior!=0&&prior!=current&&prior!=target&&AttachThreadInput(current,prior,true);
  try { ShowWindow(h,9); BringWindowToTop(h); SetForegroundWindow(h); }
  finally { if(b)AttachThreadInput(current,prior,false);if(a)AttachThreadInput(current,target,false); }
  return GetForegroundWindow()==h;
 }
 public static bool IsDown(ushort key) { return (GetAsyncKeyState(key)&0x8000)!=0; }
 public static void Place(IntPtr h,int x,int y) {
  var p=new POINT{x=x,y=y};if(!ClientToScreen(h,ref p)||!SetCursorPos(p.x,p.y))throw new Exception("Pointer placement failed");
 }
 public static string CursorState() {
  var c=new CURSORINFO{size=(uint)Marshal.SizeOf(typeof(CURSORINFO))};
  if(!GetCursorInfo(ref c))throw new Exception("GetCursorInfo failed");return c.flags+":"+c.cursor.ToInt64();
 }
 public static bool CursorIs(int id) {
  var c=new CURSORINFO{size=(uint)Marshal.SizeOf(typeof(CURSORINFO))};
  return GetCursorInfo(ref c)&&c.flags==1&&c.cursor==LoadCursor(IntPtr.Zero,new IntPtr(id));
 }
 public static string ClipState() {
  RECT r;if(!GetClipCursor(out r))throw new Exception("GetClipCursor failed");return r.left+":"+r.top+":"+r.right+":"+r.bottom;
 }
 public static uint Pixel(IntPtr h,int x,int y) {
  var point=new POINT{x=x,y=y}; if(!ClientToScreen(h,ref point))throw new Exception("ClientToScreen failed");
  var dc=GetDC(IntPtr.Zero);if(dc==IntPtr.Zero)throw new Exception("GetDC failed");
  try{return GetPixel(dc,point.x,point.y);}finally{ReleaseDC(IntPtr.Zero,dc);}
 }
 public static void Down(IntPtr h,int expectedPid,ushort key) {
  if(!OwnsWindow(h,expectedPid)||GetForegroundWindow()!=h)throw new Exception("Target identity/foreground lost before held key");
  var input=new INPUT{type=1,data=new UNION{key=new KEY{vk=key}}};
  if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("SendInput key-down failed");
 }
 public static void Up(ushort key) {
  // Release only the controller-owned synthetic hold, even if foreground moved.
  var input=new INPUT{type=1,data=new UNION{key=new KEY{vk=key,flags=2}}};
  if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("SendInput key-up failed");
 }
 public static void Click(IntPtr h,int expectedPid,int x,int y) {
  if(!OwnsWindow(h,expectedPid)||GetForegroundWindow()!=h)throw new Exception("Target identity/foreground lost before click");
  var point=new POINT{x=x,y=y};
  if(!ClientToScreen(h,ref point)||!SetCursorPos(point.x,point.y))throw new Exception("Cannot position controlled pointer");
  var down=new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=2}}};
  var up=new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=4}}};
  if(SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception("SendInput click failed");
 }
}
'@
}

function Assert-TargetForeground([string]$Phase) {
    Assert-TargetAlive $Phase
    if (-not $TargetProcess -or $TargetProcess.HasExited -or
        -not [EgoSameHwndD3D11ProofInputV1]::OwnsWindow($TargetWindow, $TargetProcess.Id) -or
        [EgoSameHwndD3D11ProofInputV1]::GetForegroundWindow() -ne $TargetWindow) {
        throw "Target identity/foreground lost at $Phase."
    }
}

function Assert-RedPixel([string]$Name) {
    Assert-TargetForeground $Name
    $Pixel = [EgoSameHwndD3D11ProofInputV1]::Pixel($TargetWindow, 60, 80)
    $Red = [int]($Pixel -band 255)
    $Green = [int](($Pixel -shr 8) -band 255)
    $Blue = [int](($Pixel -shr 16) -band 255)
    $Proof[$Name] = @{ clientX = 60; clientY = 80; red = $Red; green = $Green; blue = $Blue; source = 'foreground desktop GetPixel'; tickMs = [Environment]::TickCount64 }
    Save-Proof
    if ([Math]::Abs($Red - 198) -gt 8 -or [Math]::Abs($Green - 40) -gt 8 -or [Math]::Abs($Blue - 40) -gt 8) {
        if ($DiagnosticInputOnly) {
            $Proof.diagnosticPixelFailures = @($Proof.diagnosticPixelFailures) + @($Name)
            Save-Proof
            return
        }
        throw "Transported red pixel missing at $Name`: R=$Red G=$Green B=$Blue"
    }
}

function Capture-HeldKey([string]$Name, [bool]$ExpectedBlocked) {
    Assert-TargetForeground ($Name + '-begin')
    if ([EgoSameHwndD3D11ProofInputV1]::IsDown($TestVirtualKey)) { throw 'The test virtual key was already held before controller injection.' }
    $Epoch = Send-HostCommand 'sample-begin'
    $Before = Wait-Proof { param($Scene, $Native)
        $Native -and $Native.polling.epoch -eq $Epoch -and $Native.polling.virtualKey -eq $TestVirtualKey -and
        $Native.polling.active -and $Native.polling.samples -ge 3
    } 5 'Native polling did not begin and settle before the held key.'
    $FirstHeld = $null
    $LastHeld = $null
    $DomHeld = $false
    $OutsideTargetSawDown = $false
    $StartTick = 0L
    $ReleaseTick = 0L
    $Record = [ordered]@{
        expectedBlocked = $ExpectedBlocked
        epoch = $Epoch
        before = $Before
        firstHeld = $null
        lastHeld = $null
        after = $null
        holdStartTickMs = 0
        releaseTickMs = 0
        outsideTargetSawDown = $false
        transportedDomHeld = $false
    }
    $Proof.pollingWindows[$Name] = $Record
    Save-Proof
    try {
        [EgoSameHwndD3D11ProofInputV1]::Down($TargetWindow, $TargetProcess.Id, $TestVirtualKey)
        $script:HeldKeyDown = $true
        $StartTick = [Environment]::TickCount64
        $Record.holdStartTickMs = $StartTick
        $Deadline = $StartTick + $HoldMilliseconds
        while ([Environment]::TickCount64 -lt $Deadline) {
            Assert-TargetForeground ($Name + '-held')
            $Snapshot = Get-ProofSnapshot
            $Down = [EgoSameHwndD3D11ProofInputV1]::IsDown($TestVirtualKey)
            $OutsideTargetSawDown = $OutsideTargetSawDown -or $Down
            if ($Snapshot.Native -and $Snapshot.Native.polling.epoch -eq $Epoch -and
                $Snapshot.Native.polling.active -and $Down -and
                $Snapshot.Native.polling.lastSampleTickMs -ge $StartTick -and
                $Snapshot.Native.polling.lastSampleTickMs -le [Environment]::TickCount64) {
                if (-not $FirstHeld) { $FirstHeld = $Snapshot }
                $LastHeld = $Snapshot
            }
            if ($Snapshot.Scene -and $Snapshot.Scene.window.keyDowns -gt $Before.Scene.window.keyDowns -and
                @($Snapshot.Scene.window.heldKeys).Count -gt 0) { $DomHeld = $true }
            Start-Sleep -Milliseconds 15
        }
    }
    finally {
        if ($HeldKeyDown) {
            [EgoSameHwndD3D11ProofInputV1]::Up($TestVirtualKey)
            $script:HeldKeyDown = $false
        }
        $ReleaseTick = [Environment]::TickCount64
        $Record.releaseTickMs = $ReleaseTick
        $Record.firstHeld = $FirstHeld
        $Record.lastHeld = $LastHeld
        $Record.outsideTargetSawDown = $OutsideTargetSawDown
        $Record.transportedDomHeld = $DomHeld
        Save-Proof
    }
    $null = Wait-Proof { param($Scene, $Native)
        $Scene -and @($Scene.window.heldKeys).Count -eq 0 -and $Native -and
        $Native.polling.epoch -eq $Epoch -and $Native.polling.lastSampleTickMs -ge ($ReleaseTick + 100) -and
        -not $Native.polling.lastAsyncDown -and -not $Native.polling.lastKeyStateDown -and
        -not $Native.polling.lastKeyboardStateDown -and -not [EgoSameHwndD3D11ProofInputV1]::IsDown($TestVirtualKey)
    } 5 'The owned held key did not release cleanly in DOM/native polling.'
    $null = Send-HostCommand 'sample-end'
    $After = Get-ProofSnapshot
    $Record.after = $After
    Save-Proof
    if (-not $OutsideTargetSawDown -or -not $FirstHeld -or -not $LastHeld -or
        $LastHeld.Native.polling.samples - $FirstHeld.Native.polling.samples -lt 3 -or
        $LastHeld.Native.polling.lastSampleTickMs -gt $ReleaseTick -or
        $After.Native.polling.epoch -ne $Epoch -or $After.Native.polling.virtualKey -ne $TestVirtualKey -or
        $After.Native.polling.active -or
        $After.Native.polling.errors -ne 0) {
        throw "Held-key window $Name did not observe at least three new native samples during the actual bounded hold."
    }
    if ($ExpectedBlocked) {
        if (-not $DomHeld -or $After.Scene.window.keyDowns -le $Before.Scene.window.keyDowns) {
            throw "Intercepted held key did not reach the transported DOM at $Name."
        }
        if ($After.Native.keyDownMessages -ne $Before.Native.keyDownMessages -or
            $After.Native.keyUpMessages -ne $Before.Native.keyUpMessages -or
            $After.Native.characterMessages -ne $Before.Native.characterMessages -or
            $After.Native.polling.asyncDownSamples -ne 0 -or
            $After.Native.polling.keyStateDownSamples -ne 0 -or
            $After.Native.polling.keyboardStateDownSamples -ne 0) {
            throw "Interception ACK/DOM delivery succeeded but native messages or polling leaked at $Name."
        }
        if ($Case -eq 'primary-paused' -and ($After.Native.rawKeyDownMessages -ne $Before.Native.rawKeyDownMessages -or
            $After.Native.rawKeyUpMessages -ne $Before.Native.rawKeyUpMessages -or $After.Native.rawInputErrors -ne 0)) {
            throw "Intercepted keyboard WM_INPUT leaked to the native game at $Name."
        }
    }
    elseif ($After.Native.keyDownMessages -le $Before.Native.keyDownMessages -or
        $After.Native.characterMessages -le $Before.Native.characterMessages -or
        $After.Native.polling.asyncDownSamples -le 0 -or
        $After.Native.polling.keyStateDownSamples -le 0 -or
        $After.Native.polling.keyboardStateDownSamples -le 0) {
        throw "Released held key did not reach native messages and all three polling APIs at $Name."
    }
    if ($Case -eq 'primary-paused' -and -not $ExpectedBlocked -and
        ($After.Native.rawKeyDownMessages -le $Before.Native.rawKeyDownMessages -or
         $After.Native.rawKeyUpMessages -le $Before.Native.rawKeyUpMessages -or $After.Native.rawInputErrors -ne 0)) {
        throw "Released keyboard WM_INPUT did not reach the native game at $Name."
    }
}

function Capture-Click([string]$Name, [bool]$ExpectedBlocked) {
    Assert-TargetForeground $Name
    $Before = Get-ProofSnapshot
    [EgoSameHwndD3D11ProofInputV1]::Click($TargetWindow, $TargetProcess.Id, 80, 125)
    $After = Wait-Proof { param($Scene, $Native)
        $Native -and $Scene -and (($ExpectedBlocked -and
            $Scene.window.pointerDowns -gt $Before.Scene.window.pointerDowns -and
            $Scene.window.pointerUps -gt $Before.Scene.window.pointerUps) -or
            (-not $ExpectedBlocked -and $Native.pointerDownMessages -gt $Before.Native.pointerDownMessages -and
             $Native.rawPointerDownMessages -gt $Before.Native.rawPointerDownMessages))
    } 5 "Controlled click did not reach its expected owner at $Name."
    if ($ExpectedBlocked -and ($After.Native.pointerDownMessages -ne $Before.Native.pointerDownMessages -or
        $After.Native.rawPointerDownMessages -ne $Before.Native.rawPointerDownMessages)) { throw "Pointer input leaked to the game at $Name." }
    if (-not $ExpectedBlocked -and $After.Scene.window.pointerDowns -ne $Before.Scene.window.pointerDowns) { throw "Released pointer input reached the overlay at $Name." }
    $Proof[$Name] = @{ expectedBlocked = $ExpectedBlocked; before = $Before; after = $After }
    Save-Proof
}

function Assert-WithdrawnPixel {
    Assert-TargetForeground 'pixelAfterProducerDisconnect'
    $Pixel = [EgoSameHwndD3D11ProofInputV1]::Pixel($TargetWindow, 60, 80)
    $Red = [int]($Pixel -band 255); $Green = [int](($Pixel -shr 8) -band 255); $Blue = [int](($Pixel -shr 16) -band 255)
    $Proof.pixelAfterProducerDisconnect = @{ red = $Red; green = $Green; blue = $Blue; source = 'foreground desktop GetPixel' }
    if ([Math]::Abs($Red - 20) -gt 8 -or [Math]::Abs($Green - 31) -gt 8 -or [Math]::Abs($Blue - 51) -gt 8) {
        throw "Disconnected producer pixels remained visible: R=$Red G=$Green B=$Blue"
    }
}

try {
    Save-Proof
    $ProducerArguments = @(
        (Join-Path $SceneFixture 'scene-producer.cjs'), "--sdk-dist=$Sdk", "--stage-directory=$Stage",
        "--evidence-directory=$ProducerEvidence", '--no-sandbox', "--user-data-dir=$(Join-Path $ProducerEvidence 'profile')"
    )
    if ($Case -eq 'primary-paused') { $ProducerArguments += '--allow-window-recreation=true' }
    $ProducerChild = Start-ProofChild $Electron $ProducerArguments $ProducerEvidence 'producer' $false
    $Producer = $ProducerChild.Process
    $null = Wait-Proof { param($Scene, $Native) $Scene -and $Scene.ready } 30 'Private SDK scene producer was not ready.'
    $HostArguments = @(
        '--stage-directory', $Stage, '--reshade', (Join-Path $Stage $RuntimeLeaf),
        '--addon', (Join-Path $Stage $AddonLeaf),
        '--report', $HostReport, '--frames-before-load', '60', '--lifetime-ms', ([string]$LifetimeMs),
        '--case', $Case, '--command-file', $HostCommandFile
    )
    if ($Prototype) { $HostArguments += @('--prototype', '--config', (Join-Path $Stage 'ego-late-d3d11-same-hwnd.ini')) }
    if ($UiBusyMilliseconds -ne 0) { $HostArguments += @('--ui-busy-ms', [string]$UiBusyMilliseconds) }
    $HostChild = Start-ProofChild $HostPath $HostArguments $TargetDirectory 'host' $true
    $TargetProcess = $HostChild.Process
    $Initial = Wait-Proof { param($Scene, $Native)
        $Scene -and $Scene.connectionCount -eq 1 -and $Native -and
        $Native.bootstrapStats.adoptionSuccesses -eq 2 -and $Native.framesAfterLoad -ge 10
    } 30 'The two same-HWND raw chains did not authenticate and adopt after late bootstrap.'
    $TargetWindow = [IntPtr]::new([long]::Parse($Initial.Native.windowHandle))
    if ($Initial.Native.framesBeforeLoad -lt 60 -or $Initial.Native.case -ne $Case -or
        $Initial.Native.lifecycleApplied -or -not $Initial.Native.primaryLive -or
        $Initial.Native.firstAdoptedRole -ne 'primary' -or
        $Initial.Native.firstAdoptedNative -ne $Initial.Native.primarySwapchainNative -or
        -not [EgoSameHwndD3D11ProofInputV1]::OwnsWindow($TargetWindow, $TargetProcess.Id)) {
        throw 'The native same-HWND starting identity/lifecycle contract was not satisfied.'
    }
    if (-not [EgoSameHwndD3D11ProofInputV1]::Foreground($TargetWindow, $TargetProcess.Id)) { throw 'The retained same-HWND target could not obtain foreground.' }
    $Proof.initial = $Initial
    if ($UiBusyMilliseconds -ne 0) {
        if (-not $Initial.Native.uiBusyCompleted -or $Initial.Native.uiBusyRequestedMs -ne $UiBusyMilliseconds -or
            $Initial.Native.uiBusyElapsedMs -lt $UiBusyMilliseconds -or $Initial.Native.uiBusyNativePresentCalls -lt 6 -or
            $Initial.Native.uiBusyAdoptionSuccesses -ne 2 -or $Initial.Native.uiBusyOwnerThreadId -eq 0 -or
            $Initial.Native.uiBusyPresentThreadId -eq $Initial.Native.uiBusyOwnerThreadId) {
            throw 'The controlled UI stall did not prove worker-only first presentations/adoption while its owner stayed busy.'
        }
        $ReadyEvents = @($Initial.Scene.events | Where-Object {
            $_.type -eq 'targetConnected' -or ($_.type -eq 'diagnostic' -and $_.code -eq 'runtime-swapchain-ready')
        })
        if ($ReadyEvents.Count -lt 2 -or @($ReadyEvents | Where-Object { $_.at -lt $Initial.Native.uiBusyEndUnixMs }).Count -ne 0) {
            throw 'Target authentication or input/swapchain readiness was published before the busy UI owner resumed.'
        }
        $Proof.delayedUiStartup = $Initial.Native
    }
    $Proof.privateTcpBeforeLifecycle = Get-PrivateConnectionIdentity $Initial
    Send-SceneCommand 'focus'
    Send-SceneCommand 'release'
    $null = Wait-Proof { param($Scene, $Native) $Scene -and -not $Scene.intercepting } 10 'The initial released state was not acknowledged.'
    if ($UiBusyMilliseconds -ne 0) {
        [EgoSameHwndD3D11ProofInputV1]::Place($TargetWindow, 500, 400)
        Start-Sleep -Milliseconds 100
        $Proof.cursorBaseline = [EgoSameHwndD3D11ProofInputV1]::CursorState()
        $Proof.clipBaseline = [EgoSameHwndD3D11ProofInputV1]::ClipState()
    }
    Assert-RedPixel 'pixelBothLive'
    Capture-HeldKey 'releasedBeforeLifecycle' $false

    $null = Send-HostCommand 'apply-lifecycle'
    $Lifecycle = Wait-Proof { param($Scene, $Native)
        $Native -and $Native.lifecycleApplied -and $Native.secondaryFramesAfterLifecycle -ge 60 -and
        (($Case -eq 'primary-resize' -and $Native.primaryLive -and $Native.bootstrapStats.resizeSuccesses -eq 1) -or
         ($Case -eq 'primary-final-destroy' -and -not $Native.primaryLive -and $Native.bootstrapStats.retirements -eq 1) -or
         ($Case -eq 'primary-paused' -and $Native.primaryPaused -and $Native.primaryLive -and
            $Native.primaryFramesAfterLoad -eq $Native.primaryFramesAtPause -and $Native.bootstrapStats.retirements -eq 0 -and
            $Native.bootstrapStats.resizeSuccesses -eq 0 -and $Native.rawInputRegistered))
    } 15 'The selected primary lifecycle event did not leave a presenting same-HWND survivor.'
    $Proof.lifecycle = $Lifecycle
    if (-not [EgoSameHwndD3D11ProofInputV1]::Foreground($TargetWindow, $TargetProcess.Id)) { throw 'The target lost foreground after its primary lifecycle event.' }
    Assert-RedPixel 'pixelAfterLifecycle'
    if ($Case -eq 'primary-paused') {
        $OldNativeId = $Lifecycle.Scene.window.nativeId
        Send-SceneCommand 'recreate-window'
        $Recreated = Wait-Proof { param($Scene, $Native)
            $Scene -and $Scene.recreationCount -eq 1 -and $Scene.window.nativeId -ne $OldNativeId -and
            $Scene.focusedWindowId -eq 0 -and $Native.registrySnapshotValid -and $Native.registryFocusWindowId -eq 0 -and
            @($Native.registryWindowIds).Count -eq 1 -and $Native.registryWindowIds -contains $Scene.window.nativeId -and
            $Native.registryWindowIds -notcontains $OldNativeId -and @($Native.registryRankWindowIds).Count -eq 1 -and
            $Native.registryRankWindowIds -contains $Scene.window.nativeId -and $Native.registryRankWindowIds -notcontains $OldNativeId -and
            $Native.primaryLive -and $Native.primaryFramesAfterLoad -eq $Native.primaryFramesAtPause
        } 10 'B-only Present did not replace the registration/rank without implicitly focusing the new window.'
        $Proof.recreatedWhilePrimaryPaused = $Recreated
        $Proof.privateTcpAfterNewRegistration = Get-PrivateConnectionIdentity $Recreated
        if ($Proof.privateTcpAfterNewRegistration -ne $Proof.privateTcpBeforeLifecycle) { throw 'Window recreation replaced the authenticated TCP connection.' }
        Assert-RedPixel 'pixelNewRegistrationWhilePrimaryPaused'
    }
    Send-SceneCommand 'clear'
    Send-SceneCommand 'focus'
    Send-SceneCommand 'intercept'
    $null = Wait-Proof { param($Scene, $Native)
        $Scene -and $Scene.intercepting -and $Scene.focusedWindowId -eq $Scene.window.nativeId -and $Scene.window.domInputFocused
    } 10 'The surviving runtime did not acknowledge input focus/interception.'
    if ($UiBusyMilliseconds -ne 0) {
        [EgoSameHwndD3D11ProofInputV1]::Place($TargetWindow, 80, 125)
        $null = Wait-Proof { param($Scene, $Native) [EgoSameHwndD3D11ProofInputV1]::CursorIs(32513) } 8 'Recovered hooks did not show the actual text cursor over the overlay input.'
        $Proof.recoveredTextCursor = [EgoSameHwndD3D11ProofInputV1]::CursorState()
    }
    Capture-HeldKey 'interceptedAfterLifecycle' $true
    if ($Case -eq 'primary-paused') { Capture-Click 'interceptedPointerAfterLifecycle' $true }
    Send-SceneCommand 'release'
    $null = Wait-Proof { param($Scene, $Native) $Scene -and -not $Scene.intercepting } 10 'The surviving runtime did not release interception.'
    Capture-HeldKey 'releasedAfterLifecycle' $false
    if ($Case -eq 'primary-paused') { Capture-Click 'releasedPointerAfterLifecycle' $false }
    if ($UiBusyMilliseconds -ne 0) {
        [EgoSameHwndD3D11ProofInputV1]::Place($TargetWindow, 500, 400)
        $null = Wait-Proof { param($Scene, $Native)
            [EgoSameHwndD3D11ProofInputV1]::CursorState() -eq $Proof.cursorBaseline -and
            [EgoSameHwndD3D11ProofInputV1]::ClipState() -eq $Proof.clipBaseline
        } 8 'Recovered hooks did not restore the game cursor and clipping rectangle after release.'
        $Proof.releasedCursor = [EgoSameHwndD3D11ProofInputV1]::CursorState()
        $Proof.releasedClip = [EgoSameHwndD3D11ProofInputV1]::ClipState()
    }
    $Continuity = Get-ProofSnapshot
    if ($Continuity.Scene.connectionCount -ne 1 -or $Continuity.Scene.authenticationCount -ne 1 -or
        $Continuity.Scene.transportLostCount -ne 0 -or $Continuity.Scene.targetDisconnectedCount -ne 0 -or
        @($Continuity.Scene.window.heldKeys).Count -ne 0) { throw 'Private connection/input continuity was interrupted.' }
    $Proof.continuityBeforeShutdown = $Continuity

    if ($Case -eq 'primary-paused') {
        Send-SceneCommand 'intercept'
        $BeforeDisconnect = Wait-Proof { param($Scene, $Native) $Scene -and $Scene.intercepting } 10 'The paused-primary disconnect setup did not re-enable interception.'
        $Proof.beforeProducerDisconnect = $BeforeDisconnect
    }
    Send-SceneCommand 'exit'
    if (-not $Producer.WaitForExit(10000) -or $Producer.ExitCode -ne 0) { throw 'The private producer did not shut down cleanly.' }
    $ProducerExpectedExited = $true
    if ($Case -eq 'primary-paused') {
        $Withdrawn = Wait-Proof { param($Scene, $Native)
            $Native -and $Native.registrySnapshotValid -and @($Native.registryWindowIds).Count -eq 0 -and
            @($Native.registryRankWindowIds).Count -eq 0 -and $Native.registryFocusWindowId -eq 0 -and
            $Native.primaryLive -and $Native.primaryFramesAfterLoad -eq $Native.primaryFramesAtPause -and
            $Native.secondaryFramesAfterLifecycle -gt ($BeforeDisconnect.Native.secondaryFramesAfterLifecycle + 10)
        } 10 'B-only Present failed to withdraw the disconnected producer registrations, ranks and focus.'
        $Proof.withdrawnAfterProducerDisconnect = $Withdrawn
        Assert-WithdrawnPixel
        Capture-HeldKey 'releasedAfterProducerDisconnect' $false
        Capture-Click 'releasedPointerAfterProducerDisconnect' $false
        $Proof.sameHwndPausedPrimaryLivenessProven = $true
    }
    $null = Send-HostCommand 'finish' -NoWait
    if (-not $TargetProcess.WaitForExit(15000)) { throw 'The same-HWND lifecycle host did not finish cleanly.' }
    $Final = Read-SharedJson $HostReport
    $ExpectedResize = if ($Case -eq 'primary-resize') { 1 } else { 0 }
    if ($TargetProcess.ExitCode -ne 0 -or -not $Final -or $Final.pid -ne $TargetProcess.Id -or
        $Final.status -ne 'passed' -or $Final.case -ne $Case -or $Final.commandSequence -ne $HostSequence -or
        -not $Final.lifecycleApplied -or $Final.bootstrapStats.adoptionSuccesses -ne 2 -or
        $Final.bootstrapStats.retirements -ne 2 -or $Final.bootstrapStats.resizeCalls -ne $ExpectedResize -or
        $Final.bootstrapStats.resizeSuccesses -ne $ExpectedResize -or
        $Final.bootstrapStats.quarantines -ne 0 -or $Final.bootstrapStats.renderFailures -ne 0) {
        throw 'The same-HWND host did not complete its exact adoption/resize/retirement contract.'
    }
    $Proof.hostReport = $Final
    if (-not $Prototype) {
        if ($Final.bootstrapMode -ne 'production-owned' -or $Final.bootstrapAbi -ne 1 -or
            $Final.bootstrapInitializerUsedNullRequest -ne $true -or $Final.bootstrapStats.structSize -ne 104 -or
            $Final.bootstrapStats.abiVersion -ne 1 -or $Final.addonGateObserved -ne 0 -or
            $Final.addonGateClaimed -ne $true -or $Final.addonGateRegistered -ne $true) {
            throw 'The production owned late-D3D11 ABI and initial adapter gate were not established exactly.'
        }
        $Proof.stagedTemplateSha256After = (Get-FileHash -LiteralPath (Join-Path $Stage 'ReShade.ini') -Algorithm SHA256).Hash
        if ($Proof.stagedTemplateSha256After -cne $TemplateHashBefore) { throw 'The production owned runtime changed its staged ReShade.ini template.' }
        $GeneratedConfigs = @(Get-ChildItem -LiteralPath $Stage -File -Recurse -Force |
            Where-Object { $_.Name -match '^ego-late-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}\.ini$' })
        $Proof.finalGeneratedConfigCount = $GeneratedConfigs.Count
        if ($GeneratedConfigs.Count -ne 0) { throw 'Retired production owned runtimes left generated per-chain INIs behind.' }
        $Proof.productionOwnedAbiProven = $true
    }
    if ($UiBusyMilliseconds -ne 0) {
        if (-not $Final.uiBusyCompleted -or $Final.uiBusyNativePresentCalls -lt 6 -or
            $Final.uiBusyAdoptionSuccesses -ne 2) { throw 'Final report lost its controlled busy-UI startup evidence.' }
        $Proof.uiBusyHookRecoveryProven = -not $DiagnosticInputOnly
    }
    $Proof.privateTargetPid = $Initial.Scene.targetPid
    if ($DiagnosticInputOnly) {
        $Proof.diagnosticInputOraclesPassed = $true
        $Proof.status = 'diagnostic'
    }
    else {
        $Proof.sameHwndInputPromotionProven = $true
        $Proof.renderedOverlayPixelsProven = $true
        $Proof.status = 'passed'
    }
}
catch {
    $Proof.status = if ($DiagnosticInputOnly) { 'diagnostic' } else { 'failed' }
    $Proof.failure = $_.Exception.Message
    try {
        $Proof.failureHostSnapshot = Read-SharedJson $HostReport
        $Proof.failureSceneSnapshot = Read-SharedJson $StateFile
    }
    catch { $Proof.failureSnapshotError = $_.Exception.Message }
    throw
}
finally {
    $CleanupFailures = [Collections.Generic.List[string]]::new()
    $Proof.ownedChildExitCodes = @()
    try {
        if ($HeldKeyDown) {
            try { [EgoSameHwndD3D11ProofInputV1]::Up($TestVirtualKey); $HeldKeyDown = $false }
            catch { $CleanupFailures.Add($_.Exception.Message) }
        }
        foreach ($Child in @($TargetProcess, $Producer)) {
            if ($Child) {
                try {
                    $CleanupTerminationRequested = $false
                    if (-not $Child.HasExited) {
                        $CleanupTerminationRequested = $true
                        $Child.Kill($true)
                        if (-not $Child.WaitForExit(5000)) { throw 'An owned proof child did not exit after termination.' }
                    }
                    if ($Child.HasExited) {
                        $Proof.ownedChildExitCodes += [ordered]@{
                            pid = $Child.Id
                            exitCode = $Child.ExitCode
                            cleanupTerminationRequested = $CleanupTerminationRequested
                        }
                    }
                }
                catch { $CleanupFailures.Add($_.Exception.Message) }
            }
        }
        foreach ($Child in @($HostChild, $ProducerChild)) {
            if ($Child) {
                try {
                    foreach ($Log in @(@($Child.Out, 'stdout'), @($Child.Err, 'stderr'))) {
                        try {
                            if (-not $Log[0].Wait(5000)) { throw "Owned child $($Log[1]) pipe did not close." }
                            [IO.File]::WriteAllText((Join-Path $Run ($Child.Name + '.' + $Log[1] + '.log')), $Log[0].GetAwaiter().GetResult(), $Utf8)
                        }
                        catch { $CleanupFailures.Add($_.Exception.Message) }
                    }
                }
                finally { $Child.Process.Dispose() }
            }
        }
    }
    finally {
        if ($CleanupFailures.Count -ne 0) {
            $Proof.status = 'failed'
            $Proof.cleanupFailures = @($CleanupFailures.ToArray())
        }
        Save-Proof
        Write-Output "SAME_HWND_D3D11_EVIDENCE=$EvidenceFile"
    }
}
if ($DiagnosticInputOnly -and $Proof.status -eq 'diagnostic') {
    Write-Host "Same-HWND input diagnostic completed; this is not feature acceptance: $Run"
    return
}
if ($Proof.status -ne 'passed') { throw "Same-HWND proof cleanup failed. Evidence: $EvidenceFile" }
Write-Host "Same-HWND $Case input/polling/lifetime proof passed: $Run"
