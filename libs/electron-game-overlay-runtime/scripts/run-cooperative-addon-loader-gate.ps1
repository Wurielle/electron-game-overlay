[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InjectorPath,
    [Parameter(Mandatory = $true)][ValidateSet('x64','Win32')][string]$Architecture,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-F]{32}$')][string]$AddonBuildId,
    [string]$InjectorSourcePath
)
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$FixtureSource = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\cooperative-addon-loader'
$Build = Join-Path $RepoRoot "build\cooperative-addon-loader\compile-$Architecture"
$Run = Join-Path $RepoRoot ('build\cooperative-addon-loader\run-' + $Architecture + '-' + [Guid]::NewGuid().ToString('N'))
$Injector = (Resolve-Path -LiteralPath $InjectorPath).Path
$InjectorHash = (Get-FileHash -LiteralPath $Injector -Algorithm SHA256).Hash
if (-not $InjectorSourcePath) { $InjectorSourcePath = Join-Path $RepoRoot 'build\electron-game-overlay-runtime\_deps\reshade-src\tools\injector.cpp' }
$InjectorSource = (Resolve-Path -LiteralPath $InjectorSourcePath).Path
$SourceContent = (Get-Content -LiteralPath $InjectorSource -Raw).Replace("`r`n","`n")
$SourceHasher = [Security.Cryptography.SHA256]::Create()
$InjectorSourceHash = [BitConverter]::ToString($SourceHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($SourceContent))).Replace('-','')
$SourceHasher.Dispose()
New-Item -ItemType Directory -Path $Run | Out-Null
& cmake -S $FixtureSource -B $Build -G 'Visual Studio 17 2022' -A $Architecture "-DADDON_BUILD_ID=$AddonBuildId" "-DINJECTOR_SOURCE=$InjectorSource"
if ($LASTEXITCODE -ne 0) { throw 'Controlled loader fixture configure failed.' }
& cmake --build $Build --config RelWithDebInfo
if ($LASTEXITCODE -ne 0) { throw 'Controlled loader fixture build failed.' }
$GuardOutput = & (Join-Path $Build 'RelWithDebInfo\loader_fixture_session_guard.exe')
if ($LASTEXITCODE -ne 0) { throw 'Actual token session guard unit failed.' }
$SessionGuard = $GuardOutput | ConvertFrom-Json
if (-not $SessionGuard.sameTokenSessionAccepted -or -not $SessionGuard.invalidTargetQueryFailedClosed -or -not $SessionGuard.differentSessionPolicyRejected) { throw 'Session guard unit omitted an assertion.' }
$GuardOutput | Set-Content -LiteralPath (Join-Path $Run 'session-guard.json') -Encoding UTF8
$RuntimeLeaf = if ($Architecture -eq 'x64') { 'ReShade64.dll' } else { 'ReShade32.dll' }
$AddonLeaf = if ($Architecture -eq 'x64') { 'electron_game_overlay.addon64' } else { 'electron_game_overlay.addon32' }
$InjectorChildren = [Collections.Generic.List[object]]::new()
$TargetChildren = [Collections.Generic.List[object]]::new()

function Start-OwnedTarget([string]$Name, [switch]$Pinned) {
    $Directory = Join-Path $Run $Name
    New-Item -ItemType Directory -Path $Directory | Out-Null
    $Executable = Join-Path $Directory 'loader_fixture_target.exe'
    Copy-Item -LiteralPath (Join-Path $Build 'RelWithDebInfo\loader_fixture_target.exe') -Destination $Executable
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = $Executable
    $Info.WorkingDirectory = $Directory
    $Info.UseShellExecute = $false
    $Info.CreateNoWindow = $true
    $Info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    if ($Pinned) { $Info.Arguments = '--pin-empty-claim' }
    foreach ($Variable in @('RESHADE_BASE_PATH_OVERRIDE','ELECTRON_GAME_OVERLAY_RUN_DIRECTORY')) { $Info.Environment.Remove($Variable) | Out-Null }
    $Process = [Diagnostics.Process]::new()
    $Process.StartInfo = $Info
    if (-not $Process.Start()) { throw 'Could not launch the owned console fixture.' }
    $TargetChildren.Add($Process)
    $Line = $Process.StandardOutput.ReadLineAsync()
    if (-not $Line.Wait(5000)) { $Process.Kill(); $Process.WaitForExit(); throw 'Owned target identity timed out.' }
    $Identity = $Line.Result | ConvertFrom-Json
    if ($Identity.pid -ne $Process.Id) { throw 'Owned target reported a different PID.' }
    return [pscustomobject]@{ Process=$Process; Identity=$Identity; Executable=$Executable; Directory=$Directory }
}

function New-Stage([string]$Name) {
    $Directory = Join-Path $Run $Name
    New-Item -ItemType Directory -Path $Directory | Out-Null
    Copy-Item -LiteralPath $Injector -Destination (Join-Path $Directory 'injector.exe')
    if ((Get-FileHash -LiteralPath (Join-Path $Directory 'injector.exe') -Algorithm SHA256).Hash -ne $InjectorHash) { throw 'Injector bytes changed during staging.' }
    Copy-Item -LiteralPath (Join-Path $Build 'RelWithDebInfo\loader_fixture_host.dll') -Destination (Join-Path $Directory $RuntimeLeaf)
    Copy-Item -LiteralPath (Join-Path $Build 'RelWithDebInfo\loader_fixture_member.dll') -Destination (Join-Path $Directory $AddonLeaf)
    '[GENERAL]' | Set-Content -LiteralPath (Join-Path $Directory 'ReShade.ini') -Encoding ASCII
    return $Directory
}

function Start-OwnedInjector($Target, [string]$Stage, [switch]$Only, [string]$Creation) {
    $Expected = if ($Creation) { $Creation } else { [string]$Target.Identity.creationTime100ns }
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = Join-Path $Stage 'injector.exe'
    $Info.Arguments = '"' + $Target.Executable + '" --pid ' + $Target.Process.Id + ' --expected-creation-time-100ns ' + $Expected
    if ($Only) { $Info.Arguments += ' --addon-only' }
    $Info.WorkingDirectory = $Stage
    $Info.UseShellExecute = $false
    $Info.CreateNoWindow = $true
    $Info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $Child = [Diagnostics.Process]::new()
    $Child.StartInfo = $Info
    if (-not $Child.Start()) { throw 'Could not start the staged injector.' }
    $Out = $Child.StandardOutput.ReadToEndAsync()
    $Err = $Child.StandardError.ReadToEndAsync()
    $Pending = [pscustomobject]@{ Child=$Child; Out=$Out; Err=$Err; Stage=$Stage }
    $InjectorChildren.Add($Pending)
    return $Pending
}

function Complete-OwnedInjector($Pending) {
    $Child = $Pending.Child
    $Out = $Pending.Out
    $Err = $Pending.Err
    $Stage = $Pending.Stage
    try {
        if (-not $Child.WaitForExit(35000)) { throw 'Owned injector timed out.' }
    } finally {
        if (-not $Child.HasExited) { $Child.Kill(); $Child.WaitForExit() }
        $Exit = $Child.ExitCode
        $Text = $Out.GetAwaiter().GetResult()
        $ErrorText = $Err.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $Stage 'injector.stdout.txt'), $Text)
        [IO.File]::WriteAllText((Join-Path $Stage 'injector.stderr.txt'), $ErrorText)
    }
    $ResultLine = @($Text -split '\r?\n' | Where-Object { $_.StartsWith('ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ') })
    $Result = if ($ResultLine.Count -eq 1) { $ResultLine[0].Substring('ELECTRON_GAME_OVERLAY_INJECTOR_RESULT '.Length) | ConvertFrom-Json } else { $null }
    return [pscustomobject]@{ ExitCode=$Exit; Stdout=$Text; Stderr=$ErrorText; Result=$Result }
}

function Invoke-OwnedInjector($Target, [string]$Stage, [switch]$Only, [string]$Creation) {
    return Complete-OwnedInjector (Start-OwnedInjector $Target $Stage -Only:$Only -Creation $Creation)
}

function Wait-Member([string]$Stage) {
    $Deadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not (Test-Path -LiteralPath (Join-Path $Stage 'member.initialized'))) {
        if ([DateTime]::UtcNow -ge $Deadline) { throw "Member did not initialize from its own stage: $Stage" }
        Start-Sleep -Milliseconds 10
    }
}

$Targets = @()
try {
    $Target = Start-OwnedTarget 'live-target'; $Targets += $Target
    $StageA = New-Stage 'member-a'; $StageB = New-Stage 'member-b'; $StageC = New-Stage 'member-c'
    $PendingA = Start-OwnedInjector $Target $StageA
    $PendingB = Start-OwnedInjector $Target $StageB
    $First = Complete-OwnedInjector $PendingA
    $Second = Complete-OwnedInjector $PendingB
    if ($First.ExitCode -ne 0 -or $Second.ExitCode -ne 0) { throw "Simultaneous attachment failed: A=$($First.Stdout) B=$($Second.Stdout)" }
    $Owners = @($First.Result,$Second.Result | Where-Object { $_.runtimeMode -eq 'injected-runtime' })
    $Members = @($First.Result,$Second.Result | Where-Object { $_.runtimeMode -eq 'participant-addon' })
    if ($Owners.Count -ne 1 -or $Members.Count -ne 1) { throw 'Simultaneous apps did not elect exactly one host and one private member.' }
    $HostStage = Split-Path $Members[0].runtimeModulePath
    Wait-Member $StageA
    Wait-Member $StageB
    $ClaimName = 'Local\electron-game-overlay-host-v1-' + $Target.Process.Id + '-' + $Target.Identity.creationTime100ns
    $Claim = [IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($ClaimName)
    $Claim.Dispose()
    $Third = Invoke-OwnedInjector $Target $StageC -Only
    if ($Third.ExitCode -ne 0 -or $Third.Result.runtimeMode -ne 'participant-addon') { throw "Explicit member-only attachment failed: $($Third.Stdout) $($Third.Stderr)" }
    Wait-Member $StageC
    foreach ($Record in @($Members[0],$Third.Result)) {
        if ($Record.reshadeBasePath -ine $HostStage) { throw 'Member did not preserve the exact target host base path.' }
    }
    $Modules = @($Target.Process.Modules | ForEach-Object { $_.FileName })
    $Runtimes = @($Modules | Where-Object { [IO.Path]::GetFileName($_) -ieq $RuntimeLeaf })
    if ($Runtimes.Count -ne 1 -or $Runtimes[0] -ine (Join-Path $HostStage $RuntimeLeaf)) { throw 'Expected exactly one original host module.' }
    foreach ($Stage in @($StageA,$StageB,$StageC)) {
        if (@($Modules | Where-Object { $_ -ieq (Join-Path $Stage $AddonLeaf) }).Count -ne 1) { throw "Expected a distinct loaded member at $Stage" }
    }
    $Target.Process.Kill(); $Target.Process.WaitForExit()
    $UnexpectedClaim = $null
    try { $UnexpectedClaim = [IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($ClaimName) } catch [IO.FileNotFoundException] { }
    if ($UnexpectedClaim) { $UnexpectedClaim.Dispose(); throw 'Host claim outlived authoritative target exit.' }
    $Wrong = Start-OwnedTarget 'mismatch-target'; $Targets += $Wrong
    $StageWrong = New-Stage 'mismatch-member'
    $Mismatch = Invoke-OwnedInjector $Wrong $StageWrong -Creation (([uint64]::Parse($Wrong.Identity.creationTime100ns) + [uint64]1).ToString())
    if ($Mismatch.ExitCode -ne 1306 -or $Mismatch.Stdout -notmatch 'target-process-instance-mismatch') { throw 'Mismatched process instance did not fail before mutation.' }
    if (@($Wrong.Process.Modules | Where-Object { $_.FileName -ieq (Join-Path $StageWrong $RuntimeLeaf) }).Count -ne 0) { throw 'Mismatched target loaded a host.' }
    $StaleStage = New-Stage 'stale-build-member'
    $StalePath = Join-Path $StaleStage $AddonLeaf
    $Bytes = [IO.File]::ReadAllBytes($StalePath)
    $Needle = [Text.Encoding]::ASCII.GetBytes($AddonBuildId + [char]0)
    $Matches = 0
    for ($Offset = 0; $Offset -le $Bytes.Length - $Needle.Length; $Offset++) {
        $Equal = $true
        for ($Index = 0; $Index -lt $Needle.Length; $Index++) { if ($Bytes[$Offset + $Index] -ne $Needle[$Index]) { $Equal = $false; break } }
        if ($Equal) { $Bytes[$Offset] = if ($Bytes[$Offset] -eq [byte][char]'0') { [byte][char]'1' } else { [byte][char]'0' }; $Matches++ }
    }
    if ($Matches -ne 1) { throw 'Could not create an exact stale build-ID fixture.' }
    [IO.File]::WriteAllBytes($StalePath, $Bytes)
    $Stale = Invoke-OwnedInjector $Wrong $StaleStage -Only
    if ($Stale.ExitCode -ne 1306 -or $Stale.Stdout -notmatch 'target-member-payload-invalid') { throw 'Stale ABI-compatible member was not rejected before load.' }
    if (@($Wrong.Process.Modules | Where-Object { $_.FileName -ieq $StalePath }).Count -ne 0) { throw 'Stale member was mapped into the target.' }
    $Crashed = Start-OwnedTarget 'creator-crash-target'; $Targets += $Crashed
    $CrashOwnerStage = New-Stage 'crashed-host-owner'; $CrashJoinStage = New-Stage 'join-after-creator-crash'
    New-Item -ItemType File -Path (Join-Path $CrashOwnerStage 'hold-host-load.enabled') | Out-Null
    $CrashOwner = Start-OwnedInjector $Crashed $CrashOwnerStage
    $CrashDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not (Test-Path -LiteralPath (Join-Path $CrashOwnerStage 'host-load-entered'))) {
        if ([DateTime]::UtcNow -ge $CrashDeadline) { throw 'Creator did not reach the controlled indeterminate load boundary.' }
        Start-Sleep -Milliseconds 10
    }
    $CrashOwner.Child.Kill(); $CrashOwner.Child.WaitForExit()
    $CrashOwnerResult = Complete-OwnedInjector $CrashOwner
    if ($CrashOwnerResult.ExitCode -eq 0) { throw 'Controlled creator did not crash.' }
    $CrashClaimName = 'Local\electron-game-overlay-host-v1-' + $Crashed.Process.Id + '-' + $Crashed.Identity.creationTime100ns
    $CrashClaim = [IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($CrashClaimName)
    $CrashClaim.Dispose()
    $AfterCrash = Invoke-OwnedInjector $Crashed $CrashJoinStage
    if ($AfterCrash.ExitCode -ne 1460 -or $AfterCrash.Stdout -notmatch 'target-member-host-unavailable') { throw 'Creator crash reopened full-runtime ownership.' }
    if (@($Crashed.Process.Modules | Where-Object { $_.FileName -ieq (Join-Path $CrashJoinStage $RuntimeLeaf) }).Count -ne 0) { throw 'Creator crash permitted another runtime load.' }
    $Frozen = Start-OwnedTarget 'pinned-without-runtime' -Pinned; $Targets += $Frozen
    $StageFrozen = New-Stage 'frozen-member'
    $FrozenResult = Invoke-OwnedInjector $Frozen $StageFrozen
    if ($FrozenResult.ExitCode -ne 1460 -or $FrozenResult.Stdout -notmatch 'target-member-host-unavailable') { throw 'An uncertain pinned host claim did not remain frozen.' }
    if (@($Frozen.Process.Modules | Where-Object { $_.FileName -ieq (Join-Path $StageFrozen $RuntimeLeaf) }).Count -ne 0) { throw 'Pinned claim permitted another runtime load.' }
    if ((Get-FileHash -LiteralPath $Injector -Algorithm SHA256).Hash -ne $InjectorHash) { throw 'The source injector changed during acceptance.' }
    [ordered]@{
        schemaVersion=1; architecture=$Architecture; scope='Owned console processes and inert marker DLLs; no game rendering/input acceptance.'
        injectorSha256=$InjectorHash; addonBuildId=$AddonBuildId
        injectorSourceSha256=$InjectorSourceHash; sameTokenSessionAccepted=$true
        invalidTargetSessionQueryFailedClosed=$true; differentSessionPolicyRejected=$true
        hostInstances=1; independentMemberModules=3; simultaneousFirstStarts=$true
        hostClaimSurvivedInjectorExit=$true; claimReleasedOnTargetExit=$true
        hostClaimSurvivedCreatorCrash=$true; staleMemberBuildRejected=$true
        processInstanceMismatchRejected=$true; uncertainClaimNeverInjected=$true
        exactTargetBasePathPreserved=$true
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Run 'evidence.json') -Encoding UTF8
    Write-Host "Cooperative loader acceptance passed: $Run"
} finally {
    foreach ($Pending in $InjectorChildren) {
        if (-not $Pending.Child.HasExited) { $Pending.Child.Kill(); $Pending.Child.WaitForExit() }
        $Pending.Child.Dispose()
    }
    foreach ($Child in $TargetChildren) {
        if (-not $Child.HasExited) { $Child.Kill(); $Child.WaitForExit() }
        $Child.Dispose()
    }
}
