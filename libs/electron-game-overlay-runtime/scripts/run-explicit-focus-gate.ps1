[CmdletBinding()]
param(
    [string]$ElectronExecutable,
    [switch]$PhysicalKeyboard,
    [string]$GameExecutable,
    [switch]$FutureTarget,
    [ValidateRange(0,600)][int]$IdleSeconds = 0
)
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
if (-not $ElectronExecutable) { $ElectronExecutable = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' }
$ElectronExecutable = (Resolve-Path -LiteralPath $ElectronExecutable).Path
$Evidence = Join-Path $RepoRoot ('build\explicit-focus-' + (Get-Date -Format yyyyMMdd-HHmmss))
New-Item -ItemType Directory -Path $Evidence | Out-Null
$HostPath = Join-Path $RepoRoot 'build\electron-game-overlay-runtime-production\RelWithDebInfo\d3d11_overlay_test_host.exe'
$ScriptPath = Join-Path $RepoRoot 'libs\electron-game-overlay\tests\native-focus.acceptance.cjs'
$Report = @{ status = 'failed'; inputSource = $(if ($PhysicalKeyboard) { 'human physical keyboard' } else { 'Windows SendInput virtual keys' }); evidence = $Evidence; clicksSent = 0; checks = @() }
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
function Type-Key([string]$Key, [string]$Member, [string]$Expected) {
    if ($PhysicalKeyboard) { Write-Host "Type lowercase '$Key' in the foreground game, without clicking." }
    else { [EgoExplicitFocusKeys]::Key([uint16][char]$Key.ToUpperInvariant()) }
    $State = Wait-State $Member { param($s) $s.value -ceq $Expected } "key $Key / expected $Expected" 60
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
    $Arguments += '--idle-ms=' + ($IdleSeconds * 1000)
    $Client = Start-Process -FilePath $ElectronExecutable -ArgumentList $Arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Evidence 'stdout.txt') -RedirectStandardError (Join-Path $Evidence 'stderr.txt')
    if (-not $GameExecutable) {
        # A cached native provider can own injection. Waiting for the app's
        # injector-returned event would deadlock behind this fixture's barrier.
        $Started = Wait-State a { param($s) $s.targetPid -gt 0 } 'owned target PID' ($IdleSeconds + 100)
        $BarrierDeadline = [DateTime]::UtcNow.AddSeconds(100)
        do {
            $OwnedTarget = Get-Process -Id $Started.targetPid
            $RuntimeModule = @($OwnedTarget.Modules | Where-Object { $_.ModuleName -eq 'ReShade64.dll' }) | Select-Object -First 1
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
    if (-not $GameExecutable -and -not $FutureTarget) { Wait-State b { param($s) $s.attached } 'independent app B' | Out-Null }
    Command a focus
    Type-Key a a a
    Command a hide
    Command a clear
    Command a show
    Command a focus
    Type-Key b a b
    $Expected = 'b'
    if (-not $GameExecutable -and -not $FutureTarget) {
        Command b intercept
        Command b focus
        Command a blur
        Type-Key c b c
        if ((Read-State a).value -cne 'b') { throw 'Foreign application received B input.' }
        Command b exit
        Command a focus
        Type-Key d a bd
        $Expected = 'bd'
    }
    Command a blur
    Assert-DroppedKey e $Expected
    Command a release
    Wait-State a { param($s) -not $s.intercepting } 'interception off' | Out-Null
    Command a focus
    Assert-DroppedKey f $Expected
    Command a intercept
    Wait-State a { param($s) $s.intercepting } 'interception on' | Out-Null
    $Expected += 'g'; Type-Key g a $Expected
    Command a probe
    $ProbeHandle = [IntPtr]([int64](Read-State a).probeHwnd)
    if (-not [EgoExplicitFocusKeys]::Activate($ProbeHandle)) { throw 'Could not foreground the owned focus probe' }
    Wait-State a { param($s) -not $s.intercepting } 'game lost foreground focus' | Out-Null
    Assert-DroppedKey h $Expected
    if (-not [EgoExplicitFocusKeys]::Activate($Target.MainWindowHandle)) { throw 'Could not restore target foreground focus' }
    Wait-State a { param($s) $s.intercepting } 'game regained foreground focus' | Out-Null
    $Expected += 'i'; Type-Key i a $Expected
    Command a close-probe
    $Report.status = 'passed'
    $Report.electron = $Ready.electron
    $Report.a = Read-State a
    $Report.b = Read-State b
} catch { $Report.error = $_.Exception.Message; throw }
finally {
    if ($Client -and -not $Client.HasExited) {
        try { Command a exit; $Client.WaitForExit(5000) | Out-Null } catch { try { $Client.Refresh(); if (-not $Client.HasExited) { $Client.Kill() } } catch {} }
    }
    $env:ELECTRON_GAME_OVERLAY_BROKER_PIPE = $PriorPipe
    $Report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $Evidence 'report.json') -Encoding UTF8
    Write-Host "Explicit-focus evidence: $Evidence"
}
