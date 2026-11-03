[CmdletBinding()]
param(
    [ValidateSet('stock', 'owned')][string]$Mode = 'stock',
    [string]$OfficialRuntimePath,
    [string]$ForeignAddonPath,
    [string]$ElectronExecutable,
    [string]$SdkDist,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'visual-test-display-lease.ps1')
. (Join-Path $PSScriptRoot 'run-client-sdk-input-gate.ps1') -Backend d3d11 -SkipBuild:$SkipBuild -FunctionsOnly -ElectronExecutable $ElectronExecutable
. (Join-Path $PSScriptRoot 'input-capability-gate-helpers.ps1')
$RunDirectory = Join-Path $BuildRoot ('client-sdk-input-capabilities-' + $Mode + '-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$TargetDirectory = Join-Path $RunDirectory 'target'
$TargetPath = Join-Path $TargetDirectory $HostName
$Fixture = Join-Path $RepoRoot 'apps\client\scripts\cooperative-input-capabilities-fixture.cjs'
$Validator = Join-Path $RepoRoot 'apps\client\scripts\cooperative-input-capabilities-evidence.cjs'
$Node = (Get-Command node.exe -CommandType Application -All -ErrorAction Stop | Select-Object -First 1).Source
if (-not $SdkDist) { $SdkDist = Join-Path $RepoRoot 'libs\electron-game-overlay\dist' }
$SdkDist = (Resolve-Path -LiteralPath $SdkDist).Path
$RuntimeDirectory = Join-Path $SdkDist 'runtime\win32-x64\reshade'
$SourceAddon = Join-Path $RuntimeDirectory 'electron_game_overlay.addon64'
$Manager = Join-Path $RuntimeDirectory 'electron_game_overlay_reshade_manager.exe'
$PackageStamp = Get-Content -LiteralPath (Join-Path $RuntimeDirectory 'electron_game_overlay_runtime.build.json') -Raw | ConvertFrom-Json
$Apps = @{}
$HostProcess = $null
$HostWindow = [IntPtr]::Zero
$Sequence = 0
$Prepared = $false
$Failure = $null
$VisualDisplayLease = $null
$Report = [ordered]@{ schemaVersion = 1; mode = $Mode; status = 'failed'; scope = 'Actual controlled D3D11 target and genuine private SDK producers'; inputSource = 'Windows SendInput'; evidence = $RunDirectory; stages = [ordered]@{}; pixels = @(); permissive = $null }

if (-not ('EgoInputCapabilityPixels' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EgoInputCapabilityPixels {
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h,IntPtr dc);
 [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc,int x,int y);
 public static uint Pixel(IntPtr h,int x,int y) { var p=new POINT{x=x,y=y};if(!ClientToScreen(h,ref p))throw new Exception("ClientToScreen failed");var dc=GetDC(IntPtr.Zero);try{return GetPixel(dc,p.x,p.y);}finally{ReleaseDC(IntPtr.Zero,dc);} }
}
'@
}

if (-not ('EgoInputCapabilityDialogs' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EgoInputCapabilityDialogs {
 delegate bool WindowVisitor(IntPtr window,IntPtr parameter);
 [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor,IntPtr parameter);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,WindowVisitor visitor,IntPtr parameter);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder value,int capacity);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder value,int capacity);
 public static string ErrorDialog(uint processId) {
  string found=null;
  EnumWindows(delegate(IntPtr window,IntPtr parameter) {
   uint owner; GetWindowThreadProcessId(window,out owner); if(owner!=processId)return true;
   var name=new StringBuilder(128);GetClassName(window,name,name.Capacity);if(name.ToString()!="#32770")return true;
   var title=new StringBuilder(512);GetWindowText(window,title,title.Capacity);var text=new StringBuilder();
   EnumChildWindows(window,delegate(IntPtr child,IntPtr ignored) {
    var kind=new StringBuilder(128);GetClassName(child,kind,kind.Capacity);if(kind.ToString()!="Static")return true;
    var part=new StringBuilder(4096);GetWindowText(child,part,part.Capacity);if(part.Length!=0){if(text.Length!=0)text.Append(" | ");text.Append(part);}return true;
   },IntPtr.Zero);
   found=title.ToString()+": "+text.ToString();return false;
  },IntPtr.Zero);
  return found;
 }
}
'@
}

function Save-Json([object]$Value, [string]$Path) { $Value | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $Path -Encoding UTF8 }
function Get-CapabilityInputMarkers {
    param([ValidateSet('stock', 'owned')][string]$HostMode)
    if ($HostMode -eq 'stock') {
        # The pre-registration fixture waits specifically for ReShade64.dll;
        # a stock proxy named d3d11.dll must initialize graphics normally.
        return @('reshade-raw-wm-input-gate.enabled')
    }
    # The owned lane injects while the pre-device barrier is held. Raw input
    # must register normally afterward, rather than claiming pre-hook timing.
    return @('reshade-raw-buffer-input-gate.enabled', 'electron-game-overlay-startup-barrier.enabled', 'reshade-injection-wait.enabled')
}
function Read-State([string]$Member) {
    $Stream = $null; $Reader = $null
    try {
        $Stream = [IO.FileStream]::new((Join-Path $RunDirectory "$Member-state.json"), [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        if ($Stream.Length -le 0 -or $Stream.Length -gt 4MB) { return $null }
        $Reader = [IO.StreamReader]::new($Stream, [Text.Encoding]::UTF8, $true, 4096, $false)
        return $Reader.ReadToEnd() | ConvertFrom-Json
    } catch { return $null }
    finally { if ($Reader) { $Reader.Dispose() }; if ($Stream) { $Stream.Dispose() } }
}
function Assert-OwnedAlive {
    if ($HostProcess) {
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) { throw 'The controller-owned target exited.' }
        # This is a read-only diagnostic scoped to our retained target PID. It
        # never dismisses a dialog or controls an unrelated desktop window.
        $Dialog = [EgoInputCapabilityDialogs]::ErrorDialog([uint32]$HostProcess.Id)
        if ($Dialog) { throw "The controlled target reported a modal startup error: $Dialog" }
    }
    foreach ($Member in @($Apps.Keys)) {
        $State = Read-State $Member
        if ($State -and $State.error) { throw "Producer $Member failed: $($State.error)" }
        if (-not $Apps[$Member].expectedExit) {
            $Apps[$Member].process.Refresh()
            if ($Apps[$Member].process.HasExited) { throw "Producer $Member exited unexpectedly." }
        }
    }
}
function Wait-Condition([scriptblock]$Predicate, [string]$Label, [int]$Milliseconds = 30000) {
    $Deadline = [DateTime]::UtcNow.AddMilliseconds($Milliseconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        Assert-OwnedAlive
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 25
    }
    throw "Timed out waiting for $Label. Evidence: $RunDirectory"
}
function New-OwnedStartInfo([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [bool]$Visible = $false) {
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = $Executable; $Info.WorkingDirectory = $WorkingDirectory; $Info.UseShellExecute = $false
    $Info.RedirectStandardOutput = $true; $Info.RedirectStandardError = $true; $Info.CreateNoWindow = -not $Visible
    $Info.WindowStyle = if ($Visible) { [Diagnostics.ProcessWindowStyle]::Normal } else { [Diagnostics.ProcessWindowStyle]::Hidden }
    foreach ($Argument in $Arguments) { if ($Argument.Contains('"')) { throw 'An acceptance argument contains an embedded quote.' } }
    $Info.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    foreach ($Name in @('RESHADE_BASE_PATH_OVERRIDE','RESHADE_DISABLE_GRAPHICS_HOOK','RESHADE_DISABLE_INPUT_HOOK','RESHADE_DISABLE_LOGGING','ELECTRON_RUN_AS_NODE','ELECTRON_GAME_OVERLAY_BROKER_PIPE','ELECTRON_GAME_OVERLAY_RUN_DIRECTORY')) { $null = $Info.Environment.Remove($Name) }
    return $Info
}
function Start-Owned([Diagnostics.ProcessStartInfo]$Info) {
    $Process = [Diagnostics.Process]::new(); $Process.StartInfo = $Info
    if (-not $Process.Start()) { throw "Could not start $($Info.FileName)" }
    $null = $Process.Handle
    return @{ process = $Process; started = $Process.StartTime; arguments = $Info.Arguments; stdout = $Process.StandardOutput.ReadToEndAsync(); stderr = $Process.StandardError.ReadToEndAsync(); expectedExit = $false }
}
function Start-App([string]$Member, [bool]$Reject) {
    $Requirement = if ($Member -eq 'strict') { 'copied-raw-input-buffer' } else { 'copied-wm-input' }
    $Expected = if ($Reject) { 'reject' } else { 'accept' }
    $Info = New-OwnedStartInfo $Electron @('--force-device-scale-factor=1', $Fixture, "--member=$Member", "--evidence=$RunDirectory", "--sdk-dist=$SdkDist", "--target=$TargetPath", "--pid=$($HostProcess.Id)", "--require=$Requirement", "--expect=$Expected") $RepoRoot
    $Apps[$Member] = Start-Owned $Info
    $Apps[$Member].member = $Member
    try { Wait-Condition { (Read-State $Member).ready } "$Member public-SDK producer readiness" 120000 }
    catch {
        $Entry = $Apps[$Member]
        $Entry.process.Refresh()
        $Startup = [ordered]@{
            member = $Member; processId = $Entry.process.Id; arguments = $Entry.arguments
            stateFilePresent = Test-Path -LiteralPath (Join-Path $RunDirectory "$Member-state.json") -PathType Leaf
            sdkEvidencePresent = Test-Path -LiteralPath (Join-Path $RunDirectory "$Member-sdk.json") -PathType Leaf
            hasExited = $Entry.process.HasExited
            error = $_.Exception.Message
        }
        if ($Entry.process.HasExited) {
            $Startup.exitCode = $Entry.process.ExitCode
            if ($Entry.stdout.Wait(1000)) { $Startup.stdout = $Entry.stdout.GetAwaiter().GetResult() }
            if ($Entry.stderr.Wait(1000)) { $Startup.stderr = $Entry.stderr.GetAwaiter().GetResult() }
        }
        Save-Json $Startup (Join-Path $RunDirectory "$Member-startup-failure.json")
        throw "Producer $Member did not publish its first ready state (PID $($Entry.process.Id), exited=$($Entry.process.HasExited), state=$($Startup.stateFilePresent), SDK=$($Startup.sdkEvidencePresent)). $($Startup.error)"
    }
}
function Stop-OwnedAppTree([hashtable]$Entry) {
    $RootProcess = $Entry.process
    $RootProcess.Refresh()
    $RootStarted = $Entry.started
    $RootExitedAt = if ($RootProcess.HasExited) { $RootProcess.ExitTime } else { $null }
    $Rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $Descendants = [Collections.Generic.HashSet[int]]::new()
    $null = $Descendants.Add($RootProcess.Id)
    do {
        $Changed = $false
        foreach ($Row in $Rows) { if ($Descendants.Contains([int]$Row.ParentProcessId) -and $Descendants.Add([int]$Row.ProcessId)) { $Changed = $true } }
    } while ($Changed)
    $Handles = [Collections.Generic.List[Diagnostics.Process]]::new()
    try {
        foreach ($Row in $Rows) {
            if ($Row.ProcessId -eq $RootProcess.Id -or -not $Descendants.Contains([int]$Row.ProcessId)) { continue }
            $Stage = (Read-State $Entry.member).runDirectory
            $OwnedExecutable = [string]::Equals($Row.ExecutablePath, $Electron, [StringComparison]::OrdinalIgnoreCase) -or
                ($Stage -and [string]::Equals($Row.ExecutablePath, (Join-Path $Stage 'inject.exe'), [StringComparison]::OrdinalIgnoreCase))
            if (-not $OwnedExecutable) { continue }
            $Child = Get-Process -Id $Row.ProcessId -ErrorAction SilentlyContinue
            if (-not $Child) { continue }
            try { $null = $Child.Handle; if ($Child.StartTime -lt $RootStarted -or ($RootExitedAt -and $Child.StartTime -gt $RootExitedAt)) { $Child.Dispose(); continue }; $Handles.Add($Child) }
            catch { $Child.Dispose() }
        }
        foreach ($Child in $Handles) { try { if (-not $Child.HasExited) { $Child.Kill() } } catch { $Child.Refresh(); if (-not $Child.HasExited) { throw } } }
        if (-not $RootProcess.HasExited) { $RootProcess.Kill() }
        if (-not $RootProcess.WaitForExit(5000)) { throw 'An owned producer did not stop after bounded cleanup.' }
        foreach ($Child in $Handles) { if (-not $Child.WaitForExit(5000)) { throw 'An owned producer child did not stop after bounded cleanup.' } }
    }
    finally { foreach ($Child in $Handles) { $Child.Dispose() } }
}
function Command([string]$Member, [string]$Action) {
    $script:Sequence++; $Current = $script:Sequence
    $Path = Join-Path $RunDirectory "$Member-command.json"
    Save-Json @{ sequence = $Current; action = $Action } "$Path.tmp"
    Move-Item -LiteralPath "$Path.tmp" -Destination $Path -Force
    if ($Action -eq 'exit') { $Apps[$Member].expectedExit = $true }
    Wait-Condition { (Read-State $Member).commandSequence -eq $Current } "$Member command $Action"
}
function Activate-Target {
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($HostWindow)) { throw 'Could not foreground the controlled target.' }
    Start-Sleep -Milliseconds 200
}
function Assert-TargetForeground {
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($HostWindow)) { throw 'Desktop foreground changed during the input proof.' }
}
function Assert-ScenePixel([string]$Member) {
    Assert-TargetForeground
    $Expected = if ($Member -eq 'strict') { @(198,40,40) } else { @(21,101,192) }
    $X = if ($Member -eq 'strict') { 55 } else { 415 }
    $Probe = [ordered]@{ name = "$Member actual composing pixel"; clientX = $X; clientY = 200; expectedRgb = $Expected; observedRgb = @(); attempts = 0 }
    $Report.pixels += $Probe
    Wait-Condition {
        Assert-TargetForeground
        $Value = [EgoInputCapabilityPixels]::Pixel($HostWindow, $X, 200)
        $Probe.observedRgb = @([int]($Value -band 255), [int](($Value -shr 8) -band 255), [int](($Value -shr 16) -band 255))
        $Probe.attempts++
        [Math]::Abs($Probe.observedRgb[0]-$Expected[0]) -le 8 -and [Math]::Abs($Probe.observedRgb[1]-$Expected[1]) -le 8 -and [Math]::Abs($Probe.observedRgb[2]-$Expected[2]) -le 8
    } "$Member actual rendered RGB pixel" 15000
}
function Tcp-Evidence([string]$Member) {
    $State = Read-State $Member
    $Sockets = @(Get-NetTCPConnection -State Established -OwningProcess $State.processId -ErrorAction Stop | Where-Object { $_.LocalPort -eq $State.transport.port })
    if ($Sockets.Count -ne 1) { throw "$Member does not have one established private connection." }
    $Socket = $Sockets[0]
    $Peer = @(Get-NetTCPConnection -State Established -OwningProcess $HostProcess.Id -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Socket.RemotePort -and $_.RemotePort -eq $Socket.LocalPort })
    if ($Peer.Count -ne 1) { throw 'The socket peer is not the exact controlled target.' }
    return [ordered]@{ localAddress = $Socket.LocalAddress; localPort = $Socket.LocalPort; remoteAddress = $Socket.RemoteAddress; remotePort = $Socket.RemotePort; owningProcess = $Socket.OwningProcess; state = $Socket.State.ToString() }
}
function Snapshot([string]$Member, [string]$Name, [bool]$Tcp = $true) {
    $State = Read-State $Member
    if ($Tcp) {
        if ($State.authenticatedTarget.pid -ne $HostProcess.Id -or $State.authenticatedTarget.creationTime100ns -cne $Report.target.creationTime100ns -or
            -not [string]::Equals($State.authenticatedTarget.executablePath, $TargetPath, [StringComparison]::OrdinalIgnoreCase)) { throw "$Member did not authenticate the exact retained target process instance." }
        $State | Add-Member -NotePropertyName tcp -NotePropertyValue (Tcp-Evidence $Member)
    }
    Save-Json $State (Join-Path $RunDirectory "$Name-$Member.json")
    return $State
}
function Assert-StrictRejected {
    $State = Read-State 'strict'
    if (-not $State.rejected -or $State.attachError.code -cne 'target-input-capability-unsupported' -or
        $State.authenticationCount -ne 0 -or $State.connectionCount -ne 0 -or $State.renderingCount -ne 0 -or $State.trueAckCount -ne 0 -or
        $State.wire.helloCount -lt 1 -or $State.wire.outboundBytes -ne 0 -or $State.wire.outboundPackets -ne 0 -or $State.wire.outboundFrames -ne 0 -or $State.wire.interceptTruePackets -ne 0 -or
        @($State.wireConnections | Where-Object { $_.actualBytesWritten -ne 0 }).Count -ne 0 -or
        $State.hello.pid -ne $HostProcess.Id -or $State.hello.creationTime100ns -cne $Report.target.creationTime100ns -or
        -not [string]::Equals($State.hello.path, $TargetPath, [StringComparison]::OrdinalIgnoreCase) -or @($State.hello.capabilities) -notcontains 'input-capabilities-v1' -or
        @($State.hello.capabilities) -notcontains 'copied-wm-input-v1' -or @($State.hello.capabilities) -contains 'copied-raw-input-buffer-v1') {
        throw 'The strict stock-host producer was not rejected before every scene/frame/interception byte.'
    }
}
function Input-Proof([string]$Member, [string]$Text, [string]$Expected) {
    if ($Text -cne ' ') { throw 'The raw-input proof sends one actual VK_SPACE press/release per step.' }
    Assert-TargetForeground
    $X = if ($Member -eq 'strict') { 150 } else { 510 }
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint($HostWindow, $X, 135)
    Start-Sleep -Milliseconds 100
    $Before = Wait-ForStableHostTitle -Window $HostWindow -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    if (-not $Before.Contains('clip=off')) { throw 'Cursor confinement remained enabled during interception.' }
    $BeforeDom = (Read-State $Member).windows.main
    $BeforeWheel = @($BeforeDom.wheel).Count
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 150
    # KEYEVENTF_UNICODE synthesizes VK_PACKET window messages rather than the
    # registered raw-keyboard path. Match the established raw oracle with an
    # actual virtual-key press/release, then require its delivered DOM text.
    [ReShadeClientSdkGate.NativeInputMethods]::SendSpace()
    [ReShadeClientSdkGate.NativeInputMethods]::SendWheel(120)
    Wait-Condition { $State = Read-State $Member; $State.windows.main.value -ceq $Expected -and $State.windows.main.keydowns -gt $BeforeDom.keydowns -and $State.windows.main.downs -gt $BeforeDom.downs -and $State.windows.main.ups -gt $BeforeDom.ups -and @($State.windows.main.wheel).Count -gt $BeforeWheel -and @($State.windows.main.wheel | Where-Object { $_.dy -ne 0 }).Count -gt 0 -and @($State.windows.main.heldKeys).Count -eq 0 } "$Member real mouse/keyboard/wheel input" 15000
    Start-Sleep -Milliseconds 250
    Assert-TargetForeground
    $After = [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($HostWindow)
    if ($After -cne $Before) { throw "Input reached the game while $Member was intercepting. Before: $Before After: $After" }
    return [ordered]@{ text = $Text; overlayValue = $Expected; gameInputUnchanged = $true; sourceMode = $(if ($Mode -eq 'stock') { 'wm-input' } else { 'raw-buffer' }); before = $Before; after = $After }
}
function Module-Evidence {
    $HostProcess.Refresh()
    $Modules = @($HostProcess.Modules | ForEach-Object { [pscustomobject]@{ path = $_.FileName; sha256 = (Get-FileHash -LiteralPath $_.FileName -Algorithm SHA256).Hash.ToLowerInvariant() } })
    $Runtimes = @($Modules | Where-Object { [IO.Path]::GetFileName($_.path) -imatch '^(d3d11|ReShade64|dxgi)\.dll$' -and $_.sha256 -eq $Report.expected.runtimeSha256 })
    if ($Runtimes.Count -ne 1 -or -not [string]::Equals($Runtimes[0].path, $Report.expected.runtimePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The target does not contain its one exact expected host runtime.' }
    $Engines = @($Modules | Where-Object { [IO.Path]::GetFileName($_.path) -ieq 'electron_game_overlay.addon64' })
    $ExpectedCount = if ($Mode -eq 'stock') { 3 } else { 1 }
    if ($Engines.Count -ne $ExpectedCount -or @($Engines | Where-Object { $_.sha256 -cne $Report.expected.addonSha256 }).Count) { throw 'Mapped engine count/hash does not match the adapter and private producer stages.' }
    foreach ($Member in @($Apps.Keys)) {
        $Stage = (Read-State $Member).runDirectory
        if (-not $Stage -or @($Engines | Where-Object { [string]::Equals((Split-Path -Parent $_.path), $Stage, [StringComparison]::OrdinalIgnoreCase) }).Count -ne 1) { throw "$Member did not load its own exact private engine." }
    }
    if ($Mode -eq 'stock' -and @($Modules | Where-Object { [string]::Equals($_.path, $Report.expected.foreignAddonPath, [StringComparison]::OrdinalIgnoreCase) -and $_.sha256 -eq $Report.expected.foreignAddonSha256 }).Count -ne 1) { throw 'The foreign FPS add-on was not preserved and loaded.' }
    Save-Json $Modules (Join-Path $RunDirectory 'mapped-modules.json')
    return $Modules
}

if (-not $SkipBuild) { & $Nx run client:build; if ($LASTEXITCODE -ne 0) { throw 'Production SDK/client build failed.' } }
foreach ($Path in @($BuiltHost, $SourceAddon, $Manager, $Fixture, $Validator)) { if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required current artifact is missing: $Path" } }
if ((Get-FileHash -LiteralPath $SourceAddon -Algorithm SHA256).Hash -ine $PackageStamp.addonSha256) { throw 'The source SDK engine does not match its package manifest.' }
New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination $TargetPath
foreach ($InputMarker in @(Get-CapabilityInputMarkers -HostMode $Mode)) {
    [IO.File]::WriteAllText((Join-Path $TargetDirectory $InputMarker), "enabled`n")
}
$Report.expected = [ordered]@{ addonSha256 = $PackageStamp.addonSha256.ToLowerInvariant() }

try {
    $VisualDisplayLease = Enter-VisualTestDisplayLease $Report
    if ($Mode -eq 'stock') {
        if (-not $OfficialRuntimePath -or -not $ForeignAddonPath) { throw 'Stock mode requires exact OfficialRuntimePath (6.7.3 x64 full add-on) and pristine ForeignAddonPath (FPS Limiter API 18).' }
        $OfficialRuntimePath = (Resolve-Path -LiteralPath $OfficialRuntimePath).Path
        $ForeignAddonPath = (Resolve-Path -LiteralPath $ForeignAddonPath).Path
        if ((Get-Item -LiteralPath $OfficialRuntimePath).VersionInfo.FileVersion -notmatch '^6\.7\.3(?:\.|$)') { throw 'This controlled stock capability lane requires ReShade 6.7.3.' }
        $RuntimePath = Join-Path $TargetDirectory 'd3d11.dll'
        $AddonDirectory = Join-Path $TargetDirectory 'addons'
        New-Item -ItemType Directory -Path $AddonDirectory -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $TargetDirectory 'cache') -Force | Out-Null
        Copy-Item -LiteralPath $OfficialRuntimePath -Destination $RuntimePath
        $ForeignPath = Join-Path $AddonDirectory 'fps_limit.addon64'
        Copy-Item -LiteralPath $ForeignAddonPath -Destination $ForeignPath
        [IO.File]::WriteAllText((Join-Path $TargetDirectory 'ReShade.ini'), "[INSTALL]`nBasePath=.`n[ADDON]`nAddonPath=.\addons`nDisabledAddons=`n[GENERAL]`nEffectSearchPaths=.`nTextureSearchPaths=.`nIntermediateCachePath=.\cache`nPresetPath=.\CapabilityWitness.ini`nPerformanceMode=0`n[INPUT]`nInputProcessing=0`n[OVERLAY]`nShowFPS=0`nTutorialProgress=4`n", [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $TargetDirectory 'CapabilityWitness.ini'), "PreprocessorDefinitions=`nTechniques=CapabilityWitness@CapabilityWitness.fx`nTechniqueSorting=CapabilityWitness@CapabilityWitness.fx`n", [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $TargetDirectory 'CapabilityWitness.fx'), @'
texture2D BackBufferTex : COLOR;
sampler2D BackBufferSampler { Texture = BackBufferTex; };
void CapabilityVS(uint id : SV_VertexID, out float4 pos : SV_Position, out float2 uv : TEXCOORD) {
 uv = float2(id == 2 ? 2.0 : 0.0, id == 1 ? 2.0 : 0.0); pos = float4(uv * float2(2.0,-2.0) + float2(-1.0,1.0),0.0,1.0);
}
float4 CapabilityPS(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target { return tex2D(BackBufferSampler, uv); }
technique CapabilityWitness < enabled = true; > { pass { VertexShader = CapabilityVS; PixelShader = CapabilityPS; } }
'@, [Text.UTF8Encoding]::new($false))
        foreach ($Path in @($RuntimePath,$ForeignPath,(Join-Path $TargetDirectory 'ReShade.ini'),(Join-Path $TargetDirectory 'CapabilityWitness.ini'),(Join-Path $TargetDirectory 'CapabilityWitness.fx'))) { (Get-Item -LiteralPath $Path).IsReadOnly = $true }
        $Report.expected.runtimePath = $RuntimePath
        $Report.expected.runtimeSha256 = (Get-FileHash -LiteralPath $RuntimePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($Report.expected.runtimeSha256 -eq $PackageStamp.reshadeRuntimeSha256.ToLowerInvariant()) { throw 'Stock mode was supplied the project patched host.' }
        $Report.expected.adapterPath = Join-Path $AddonDirectory 'electron_game_overlay.addon64'
        $Report.expected.foreignAddonPath = $ForeignPath
        $Report.expected.foreignAddonSha256 = (Get-FileHash -LiteralPath $ForeignPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $Report.protectedBefore = @(Get-CapabilityProtectedManifest -Root $TargetDirectory)
        $Report.stages.prepare = Invoke-CapabilityAddonTransaction -Operation prepare -Manager $Manager -Directory $AddonDirectory -Runtime $RuntimePath -RuntimeHash $Report.expected.runtimeSha256 -Source $SourceAddon -SourceHash $Report.expected.addonSha256
        $Prepared = $true
        Assert-CapabilityProtectedManifest -Expected $Report.protectedBefore -Actual @(Get-CapabilityProtectedManifest -Root $TargetDirectory)
    }
    $HostEntry = Start-Owned (New-OwnedStartInfo $TargetPath @() $TargetDirectory $true)
    $HostProcess = $HostEntry.process
    $Report.target = @{ pid = $HostProcess.Id; executablePath = $TargetPath; creationTime100ns = $HostProcess.StartTime.ToFileTimeUtc().ToString() }
    if ($Mode -eq 'owned') {
        Start-App strict $false
        Wait-Condition { (Read-State 'strict').injectorReturned } 'owned full-runtime injection before graphics' 120000
        foreach ($Name in @('electron-game-overlay-startup-barrier.enabled','reshade-injection-wait.enabled')) { Remove-Item -LiteralPath (Join-Path $TargetDirectory $Name) -Force }
        Wait-Condition { (Read-State 'strict').attached } 'strict owned-host capability authentication' 120000
        $Report.expected.runtimePath = Join-Path (Read-State 'strict').runDirectory 'ReShade64.dll'
        $Report.expected.runtimeSha256 = $PackageStamp.reshadeRuntimeSha256.ToLowerInvariant()
        $Active = 'strict'
    }
    else {
        Start-App permissive $false
        Wait-Condition { (Read-State 'permissive').attached } 'permissive stock-host WM_INPUT authentication' 120000
        $Active = 'permissive'
    }
    $HostWindow = Wait-ForHostWindow -HostProcess $HostProcess -Deadline ([DateTime]::UtcNow.AddSeconds(30))
    Activate-Target
    Wait-Condition { $State = Read-State $Active; $State.renderingCount -gt 0 -and $State.fpsCount -gt 0 -and $State.hello.pid -eq $HostProcess.Id } 'actual host hello and private scene rendering'
    Assert-ScenePixel $Active
    $Registration = Get-HostInputSnapshot -Title ([ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($HostWindow))
    if ($Registration.Mode -cne $(if ($Mode -eq 'stock') { 'wm-input' } else { 'raw-buffer' })) { throw 'The controlled input oracle did not register the required real input mode.' }
    Command $Active intercept
    Wait-Condition { (Read-State $Active).intercepting } "$Active effective interception"
    $Report.inputProof = Input-Proof $Active ' ' ' '
    if ($Mode -eq 'stock') {
        $Report.permissiveBefore = Snapshot permissive 'before-strict-rejection'
        Start-App strict $true
        Wait-Condition { (Read-State 'strict').rejected -and (Read-State 'strict').attachError.code -eq 'target-input-capability-unsupported' } 'typed strict stock capability rejection' 15000
        Start-Sleep -Milliseconds 750
        Assert-StrictRejected
        $Report.strict = Snapshot strict 'strict-rejected' $false
        $Report.inputProof = Input-Proof permissive ' ' '  '
        Assert-ScenePixel permissive
        $Report.permissiveAfter = Snapshot permissive 'after-strict-rejection'
        if (($Report.permissiveBefore.tcp | ConvertTo-Json -Compress) -cne ($Report.permissiveAfter.tcp | ConvertTo-Json -Compress) -or
            $Report.permissiveAfter.authenticationCount -ne 1 -or $Report.permissiveAfter.connectionCount -ne 1 -or
            $Report.permissiveAfter.transportLostCount -ne 0 -or $Report.permissiveAfter.targetDisconnectedCount -ne 0) { throw 'Strict rejection disturbed the permissive private connection.' }
        $Report.permissive = $Report.permissiveAfter
        $Log = Get-Content -LiteralPath (Join-Path $TargetDirectory 'ReShade.log') -Raw
        if ($Log -notmatch 'Registered add-on "FPS Limiter"' -or $Log -notmatch "Successfully compiled '.*CapabilityWitness\.fx'") { throw 'Stock foreign add-on/effect coexistence was not observed.' }
    }
    else { $Report.strict = Snapshot strict 'owned-positive' }
    $Report.modules = @(Module-Evidence)
    Command $Active release
    Wait-Condition { -not (Read-State $Active).intercepting } 'actual input release'
    $Baseline = Get-HostInputSnapshot -Title (Wait-ForStableHostTitle -Window $HostWindow -Deadline ([DateTime]::UtcNow.AddSeconds(8)))
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint($HostWindow, 1100, 650)
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    [ReShadeClientSdkGate.NativeInputMethods]::SendWheel(120)
    [ReShadeClientSdkGate.NativeInputMethods]::SendSpace()
    $Released = Wait-ForReleasedRawInput -Window $HostWindow -Baseline $Baseline -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    if ($Released.RawBufferError -ne 0 -or ($Mode -eq 'owned' -and $Released.RawBuffer -le $Baseline.RawBuffer)) { throw 'The released owned host did not deliver actual GetRawInputBuffer records to the game.' }
    if (-not $Released.Title.Contains('clip=on')) { throw 'Cursor confinement was not restored after release.' }
    $Report.inputProof.releasedRawBufferAdvanced = $Mode -eq 'owned' -and $Released.RawBuffer -gt $Baseline.RawBuffer
    $Report.releasedGameInput = $Released
    if ($Mode -eq 'stock') {
        Assert-StrictRejected
        $Report.protectedAfter = @(Get-CapabilityProtectedManifest -Root $TargetDirectory)
        Assert-CapabilityProtectedManifest -Expected $Report.protectedBefore -Actual $Report.protectedAfter
    }
    $Report.status = 'passed'
    # Read the actual mapped module files while both private stages and the
    # exact target are still alive. Final disposal may legitimately remove a
    # stage after authoritative target exit; the final validator uses this
    # retained proof instead of requiring those files to survive cleanup.
    $LiveReport = Join-Path $RunDirectory 'before-cleanup-report.json'
    Save-Json $Report $LiveReport
    $ModuleValidation = @(& $Node $Validator --report $LiveReport --verify-module-files)
    if ($LASTEXITCODE -ne 0 -or $ModuleValidation.Count -ne 1) { throw 'Live mapped-module PE/hash verification failed.' }
    $Report.moduleFileVerification = ($ModuleValidation[0] | ConvertFrom-Json).moduleFileVerification
}
catch { $Failure = $_; $Report.status = 'failed'; $Report.error = $_.Exception.Message; $Report.stack = $_.ScriptStackTrace }
finally {
    foreach ($Member in @($Apps.Keys)) {
        try {
            if (-not $Apps[$Member].process.HasExited) {
                try { Command $Member exit } catch {}
                $null = $Apps[$Member].process.WaitForExit(5000)
            }
            Stop-OwnedAppTree $Apps[$Member]
            if (-not $Apps[$Member].stdout.Wait(5000) -or -not $Apps[$Member].stderr.Wait(5000)) { throw 'Owned producer output did not close after cleanup.' }
            [IO.File]::WriteAllText((Join-Path $RunDirectory "$Member.stdout.log"), $Apps[$Member].stdout.GetAwaiter().GetResult())
            [IO.File]::WriteAllText((Join-Path $RunDirectory "$Member.stderr.log"), $Apps[$Member].stderr.GetAwaiter().GetResult())
        } catch { $Report.status = 'failed'; $Report.cleanupError = $_.Exception.Message; if (-not $Failure) { $Failure = $_ } }
    }
    if ($HostProcess) { try { if (-not $HostProcess.HasExited) { [ReShadeClientSdkGate.NativeInputMethods]::RequestClose($HostWindow); if (-not $HostProcess.WaitForExit(5000)) { $HostProcess.Kill() } } } catch { try { $HostProcess.Kill() } catch {} } }
    if ($HostEntry) { try { if (-not $HostEntry.stdout.Wait(5000) -or -not $HostEntry.stderr.Wait(5000)) { throw 'Owned host output did not close after cleanup.' }; [IO.File]::WriteAllText((Join-Path $RunDirectory 'host.stdout.log'), $HostEntry.stdout.GetAwaiter().GetResult()); [IO.File]::WriteAllText((Join-Path $RunDirectory 'host.stderr.log'), $HostEntry.stderr.GetAwaiter().GetResult()) } catch { $Report.status = 'failed'; $Report.cleanupError = $_.Exception.Message; if (-not $Failure) { $Failure = $_ } } }
    if ($Prepared) {
        try {
            $Report.stages.remove = Invoke-CapabilityAddonTransaction -Operation remove -Manager $Manager -Directory $AddonDirectory -Runtime $RuntimePath -RuntimeHash $Report.expected.runtimeSha256 -Source $SourceAddon -SourceHash $Report.expected.addonSha256
            $Report.protectedAfterCleanup = @(Get-CapabilityProtectedManifest -Root $TargetDirectory)
            Assert-CapabilityProtectedManifest -Expected $Report.protectedBefore -Actual $Report.protectedAfterCleanup
        } catch { $Report.status = 'failed'; $Report.cleanupError = $_.Exception.Message; if (-not $Failure) { $Failure = $_ } }
    }
    Exit-VisualTestDisplayLease $VisualDisplayLease $Report
    Save-Json $Report (Join-Path $RunDirectory 'report.json')
}
if ($Failure) { throw $Failure }
& $Node $Validator --report (Join-Path $RunDirectory 'report.json')
if ($LASTEXITCODE -ne 0) { throw "Input capability acceptance evidence failed validation: $RunDirectory" }
Write-Host "D3D11_$($Mode.ToUpperInvariant())_INPUT_CAPABILITIES_GATE_PASS $RunDirectory"
