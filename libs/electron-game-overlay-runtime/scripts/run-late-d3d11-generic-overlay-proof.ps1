#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$AddonPath,
    [ValidateSet('x64','Win32')][string]$Architecture = 'x64',
    [string]$SdkDist,
    [string]$ElectronPath,
    [ValidateRange(20000,120000)][int]$LifetimeMs = 30000,
    [switch]$GpuReadback,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$BuildRoot = Join-Path $RepoRoot 'build\late-d3d11-adoption'
$Compile = Join-Path $BuildRoot "generic-compile-$Architecture"
$Fixture = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\late-d3d11-adoption'
$Prototype = Join-Path $Fixture 'owned-host-prototype'
$Include = Join-Path $RepoRoot 'build\electron-game-overlay-runtime\_deps\reshade-src\include'
if (-not $SdkDist) { $SdkDist = Join-Path $RepoRoot 'libs\electron-game-overlay\dist' }
if (-not $ElectronPath) { $ElectronPath = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' }
$Runtime = (Resolve-Path -LiteralPath $RuntimePath).Path
$Addon = (Resolve-Path -LiteralPath $AddonPath).Path
$Sdk = (Resolve-Path -LiteralPath $SdkDist).Path
$Electron = (Resolve-Path -LiteralPath $ElectronPath).Path
if (-not $SkipBuild) {
    & cmake -S $Prototype -B $Compile -G 'Visual Studio 17 2022' -A $Architecture "-DRESHADE_INCLUDE_DIR=$Include"
    if ($LASTEXITCODE -ne 0) { throw 'Late D3D11 proof host configure failed.' }
    & cmake --build $Compile --config Release
    if ($LASTEXITCODE -ne 0) { throw 'Late D3D11 proof host build failed.' }
}
$BuiltHost = Join-Path $Compile 'Release\late_d3d11_generic_adoption_host.exe'
foreach ($File in @($BuiltHost, (Join-Path $Sdk 'index.js'), (Join-Path $Fixture 'scene-producer.cjs'))) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Required proof file is missing: $File" }
}
$Run = Join-Path $BuildRoot ('generic-overlay-proof-' + $Architecture + '-' + [Guid]::NewGuid().ToString('N'))
$Stage = Join-Path $Run 'stage'
$TargetDirectory = Join-Path $Run 'target'
$ProducerEvidence = Join-Path $Run 'producer'
New-Item -ItemType Directory -Path $Stage,$TargetDirectory,$ProducerEvidence | Out-Null
$RuntimeLeaf = if ($Architecture -eq 'x64') { 'ReShade64.dll' } else { 'ReShade32.dll' }
$AddonLeaf = if ($Architecture -eq 'x64') { 'electron_game_overlay.addon64' } else { 'electron_game_overlay.addon32' }
$HostPath = Join-Path $TargetDirectory 'late_d3d11_generic_adoption_host.exe'
foreach ($Copy in @(@($Runtime,(Join-Path $Stage $RuntimeLeaf)), @($Addon,(Join-Path $Stage $AddonLeaf)), @($BuiltHost,$HostPath))) {
    Copy-Item -LiteralPath $Copy[0] -Destination $Copy[1]
    if ((Get-FileHash -LiteralPath $Copy[0]).Hash -ne (Get-FileHash -LiteralPath $Copy[1]).Hash) { throw 'Proof staging changed file bytes.' }
}
Copy-Item -LiteralPath (Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\config\ReShade.ini') -Destination (Join-Path $Stage 'ReShade.ini')
[IO.File]::WriteAllText((Join-Path $Stage 'ego-owned-late-d3d11-prototype.marker'), "EGO_OWNED_LATE_D3D11_PROTOTYPE_V1`n", [Text.Encoding]::ASCII)
. (Join-Path $PSScriptRoot 'owned-stage-marker.ps1')
. (Join-Path $PSScriptRoot 'late-d3d11-child-environment.ps1')
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
$Producer = $null
$HostChild = $null
$ProducerChild = $null
$Sequence = 0
$Proof = [ordered]@{
    schemaVersion=1; fixture='owned-host-generic-late-d3d11-overlay'; architecture=$Architecture; status='failed'
    automaticDiscoveryProven=$false; inputSource='Windows SendInput virtual keys and pointer'
    nativeSwapchainDiscoveryProven=$false; automaticProcessAttachmentProven=$false
    gpuReadbackRequested=[bool]$GpuReadback
    runtimeSha256=(Get-FileHash -LiteralPath $Runtime).Hash; addonSha256=(Get-FileHash -LiteralPath $Addon).Hash
    hostSha256=(Get-FileHash -LiteralPath $BuiltHost).Hash
    hostSourceSha256=(Get-FileHash -LiteralPath (Join-Path $Prototype 'generic_host.cpp')).Hash
    sdkEntrySha256=(Get-FileHash -LiteralPath (Join-Path $Sdk 'index.js')).Hash
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
        $State = Read-SharedJson $StateFile
        $HostState = Read-SharedJson $HostReport
        if ($TargetProcess -and $HostState -and $HostState.pid -ne $TargetProcess.Id) { throw 'The manual host report identifies a different process.' }
        if ($TargetProcess -and $State -and $null -ne $State.targetPid -and $State.targetPid -ne $TargetProcess.Id) { throw 'The private route authenticated a different process.' }
        if ($State -and $State.error) { throw "Scene producer fault: $($State.error)" }
        if ($HostState -and $HostState.status -eq 'failed') { throw "Manual host fault: $($HostState.failure)" }
        if (& $Predicate $State $HostState) { return }
        if ($TargetProcess -and $TargetProcess.HasExited) { throw "Manual host exited before assertion: $Failure" }
        Start-Sleep -Milliseconds 40
    }
    throw $Failure
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
    foreach ($Name in @('RESHADE_BASE_PATH_OVERRIDE','RESHADE_DISABLE_GRAPHICS_HOOK','RESHADE_DISABLE_INPUT_HOOK','RESHADE_DISABLE_LOGGING','ELECTRON_GAME_OVERLAY_RUN_DIRECTORY','ELECTRON_RUN_AS_NODE')) { $Info.Environment.Remove($Name) | Out-Null }
    if ($Visible) {
        $ChildEnvironment = Set-LateD3D11OwnedStageChildEnvironment -StartInfo $Info -StageDirectory $Stage -FixtureRoot $BuildRoot
        $Proof.childOwnedBasePath = $ChildEnvironment.stageDirectory
    }
    $Child=[Diagnostics.Process]::new(); $Child.StartInfo=$Info
    if (-not $Child.Start()) { throw "Could not start owned proof child: $File" }
    return [pscustomobject]@{ Process=$Child; Out=$Child.StandardOutput.ReadToEndAsync(); Err=$Child.StandardError.ReadToEndAsync(); Name=$LogName }
}
if (-not ('EgoLateD3D11ProofInput' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EgoLateD3D11ProofInput {
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
}
'@
}
function Assert-RedPixel([IntPtr]$Window,[string]$Name) {
    if (-not [EgoLateD3D11ProofInput]::OwnsWindow($Window,$TargetProcess.Id) -or [EgoLateD3D11ProofInput]::GetForegroundWindow() -ne $Window) { throw 'Target identity/foreground lost before pixel sampling.' }
    $Pixel=[EgoLateD3D11ProofInput]::Pixel($Window,60,80)
    $R=[int]($Pixel -band 255); $G=[int](($Pixel -shr 8) -band 255); $B=[int](($Pixel -shr 16) -band 255)
    $Proof[$Name]=@{ clientX=60; clientY=80; red=$R; green=$G; blue=$B; expected='#c62828'; source='foreground desktop GetPixel'; tickMs=[Environment]::TickCount64; utc=[DateTime]::UtcNow.ToString('O'); hwnd=$Window.ToInt64(); targetPid=$TargetProcess.Id }
    if ([Math]::Abs($R-198) -gt 8 -or [Math]::Abs($G-40) -gt 8 -or [Math]::Abs($B-40) -gt 8) { throw "Transported red pixel missing at $Name`: R=$R G=$G B=$B" }
}
try {
    $ProducerChild=Start-ProofChild $Electron @((Join-Path $Fixture 'scene-producer.cjs'),"--sdk-dist=$Sdk","--stage-directory=$Stage","--evidence-directory=$ProducerEvidence",'--no-sandbox',"--user-data-dir=$(Join-Path $ProducerEvidence 'profile')") $ProducerEvidence 'producer' $false
    $Producer=$ProducerChild.Process
    Wait-Proof { param($State,$HostState) $State -and $State.ready } 30 'Private SDK scene producer was not ready.'
    $HostChild=Start-ProofChild $HostPath @('--stage-directory',$Stage,'--reshade',(Join-Path $Stage $RuntimeLeaf),'--addon',(Join-Path $Stage $AddonLeaf),'--config',(Join-Path $Stage 'ego-late-d3d11-controlled.ini'),'--report',$HostReport,'--frames-before-load','60','--resize-after-frames','600','--lifetime-ms',([string]$LifetimeMs)) $TargetDirectory 'host' $true
    $TargetProcess=$HostChild.Process
    Wait-Proof { param($State,$HostState) $State -and $State.connectionCount -ge 1 -and $HostState -and $HostState.framesAfterLoad -ge 10 } 30 'Manual runtime did not authenticate and present the private scene.'
    $Initial=Read-SharedJson $StateFile; $InitialHost=Read-SharedJson $HostReport
    $Window=[IntPtr]::new([long]::Parse($InitialHost.windowHandle))
    if ($InitialHost.pid -ne $TargetProcess.Id -or $Initial.targetPid -ne $TargetProcess.Id -or
        -not [EgoLateD3D11ProofInput]::OwnsWindow($Window,$TargetProcess.Id)) { throw 'Initial target/report/window identities do not match the retained child.' }
    if ($InitialHost.framesBeforeLoad -lt 60) { throw 'Manual runtime loaded before60 real native Presents.' }
    if (-not [EgoLateD3D11ProofInput]::Foreground($Window,$TargetProcess.Id)) { throw 'Controlled host could not obtain foreground.' }
    Send-SceneCommand 'focus'; Send-SceneCommand 'intercept'
    Wait-Proof { param($State,$HostState) $State -and $State.intercepting -and $State.focusedWindowId -eq $State.window.nativeId } 10 'Native focus/interception did not acknowledge.'
    Assert-RedPixel $Window 'pixelBeforeResize'
    $NativeBeforeInput=Read-SharedJson $HostReport
    [EgoLateD3D11ProofInput]::Key($Window,$TargetProcess.Id,0x41); [EgoLateD3D11ProofInput]::Key($Window,$TargetProcess.Id,0x5A)
    Wait-Proof { param($State,$HostState) $State -and $State.window.value -eq 'az' -and $State.window.keyDowns -ge 2 } 10 'Real foreground virtual keys did not reach the transported DOM input.'
    [EgoLateD3D11ProofInput]::Click($Window,$TargetProcess.Id,90,125)
    Wait-Proof { param($State,$HostState) $State -and $State.window.pointerDowns -ge 1 -and $State.window.pointerUps -ge 1 } 10 'Real foreground pointer input did not reach the transported DOM.'
    Wait-Proof { param($State,$HostState) $HostState -and $HostState.elapsedMs -ge ($NativeBeforeInput.elapsedMs+1200) } 5 'Native input suppression report did not refresh.'
    $NativeAfterInput=Read-SharedJson $HostReport
    if ($NativeAfterInput.keyDownMessages -ne $NativeBeforeInput.keyDownMessages -or
        $NativeAfterInput.characterMessages -ne $NativeBeforeInput.characterMessages -or
        $NativeAfterInput.pointerDownMessages -ne $NativeBeforeInput.pointerDownMessages) { throw 'Intercepted input leaked into the native host.' }
    $Proof.interceptedNativeCountersUnchanged=$true
    $BeforeResize=Read-SharedJson $StateFile
    Wait-Proof { param($State,$HostState) $HostState -and $HostState.resizeSuccesses -ge 1 -and $HostState.framesAfterResize -ge 60 } 25 'The manual runtime did not survive a real resize.'
    if (-not [EgoLateD3D11ProofInput]::Foreground($Window,$TargetProcess.Id)) { throw 'Controlled host lost foreground after resize.' }
    Send-SceneCommand 'clear'; Send-SceneCommand 'focus'; Send-SceneCommand 'intercept'
    Wait-Proof { param($State,$HostState) $State -and $State.intercepting } 10 'Post-resize interception did not acknowledge.'
    Assert-RedPixel $Window 'pixelAfterResize'
    [EgoLateD3D11ProofInput]::Key($Window,$TargetProcess.Id,0x42)
    Wait-Proof { param($State,$HostState) $State -and $State.window.value -eq 'b' } 10 'Post-resize key did not reach the transported DOM.'
    $AfterResize=Read-SharedJson $StateFile
    Send-SceneCommand 'release'
    Wait-Proof { param($State,$HostState) $State -and -not $State.intercepting } 10 'Input interception did not release.'
    $BeforeReleaseKey=Read-SharedJson $HostReport
    [EgoLateD3D11ProofInput]::Key($Window,$TargetProcess.Id,0x43)
    Wait-Proof { param($State,$HostState) $HostState -and $HostState.keyDownMessages -gt $BeforeReleaseKey.keyDownMessages } 10 'Released keyboard input did not reach the native host.'
    Send-SceneCommand 'exit'
    if (-not $Producer.WaitForExit(10000) -or $Producer.ExitCode -ne 0) { throw 'Private producer did not shut down cleanly.' }
    if (-not $TargetProcess.WaitForExit(90000)) { throw 'Manual lifecycle host did not finish.' }
    $FinalHost=Read-SharedJson $HostReport
    if ($TargetProcess.ExitCode -ne 0 -or $FinalHost.status -ne 'passed') { throw 'Manual runtime lifecycle did not pass clean shutdown/state restoration.' }
    if (-not $FinalHost.nativeSwapchainDiscoveryProven -or
        $FinalHost.graphicsPointersSuppliedToBootstrap -ne $false) { throw 'The isolated generic bootstrap did not establish native swapchain discovery without pointer handoff.' }
    $Proof.status='passed'; $Proof.renderedOverlayPixelsProven=$true; $Proof.syntheticForegroundInputProven=$true
    $Proof.nativeSwapchainDiscoveryProven=$FinalHost.nativeSwapchainDiscoveryProven; $Proof.hostReport=$FinalHost; $Proof.sceneBeforeResize=$BeforeResize; $Proof.sceneAfterResize=$AfterResize
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
        foreach ($Child in @($TargetProcess,$Producer)) {
            if ($Child) {
                try {
                    if (-not $Child.HasExited) {
                        $Child.Kill($true)
                        if (-not $Child.WaitForExit(5000)) { throw 'Owned child did not exit after termination.' }
                    }
                } catch { $CleanupFailures.Add($_.Exception.Message) }
            }
        }
        foreach ($Child in @($HostChild,$ProducerChild)) {
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
        if ($CleanupFailures.Count -ne 0) { $Proof.status='failed'; $Proof.cleanupFailures=@($CleanupFailures.ToArray()) }
        $NativeLog=Join-Path $Stage 'ReShade.log'
        if ($GpuReadback -and (Test-Path -LiteralPath $NativeLog -PathType Leaf)) {
            try { $Proof.gpuDiagnosticLines=@([IO.File]::ReadAllLines($NativeLog) | Where-Object { $_.Contains('EGO_GPU_PIXELS_V1') }) }
            catch { $Proof.gpuDiagnosticReadFailure=$_.Exception.Message }
        }
        $Proof | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $Run 'evidence.json') -Encoding utf8
    }
}
if ($Proof.status -ne 'passed') { throw "Host-assisted late D3D11 proof cleanup failed. Evidence: $Run" }
Write-Host "Host-assisted late D3D11 overlay proof passed: $Run"
