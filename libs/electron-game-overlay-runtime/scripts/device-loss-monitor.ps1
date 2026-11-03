[CmdletBinding()]
param(
    [Alias('RequestPath')][string]$EgoDiagnosticRequestPath,
    [Alias('FunctionsOnly')][switch]$EgoDiagnosticFunctionsOnly
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw 'Device-loss monitoring requires PowerShell 7 (pwsh.exe); launch the diagnostic wrapper with pwsh before starting a target.'
}
$script:EgoDeviceLossHelperDirectory = $PSScriptRoot

function Read-EgoDiagnosticText {
    param([string]$Path)
    if (-not [IO.File]::Exists($Path)) { return '' }
    $stream = [IO.File]::Open($Path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $reader = [IO.StreamReader]::new($stream)
        try { return [string]$reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Write-EgoDiagnosticJson {
    param([string]$Path, [object]$Value)
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $Path, $true)
}

function Test-EgoDiagnosticIdentity {
    param([object]$Actual, [object]$Expected)
    return ($null -ne $Actual -and $null -ne $Expected -and
        [int]$Actual.ProcessId -eq [int]$Expected.ProcessId -and
        [string]::Equals([string]$Actual.ExecutablePath, [string]$Expected.ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -and
        [string]$Actual.CreationTime100ns -ceq [string]$Expected.CreationTime100ns)
}

function Find-EgoDeviceLossLine {
    param([AllowEmptyString()][string]$Text)
    $pattern = '(?i)\bDXGI_ERROR_DEVICE_(REMOVED|HUNG|RESET)\b|\b0x887a000[567]\b|\bdevice\s+(?:has\s+been\s+)?(?:removed|hung|lost)\b|\bDevice(?:Removed|Hung)\b'
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -match $pattern) { return $line }
    }
    return $null
}

function Get-EgoScopedGpuEvent {
    param([string]$Xml, [object]$Identity, [long]$AfterRecordId, [DateTime]$ArmedAtUtc)
    $document = [xml]$Xml
    $system = $document.SelectSingleNode("/*[local-name()='Event']/*[local-name()='System']")
    if ($system.Provider.Name -cne 'nvlddmkm' -or [long]$system.EventRecordID -le $AfterRecordId) { return $null }
    $at = [DateTime]::Parse([string]$system.TimeCreated.SystemTime).ToUniversalTime()
    if ($at -lt $ArmedAtUtc.ToUniversalTime()) { return $null }
    # System.Execution.ProcessID is often 4 (the driver), NOT the game's identity.
    foreach ($data in $document.SelectNodes("/*[local-name()='Event']/*[local-name()='EventData']/*[local-name()='Data']")) {
        if ([string]$data.Name -notmatch '^(?i:ProcessId|TargetProcessId|Pid)$') { continue }
        $value = [string]$data.InnerText
        try {
            $eventPid = if ($value -match '^0x[0-9a-f]+$') { [Convert]::ToInt64($value.Substring(2), 16) } else { [long]$value }
        } catch { continue }
        if ($eventPid -eq [long]$Identity.ProcessId) {
            return [pscustomobject]@{ Source = 'scoped-nvlddmkm-event'; RecordId = [long]$system.EventRecordID; EventAtUtc = $at.ToString('o'); Xml = $Xml }
        }
    }
    return $null
}

function Get-EgoDeviceHealthMarker {
    param([string]$Line, [object]$Identity)
    if ($Line -notmatch '^EGO_DEVICE_HEALTH (.+)$') { return $null }
    try { $health = $Matches[1] | ConvertFrom-Json } catch { return $null }
    if (-not (Test-EgoDiagnosticIdentity $health $Identity)) { return $null }
    if ([string]$health.Status -notin @('device-removed', 'device-hung', 'device-reset')) { return $null }
    return [pscustomobject]@{ Source = 'identity-bound-device-health'; Line = $Line; Marker = $health }
}

function Read-EgoDiagnosticTail {
    param([hashtable]$State, [string]$Path)
    if (-not [IO.File]::Exists($Path)) { return @() }
    $stream = [IO.File]::Open($Path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        if ($stream.Length -lt [long]$State.Offset) { $State.Offset = 0L; $State.Pending = ''; $State.Truncated = $true }
        $stream.Position = [long]$State.Offset
        $bytes = [byte[]]::new([Math]::Min(262144L, [Math]::Max(0L, $stream.Length - $stream.Position)))
        $read = $stream.Read($bytes, 0, $bytes.Length)
        $State.Offset = $stream.Position
        if ($read -eq 0) { return @() }
        # Fault tokens are ASCII; preserve partial lines across file appends.
        $text = [string]$State.Pending + [Text.Encoding]::UTF8.GetString($bytes, 0, $read)
        $parts = $text -split '\n'
        $State.Pending = $parts[-1]
        if ($parts.Count -gt 1) { return @($parts[0..($parts.Count - 2)] | ForEach-Object { $_.TrimEnd("`r") }) }
        return @()
    } finally { $stream.Dispose() }
}

function Initialize-EgoDiagnosticNative {
    if (-not ('EgoDeviceLossDiagnostics.PinnedTarget' -as [type])) {
        Add-Type -Path (Join-Path $script:EgoDeviceLossHelperDirectory 'device-loss-monitor-native.cs')
    }
}

function Start-EgoDeviceLossMonitor {
    param(
        [Parameter(Mandatory)][Diagnostics.Process]$TargetProcess,
        [Parameter(Mandatory)][string]$ExpectedExecutablePath,
        [Parameter(Mandatory)][string]$MonitorRoot,
        [Parameter(Mandatory)][string]$OwnedRunDirectory,
        [Parameter(Mandatory)][string]$NativeRunDirectory,
        [Parameter(Mandatory)][string[]]$OwnedLogPaths
    )
    Initialize-EgoDiagnosticNative
    # Force the controller's Process object to retain the original kernel handle.
    $identity = [EgoDeviceLossDiagnostics.PinnedTarget]::ReadIdentity($TargetProcess.Handle)
    if (-not [string]::Equals($identity.ExecutablePath, [IO.Path]::GetFullPath($ExpectedExecutablePath), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Device-loss diagnostics refused an unexpected retained target path.'
    }
    $nonce = [guid]::NewGuid().ToString('N')
    $directory = Join-Path ([IO.Path]::GetFullPath($MonitorRoot)) $nonce
    $null = New-Item -ItemType Directory -Path $directory -ErrorAction Stop
    $request = [ordered]@{
        Schema = 1; Nonce = $nonce; Identity = $identity
        RequestedAtUtc = [DateTime]::UtcNow.ToString('o')
        Directory = $directory; OwnedRunDirectory = [IO.Path]::GetFullPath($OwnedRunDirectory)
        NativeRunDirectory = [IO.Path]::GetFullPath($NativeRunDirectory)
        LogPaths = @($OwnedLogPaths | ForEach-Object { [IO.Path]::GetFullPath($_) } | Select-Object -Unique)
        PollMilliseconds = 40; DumpTimeoutMilliseconds = 15000; DumpByteLimit = 268435456
        MaximumMonitorSeconds = 1200
    }
    $requestFile = Join-Path $directory 'request.json'
    Write-EgoDiagnosticJson $requestFile $request
    $shell = (Get-Process -Id $PID).Path
    $arguments = @('-NoProfile', '-File', ('"' + (Join-Path $script:EgoDeviceLossHelperDirectory 'device-loss-monitor.ps1') + '"'), '-RequestPath', ('"' + $requestFile + '"'))
    $process = Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $directory 'monitor.stdout.log') -RedirectStandardError (Join-Path $directory 'monitor.stderr.log')
    $monitor = [pscustomobject]@{ Process = $process; Directory = $directory; Nonce = $nonce; Identity = $identity }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
        $readyPath = Join-Path $directory 'armed.json'
        if ([IO.File]::Exists($readyPath)) {
            $ready = (Read-EgoDiagnosticText $readyPath) | ConvertFrom-Json
            if ($ready.Nonce -cne $nonce -or -not (Test-EgoDiagnosticIdentity $ready.Identity $identity)) { throw 'Diagnostic arm acknowledgement did not match the retained target/nonce.' }
            Write-Host "EGO_DEVICE_LOSS_MONITOR_ARMED directory=$($directory | ConvertTo-Json -Compress)"
            return $monitor
        }
        $process.Refresh()
        if ($process.HasExited) { throw "Device-loss monitor unavailable before input; inspect $directory" }
        Start-Sleep -Milliseconds 25
    }
    Stop-EgoDeviceLossMonitor $monitor
    throw "Device-loss monitor did not arm before input; inspect $directory"
}

function Stop-EgoDeviceLossMonitor {
    param([object]$Monitor)
    if ($null -eq $Monitor) { return }
    [IO.File]::WriteAllText((Join-Path $Monitor.Directory 'stop.request'), [DateTime]::UtcNow.ToString('o'))
    # Join BEFORE any producer/injector/target cleanup changes the failure state.
    $deadline = [DateTime]::UtcNow.AddSeconds(22)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Monitor.Process.Refresh()
        if ($Monitor.Process.HasExited) {
            $resultPath = Join-Path $Monitor.Directory 'report.json'
            if ([IO.File]::Exists($resultPath)) {
                $result = (Read-EgoDiagnosticText $resultPath) | ConvertFrom-Json
                if ($result.Status -in @('capture-unavailable', 'monitor-unavailable')) {
                    Write-Warning "Device-loss diagnostics $($result.Status); inspect $($Monitor.Directory)"
                }
            } else { Write-Warning "Device-loss monitor produced no final report; inspect $($Monitor.Directory)" }
            return
        }
        Start-Sleep -Milliseconds 40
    }
    # Terminate only this retained owned MONITOR, never the target.
    $Monitor.Process.Kill()
    $null = $Monitor.Process.WaitForExit(3000)
    Write-EgoDiagnosticJson (Join-Path $Monitor.Directory 'capture-unavailable.json') ([ordered]@{
        Status = 'capture-unavailable'; Reason = 'owned-monitor-join-timeout'; AtUtc = [DateTime]::UtcNow.ToString('o')
        Nonce = $Monitor.Nonce; Identity = $Monitor.Identity; PartialDumpIsNotComplete = $true
    })
    Write-Warning "Device-loss capture unavailable/incomplete; inspect $($Monitor.Directory)"
}

function Copy-EgoDiagnosticLogs {
    param([object]$Request)
    $copies = @(); $index = 0
    foreach ($path in $Request.LogPaths) {
        $index++
        $entry = [ordered]@{ Source = $path; SnapshotAtUtc = [DateTime]::UtcNow.ToString('o'); ByteLimit = 16777216 }
        try {
            $inputStream = [IO.File]::Open($path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            try {
                $entry.SourceBytes = $inputStream.Length
                $output = Join-Path $Request.Directory ("fault-log-$index-" + [IO.Path]::GetFileName($path))
                $outStream = [IO.File]::Open($output, 'CreateNew', 'Write', 'Read')
                try {
                    $buffer = [byte[]]::new(65536); $total = 0L
                    while ($total -lt 16777216) {
                        $count = $inputStream.Read($buffer, 0, [int][Math]::Min($buffer.Length, 16777216 - $total))
                        if ($count -eq 0) { break }
                        $outStream.Write($buffer, 0, $count); $total += $count
                    }
                    $entry.CopiedBytes = $total; $entry.Truncated = ($entry.SourceBytes -gt $total); $entry.Path = $output
                } finally { $outStream.Dispose() }
            } finally { $inputStream.Dispose() }
        } catch { $entry.Unavailable = $_.Exception.Message }
        $copies += [pscustomobject]$entry
    }
    return $copies
}

if ($EgoDiagnosticFunctionsOnly) { return }
if ([string]::IsNullOrWhiteSpace($EgoDiagnosticRequestPath)) { throw 'A controller-owned request path is required.' }
$request = (Read-EgoDiagnosticText $EgoDiagnosticRequestPath) | ConvertFrom-Json
$reportPath = Join-Path $request.Directory 'report.json'
$report = [ordered]@{ Schema = 1; Nonce = $request.Nonce; Identity = $request.Identity; Status = 'starting'; RootCauseClaimed = $false; RequestedAtUtc = $request.RequestedAtUtc }
$target = $null; $watcher = $null; $eventSource = "ego-device-loss-$($request.Nonce)"
try {
    if ($request.Schema -ne 1 -or [int]$request.Identity.ProcessId -le 0 -or [string]$request.Identity.CreationTime100ns -notmatch '^\d+$' -or @($request.LogPaths).Count -gt 8) { throw 'Invalid retained-target request.' }
    foreach ($path in $request.LogPaths) {
        $full = [IO.Path]::GetFullPath($path)
        $allowed = $false
        foreach ($root in @($request.OwnedRunDirectory, $request.NativeRunDirectory)) {
            if ($full.StartsWith(([IO.Path]::GetFullPath($root).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { $allowed = $true }
        }
        if (-not $allowed) { throw 'Diagnostic log is outside the controller-owned run roots.' }
    }
    Initialize-EgoDiagnosticNative
    $target = [EgoDeviceLossDiagnostics.PinnedTarget]::new([int]$request.Identity.ProcessId, [string]$request.Identity.ExecutablePath, [string]$request.Identity.CreationTime100ns)
    $armedAt = [DateTime]::UtcNow
    $report.ArmedAtUtc = $armedAt.ToString('o')
    $report.EventLog = [ordered]@{ Status = 'unavailable'; UnscopedEventsDoNotTrigger = $true }
    $lastRecordId = 0L
    try {
        $baseline = Get-WinEvent -LogName System -MaxEvents 1 -ErrorAction Stop
        $lastRecordId = [long]$baseline.RecordId
        $query = [Diagnostics.Eventing.Reader.EventLogQuery]::new('System', [Diagnostics.Eventing.Reader.PathType]::LogName, "*[System[Provider[@Name='nvlddmkm']]]")
        $watcher = [Diagnostics.Eventing.Reader.EventLogWatcher]::new($query)
        $null = Register-ObjectEvent -InputObject $watcher -EventName EventRecordWritten -SourceIdentifier $eventSource
        $watcher.Enabled = $true
        $report.EventLog = [ordered]@{ Status = 'watching'; BaselineRecordId = $lastRecordId; UnscopedEventsDoNotTrigger = $true }
    } catch { $report.EventLog.Error = $_.Exception.Message }
    $report.Status = 'armed'
    Write-EgoDiagnosticJson $reportPath $report
    Write-EgoDiagnosticJson (Join-Path $request.Directory 'armed.json') ([ordered]@{ Nonce = $request.Nonce; Identity = $target.Verify(); ArmedAtUtc = $report.ArmedAtUtc })
    $tails = @{}; foreach ($path in $request.LogPaths) { $tails[$path] = @{ Offset = 0L; Pending = ''; Truncated = $false } }
    $fault = $null
    $limit = $armedAt.AddSeconds([int]$request.MaximumMonitorSeconds)
    while ($null -eq $fault) {
        foreach ($path in $request.LogPaths) {
            foreach ($line in @(Read-EgoDiagnosticTail $tails[$path] $path)) {
                $health = Get-EgoDeviceHealthMarker $line $request.Identity
                if ($null -ne $health) { $fault = $health }
                elseif (-not $line.StartsWith('EGO_DEVICE_HEALTH ') -and $null -ne (Find-EgoDeviceLossLine $line)) {
                    $fault = [pscustomobject]@{ Source = 'owned-target-log'; Path = $path; Line = $line; ObservedThroughByteOffset = $tails[$path].Offset }
                }
                if ($null -ne $fault) { break }
            }
            if ($null -ne $fault) { break }
        }
        foreach ($event in @(Get-Event -SourceIdentifier $eventSource -ErrorAction SilentlyContinue)) {
            try {
                if ($event.SourceEventArgs.EventException) { $report.EventLog.ContinuityError = $event.SourceEventArgs.EventException.Message }
                elseif ($event.SourceEventArgs.EventRecord) {
                    $xml = $event.SourceEventArgs.EventRecord.ToXml()
                    if ([long]$event.SourceEventArgs.EventRecord.RecordId -le $lastRecordId) {
                        $report.EventLog.ContinuityWarning = 'event-record-not-after-arm-baseline; possible cleared log; stale records cannot trigger'
                    }
                    $scoped = Get-EgoScopedGpuEvent $xml $request.Identity $lastRecordId $armedAt
                    $contextPath = Join-Path $request.Directory 'nvlddmkm-context.xml.log'
                    if (-not [IO.File]::Exists($contextPath) -or [IO.FileInfo]::new($contextPath).Length -lt 16777216) {
                        [IO.File]::AppendAllText($contextPath, $xml + "`n")
                    } else { $report.EventLog.ContextByteLimitReached = $true }
                    if ($null -eq $fault -and $null -ne $scoped) { $fault = $scoped }
                    $event.SourceEventArgs.EventRecord.Dispose()
                }
            } finally { Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue }
        }
        if ($null -ne $fault) { break }
        if ($target.HasExited) { $report.Status = 'target-exited-without-observed-device-loss'; break }
        if ([IO.File]::Exists((Join-Path $request.Directory 'stop.request'))) { $report.Status = 'no-device-loss-observed'; break }
        if ([DateTime]::UtcNow -ge $limit) { $report.Status = 'monitor-unavailable'; $report.Failure = 'monitor-lifetime-limit'; break }
        Start-Sleep -Milliseconds ([int]$request.PollMilliseconds)
    }
    if ($null -ne $fault) {
        $report.FirstFault = $fault
        $report.FirstFaultObservedAtUtc = [DateTime]::UtcNow.ToString('o')
        $report.Status = 'capturing'
        Write-EgoDiagnosticJson (Join-Path $request.Directory 'first-fault.json') $report
        Write-EgoDiagnosticJson $reportPath $report
        try {
            $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($request.Directory))
            if ($drive.AvailableFreeSpace -lt ([long]$request.DumpByteLimit + 67108864)) { throw 'Insufficient owned-output disk space for bounded diagnostic dump.' }
            $dump = Join-Path $request.Directory 'first-device-loss.partial.dmp'
            $report.DumpStartedAtUtc = [DateTime]::UtcNow.ToString('o')
            $null = $target.Verify()
            $task = $target.BeginDump($dump, [int]$request.DumpTimeoutMilliseconds, [long]$request.DumpByteLimit)
            $hardDeadline = [DateTime]::UtcNow.AddMilliseconds([int]$request.DumpTimeoutMilliseconds + 2000)
            while (-not $task.IsCompleted -and [DateTime]::UtcNow -lt $hardDeadline) { Start-Sleep -Milliseconds 20 }
            if (-not $task.IsCompleted) {
                $report.Status = 'capture-unavailable'; $report.Failure = 'dump-writer-hard-timeout'; $report.PartialDumpIsNotComplete = $true
                $report.LogSnapshots = @(Copy-EgoDiagnosticLogs $request)
                Write-EgoDiagnosticJson $reportPath $report
                [Environment]::Exit(3) # terminate only the monitor/writer, leaving target untouched
            }
            $report.Dump = $task.GetAwaiter().GetResult()
            $report.DumpCompletedAtUtc = [DateTime]::UtcNow.ToString('o')
            if ($report.Dump.Complete) {
                $completeDump = Join-Path $request.Directory 'first-device-loss.dmp'
                [IO.File]::Move($dump, $completeDump)
                $report.DumpPath = $completeDump; $report.Status = 'captured'
                $report.DumpSha256 = (Get-FileHash -LiteralPath $completeDump -Algorithm SHA256).Hash.ToLowerInvariant()
            } else { $report.DumpPath = $dump; $report.Status = 'capture-unavailable'; $report.PartialDumpIsNotComplete = $true }
        } catch { $report.Status = 'capture-unavailable'; $report.Failure = $_.Exception.Message }
        $report.LogSnapshots = @(Copy-EgoDiagnosticLogs $request)
    }
} catch { $report.Status = 'monitor-unavailable'; $report.Failure = $_.Exception.ToString() }
finally {
    if ($watcher) { $watcher.Enabled = $false; $watcher.Dispose() }
    Unregister-Event -SourceIdentifier $eventSource -ErrorAction SilentlyContinue
    if ($target) { $target.Dispose() }
    $report.FinishedAtUtc = [DateTime]::UtcNow.ToString('o')
    Write-EgoDiagnosticJson $reportPath $report
}
