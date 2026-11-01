[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InjectorPath,
    [Parameter(Mandatory = $true)][string]$InjectorSourcePath,
    [Parameter(Mandatory = $true)][ValidateSet('x64','Win32')][string]$Architecture,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-F]{32}$')][string]$AddonBuildId,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$FixtureSource = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\owned-late-bootstrap-loader'
. (Join-Path $FixtureSource 'result-contract.ps1')
$Build = Join-Path $RepoRoot "build\owned-late-bootstrap-loader\compile-$Architecture"
$RunRelative = 'build/owned-late-bootstrap-loader/run-' + $Architecture + '-' + [Guid]::NewGuid().ToString('N')
$Run = Join-Path $RepoRoot $RunRelative
$Injector = (Resolve-Path -LiteralPath $InjectorPath).Path
$InjectorSource = (Resolve-Path -LiteralPath $InjectorSourcePath).Path
$InjectorHash = (Get-FileHash -LiteralPath $Injector -Algorithm SHA256).Hash
$SourceBytes = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($InjectorSource).Replace("`r`n", "`n"))
$Hasher = [Security.Cryptography.SHA256]::Create()
try { $InjectorSourceHash = [BitConverter]::ToString($Hasher.ComputeHash($SourceBytes)).Replace('-', '') } finally { $Hasher.Dispose() }
New-Item -ItemType Directory -Path $Run | Out-Null
if (-not $SkipBuild) {
    & cmake -S $FixtureSource -B $Build -G 'Visual Studio 17 2022' -A $Architecture "-DADDON_BUILD_ID=$AddonBuildId"
    if ($LASTEXITCODE -ne 0) { throw 'Inert owned-bootstrap fixture configure failed.' }
    & cmake --build $Build --config Release --parallel
    if ($LASTEXITCODE -ne 0) { throw 'Inert owned-bootstrap fixture build failed.' }
}
$Binaries = Join-Path $Build 'Release'
$RuntimeLeaf = if ($Architecture -eq 'x64') { 'ReShade64.dll' } else { 'ReShade32.dll' }
$AddonLeaf = if ($Architecture -eq 'x64') { 'electron_game_overlay.addon64' } else { 'electron_game_overlay.addon32' }
$Targets = [Collections.Generic.List[object]]::new()
$Injectors = [Collections.Generic.List[object]]::new()
$Cases = [Collections.Generic.List[object]]::new()
$Status = 'failed'
$Failure = $null

function New-Stage([string]$Name, [ValidateSet('owned','foreign','malformed')][string]$Kind = 'owned') {
    $Directory = Join-Path $Run $Name
    New-Item -ItemType Directory -Path $Directory | Out-Null
    Copy-Item -LiteralPath $Injector -Destination (Join-Path $Directory 'injector.exe')
    if ((Get-FileHash -LiteralPath (Join-Path $Directory 'injector.exe') -Algorithm SHA256).Hash -ne $InjectorHash) { throw 'Injector bytes changed during staging.' }
    Copy-Item -LiteralPath (Join-Path $Binaries "owned_late_bootstrap_${Kind}_host.dll") -Destination (Join-Path $Directory $RuntimeLeaf)
    Copy-Item -LiteralPath (Join-Path $Binaries 'owned_late_bootstrap_member.dll') -Destination (Join-Path $Directory $AddonLeaf)
    [IO.File]::WriteAllText((Join-Path $Directory 'ReShade.ini'), "[GENERAL]`r`n[ADDON]`r`nAddonPath=.`r`n", [Text.Encoding]::ASCII)
    # The inert DLL does not validate this marker. Actual ownership/INI safety
    # belongs to separate real-host checks; this fixture tests loader sequencing.
    [IO.File]::WriteAllText((Join-Path $Directory 'electron-game-overlay-owned-runtime-v1.marker'), "ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1`n", [Text.Encoding]::ASCII)
    return $Directory
}

function Start-Target([string]$Name, [string]$PreloadStage, [string]$Mode) {
    $Directory = Join-Path $Run $Name
    New-Item -ItemType Directory -Path $Directory | Out-Null
    $Executable = Join-Path $Directory 'owned_late_bootstrap_target.exe'
    Copy-Item -LiteralPath (Join-Path $Binaries 'owned_late_bootstrap_target.exe') -Destination $Executable
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = $Executable; $Info.WorkingDirectory = $Directory
    $Info.UseShellExecute = $false; $Info.CreateNoWindow = $true
    $Info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $Info.RedirectStandardOutput = $true; $Info.RedirectStandardError = $true
    foreach ($Variable in @('RESHADE_BASE_PATH_OVERRIDE','ELECTRON_GAME_OVERLAY_RUN_DIRECTORY','RESHADE_DISABLE_GRAPHICS_HOOK','RESHADE_DISABLE_INPUT_HOOK','RESHADE_DISABLE_LOGGING')) { $Info.Environment.Remove($Variable) | Out-Null }
    if ($PreloadStage) { $Info.ArgumentList.Add('--preload'); $Info.ArgumentList.Add($PreloadStage); $Info.ArgumentList.Add($Mode) }
    $Process = [Diagnostics.Process]::new(); $Process.StartInfo = $Info
    if (-not $Process.Start()) { throw 'Could not start the owned inert target.' }
    $Targets.Add($Process)
    $Line = $Process.StandardOutput.ReadLineAsync()
    if (-not $Line.Wait(5000) -or -not $Line.Result) { throw 'Owned inert target did not publish identity.' }
    $Identity = $Line.Result | ConvertFrom-Json
    if ($Identity.pid -ne $Process.Id) { throw 'Owned inert target reported a different PID.' }
    return [pscustomobject]@{ Process=$Process; Identity=$Identity; Executable=$Executable; Directory=$Directory }
}

function Start-Injector($Target, [string]$Stage, [switch]$Only) {
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = Join-Path $Stage 'injector.exe'; $Info.WorkingDirectory = $Stage
    foreach ($Argument in @($Target.Executable,'--pid',[string]$Target.Process.Id,'--expected-creation-time-100ns',[string]$Target.Identity.creationTime100ns)) { $Info.ArgumentList.Add($Argument) }
    if ($Only) { $Info.ArgumentList.Add('--addon-only') }
    $Info.UseShellExecute=$false; $Info.CreateNoWindow=$true
    $Info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
    $Info.RedirectStandardOutput=$true; $Info.RedirectStandardError=$true
    $Child=[Diagnostics.Process]::new(); $Child.StartInfo=$Info
    if (-not $Child.Start()) { throw 'Could not start owned injector.' }
    $Pending=[pscustomobject]@{ Child=$Child; Out=$Child.StandardOutput.ReadToEndAsync(); Err=$Child.StandardError.ReadToEndAsync(); Stage=$Stage }
    $Injectors.Add($Pending)
    return $Pending
}

function Complete-Injector($Pending) {
    if (-not $Pending.Child.WaitForExit(35000)) { throw 'Owned injector exceeded its bounded fixture wait.' }
    $Text=$Pending.Out.GetAwaiter().GetResult(); $ErrorText=$Pending.Err.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $Pending.Stage 'injector.stdout.txt'),$Text)
    [IO.File]::WriteAllText((Join-Path $Pending.Stage 'injector.stderr.txt'),$ErrorText)
    $Lines=@($Text -split '\r?\n' | Where-Object { $_.StartsWith('ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ') })
    $Result=if($Lines.Count -eq 1){ $Lines[0].Substring('ELECTRON_GAME_OVERLAY_INJECTOR_RESULT '.Length)|ConvertFrom-Json }else{$null}
    return [pscustomobject]@{ ExitCode=$Pending.Child.ExitCode; ResultLineCount=$Lines.Count; Result=$Result; Stdout=$Text; Stderr=$ErrorText }
}

function Invoke-Injector($Target,[string]$Stage,[switch]$Only) { return Complete-Injector (Start-Injector $Target $Stage -Only:$Only) }
function Read-Record([string]$Stage,[string]$Name) { return Get-Content -Raw -LiteralPath (Join-Path $Stage $Name) | ConvertFrom-Json }
function Assert-OneHost($Target,[string]$HostStage) {
    $Target.Process.Refresh()
    $Modules=@($Target.Process.Modules|ForEach-Object{$_.FileName})
    $Hosts=@($Modules|Where-Object{[IO.Path]::GetFileName($_) -ieq  $RuntimeLeaf})
    if($Hosts.Count -ne  1 -or $Hosts[0] -ine  (Join-Path $HostStage $RuntimeLeaf)){throw 'Expected exactly one original host module.'}
    return $Modules
}
function Assert-Success($Result,$Target,[string]$Stage,[string]$HostStage,
    [ValidateSet('injected-runtime','participant-addon')][string]$ExpectedMode = 'participant-addon') {
    Assert-OwnedLoaderResultContract -Record $Result -Target $Target -Stage $Stage -HostStage $HostStage `
        -RuntimeLeaf $RuntimeLeaf -AddonLeaf $AddonLeaf -ExpectedMode $ExpectedMode
    $Member=Read-Record $Stage 'member.initialized.json'
    if(-not $Member.requestWasNull){throw 'Member initializer did not use its own-module route.'}
}

try {
    $Target=Start-Target 'first-target'; $A=New-Stage 'first-app-a'; $B=New-Stage 'first-app-b'
    $PendingA=Start-Injector $Target $A; $PendingB=Start-Injector $Target $B
    $ResultA=Complete-Injector $PendingA; $ResultB=Complete-Injector $PendingB
    $Pair=Get-OwnedLoaderFirstPair -Attachments @([pscustomobject]@{Record=$ResultA;Stage=$A},[pscustomobject]@{Record=$ResultB;Stage=$B})
    $HostStage=$Pair.HostStage
    Assert-Success $Pair.Owner.Record $Target $Pair.Owner.Stage $HostStage -ExpectedMode 'injected-runtime'
    Assert-Success $Pair.Member.Record $Target $Pair.Member.Stage $HostStage
    $Modules=Assert-OneHost $Target $HostStage
    foreach($Stage in @($A,$B)){if(@($Modules|Where-Object{$_ -ieq  (Join-Path $Stage $AddonLeaf)}).Count -ne  1){throw 'Independent stage did not load its own member.'}}
    $FirstGates=@((Read-Record $A 'member.loaded.json').gateAtDllMain,(Read-Record $B 'member.loaded.json').gateAtDllMain)
    if(@($FirstGates|Where-Object{$_ -eq  1}).Count -ne  1){throw 'Exactly one first member must load under the claimed OPEN gate.'}
    if ((Read-Record $Pair.Owner.Stage 'member.loaded.json').gateAtDllMain -ne 1 -or
        (Read-Record $Pair.Member.Stage 'member.loaded.json').gateAtDllMain -ne 3) {
        throw 'The initial result must describe the gate claimant; the later member must follow completed bootstrap initialization.'
    }
    $Bootstrap=Read-Record $HostStage 'bootstrap.called.json'
    if($Bootstrap.calls -ne  2 -or -not $Bootstrap.requestWasNull -or $Bootstrap.initializedMembers -ne  2 -or $Bootstrap.gateAtEntry -ne  3){throw 'Bootstrap ordering or repeated initialization proof failed.'}
    $Cases.Add([ordered]@{name='simultaneous-first-and-private-late-member';status='passed';hostCount=1;memberCount=2;bootstrapCalls=2;firstRegistrationGateCount=1;initialHostResultFieldCount=4;privateParticipantResultFieldCount=9})

    foreach($Mode in @('registered','closed-ready')){
        $Existing=New-Stage "$Mode-host"; $App=New-Stage "$Mode-app"
        $Target=Start-Target "$Mode-target" $Existing $Mode
        if(Test-Path -LiteralPath (Join-Path $Existing 'member.initialized.json')){throw 'Preloaded adapter must start without a feature participant.'}
        $Result=Invoke-Injector $Target $App -Only
        Assert-Success $Result $Target $App $Existing
        $null=Assert-OneHost $Target $Existing
        $Bootstrap=Read-Record $Existing 'bootstrap.called.json'
        if($Bootstrap.initializedMembers -ne  1 -or $Bootstrap.calls -ne  1){throw 'Adapter-only recovery initialized the wrong member set.'}
        $Cases.Add([ordered]@{name="adapter-only-$Mode-recovery";status='passed';memberReadyBeforeAttach=$false;adapterReadyBeforeAttach=$true;hostCount=1;bootstrapCalls=1})
    }

    $Existing=New-Stage 'closed-unready-host'; $App=New-Stage 'closed-unready-app'
    New-Item -ItemType File -Path (Join-Path $Existing 'suppress-adapter-ready.enabled')|Out-Null
    $Target=Start-Target 'closed-unready-target' $Existing 'closed-unready'
    $Result=Invoke-Injector $Target $App -Only
    if($Result.ExitCode -ne  1460 -or $Result.Result){throw 'Ambiguous CLOSED adapter readiness did not time out fail-closed.'}
    if((Test-Path -LiteralPath (Join-Path $App 'member.loaded.json')) -or (Test-Path -LiteralPath (Join-Path $Existing 'bootstrap.called.json'))){throw 'Ambiguous adapter readiness mutated a member/bootstrap.'}
    $null=Assert-OneHost $Target $Existing
    $Cases.Add([ordered]@{name='closed-unready-fails-closed';status='passed';expectedError=1460;hostCount=1;memberMutation=$false;bootstrapCalled=$false})

    foreach($Only in @($false,$true)){
        $Label=if($Only){'addon-only'}else{'default'}
        $Existing=New-Stage "malformed-$Label-host" 'malformed'; $App=New-Stage "malformed-$Label-app"
        $Target=Start-Target "malformed-$Label-target" $Existing 'malformed'
        $Result=Invoke-Injector $Target $App -Only:$Only
        if($Result.ExitCode -ne  1306 -or $Result.Result){throw 'Malformed owned capability did not fail with exact ABI mismatch.'}
        if((Test-Path -LiteralPath (Join-Path $App 'member.loaded.json')) -or (Test-Path -LiteralPath (Join-Path $Existing 'bootstrap.called.json'))){throw 'Malformed owned capability reached member/bootstrap mutation.'}
        $null=Assert-OneHost $Target $Existing
        $Cases.Add([ordered]@{name="malformed-capability-$Label-fails-before-member";status='passed';expectedError=1306;hostCount=1;memberMutation=$false;bootstrapCalled=$false})
    }

    $Existing=New-Stage 'foreign-host' 'foreign'; $App=New-Stage 'foreign-app'
    $ProtectedBefore=@{}; foreach($Leaf in @($RuntimeLeaf,'ReShade.ini')){$ProtectedBefore[$Leaf]=(Get-FileHash -LiteralPath (Join-Path $Existing $Leaf) -Algorithm SHA256).Hash}
    $Target=Start-Target 'foreign-target' $Existing 'foreign'; $Result=Invoke-Injector $Target $App -Only
    Assert-Success $Result $Target $App $Existing; $null=Assert-OneHost $Target $Existing
    if(Test-Path -LiteralPath (Join-Path $Existing 'bootstrap.called.json')){throw 'A cap-absent host executed the owned-only activation export.'}
    foreach($Leaf in @($RuntimeLeaf,'ReShade.ini')){if($ProtectedBefore[$Leaf] -ne  (Get-FileHash -LiteralPath (Join-Path $Existing $Leaf) -Algorithm SHA256).Hash){throw 'Cap-absent host file changed.'}}
    $Cases.Add([ordered]@{name='cap-absent-host-not-activated';status='passed';hostCount=1;bootstrapCalled=$false;protectedStubFilesUnchanged=$true})

    $A=New-Stage 'failure-owner'; $B=New-Stage 'failure-later-app'
    New-Item -ItemType File -Path (Join-Path $A 'bootstrap-failure.enabled')|Out-Null
    $Target=Start-Target 'failure-target'; $First=Invoke-Injector $Target $A
    if($First.ExitCode -ne  50 -or $First.Result){throw 'Explicit bootstrap failure did not preserve its error.'}
    $null=Assert-OneHost $Target $A
    $Second=Invoke-Injector $Target $B
    if($Second.ExitCode -ne  50 -or $Second.Result){throw 'Later attach silently bypassed explicit bootstrap failure.'}
    $Modules=Assert-OneHost $Target $A
    if(@($Modules|Where-Object{$_ -ieq  (Join-Path $B $RuntimeLeaf)}).Count -ne  0){throw 'Explicit bootstrap failure allowed a second host.'}
    $Bootstrap=Read-Record $A 'bootstrap.called.json'
    if(-not $Bootstrap.explicitFailure -or $Bootstrap.calls -ne  2 -or $Bootstrap.initializedMembers -ne  2){throw 'Failed bootstrap did not preserve admitted private members and the original host.'}
    $Cases.Add([ordered]@{name='explicit-bootstrap-failure-never-reinjects';status='passed';expectedError=50;hostCount=1;memberCount=2;bootstrapCalls=2})
    $Status='passed'
} catch { $Failure=$_.Exception.Message; throw } finally {
    foreach($Pending in $Injectors){try{if(-not $Pending.Child.HasExited){$Pending.Child.Kill();$null=$Pending.Child.WaitForExit(5000)}}catch{}}
    foreach($Process in $Targets){try{if(-not $Process.HasExited){$Process.Kill();$null=$Process.WaitForExit(5000)}}catch{}}
    [ordered]@{schemaVersion=1;fixture='inert-owned-late-bootstrap-loader';status=$Status;failure=$Failure;architecture=$Architecture;addonBuildId=$AddonBuildId;injectorSha256=$InjectorHash;injectorNormalizedSourceSha256=$InjectorSourceHash;artifactDirectory=$RunRelative;cases=@($Cases);scope='Console-only copied-loader sequencing and native module/claim boundary; inert DLLs, no ReShade graphics or add-on callback vectors.';ownedStageMarkerValidationProven=$false;graphicsOrInputProven=$false;realGameAcceptanceProven=$false}|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $Run 'evidence.json') -Encoding utf8NoBOM
    Write-Output "Owned bootstrap loader evidence: $RunRelative/evidence.json"
}
