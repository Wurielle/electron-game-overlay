[CmdletBinding()]
param(
    [string]$InjectorPath
)

$ErrorActionPreference = "Stop"

function Wait-ForCondition {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Condition,
        [Parameter(Mandatory = $true)]
        [string]$FailureMessage,
        [int]$TimeoutMilliseconds = 10000
    )

    $Deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        if (& $Condition) {
            return
        }
        Start-Sleep -Milliseconds 25
    }
    throw $FailureMessage
}

function Read-Lines([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @()
    }
    return @(Get-Content -LiteralPath $Path -ErrorAction Stop)
}

function Get-ObserverEventCount {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [ValidateSet("CREATE", "DELETE")]
        [string]$Kind,
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [Parameter(Mandatory = $true)]
        [string]$ExecutablePath
    )

    $Pattern = "^EGO_PROCESS_$Kind`t$ProcessId`t$([regex]::Escape($ExecutablePath))$"
    return @(
        Read-Lines $Path |
            Where-Object { $_ -match $Pattern }
    ).Count
}

function Measure-ObserverIdleResources {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Process,
        [int]$WarmupMilliseconds = 2000,
        [int]$SampleMilliseconds = 7500
    )

    if ($Process.HasExited) {
        throw "The native process observer exited before its idle resource sample."
    }

    Start-Sleep -Milliseconds $WarmupMilliseconds
    if ($Process.HasExited) {
        throw "The native process observer exited during its idle resource warm-up."
    }

    $Process.Refresh()
    $StartingCpuMilliseconds = $Process.TotalProcessorTime.TotalMilliseconds
    $StartingHandleCount = $Process.HandleCount
    $StartingPrivateBytes = $Process.PrivateMemorySize64
    $Stopwatch = [Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Milliseconds $SampleMilliseconds
    $Stopwatch.Stop()

    if ($Process.HasExited) {
        throw "The native process observer exited during its idle resource sample."
    }

    $Process.Refresh()
    $CpuMilliseconds = $Process.TotalProcessorTime.TotalMilliseconds - $StartingCpuMilliseconds
    $SingleCorePercent = 100 * $CpuMilliseconds / $Stopwatch.Elapsed.TotalMilliseconds
    $HandleGrowth = $Process.HandleCount - $StartingHandleCount
    $PrivateByteGrowth = $Process.PrivateMemorySize64 - $StartingPrivateBytes

    # This observer intentionally scans at a short cadence, but a stable process set
    # must not turn that cadence into a busy loop or an accumulating resource leak.
    # Expressing CPU against one logical core keeps the assertion independent of the
    # number of processors exposed by a developer machine or CI worker.
    if ($SingleCorePercent -gt 5) {
        throw ((
                "The native process observer used {0:N1}% of one logical core while idle; " +
                "the 5% regression budget was exceeded."
            ) -f $SingleCorePercent)
    }
    if ($HandleGrowth -gt 8) {
        throw "The native process observer gained $HandleGrowth handles while idle; the regression budget is 8."
    }
    if ($PrivateByteGrowth -gt 16MB) {
        throw ((
                "The native process observer gained {0:N1} MiB of private memory while idle; " +
                "the regression budget is 16 MiB."
            ) -f ($PrivateByteGrowth / 1MB))
    }

    return [pscustomobject]@{
        SingleCorePercent = $SingleCorePercent
        HandleGrowth = $HandleGrowth
        PrivateByteGrowth = $PrivateByteGrowth
    }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$Injector = if ([string]::IsNullOrWhiteSpace($InjectorPath)) {
    Join-Path $RepoRoot "libs\electron-game-overlay-runtime\dist\win32-x64\inject.exe"
}
else {
    [IO.Path]::GetFullPath($InjectorPath)
}
if (-not (Test-Path -LiteralPath $Injector -PathType Leaf)) {
    throw "Build the runtime before running the process observer gate: $Injector"
}
$Injector = (Resolve-Path -LiteralPath $Injector).Path

$GateRoot = Join-Path $env:TEMP ("electron-game-overlay-observer-gate-" + [Guid]::NewGuid().ToString("N"))
$SteamFixture = Join-Path $GateRoot "steamapps\common\observer-fixture"
$ObserverStdout = Join-Path $GateRoot "observer.stdout.log"
$ObserverStderr = Join-Path $GateRoot "observer.stderr.log"
$Observer = $null
$Fixtures = @()

try {
    New-Item -ItemType Directory -Path $SteamFixture -Force | Out-Null
    $FixturePaths = @(
        Join-Path $SteamFixture "existing.exe"
        Join-Path $SteamFixture "first.exe"
        Join-Path $SteamFixture "second.exe"
    )
    foreach ($FixturePath in $FixturePaths) {
        Copy-Item -LiteralPath "$env:WINDIR\System32\ping.exe" -Destination $FixturePath
    }

    $Fixtures += Start-Process -FilePath $FixturePaths[0] `
        -ArgumentList @("127.0.0.1", "-n", "20") -WindowStyle Hidden -PassThru

    $Observer = Start-Process -FilePath $Injector `
        -ArgumentList @(
            "--observe-path-contains",
            "\steamapps\",
            "--parent-pid",
            [string]$PID
        ) `
        -RedirectStandardOutput $ObserverStdout `
        -RedirectStandardError $ObserverStderr `
        -WindowStyle Hidden `
        -PassThru

    Wait-ForCondition `
        -Condition { (Read-Lines $ObserverStdout) -contains "EGO_PROCESS_OBSERVER_READY" } `
        -FailureMessage "The native process observer did not publish its ready handshake."

    $ReadyLines = @(Read-Lines $ObserverStdout)
    $ReadyRecords = @($ReadyLines | Where-Object { $_ -eq "EGO_PROCESS_OBSERVER_READY" })
    if ($ReadyRecords.Count -ne 1 -or $ReadyLines[0] -ne "EGO_PROCESS_OBSERVER_READY") {
        throw "The native process observer did not publish exactly one ready record before process events."
    }

    $Fixtures += Start-Process -FilePath $FixturePaths[1] `
        -ArgumentList @("127.0.0.1", "-n", "20") -WindowStyle Hidden -PassThru
    $Fixtures += Start-Process -FilePath $FixturePaths[2] `
        -ArgumentList @("127.0.0.1", "-n", "20") -WindowStyle Hidden -PassThru
    $NonMatching = Start-Process -FilePath "$env:WINDIR\System32\ping.exe" `
        -ArgumentList @("127.0.0.1", "-n", "20") -WindowStyle Hidden -PassThru
    $Fixtures += $NonMatching

    $ExpectedByPid = @{}
    for ($Index = 0; $Index -lt $FixturePaths.Count; $Index++) {
        $ExpectedByPid[[string]$Fixtures[$Index].Id] = [IO.Path]::GetFullPath($FixturePaths[$Index])
    }

    Wait-ForCondition -Condition {
        $Observed = @{}
        foreach ($Line in Read-Lines $ObserverStdout) {
            if ($Line -match '^EGO_PROCESS_CREATE\t([1-9][0-9]*)\t(.+)$') {
                $Observed[$Matches[1]] = $Matches[2]
            }
        }
        foreach ($Entry in $ExpectedByPid.GetEnumerator()) {
            if (-not $Observed.ContainsKey($Entry.Key) -or
                -not $Observed[$Entry.Key].Equals($Entry.Value, [StringComparison]::OrdinalIgnoreCase)) {
                return $false
            }
        }
        return $true
    } -FailureMessage "The native process observer did not report every matching executable."

    $Lines = Read-Lines $ObserverStdout
    if ($Lines -match ("^EGO_PROCESS_CREATE\t" + $NonMatching.Id + "\t")) {
        throw "The native process observer reported a process outside the configured path."
    }

    $Resources = Measure-ObserverIdleResources -Process $Observer
    foreach ($Entry in $ExpectedByPid.GetEnumerator()) {
        if ((Get-ObserverEventCount `
                -Path $ObserverStdout `
                -Kind CREATE `
                -ProcessId ([int]$Entry.Key) `
                -ExecutablePath $Entry.Value) -ne 1) {
            throw "The persistent observer emitted a duplicate or missing creation for PID $($Entry.Key)."
        }
        if ((Get-ObserverEventCount `
                -Path $ObserverStdout `
                -Kind DELETE `
                -ProcessId ([int]$Entry.Key) `
                -ExecutablePath $Entry.Value) -ne 0) {
            throw "The persistent observer emitted a deletion while PID $($Entry.Key) was still running."
        }
    }

    $Released = $Fixtures[1]
    Stop-Process -Id $Released.Id -Force
    Wait-ForCondition `
        -Condition {
            (Get-ObserverEventCount `
                    -Path $ObserverStdout `
                    -Kind DELETE `
                    -ProcessId $Released.Id `
                    -ExecutablePath $FixturePaths[1]) -eq 1
        } `
        -FailureMessage "The native process observer did not report the matching executable's deletion."

    Start-Sleep -Milliseconds 100
    if ((Get-ObserverEventCount `
            -Path $ObserverStdout `
            -Kind DELETE `
            -ProcessId $Released.Id `
            -ExecutablePath $FixturePaths[1]) -ne 1) {
        throw "The persistent observer emitted a matching executable's deletion more than once."
    }

    $Restarted = Start-Process -FilePath $FixturePaths[1] `
        -ArgumentList @("127.0.0.1", "-n", "20") -WindowStyle Hidden -PassThru
    $Fixtures += $Restarted
    $ExpectedRestartCreateCount = if ($Restarted.Id -eq $Released.Id) { 2 } else { 1 }
    Wait-ForCondition `
        -Condition {
            (Get-ObserverEventCount `
                    -Path $ObserverStdout `
                    -Kind CREATE `
                    -ProcessId $Restarted.Id `
                    -ExecutablePath $FixturePaths[1]) -eq $ExpectedRestartCreateCount
        } `
        -FailureMessage "The native process observer did not report a matching executable after relaunch."

    Start-Sleep -Milliseconds 100
    if ((Get-ObserverEventCount `
            -Path $ObserverStdout `
            -Kind CREATE `
            -ProcessId $Restarted.Id `
            -ExecutablePath $FixturePaths[1]) -ne $ExpectedRestartCreateCount) {
        throw "The persistent observer emitted a relaunched executable's creation more than once."
    }

    if ($Observer.HasExited) {
        throw "The native process observer exited after the first matching executable."
    }

    Write-Host (
        "ELECTRON_GAME_OVERLAY_PROCESS_OBSERVER_GATE_PASSED " +
        "pids=$($ExpectedByPid.Keys -join ','),$($Restarted.Id) " +
        "idle_single_core_percent=$($Resources.SingleCorePercent.ToString('F1', [Globalization.CultureInfo]::InvariantCulture)) " +
        "idle_handle_growth=$($Resources.HandleGrowth) " +
        "idle_private_byte_growth=$($Resources.PrivateByteGrowth)"
    )
}
finally {
    foreach ($Fixture in $Fixtures) {
        if ($null -ne $Fixture -and -not $Fixture.HasExited) {
            Stop-Process -Id $Fixture.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if ($null -ne $Observer -and -not $Observer.HasExited) {
        Stop-Process -Id $Observer.Id -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path -LiteralPath $GateRoot) {
        $ResolvedGateRoot = (Resolve-Path -LiteralPath $GateRoot).Path
        $ExpectedPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if (-not $ResolvedGateRoot.StartsWith($ExpectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove process observer gate data outside TEMP: $ResolvedGateRoot"
        }
        Remove-Item -LiteralPath $ResolvedGateRoot -Recurse -Force
    }
}
