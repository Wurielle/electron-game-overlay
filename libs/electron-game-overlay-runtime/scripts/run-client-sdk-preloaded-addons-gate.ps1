#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('d3d11', 'd3d12')][string]$Backend,
    [string]$SdkDistA,
    [string]$SdkDistB,
    [string]$ElectronExecutable,
    [ValidateSet('all', 'self-load', 'production-injection')][string]$Scope = 'all',
    [switch]$SkipBuild,
    [Parameter(DontShow)][switch]$FunctionsOnly
)

# Scope is deliberately limited to the repository's copied DirectX demo. The
# self-load cell proves ordinary ReShade AddonPath scanning with no apps alive;
# the production-injection cell separately proves the public SDK's first-host
# snapshot wiring before device creation. SendInput is not physical-key evidence.
$ErrorActionPreference = 'Stop'
$RequestedElectron = $ElectronExecutable
$RequestedFunctionsOnly = $FunctionsOnly
$RequestedSkipBuild = $SkipBuild
. (Join-Path $PSScriptRoot 'run-client-sdk-input-gate.ps1') -Backend $Backend -FunctionsOnly -SkipBuild
. (Join-Path $PSScriptRoot 'cooperative-resource-snapshot.ps1')
. (Join-Path $PSScriptRoot 'owned-stage-marker.ps1')
. (Join-Path $PSScriptRoot 'owned-injector-result.ps1')
$ElectronExecutable = if ($RequestedElectron) { $RequestedElectron } else { Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' }
$SdkDistA = if ($SdkDistA) { $SdkDistA } else { Join-Path $RepoRoot 'libs\electron-game-overlay\dist' }
$SdkDistB = if ($SdkDistB) { $SdkDistB } else { $SdkDistA }
$ProducerFixture = Join-Path $RepoRoot 'apps\client\scripts\cooperative-two-app-game-fixture.cjs'
$RegistrationFixture = Join-Path $RepoRoot 'apps\client\scripts\cooperative-preload-registration.cjs'

function Save-PreloadJson($Value, [string]$Path) { $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Path -Encoding utf8 }
function Test-PreloadPath([string]$Left, [string]$Right) { return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase) }
function ConvertTo-PreloadArgument([AllowEmptyString()][string]$Argument) {
    if ($Argument.Contains([char]0)) { throw 'NUL in controlled process argument.' }
    $Text = [Text.StringBuilder]::new(); $null = $Text.Append('"'); $Slashes = 0
    foreach ($Character in $Argument.ToCharArray()) {
        if ($Character -eq '\') { $Slashes++; continue }
        $Count = if ($Character -eq '"') { 2 * $Slashes + 1 } else { $Slashes }
        if ($Count) { $null = $Text.Append(('\' * $Count)) }
        $null = $Text.Append($Character); $Slashes = 0
    }
    if ($Slashes) { $null = $Text.Append(('\' * (2 * $Slashes))) }
    $null = $Text.Append('"'); return $Text.ToString()
}
function New-PreloadProcessInfo([string]$Executable, [string[]]$Arguments, [bool]$Visible = $false) {
    $Info = [Diagnostics.ProcessStartInfo]::new(); $Info.FileName = $Executable; $Info.WorkingDirectory = $RepoRoot
    $Info.UseShellExecute = $false; $Info.RedirectStandardOutput = $true; $Info.RedirectStandardError = $true
    $Info.CreateNoWindow = -not $Visible
    $Info.WindowStyle = if ($Visible) { [Diagnostics.ProcessWindowStyle]::Normal } else { [Diagnostics.ProcessWindowStyle]::Hidden }
    $Info.Arguments = ($Arguments | ForEach-Object { ConvertTo-PreloadArgument $_ }) -join ' '
    if ($Info.Arguments.Length + $Executable.Length -gt 32760) { throw 'Controlled command line exceeds the Windows bound.' }
    foreach ($Name in @('RESHADE_BASE_PATH_OVERRIDE', 'RESHADE_DISABLE_GRAPHICS_HOOK', 'RESHADE_DISABLE_INPUT_HOOK', 'RESHADE_DISABLE_LOGGING', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_GAME_OVERLAY_BROKER_PIPE')) { $Info.EnvironmentVariables.Remove($Name) }
    return $Info
}
function Start-PreloadProcess([Diagnostics.ProcessStartInfo]$Info) {
    $Process = [Diagnostics.Process]::new(); $Process.StartInfo = $Info
    if (-not $Process.Start()) { throw 'Controlled process failed to start.' }
    $null = $Process.Handle
    return @{ process = $Process; creationTime100ns = $Process.StartTime.ToFileTimeUtc().ToString(); stdout = $Process.StandardOutput.ReadToEndAsync(); stderr = $Process.StandardError.ReadToEndAsync(); children = [Collections.Generic.List[Diagnostics.Process]]::new(); expectedExit = $false }
}
function Get-PreloadProcessEvidence($Entry, [string]$Phase) {
    $Evidence = [ordered]@{ phase = $Phase; observedAtUtc = [DateTime]::UtcNow.ToString('o'); processId = $Entry.process.Id; creationTime100ns = $Entry.creationTime100ns; hasExited = $null; exitCode = $null; exitCodeHex = $null; exitTimeUtc = $null }
    try {
        $Entry.process.Refresh()
        $Evidence.hasExited = [bool]$Entry.process.HasExited
        $Evidence.observedCreationMatches = $Entry.process.StartTime.ToFileTimeUtc().ToString() -ceq $Entry.creationTime100ns
        if ($Evidence.hasExited) {
            $Code = [int]$Entry.process.ExitCode
            $Evidence.exitCode = $Code
            $Evidence.exitCodeHex = '0x' + [BitConverter]::ToUInt32([BitConverter]::GetBytes($Code), 0).ToString('X8')
            $Evidence.exitTimeUtc = $Entry.process.ExitTime.ToUniversalTime().ToString('o')
        }
    } catch { $Evidence.observationError = $_.Exception.GetType().FullName }
    return $Evidence
}
function Get-PreloadTargetDiagnostics {
    $Diagnostics = [ordered]@{}
    foreach ($Leaf in @('electron-game-overlay-preload-runtime.log', 'electron-game-overlay-demo-graphics.log', 'electron-game-overlay-demo-failure.log', 'electron-game-overlay-demo-present.ready')) {
        $Path = Join-Path $TargetDirectory $Leaf
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $Item = Get-Item -LiteralPath $Path -Force
            if ($Item.Length -gt 16KB -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Controlled target diagnostic exceeds its regular-file bound.' }
            $Diagnostics[$Leaf] = @{ path = $Path; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash; text = [IO.File]::ReadAllText($Path) }
        }
    }
    return $Diagnostics
}
function Read-PreloadState([string]$Member) {
    try { return Get-Content -LiteralPath (Join-Path $Apps[$Member].directory "$Member-state.json") -Raw | ConvertFrom-Json } catch { return $null }
}
function Assert-PreloadAlive {
    if ($Target) {
        $Target.process.Refresh()
        if ($Target.process.HasExited) {
            $CaseResult.targetExit = Get-PreloadProcessEvidence $Target 'unexpected-target-exit'
            $CaseResult.targetDiagnostics = Get-PreloadTargetDiagnostics
            Save-PreloadJson $CaseResult.targetExit (Join-Path $CaseDirectory 'target-exit.json')
            throw "The controller-owned DirectX demo exited (exitCode=$($CaseResult.targetExit.exitCode), $($CaseResult.targetExit.exitCodeHex))."
        }
    }
    foreach ($Entry in $Apps.Values) {
        $State = Read-PreloadState $Entry.member
        if ($State -and $State.error) { throw "Producer $($Entry.member) failed: $($State.error)" }
        if (-not $Entry.expectedExit) { $Entry.process.Refresh(); if ($Entry.process.HasExited) { throw "Producer $($Entry.member) exited unexpectedly." } }
    }
}
function Wait-Preload([scriptblock]$Predicate, [string]$Label, [int]$Seconds = 35) {
    $Deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        Assert-PreloadAlive
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 50
    }
    throw "Timed out waiting for $Label. Last snapshot: $script:SnapshotError. Evidence: $CaseDirectory"
}
function Invoke-PreloadRegistration([string]$Member, [string]$Action, [string]$Output, [string]$Destination = '') {
    $Arguments = @($RegistrationFixture, "--action=$Action", "--sdk-dist=$($Sdks[$Member])", "--application-id=$($ApplicationIds[$Member])", "--storage-root=$StorageRoot", "--output=$Output")
    if ($Destination) { $Arguments += "--destination=$Destination" }
    $Entry = Start-PreloadProcess (New-PreloadProcessInfo $NodeExecutable $Arguments)
    if (-not $Entry.process.WaitForExit(20000)) { $Entry.process.Kill(); throw 'Pure Node registration fixture timed out.' }
    $OutText = $Entry.stdout.GetAwaiter().GetResult(); $ErrorText = $Entry.stderr.GetAwaiter().GetResult()
    [IO.File]::WriteAllText("$Output.stdout.log", $OutText); [IO.File]::WriteAllText("$Output.stderr.log", $ErrorText)
    if ($Entry.process.ExitCode -ne 0) { throw "Pure Node $Action failed: $ErrorText" }
    return Get-Content -LiteralPath $Output -Raw | ConvertFrom-Json
}
function Retain-PreloadChildren($Entry) {
    # Preserve exact handles while the parent still exists. Never kill by name.
    $Processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $Parents = [Collections.Generic.HashSet[int]]::new(); $null = $Parents.Add($Entry.process.Id)
    $Seen = [Collections.Generic.HashSet[int]]::new(); foreach ($Child in $Entry.children) { $null = $Seen.Add($Child.Id) }
    do {
        $Added = $false
        foreach ($Item in $Processes) {
            if ($Parents.Contains([int]$Item.ParentProcessId) -and -not $Parents.Contains([int]$Item.ProcessId)) {
                $null = $Parents.Add([int]$Item.ProcessId); $Added = $true
                if (-not $Seen.Contains([int]$Item.ProcessId)) {
                    try {
                        $Child = [Diagnostics.Process]::GetProcessById([int]$Item.ProcessId); $null = $Child.Handle
                        if (-not $Child.HasExited -and $Child.StartTime.ToUniversalTime() -ge $Entry.process.StartTime.ToUniversalTime() -and
                            [long][Math]::Floor($Child.StartTime.ToUniversalTime().Ticks / 10D) -eq [long][Math]::Floor($Item.CreationDate.ToUniversalTime().Ticks / 10D)) {
                            $Entry.children.Add($Child); $null = $Seen.Add($Child.Id)
                        }
                    } catch { }
                }
            }
        }
    } while ($Added)
}
function Start-PreloadApp([string]$Member, [string]$Slot, [int]$Generation = 1, [bool]$WaitForRendering = $true, [bool]$UsePreload = $true) {
    $Directory = Join-Path $CaseDirectory "p\$Member$Generation"; New-Item -ItemType Directory -Path $Directory | Out-Null
    $RunsRoot = Join-Path $CaseDirectory "$Member$Generation"
    $LongestLeaf = if ($UsePreload) { [IO.Path]::GetFileName($Registrations[$Member].addonPath) } else { 'electron_game_overlay_runtime.build.json' }
    $Projected = Join-Path (Join-Path (Join-Path $RunsRoot 'p.exe-XXXXXX') 'preloaded-addons') $LongestLeaf
    if ($Projected.Length -gt 240) { throw "The controlled native snapshot path exceeds its explicit Windows path budget: $Projected" }
    $Arguments = @($ProducerFixture, "--member=$Member", "--slot=$Slot", "--evidence=$Directory", "--sdk-dist=$($Sdks[$Member])", "--game=$TargetPath", "--pid=$($Target.process.Id)", "--runs-root=$RunsRoot", '--exact-pid-proof=1')
    if ($UsePreload) { $Arguments += @("--preload-app-id=$($ApplicationIds[$Member])", "--preload-storage-root=$StorageRoot") }
    if ($SdkConsumers -and $SdkConsumers[$Member]) { $Arguments += "--sdk-consumer-root=$($SdkConsumers[$Member])" }
    $Entry = Start-PreloadProcess (New-PreloadProcessInfo $ElectronExecutable $Arguments)
    $Entry.member = $Member; $Entry.directory = $Directory; $Entry.runsRoot = $RunsRoot; $Entry.generation = $Generation; $Apps[$Member] = $Entry; $AllApps.Add($Entry)
    Save-PreloadJson @{ executable = $ElectronExecutable; arguments = $Arguments; processId = $Entry.process.Id; creationTime100ns = $Entry.process.StartTime.ToFileTimeUtc().ToString() } (Join-Path $Directory 'process-launch.json')
    Wait-Preload { $State = Read-PreloadState $Member; $State -and $State.ready -and $(if ($WaitForRendering) { $State.attached -and $State.rendering } else { $State.injectorReturned }) } "$Member genuine SDK $(if ($WaitForRendering) { 'authenticated attachment' } else { 'pre-device native return' })" 75
    if (-not $WaitForRendering) {
        $State = Read-PreloadState $Member; $Proof = $State.injectorProof
        # Exact-PID launches can resolve creation time before the watcher and
        # therefore omit the future-selection lifecycle event. The mapped proof
        # below validates the persisted native PID/creation/image selection.
        if ($Proof.runtimeMode -cne 'injected-runtime' -or $Proof.injectorTargetPid -ne $Target.process.Id -or -not (Test-PreloadPath $Proof.targetExecutablePath $TargetPath)) { throw 'Pre-device native return did not identify the fresh exact target.' }
        $CaseResult.preDeviceNativeResult = Read-PreloadInitialResult $Proof.injectorStdoutPath
        $MappedAddon = if ($UsePreload) { Join-Path (Join-Path $Proof.runDirectory 'preloaded-addons') ([IO.Path]::GetFileName($Registrations[$Member].addonPath)) } else { Join-Path $Proof.runDirectory 'electron_game_overlay.addon64' }
        $SourceAddon = if ($UsePreload) { $Registrations[$Member].addonPath } else { Join-Path $Sdks[$Member] 'runtime\win32-x64\reshade\electron_game_overlay.addon64' }
        $CaseResult.preDeviceMappedProof = Get-PreloadExactPidMappedEvidence $Entry $State (Join-Path $Proof.runDirectory 'ReShade64.dll') $MappedAddon (Get-FileHash -LiteralPath (Join-Path $Sdks[$Member] 'runtime\win32-x64\reshade\ReShade64.dll') -Algorithm SHA256).Hash (Get-FileHash -LiteralPath $SourceAddon -Algorithm SHA256).Hash
    }
    Retain-PreloadChildren $Entry
    return $Entry
}
function Send-PreloadCommand([string]$Member, [string]$Action, [string]$Window = 'main') {
    $script:Sequence++; $CommandPath = Join-Path $Apps[$Member].directory "$Member-command.json"
    Save-PreloadJson @{ sequence = $script:Sequence; action = $Action; window = $Window } "$CommandPath.tmp"
    Move-Item -LiteralPath "$CommandPath.tmp" -Destination $CommandPath -Force
    if ($Action -eq 'exit') { $Apps[$Member].expectedExit = $true }
    Wait-Preload { (Read-PreloadState $Member).commandSequence -eq $script:Sequence } "$Member $Action"
}
function Stop-PreloadApp($Entry, [bool]$Crash = $false) {
    $StopError = $null
    try {
        if (-not $Entry.process.HasExited) {
            Retain-PreloadChildren $Entry
            $Entry.expectedExit = $true
            if ($Crash) { $Entry.process.Kill() }
            elseif ($Apps[$Entry.member] -eq $Entry) { Send-PreloadCommand $Entry.member exit }
            else { $Entry.process.Kill() }
            if (-not $Entry.process.WaitForExit(10000)) { throw 'An owned producer did not exit.' }
        }
    } catch {
        $StopError = $_
        # A producer error must not make graceful command polling block cleanup.
        # The retained process handle still refers to this exact owned process.
        if (-not $Entry.process.HasExited) { $Entry.process.Kill(); $null = $Entry.process.WaitForExit(5000) }
    } finally {
        foreach ($Child in $Entry.children) { if (-not $Child.HasExited -and -not $Child.WaitForExit(3000)) { $Child.Kill(); if (-not $Child.WaitForExit(5000)) { throw 'An owned Electron child survived cleanup.' } } }
    }
    if ($StopError) { throw $StopError }
}
function Save-PreloadLogs($Entry, [string]$Directory) {
    if ($Entry.process.HasExited) {
        if (-not $Entry.stdout.Wait(5000) -or -not $Entry.stderr.Wait(5000)) { throw 'Owned process logs did not close.' }
        [IO.File]::WriteAllText((Join-Path $Directory 'stdout.log'), $Entry.stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $Directory 'stderr.log'), $Entry.stderr.GetAwaiter().GetResult())
    }
}
function Get-PreloadSnapshot([string]$Label, [int]$Windows, [int]$Tcp, [int]$Frames) {
    $script:SnapshotError = $null; $script:Snapshot = $null
    Wait-Preload {
        try {
            $Candidate = Get-CooperativeResourceSnapshot -Process $Target.process -ExpectedCreationTime100ns $TargetCreation
            $Hosts = @($Candidate.modules | Where-Object { [IO.Path]::GetFileName($_.path) -ieq 'ReShade64.dll' })
            if ($Hosts.Count -ne 1 -or $Candidate.registry.windows -ne $Windows -or $Candidate.registry.ranks -ne $Windows -or $Candidate.tcpThreads -ne $Tcp -or $Candidate.frameThreads -ne $Frames) {
                $script:SnapshotError = "hosts=$($Hosts.Count); windows=$($Candidate.registry.windows); ranks=$($Candidate.registry.ranks); tcp=$($Candidate.tcpThreads); frame=$($Candidate.frameThreads)"; return $false
            }
            $script:Snapshot = $Candidate; return $true
        } catch { $script:SnapshotError = $_.Exception.Message; return $false }
    } $Label 40
    Save-PreloadJson $script:Snapshot (Join-Path $CaseDirectory "$Label-resources.json")
    return $script:Snapshot
}
function Assert-PreloadMappedReuse($Before, $After, [string]$Path) {
    $Old = @($Before.modules | Where-Object { Test-PreloadPath $_.path $Path }); $New = @($After.modules | Where-Object { Test-PreloadPath $_.path $Path })
    if ($Old.Count -ne 1 -or $New.Count -ne 1 -or $Old[0].baseAddress -cne $New[0].baseAddress -or $Old[0].size -ne $New[0].size) { throw 'Activation did not reuse the exact preloaded module base.' }
    if (@($After.registry.participants | Where-Object { Test-PreloadPath $_.modulePath $Path }).Count -ne 1) { throw 'The activated member did not publish the exact preloaded private implementation.' }
    $OldCount = @($Before.modules | Where-Object { [IO.Path]::GetExtension($_.path) -ieq '.addon64' }).Count
    $NewCount = @($After.modules | Where-Object { [IO.Path]::GetExtension($_.path) -ieq '.addon64' }).Count
    if ($NewCount -ne $OldCount) { throw 'Initial preloaded activation mapped a duplicate private add-on.' }
}
function Read-PreloadInitialResult([string]$StdoutPath) {
    # A first-host result deliberately contains no private-module path. Validate
    # its exact four fields here; the separate mapped proof binds the selected
    # preloaded module, which lives below AddonPath rather than beside ReShade.
    $Stream = $null; $Reader = $null
    try {
        $Stream = [IO.File]::OpenRead($StdoutPath)
        if ($Stream.Length -lt 1 -or $Stream.Length -gt 1MB) { throw 'Initial injector stdout exceeds its bound.' }
        $Reader = [IO.StreamReader]::new($Stream, [Text.UTF8Encoding]::new($false, $true), $true)
        $Text = $Reader.ReadToEnd()
        if ($Text.Contains('ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ') -or $Text.Contains('ReShade injection not started.')) { throw 'Ambiguous initial injector diagnostics.' }
        $Prefix = 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT '
        $Lines = @($Text -split '\r?\n' | Where-Object { $_.StartsWith($Prefix, [StringComparison]::Ordinal) })
        if ($Lines.Count -ne 1) { throw 'Expected one structured first-host result.' }
        $Json = $Lines[0].Substring($Prefix.Length).Trim()
        if (-not $Json.StartsWith('{', [StringComparison]::Ordinal) -or -not $Json.EndsWith('}', [StringComparison]::Ordinal)) { throw 'First-host result is not one JSON object.' }
        $Record = $Json | ConvertFrom-Json -ErrorAction Stop
        if ((@($Record.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'pid,runtimeMode,schemaVersion,targetExecutablePath' -or
            ($Record.schemaVersion -isnot [int] -and $Record.schemaVersion -isnot [long]) -or $Record.schemaVersion -ne 1 -or
            ($Record.pid -isnot [int] -and $Record.pid -isnot [long]) -or $Record.pid -ne $Target.process.Id -or
            $Record.runtimeMode -isnot [string] -or $Record.runtimeMode -cne 'injected-runtime' -or
            $Record.targetExecutablePath -isnot [string] -or -not (Test-PreloadPath $Record.targetExecutablePath $TargetPath)) { throw 'First-host result does not match its strict initial schema and exact target.' }
        return $Record
    } finally { if ($Reader) { $Reader.Dispose() } elseif ($Stream) { $Stream.Dispose() } }
}
function Get-PreloadExactPidMappedEvidence($Entry, $State, [string]$ExpectedRuntimePath, [string]$ExpectedAddonPath, [string]$ExpectedRuntimeSha256, [string]$ExpectedAddonSha256) {
    $Binding = $State.injectorBinding; $Proof = $State.injectorProof
    if ($State.processId -ne $Entry.process.Id -or -not $State.injectorReturned -or
        $Binding.pid -ne $Target.process.Id -or $Binding.creationTime100ns -cne $TargetCreation -or
        -not (Test-PreloadPath $Binding.executablePath $TargetPath) -or -not (Test-PreloadPath $Binding.runDirectory $Proof.runDirectory) -or
        $Proof.injectorTargetPid -ne $Target.process.Id -or -not (Test-PreloadPath $Proof.targetExecutablePath $TargetPath) -or
        -not [IO.Path]::IsPathRooted($Binding.runDirectory) -or -not [IO.Path]::IsPathRooted($Binding.injectorExecutable) -or
        -not (Test-PreloadPath ([IO.Path]::GetDirectoryName($Binding.injectorExecutable)) $Binding.runDirectory) -or [IO.Path]::GetFileName($Binding.injectorExecutable) -ine 'inject.exe') { throw 'Captured exact-PID injector binding does not match the retained target and fresh stage.' }
    $Relative = [IO.Path]::GetRelativePath($Entry.runsRoot, $Binding.runDirectory)
    if (-not $Relative -or $Relative -in @('.', '..') -or $Relative.StartsWith('..\', [StringComparison]::Ordinal) -or [IO.Path]::IsPathRooted($Relative)) { throw 'Exact-PID injector binding escaped its app-owned runs root.' }
    foreach ($Path in @($ExpectedRuntimePath, $ExpectedAddonPath, $Proof.injectorStdoutPath)) { if (-not [IO.Path]::IsPathRooted($Path)) { throw 'Exact-PID mapped proof requires absolute module/stdout paths.' } }
    if (-not (Test-PreloadPath ([IO.Path]::GetDirectoryName($Proof.injectorStdoutPath)) $Binding.runDirectory)) { throw 'Exact-PID native stdout escaped its bound stage.' }
    # The fixture captures only a validated allowlist of real injector argv.
    # Recheck PID/creation flags here; legacy EGO_TARGET_SELECTED output contains
    # only a PID and must not be treated as an observed creation-time witness.
    $InvocationArgs = @($Binding.arguments)
    if ($InvocationArgs.Count -lt 5 -or -not (Test-PreloadPath $InvocationArgs[0] $TargetPath)) { throw 'Exact-PID argv omitted the target image.' }
    $Flags = @{}
    for ($Index = 1; $Index -lt $InvocationArgs.Count; $Index++) {
        $Flag = $InvocationArgs[$Index]
        if ($Flags.ContainsKey($Flag) -or $Flag -notin @('--pid', '--expected-creation-time-100ns', '--preloaded-addon-name', '--addon-only')) { throw 'Exact-PID argv contains ambiguous flags.' }
        if ($Flag -eq '--addon-only') { $Flags[$Flag] = $true }
        else { $Index++; if ($Index -ge $InvocationArgs.Count) { throw 'Exact-PID argv has a missing flag value.' }; $Flags[$Flag] = [string]$InvocationArgs[$Index] }
    }
    if ($Flags['--pid'] -cne [string]$Target.process.Id -or $Flags['--expected-creation-time-100ns'] -cne $TargetCreation) { throw 'Exact-PID argv changed the retained target incarnation.' }
    $ExpectedLeaf = [IO.Path]::GetFileName($ExpectedAddonPath)
    if ($ExpectedLeaf.StartsWith('ego-preload-', [StringComparison]::Ordinal) -and $Flags['--preloaded-addon-name'] -cne $ExpectedLeaf) { throw 'Exact-PID argv did not request the selected preloaded implementation.' }
    $PinnedHandle = $Target.process.Handle; $Target.process.Refresh()
    if ($PinnedHandle -eq [IntPtr]::Zero -or $Target.process.HasExited -or $Target.process.StartTime.ToFileTimeUtc().ToString() -cne $TargetCreation -or -not (Test-PreloadPath $Target.process.MainModule.FileName $TargetPath)) { throw 'Exact-PID proof no longer holds the original live target image and creation time.' }
    $Modules = @($Target.process.Modules)
    $RuntimeModules = @($Modules | Where-Object { $_.ModuleName -match '^ReShade(?:32|64)\.dll$' -or $_.FileVersionInfo.ProductName -eq 'ReShade' -or (Test-PreloadPath $_.FileName $ExpectedRuntimePath) })
    $AddonModules = @($Modules | Where-Object { Test-PreloadPath $_.FileName $ExpectedAddonPath })
    if ($RuntimeModules.Count -ne 1 -or -not (Test-PreloadPath $RuntimeModules[0].FileName $ExpectedRuntimePath) -or $AddonModules.Count -ne 1) { throw 'Exact-PID target did not map the one expected host and selected private implementation.' }
    $RuntimeHash = (Get-FileHash -LiteralPath $RuntimeModules[0].FileName -Algorithm SHA256).Hash
    $AddonHash = (Get-FileHash -LiteralPath $AddonModules[0].FileName -Algorithm SHA256).Hash
    if (-not (Test-PreloadPath $RuntimeHash $ExpectedRuntimeSha256) -or -not (Test-PreloadPath $AddonHash $ExpectedAddonSha256)) { throw 'Mapped exact-PID host or selected private implementation differs from its sealed source bytes.' }
    $Target.process.Refresh()
    if ($Target.process.HasExited -or $Target.process.StartTime.ToFileTimeUtc().ToString() -cne $TargetCreation) { throw 'Exact-PID target exited during module inspection.' }
    return [ordered]@{
        scope = 'Captured real exact-PID/creation-time injector argv plus retained authoritative OS target handle, strict native result checked separately, mapped module paths and full current file hashes. Legacy PID-only stdout is not a creation witness; no remote-memory or historical load-count claim.'
        targetPid = $Target.process.Id; targetCreationTime100ns = $TargetCreation; targetExecutablePath = $TargetPath
        injectorBinding = $Binding; runtimeCount = 1; runtimeModulePath = $RuntimeModules[0].FileName; runtimeBaseAddress = $RuntimeModules[0].BaseAddress.ToInt64().ToString(); runtimeSha256 = $RuntimeHash
        selectedAddonModulePath = $AddonModules[0].FileName; selectedAddonBaseAddress = $AddonModules[0].BaseAddress.ToInt64().ToString(); selectedAddonSha256 = $AddonHash
    }
}
function Assert-PreloadAuthentication([string]$Member) {
    $State = Read-PreloadState $Member
    if (-not $State.attached -or -not $State.rendering -or $State.targetPid -ne $Target.process.Id -or
        $State.authenticatedTarget.pid -ne $Target.process.Id -or $State.authenticatedTarget.creationTime100ns -cne $TargetCreation -or
        -not (Test-PreloadPath $State.authenticatedTarget.executablePath $TargetPath) -or $State.transport.producerPid -ne $Apps[$Member].process.Id -or
        $State.transport.tokenFingerprint -cnotmatch '^[a-f0-9]{64}$' -or -not $State.windows.main.visible) { throw 'Private authentication does not name the exact retained target and producer.' }
    return $State
}
function Activate-PreloadTarget {
    Wait-Preload { $Target.process.Refresh(); $script:Hwnd = $Target.process.MainWindowHandle; $script:Hwnd -ne [IntPtr]::Zero -and [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($script:Hwnd) } 'foreground controlled demo' 12
}
function Move-PreloadPointer([int]$X, [int]$Y) { if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($Hwnd)) { throw 'Controlled demo lost foreground input.' }; $null = [ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint($Hwnd, $X, $Y); Start-Sleep -Milliseconds 80 }
function Click-Preload([int]$X, [int]$Y) { Move-PreloadPointer $X $Y; [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick() }
function Type-Preload([string]$Member, [string]$Text, [string]$Window = 'main') {
    Send-PreloadCommand $Member clear $Window; Send-PreloadCommand $Member focus $Window
    Wait-Preload { $State = Read-PreloadState $Member; $State.intercepting -and $State.focusedWindowId -eq $State.windows.$Window.id } "$Member acknowledged native focus"
    foreach ($Character in $Text.ToCharArray()) {
        if (-not [ReShadeClientSdkGate.NativeInputMethods]::IsForegroundWindow($Hwnd)) { throw 'Controlled demo lost foreground while typing.' }
        [EgoPreloadDemoPixels]::Letter([uint16][char]$Character.ToString().ToUpperInvariant()); Start-Sleep -Milliseconds 60
    }
    Wait-Preload { $State = Read-PreloadState $Member; $State.windows.$Window.value -ceq $Text -and @($State.windows.$Window.heldKeys).Count -eq 0 } "$Member independent typed text"
}
function Set-PreloadInterception([string]$First, [string]$Late, [bool]$FirstEnabled, [bool]$LateEnabled) {
    Send-PreloadCommand $First $(if ($FirstEnabled) { 'intercept' } else { 'release' })
    Send-PreloadCommand $Late $(if ($LateEnabled) { 'intercept' } else { 'release' })
    Wait-Preload { (Read-PreloadState $First).requestedInterception -eq $FirstEnabled -and (Read-PreloadState $Late).requestedInterception -eq $LateEnabled -and (Read-PreloadState $First).intercepting -eq ($FirstEnabled -or $LateEnabled) -and (Read-PreloadState $Late).intercepting -eq ($FirstEnabled -or $LateEnabled) } 'cross-app OR interception'
}
function Assert-PreloadPixel([int]$X, [int]$Y, [uint32]$Expected, [string]$Label) { Wait-Preload { [EgoPreloadDemoPixels]::Pixel($Hwnd, $X, $Y) -eq $Expected } $Label 12; $CaseResult.checks.Add($Label) }

if (-not [Environment]::Is64BitProcess) { throw 'Run the DirectX preload demo gates in 64-bit PowerShell.' }
if (-not ('EgoPreloadDemoPixels' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EgoPreloadDemoPixels {
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit,Size=32)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
 [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public uint size,flags; public IntPtr cursor; public POINT point; }
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h,IntPtr dc);
 [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc,int x,int y);
 [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO c);
 [DllImport("user32.dll")] static extern IntPtr LoadCursor(IntPtr module,IntPtr id);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] input,int size);
 public static uint Pixel(IntPtr h,int x,int y) { var p=new POINT{x=x,y=y};if(!ClientToScreen(h,ref p))throw new Exception("ClientToScreen failed");var dc=GetDC(IntPtr.Zero);try{return GetPixel(dc,p.x,p.y);}finally{ReleaseDC(IntPtr.Zero,dc);} }
 public static bool CursorIs(int id) { var c=new CURSORINFO{size=(uint)Marshal.SizeOf(typeof(CURSORINFO))};return GetCursorInfo(ref c)&&c.flags==1&&c.cursor==LoadCursor(IntPtr.Zero,new IntPtr(id)); }
 static void Send(INPUT input) { if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("SendInput failed"); }
 public static void Letter(ushort vk) { Send(new INPUT{type=1,data=new UNION{key=new KEY{vk=vk}}});Send(new INPUT{type=1,data=new UNION{key=new KEY{vk=vk,flags=2}}}); }
 public static void Wheel(int delta,bool horizontal) { Send(new INPUT{data=new UNION{mouse=new MOUSE{flags=horizontal?0x1000u:0x800u,data=unchecked((uint)delta)}}}); }
}
'@
}
if ($RequestedFunctionsOnly) { return }
if (-not $RequestedSkipBuild) {
    Push-Location $RuntimeRoot
    try {
        & cmake.exe --preset $CMakePreset
        if ($LASTEXITCODE -ne 0) { throw 'Demo CMake configure failed.' }
        & cmake.exe --build $ProductionBuildRoot --config RelWithDebInfo --target $HostTarget --parallel
        if ($LASTEXITCODE -ne 0) { throw 'Demo build failed.' }
    } finally { Pop-Location }
}
$ElectronExecutable = (Resolve-Path -LiteralPath $ElectronExecutable).Path
$NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$Sdks = @{ a = (Resolve-Path -LiteralPath $SdkDistA).Path; b = (Resolve-Path -LiteralPath $SdkDistB).Path }
$SdkConsumers = @{}
foreach ($File in @($BuiltHost, $ProducerFixture, $RegistrationFixture, (Join-Path $Sdks.a 'preload.js'), (Join-Path $Sdks.b 'preload.js'))) { if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Required built artifact missing: $File" } }
. (Join-Path $PSScriptRoot 'visual-test-display-lease.ps1')
$PreloadBuildRoot = Join-Path $RepoRoot 'build\pl'
$RunDirectory = Join-Path $PreloadBuildRoot ('r-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
New-Item -ItemType Directory -Path $RunDirectory | Out-Null
$Report = [ordered]@{ schemaVersion = 1; scope = 'Repository DirectX demos only; Windows SendInput, not physical keyboard; OS module paths/bases plus file hashes, not remote memory attestation.'; backend = $Backend; sdkDistA = $Sdks.a; sdkDistB = $Sdks.b; cases = [Collections.Generic.List[object]]::new(); status = 'running' }
$Failure = $null
try {
    foreach ($Cell in @('self-load', 'production-injection')) {
        if ($Scope -ne 'all' -and $Scope -ne $Cell) { continue }
        $CaseDirectory = Join-Path $RunDirectory $(if ($Cell -eq 'self-load') { 's' } else { 'i' }); $TargetDirectory = Join-Path $CaseDirectory 't'; $Stage = Join-Path $CaseDirectory 'h'; $StorageRoot = Join-Path $CaseDirectory 'r'
        New-Item -ItemType Directory -Path $TargetDirectory, $Stage | Out-Null
        $TargetPath = Join-Path $TargetDirectory 'p.exe'; Copy-Item -LiteralPath $BuiltHost -Destination $TargetPath
        $Barrier = Join-Path $TargetDirectory 'electron-game-overlay-startup-barrier.enabled'
        [IO.File]::WriteAllText($Barrier, 'controlled pre-device barrier')
        [IO.File]::WriteAllText((Join-Path $TargetDirectory 'reshade-input-gate.enabled'), '1')
        [IO.File]::WriteAllText((Join-Path $TargetDirectory 'electron-game-overlay-demo-present.enabled'), '1')
        $ApplicationIds = @{ a = 'com.electron-game-overlay.preload-demo.a'; b = 'com.electron-game-overlay.preload-demo.b' }
        $Registrations = @{}
        foreach ($Member in @('a', 'b')) { $Registrations[$Member] = Invoke-PreloadRegistration $Member register (Join-Path $CaseDirectory "$Member-registration.json") }
        $CaseResult = [ordered]@{ name = $Cell; status = 'running'; checks = [Collections.Generic.List[string]]::new(); registrations = $Registrations; distinctNativeBuilds = $Registrations.a.addonBuildId -cne $Registrations.b.addonBuildId; target = $null; cleanupErrors = [Collections.Generic.List[string]]::new() }
        $Report.cases.Add($CaseResult)
        $Apps = @{}; $AllApps = [Collections.Generic.List[object]]::new(); $Target = $null; $script:Sequence = 0; $MouseHeld = $false
        try {
            if ($Cell -eq 'self-load') {
                $SnapshotDescription = Invoke-PreloadRegistration a snapshot (Join-Path $CaseDirectory 'host-snapshot.json') (Join-Path $Stage 'addons')
                $RuntimeSource = Join-Path $Sdks.a 'runtime\win32-x64\reshade\ReShade64.dll'
                Copy-Item -LiteralPath $RuntimeSource -Destination (Join-Path $Stage 'ReShade64.dll')
                [IO.File]::WriteAllText((Join-Path $Stage 'ReShade.ini'), "[INSTALL]`nBasePath=.`n[ADDON]`nAddonPath=$($SnapshotDescription.snapshot.directory)`n", [Text.UTF8Encoding]::new($false))
                Write-OwnedOverlayRunMarker -RunDirectory $Stage -BuildRoot $PreloadBuildRoot
                [IO.File]::WriteAllText((Join-Path $TargetDirectory 'electron-game-overlay-preload-runtime.path'), (Join-Path $Stage 'ReShade64.dll'), [Text.UTF8Encoding]::new($false))
                $CaseResult.initialization = 'Test-owned target self-LoadLibrary before devices; real ReShade scans an external immutable AddonPath; no producer is running.'
            } else { $CaseResult.initialization = 'Genuine public SDK first-host injection before devices; initiating app active, second registered app dormant.' }
            $Target = Start-PreloadProcess (New-PreloadProcessInfo $TargetPath @() $true)
            $TargetCreation = $Target.process.StartTime.ToFileTimeUtc().ToString()
            $CaseResult.target = @{ pid = $Target.process.Id; creationTime100ns = $TargetCreation; executablePath = $TargetPath; sha256 = (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash }
            if ($Cell -eq 'production-injection') {
                $First = 'a'; $Late = 'b'
                $null = Start-PreloadApp $First first 1 $false
            }
            Remove-Item -LiteralPath $Barrier
            Wait-Preload { Test-Path -LiteralPath (Join-Path $TargetDirectory 'electron-game-overlay-demo-present.ready') -PathType Leaf } 'eight successful controlled demo Presents' 30
            $PresentText = Get-Content -LiteralPath (Join-Path $TargetDirectory 'electron-game-overlay-demo-present.ready') -Raw
            if ($PresentText -notmatch '(?m)^EGO_CONTROLLED_PRESENT_V1\r?$' -or $PresentText -notmatch "(?m)^pid=$($Target.process.Id)\r?$" -or $PresentText -notmatch "(?m)^creationFileTime=$TargetCreation\r?$" -or $PresentText -notmatch '(?m)^successfulPresents=8\r?$') { throw 'The initial Present oracle did not bind the exact target incarnation.' }
            Activate-PreloadTarget
            $Initial = Get-PreloadSnapshot 'initial-scan' $(if ($Cell -eq 'self-load') { 0 } else { 1 }) $(if ($Cell -eq 'self-load') { 0 } else { 1 }) $(if ($Cell -eq 'self-load') { 0 } else { 1 })
            $ReShadeHostModule = @($Initial.modules | Where-Object { [IO.Path]::GetFileName($_.path) -ieq 'ReShade64.dll' })[0]
            $HostDirectory = [IO.Path]::GetDirectoryName($ReShadeHostModule.path)
            $ExpectedHostSource = Join-Path $Sdks.a 'runtime\win32-x64\reshade\ReShade64.dll'
            if ((Get-FileHash -LiteralPath $ReShadeHostModule.path -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $ExpectedHostSource -Algorithm SHA256).Hash) { throw 'The sole mapped ReShade host differs from the selected SDK runtime.' }
            $CaseResult.host = @{ path = $ReShadeHostModule.path; baseAddress = $ReShadeHostModule.baseAddress; sha256 = (Get-FileHash -LiteralPath $ReShadeHostModule.path -Algorithm SHA256).Hash }
            $Preloaded = @{}
            foreach ($Member in @('a', 'b')) {
                $Leaf = [IO.Path]::GetFileName($Registrations[$Member].addonPath)
                $Mapped = @($Initial.modules | Where-Object { [IO.Path]::GetFileName($_.path) -ceq $Leaf })
                if ($Mapped.Count -ne 1 -or (Get-FileHash -LiteralPath $Mapped[0].path -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $Registrations[$Member].addonPath -Algorithm SHA256).Hash) { throw "Real ReShade did not scan the registered $Member payload exactly once." }
                $Preloaded[$Member] = $Mapped[0].path
            }
            if ($Cell -eq 'self-load') {
                if ($Initial.registry.lifetimeSlots -ne 0 -or $Initial.registry.activeParticipants -ne 0 -or $Initial.registry.focus.participant -ne 0 -or $Initial.registry.capture.participant -ne 0 -or @($Apps.Values).Count -ne 0) { throw 'Offline preload allocated a private participant or input ownership.' }
                $ScanLog = Get-Content -LiteralPath (Join-Path $HostDirectory 'ReShade.log') -Raw
                $OrderedLoads = @([regex]::Matches($ScanLog, "Loading add-on from '[^']*(ego-preload-[^']+\.addon64)'"))
                if ($OrderedLoads.Count -ne 2) { throw 'Cannot authoritatively identify the first scanner-loaded EGO dispatcher.' }
                $Dispatcher = @('a', 'b' | Where-Object { [IO.Path]::GetFileName($Preloaded[$_]) -ceq $OrderedLoads[0].Groups[1].Value })
                if ($Dispatcher.Count -ne 1) { throw 'First scanner-loaded module does not match a registration.' }
                $Late = $Dispatcher[0]; $First = if ($Late -eq 'a') { 'b' } else { 'a' }
                $CaseResult.offlineDispatcher = $Late; $CaseResult.firstActiveMember = $First
                $CaseResult.checks.Add('Real scanner mapped both registered DLLs with zero participants/windows/ranks/private TCP or frame workers while both apps were offline')
                $null = Start-PreloadApp $First first
                $OnlyFirst = Get-PreloadSnapshot 'first-app-active-dispatcher-offline' 1 1 1
                Assert-PreloadMappedReuse $Initial $OnlyFirst $Preloaded[$First]
                $CaseResult.checks.Add('A private implementation activates at its existing module base while the supplying app of the first dispatcher remains offline')
            } else {
                Wait-Preload { (Read-PreloadState $First).rendering } 'initiating SDK app rendering'
                $InitialAttachment = (Read-PreloadState $First).attachment
                $CaseResult.initialNativeResult = Read-PreloadInitialResult $InitialAttachment.injectorStdoutPath
                if ($InitialAttachment.runtimeMode -cne 'injected-runtime' -or $CaseResult.initialNativeResult.runtimeMode -cne 'injected-runtime') { throw 'A fresh-target production injection did not retain initial injected-runtime provenance.' }
                $CaseResult.initialMappedProof = Get-PreloadExactPidMappedEvidence $Apps[$First] (Read-PreloadState $First) $ReShadeHostModule.path $Preloaded[$First] $CaseResult.host.sha256 (Get-FileHash -LiteralPath $Registrations[$First].addonPath -Algorithm SHA256).Hash
                if (@($Initial.registry.participants | Where-Object { Test-PreloadPath $_.modulePath $Preloaded[$First] }).Count -ne 1 -or @($Initial.modules | Where-Object { [IO.Path]::GetExtension($_.path) -ieq '.addon64' }).Count -ne 2) { throw 'First-host injection did not activate its scanned selected implementation exactly once.' }
                $CaseResult.checks.Add('Production SDK injected one external ReShade host before devices and its immutable AddonPath scanned the offline peer')
            }
            $null = Start-PreloadApp $Late late
            $Both = Get-PreloadSnapshot 'both-apps-active' 2 2 2
            Assert-PreloadMappedReuse $Initial $Both $Preloaded[$Late]
            if ($Cell -eq 'self-load') { Assert-PreloadMappedReuse $Initial $Both $Preloaded[$First] }
            $FirstState = Assert-PreloadAuthentication $First; $LateState = Assert-PreloadAuthentication $Late
            if ($FirstState.transport.port -eq $LateState.transport.port -or $FirstState.transport.tokenFingerprint -ceq $LateState.transport.tokenFingerprint -or $FirstState.windows.main.id -ne $LateState.windows.main.id) { throw 'Two apps did not retain private routes and colliding local window IDs.' }
            $CaseResult.privateTransports = @{ first = $FirstState.transport; late = $LateState.transport }
            Activate-PreloadTarget
            Assert-PreloadPixel 55 130 0x2828c6 'first app red surface'
            Assert-PreloadPixel 430 210 0xc06515 'second app blue surface'
            Set-PreloadInterception $First $Late $true $true
            Type-Preload $First alpha; Type-Preload $Late bravo
            if ((Read-PreloadState $First).windows.main.value -cne 'alpha') { throw 'Typing into the peer altered the first app.' }
            $CaseResult.checks.Add('Distinct authenticated routes isolate colliding local window IDs and keyboard input')
            Send-PreloadCommand $First create-extra
            Wait-Preload { $State = Read-PreloadState $First; $State.windows.extra.alphaProbe.hole -eq 0 -and $State.windows.extra.alphaProbe.opaque -eq 255 } 'genuine transparent Electron paint'
            Assert-PreloadPixel 230 235 0xc06515 'interleaved peer above first main'
            Assert-PreloadPixel 480 350 0x327d2e 'interleaved extra above peer'
            Assert-PreloadPixel 470 430 0xc06515 'alpha cutout reveals peer pixels'
            Click-Preload 100 350
            Assert-PreloadPixel 340 335 0x2828c6 'one local window raises independently across apps'
            $PeerDowns = (Read-PreloadState $Late).windows.main.downs; $ExtraDowns = (Read-PreloadState $First).windows.extra.downs
            Click-Preload 470 430
            Wait-Preload { (Read-PreloadState $Late).windows.main.downs -eq $PeerDowns + 1 } 'alpha cutout routes to peer'
            if ((Read-PreloadState $First).windows.extra.downs -ne $ExtraDowns) { throw 'Transparent extra consumed a peer click.' }
            Click-Preload 510 350
            Assert-PreloadPixel 480 350 0x327d2e 'extra raises independently'
            $CaptureDowns = (Read-PreloadState $First).windows.extra.downs
            $CaptureUps = (Read-PreloadState $First).windows.extra.ups
            $PeerUps = (Read-PreloadState $Late).windows.main.ups
            Move-PreloadPointer 510 350; [ReShadeClientSdkGate.NativeInputMethods]::SendLeftDown(); $MouseHeld = $true
            Wait-Preload { (Read-PreloadState $First).windows.extra.downs -eq $CaptureDowns + 1 } 'extra owns pointer capture'
            Move-PreloadPointer 200 430; [ReShadeClientSdkGate.NativeInputMethods]::SendLeftUp(); $MouseHeld = $false
            Wait-Preload { (Read-PreloadState $First).windows.extra.ups -gt $CaptureUps } 'capture release outside its original window'
            if ((Read-PreloadState $Late).windows.main.ups -ne $PeerUps) { throw 'Captured pointer release leaked to the peer.' }
            foreach ($Cursor in @(@(300, 295, 32513, 'text'), @(290, 340, 32649, 'hand'), @(410, 340, 32644, 'ew-resize'))) { Move-PreloadPointer $Cursor[0] $Cursor[1]; $CursorId = [int]$Cursor[2]; Wait-Preload { [EgoPreloadDemoPixels]::CursorIs($CursorId) } "native $($Cursor[3]) cursor" 10 }
            Move-PreloadPointer 310 410; [ReShadeClientSdkGate.NativeInputMethods]::SendWheel(-120)
            Wait-Preload { (Read-PreloadState $First).windows.extra.scroll.y -gt 0 } 'independent wheel routing'
            [EgoPreloadDemoPixels]::Wheel(120, $true)
            Wait-Preload { (Read-PreloadState $First).windows.extra.scroll.x -gt 0 } 'independent horizontal wheel routing'
            Move-PreloadPointer 360 250; [ReShadeClientSdkGate.NativeInputMethods]::SendLeftDown(); $MouseHeld = $true; Start-Sleep -Milliseconds 100
            Move-PreloadPointer 420 290; [ReShadeClientSdkGate.NativeInputMethods]::SendLeftUp(); $MouseHeld = $false
            Assert-PreloadPixel 565 325 0x327d2e 'caption drag updates native placement'
            Set-PreloadInterception $First $Late $true $false; Set-PreloadInterception $First $Late $false $true; Set-PreloadInterception $First $Late $false $false; Set-PreloadInterception $First $Late $true $true
            $CaseResult.checks.Add('Alpha hit testing, window order, three cursor shapes, wheel, caption drag and OR interception pass across apps')
            Send-PreloadCommand $First focus extra
            $SurvivorFingerprint = (Read-PreloadState $Late).transport.tokenFingerprint
            Stop-PreloadApp $Apps[$First] $true
            $Survivor = Get-PreloadSnapshot 'survivor-after-peer-crash' 1 1 2
            $SurvivorParticipant = @($Survivor.registry.participants | Where-Object { Test-PreloadPath $_.modulePath $Preloaded[$Late] })
            if ($SurvivorParticipant.Count -ne 1 -or $Survivor.registry.focus.participant -notin @(0, $SurvivorParticipant[0].id) -or $Survivor.registry.capture.participant -ne 0 -or $Survivor.registry.captureButtons -ne 0) { throw 'Peer crash retained retired input focus or capture ownership.' }
            if ((Assert-PreloadAuthentication $Late).transport.tokenFingerprint -cne $SurvivorFingerprint) { throw 'Peer crash replaced the surviving private route.' }
            Assert-PreloadPixel 430 210 0xc06515 'survivor remains composited after peer crash'
            Type-Preload $Late survivor
            $null = Start-PreloadApp $First first 2
            $Restarted = Get-PreloadSnapshot 'restarted-app-fresh-member' 2 2 3
            if (@($Restarted.registry.participants | Where-Object { Test-PreloadPath $_.modulePath $Preloaded[$First] }).Count -ne 1) { throw 'Restart rebound a consumed preloaded implementation.' }
            $OldBases = @($Both.modules | Where-Object { [IO.Path]::GetExtension($_.path) -ieq '.addon64' }).Count
            if (@($Restarted.modules | Where-Object { [IO.Path]::GetExtension($_.path) -ieq '.addon64' }).Count -ne $OldBases + 1) { throw 'Consumed-member restart did not use one fresh staged engine.' }
            Type-Preload $First restarted
            if ((Assert-PreloadAuthentication $Late).transport.tokenFingerprint -cne $SurvivorFingerprint) { throw 'Restart changed the surviving app route.' }
            $CaseResult.checks.Add('Crash removes the retired app surface/input; survivor route and input persist; restarted app safely uses one fresh engine')
            $null = Invoke-PreloadRegistration $First unregister (Join-Path $CaseDirectory 'unregister-retired-app.json')
            $Future = Invoke-PreloadRegistration $Late snapshot (Join-Path $CaseDirectory 'future-host-snapshot.json') (Join-Path $CaseDirectory 'future-host-addons')
            if (@($Future.selection.payloads | Where-Object { $_.fileName -ceq [IO.Path]::GetFileName($Preloaded[$First]) }).Count -ne 0 -or -not (Test-Path -LiteralPath $Preloaded[$First])) { throw 'Unregister mutated an existing snapshot or remained in a future snapshot.' }
            $AfterUnregister = Get-PreloadSnapshot 'unregister-keeps-current-target' 2 2 3
            if (@($AfterUnregister.modules | Where-Object { Test-PreloadPath $_.path $Preloaded[$First] }).Count -ne 1) { throw 'Unregister unloaded a consumed module.' }
            $CaseResult.checks.Add('Unregister changes future snapshots while mapped modules and the current target remain intact')
            foreach ($Member in @($First, $Late)) { Send-PreloadCommand $Member release; Stop-PreloadApp $Apps[$Member] }
            $Final = Get-PreloadSnapshot 'all-apps-offline' 0 0 3
            if ($Final.registry.focus.participant -ne 0 -or $Final.registry.capture.participant -ne 0 -or $Final.registry.captureButtons -ne 0) { throw 'No-app state retained focus or capture.' }
            if (Test-Path -LiteralPath (Join-Path $TargetDirectory 'ReShade64.dll')) { throw 'Runtime was written into the controlled target directory.' }
            if (Test-Path -LiteralPath (Join-Path $TargetDirectory 'ReShade.ini')) { throw 'ReShade configuration was written into the controlled target directory.' }
            $CaseResult.checks.Add('Final no-app state has no windows/ranks/private TCP/focus/capture and the target directory has no installed ReShade files')
            $CaseResult.status = 'passed'
        } catch { $CaseResult.status = 'failed'; $CaseResult.error = $_.Exception.Message; throw }
        finally {
            if ($MouseHeld) { try { [ReShadeClientSdkGate.NativeInputMethods]::SendLeftUp() } catch { $CaseResult.cleanupErrors.Add($_.Exception.Message) } }
            foreach ($Entry in $AllApps) {
                try { Stop-PreloadApp $Entry } catch { $CaseResult.cleanupErrors.Add($_.Exception.Message) }
                try { Save-PreloadLogs $Entry $Entry.directory } catch { $CaseResult.cleanupErrors.Add($_.Exception.Message) }
            }
            if ($Target) {
                try {
                    $CloseRequested = $false; $Forced = $false
                    $WasAlive = -not $Target.process.HasExited
                    if ($WasAlive) { $CloseRequested = $Target.process.CloseMainWindow(); if (-not $Target.process.WaitForExit(5000)) { $Forced = $true; $Target.process.Kill(); $null = $Target.process.WaitForExit(5000) } }
                    $CaseResult.targetCleanup = Get-PreloadProcessEvidence $Target 'target-cleanup-complete'
                    $CaseResult.targetCleanup.wasRunningBeforeCleanup = $WasAlive
                    $CaseResult.targetCleanup.closeRequested = $CloseRequested
                    $CaseResult.targetCleanup.forcedTermination = $Forced
                    $CaseResult.targetDiagnostics = Get-PreloadTargetDiagnostics
                    Save-PreloadJson $CaseResult.targetCleanup (Join-Path $CaseDirectory 'target-cleanup.json')
                    Save-PreloadLogs $Target $TargetDirectory
                } catch { $CaseResult.cleanupErrors.Add($_.Exception.Message) }
            }
            if ($CaseResult.cleanupErrors.Count -gt 0) { $CaseResult.status = 'failed'; if (-not $CaseResult.error) { $CaseResult.error = 'Owned process cleanup failed.' } }
            Save-PreloadJson $CaseResult (Join-Path $CaseDirectory 'result.json')
        }
        if ($CaseResult.status -ne 'passed') { throw 'Preload case cleanup failed.' }
    }
    $Report.status = 'passed'
} catch { $Failure = $_; $Report.status = 'failed'; $Report.error = $_.Exception.Message }
finally { Save-PreloadJson $Report (Join-Path $RunDirectory 'report.json') }
if ($Failure) { throw $Failure }
Write-Host "${BackendLabel}_CLIENT_SDK_PRELOADED_ADDONS_GATE_PASS $RunDirectory"
