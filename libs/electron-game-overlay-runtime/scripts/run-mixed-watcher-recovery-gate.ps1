#requires -Version 7.2
[CmdletBinding()]
param([switch]$SkipBuild, [switch]$ProtocolOnly)
$ErrorActionPreference = 'Stop'
$Repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$Root = Join-Path $Repository 'build\mixed-watcher-recovery'
$Runtime = Join-Path $Root 'published\package\dist\runtime\win32-x64\reshade'
if (-not (Test-Path -LiteralPath (Join-Path $Runtime 'inject.exe'))) { throw 'First fetch and verify the exact v1.0.0-nightly.1 release payload into the reusable published cache.' }
$Manifest = Get-Content -LiteralPath (Join-Path $Runtime 'electron_game_overlay_runtime.build.json') -Raw | ConvertFrom-Json
if ($Manifest.runtimeGeneration -ne 23 -or $Manifest.addonBuildId -cne 'CCE20935ADD44EF6A5A7973014B2E07F') { throw 'Wrong retained native fixture build.' }
$Source = Join-Path $Repository 'libs\electron-game-overlay-runtime\tests\mixed-watcher-recovery'
$Compile = Join-Path $Root 'compile'
if (-not $SkipBuild) {
    & cmake -S $Source -B $Compile -G 'Visual Studio 17 2022' -A x64
    if ($LASTEXITCODE -ne 0) { throw 'Owned recovery fixture configure failed.' }
    & cmake --build $Compile --config Release
    if ($LASTEXITCODE -ne 0) { throw 'Owned recovery fixture build failed.' }
}
. (Join-Path $PSScriptRoot 'run-client-sdk-input-gate.ps1') -Backend d3d11 -FunctionsOnly -SkipBuild
. (Join-Path $PSScriptRoot 'visual-test-display-lease.ps1')
$Root = Join-Path $Repository 'build\mixed-watcher-recovery'
$Runtime = Join-Path $Root 'published\package\dist\runtime\win32-x64\reshade'
$Source = Join-Path $Repository 'libs\electron-game-overlay-runtime\tests\mixed-watcher-recovery'
$Compile = Join-Path $Root 'compile'
$Targets = Join-Path $Root 'targets'
New-Item -ItemType Directory -Force -Path $Targets | Out-Null
foreach ($Name in @('owned_recovery_a.exe','owned_recovery_b.exe')) {
    $From = Join-Path $Compile "Release\$Name"; $To = Join-Path $Targets $Name
    if (-not (Test-Path -LiteralPath $To) -or (Get-FileHash -LiteralPath $From).Hash -cne (Get-FileHash -LiteralPath $To).Hash) { Copy-Item -LiteralPath $From -Destination $To }
}
$Capture = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$ReportPath = Join-Path $Root "$Capture.report.json"
$Report = [ordered]@{ status='running'; scope='Current workspace SDK watcher/storage with unmodified released native generation 23; controlled D3D11 A and inert owned B only. Virtual SendInput, no physical-key claim. No Izabela or user game.'; cases=@(); apps=@(); cleanupErrors=@() }
$Report.protocolOnly = [bool]$ProtocolOnly
if ($ProtocolOnly) { $Report.inputAndPixelAcceptance = 'not-run; protocol-only cell, display state unavailable for visual input acceptance' }
$Report.releaseAssetSha256 = (Get-FileHash -LiteralPath (Join-Path $Root 'electron-game-overlay-1.0.0-nightly.1.tgz') -Algorithm SHA256).Hash
if ($Report.releaseAssetSha256 -cne '437526E5DA73130E995AABC2E9C890DAB0CAA6F110016CD409483765DFF12871') { throw 'Retained release archive changed.' }
$Report.runtimeManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $Runtime 'electron_game_overlay_runtime.build.json') -Algorithm SHA256).Hash
$Report.fixtureBinaries = @('owned_recovery_a.exe','owned_recovery_b.exe','owned_recovery_controller.exe') | ForEach-Object { @{name=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $Compile "Release\$_") -Algorithm SHA256).Hash} }
$Controllers = [Collections.Generic.List[object]]::new(); $Apps = [Collections.Generic.List[object]]::new()
$AppNumber = 0; $Sequence = 0; $DisplayLease = $null; $App = $null; $StatePath = $null; $CommandPath = $null
$InitialStages = @(if(Test-Path -LiteralPath (Join-Path $Root 'private-runs')) { Get-ChildItem -LiteralPath (Join-Path $Root 'private-runs') -Directory | Select-Object -ExpandProperty Name })
function Save-Report { $Report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ReportPath -Encoding utf8 }
function Read-State {
    if (-not (Test-Path -LiteralPath $script:StatePath)) { return $null }
    try { $Value = Get-Content -LiteralPath $script:StatePath -Raw | ConvertFrom-Json } catch { return $null }
    if ($Value.fatal -or $Value.globalStop) { throw "Producer stopped globally: $($Value.fatal.message)" }
    return $Value
}
function Wait-State([scriptblock]$Predicate, [int]$Seconds = 25) {
    $Deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        $Value = Read-State
        if ($Value -and (& $Predicate $Value)) { return $Value }
        if ($script:App.HasExited) { throw 'Owned producer exited while waiting.' }
        Start-Sleep -Milliseconds 25
    }
    throw 'Timed out waiting for owned SDK state.'
}
function Start-App {
    $script:AppNumber++; $script:StatePath = Join-Path $Root "$Capture.app-$AppNumber.state.json"; $script:CommandPath = Join-Path $Root "$Capture.app-$AppNumber.command.json"
    $Configuration = Join-Path $Root "$Capture.app-$AppNumber.configuration.json"
    @{ userData=(Join-Path $Root 'electron-user-data'); sdkDist=(Join-Path $Repository 'libs\electron-game-overlay\dist'); runtimeDirectory=$Runtime; runsRoot=(Join-Path $Root 'private-runs'); statePath=$StatePath; commandPath=$CommandPath; targetDirectory=$Targets } | ConvertTo-Json | Set-Content -LiteralPath $Configuration -Encoding utf8NoBOM
    $Info = [Diagnostics.ProcessStartInfo]::new(); $Info.FileName = Join-Path $Repository 'node_modules\electron\dist\electron.exe'
    $Info.UseShellExecute=$false; $Info.CreateNoWindow=$true; $Info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
    $Info.RedirectStandardOutput=$true; $Info.RedirectStandardError=$true
    $Info.ArgumentList.Add((Join-Path $Source 'producer.cjs')); $Info.ArgumentList.Add("--configuration=$Configuration"); $Info.ArgumentList.Add('--no-sandbox')
    foreach ($Name in @('ELECTRON_RUN_AS_NODE','RESHADE_BASE_PATH_OVERRIDE','ELECTRON_GAME_OVERLAY_RUN_DIRECTORY','RESHADE_DISABLE_GRAPHICS_HOOK','RESHADE_DISABLE_INPUT_HOOK','RESHADE_DISABLE_LOGGING')) { $Info.Environment.Remove($Name) | Out-Null }
    $Process = [Diagnostics.Process]::new(); $Process.StartInfo=$Info; $null=$Process.Start(); $null=$Process.Handle
    $script:App=$Process; $Apps.Add(@{process=$Process; stdout=$Process.StandardOutput.ReadToEndAsync(); stderr=$Process.StandardError.ReadToEndAsync(); number=$AppNumber})
    $Value=Wait-State {param($s) $s.ready}; $Report.apps+=@{pid=$Process.Id; state=$StatePath; watcherSourceSha256=$Value.watcherSourceSha256; nativeGeneration=$Value.nativeGeneration}
}
function Stop-App {
    $script:Sequence++; @{sequence=$Sequence;kind='quit'} | ConvertTo-Json | Set-Content -LiteralPath $CommandPath -Encoding utf8NoBOM
    if (-not $App.WaitForExit(10000)) { throw 'Producer did not stop cleanly.' }
}
function Start-Owned([string]$Name, [string]$Mode) {
    $Info=[Diagnostics.ProcessStartInfo]::new(); $Info.FileName=Join-Path $Compile 'Release\owned_recovery_controller.exe'; $Info.UseShellExecute=$false; $Info.CreateNoWindow=$true; $Info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
    $Info.RedirectStandardInput=$true; $Info.RedirectStandardOutput=$true; $Info.RedirectStandardError=$true
    $Info.ArgumentList.Add((Join-Path $Targets $Name)); $Info.ArgumentList.Add($Mode)
    $Process=[Diagnostics.Process]::new(); $Process.StartInfo=$Info; $null=$Process.Start(); $null=$Process.Handle
    $Line=$Process.StandardOutput.ReadLineAsync(); if (-not $Line.Wait(5000)) {throw 'Owned creation identity was not published.'}
    $Identity=$Line.Result|ConvertFrom-Json
    if (-not $Identity.pid -or -not $Identity.creationTime100ns) {throw 'Bad owned identity.'}
    $Owned=@{controller=$Process;identity=$Identity;process=[Diagnostics.Process]::GetProcessById($Identity.pid)}; $Controllers.Add($Owned); return $Owned
}
function Stop-Owned($Owned) {
    if ($Owned.controller.HasExited) {return}
    $Owned.controller.StandardInput.WriteLine('exit'); if (-not $Owned.controller.WaitForExit(6000)) {throw 'Owned retained-handle cleanup timed out.'}
    $Exited=$Owned.controller.StandardOutput.ReadLine()|ConvertFrom-Json
    if (-not $Exited.exited -or $Exited.pid -ne $Owned.identity.pid -or $Exited.creationTime100ns -cne $Owned.identity.creationTime100ns) {throw 'Owned exact-handle exit proof failed.'}
}
function Wait-PrivateRetirement([int]$TargetPid) {
    $Stage=Get-ChildItem -LiteralPath (Join-Path $Root 'private-runs') -Directory | Where-Object { $Log=Join-Path $_.FullName 'inject.stdout.log'; (Test-Path -LiteralPath $Log) -and (Get-Content -LiteralPath $Log -Raw) -match ('EGO_TARGET_SELECTED_V2\s+'+$TargetPid+'\s+') } | Select-Object -First 1
    if(-not $Stage){throw 'Missing exact-instance stage retirement evidence.'}
    $Deadline=[DateTime]::UtcNow.AddSeconds(5)
    while(@(Get-ChildItem -LiteralPath $Stage.FullName -File -Filter '*.addon*').Count -gt 0) {
        if([DateTime]::UtcNow -gt $Deadline){throw 'SDK did not retire private images after authoritative exit.'}
        Start-Sleep -Milliseconds 25
    }
}
function Prove-A([string]$Label) {
    $Owned=Start-Owned 'owned_recovery_a.exe' 'normal'; $TargetPid=$Owned.identity.pid
    $Value=Wait-State {param($s) $s.activePid -eq $TargetPid -and $s.inputReady -and ($ProtocolOnly -or $s.intercepting)}
    $SentAt=$null; $AcknowledgedAt=$Value.interceptAcknowledgedAt
    if (-not $ProtocolOnly) {
        $Window=Wait-ForHostWindow -HostProcess $Owned.process -Deadline ([DateTime]::UtcNow.AddSeconds(10))
        if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($Window)) {throw 'Owned graphics target could not take foreground.'}
        # No click, warm-up key or DOM refocus after the SDK interception ack.
        $SentAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        [ReShadeClientSdkGate.NativeInputMethods]::SendUnicodeText('q')
        $Value=Wait-State {param($s) $s.dom.value -eq 'q'} 8
        if ($Value.dom.keys.Count -ne 1) {throw 'First-key oracle observed extra keys.'}
    }
    $Stage = Get-ChildItem -LiteralPath (Join-Path $Root 'private-runs') -Directory | Where-Object { $Log=Join-Path $_.FullName 'inject.stdout.log'; (Test-Path -LiteralPath $Log) -and (Get-Content -LiteralPath $Log -Raw) -match ('EGO_TARGET_SELECTED_V2\s+'+$TargetPid+'\s+') } | Select-Object -First 1
    if (-not $Stage) {throw 'No exact selected-instance injector evidence.'}
    Wait-ForReShadeMarker -Path (Join-Path $Stage.FullName 'ReShade.log') -Marker 'rendered its first transported scene (1 window(s))' -Deadline ([DateTime]::UtcNow.AddSeconds(10)) -HostProcess $Owned.process
    Stop-Owned $Owned; $null=Wait-State {param($s) @($s.exited|Where-Object pid -eq $TargetPid).Count -eq 1}
    Wait-PrivateRetirement $TargetPid
    $Report.cases+=@{name=$Label;identity=$Owned.identity;status='passed';firstKey=$(if($ProtocolOnly){'not-run'}else{'q'});firstKeySendAfterAckMs=$(if($ProtocolOnly){$null}else{$SentAt-$AcknowledgedAt});stage=$Stage.FullName;injectorStdoutSha256=(Get-FileHash -LiteralPath (Join-Path $Stage.FullName 'inject.stdout.log') -Algorithm SHA256).Hash;reshadeLogAfterExitSha256=(Get-FileHash -LiteralPath (Join-Path $Stage.FullName 'ReShade.log') -Algorithm SHA256).Hash;appPid=$App.Id}
    Save-Report
}
try {
    if (-not $ProtocolOnly) { $DisplayLease=Enter-VisualTestDisplayLease $Report }
    Start-App; Prove-A 'A before failure'
    $B=Start-Owned 'owned_recovery_b.exe' 'suspended'; $TargetPid=$B.identity.pid
    $Value=Wait-State {param($s) @($s.failures|Where-Object {$_.target.pid -eq $TargetPid -and $_.code -eq 'target-module-inspection-failed'}).Count -eq 1}
    $Report.cases+=@{name='owned suspended B preflight 299';identity=$B.identity;failure=($Value.failures|Where-Object {$_.target.pid -eq $TargetPid});appPid=$App.Id;status='passed'}
    Stop-Owned $B; $null=Wait-State {param($s) @($s.exited|Where-Object pid -eq $TargetPid).Count -eq 1}
    Wait-PrivateRetirement $TargetPid
    Prove-A 'new A after B preflight failure'
    $B=Start-Owned 'owned_recovery_b.exe' 'normal'; $TargetPid=$B.identity.pid
    $Value=Wait-State {param($s) @($s.failures|Where-Object {$_.target.pid -eq $TargetPid -and $_.retrySafety -eq 'indeterminate'}).Count -ge 1} 35
    $Report.cases+=@{name='owned B uncertain startup';identity=$B.identity;failure=($Value.failures|Where-Object {$_.target.pid -eq $TargetPid});appPid=$App.Id;status='passed'}
    Stop-Owned $B; $null=Wait-State {param($s) @($s.exited|Where-Object pid -eq $TargetPid).Count -eq 1}
    Wait-PrivateRetirement $TargetPid
    Prove-A 'new A after B uncertain failure'
    # A fresh app process uses the same writable roots but a fresh SDK session.
    Stop-App; Start-App; Prove-A 'A after fresh app restart'
    Stop-App
    $NewStages=@(Get-ChildItem -LiteralPath (Join-Path $Root 'private-runs') -Directory | Where-Object {$_.Name -notin $InitialStages})
    $RemainingImages=@($NewStages|ForEach-Object {Get-ChildItem -LiteralPath $_.FullName -File -Filter '*.addon*'})
    if($RemainingImages.Count){throw 'Normal producer shutdown retained unused watcher private images.'}
    $Report.currentCapturePrivateImagesAfterShutdown=$RemainingImages.Count
    $Report.verifiedPayloadBuildCount=@(Get-ChildItem -LiteralPath (Join-Path $Root 'private-runs.payloads-v1') -Directory).Count
    $Report.status='passed'
} catch { $Report.status='failed'; $Report.error=$_.Exception.Message; throw }
finally {
    foreach ($Owned in $Controllers) {try {Stop-Owned $Owned} catch {$Report.cleanupErrors+=$_.Exception.Message}}
    foreach ($Entry in $Apps) {
        if (-not $Entry.process.HasExited) {$Entry.process.Kill($true);$null=$Entry.process.WaitForExit(5000)}
        $Entry.stdout.Result | Set-Content -LiteralPath (Join-Path $Root "$Capture.app-$($Entry.number).stdout.log")
        $Entry.stderr.Result | Set-Content -LiteralPath (Join-Path $Root "$Capture.app-$($Entry.number).stderr.log")
    }
    Exit-VisualTestDisplayLease $DisplayLease $Report; Save-Report
    Write-Output "Mixed recovery $($Report.status): $ReportPath"
}
