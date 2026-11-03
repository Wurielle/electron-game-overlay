#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$AddonPath,
    [ValidateSet('x64','Win32')][string]$Architecture = 'x64',
    [string]$DetoursSourceDirectory,
    [string]$SdkDist,
    [string]$ElectronPath,
    [switch]$GpuReadback,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$BuildRoot = Join-Path $RepoRoot 'build\early-reshade-bootstrap'
$Compile = Join-Path $BuildRoot "compile-$Architecture"
$Fixture = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\early-reshade-bootstrap'
$ProducerFixture = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\late-d3d11-adoption\scene-producer.cjs'
if (-not $DetoursSourceDirectory) { $DetoursSourceDirectory = Join-Path $RepoRoot 'build\early-process-bootstrap-deps\Detours-v4.0.1' }
if (-not $SdkDist) { $SdkDist = Join-Path $RepoRoot 'libs\electron-game-overlay\dist' }
if (-not $ElectronPath) { $ElectronPath = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' }
$Runtime = (Resolve-Path -LiteralPath $RuntimePath).Path
$Addon = (Resolve-Path -LiteralPath $AddonPath).Path
$Sdk = (Resolve-Path -LiteralPath $SdkDist).Path
$Electron = (Resolve-Path -LiteralPath $ElectronPath).Path
$DetoursSourceDirectory = (Resolve-Path -LiteralPath $DetoursSourceDirectory).Path
$DependencyLock = Get-Content -LiteralPath (Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\early-process-bootstrap\detours-source-lock.json') -Raw | ConvertFrom-Json
foreach ($Dependency in $DependencyLock.files) {
    $Body = [IO.File]::ReadAllText((Join-Path $DetoursSourceDirectory $Dependency.path)).Replace("`r`n","`n")
    $Digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Body))).ToLowerInvariant()
    if ($Digest -cne $Dependency.lfSha256) { throw "Official Detours source identity mismatch: $($Dependency.path)" }
}
if (-not $SkipBuild) {
    & cmake -S $Fixture -B $Compile -G 'Visual Studio 17 2022' -A $Architecture "-DDETOURS_SOURCE_DIR=$DetoursSourceDirectory"
    if ($LASTEXITCODE -ne 0) { throw 'First-import ReShade proof configure failed.' }
    & cmake --build $Compile --config Release
    if ($LASTEXITCODE -ne 0) { throw 'First-import ReShade proof build failed.' }
}
$BuiltHost = Join-Path $Compile 'Release\early_reshade_bootstrap_host.exe'
foreach ($File in @($BuiltHost, (Join-Path $Sdk 'index.js'), $ProducerFixture)) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Required proof file is missing: $File" }
}
$Run = Join-Path $BuildRoot ('overlay-proof-' + $Architecture + '-' + [Guid]::NewGuid().ToString('N'))
$Stage = Join-Path $Run 'stage'
$ProducerEvidence = Join-Path $Run 'producer'
New-Item -ItemType Directory -Path $Stage,$ProducerEvidence | Out-Null
$RuntimeLeaf = if ($Architecture -eq 'x64') { 'ReShade64.dll' } else { 'ReShade32.dll' }
$AddonLeaf = if ($Architecture -eq 'x64') { 'electron_game_overlay.addon64' } else { 'electron_game_overlay.addon32' }
$RestoreLeaf = if ($Architecture -eq 'x64') { 'early_reshade_restore64.dll' } else { 'early_reshade_restore32.dll' }
$HostPath = Join-Path $Stage 'early_reshade_bootstrap_host.exe'
$LauncherPath = Join-Path $Stage 'early_reshade_bootstrap_launcher.exe'
$StagedAssets = @()
$Copies = @(@($Runtime,(Join-Path $Stage $RuntimeLeaf)), @($Addon,(Join-Path $Stage $AddonLeaf)))
foreach ($Leaf in @('early_reshade_bootstrap_host.exe','early_reshade_bootstrap_launcher.exe','early_original_graphics.dll',$RestoreLeaf)) {
    $Copies += ,@((Join-Path $Compile "Release\$Leaf"),(Join-Path $Stage $Leaf))
}
foreach ($Copy in $Copies) {
    Copy-Item -LiteralPath $Copy[0] -Destination $Copy[1]
    $Hash = (Get-FileHash -LiteralPath $Copy[0]).Hash
    if ($Hash -cne (Get-FileHash -LiteralPath $Copy[1]).Hash) { throw 'Proof staging changed file bytes.' }
    $StagedAssets += [ordered]@{ source=[IO.Path]::GetFullPath($Copy[0]); path=[IO.Path]::GetFullPath($Copy[1]); sha256=$Hash }
}
Copy-Item -LiteralPath (Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\config\ReShade.ini') -Destination (Join-Path $Stage 'ReShade.ini')
Copy-Item -LiteralPath (Join-Path $DetoursSourceDirectory 'LICENSE.md') -Destination (Join-Path $Stage 'LICENSE.Detours.md')
[IO.File]::WriteAllText((Join-Path $Stage 'owned-run.txt'),"EGO_EARLY_RESHADE_BOOTSTRAP_V1`n",[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $Stage 'trace.ndjson'),'', [Text.UTF8Encoding]::new($false))
. (Join-Path $PSScriptRoot 'owned-stage-marker.ps1')
. (Join-Path $PSScriptRoot 'late-d3d11-child-environment.ps1')
. (Join-Path $PSScriptRoot 'visual-test-display-lease.ps1')
Write-OwnedOverlayRunMarker -RunDirectory $Stage -BuildRoot $BuildRoot
if ($GpuReadback) {
    # Opt-in diagnostic request only; acceptance still requires actual target
    # desktop pixels. The second/third points are outside this one red scene.
    'EGO_GPU_READBACK_V1 60 80 350 80 750 500 8 500' |
        Set-Content -LiteralPath (Join-Path $Stage 'electron-game-overlay-gpu-pixels-v1.request') -Encoding ascii
}
$HostReport = Join-Path $Stage 'host-report.json'
$StateFile = Join-Path $ProducerEvidence 'scene-state.json'
$CommandFile = Join-Path $ProducerEvidence 'scene-command.json'
$TargetProcess = $null
$LauncherProcess = $null
$Producer = $null
$LauncherChild = $null
$ProducerChild = $null
$VisualDisplayLease = $null
$Sequence = 0
$Proof = [ordered]@{
    schemaVersion=1; fixture='first-import-owned-reshade-d3d12-overlay'; architecture=$Architecture; status='failed'
    automaticDiscoveryProven=$false; inputSource='Windows SendInput virtual keys and pointer'
    productionActivation=$false; lateAttachmentProven=$false; reshadeForkUsed=$false
    sceneProducerRole='Unchanged public SDK producer reused from late-d3d11-adoption; it does not bootstrap or inject.'
    gpuReadbackRequested=[bool]$GpuReadback
    runtimeSha256=(Get-FileHash -LiteralPath $Runtime).Hash; addonSha256=(Get-FileHash -LiteralPath $Addon).Hash
    hostSha256=(Get-FileHash -LiteralPath $BuiltHost).Hash
    hostSourceSha256=(Get-FileHash -LiteralPath (Join-Path $Fixture 'host.cpp')).Hash
    sdkEntrySha256=(Get-FileHash -LiteralPath (Join-Path $Sdk 'index.js')).Hash
    stagedAssets=$StagedAssets
    detoursCommit=$DependencyLock.commit; detoursSourceVerified=$true
    checkedFeatures=@('red overlay pixels','keyboard text','pointer down/up','interception/release','real resize','private transport continuity')
    nativeSourceAssets=@(Get-ChildItem -LiteralPath $Fixture -File | Sort-Object Name | ForEach-Object {
        [ordered]@{ leaf=$_.Name; sha256=(Get-FileHash -LiteralPath $_.FullName).Hash }
    })
    sharedProducerSha256=(Get-FileHash -LiteralPath $ProducerFixture).Hash
}

function Read-SharedJson([string]$File) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $null }
    $Stream = $null; $Reader = $null
    try {
        $Stream = [IO.FileStream]::new($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $Reader = [IO.StreamReader]::new($Stream)
        return $Reader.ReadToEnd() | ConvertFrom-Json
    } finally {
        if ($Reader) { $Reader.Dispose() } elseif ($Stream) { $Stream.Dispose() }
    }
}
function Wait-Proof([scriptblock]$Predicate, [int]$Seconds, [string]$Failure) {
    $Deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        if ($Producer -and $Producer.HasExited) { throw "Scene producer exited: $Failure" }
        if ($LauncherProcess -and $LauncherProcess.HasExited) { throw "Owned native launcher exited before assertion: $Failure" }
        $State = Read-SharedJson $StateFile
        $HostState = Read-SharedJson $HostReport
        if ($TargetProcess -and $HostState -and ($HostState.pid -ne $TargetProcess.Id -or $HostState.creationTime100ns -cne $Proof.targetCreationTime100ns)) { throw 'The native host report identifies a different process instance.' }
        if ($TargetProcess -and $State -and $null -ne $State.targetPid -and $State.targetPid -ne $TargetProcess.Id) { throw 'The private route authenticated a different process.' }
        if ($State -and $State.error) { throw "Scene producer fault: $($State.error)" }
        if ($HostState -and $HostState.status -eq 'failed') { throw "Native host fault: $($HostState.failure)" }
        if (& $Predicate $State $HostState) { return }
        if ($TargetProcess -and $TargetProcess.HasExited) { throw "Owned target exited before assertion: $Failure" }
        Start-Sleep -Milliseconds 40
    }
    throw $Failure
}
function Bind-OwnedNativeTarget([object]$HostState) {
    $Journal = Read-SharedJson (Join-Path $Stage 'launcher-result.json')
    if (-not $Journal -or $Journal.pid -ne $HostState.pid -or
        $Journal.creationTime100ns -cne $HostState.creationTime100ns -or
        $Journal.identityVerified -ne $true -or $Journal.ownedChildJobBound -ne $true) {
        throw 'Native launcher/host process-instance identities are not verified.'
    }
    $Expected = [IO.Path]::GetFullPath($HostPath)
    foreach ($ReportedPath in @($Journal.targetPath,$HostState.exactImagePath)) {
        if (-not [string]::Equals([IO.Path]::GetFullPath($ReportedPath),$Expected,[StringComparison]::OrdinalIgnoreCase)) {
            throw 'Native report does not identify the fixed owned staged target.'
        }
    }
    $Candidate = [Diagnostics.Process]::GetProcessById([int]$HostState.pid)
    try {
        # Force a retained OS handle; no later action reopens an arbitrary PID.
        $null = $Candidate.Handle
        if ($Candidate.HasExited -or
            -not [string]::Equals([IO.Path]::GetFullPath($Candidate.Path),$Expected,[StringComparison]::OrdinalIgnoreCase) -or
            $Candidate.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -cne $HostState.creationTime100ns) {
            throw 'Read-only OS identity does not match the native retained target.'
        }
        $Proof.targetCreationTime100ns = $HostState.creationTime100ns
        return $Candidate
    } catch { $Candidate.Dispose(); throw }
}
function Assert-MappedOwnedModules {
    $TargetProcess.Refresh()
    $Modules = @($TargetProcess.Modules)
    $ExpectedModules = @(
        @{ leaf=$RuntimeLeaf; path=(Join-Path $Stage $RuntimeLeaf); sha256=$Proof.runtimeSha256 },
        @{ leaf=$AddonLeaf; path=(Join-Path $Stage $AddonLeaf); sha256=$Proof.addonSha256 }
    )
    $Mapped = @()
    foreach ($Expected in $ExpectedModules) {
        $Matches = @($Modules | Where-Object { $_.ModuleName.Equals($Expected.leaf,[StringComparison]::OrdinalIgnoreCase) })
        if ($Matches.Count -ne 1 -or
            -not [string]::Equals([IO.Path]::GetFullPath($Matches[0].FileName),[IO.Path]::GetFullPath($Expected.path),[StringComparison]::OrdinalIgnoreCase)) {
            throw "Expected one exact owned mapped module: $($Expected.leaf)"
        }
        $Hash = (Get-FileHash -LiteralPath $Matches[0].FileName).Hash
        if ($Hash -cne $Expected.sha256) { throw "Mapped module file identity changed: $($Expected.leaf)" }
        $Mapped += [ordered]@{ leaf=$Expected.leaf; path=$Matches[0].FileName; sha256=$Hash; baseAddress=$Matches[0].BaseAddress.ToInt64().ToString() }
    }
    $Proof.mappedOwnedModules = $Mapped
}
function Send-SceneCommand([string]$Action) {
    $script:Sequence++
    $Temporary = $CommandFile + '.tmp'
    [IO.File]::WriteAllText($Temporary,(@{ sequence=$Sequence; action=$Action } | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    [IO.File]::Move($Temporary,$CommandFile,$true)
    if ($Action -ne 'exit') { Wait-Proof { param($State,$HostState) $State -and $State.commandSequence -eq $Sequence } 10 "Scene command was not acknowledged: $Action" }
}
function Start-ProofChild([string]$File,[string[]]$Arguments,[string]$Directory,[string]$LogName,[bool]$Visible) {
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName=$File; $Info.WorkingDirectory=$Directory; $Info.UseShellExecute=$false
    $Info.CreateNoWindow=-not $Visible
    if (-not $Visible) { $Info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden }
    $Info.RedirectStandardOutput=$true; $Info.RedirectStandardError=$true
    foreach ($Argument in $Arguments) { $Info.ArgumentList.Add($Argument) }
    foreach ($Name in @($Info.Environment.Keys)) {
        if ($Name.Equals('ELECTRON_RUN_AS_NODE',[StringComparison]::OrdinalIgnoreCase) -or
            $Name.Equals('RESHADE_BASE_PATH_OVERRIDE',[StringComparison]::OrdinalIgnoreCase) -or
            $Name.StartsWith('RESHADE_DISABLE_',[StringComparison]::OrdinalIgnoreCase) -or
            $Name.StartsWith('ELECTRON_GAME_OVERLAY',[StringComparison]::OrdinalIgnoreCase) -or
            $Name.StartsWith('EGO_',[StringComparison]::OrdinalIgnoreCase)) { $Info.Environment.Remove($Name) | Out-Null }
    }
    if ([string]::Equals($File,$LauncherPath,[StringComparison]::OrdinalIgnoreCase)) {
        $ChildEnvironment = Set-LateD3D11OwnedStageChildEnvironment -StartInfo $Info -StageDirectory $Stage -FixtureRoot $BuildRoot
        $Proof.childOwnedBasePath = $ChildEnvironment.stageDirectory
    }
    $Child=[Diagnostics.Process]::new(); $Child.StartInfo=$Info
    if (-not $Child.Start()) { throw "Could not start owned proof child: $File" }
    return [pscustomobject]@{ Process=$Child; Out=$Child.StandardOutput.ReadToEndAsync(); Err=$Child.StandardError.ReadToEndAsync(); Name=$LogName }
}
if (-not ('EgoEarlyReShadeProofInput' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EgoEarlyReShadeProofInput {
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
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
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h,IntPtr dc);
 [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc,int x,int y);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
 [DllImport("user32.dll",SetLastError=true)] static extern bool PostMessageW(IntPtr h,uint message,UIntPtr wparam,IntPtr lparam);
 public static bool OwnsWindow(IntPtr h,int expectedPid) { uint pid;return GetWindowOwner(h,out pid)!=0&&pid==(uint)expectedPid; }
 public static bool Foreground(IntPtr h,int expectedPid) {
  if(!OwnsWindow(h,expectedPid))return false;
  uint current=GetCurrentThreadId(), target=GetWindowThreadProcessId(h,IntPtr.Zero), prior=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
  bool a=target!=0&&target!=current&&AttachThreadInput(current,target,true);
  bool b=prior!=0&&prior!=current&&prior!=target&&AttachThreadInput(current,prior,true);
  try { ShowWindow(h,9); BringWindowToTop(h); SetForegroundWindow(h); }
  finally { if(b)AttachThreadInput(current,prior,false);if(a)AttachThreadInput(current,target,false); }
  return GetForegroundWindow()==h;
 }
 public static uint Pixel(IntPtr h,int x,int y) {
  var point=new POINT{x=x,y=y};if(!ClientToScreen(h,ref point))throw new Exception("ClientToScreen failed");
  var dc=GetDC(IntPtr.Zero);if(dc==IntPtr.Zero)throw new Exception("GetDC failed");
  try{return GetPixel(dc,point.x,point.y);}finally{ReleaseDC(IntPtr.Zero,dc);}
 }
 public static void Key(IntPtr h,int expectedPid,ushort vk) {
  if(!OwnsWindow(h,expectedPid)||GetForegroundWindow()!=h)throw new Exception("Target identity/foreground lost before key input");
  var down=new INPUT{type=1,data=new UNION{key=new KEY{vk=vk}}};
  var up=new INPUT{type=1,data=new UNION{key=new KEY{vk=vk,flags=2}}};
  if(SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception("SendInput keyboard failed");
 }
 public static void Click(IntPtr h,int expectedPid,int x,int y) {
  if(!OwnsWindow(h,expectedPid)||GetForegroundWindow()!=h)throw new Exception("Target identity/foreground lost before pointer input");
  var point=new POINT{x=x,y=y};if(!ClientToScreen(h,ref point)||!SetCursorPos(point.x,point.y))throw new Exception("Pointer positioning failed");
  var down=new INPUT{data=new UNION{mouse=new MOUSE{flags=2}}};
  var up=new INPUT{data=new UNION{mouse=new MOUSE{flags=4}}};
  if(SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception("SendInput pointer failed");
 }
 public static void CloseOwned(IntPtr h,int expectedPid) {
  if(!OwnsWindow(h,expectedPid))throw new Exception("Target identity lost before owned close");
  if(!PostMessageW(h,0x0010,UIntPtr.Zero,IntPtr.Zero))throw new Exception("Owned WM_CLOSE failed");
 }
}
'@
}
function Assert-RedPixel([IntPtr]$Window,[string]$Name) {
    if (-not [EgoEarlyReShadeProofInput]::OwnsWindow($Window,$TargetProcess.Id) -or [EgoEarlyReShadeProofInput]::GetForegroundWindow() -ne $Window) { throw 'Target identity/foreground lost before pixel sampling.' }
    $Pixel=[EgoEarlyReShadeProofInput]::Pixel($Window,60,80)
    $R=[int]($Pixel -band 255); $G=[int](($Pixel -shr 8) -band 255); $B=[int](($Pixel -shr 16) -band 255)
    $Proof[$Name]=@{ clientX=60; clientY=80; red=$R; green=$G; blue=$B; expected='#c62828'; source='foreground desktop GetPixel'; tickMs=[Environment]::TickCount64; utc=[DateTime]::UtcNow.ToString('O'); hwnd=$Window.ToInt64(); targetPid=$TargetProcess.Id }
    $Proof[$Name].rawColorRef = ('0x{0:X8}' -f $Pixel)
    if ($Pixel -eq [uint32]::MaxValue) { throw "Foreground pixel sampling failed at $Name (CLR_INVALID); no target pixel proof." }
    if ([Math]::Abs($R-198) -gt 8 -or [Math]::Abs($G-40) -gt 8 -or [Math]::Abs($B-40) -gt 8) { throw "Transported red pixel missing at $Name`: R=$R G=$G B=$B" }
}
try {
    $VisualDisplayLease = Enter-VisualTestDisplayLease $Proof
    $ProducerChild=Start-ProofChild $Electron @($ProducerFixture,"--sdk-dist=$Sdk","--stage-directory=$Stage","--evidence-directory=$ProducerEvidence",'--no-sandbox',"--user-data-dir=$(Join-Path $ProducerEvidence 'profile')") $ProducerEvidence 'producer' $false
    $Producer=$ProducerChild.Process
    Wait-Proof { param($State,$HostState) $State -and $State.ready } 30 'Private SDK scene producer was not ready.'
    $LauncherChild=Start-ProofChild $LauncherPath @() $Stage 'launcher' $false
    $LauncherProcess=$LauncherChild.Process
    Wait-Proof { param($State,$HostState) $State -and $State.connectionCount -ge 1 -and $HostState -and $HostState.nativePresentSuccesses -ge 10 } 30 'First-import ReShade did not authenticate and present the private scene.'
    $Initial=Read-SharedJson $StateFile; $InitialHost=Read-SharedJson $HostReport
    $TargetProcess=Bind-OwnedNativeTarget $InitialHost
    $Window=[IntPtr]::new([long]::Parse($InitialHost.windowHandle))
    if ($InitialHost.pid -ne $TargetProcess.Id -or $Initial.targetPid -ne $TargetProcess.Id -or
        -not [EgoEarlyReShadeProofInput]::OwnsWindow($Window,$TargetProcess.Id)) { throw 'Initial target/report/window identities do not match the retained child.' }
    if ($InitialHost.graphicsInitializationPhase -cne 'exe-crt-before-main' -or
        $InitialHost.preMainInitializerReturned -ne $true -or
        $InitialHost.originalDllAttachEntered -ne $true -or $InitialHost.originalDllAttachReturned -ne $true -or
        $InitialHost.reshadePresentBeforeCrt -ne $true -or $InitialHost.reshadeFromStageBeforeCrt -ne $true -or
        $InitialHost.reshadeExportsValidBeforeCrt -ne $true -or $InitialHost.restoreStateVerified -ne $true -or
        $InitialHost.reshadeModuleCountBeforeCrt -ne 1 -or $InitialHost.reshadeModuleEnumerationCompleteBeforeCrt -ne $true -or
        $InitialHost.initializerDeviceHr -cne '0x00000000' -or $InitialHost.initializerQueueHr -cne '0x00000000' -or
        $InitialHost.queueDeviceIdentityMatches -ne $true) { throw 'Native first-import/pre-main graphics evidence is incomplete.' }
    if ($InitialHost.resizeSuccesses -ne 0) { throw 'Initial overlay assertions must precede the controlled real resize.' }
    Assert-MappedOwnedModules
    if (-not [EgoEarlyReShadeProofInput]::Foreground($Window,$TargetProcess.Id)) { throw 'Controlled host could not obtain foreground.' }
    Send-SceneCommand 'focus'; Send-SceneCommand 'intercept'
    Wait-Proof { param($State,$HostState) $State -and $State.intercepting -and $State.focusedWindowId -eq $State.window.nativeId } 10 'Native focus/interception did not acknowledge.'
    Assert-RedPixel $Window 'pixelBeforeResize'
    $NativeBeforeInput=Read-SharedJson $HostReport
    [EgoEarlyReShadeProofInput]::Key($Window,$TargetProcess.Id,0x41); [EgoEarlyReShadeProofInput]::Key($Window,$TargetProcess.Id,0x5A)
    Wait-Proof { param($State,$HostState) $State -and $State.window.value -eq 'az' -and $State.window.keyDowns -ge 2 } 10 'Real foreground virtual keys did not reach the transported DOM input.'
    [EgoEarlyReShadeProofInput]::Click($Window,$TargetProcess.Id,90,125)
    Wait-Proof { param($State,$HostState) $State -and $State.window.pointerDowns -ge 1 -and $State.window.pointerUps -ge 1 } 10 'Real foreground pointer input did not reach the transported DOM.'
    Wait-Proof { param($State,$HostState) $HostState -and $HostState.nativePresentSuccesses -ge ($NativeBeforeInput.nativePresentSuccesses+15) } 5 'Native input suppression report did not refresh.'
    $NativeAfterInput=Read-SharedJson $HostReport
    if ($NativeAfterInput.keyDownMessages -ne $NativeBeforeInput.keyDownMessages -or
        $NativeAfterInput.characterMessages -ne $NativeBeforeInput.characterMessages -or
        $NativeAfterInput.pointerDownMessages -ne $NativeBeforeInput.pointerDownMessages) { throw 'Intercepted input leaked into the native host.' }
    $Proof.interceptedNativeCountersUnchanged=$true
    $BeforeResize=Read-SharedJson $StateFile
    $ResizeRequest=Join-Path $Stage 'host-resize.request'
    $ResizeTemporary=Join-Path $Stage ('host-resize.request.tmp-'+[Guid]::NewGuid().ToString('N'))
    $ResizeBytes=[Text.Encoding]::ASCII.GetBytes("EGO_EARLY_RESHADE_RESIZE_V1`n")
    $ResizeFile=[IO.File]::Open($ResizeTemporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $ResizeFile.Write($ResizeBytes,0,$ResizeBytes.Length); $ResizeFile.Flush($true) } finally { $ResizeFile.Dispose() }
    [IO.File]::Move($ResizeTemporary,$ResizeRequest,$false)
    Wait-Proof { param($State,$HostState) $HostState -and $HostState.resizeSuccesses -eq 1 -and $HostState.framesAfterResize -ge 60 } 25 'The first-import ReShade runtime did not survive a real resize.'
    if (-not [EgoEarlyReShadeProofInput]::Foreground($Window,$TargetProcess.Id)) { throw 'Controlled host lost foreground after resize.' }
    Send-SceneCommand 'clear'; Send-SceneCommand 'focus'; Send-SceneCommand 'intercept'
    Wait-Proof { param($State,$HostState) $State -and $State.intercepting } 10 'Post-resize interception did not acknowledge.'
    Assert-RedPixel $Window 'pixelAfterResize'
    [EgoEarlyReShadeProofInput]::Key($Window,$TargetProcess.Id,0x42)
    Wait-Proof { param($State,$HostState) $State -and $State.window.value -eq 'b' } 10 'Post-resize key did not reach the transported DOM.'
    $AfterResize=Read-SharedJson $StateFile
    Assert-MappedOwnedModules
    Send-SceneCommand 'release'
    Wait-Proof { param($State,$HostState) $State -and -not $State.intercepting } 10 'Input interception did not release.'
    $BeforeReleaseKey=Read-SharedJson $HostReport
    [EgoEarlyReShadeProofInput]::Key($Window,$TargetProcess.Id,0x43)
    Wait-Proof { param($State,$HostState) $HostState -and $HostState.keyDownMessages -gt $BeforeReleaseKey.keyDownMessages } 10 'Released keyboard input did not reach the native host.'
    Send-SceneCommand 'exit'
    if (-not $Producer.WaitForExit(10000) -or $Producer.ExitCode -ne 0) { throw 'Private producer did not shut down cleanly.' }
    [EgoEarlyReShadeProofInput]::CloseOwned($Window,$TargetProcess.Id)
    if (-not $TargetProcess.WaitForExit(20000)) { throw 'Owned first-import host did not finish after WM_CLOSE.' }
    if (-not $LauncherProcess.WaitForExit(20000) -or $LauncherProcess.ExitCode -ne 0) { throw 'Owned first-import launcher did not finish cleanly.' }
    $FinalHost=Read-SharedJson $HostReport
    $FinalLauncher=Read-SharedJson (Join-Path $Stage 'launcher-result.json')
    if ($TargetProcess.ExitCode -ne 0 -or $FinalHost.status -ne 'passed' -or
        $FinalHost.resizeSuccesses -ne 1 -or $FinalHost.framesAfterResize -lt 60 -or
        $FinalHost.nativePresentSuccesses -lt 60 -or $FinalHost.cleanupCompleted -ne $true -or
        $FinalHost.windowDestroyed -ne $true -or $FinalHost.closeRequested -ne $true) { throw 'Native first-import graphics lifecycle did not pass clean shutdown.' }
    if (-not $FinalLauncher -or $FinalLauncher.passed -ne $true -or $FinalLauncher.phase -cne 'complete' -or
        $FinalLauncher.pid -ne $TargetProcess.Id -or $FinalLauncher.creationTime100ns -cne $Proof.targetCreationTime100ns -or
        $FinalLauncher.identityVerified -ne $true -or $FinalLauncher.ownedChildJobBound -ne $true -or
        $FinalLauncher.createProcessCalls -ne 1 -or $FinalLauncher.helperCreationRejected -ne $false -or
        $FinalLauncher.childExitCode -ne 0 -or $FinalLauncher.errorCode -ne 0 -or
        $FinalLauncher.timedOut -ne $false -or $FinalLauncher.terminatedOwnedChild -ne $false -or
        $FinalLauncher.loadsReShade -ne $true -or $FinalLauncher.productionActivation -ne $false -or
        $FinalLauncher.firstImportDllCount -ne 2 -or $FinalLauncher.ordinal1Rva -le 0 -or
        [string]::IsNullOrEmpty($FinalLauncher.ordinal1Name) -or $FinalLauncher.restoreOrdinal1Validated -ne $true -or
        $FinalLauncher.ansiPathsRoundTripVerified -ne $true) {
        throw 'Native first-import launcher identity, ownership or bounded-lifecycle evidence failed.'
    }
    & node (Join-Path $Fixture 'validate-sdk-proof.cjs') $Stage
    if ($LASTEXITCODE -ne 0) { throw 'Native first-import/restore trace validation failed.' }
    $Proof.nativeValidation=Read-SharedJson (Join-Path $Stage 'native-proof-validation.json')
    foreach ($Asset in $StagedAssets) {
        if ((Get-FileHash -LiteralPath $Asset.path).Hash -cne $Asset.sha256) { throw "Owned proof binary changed during execution: $($Asset.path)" }
    }
    $Proof.status='passed'; $Proof.renderedOverlayPixelsProven=$true; $Proof.syntheticForegroundInputProven=$true
    $Proof.hostReport=$FinalHost; $Proof.launcherReport=$FinalLauncher; $Proof.sceneBeforeResize=$BeforeResize; $Proof.sceneAfterResize=$AfterResize
    $Proof.loadsReShade=$true; $Proof.graphicsInitializationPhase='exe-crt-before-main'
    $Proof.automaticReShadeRuntimeProven=$true; $Proof.manualRuntimeApiUsed=$false
    $Proof.privateTargetPid=$Initial.targetPid
    if ($Initial.targetPid -ne $TargetProcess.Id) { throw 'Private route authenticated a different target.' }
    if ($Initial.connectionCount -ne 1 -or $AfterResize.connectionCount -ne 1) { throw 'Resize replaced the private authenticated connection.' }
    if ($AfterResize.authenticationCount -ne 1 -or $AfterResize.transportLostCount -ne 0 -or
        $AfterResize.targetDisconnectedCount -ne 0) { throw 'Private authentication continuity was interrupted.' }
} catch {
    $Proof.status='failed'; $Proof.failure=$_.Exception.Message
    throw
} finally {
    $CleanupFailures=[Collections.Generic.List[string]]::new()
    try {
        # Closing the exact retained launcher closes its private kill-on-close
        # job. The fixed controlled target is never rediscovered by basename.
        foreach ($Child in @($LauncherProcess,$Producer)) {
            if ($Child) {
                try {
                    if (-not $Child.HasExited) {
                        $Child.Kill($true)
                        if (-not $Child.WaitForExit(5000)) { throw 'Owned child did not exit after termination.' }
                    }
                } catch { $CleanupFailures.Add($_.Exception.Message) }
            }
        }
        if ($TargetProcess) {
            try { if (-not $TargetProcess.HasExited -and -not $TargetProcess.WaitForExit(5000)) { throw 'Native owned target survived launcher-job cleanup.' } }
            catch { $CleanupFailures.Add($_.Exception.Message) }
            finally { $TargetProcess.Dispose() }
        }
        foreach ($Child in @($LauncherChild,$ProducerChild)) {
            if ($Child) {
                try {
                    foreach ($Log in @(@($Child.Out,'stdout'),@($Child.Err,'stderr'))) {
                        try {
                            if (-not $Log[0].Wait(5000)) { throw "Owned child $($Log[1]) pipe did not close." }
                            [IO.File]::WriteAllText((Join-Path $Run ($Child.Name+'.'+$Log[1]+'.log')),$Log[0].GetAwaiter().GetResult())
                        } catch { $CleanupFailures.Add($_.Exception.Message) }
                    }
                } finally { $Child.Process.Dispose() }
            }
        }
    } finally {
        Exit-VisualTestDisplayLease $VisualDisplayLease $Proof
        if ($VisualDisplayLease -and
            ($Proof.displayPrecondition.cleanupError -or $Proof.displayPrecondition.clearSucceeded -ne $true -or
             $Proof.displayPrecondition.closeSucceeded -ne $true)) {
            $CleanupFailures.Add('The temporary display request did not report successful clear/close cleanup.')
        }
        if ($CleanupFailures.Count -ne 0) { $Proof.status='failed'; $Proof.cleanupFailures=@($CleanupFailures.ToArray()) }
        $NativeLog=Join-Path $Stage 'ReShade.log'
        if ($GpuReadback -and (Test-Path -LiteralPath $NativeLog -PathType Leaf)) {
            try { $Proof.gpuDiagnosticLines=@([IO.File]::ReadAllLines($NativeLog) | Where-Object { $_.Contains('EGO_GPU_PIXELS_V1') }) }
            catch { $Proof.gpuDiagnosticReadFailure=$_.Exception.Message }
        }
        $Proof | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $Run 'evidence.json') -Encoding utf8
    }
}
if ($Proof.status -ne 'passed') { throw "First-import ReShade overlay proof cleanup failed. Evidence: $Run" }
Write-Host "First-import owned ReShade D3D12 overlay proof passed (not watcher or game acceptance): $Run"
