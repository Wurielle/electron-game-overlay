[CmdletBinding()]
param([string]$OutputDirectory, [switch]$SelfTestFunctionsOnly)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'device-loss-monitor.ps1') -FunctionsOnly

function Assert-EgoSyntheticDumpEvidence {
    param([object]$Report, [object]$ExpectedIdentity, [DateTime]$PublishedAtUtc, [bool]$OwnedChildAlive)
    if ($Report.Status -cne 'captured' -or -not $Report.Dump.Complete -or $Report.RootCauseClaimed -ne $false) {
        throw 'Synthetic test requires a completed diagnostic dump with no GPU-root-cause claim.'
    }
    if (-not (Test-EgoDiagnosticIdentity $Report.Identity $ExpectedIdentity) -or
        -not (Test-EgoDiagnosticIdentity $Report.FirstFault.Marker $ExpectedIdentity)) {
        throw 'Synthetic dump did not retain the exact owned child identity.'
    }
    if ($Report.FirstFault.Source -cne 'identity-bound-device-health' -or
        $Report.FirstFault.Marker.Synthetic -ne $true -or
        $Report.FirstFault.Marker.EvidenceKind -cne 'synthetic-monitor-self-test' -or
        $Report.FirstFault.Marker.Status -cne 'device-hung') {
        throw 'The first captured fault was not the explicitly synthetic, identity-bound marker.'
    }
    # PS7 ConvertFrom-Json may already return DateTime. Parse(object) would
    # stringify it with local culture, losing subsecond precision and Kind.
    $observed = ([DateTime]$Report.FirstFaultObservedAtUtc).ToUniversalTime()
    $started = ([DateTime]$Report.DumpStartedAtUtc).ToUniversalTime()
    $completed = ([DateTime]$Report.DumpCompletedAtUtc).ToUniversalTime()
    $detectionMilliseconds = ($observed - $PublishedAtUtc.ToUniversalTime()).TotalMilliseconds
    $startMilliseconds = ($started - $PublishedAtUtc.ToUniversalTime()).TotalMilliseconds
    $dumpMilliseconds = ($completed - $started).TotalMilliseconds
    if ($detectionMilliseconds -lt 0 -or $startMilliseconds -lt $detectionMilliseconds -or
        $startMilliseconds -gt 2000 -or $dumpMilliseconds -lt 0 -or $dumpMilliseconds -gt 20000) {
        throw 'Synthetic first-fault capture did not start within 2 seconds and complete within its 20-second outer bound.'
    }
    $dump = [IO.FileInfo]::new([string]$Report.DumpPath)
    if (-not $dump.Exists -or $dump.Length -le 32 -or $dump.Length -gt 268435456 -or
        $dump.Length -ne [long]$Report.Dump.Bytes -or $dump.Name -cne 'first-device-loss.dmp') {
        throw 'Synthetic capture must have one complete, size-bounded dump artifact.'
    }
    $stream = $dump.OpenRead()
    try { $reader = [IO.BinaryReader]::new($stream); $signature = $reader.ReadUInt32() }
    finally { $stream.Dispose() }
    if ($signature -ne 0x504D444D) { throw 'Captured file has no MDMP minidump signature.' }
    if (-not $OwnedChildAlive) { throw 'Owned child exited before capture verification/cleanup.' }
    return [pscustomobject]@{
        Synthetic = $true; GenuineGpuLossObserved = $false; ExactOwnedTarget = $true
        FirstFaultDetectionMilliseconds = $detectionMilliseconds
        DumpStartMilliseconds = $startMilliseconds; DumpWriteMilliseconds = $dumpMilliseconds
        MdmpSignatureVerified = $true; DumpBytes = $dump.Length; ChildAliveBeforeCleanup = $true
    }
}

if ($SelfTestFunctionsOnly) { return }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
    $OutputDirectory = Join-Path $repo ('build\device-loss-monitor\synthetic-self-test-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ([IO.Directory]::Exists($OutputDirectory) -or [IO.File]::Exists($OutputDirectory)) { throw 'Synthetic self-test output must be a new owned directory.' }
$null = New-Item -ItemType Directory -Path $OutputDirectory
$result = [ordered]@{
    Schema = 1; Status = 'starting'; Synthetic = $true; GenuineGpuLossObserved = $false
    GpuRootCauseClaimed = $false; UiUsed = $false; TargetSelection = 'retained-owned-Start-Process-only'
    StartedAtUtc = [DateTime]::UtcNow.ToString('o'); OutputDirectory = $OutputDirectory
}
$child = $null; $monitor = $null; $failure = $null
try {
    $childScript = Join-Path $OutputDirectory 'owned-console-child.ps1'
    [IO.File]::WriteAllText($childScript, "`$ErrorActionPreference = 'Stop'; while (`$true) { [Threading.Thread]::Sleep(100) }")
    $childExecutable = (Get-Process -Id $PID).Path
    $child = Start-Process -FilePath $childExecutable -ArgumentList @('-NoProfile', '-File', ('"' + $childScript + '"')) `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $OutputDirectory 'child.stdout.log') `
        -RedirectStandardError (Join-Path $OutputDirectory 'child.stderr.log')
    $null = $child.Handle
    $log = Join-Path $OutputDirectory 'synthetic-device-health.log'
    [IO.File]::WriteAllText($log, "SYNTHETIC DIAGNOSTIC SELF-TEST; no actual GPU work or device loss.`n")
    $monitor = Start-EgoDeviceLossMonitor -TargetProcess $child -ExpectedExecutablePath $childExecutable `
        -MonitorRoot (Join-Path $OutputDirectory 'monitor') -OwnedRunDirectory $OutputDirectory `
        -NativeRunDirectory $OutputDirectory -OwnedLogPaths @($log,
            (Join-Path $OutputDirectory 'child.stdout.log'), (Join-Path $OutputDirectory 'child.stderr.log'))
    $identity = $monitor.Identity
    $result.Identity = $identity; $result.MonitorDirectory = $monitor.Directory
    $wrong = [ordered]@{ ProcessId = $identity.ProcessId + 1; ExecutablePath = $identity.ExecutablePath; CreationTime100ns = $identity.CreationTime100ns; Status = 'device-hung'; Synthetic = $true; EvidenceKind = 'synthetic-monitor-self-test' }
    [IO.File]::AppendAllText($log, 'EGO_DEVICE_HEALTH ' + ($wrong | ConvertTo-Json -Compress) + "`n")
    $wrong.ProcessId = $identity.ProcessId; $wrong.CreationTime100ns = '1'
    [IO.File]::AppendAllText($log, 'EGO_DEVICE_HEALTH ' + ($wrong | ConvertTo-Json -Compress) + "`n")
    Start-Sleep -Milliseconds 200
    $before = (Read-EgoDiagnosticText (Join-Path $monitor.Directory 'report.json')) | ConvertFrom-Json
    if ($before.Status -cne 'armed' -or [IO.File]::Exists((Join-Path $monitor.Directory 'first-fault.json'))) {
        throw 'A wrong PID/creation-time synthetic marker triggered capture.'
    }
    $result.ForeignAndReusedIdentityMarkersIgnored = $true
    $marker = [ordered]@{ ProcessId = $identity.ProcessId; ExecutablePath = $identity.ExecutablePath; CreationTime100ns = $identity.CreationTime100ns; Status = 'device-hung'; Synthetic = $true; EvidenceKind = 'synthetic-monitor-self-test' }
    $publishedAt = [DateTime]::UtcNow
    $result.SyntheticMarkerPublishedAtUtc = $publishedAt.ToString('o')
    [IO.File]::AppendAllText($log, 'EGO_DEVICE_HEALTH ' + ($marker | ConvertTo-Json -Compress) + "`n")
    [IO.File]::AppendAllText($log, "DXGI_ERROR_DEVICE_REMOVED synthetic second marker; must not replace first fault`n")
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $report = (Read-EgoDiagnosticText (Join-Path $monitor.Directory 'report.json')) | ConvertFrom-Json
        if ($report.Status -in @('captured', 'capture-unavailable', 'monitor-unavailable')) { break }
        $child.Refresh()
        if ($child.HasExited) { throw 'The owned benign child exited before diagnostic capture.' }
        Start-Sleep -Milliseconds 25
    } while ([DateTime]::UtcNow -lt $deadline)
    $child.Refresh()
    $result.Capture = Assert-EgoSyntheticDumpEvidence $report $identity $publishedAt (-not $child.HasExited)
    $afterIdentity = [EgoDeviceLossDiagnostics.PinnedTarget]::ReadIdentity($child.Handle)
    if (-not (Test-EgoDiagnosticIdentity $afterIdentity $identity)) { throw 'Owned child identity changed during capture.' }
    $dumps = @(Get-ChildItem -LiteralPath $monitor.Directory -Filter '*.dmp' -File)
    if ($dumps.Count -ne 1) { throw 'First-fault capture wrote more than one dump or left a partial artifact.' }
    $result.DumpPath = $report.DumpPath; $result.DumpSha256 = $report.DumpSha256
    $result.Status = 'synthetic-self-test-passed'
} catch {
    $failure = $_; $result.Status = 'synthetic-self-test-failed'; $result.Failure = $_.Exception.ToString()
} finally {
    if ($monitor) { Stop-EgoDeviceLossMonitor $monitor }
    if ($child) {
        $child.Refresh()
        $result.ChildAliveUntilOwnedCleanup = -not $child.HasExited
        if (-not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(5000) }
        $child.Refresh(); $result.OwnedChildExitObserved = $child.HasExited
        $child.Dispose()
    }
    $result.FinishedAtUtc = [DateTime]::UtcNow.ToString('o')
    Write-EgoDiagnosticJson (Join-Path $OutputDirectory 'self-test-report.json') $result
}
if ($failure) { throw $failure }
Write-Host 'EGO_DEVICE_LOSS_MONITOR_SYNTHETIC_SELF_TEST_PASS (no genuine GPU loss observed)'
Write-Host "Evidence: $OutputDirectory"
