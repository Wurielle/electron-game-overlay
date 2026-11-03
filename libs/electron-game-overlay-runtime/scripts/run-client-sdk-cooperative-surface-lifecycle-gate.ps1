[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$ElectronExecutable,
    [string]$SdkDistA,
    [string]$SdkDistB
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cooperative-native-evidence.ps1')
. (Join-Path $PSScriptRoot 'run-client-sdk-input-gate.ps1') -Backend d3d11 -SkipBuild:$SkipBuild -FunctionsOnly -ElectronExecutable $ElectronExecutable
$RunDirectory = Join-Path $BuildRoot ('client-sdk-two-app-surface-lifecycle-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$TargetDirectory = Join-Path $RunDirectory 'target'
$TargetPath = Join-Path $TargetDirectory $HostName
$Fixture = Join-Path $RepoRoot 'apps\client\scripts\cooperative-surface-lifecycle-fixture.cjs'
$NativeHelper = Join-Path $RepoRoot 'apps\client\scripts\cooperative-game-evidence.cjs'
$LifecycleHelper = Join-Path $RepoRoot 'apps\client\scripts\cooperative-surface-lifecycle-evidence.cjs'
$Node = (Get-Command node.exe -CommandType Application -All -ErrorAction Stop | Select-Object -First 1).Source
if (-not $SdkDistA) { $SdkDistA = Join-Path $RepoRoot 'libs\electron-game-overlay\dist' }
if (-not $SdkDistB) { $SdkDistB = $SdkDistA }
$SdkDistA = (Resolve-Path -LiteralPath $SdkDistA).Path
$SdkDistB = (Resolve-Path -LiteralPath $SdkDistB).Path
$Apps = @{}
$HostProcess = $null
$PrimaryWindow = [IntPtr]::Zero
$SecondaryWindow = [IntPtr]::Zero
$Sequence = 0
$ExpectedIdentity = $null
$Report = [ordered]@{ schemaVersion = 1; status = 'failed'; scope = 'Actual controlled D3D11 host and two genuine public-SDK Electron producers'; inputSource = 'Windows SendInput'; evidence = $RunDirectory; stages = [ordered]@{}; pixelProbes = @(); error = $null }

if (-not ('EgoCooperativeSurfacePixels' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EgoCooperativeSurfacePixels {
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h,IntPtr dc);
 [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc,int x,int y);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 public static uint Pixel(IntPtr h,int x,int y) { var p=new POINT{x=x,y=y};if(!ClientToScreen(h,ref p))throw new Exception("ClientToScreen failed");var dc=GetDC(IntPtr.Zero);try{return GetPixel(dc,p.x,p.y);}finally{ReleaseDC(IntPtr.Zero,dc);} }
}
'@
}

function Save-Json([object]$Value, [string]$Path) { $Value | ConvertTo-Json -Depth 35 | Set-Content -LiteralPath $Path -Encoding UTF8 }
function Read-State([string]$Member) {
    $Stream = $null
    $Reader = $null
    try {
        # Producers publish by atomic rename. A normal Get-Content reader does
        # not share deletion on Windows and can make that publication fail.
        $Stream = [IO.FileStream]::new((Join-Path $RunDirectory "$Member-state.json"), [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        if ($Stream.Length -le 0 -or $Stream.Length -gt 4MB) { throw 'Producer state size is out of bounds.' }
        $Reader = [IO.StreamReader]::new($Stream, [Text.Encoding]::UTF8, $true, 4096, $false)
        $Text = $Reader.ReadToEnd()
        if ($Text.Length -gt 4MB) { throw 'Producer state size is out of bounds.' }
        return $Text | ConvertFrom-Json
    }
    catch { return $null }
    finally { if ($Reader) { $Reader.Dispose() }; if ($Stream) { $Stream.Dispose() } }
}
function Assert-OwnedAlive {
    if ($HostProcess) {
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) { throw 'The controller-owned D3D11 host exited during lifecycle acceptance.' }
    }
    foreach ($Member in @('a', 'b')) {
        $State = Read-State $Member
        if ($State -and $State.error) { throw "Producer $Member failed: $($State.error)" }
        if ($Apps.ContainsKey($Member) -and -not $Apps[$Member].expectedExit) {
            $Apps[$Member].process.Refresh()
            if ($Apps[$Member].process.HasExited) { throw "Producer $Member exited during lifecycle acceptance." }
        }
    }
    foreach ($Window in @($PrimaryWindow, $SecondaryWindow)) {
        if ($Window -ne [IntPtr]::Zero -and -not [EgoCooperativeSurfacePixels]::IsWindow($Window)) { throw 'A retained controlled HWND was destroyed instead of only its graphics surface.' }
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
function Command([string]$Member, [string]$Action) {
    $script:Sequence++
    $CurrentSequence = $script:Sequence
    $Destination = Join-Path $RunDirectory "$Member-command.json"
    Save-Json @{ sequence = $CurrentSequence; action = $Action } "$Destination.tmp"
    Move-Item -LiteralPath "$Destination.tmp" -Destination $Destination -Force
    if ($Action -eq 'exit') { $Apps[$Member].expectedExit = $true }
    Wait-Condition { (Read-State $Member).commandSequence -eq $CurrentSequence } "$Member command $Action"
}
function Start-Owned([Diagnostics.ProcessStartInfo]$Info) {
    $Process = [Diagnostics.Process]::new()
    $Process.StartInfo = $Info
    if (-not $Process.Start()) { throw "Could not launch owned process: $($Info.FileName)" }
    $null = $Process.Handle
    return $Process
}
function New-StartInfo([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [bool]$Visible = $false) {
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = $Executable
    $Info.WorkingDirectory = $WorkingDirectory
    $Info.UseShellExecute = $false
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $Info.CreateNoWindow = -not $Visible
    $Info.WindowStyle = if ($Visible) { [Diagnostics.ProcessWindowStyle]::Normal } else { [Diagnostics.ProcessWindowStyle]::Hidden }
    foreach ($Argument in $Arguments) { if ($Argument.Contains('"')) { throw 'An acceptance argument contains an unsupported embedded quote.' } }
    $Info.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    foreach ($Name in @('RESHADE_BASE_PATH_OVERRIDE', 'RESHADE_DISABLE_GRAPHICS_HOOK', 'RESHADE_DISABLE_INPUT_HOOK', 'RESHADE_DISABLE_LOGGING', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_GAME_OVERLAY_BROKER_PIPE')) { $Info.Environment.Remove($Name) | Out-Null }
    return $Info
}
function Start-App([string]$Member, [bool]$WaitForAuthentication = $true) {
    $Dist = if ($Member -eq 'a') { $SdkDistA } else { $SdkDistB }
    $Info = New-StartInfo $Electron @('--force-device-scale-factor=1', $Fixture, "--evidence=$RunDirectory", "--member=$Member", "--sdk-dist=$Dist", "--target=$TargetPath", "--pid=$($HostProcess.Id)") $RepoRoot
    $Process = Start-Owned $Info
    $Apps[$Member] = @{ process = $Process; expectedExit = $false; stdout = $Process.StandardOutput.ReadToEndAsync(); stderr = $Process.StandardError.ReadToEndAsync(); children = [Collections.Generic.List[Diagnostics.Process]]::new(); childIds = [Collections.Generic.HashSet[int]]::new() }
    Wait-Condition { $State = Read-State $Member; $State.ready -and $State.injectorReturned -and (-not $WaitForAuthentication -or $State.attached) } "producer $Member own-engine injection$(if ($WaitForAuthentication) { ' and exact-PID authentication' })" 120000
}
function Retain-OwnedChildren {
    $Snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    foreach ($Member in @('a', 'b')) {
        if (-not $Apps.ContainsKey($Member)) { continue }
        $Entry = $Apps[$Member]
        $Parents = [Collections.Generic.HashSet[int]]::new()
        $null = $Parents.Add($Entry.process.Id)
        foreach ($Child in $Entry.children) { $null = $Parents.Add($Child.Id) }
        do {
            $Changed = $false
            foreach ($Record in $Snapshot) { if ($Parents.Contains([int]$Record.ParentProcessId) -and $Parents.Add([int]$Record.ProcessId)) { $Changed = $true } }
        } while ($Changed)
        foreach ($Record in $Snapshot) {
            if ($Record.ProcessId -eq $Entry.process.Id -or -not $Parents.Contains([int]$Record.ProcessId) -or $Entry.childIds.Contains([int]$Record.ProcessId) -or -not [string]::Equals($Record.ExecutablePath, $Electron, [StringComparison]::OrdinalIgnoreCase)) { continue }
            $Child = Get-Process -Id $Record.ProcessId -ErrorAction SilentlyContinue
            if (-not $Child) { continue }
            try {
                $null = $Child.Handle
                if ($Child.StartTime -lt $Entry.process.StartTime) { $Child.Dispose(); continue }
                $null = $Entry.childIds.Add($Child.Id)
                $Entry.children.Add($Child)
            } catch { $Child.Dispose() }
        }
    }
}
function Host-Text {
    if (Test-Path -LiteralPath (Join-Path $RunDirectory 'host.stdout.log')) { return [string](Get-Content -LiteralPath (Join-Path $RunDirectory 'host.stdout.log') -Raw) }
    return ''
}
function Wait-HostMarker([string]$Pattern, [string]$Label, [int]$Milliseconds = 30000) {
    $script:HostMatch = $null
    Wait-Condition {
        $MatchesFound = @([regex]::Matches((Host-Text), $Pattern))
        if ($MatchesFound.Count -gt 1) { throw "Controlled host repeated $Label." }
        if ($MatchesFound.Count -eq 1) { $script:HostMatch = $MatchesFound[0]; return $true }
        return $false
    } $Label $Milliseconds
    return $script:HostMatch
}
function Request([string]$Name) { [IO.File]::WriteAllText((Join-Path $TargetDirectory $Name), "requested`n", [Text.UTF8Encoding]::new($false)) }
function Activate([IntPtr]$Window) {
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($Window)) { throw 'Could not foreground the controlled target HWND.' }
    Start-Sleep -Milliseconds 150
}
function Assert-Foreground([IntPtr]$Window) {
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($Window)) { throw 'Desktop foreground changed during controlled lifecycle input.' }
}
function Convert-PixelColorRef([uint32]$Value) {
    return [ordered]@{
        colorRef = $Value
        hex = '0x' + $Value.ToString('x8')
        red = [int]($Value -band 255)
        green = [int](($Value -shr 8) -band 255)
        blue = [int](($Value -shr 16) -band 255)
    }
}
function Get-PixelProbeContext([IntPtr]$Window) {
    $Context = [ordered]@{
        expectedHwnd = '0x' + $Window.ToInt64().ToString('x')
        primaryHwnd = '0x' + $PrimaryWindow.ToInt64().ToString('x')
        secondaryHwnd = '0x' + $SecondaryWindow.ToInt64().ToString('x')
        foregroundMatches = [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($Window)
        title = [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($Window)
        screenPoints = @()
        members = [ordered]@{}
    }
    # Reuse the already-loaded read-only interop methods. No new screen/window
    # control helper is introduced for failure diagnostics.
    $Flags = [Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static
    $NativeType = [ReShadeClientSdkGate.NativeInputMethods]
    try {
        $Foreground = [IntPtr]$NativeType.GetMethod('GetForegroundWindow', $Flags).Invoke($null, @())
        $Context.actualForegroundHwnd = '0x' + $Foreground.ToInt64().ToString('x')
    } catch { $Context.foregroundQueryError = $_.Exception.Message }
    foreach ($X in @(55, 415)) {
        try {
            $Point = [ReShadeClientSdkGate.NativeInputMethods+POINT]::new()
            $Point.X = $X; $Point.Y = 200
            $Arguments = [object[]]@($Window, $Point)
            if (-not $NativeType.GetMethod('ClientToScreen', $Flags).Invoke($null, $Arguments)) { throw 'Existing ClientToScreen query failed.' }
            $Context.screenPoints += [ordered]@{ clientX = $X; clientY = 200; screenX = $Arguments[1].X; screenY = $Arguments[1].Y }
        } catch { $Context.screenPoints += [ordered]@{ clientX = $X; clientY = 200; error = $_.Exception.Message } }
    }
    foreach ($Member in @('a', 'b')) {
        $State = Read-State $Member
        if ($State) {
            $Context.members[$Member] = [ordered]@{
                processId = $State.processId; attached = $State.attached; targetPid = $State.targetPid
                connectionCount = $State.connectionCount; authenticationCount = $State.authenticationCount
                transportLostCount = $State.transportLostCount; targetDisconnectedCount = $State.targetDisconnectedCount
                surface = $State.surface; fps = $State.fps; fpsCount = $State.fpsCount
                windows = $State.windows; intercepting = $State.intercepting; focusedWindowId = $State.focusedWindowId
            }
        } else { $Context.members[$Member] = $null }
    }
    return $Context
}
function Assert-Pixels([IntPtr]$Window, [bool]$Both = $true) {
    $Probe = [ordered]@{
        schemaVersion = 1; index = $Report.pixelProbes.Count + 1; status = 'pending'
        startedAt = [DateTime]::UtcNow.ToString('o'); bothAppsRequired = $Both
        expectedHwnd = '0x' + $Window.ToInt64().ToString('x')
        expectedA = Convert-PixelColorRef 0x2828c6; expectedB = Convert-PixelColorRef 0xc06515
        attempts = 0; samples = @()
    }
    $Report.pixelProbes += $Probe
    try {
        Assert-Foreground $Window
        Wait-Condition {
            $ColorA = [EgoCooperativeSurfacePixels]::Pixel($Window, 55, 200)
            $ColorB = [EgoCooperativeSurfacePixels]::Pixel($Window, 415, 200)
            $Probe.attempts++
            $Probe.samples += [ordered]@{
                at = [DateTime]::UtcNow.ToString('o')
                a = Convert-PixelColorRef $ColorA; b = Convert-PixelColorRef $ColorB
                foregroundMatches = [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($Window)
            }
            if ($Probe.samples.Count -gt 9) { $Probe.samples = @($Probe.samples[0]) + @($Probe.samples | Select-Object -Last 8) }
            $ColorA -eq 0x2828c6 -and (-not $Both -or $ColorB -eq 0xc06515)
        } 'actual independent app pixels on the current composing surface' 15000
        $Probe.status = 'matched'
    }
    catch { $Probe.status = 'failed'; $Probe.error = $_.Exception.Message; throw }
    finally {
        $Probe.finishedAt = [DateTime]::UtcNow.ToString('o')
        try {
            $Probe.context = Get-PixelProbeContext $Window
            Save-Json $Probe (Join-Path $RunDirectory ('pixel-probe-' + $Probe.index.ToString('000') + '.json'))
        } catch { $Probe.diagnosticError = $_.Exception.Message }
    }
}
function Type-At([string]$Member, [IntPtr]$Window, [string]$Text, [string]$Expected) {
    Assert-Foreground $Window
    $X = if ($Member -eq 'a') { 100 } else { 460 }
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint($Window, $X, 135)
    Start-Sleep -Milliseconds 100
    $Baseline = Wait-ForStableHostTitle -Window $PrimaryWindow -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    if (-not $Baseline.Contains('clip=off')) { throw 'Cursor confinement remained active during overlay interception.' }
    $Other = if ($Member -eq 'a') { 'b' } else { 'a' }
    $OtherBefore = Read-State $Other
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 150
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText($Text)
    Wait-Condition { $State = Read-State $Member; $State.windows.main.value -ceq $Expected -and @($State.windows.main.heldKeys).Count -eq 0 -and $State.focusedWindowId -eq $State.windows.main.id } "$Member actual implicit-click text '$Expected'" 10000
    Start-Sleep -Milliseconds 250
    Assert-Foreground $Window
    $After = [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($PrimaryWindow)
    if ($After -cne $Baseline) { throw "Game input changed while overlay input was intercepted. Before: $Baseline After: $After" }
    if ($OtherBefore -and (Read-State $Other).windows.main.value -cne $OtherBefore.windows.main.value) { throw 'Input reached the other producer.' }
}
function Get-TcpEvidence([object]$State) {
    $Connections = @(Get-NetTCPConnection -State Established -OwningProcess $State.processId -ErrorAction Stop | Where-Object { $_.LocalPort -eq $State.transport.port })
    if ($Connections.Count -ne 1) { throw "Producer $($State.processId) does not own exactly one established private target TCP connection." }
    $Connection = $Connections[0]
    $Peer = @(Get-NetTCPConnection -State Established -OwningProcess $HostProcess.Id -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Connection.RemotePort -and $_.RemotePort -eq $Connection.LocalPort })
    if ($Peer.Count -ne 1) { throw 'The private TCP peer is not the exact controller-owned game process.' }
    return [ordered]@{ localAddress = $Connection.LocalAddress; localPort = $Connection.LocalPort; remoteAddress = $Connection.RemoteAddress; remotePort = $Connection.RemotePort; owningProcess = $Connection.OwningProcess; state = $Connection.State.ToString() }
}
function Snapshot([string]$Member, [string]$Label, [bool]$Tcp = $true) {
    $State = Read-State $Member
    if (-not $State -or -not $State.attached -or $State.authenticatedTarget.pid -ne $ExpectedIdentity.pid -or $State.authenticatedTarget.creationTime100ns -cne $ExpectedIdentity.creationTime100ns -or -not [string]::Equals($State.authenticatedTarget.executablePath, $TargetPath, [StringComparison]::OrdinalIgnoreCase)) { throw "Producer $Member did not authenticate the retained exact target process instance." }
    if ($Tcp) { $State | Add-Member -NotePropertyName tcp -NotePropertyValue (Get-TcpEvidence $State) }
    Save-Json $State (Join-Path $RunDirectory "$Label-$Member-state.json")
    return $State
}
function Wait-Surface([string]$Member, [string]$Hwnd, [int]$Width, [int]$Height, [long]$MinimumFpsCount = 1) {
    Wait-Condition {
        $State = Read-State $Member
        $Surface = $State.surface
        $Surface -and $Surface.pid -eq $HostProcess.Id -and $Surface.hwnd -ieq $Hwnd -and $Surface.graphicsApi -eq 'd3d11' -and $Surface.renderSize.width -eq $Width -and $Surface.renderSize.height -eq $Height -and $State.fpsCount -ge $MinimumFpsCount -and $State.fps.fps -gt 0
    } "$Member advertised exact $Width x $Height composing surface $Hwnd" 20000
}
function Native-Evidence([string]$Label, [string]$Survivor = '') {
    $HostProcess.Refresh()
    $Modules = @($HostProcess.Modules | ForEach-Object { @{ path = $_.FileName; baseAddress = $_.BaseAddress.ToInt64().ToString() } })
    $SnapshotPath = Join-Path $RunDirectory "$Label-modules.json"
    $EvidencePath = Join-Path $RunDirectory "$Label-native.json"
    Save-Json $Modules $SnapshotPath
    $Arguments = @($NativeHelper, '--sdk-a', $SdkDistA, '--sdk-b', $SdkDistB, '--modules-json', $SnapshotPath, '--output', $EvidencePath)
    if ($Survivor) { $Arguments += @('--survivor', $Survivor) }
    & $Node @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Mapped source/hash/build-ID native evidence failed.' }
    $Evidence = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
    foreach ($Member in $(if ($Survivor) { @($Survivor) } else { @('a', 'b') })) {
        $Directory = (Read-State $Member).attachment.runDirectory
        if (@($Evidence.mapped.addons | Where-Object { [string]::Equals((Split-Path -Parent $_.path), $Directory, [StringComparison]::OrdinalIgnoreCase) }).Count -ne 1) { throw "Producer $Member did not map its own exact staged engine." }
    }
    Assert-CooperativeRuntimeHash -Observed $Evidence.mapped.runtime.sha256 -Expected @($Evidence.sdkA.runtimeManifest.reshadeRuntimeSha256)
    return $Evidence
}
function Validate-Lifecycle([string]$Member, [object]$Evidence) {
    $Filename = Join-Path $RunDirectory "$Member-lifecycle-evidence.json"
    Save-Json $Evidence $Filename
    & $Node $LifecycleHelper --report $Filename | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Producer $Member lifecycle evidence failed." }
}
function Assert-NativeLogs {
    $Paths = @(@('a', 'b') | ForEach-Object { (Read-State $_).attachment.reshadeLogPath } | Where-Object { $_ } | Sort-Object -Unique)
    if (-not $Paths.Count) { throw 'No authoritative runtime log was returned.' }
    $Index = 0
    foreach ($Path in $Paths) {
        $Text = Get-Content -LiteralPath $Path -Raw
        [IO.File]::WriteAllText((Join-Path $RunDirectory "native-log-$Index.txt"), $Text)
        if ($Text -match '(?i)out of global sequence|router was reset|input[^\r\n]*(failed|error)|queue[^\r\n]*(failed|error)|FATAL') { throw 'Native input/router fault invalidated lifecycle acceptance.' }
        $Index++
    }
}

if (@(Get-MatchingHosts).Count) { throw 'A controlled graphics host is already running; this gate owns only its newly launched process.' }
if (-not $SkipBuild) {
    & $Nx run client:build
    if ($LASTEXITCODE -ne 0) { throw 'Production client/SDK build failed.' }
    & cmake.exe --build $ProductionBuildRoot --config RelWithDebInfo --target d3d11_overlay_test_host --parallel
    if ($LASTEXITCODE -ne 0) { throw 'Opt-in controlled D3D11 host build failed.' }
}
if (-not (Test-Path -LiteralPath $BuiltHost -PathType Leaf)) { throw "Controlled D3D11 host is missing: $BuiltHost" }
New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination $TargetPath
foreach ($Name in @('reshade-input-gate.enabled', 'reshade-injection-wait.enabled', 'electron-game-overlay-startup-barrier.enabled')) { Request $Name }
Write-Host "Two-app D3D11 secondary-promotion/final-recreation acceptance: $RunDirectory"

try {
    # File-backed stdout supports observing milestones while the host remains
    # alive. This process and every target handle belong to this run only.
    $HostEnvironment = @{}
    try {
        foreach ($Name in @('RESHADE_BASE_PATH_OVERRIDE', 'RESHADE_DISABLE_GRAPHICS_HOOK', 'RESHADE_DISABLE_INPUT_HOOK', 'RESHADE_DISABLE_LOGGING', 'ELECTRON_GAME_OVERLAY_BROKER_PIPE')) {
            $HostEnvironment[$Name] = Get-OverlayProcessEnvironmentVariable -Name $Name
            Set-OverlayProcessEnvironmentVariable -Name $Name -Value $null
        }
        $HostProcess = Start-Process -FilePath $TargetPath -ArgumentList @('--multi-swapchain', '--defer-secondary-present-until-primary-release', '--allow-surface-recreation') -WorkingDirectory $TargetDirectory -WindowStyle Normal -PassThru -RedirectStandardOutput (Join-Path $RunDirectory 'host.stdout.log') -RedirectStandardError (Join-Path $RunDirectory 'host.stderr.log')
    }
    finally { foreach ($Name in $HostEnvironment.Keys) { Set-OverlayProcessEnvironmentVariable -Name $Name -Value $HostEnvironment[$Name] } }
    $null = $HostProcess.Handle
    $ExpectedIdentity = @{ pid = $HostProcess.Id; creationTime100ns = $HostProcess.StartTime.ToFileTimeUtc().ToString(); path = $TargetPath }
    Start-App a $false
    Remove-Item -LiteralPath (Join-Path $TargetDirectory 'electron-game-overlay-startup-barrier.enabled') -Force
    Remove-Item -LiteralPath (Join-Path $TargetDirectory 'reshade-injection-wait.enabled') -Force
    Wait-Condition { (Read-State 'a').attached } 'A exact-process authentication after releasing the graphics barrier' 120000
    $Ready = Wait-HostMarker '(?m)^EGO_CONTROLLED_HOST_MULTI_SWAPCHAIN_READY backend=d3d11 pid=(?<pid>\d+) primaryHwnd=(?<primary>0x[0-9a-f]+) secondaryHwnd=(?<secondary>0x[0-9a-f]+) .*\r?$' 'two already-created graphics surfaces'
    if ([int]$Ready.Groups['pid'].Value -ne $HostProcess.Id) { throw 'Controlled host READY PID mismatch.' }
    $PrimaryHex = $Ready.Groups['primary'].Value
    $SecondaryHex = $Ready.Groups['secondary'].Value
    $PrimaryWindow = [IntPtr]::new([Convert]::ToInt64($PrimaryHex.Substring(2), 16))
    $SecondaryWindow = [IntPtr]::new([Convert]::ToInt64($SecondaryHex.Substring(2), 16))
    if ($PrimaryWindow -eq $SecondaryWindow -or $PrimaryWindow -eq [IntPtr]::Zero -or $SecondaryWindow -eq [IntPtr]::Zero) { throw 'Controlled host did not retain two distinct HWNDs.' }
    $Deferred = Wait-HostMarker '(?m)^EGO_CONTROLLED_HOST_DEFERRED_SECONDARY_READY backend=d3d11 primaryPresentCount=(?<primary>\d+) secondaryPresentCount=0 secondarySwapchainAlive=true\r?$' 'created but never-presented secondary'
    if ([long]$Deferred.Groups['primary'].Value -lt 3) { throw 'Primary did not present before the late join.' }
    Wait-Surface a $PrimaryHex 1280 720
    Activate $PrimaryWindow
    Command a intercept
    Wait-Condition { (Read-State 'a').intercepting } 'A interception'
    Assert-Pixels $PrimaryWindow $false
    Type-At a $PrimaryWindow a a

    # The secondary exists and has received zero Presents before B's engine is
    # mapped; this is the lazy-reference lifetime regression boundary.
    Start-App b
    Wait-Surface b $PrimaryHex 1280 720
    Command b intercept
    Wait-Condition { (Read-State 'a').intercepting -and (Read-State 'b').intercepting } 'two-app effective interception'
    Activate $PrimaryWindow
    Assert-Pixels $PrimaryWindow
    Type-At b $PrimaryWindow b b
    Retain-OwnedChildren
    $BeforeA = Snapshot a primary
    $BeforeB = Snapshot b primary
    if ($BeforeA.windows.main.id -ne $BeforeB.windows.main.id) { throw 'The independent producers did not expose the same process-local window ID collision.' }
    if ($BeforeA.transport.port -eq $BeforeB.transport.port -or $BeforeA.transport.tokenFingerprint -ceq $BeforeB.transport.tokenFingerprint) { throw 'Producers shared a private transport route or credential.' }
    $Report.stages.initial = @{ a = $BeforeA; b = $BeforeB; native = Native-Evidence initial }

    Request 'electron-game-overlay-destroy-primary-surface.request'
    $null = Wait-HostMarker '(?m)^EGO_CONTROLLED_HOST_PRIMARY_GRAPHICS_RELEASED backend=d3d11 .*secondaryPresentCount=0 primaryHwndAlive=true secondaryHwndAlive=true sharedDeviceAlive=true sharedContextAlive=true processAlive=true .*trigger=request\r?$' 'primary destruction before first secondary Present'
    $Remaining = Wait-HostMarker '(?m)^EGO_CONTROLLED_HOST_REMAINING_PRESENT backend=d3d11 remaining=secondary .*presentsAfterPrimaryRelease=(?<after>\d+) primarySwapchainAlive=false secondarySwapchainAlive=true sharedDeviceAlive=true sharedContextAlive=true processAlive=true .*\r?$' 'surviving secondary sustained Presents'
    if ([long]$Remaining.Groups['after'].Value -lt 3) { throw 'The promoted secondary did not sustain three new Presents.' }
    Wait-Surface a $SecondaryHex 960 540 ($BeforeA.fpsCount + 1)
    Wait-Surface b $SecondaryHex 960 540 ($BeforeB.fpsCount + 1)
    Activate $SecondaryWindow
    Wait-Condition { (Read-State 'a').intercepting -and (Read-State 'b').intercepting } 'promoted secondary interception'
    Assert-Pixels $SecondaryWindow
    Type-At a $SecondaryWindow p ap
    Type-At b $SecondaryWindow p bp
    $AfterA = Snapshot a promoted
    $AfterB = Snapshot b promoted
    Validate-Lifecycle a @{ promotion = @{ before = $BeforeA; after = $AfterA } }
    Validate-Lifecycle b @{ promotion = @{ before = $BeforeB; after = $AfterB } }
    if ($AfterA.explicitFocusCount -ne 0 -or $AfterB.explicitFocusCount -ne 0 -or $AfterB.focusedWindowId -ne $AfterB.windows.main.id) { throw 'The final-retirement test requires genuine implicit focus on B, with no explicit-focus replay.' }
    $Report.stages.promoted = @{ a = $AfterA; b = $AfterB; native = Native-Evidence promoted }

    $DrainClock = [Diagnostics.Stopwatch]::StartNew()
    Request 'electron-game-overlay-destroy-final-surface.request'
    Wait-Condition {
        $Ack = Join-Path $TargetDirectory 'electron-game-overlay-final-surface-destroyed.ack'
        (Test-Path -LiteralPath $Ack -PathType Leaf) -and [IO.File]::ReadAllText($Ack) -ceq "graphics-destroyed`n" -and $null -eq (Read-State 'a').surface -and $null -eq (Read-State 'b').surface -and (Read-State 'a').focusedWindowId -eq 0 -and (Read-State 'b').focusedWindowId -eq 0
    } 'both final-surface tombstones and native focus release within the strict 2000ms bound' 2000
    $DrainClock.Stop()
    $DestroyedA = Snapshot a destroyed $false
    $DestroyedB = Snapshot b destroyed $false
    $Report.stages.destroyed = @{ a = $DestroyedA; b = $DestroyedB; drainMilliseconds = $DrainClock.ElapsedMilliseconds }
    Start-Sleep -Milliseconds 350
    Assert-OwnedAlive
    if ((Read-State 'a').surface -or (Read-State 'b').surface) { throw 'A destroyed surface returned before the explicit recreation request.' }

    Request 'electron-game-overlay-recreate-surfaces.request'
    $null = Wait-HostMarker '(?m)^EGO_CONTROLLED_HOST_SURFACES_RECREATED backend=d3d11 primaryHwnd=(?<primary>0x[0-9a-f]+) secondaryHwnd=(?<secondary>0x[0-9a-f]+) sameWindows=true processAlive=true\r?$' 'graphics recreation on the same live HWNDs'
    if ($script:HostMatch.Groups['primary'].Value -ine $PrimaryHex -or $script:HostMatch.Groups['secondary'].Value -ine $SecondaryHex) { throw 'Graphics recreation replaced a retained HWND.' }
    Wait-Surface a $PrimaryHex 1280 720 ($AfterA.fpsCount + 1)
    Wait-Surface b $PrimaryHex 1280 720 ($AfterB.fpsCount + 1)
    Activate $PrimaryWindow
    Assert-Pixels $PrimaryWindow
    Wait-Condition { (Read-State 'a').intercepting -and (Read-State 'b').intercepting } 'recreated surface interception'
    $RemadeA = Snapshot a remade
    $RemadeB = Snapshot b remade
    # No API focus, pointer click, or DOM mutation occurs before this SendInput.
    Assert-Foreground $PrimaryWindow
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText('z')
    Start-Sleep -Milliseconds 500
    Assert-Foreground $PrimaryWindow
    $UnfocusedA = Snapshot a no-implicit-focus
    $UnfocusedB = Snapshot b no-implicit-focus
    Validate-Lifecycle a @{ promotion = @{ before = $BeforeA; after = $AfterA }; recreation = @{ before = $AfterA; destroyed = $DestroyedA; after = $RemadeA }; noImplicitFocus = @{ before = $RemadeA; after = $UnfocusedA; sent = 'z' } }
    Validate-Lifecycle b @{ promotion = @{ before = $BeforeB; after = $AfterB }; recreation = @{ before = $AfterB; destroyed = $DestroyedB; after = $RemadeB }; noImplicitFocus = @{ before = $RemadeB; after = $UnfocusedB; sent = 'z' } }
    $Report.stages.recreated = @{ a = $UnfocusedA; b = $UnfocusedB; native = Native-Evidence recreated; rejectedImplicitInput = 'z' }

    Command b focus
    Wait-Condition { (Read-State 'b').focusedWindowId -eq (Read-State 'b').windows.main.id } 'explicit focus after true final recreation'
    Assert-Foreground $PrimaryWindow
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText('e')
    Wait-Condition { (Read-State 'b').windows.main.value -ceq 'bpe' -and @((Read-State 'b').windows.main.heldKeys).Count -eq 0 } 'explicit focus resumes B input without changing its window ID'
    Retain-OwnedChildren
    Command a exit
    if (-not $Apps.a.process.WaitForExit(10000)) { throw 'App A did not finish its requested graceful shutdown.' }
    Wait-Condition { (Read-State 'b').intercepting } 'remaining app keeps interception after A exit'
    Assert-Foreground $PrimaryWindow
    [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText('s')
    Wait-Condition { (Read-State 'b').windows.main.value -ceq 'bpes' } 'B retains focused input after A shutdown'
    Wait-Condition { [EgoCooperativeSurfacePixels]::Pixel($PrimaryWindow, 55, 200) -ne 0x2828c6 -and [EgoCooperativeSurfacePixels]::Pixel($PrimaryWindow, 415, 200) -eq 0xc06515 } 'only surviving B scene remains'
    $SurvivorB = Snapshot b survivor
    if ($SurvivorB.authenticationCount -ne $UnfocusedB.authenticationCount -or $SurvivorB.connectionCount -ne $UnfocusedB.connectionCount -or $SurvivorB.transportLostCount -ne $UnfocusedB.transportLostCount -or $SurvivorB.tcp.remotePort -ne $UnfocusedB.tcp.remotePort) { throw 'Peer shutdown reconnected or replaced B private transport.' }
    $Report.stages.survivor = @{ b = $SurvivorB; native = Native-Evidence survivor b }
    Command b release
    Wait-Condition { -not (Read-State 'b').intercepting } 'survivor releases aggregate interception'
    Assert-Foreground $PrimaryWindow
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint($PrimaryWindow, 900, 650)
    $ReleasedBefore = Get-HostInputSnapshot -Title (Wait-ForStableHostTitle -Window $PrimaryWindow -Deadline ([DateTime]::UtcNow.AddSeconds(8)))
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Wait-Condition { $Current = Get-HostInputSnapshot -Title ([ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($PrimaryWindow)); $Current.Down -gt $ReleasedBefore.Down -and $Current.Up -gt $ReleasedBefore.Up } 'released mouse down and up reach the actual host oracle'
    Assert-NativeLogs
    [ReShadeClientSdkGate.NativeInputMethods]::RequestClose($PrimaryWindow)
    if (-not $HostProcess.WaitForExit(10000) -or $HostProcess.ExitCode -ne 0) { throw 'Controlled host did not exit normally after release.' }
    $Report.status = 'passed'
}
catch { $Report.error = $_.Exception.ToString(); throw }
finally {
    $CleanupFailures = [Collections.Generic.List[string]]::new()
    try { Retain-OwnedChildren } catch { $CleanupFailures.Add($_.Exception.Message) }
    foreach ($Member in @('a', 'b')) {
        if (-not $Apps.ContainsKey($Member)) { continue }
        $Entry = $Apps[$Member]
        foreach ($Process in @($Entry.children.ToArray()) + @($Entry.process)) {
            try { if (-not $Process.HasExited) { $Process.Kill() }; if (-not $Process.WaitForExit(5000)) { throw 'Owned Electron process did not exit.' } } catch { $CleanupFailures.Add($_.Exception.Message) }
        }
        foreach ($Stream in @('stdout', 'stderr')) {
            try { if (-not $Entry[$Stream].Wait(5000)) { throw 'Owned Electron output did not finish.' }; [IO.File]::WriteAllText((Join-Path $RunDirectory "$Member.$Stream.log"), $Entry[$Stream].GetAwaiter().GetResult()) } catch { $CleanupFailures.Add($_.Exception.Message) }
        }
    }
    if ($HostProcess) {
        try { if (-not $HostProcess.HasExited) { $HostProcess.CloseMainWindow() | Out-Null; if (-not $HostProcess.WaitForExit(2000)) { $HostProcess.Kill() } }; if (-not $HostProcess.WaitForExit(5000)) { throw 'Owned controlled host did not exit.' } } catch { $CleanupFailures.Add($_.Exception.Message) }
    }
    if ($CleanupFailures.Count) { $Report.cleanupErrors = $CleanupFailures.ToArray(); $Report.status = 'failed' }
    Save-Json $Report (Join-Path $RunDirectory 'report.json')
    if ($CleanupFailures.Count -and -not $Report.error) { throw "Owned-process cleanup failed: $($CleanupFailures -join '; ')" }
}
if ($Report.status -eq 'passed') { Write-Host 'D3D11_TWO_APP_SURFACE_LIFECYCLE_REAL_CLIENT_SDK_GATE_PASS' }
