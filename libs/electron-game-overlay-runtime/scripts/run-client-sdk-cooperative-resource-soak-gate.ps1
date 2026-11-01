[CmdletBinding()]
param(
    [string]$TargetExecutable,
    [string[]]$TargetArguments = @(),
    [string]$ElectronExecutable,
    [string]$SdkDist,
    [ValidateRange(1, 64)][int]$Cycles = 8,
    [switch]$FunctionsOnly
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
. (Join-Path $PSScriptRoot 'cooperative-resource-snapshot.ps1')

function ConvertTo-SoakWindowsArgument([AllowEmptyString()][string]$Argument) {
    if ($Argument.Contains([char]0)) { throw 'A process argument contains NUL.' }
    $Result = [Text.StringBuilder]::new()
    $null = $Result.Append('"')
    $Backslashes = 0
    foreach ($Character in $Argument.ToCharArray()) {
        if ($Character -eq '\') { $Backslashes++; continue }
        $Count = if ($Character -eq '"') { 2 * $Backslashes + 1 } else { $Backslashes }
        if ($Count) { $null = $Result.Append(('\' * $Count)) }
        $null = $Result.Append($Character)
        $Backslashes = 0
    }
    if ($Backslashes) { $null = $Result.Append(('\' * (2 * $Backslashes))) }
    $null = $Result.Append('"')
    return $Result.ToString()
}

function New-SoakStartInfo([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [bool]$Visible = $false) {
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = $Executable
    $Info.WorkingDirectory = $WorkingDirectory
    $Info.UseShellExecute = $false
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $Info.CreateNoWindow = -not $Visible
    $Info.WindowStyle = if ($Visible) { [Diagnostics.ProcessWindowStyle]::Normal } else { [Diagnostics.ProcessWindowStyle]::Hidden }
    $Info.Arguments = ($Arguments | ForEach-Object { ConvertTo-SoakWindowsArgument $_ }) -join ' '
    if ($Info.Arguments.Length + $Executable.Length -gt 32760) { throw 'The controlled process command line exceeds its explicit bound.' }
    foreach ($Name in @('RESHADE_BASE_PATH_OVERRIDE', 'RESHADE_DISABLE_GRAPHICS_HOOK', 'RESHADE_DISABLE_INPUT_HOOK', 'RESHADE_DISABLE_LOGGING', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_GAME_OVERLAY_BROKER_PIPE')) { $Info.EnvironmentVariables.Remove($Name) }
    return $Info
}

function Test-SoakPath([string]$Left, [string]$Right) {
    return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)
}

function New-SoakOwnedPaths([string]$Root, [string]$RunId, [string]$TargetId) {
    if ($RunId -cnotmatch '^[a-f0-9]{32}$' -or $TargetId -cnotmatch '^[a-f0-9]{32}$') { throw 'Owned soak paths require canonical GUID identifiers.' }
    $Run = Join-Path $Root ('build\cooperative-resource-soak\r-' + $RunId.Substring(0, 16))
    $Directory = Join-Path $Run 'target'
    return [ordered]@{ run = $Run; targetDirectory = $Directory; target = (Join-Path $Directory ('ego-soak-' + $TargetId.Substring(0, 8) + '.exe')) }
}

function Assert-SoakStagedPathBudget([string]$ProducerDirectory, [string]$Member, [string]$TargetLeaf, [string[]]$AssetNames) {
    if ($Member -cnotmatch '^[a-z][a-z0-9-]{0,31}$' -or $TargetLeaf -cnotmatch '^ego-soak-[a-f0-9]{8}\.exe$' -or $AssetNames.Count -eq 0) { throw 'Invalid soak staged-path budget inputs.' }
    $Stage = Join-Path (Join-Path (Join-Path $ProducerDirectory ('runs-' + $Member)) 'cycle-1024') ($TargetLeaf + '-XXXXXX')
    $Longest = ''
    foreach ($Name in $AssetNames) {
        if (-not $Name -or [IO.Path]::GetFileName($Name) -cne $Name) { throw 'A staged asset name escaped its flat runtime directory.' }
        $Projected = Join-Path $Stage $Name
        if ($Projected.Length -gt $Longest.Length) { $Longest = $Projected }
    }
    if ($Longest.Length -gt 240) { throw "The owned soak staged path exceeds its 240-character Windows budget: $Longest" }
    return [ordered]@{ maximumCharacters = 240; longestProjectedCharacters = $Longest.Length; longestProjectedAsset = $Longest }
}

function Test-SoakResourceCounts([object]$Snapshot, [object[]]$KnownNative, [string[]]$ActivePaths, [uint32[]]$RetainedFrameIds, [uint32]$SurvivorTcpId) {
    if (-not $Snapshot -or $Snapshot.registry.lifetimeSlots -ne $KnownNative.Count -or $Snapshot.registry.activeParticipants -ne $KnownNative.Count -or
        $Snapshot.frameThreads -ne $KnownNative.Count -or $Snapshot.tcpThreads -ne $ActivePaths.Count -or
        $Snapshot.registry.windows -ne $ActivePaths.Count -or $Snapshot.registry.ranks -ne $ActivePaths.Count) { return $false }
    $NativeModules = @($Snapshot.modules | Where-Object { [IO.Path]::GetFileName($_.path) -ieq 'electron_game_overlay.addon64' })
    if ($NativeModules.Count -ne $KnownNative.Count) { return $false }
    $ActiveIds = [Collections.Generic.HashSet[uint64]]::new()
    foreach ($Identity in $KnownNative) {
        if (@($NativeModules | Where-Object { Test-SoakPath $_.path $Identity.path }).Count -ne 1) { return $false }
        $Participants = @($Snapshot.registry.participants | Where-Object { $_.id -ne 0 -and (Test-SoakPath $_.modulePath $Identity.path) })
        if ($Participants.Count -ne 1) { return $false }
        $Active = @($ActivePaths | Where-Object { Test-SoakPath $_ $Identity.path }).Count -eq 1
        $ExpectedWindows = if ($Active) { 1 } else { 0 }
        if ($Active) { $null = $ActiveIds.Add([uint64]$Participants[0].id) }
        if ($Participants[0].windows -ne $ExpectedWindows -or $Participants[0].ranks -ne $ExpectedWindows -or (-not $Active -and $Participants[0].interception -ne 0)) { return $false }
    }
    if ($Snapshot.registry.focus.participant -ne 0 -and -not $ActiveIds.Contains([uint64]$Snapshot.registry.focus.participant)) { return $false }
    if ($Snapshot.registry.capture.participant -ne 0 -and -not $ActiveIds.Contains([uint64]$Snapshot.registry.capture.participant)) { return $false }
    if ($Snapshot.registry.captureButtons -ne 0 -and $Snapshot.registry.capture.participant -eq 0) { return $false }
    foreach ($Id in $RetainedFrameIds) { if ($Id -notin @($Snapshot.frameThreadIds)) { return $false } }
    if ($SurvivorTcpId -ne 0 -and $SurvivorTcpId -notin @($Snapshot.tcpThreadIds)) { return $false }
    return $true
}

function Save-SoakJson([object]$Value, [string]$Path) { $Value | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath $Path -Encoding UTF8 }

function New-SoakProducerLaunchEvidence([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [object]$Process) {
    if (-not [IO.Path]::IsPathRooted($Executable) -or -not [IO.Path]::IsPathRooted($WorkingDirectory) -or $Arguments.Count -lt 1 -or $Arguments.Count -gt 16 -or -not [IO.Path]::IsPathRooted($Arguments[0])) { throw 'Producer launch evidence requires bounded absolute executable, fixture and working-directory paths.' }
    $Total = 0
    for ($Index = 0; $Index -lt $Arguments.Count; $Index++) {
        $Argument = $Arguments[$Index]
        if ($null -eq $Argument -or $Argument.Contains([char]0) -or $Argument.Length -gt 32768 -or ($Index -gt 0 -and $Argument -cnotmatch '^--(member|slot|evidence|sdk-dist|game|pid|max-cycles)=')) { throw 'Producer launch evidence refuses unknown or credential-bearing argument fields.' }
        $Total += $Argument.Length
    }
    if ($Total -gt 32760) { throw 'Producer launch evidence argument bytes exceed their explicit bound.' }
    return [ordered]@{
        schemaVersion = 1; scope = 'Exact controller-supplied producer argv; no environment or transport credentials.'
        launchedAtUtc = [DateTime]::UtcNow.ToString('o'); executable = $Executable; arguments = @($Arguments); workingDirectory = $WorkingDirectory
        processId = $Process.Id; creationTime100ns = $Process.StartTime.ToFileTimeUtc().ToString()
    }
}

function New-SoakProducerLifecycleEvidence([object]$Entry, [ValidateSet('started', 'ready', 'wait-timeout', 'unexpected-exit', 'producer-error', 'graceful-exit', 'cleanup-before-force', 'cleanup-complete')][string]$Phase, [string]$Reason = '') {
    $Record = [ordered]@{
        schemaVersion = 1; phase = $Phase; observedAtUtc = [DateTime]::UtcNow.ToString('o'); member = $Entry.member
        processId = $Entry.launch.processId; creationTime100ns = $Entry.launch.creationTime100ns; expectedExit = [bool]$Entry.expectedExit
        hasExited = $null; exitCode = $null; exitTimeUtc = $null; observedIdentityMatchesLaunch = $null
        producerStateFileExists = [IO.File]::Exists((Join-Path $Entry.directory ($Entry.member + '-state.json')))
        producerSdkFileExists = [IO.File]::Exists((Join-Path $Entry.directory ($Entry.member + '-sdk.json')))
        reason = $Reason.Substring(0, [Math]::Min(512, $Reason.Length))
    }
    try {
        $Entry.process.Refresh()
        $Record.observedIdentityMatchesLaunch = $Entry.process.Id -eq $Entry.launch.processId -and $Entry.process.StartTime.ToFileTimeUtc().ToString() -ceq $Entry.launch.creationTime100ns
        $Record.hasExited = [bool]$Entry.process.HasExited
        if ($Record.hasExited) { $Record.exitCode = $Entry.process.ExitCode; $Record.exitTimeUtc = $Entry.process.ExitTime.ToUniversalTime().ToString('o') }
    } catch { $Record.observationError = $_.Exception.GetType().FullName }
    return $Record
}

function Save-SoakProducerLifecycle([object]$Entry, [string]$Phase, [string]$Reason = '') {
    $Entry.lifecycleSequence++
    if ($Entry.lifecycleSequence -gt 64) { throw 'Producer lifecycle evidence exceeded its explicit event bound.' }
    $Record = New-SoakProducerLifecycleEvidence $Entry $Phase $Reason
    Save-SoakJson $Record (Join-Path $Entry.directory ('process-lifecycle-' + $Entry.lifecycleSequence.ToString('000') + '-' + $Phase + '.json'))
    Save-SoakJson $Record (Join-Path $Entry.directory 'process-lifecycle-latest.json')
}

function Read-SoakState([object]$Entry) {
    $Stream = $null; $Reader = $null
    try {
        $Stream = [IO.FileStream]::new((Join-Path $Entry.directory ($Entry.member + '-state.json')), [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        if ($Stream.Length -le 0 -or $Stream.Length -gt 4MB) { throw 'The producer state size is out of bounds.' }
        $Reader = [IO.StreamReader]::new($Stream, [Text.Encoding]::UTF8, $true, 4096, $false)
        $Text = $Reader.ReadToEnd()
        if ($Text.Length -gt 4MB) { throw 'The producer state size is out of bounds.' }
        return $Text | ConvertFrom-Json
    } catch { return $null }
    finally { if ($Reader) { $Reader.Dispose() }; if ($Stream) { $Stream.Dispose() } }
}

function Assert-SoakOwnedAlive {
    $Target.Refresh()
    if ($Target.HasExited) { throw 'The controller-owned graphics target exited during resource acceptance.' }
    foreach ($Entry in $Entries) {
        $State = Read-SoakState $Entry
        if ($State -and $State.error) { Save-SoakProducerLifecycle $Entry 'producer-error' 'Producer state reported an error.'; throw "Producer $($Entry.member) failed: $($State.error)" }
        if (-not $Entry.expectedExit) {
            $Entry.process.Refresh()
            if ($Entry.process.HasExited) { Save-SoakProducerLifecycle $Entry 'unexpected-exit' 'The producer exited before its expected lifecycle boundary.'; throw "Producer $($Entry.member) exited unexpectedly." }
        }
    }
}

function Wait-SoakCondition([scriptblock]$Predicate, [string]$Label, [int]$Seconds = 30) {
    $Deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        Assert-SoakOwnedAlive
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 50
    }
    foreach ($Entry in $Entries) { Save-SoakProducerLifecycle $Entry 'wait-timeout' $Label }
    throw "Timed out waiting for $Label. Last snapshot error: $script:LastSnapshotError. Evidence: $RunDirectory"
}

function Test-SoakCimCreation([datetime]$Actual, [object]$Observed) {
    if ($Observed -isnot [datetime]) { return $false }
    # Win32_Process CreationDate carries microseconds, while the retained
    # process handle exposes 100 ns ticks. Compare at the reported precision.
    return [long][Math]::Floor($Actual.ToUniversalTime().Ticks / 10D) -eq [long][Math]::Floor($Observed.ToUniversalTime().Ticks / 10D)
}

function Retain-SoakChildren([object]$Entry) {
    if ($Entry.process.HasExited) { return }
    $Snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $Records = @{}
    foreach ($Record in $Snapshot) { $Records[[int]$Record.ProcessId] = $Record }
    $Parents = [Collections.Generic.Dictionary[int, Diagnostics.Process]]::new()
    $Parents.Add($Entry.process.Id, $Entry.process)
    foreach ($Child in $Entry.children) { if (-not $Child.HasExited) { $Parents[$Child.Id] = $Child } }
    do {
        $Changed = $false
        foreach ($Record in $Snapshot) {
            if ($Record.ProcessId -eq $Entry.process.Id -or $Entry.childIds.Contains([int]$Record.ProcessId) -or
                -not $Parents.ContainsKey([int]$Record.ParentProcessId) -or -not (Test-SoakPath $Record.ExecutablePath $ElectronExecutable)) { continue }
            $Parent = $Parents[[int]$Record.ParentProcessId]
            if ($Parent.HasExited -or -not $Records.ContainsKey($Parent.Id) -or -not (Test-SoakCimCreation $Parent.StartTime $Records[$Parent.Id].CreationDate)) { continue }
            $Child = Get-Process -Id $Record.ProcessId -ErrorAction SilentlyContinue
            if (-not $Child) { continue }
            try {
                $null = $Child.Handle
                if (-not (Test-SoakCimCreation $Child.StartTime $Record.CreationDate) -or $Child.StartTime -lt $Parent.StartTime -or
                    -not (Test-SoakPath $Child.MainModule.FileName $Record.ExecutablePath)) { $Child.Dispose(); continue }
                $Entry.children.Add($Child); $null = $Entry.childIds.Add($Child.Id); $Parents[$Child.Id] = $Child; $Changed = $true
            } catch { $Child.Dispose(); throw }
        }
    } while ($Changed)
}

function Start-SoakOwned([Diagnostics.ProcessStartInfo]$Info) {
    $Process = [Diagnostics.Process]::new(); $Process.StartInfo = $Info
    if (-not $Process.Start()) { throw "Could not start owned process $($Info.FileName)." }
    $null = $Process.Handle
    return $Process
}

function Start-SoakApp([string]$Member, [string]$Slot, [int]$Restart, [bool]$WaitForAuthentication = $true) {
    $Directory = Join-Path $RunDirectory ("producers\$Member-$Restart")
    New-Item -ItemType Directory -Path $Directory | Out-Null
    $Arguments = @($Fixture, "--member=$Member", "--slot=$Slot", "--evidence=$Directory", "--sdk-dist=$SdkDist", "--game=$TargetPath", "--pid=$($Target.Id)", '--max-cycles=2')
    $Process = Start-SoakOwned (New-SoakStartInfo $ElectronExecutable $Arguments $RepoRoot)
    $Entry = @{ member = $Member; directory = $Directory; process = $Process; startedAt = $Process.StartTime; expectedExit = $false; lifecycleSequence = 0; stdout = $Process.StandardOutput.ReadToEndAsync(); stderr = $Process.StandardError.ReadToEndAsync(); children = [Collections.Generic.List[Diagnostics.Process]]::new(); childIds = [Collections.Generic.HashSet[int]]::new() }
    $Entries.Add($Entry)
    $Entry.launch = New-SoakProducerLaunchEvidence $ElectronExecutable $Arguments $RepoRoot $Process
    Save-SoakJson $Entry.launch (Join-Path $Directory 'process-launch.json')
    Save-SoakProducerLifecycle $Entry 'started'
    Wait-SoakCondition { $State = Read-SoakState $Entry; $State -and $State.ready -and $State.injectorReturned -and $State.cycle -eq 1 -and (-not $WaitForAuthentication -or ($State.attached -and $State.rendering)) } "$Member injector proof$(if ($WaitForAuthentication) { ' and authenticated/rendering cycle 1' })" 50
    Retain-SoakChildren $Entry
    Save-SoakProducerLifecycle $Entry 'ready'
    return $Entry
}

function Send-SoakCommand([object]$Entry, [string]$Action) {
    $script:CommandSequence++
    $Sequence = $script:CommandSequence
    $Destination = Join-Path $Entry.directory ($Entry.member + '-command.json')
    Save-SoakJson @{ sequence = $Sequence; action = $Action } "$Destination.tmp"
    Move-Item -LiteralPath "$Destination.tmp" -Destination $Destination -Force
    if ($Action -eq 'exit') { $Entry.expectedExit = $true }
    Wait-SoakCondition { $State = Read-SoakState $Entry; $State -and $State.commandSequence -eq $Sequence } "$($Entry.member) command $Action"
}

function Assert-SoakAuthentication([object]$Entry, [object]$State) {
    if (-not $State -or -not $State.activeSession -or -not $State.attached -or -not $State.rendering -or $State.processId -ne $Entry.process.Id -or
        $State.targetPid -ne $Target.Id -or $State.authenticatedTarget.pid -ne $Target.Id -or $State.authenticatedTarget.creationTime100ns -cne $TargetCreation -or
        -not (Test-SoakPath $State.authenticatedTarget.executablePath $TargetPath) -or $State.transport.producerPid -ne $Entry.process.Id -or $State.transport.targetPid -ne $Target.Id -or
        $State.transport.tokenFingerprint -cnotmatch '^[a-f0-9]{64}$' -or -not $State.windows.main.visible -or $State.windows.main.paints -lt 1) { throw 'The producer did not retain exact-process authenticated private-route/window proof.' }
}

function Get-SoakTcp([object]$Entry, [object]$State) {
    $Connections = @(Get-NetTCPConnection -State Established -OwningProcess $Entry.process.Id -ErrorAction Stop | Where-Object { $_.LocalPort -eq $State.transport.port })
    if ($Connections.Count -ne 1) { throw 'A producer does not have exactly one established private TCP connection.' }
    $Connection = $Connections[0]
    $Peer = @(Get-NetTCPConnection -State Established -OwningProcess $Target.Id -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Connection.RemotePort -and $_.RemotePort -eq $Connection.LocalPort })
    if ($Peer.Count -ne 1) { throw 'A private producer TCP connection does not terminate in the exact owned target.' }
    return [ordered]@{ localAddress = $Connection.LocalAddress; localPort = $Connection.LocalPort; remoteAddress = $Connection.RemoteAddress; remotePort = $Connection.RemotePort; owningProcess = $Connection.OwningProcess }
}

function Get-SoakTargetEstablished {
    # Query the complete OS table so an empty exact-target result remains a
    # successful query, rather than suppressing a failed per-PID query.
    return @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $Target.Id -and $_.State.ToString() -eq 'Established' })
}

function Wait-SoakResources([string]$Label, [string[]]$ActivePaths) {
    $script:LastSnapshotError = $null; $script:CurrentSnapshot = $null
    Wait-SoakCondition {
        try {
            $Candidate = Get-CooperativeResourceSnapshot -Process $Target -ExpectedCreationTime100ns $TargetCreation
            if (Test-SoakResourceCounts $Candidate @($KnownNative) $ActivePaths @($RetainedFrameIds) $SurvivorTcpId) { $script:CurrentSnapshot = $Candidate; return $true }
            $script:LastSnapshotError = "Observed slots=$($Candidate.registry.lifetimeSlots), participants=$($Candidate.registry.activeParticipants), frame=$($Candidate.frameThreads), tcp=$($Candidate.tcpThreads), windows=$($Candidate.registry.windows), ranks=$($Candidate.registry.ranks)"
        } catch { $script:LastSnapshotError = $_.Exception.Message }
        return $false
    } $Label 45
    Save-SoakJson $script:CurrentSnapshot (Join-Path $RunDirectory ($Label + '-resources.json'))
    return $script:CurrentSnapshot
}

function Assert-SoakSurvivor([long]$AfterFpsAt) {
    Wait-SoakCondition { $State = Read-SoakState $Survivor; $State -and $State.lastFpsAt -gt $AfterFpsAt } 'fresh survivor FPS observation after churn' 20
    $State = Read-SoakState $Survivor
    Assert-SoakAuthentication $Survivor $State
    if ($State.cycle -ne 1 -or $State.native.path -cne $SurvivorIdentity.path -or $State.runDirectory -cne $SurvivorRunDirectory -or $State.transport.tokenFingerprint -cne $SurvivorFingerprint -or $State.transport.port -ne $SurvivorPort) { throw 'Churn changed the survivor cycle, staged engine or private route.' }
    $Tcp = Get-SoakTcp $Survivor $State
    if (($Tcp | ConvertTo-Json -Compress) -cne ($SurvivorTcp | ConvertTo-Json -Compress)) { throw 'Churn replaced the survivor established TCP connection.' }
    return $State
}

function Stop-SoakApp([object]$Entry) {
    Retain-SoakChildren $Entry
    Send-SoakCommand $Entry 'exit'
    if (-not $Entry.process.WaitForExit(15000) -or $Entry.process.ExitCode -ne 0) { throw 'An owned Electron producer did not exit gracefully with code 0.' }
    foreach ($Child in $Entry.children) { if (-not $Child.WaitForExit(15000)) { throw 'An owned Electron child survived graceful producer exit.' } }
    Save-SoakProducerLifecycle $Entry 'graceful-exit'
}

function Save-SoakAppLogs([object]$Entry) {
    if ($Entry.process.HasExited) {
        if (-not $Entry.stdout.Wait(10000) -or -not $Entry.stderr.Wait(10000)) { throw 'Owned producer output streams did not close after process cleanup.' }
        [IO.File]::WriteAllText((Join-Path $Entry.directory 'stdout.log'), $Entry.stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $Entry.directory 'stderr.log'), $Entry.stderr.GetAwaiter().GetResult())
    }
}

if ($FunctionsOnly) { return }
if (-not [Environment]::Is64BitProcess) { throw 'Run this x64-only SDK resource gate from a 64-bit PowerShell process.' }
if (-not $TargetExecutable) { throw 'TargetExecutable must identify a controller-owned graphics test artifact under this workspace build directory.' }
if (-not $ElectronExecutable) { $ElectronExecutable = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' }
if (-not $SdkDist) { $SdkDist = Join-Path $RepoRoot 'libs\electron-game-overlay\dist' }
$TargetSource = (Resolve-Path -LiteralPath $TargetExecutable).Path
$BuildPrefix = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'build')) + [IO.Path]::DirectorySeparatorChar
if (-not $TargetSource.StartsWith($BuildPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($TargetSource) -ine '.exe') { throw 'This gate accepts only controlled graphics .exe artifacts under this workspace build directory.' }
$SourceBytes = [IO.File]::ReadAllBytes($TargetSource)
if ($SourceBytes.Length -lt 64 -or $SourceBytes.Length -gt 128MB -or [BitConverter]::ToUInt16($SourceBytes, 0) -ne 0x5a4d) { throw 'The controlled target PE image is invalid or out of bounds.' }
$PeOffset = [BitConverter]::ToUInt32($SourceBytes, 60)
if ($PeOffset -lt 64 -or $PeOffset -gt $SourceBytes.Length - 24 -or [BitConverter]::ToUInt32($SourceBytes, $PeOffset) -ne 0x4550 -or [BitConverter]::ToUInt16($SourceBytes, $PeOffset + 4) -ne 0x8664) { throw 'The controlled target must be an x64 PE image.' }
$SourceBytes = $null
if (@(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($TargetSource)) -ErrorAction SilentlyContinue).Count) { throw 'A matching controlled target is already running; refusing to use or terminate it.' }
$ElectronExecutable = (Resolve-Path -LiteralPath $ElectronExecutable).Path
$SdkDist = (Resolve-Path -LiteralPath $SdkDist).Path
$Node = (Get-Command node.exe -CommandType Application -All -ErrorAction Stop | Select-Object -First 1).Source
$Fixture = Join-Path $RepoRoot 'apps\client\scripts\cooperative-resource-soak-fixture.cjs'
$EvidenceHelper = Join-Path $RepoRoot 'apps\client\scripts\cooperative-resource-soak-evidence.cjs'
$OwnedPaths = New-SoakOwnedPaths $RepoRoot ([Guid]::NewGuid().ToString('N')) ([Guid]::NewGuid().ToString('N'))
$RunDirectory = $OwnedPaths.run
$TargetDirectory = $OwnedPaths.targetDirectory
$TargetPath = $OwnedPaths.target
$AssetNames = @((Get-ChildItem -LiteralPath (Join-Path $SdkDist 'runtime\win32-x64\reshade') -File).Name) + @('.electron-game-overlay-runtime-startup.json', '.electron-game-overlay-run-reclaimable.json', 'electron-overlay-transport-v1.json')
$PathBudgets = @(
    (Assert-SoakStagedPathBudget (Join-Path $RunDirectory 'producers\survivor-1') 'survivor' ([IO.Path]::GetFileName($TargetPath)) $AssetNames),
    (Assert-SoakStagedPathBudget (Join-Path $RunDirectory 'producers\churn-32') 'churn' ([IO.Path]::GetFileName($TargetPath)) $AssetNames)
)
New-Item -ItemType Directory -Path $RunDirectory -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $TargetDirectory -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath $TargetSource -Destination $TargetPath
$SourceHash = (Get-FileHash -LiteralPath $TargetSource -Algorithm SHA256).Hash
if ((Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash -cne $SourceHash) { throw 'The owned target copy differs from its source artifact.' }
$StartupMarker = Join-Path $TargetDirectory 'electron-game-overlay-startup-barrier.enabled'
$RuntimeWaitMarker = Join-Path $TargetDirectory 'reshade-injection-wait.enabled'
$MarkerContents = [Guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($StartupMarker, $MarkerContents)
[IO.File]::WriteAllText($RuntimeWaitMarker, $MarkerContents)
$Entries = [Collections.Generic.List[object]]::new()
$KnownNative = [Collections.Generic.List[object]]::new()
$RetainedFrameIds = [Collections.Generic.List[uint32]]::new()
$CommandSequence = 0; $SurvivorTcpId = 0; $Target = $null; $Churn = $null
$Report = [ordered]@{ schemaVersion = 1; status = 'failed'; scope = 'Owned x64 graphics target and genuine public-SDK producers; exact current module/participant/window/named-thread/TCP observations. No pixel, physical input, GPU reclamation or 500-app capacity claim.'; cyclesRequested = $Cycles; targetSource = $TargetSource; targetSourceSha256 = $SourceHash; evidence = $RunDirectory; stagedPathBudgets = $PathBudgets; cycles = @(); error = $null; cleanupErrors = @() }
try {
    $Target = Start-SoakOwned (New-SoakStartInfo $TargetPath $TargetArguments $TargetDirectory $true)
    $TargetStdout = $Target.StandardOutput.ReadToEndAsync(); $TargetStderr = $Target.StandardError.ReadToEndAsync()
    $TargetCreation = $Target.StartTime.ToFileTimeUtc().ToString()
    $Report.target = @{ pid = $Target.Id; creationTime100ns = $TargetCreation; executable = $TargetPath; arguments = $TargetArguments }
    $Survivor = Start-SoakApp 'survivor' 'survivor' 1 $false
    $StartupProof = Read-SoakState $Survivor
    if ($StartupProof.injectorProof.runtimeMode -cne 'injected-runtime' -or $StartupProof.injectorProof.injectorTargetPid -ne $Target.Id -or
        $StartupProof.selectedTarget.pid -ne $Target.Id -or $StartupProof.selectedTarget.creationTime100ns -cne $TargetCreation -or
        -not (Test-SoakPath $StartupProof.selectedTarget.executablePath $TargetPath)) { throw 'First-injection full-runtime proof did not match the retained controlled target instance.' }
    Save-SoakJson $StartupProof (Join-Path $RunDirectory 'startup-full-runtime-proof.json')
    foreach ($Marker in @($StartupMarker, $RuntimeWaitMarker)) {
        if (-not [IO.Path]::GetFullPath($Marker).StartsWith(([IO.Path]::GetFullPath($TargetDirectory) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase) -or [IO.File]::ReadAllText($Marker) -cne $MarkerContents) { throw 'The controlled startup marker no longer belongs to this exact run.' }
        [IO.File]::Delete($Marker)
    }
    Wait-SoakCondition { $State = Read-SoakState $Survivor; $State -and $State.attached -and $State.rendering } 'survivor authentication/rendering after owned graphics barrier release' 120
    $SurvivorState = Read-SoakState $Survivor
    Assert-SoakAuthentication $Survivor $SurvivorState
    $SurvivorIdentity = $SurvivorState.native; $KnownNative.Add($SurvivorIdentity)
    $SurvivorRunDirectory = $SurvivorState.runDirectory; $SurvivorFingerprint = $SurvivorState.transport.tokenFingerprint; $SurvivorPort = $SurvivorState.transport.port
    $SurvivorTcp = Get-SoakTcp $Survivor $SurvivorState
    $Initial = Wait-SoakResources 'initial-survivor' @($SurvivorIdentity.path)
    $SurvivorTcpId = [uint32]$Initial.tcpThreadIds[0]
    foreach ($Id in $Initial.frameThreadIds) { $RetainedFrameIds.Add([uint32]$Id) }
    Save-SoakJson $SurvivorState (Join-Path $RunDirectory 'initial-survivor-state.json')
    for ($Cycle = 1; $Cycle -le $Cycles; $Cycle++) {
        $BeforeFps = [long](Read-SoakState $Survivor).lastFpsAt
        $Mode = if ($Cycle % 2 -eq 1) { 'fresh-electron-restart' } else { 'same-electron-session-recreate' }
        if ($Cycle % 2 -eq 1) { $Churn = Start-SoakApp 'churn' 'churn' ([int](($Cycle + 1) / 2)) }
        else {
            Send-SoakCommand $Churn 'recreate-session'
            Wait-SoakCondition { $State = Read-SoakState $Churn; $State -and $State.cycle -eq 2 -and $State.attached -and $State.rendering } 'recreated churn authentication/rendering' 120
        }
        $ChurnState = Read-SoakState $Churn
        Assert-SoakAuthentication $Churn $ChurnState
        if (@($KnownNative | Where-Object { Test-SoakPath $_.path $ChurnState.native.path }).Count) { throw 'A fresh-stage cycle reused a previous native module path.' }
        $KnownNative.Add($ChurnState.native)
        $ChurnTcp = Get-SoakTcp $Churn $ChurnState
        if ($ChurnState.transport.tokenFingerprint -ceq $SurvivorFingerprint -or $ChurnState.transport.port -eq $SurvivorPort) { throw 'The churn producer reused the survivor private route.' }
        $Label = 'cycle-' + $Cycle.ToString('000')
        $Active = Wait-SoakResources ($Label + '-active') @($SurvivorIdentity.path, $ChurnState.native.path)
        foreach ($Id in $Active.frameThreadIds) { if ($Id -notin @($RetainedFrameIds)) { $RetainedFrameIds.Add([uint32]$Id) } }
        $ModuleInput = Join-Path $RunDirectory ($Label + '-modules.json'); $ExpectedInput = Join-Path $RunDirectory ($Label + '-expected-native.json'); $ModuleOutput = Join-Path $RunDirectory ($Label + '-native-evidence.json')
        Save-SoakJson @($Active.modules) $ModuleInput; Save-SoakJson @($KnownNative) $ExpectedInput
        & $Node $EvidenceHelper '--sdk' $SdkDist '--modules-json' $ModuleInput '--expected-json' $ExpectedInput '--output' $ModuleOutput | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'The exact current target module identities failed independent file verification.' }
        Save-SoakJson $ChurnState (Join-Path $RunDirectory ($Label + '-churn-state.json'))
        Retain-SoakChildren $Churn
        Send-SoakCommand $Churn 'close-session'
        Wait-SoakCondition { $State = Read-SoakState $Churn; $State -and -not $State.activeSession -and @($State.windows.psobject.Properties).Count -eq 0 } 'closed churn session state'
        $Dormant = Wait-SoakResources ($Label + '-dormant') @($SurvivorIdentity.path)
        Wait-SoakCondition { @(Get-NetTCPConnection -State Established -OwningProcess $Target.Id -ErrorAction Stop | Where-Object { $_.LocalPort -eq $ChurnTcp.remotePort -and $_.RemotePort -eq $ChurnTcp.localPort }).Count -eq 0 } 'removed churn target TCP peer'
        $SurvivorAfter = Assert-SoakSurvivor $BeforeFps
        Save-SoakJson $SurvivorAfter (Join-Path $RunDirectory ($Label + '-survivor-state.json'))
        $Report.cycles += [ordered]@{ cycle = $Cycle; mode = $Mode; churnProcessId = $Churn.process.Id; churnSessionCycle = $ChurnState.cycle; pinnedModules = $KnownNative.Count; lifetimeSlots = $Dormant.registry.lifetimeSlots; publishedParticipants = $Dormant.registry.activeParticipants; frameThreads = $Dormant.frameThreads; activeTcpThreads = $Active.tcpThreads; dormantTcpThreads = $Dormant.tcpThreads; ownWindowAndRankCleared = $true; survivorPrivateRouteAndTcpUnchanged = $true; survivorFreshFps = $true; privateBytesDiagnostic = $Dormant.privateBytes; totalHandlesDiagnostic = $Dormant.handles }
        if ($Cycle % 2 -eq 0 -or $Cycle -eq $Cycles) { Stop-SoakApp $Churn }
    }
    Stop-SoakApp $Survivor
    $SurvivorTcpId = 0
    $Final = Wait-SoakResources 'final-all-dormant' @()
    Wait-SoakCondition { @(Get-SoakTargetEstablished).Count -eq 0 } 'zero final exact-target established TCP endpoints'
    $Report.final = @{ pinnedModules = $KnownNative.Count; lifetimeSlots = $Final.registry.lifetimeSlots; publishedParticipants = $Final.registry.activeParticipants; frameThreads = $Final.frameThreads; tcpThreads = $Final.tcpThreads; establishedTcpConnections = 0; windows = $Final.registry.windows; ranks = $Final.registry.ranks; privateBytesDiagnostic = $Final.privateBytes; totalHandlesDiagnostic = $Final.handles }
    if ((Get-FileHash -LiteralPath $TargetSource -Algorithm SHA256).Hash -cne $SourceHash -or (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash -cne $SourceHash) { throw 'A controlled target artifact changed during acceptance.' }
    $Report.status = 'passed'
} catch { $Report.error = $_.Exception.Message; throw }
finally {
    foreach ($Entry in $Entries) {
        try { Save-SoakProducerLifecycle $Entry 'cleanup-before-force' 'Lifecycle captured before any controller-forced producer termination.' } catch { $Report.cleanupErrors += $_.Exception.Message }
        try { if (-not $Entry.process.HasExited) { Retain-SoakChildren $Entry; $Entry.process.Kill(); if (-not $Entry.process.WaitForExit(10000)) { throw 'Owned producer termination did not complete.' } } } catch { $Report.cleanupErrors += $_.Exception.Message }
        foreach ($Child in $Entry.children) { try { if (-not $Child.HasExited) { $Child.Kill(); if (-not $Child.WaitForExit(10000)) { throw 'Owned Electron child termination did not complete.' } }; $Child.Dispose() } catch { $Report.cleanupErrors += $_.Exception.Message } }
        try { Save-SoakAppLogs $Entry } catch { $Report.cleanupErrors += $_.Exception.Message }
        try { Save-SoakProducerLifecycle $Entry 'cleanup-complete' } catch { $Report.cleanupErrors += $_.Exception.Message }
        $Entry.process.Dispose()
    }
    if ($Target) {
        try { if (-not $Target.HasExited) { $Target.Kill(); if (-not $Target.WaitForExit(10000)) { throw 'Owned graphics target termination did not complete.' } }; if (-not $TargetStdout.Wait(10000) -or -not $TargetStderr.Wait(10000)) { throw 'Owned target output streams did not close.' }; [IO.File]::WriteAllText((Join-Path $RunDirectory 'target.stdout.log'), $TargetStdout.GetAwaiter().GetResult()); [IO.File]::WriteAllText((Join-Path $RunDirectory 'target.stderr.log'), $TargetStderr.GetAwaiter().GetResult()) } catch { $Report.cleanupErrors += $_.Exception.Message }
        $Target.Dispose()
    }
    if ($Report.cleanupErrors.Count) { $Report.status = 'failed' }
    Save-SoakJson $Report (Join-Path $RunDirectory 'evidence.json')
    if ($Report.cleanupErrors.Count) { throw "Owned process cleanup failed: $($Report.cleanupErrors -join ' | ')" }
}
Write-Host "Cooperative real-SDK native-process resource soak passed: $RunDirectory"
