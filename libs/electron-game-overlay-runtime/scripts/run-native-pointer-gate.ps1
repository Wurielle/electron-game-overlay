[CmdletBinding()]
param(
    [string]$ElectronExecutable,
    [double]$ScaleFactor = 1,
    [double]$OsrScaleFactor = 0,
    [switch]$Attached,
    [ValidateSet('legacy','wm-input','raw-buffer')][string]$InputMode = 'legacy',
    [ValidateSet('d3d9','d3d10','d3d11','d3d12')][string]$Backend = 'd3d11',
    [ValidateSet('x64','x86')][string]$Architecture = 'x64',
    [switch]$PhysicalKeyboard,
    [switch]$PhysicalFirstKeys,
    [string]$GameExecutable,
    [switch]$FutureTarget,
    [switch]$ProcessPolicy,
    [switch]$BasenameRule,
    [ValidateRange(0,600)][int]$IdleSeconds = 0
)
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
if (-not $ElectronExecutable) { $ElectronExecutable = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' }
$ElectronExecutable = (Resolve-Path -LiteralPath $ElectronExecutable).Path
$Evidence = Join-Path $RepoRoot ('build\native-pointer-' + (Get-Date -Format yyyyMMdd-HHmmss))
New-Item -ItemType Directory -Path $Evidence | Out-Null
$Suffix = if ($Architecture -eq 'x86') { '-x86' } else { '' }
$HostPath = Join-Path $RepoRoot "build\electron-game-overlay-runtime-production$Suffix\RelWithDebInfo\${Backend}_overlay_test_host.exe"
$ScriptPath = Join-Path $RepoRoot 'libs\electron-game-overlay\tests\native-pointer.acceptance.cjs'
$Report = @{ backend=$Backend; architecture=$Architecture; scale=$ScaleFactor; osrScale=$OsrScaleFactor; attached=[bool]$Attached; inputMode=$InputMode; status = 'failed'; inputSource = $(if ($PhysicalKeyboard) { 'human physical keyboard' } elseif ($PhysicalFirstKeys) { 'human physical first-show/reopen keys; Windows SendInput for later gates' } else { 'Windows SendInput virtual keys' }); evidence = $Evidence; clicksSent = 0; checks = @() }
function Read-State([string]$Member) {
    $File = Join-Path $Evidence "$Member-state.json"
    if (-not (Test-Path -LiteralPath $File)) { return $null }
    try { Get-Content -Raw -LiteralPath $File | ConvertFrom-Json } catch { return $null }
}
function Wait-State([string]$Member, [scriptblock]$Predicate, [string]$Label, [int]$Seconds = 30) {
    $Deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        $Current = Read-State $Member
        if ($Current -and $Current.error) { throw $Current.error }
        if ($Current -and $Current.managedFailure -and $Label -eq 'authenticated rendering') { throw $Current.managedFailure }
        if ($ScaleFactor -ne 1 -and $Label -eq 'authenticated rendering' -and
            $Current -and @($Current.events | Where-Object { $_.code -eq 'producer-frame-rejected' }).Count -gt 0) {
            throw 'Fractional-scale OSR frame rejected before input acceptance; inspect Electron stderr for actual and expected raster sizes.'
        }
        if ($Current -and (& $Predicate $Current)) { return $Current }
        Start-Sleep -Milliseconds 40
    }
    throw "Timed out: $Label (member $Member). Inspect $Evidence."
}
$Sequence = 0
function Command([string]$Member, [string]$Action) {
    $script:Sequence++
    $File = Join-Path $Evidence "$Member-command.json"
    $Temporary = "$File.tmp"
    @{ sequence = $script:Sequence; action = $Action } | ConvertTo-Json | Set-Content -LiteralPath $Temporary -Encoding UTF8
    Move-Item -LiteralPath $Temporary -Destination $File -Force
    $Expected = $script:Sequence
    Wait-State $Member { param($s) $s.commandSequence -eq $Expected } $Action | Out-Null
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EgoExplicitFocusKeys {
 [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit, Size=32)] struct UNION { [FieldOffset(0)] public KEYBDINPUT key; }
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
 [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] input, int size);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr pid);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
 [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
 public static bool Activate(IntPtr window) {
  uint current=GetCurrentThreadId(), target=GetWindowThreadProcessId(window,IntPtr.Zero), foreground=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
  bool a=target!=0 && target!=current && AttachThreadInput(current,target,true);
  bool b=foreground!=0 && foreground!=current && foreground!=target && AttachThreadInput(current,foreground,true);
  try { ShowWindow(window,9); BringWindowToTop(window); SetForegroundWindow(window); }
  finally { if(b)AttachThreadInput(current,foreground,false); if(a)AttachThreadInput(current,target,false); }
  return GetForegroundWindow()==window;
 }
 public static void Key(ushort vk) {
  INPUT down = new INPUT { type=1, data=new UNION { key=new KEYBDINPUT { vk=vk } } };
  INPUT up = down; up.data.key.flags = 2;
  if(SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(INPUT)))!=2) throw new Exception("SendInput failed");
 }
}
'@
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EgoPointer {
 [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit,Size=32)] struct UNION { [FieldOffset(0)] public MOUSE mouse; }
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public uint size,flags; public IntPtr cursor; public POINT point; }
 [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO c);
 [DllImport("user32.dll")] static extern IntPtr LoadCursor(IntPtr module,IntPtr id);
 public static string CursorState() { var c=new CURSORINFO{size=(uint)Marshal.SizeOf(typeof(CURSORINFO))};GetCursorInfo(ref c);return c.flags+":"+c.cursor.ToInt64(); }
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 public static string Foreground() { var h=GetForegroundWindow();return h.ToInt64()+":"+Title(h); }
 public static string CursorSnapshot() { var c=new CURSORINFO{size=(uint)Marshal.SizeOf(typeof(CURSORINFO))};GetCursorInfo(ref c);return c.flags+":"+c.cursor.ToInt64()+":xy="+c.point.x+","+c.point.y+":text="+LoadCursor(IntPtr.Zero,new IntPtr(32513)).ToInt64(); }
 public static bool CursorIs(int id) { var c=new CURSORINFO{size=(uint)Marshal.SizeOf(typeof(CURSORINFO))};return GetCursorInfo(ref c) && (id==0 ? c.cursor==IntPtr.Zero : c.flags==1 && c.cursor==LoadCursor(IntPtr.Zero,new IntPtr(id))); }
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h,IntPtr dc);
 [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc,int x,int y);
 public static int DarkColumns(IntPtr h,int x,int y,int width,int height) { var p=new POINT{x=x,y=y};if(!ClientToScreen(h,ref p))return 0;var dc=GetDC(IntPtr.Zero);int columns=0;try{for(int col=0;col<width;col++){bool dark=false;for(int row=0;row<height;row++){uint rgb=GetPixel(dc,p.x+col,p.y+row);if((rgb&255)<100&&((rgb>>8)&255)<100&&((rgb>>16)&255)<100){dark=true;break;}}if(dark)columns++;}}finally{ReleaseDC(IntPtr.Zero,dc);}return columns; }
 public static uint Pixel(IntPtr h,int x,int y) { var p=new POINT{x=x,y=y};if(!ClientToScreen(h,ref p))return 0xFFFFFFFF;var dc=GetDC(IntPtr.Zero);try{return GetPixel(dc,p.x,p.y);}finally{ReleaseDC(IntPtr.Zero,dc);} }
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 public static void Place(IntPtr h,int x,int y) { var p=new POINT{x=x,y=y};if(!ClientToScreen(h,ref p)||!SetCursorPos(p.x,p.y))throw new Exception("Place failed"); }
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 public static string Title(IntPtr h) { var s=new StringBuilder(2048);GetWindowText(h,s,s.Capacity);return s.ToString(); }
 public static void Move(IntPtr h,int x,int y) {
  var p=new POINT{x=x,y=y};if(!ClientToScreen(h,ref p))throw new Exception("ClientToScreen failed");
  int width=GetSystemMetrics(78),height=GetSystemMetrics(79);
  var i=new INPUT{data=new UNION{mouse=new MOUSE{x=(int)Math.Round((p.x-GetSystemMetrics(76))*65535.0/(width-1)),y=(int)Math.Round((p.y-GetSystemMetrics(77))*65535.0/(height-1)),flags=0xC001}}};
  if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("Move failed");
 }
 public static void Wheel(int delta,bool horizontal) { var i=new INPUT{data=new UNION{mouse=new MOUSE{data=unchecked((uint)delta),flags=horizontal?0x1000u:0x800u}}};if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("Wheel failed"); }
}
'@
function Move-OverlayPointer([int]$X, [int]$Y) {
    $PhysicalX=[int][Math]::Round($X*$Ready.scaleFactor)
    $PhysicalY=[int][Math]::Round($Y*$Ready.scaleFactor)
    if ($InputMode -eq 'legacy') { [EgoPointer]::Place($Target.MainWindowHandle,$PhysicalX,$PhysicalY) }
    else { [EgoPointer]::Move($Target.MainWindowHandle,$PhysicalX,$PhysicalY) }
}
function Type-Key([string]$Key, [string]$Member, [string]$Expected) {
    Wait-State $Member { param($s) $s.intercepting -and $s.nativeFocusedWindowId -eq $s.windowId } 'native keyboard owner' | Out-Null
    $HumanKey = $PhysicalKeyboard -or ($PhysicalFirstKeys -and $Key -in @('a','b'))
    if ($HumanKey) {
        if ($Key -in @('a','b')) { Command $Member "prompt-$Key" }
        Write-Host "Tap lowercase '$Key' once, then release, without clicking. Use Alt+Tab to return to the game if needed."
    }
    else { [EgoExplicitFocusKeys]::Key([uint16][char]$Key.ToUpperInvariant()) }
    $State = Wait-State $Member { param($s) if ($s.value.Length -gt $Expected.Length) { throw "External input contaminated the fixture: '$($s.value)' (expected '$Expected')" }; $s.value -ceq $Expected -and @($s.heldKeys).Count -eq 0 } "key $Key released / expected $Expected" $(if ($HumanKey) { 180 } else { 60 })
    if($ProcessPolicy){
        Wait-State $Member {param($s) [EgoPointer]::DarkColumns($Target.MainWindowHandle,[int][Math]::Round(45*$Ready.scaleFactor),[int][Math]::Round(75*$Ready.scaleFactor),[int][Math]::Round(13*$Ready.scaleFactor),[int][Math]::Round(17*$Ready.scaleFactor)) -ge 4} 'visible native typed glyph' 8 | Out-Null
        $Report.checks += "native composited glyph for $Key"
    }
    if ($State.pointerDowns -ne 0) { throw 'A pointer-down invalidated the no-click test.' }
    $Report.checks += "$Member=$Expected without pointer-down"
}
function Assert-DroppedKey([string]$Key, [string]$Expected) {
    if ($PhysicalKeyboard) { Write-Host "Type lowercase '$Key' now; the overlay must not receive it."; Start-Sleep -Seconds 8 }
    else { [EgoExplicitFocusKeys]::Key([uint16][char]$Key.ToUpperInvariant()); Start-Sleep -Milliseconds 350 }
    if ((Read-State a).value -cne $Expected) { throw "Key $Key escaped its input gate" }
    $Report.checks += "key $Key blocked"
}
$Client = $null
$PriorPipe = $env:ELECTRON_GAME_OVERLAY_BROKER_PIPE
$env:ELECTRON_GAME_OVERLAY_BROKER_PIPE = '\\.\pipe\ego-native-focus-' + [guid]::NewGuid().ToString('N')
try {
    $Arguments = @('"' + $ScriptPath + '"', '"--evidence=' + $Evidence + '"', '"--host=' + $HostPath + '"')
    if ($GameExecutable) { $Arguments += '"--game=' + (Resolve-Path -LiteralPath $GameExecutable).Path + '"' }
    if ($FutureTarget) { $Arguments += '--future=true' }
    if ($ProcessPolicy) {$Arguments += '--policy=true'}
    if ($BasenameRule) {$Arguments += '--basename-rule=true'}
    $Arguments += '--idle-ms=' + ($IdleSeconds * 1000)
    $Arguments = @("--force-device-scale-factor=$ScaleFactor","--input-mode=$InputMode") + $Arguments
    if ($OsrScaleFactor -gt 0) {$Arguments += "--osr-scale=$OsrScaleFactor"}
    if ($Attached) {$Arguments += '--attached=true'}
    $Client = Start-Process -FilePath $ElectronExecutable -ArgumentList $Arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Evidence 'stdout.txt') -RedirectStandardError (Join-Path $Evidence 'stderr.txt')
    if (-not $GameExecutable) {
        # A cached native provider can own injection. Waiting for the app's
        # injector-returned event would deadlock behind this fixture's barrier.
        $Started = Wait-State a { param($s) $s.targetPid -gt 0 } 'owned target PID' ($IdleSeconds + 100)
        $BarrierDeadline = [DateTime]::UtcNow.AddSeconds(100)
        do {
            if (-not (Test-Path -LiteralPath (Join-Path $Evidence 'target\electron-game-overlay-startup-barrier.enabled'))) { break }
            $OwnedTarget = Get-Process -Id $Started.targetPid
            $RuntimeModule = @($OwnedTarget.Modules | Where-Object { $_.ModuleName -eq $(if ($Architecture -eq 'x86') { 'ReShade32.dll' } else { 'ReShade64.dll' }) }) | Select-Object -First 1
            if ($RuntimeModule) {
                $InjectorLog = Join-Path ([IO.Path]::GetDirectoryName($RuntimeModule.FileName)) 'inject.stdout.log'
                if ((Test-Path -LiteralPath $InjectorLog) -and (Get-Content -Raw -LiteralPath $InjectorLog) -match 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT') {
                    Remove-Item -LiteralPath (Join-Path $Evidence 'target\electron-game-overlay-startup-barrier.enabled') -Force -ErrorAction SilentlyContinue
                    break
                }
            }
            Start-Sleep -Milliseconds 40
        } while ([DateTime]::UtcNow -lt $BarrierDeadline)
    }
    $Ready = Wait-State a { param($s) $s.attached -and $s.rendering } 'authenticated rendering' ($IdleSeconds + 120)
    $Target = Get-Process -Id $Ready.targetPid
    $Deadline = [DateTime]::UtcNow.AddSeconds(15)
    do { $Target.Refresh(); if ($Target.MainWindowHandle -ne 0) { break }; Start-Sleep -Milliseconds 40 } while ([DateTime]::UtcNow -lt $Deadline)
    if (-not [EgoExplicitFocusKeys]::Activate($Target.MainWindowHandle)) { throw 'Could not foreground the owned acceptance target.' }
    Wait-State a { param($s) $s.intercepting } 'foreground interception' | Out-Null
    if (@($Ready.events | Where-Object { $_.code -eq 'runtime-input-routing-failed' -and $_.context.errorCode -eq -4 }).Count -gt 0) {
        throw 'Native input/cursor initialization failed; inspect the owned ReShade log before evaluating scaling.'
    }

    $MappedAddon = @($Target.Modules | Where-Object {$_.ModuleName -like 'electron_game_overlay.addon*'}) | Select-Object -First 1
    if ($MappedAddon) {
        $Report.mappedAddonPath = $MappedAddon.FileName
        $Report.mappedAddonSha256 = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($MappedAddon.FileName)))).Replace('-','').ToLowerInvariant()
    }

    foreach ($PixelCase in @(@(480,100,0x3539e5),@(540,100,0xe5881e))) {
        $PixelX = [int][Math]::Round($PixelCase[0]*$Ready.scaleFactor)
        $PixelY = [int][Math]::Round($PixelCase[1]*$Ready.scaleFactor)
        Wait-State a {param($s) [EgoPointer]::Pixel($Target.MainWindowHandle,$PixelX,$PixelY) -eq $PixelCase[2]} 'native composited calibration pixel' 30 | Out-Null
    }
    $Report.checks += 'actual native red/blue calibration pixels at scaled CSS coordinates'
    Command a release
    Wait-State a { param($s) -not $s.intercepting } 'initial cursor ownership release' | Out-Null
    Move-OverlayPointer 760 440
    Start-Sleep -Milliseconds 250
    $GameCursorBaseline = [EgoPointer]::CursorState()
    Command a intercept
    Wait-State a { param($s) $s.intercepting } 'interception restored' | Out-Null
    Command a focus
    Type-Key a a a
    foreach ($CursorCase in @(@(60,85,32513,'text'),@(290,85,32649,'hand'),@(400,85,32644,'ew-resize'))) {
        Move-OverlayPointer $CursorCase[0] $CursorCase[1]
        $ExpectedCursor = [int]$CursorCase[2]
        Wait-State a { param($s) $s.cursor -eq $CursorCase[3] -and [EgoPointer]::CursorIs($ExpectedCursor) } "visible cursor $($CursorCase[3])" 8 | Out-Null
        $Report.checks += "actual Windows cursor $($CursorCase[3])"
    }
    Move-OverlayPointer 760 440
    Wait-State a { param($s) [EgoPointer]::CursorState() -eq $GameCursorBaseline } 'game cursor outside overlay' 8 | Out-Null
    Move-OverlayPointer 290 85
    Wait-State a { param($s) [EgoPointer]::CursorIs(32649) } 'overlay cursor on reentry' 8 | Out-Null
    $Report.checks += 'game/overlay cursor transitions follow pointer hit-test'
    $BaselineTitle = [EgoPointer]::Title($Target.MainWindowHandle)
    Move-OverlayPointer 80 170
    Start-Sleep -Milliseconds 400
    [EgoPointer]::Wheel(-120, $false)
    $Vertical = Wait-State a { param($s) $s.inner.y -gt 0 } 'nested vertical scrolling' 8
    $Report.checks += 'native vertical wheel scrolls nested overflow content'
    if ($Vertical.wheels[-1].x -ne 60 -or $Vertical.wheels[-1].y -ne 110) { throw 'Wheel coordinates did not localize and scale into the nested scroller' }
    if ($Vertical.outer.y -ne 0) { throw 'Nested wheel unexpectedly scrolled the outer container' }
    $Report.vertical = $Vertical
    [EgoPointer]::Wheel(120, $true)
    $Horizontal = Wait-State a { param($s) $s.inner.x -gt 0 } 'nested horizontal scrolling' 8
    $Report.checks += 'native horizontal wheel scrolls nested overflow content'
    $Report.horizontal = $Horizontal
    if ([EgoPointer]::Title($Target.MainWindowHandle) -ne $BaselineTitle) { throw 'Game input oracle changed while intercepted' }
    [EgoPointer]::Wheel(120, $false)
    Wait-State a { param($s) $s.inner.y -eq 0 } 'reverse vertical scrolling' 8 | Out-Null
    [EgoPointer]::Wheel(-120, $true)
    Wait-State a { param($s) $s.inner.x -eq 0 } 'reverse horizontal scrolling' 8 | Out-Null
    [EgoPointer]::Wheel(-30, $false)
    Wait-State a { param($s) $s.inner.y -gt 0 -and $s.inner.y -lt 120 } 'partial wheel delta' 8 | Out-Null
    Move-OverlayPointer 470 360
    Start-Sleep -Milliseconds 250
    [EgoPointer]::Wheel(-120,$false)
    Wait-State a { param($s) $s.outer.y -gt 0 } 'outer overflow scrolling' 8 | Out-Null
    $Report.checks += 'both directions, partial deltas, nested and outer overflow scroll'
    Command a hide
    Command a clear
    Command a show
    Command a focus
    Type-Key b a b
    Move-OverlayPointer 290 85
    Wait-State a { param($s) [EgoPointer]::CursorIs(32649) } 'cursor after reopen' 8 | Out-Null
    Command a release
    Wait-State a { param($s) -not $s.intercepting } 'released input' | Out-Null
    Wait-State a { param($s) [EgoPointer]::CursorState() -eq $GameCursorBaseline } 'game cursor restored' 8 | Out-Null
    $ReleasedBaseline = [EgoPointer]::Title($Target.MainWindowHandle)
    [EgoPointer]::Wheel(-120,$false)
    Wait-State a { param($s) [EgoPointer]::Title($Target.MainWindowHandle) -ne $ReleasedBaseline } 'game wheel after release' 8 | Out-Null
    $Report.checks += 'reopen preserves no-click typing; release restores game cursor and wheel'
    if($ProcessPolicy){
        if(-not (Read-State a).noStartupBarrier){throw 'Fast policy case unexpectedly enabled a startup barrier'}
        $Report.checks += 'fast host used no injection-wait marker or artificial startup barrier'
        Command a policy-add-redundant
        if(-not (Read-State a).addedRedundantPreserved){throw 'Adding redundant allow cancelled the native target'}
        Command a policy-redundant
        if(-not (Read-State a).redundantTargetPreserved){throw 'Removing redundant allow cancelled the authorized native target'}
        Command a clear;Command a focus;Command a intercept
        Type-Key c a c
        $Report.checks += 'removing redundant specific allow preserved the real overlay and immediate no-click typing'
        $OldPid=(Read-State a).targetPid
        Command a policy-relaunch
        $Ready=Wait-State a {param($s)$s.attached -and $s.rendering -and $s.targetPid -ne $OldPid} 'fresh policy relaunch' 30
        $Target=Get-Process -Id $Ready.targetPid
        if(-not [EgoExplicitFocusKeys]::Activate($Target.MainWindowHandle)){throw 'Could not foreground relaunched owned host'}
        Command a clear;Command a show;Command a focus;Command a intercept
        Type-Key d a d
        $Report.checks += 'fresh no-barrier game relaunch authenticated and accepted its first key without a click'
        Command a probe
        $ProbeHandle=[IntPtr]::new([long](Read-State a).probeHwnd)
        if(-not [EgoExplicitFocusKeys]::Activate($ProbeHandle)){throw 'Could not foreground the owned negative-control probe'}
        Start-Sleep -Milliseconds 250
        $ProbePrefix=$ProbeHandle.ToInt64().ToString()+':'
        if(-not [EgoPointer]::Foreground().StartsWith($ProbePrefix)){throw 'Owned probe lost foreground before negative-control key'}
        [EgoExplicitFocusKeys]::Key(90)
        Start-Sleep -Milliseconds 250
        if(-not [EgoPointer]::Foreground().StartsWith($ProbePrefix)){throw 'Owned probe lost foreground during negative-control key'}
        if((Read-State a).value -cne 'd'){throw 'Foreground negative control delivered text to overlay'}
        Command a close-probe
        [EgoExplicitFocusKeys]::Activate($Target.MainWindowHandle)|Out-Null
        Command a policy-revoke
        if(-not (Read-State a).revokedSynchronously){throw 'Genuine authorization removal was not synchronous'}
        Start-Sleep -Milliseconds 400
        $GameBeforeRevokeKey=[EgoPointer]::Title($Target.MainWindowHandle)
        [EgoExplicitFocusKeys]::Key(69)
        Start-Sleep -Milliseconds 250
        if((Read-State a).value -cne 'd'){throw 'A revoked target still routed keyboard input to the overlay'}
        Wait-State a {param($s)[EgoPointer]::Title($Target.MainWindowHandle) -ne $GameBeforeRevokeKey} 'revoked input returned to game' 8 | Out-Null
        Wait-State a {param($s)[EgoPointer]::Pixel($Target.MainWindowHandle,[int][Math]::Round(480*$Ready.scaleFactor),[int][Math]::Round(100*$Ready.scaleFactor)) -ne 0x3539e5} 'revoked overlay pixels removed' 8 | Out-Null
        $Report.checks += 'genuine revoke disabled overlay input; foreground negative control passed'
        $Final=Read-State a
        if(@($Final.managedEvents|Where-Object{$_.pid -in @($Final.helperPid,$Final.baselinePid) -and $_.type -eq 'connected'}).Count){throw 'Denied helper or baseline target was attached'}
        if($Final.managedFailure){throw $Final.managedFailure}
        foreach($NegativePid in @($Final.helperPid,$Final.baselinePid,$Final.outsidePid)){
            $Negative=Get-Process -Id $NegativePid
            if(@($Negative.Modules|Where-Object{$_.ModuleName -match '^ReShade(32|64)\.dll$|^electron_game_overlay\.addon'}).Count){throw 'Native policy mutated a denied/baseline/outside target'}
        }
        $Report.managed=$Final.managedEvents
        $Report.checks += 'native deny excluded the explicit crash-helper control and pre-existing baseline'
    }
    $Report.status = 'passed'
    $Report.electron = $Ready.electron
    $Report.paint = $Ready.paint
    $Report.a = Read-State a
} catch { $Report.error = $_.Exception.Message; try {Command a capture} catch {}; $Report.cursorSnapshot = [EgoPointer]::CursorSnapshot(); $Report.foreground = [EgoPointer]::Foreground();
    if ($Target) {
        $Report.targetHandle = $Target.MainWindowHandle.ToInt64();
        $Report.nativePixels = @([EgoPointer]::Pixel($Target.MainWindowHandle,[int][Math]::Round(480*$ScaleFactor),[int][Math]::Round(100*$ScaleFactor)),[EgoPointer]::Pixel($Target.MainWindowHandle,[int][Math]::Round(540*$ScaleFactor),[int][Math]::Round(100*$ScaleFactor)))
    }; throw }
finally {
    if ($Client -and -not $Client.HasExited) {
        try { Command a exit; $Client.WaitForExit(5000) | Out-Null } catch { try { $Client.Refresh(); if (-not $Client.HasExited) { $Client.Kill() } } catch {} }
    }
    $env:ELECTRON_GAME_OVERLAY_BROKER_PIPE = $PriorPipe
    $Report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $Evidence 'report.json') -Encoding UTF8
    Write-Host "Pointer evidence: $Evidence"
}
