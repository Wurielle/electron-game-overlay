#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('d3d11', 'd3d12')][string]$Backend,
    [string]$SdkDist,
    [string]$UnregisteredSdkDist,
    [string]$UnregisteredConsumerRoot,
    [string]$ElectronExecutable,
    [switch]$SkipBuild
)

# One registered current build supplies a dormant dispatcher. A genuinely older,
# unregistered SDK joins dynamically; this never pretends that old code supports
# dormant preloading. The only target is a copied repository DirectX demo.
$ErrorActionPreference = 'Stop'
$CompatibilitySkipBuild = $SkipBuild
$CompatibilitySdk = $SdkDist
$CompatibilityOldSdk = $UnregisteredSdkDist
$CompatibilityConsumer = $UnregisteredConsumerRoot
$CompatibilityElectron = $ElectronExecutable
. (Join-Path $PSScriptRoot 'run-client-sdk-preloaded-addons-gate.ps1') -Backend $Backend -FunctionsOnly -SkipBuild -ElectronExecutable $CompatibilityElectron
if (-not $CompatibilitySkipBuild) {
    Push-Location $RuntimeRoot
    try {
        & cmake.exe --preset $CMakePreset
        if ($LASTEXITCODE -ne 0) { throw 'Demo CMake configure failed.' }
        & cmake.exe --build $ProductionBuildRoot --config RelWithDebInfo --target $HostTarget --parallel
        if ($LASTEXITCODE -ne 0) { throw 'Demo build failed.' }
    } finally { Pop-Location }
}
if (-not $CompatibilitySdk) { $CompatibilitySdk = Join-Path $RepoRoot 'libs\electron-game-overlay\dist' }
if (-not $CompatibilityOldSdk) {
    if (-not $CompatibilityConsumer) { $CompatibilityConsumer = Join-Path $RepoRoot 'build\installed-cooperative-pair-gen11-gen16-async-20261101-final\consumer-b' }
    $CompatibilityOldSdk = Join-Path $CompatibilityConsumer 'node_modules\electron-game-overlay\dist'
}
$ElectronExecutable = (Resolve-Path -LiteralPath $ElectronExecutable).Path
$NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$Sdks = @{ a = (Resolve-Path -LiteralPath $CompatibilitySdk).Path; b = (Resolve-Path -LiteralPath $CompatibilityOldSdk).Path }
$SdkConsumers = @{}
if ($CompatibilityConsumer) { $SdkConsumers.b = (Resolve-Path -LiteralPath $CompatibilityConsumer).Path }
foreach ($File in @($BuiltHost, $ProducerFixture, $RegistrationFixture, (Join-Path $Sdks.a 'preload.js'), (Join-Path $Sdks.b 'index.js'))) { if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Required compatibility artifact missing: $File" } }
$OldStamp = Get-Content -LiteralPath (Join-Path $Sdks.b 'runtime\win32-x64\reshade\electron_game_overlay_runtime.build.json') -Raw | ConvertFrom-Json
if ($OldStamp.addonBuildId -cne 'E8FE3783F29E4FB297D8B006D0087725') { throw 'This compatibility case is calibrated for the retained generation-16 unregistered SDK.' }
. (Join-Path $PSScriptRoot 'visual-test-display-lease.ps1')
$PreloadBuildRoot = Join-Path $RepoRoot 'build\pl'
$RunDirectory = Join-Path $PreloadBuildRoot ('c-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
$CaseDirectory = $RunDirectory; $TargetDirectory = Join-Path $CaseDirectory 't'; $Stage = Join-Path $CaseDirectory 'h'; $StorageRoot = Join-Path $CaseDirectory 'r'
New-Item -ItemType Directory -Path $TargetDirectory, $Stage | Out-Null
$TargetPath = Join-Path $TargetDirectory 'p.exe'; Copy-Item -LiteralPath $BuiltHost -Destination $TargetPath
$Barrier = Join-Path $TargetDirectory 'electron-game-overlay-startup-barrier.enabled'
[IO.File]::WriteAllText($Barrier, 'controlled pre-device barrier')
[IO.File]::WriteAllText((Join-Path $TargetDirectory 'reshade-input-gate.enabled'), '1')
[IO.File]::WriteAllText((Join-Path $TargetDirectory 'electron-game-overlay-demo-present.enabled'), '1')
$ApplicationIds = @{ a = 'com.electron-game-overlay.preload-compat.current' }
$Registrations = @{ a = Invoke-PreloadRegistration a register (Join-Path $CaseDirectory 'a-registration.json') }
if ($Registrations.a.addonBuildId -ceq $OldStamp.addonBuildId) { throw 'A mixed-version case requires a different current native implementation.' }
$Description = Invoke-PreloadRegistration a snapshot (Join-Path $CaseDirectory 'host-snapshot.json') (Join-Path $Stage 'addons')
$PreloadedPath = $Description.snapshot.addonPath
$RuntimeSource = Join-Path $Sdks.a 'runtime\win32-x64\reshade\ReShade64.dll'
$RuntimePath = Join-Path $Stage 'ReShade64.dll'
Copy-Item -LiteralPath $RuntimeSource -Destination $RuntimePath
[IO.File]::WriteAllText((Join-Path $Stage 'ReShade.ini'), "[INSTALL]`nBasePath=.`n[ADDON]`nAddonPath=$($Description.snapshot.directory)`n", [Text.UTF8Encoding]::new($false))
Write-OwnedOverlayRunMarker -RunDirectory $Stage -BuildRoot $PreloadBuildRoot
$OwnedMarker = Join-Path $Stage 'electron-game-overlay-owned-runtime-v1.marker'
if ([IO.File]::ReadAllText($OwnedMarker) -cne "ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1`n") { throw 'The compatibility host is missing its exact owned-runtime opt-in marker.' }
[IO.File]::WriteAllText((Join-Path $TargetDirectory 'electron-game-overlay-preload-runtime.path'), $RuntimePath, [Text.UTF8Encoding]::new($false))
$Apps = @{}; $AllApps = [Collections.Generic.List[object]]::new(); $Target = $null; $script:Sequence = 0; $MouseHeld = $false
$CaseResult = [ordered]@{
    schemaVersion = 1; backend = $Backend; status = 'running'
    scope = 'Copied repository DirectX demo; test-only self-load of the current SDK owned host with its exact reserved marker, not foreign stock-host compatibility; actual old SDK dynamic attachment. Windows SendInput, not physical-key acceptance. File hashes and OS module bases, not remote-memory attestation.'
    currentSdkDist = $Sdks.a; unregisteredSdkDist = $Sdks.b; unregisteredConsumerRoot = $SdkConsumers.b
    registeredBuildId = $Registrations.a.addonBuildId; unregisteredBuildId = $OldStamp.addonBuildId
    ownedHost = @{ path = $RuntimePath; sha256 = (Get-FileHash -LiteralPath $RuntimePath -Algorithm SHA256).Hash; markerPath = $OwnedMarker; markerSha256 = (Get-FileHash -LiteralPath $OwnedMarker -Algorithm SHA256).Hash }
    checks = [Collections.Generic.List[string]]::new(); cleanupErrors = [Collections.Generic.List[string]]::new()
}
$Failure = $null
try {
    $Target = Start-PreloadProcess (New-PreloadProcessInfo $TargetPath @() $true)
    $TargetCreation = $Target.process.StartTime.ToFileTimeUtc().ToString()
    $CaseResult.target = @{ pid = $Target.process.Id; creationTime100ns = $TargetCreation; executablePath = $TargetPath; sha256 = (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash }
    Remove-Item -LiteralPath $Barrier
    Wait-Preload { Test-Path -LiteralPath (Join-Path $TargetDirectory 'electron-game-overlay-demo-present.ready') -PathType Leaf } 'eight successful demo Presents with current app offline' 30
    $Present = Get-Content -LiteralPath (Join-Path $TargetDirectory 'electron-game-overlay-demo-present.ready') -Raw
    if ($Present -notmatch "(?m)^pid=$($Target.process.Id)\r?$" -or $Present -notmatch "(?m)^creationFileTime=$TargetCreation\r?$" -or $Present -notmatch '(?m)^successfulPresents=8\r?$') { throw 'First-Present acknowledgment does not identify the exact owned target.' }
    Activate-PreloadTarget
    $Dormant = Get-PreloadSnapshot 'dormant-current-app-offline' 0 0 0
    if ($Dormant.registry.lifetimeSlots -ne 0 -or $Dormant.registry.activeParticipants -ne 0 -or $Dormant.registry.focus.participant -ne 0 -or $Dormant.registry.capture.participant -ne 0 -or
        @($Dormant.modules | Where-Object { Test-PreloadPath $_.path $PreloadedPath }).Count -ne 1 -or
        @($Dormant.modules | Where-Object { [IO.Path]::GetExtension($_.path) -ieq '.addon64' }).Count -ne 1) { throw 'The sole registered current implementation did not remain dormant.' }
    $CaseResult.checks.Add('Current registered implementation supplies the only dormant dispatcher with no application or private engine workers running')
    # B intentionally receives no preload options and is never registered.
    $null = Start-PreloadApp b first 1 $true $false
    $OldOnly = Get-PreloadSnapshot 'old-unregistered-active-current-offline' 1 1 1
    $OldState = Assert-PreloadAuthentication b
    if ($OldState.addonPreload -or $OldState.sdk.addon.buildId -cne $OldStamp.addonBuildId -or $OldState.attachment.runtimeMode -cne 'participant-addon') { throw 'The older SDK did not use a normal unregistered participant route.' }
    $OldNativePath = $OldState.attachment.addonModulePath
    $OldSourcePath = Join-Path $Sdks.b 'runtime\win32-x64\reshade\electron_game_overlay.addon64'
    $CaseResult.oldNativeResult = Read-OwnedOverlayInjectorResult -StdoutPath $OldState.attachment.injectorStdoutPath -ExpectedPid $Target.process.Id -ExpectedExecutablePath $TargetPath -ExpectedRuntimePath $RuntimePath -ExpectedAddonPath $OldNativePath -ExpectedBasePath $Stage
    $CaseResult.oldMappedProof = Get-PreloadExactPidMappedEvidence $Apps.b $OldState $RuntimePath $OldNativePath (Get-FileHash -LiteralPath $RuntimeSource -Algorithm SHA256).Hash (Get-FileHash -LiteralPath $OldSourcePath -Algorithm SHA256).Hash
    if (@($OldOnly.registry.participants | Where-Object { Test-PreloadPath $_.modulePath $OldNativePath }).Count -ne 1 -or @($OldOnly.modules | Where-Object { [IO.Path]::GetExtension($_.path) -ieq '.addon64' }).Count -ne 2 -or @($Apps.Keys).Count -ne 1) { throw 'The old app did not own exactly one distinct private implementation while the registered app remained offline.' }
    Activate-PreloadTarget
    Assert-PreloadPixel 55 130 0x2828c6 'unregistered gen16 red surface while current dispatcher app is offline'
    Type-Preload b older
    $CaseResult.checks.Add('Unregistered generation-16 SDK dynamically joins the dormant current baseline, authenticates and renders/routes keyboard while the registered app is offline')
    $null = Start-PreloadApp a late
    $Both = Get-PreloadSnapshot 'both-versions-active' 2 2 2
    Assert-PreloadMappedReuse $OldOnly $Both $PreloadedPath
    $CurrentState = Assert-PreloadAuthentication a
    $CaseResult.currentNativeResult = Read-OwnedOverlayInjectorResult -StdoutPath $CurrentState.attachment.injectorStdoutPath -ExpectedPid $Target.process.Id -ExpectedExecutablePath $TargetPath -ExpectedRuntimePath $RuntimePath -ExpectedAddonPath $PreloadedPath -ExpectedBasePath $Stage
    if ($CurrentState.windows.main.id -ne $OldState.windows.main.id -or $CurrentState.transport.port -eq $OldState.transport.port -or $CurrentState.transport.tokenFingerprint -ceq $OldState.transport.tokenFingerprint) { throw 'Mixed SDKs did not retain independent private routes and colliding local window IDs.' }
    $CaseResult.privateTransports = @{ old = $OldState.transport; current = $CurrentState.transport }
    Activate-PreloadTarget
    Set-PreloadInterception b a $true $true
    Type-Preload a current; Type-Preload b older
    if ((Read-PreloadState a).windows.main.value -cne 'current') { throw 'Old-version input changed the current app window.' }
    Send-PreloadCommand b create-extra
    Wait-Preload { (Read-PreloadState b).windows.extra.alphaProbe.hole -eq 0 -and (Read-PreloadState b).windows.extra.alphaProbe.opaque -eq 255 } 'old SDK transparent paint'
    Assert-PreloadPixel 230 235 0xc06515 'current version surface interleaves above old main'
    Assert-PreloadPixel 480 350 0x327d2e 'old version extra interleaves above current surface'
    Assert-PreloadPixel 470 430 0xc06515 'old alpha cutout reveals current surface'
    $CurrentDowns = (Read-PreloadState a).windows.main.downs
    Click-Preload 470 430
    Wait-Preload { (Read-PreloadState a).windows.main.downs -eq $CurrentDowns + 1 } 'mixed-version transparent pointer routing'
    Set-PreloadInterception b a $true $false; Set-PreloadInterception b a $false $true; Set-PreloadInterception b a $false $false; Set-PreloadInterception b a $true $true
    $CaseResult.checks.Add('Current activation reuses its mapped base; both native builds isolate private input/window IDs and preserve interleaved alpha surfaces and OR interception')
    $OldFingerprint = (Read-PreloadState b).transport.tokenFingerprint
    Send-PreloadCommand a focus
    Stop-PreloadApp $Apps.a $true
    $Survivor = Get-PreloadSnapshot 'old-survives-current-dispatcher-app-crash' 2 1 2
    $OldParticipant = @($Survivor.registry.participants | Where-Object { Test-PreloadPath $_.modulePath $OldNativePath })
    if ($OldParticipant.Count -ne 1 -or $Survivor.registry.focus.participant -notin @(0, $OldParticipant[0].id) -or $Survivor.registry.capture.participant -ne 0 -or $Survivor.registry.captureButtons -ne 0 -or
        (Assert-PreloadAuthentication b).transport.tokenFingerprint -cne $OldFingerprint) { throw 'Current app crash changed the surviving old route or retained dead input ownership.' }
    Activate-PreloadTarget
    Assert-PreloadPixel 55 130 0x2828c6 'old SDK survives the supplying dispatcher application crash'
    Type-Preload b survivor
    $CaseResult.checks.Add('Older unregistered SDK survives the current dispatcher application crash with the same private route and working rendering/input')
    Send-PreloadCommand b release; Send-PreloadCommand b close-extra; Stop-PreloadApp $Apps.b
    $Final = Get-PreloadSnapshot 'both-versions-offline' 0 0 2
    if ($Final.registry.focus.participant -ne 0 -or $Final.registry.capture.participant -ne 0 -or $Final.registry.captureButtons -ne 0) { throw 'Final old-version shutdown retained input ownership.' }
    if ((Get-FileHash -LiteralPath $RuntimePath -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $RuntimeSource -Algorithm SHA256).Hash -or
        (Test-Path -LiteralPath (Join-Path $TargetDirectory 'ReShade64.dll')) -or (Test-Path -LiteralPath (Join-Path $TargetDirectory 'ReShade.ini'))) { throw 'Compatibility mutated its external host or installed ReShade into the target directory.' }
    $CaseResult.status = 'passed'
} catch { $Failure = $_; $CaseResult.status = 'failed'; $CaseResult.error = $_.Exception.Message }
finally {
    if ($MouseHeld) { try { [ReShadeClientSdkGate.NativeInputMethods]::SendLeftUp() } catch { $CaseResult.cleanupErrors.Add($_.Exception.Message) } }
    foreach ($Entry in $AllApps) {
        try { Stop-PreloadApp $Entry } catch { $CaseResult.cleanupErrors.Add($_.Exception.Message) }
        try { Save-PreloadLogs $Entry $Entry.directory } catch { $CaseResult.cleanupErrors.Add($_.Exception.Message) }
    }
    if ($Target) {
        try {
            $CloseRequested = $false; $Forced = $false; $WasAlive = -not $Target.process.HasExited
            if ($WasAlive) { $CloseRequested = $Target.process.CloseMainWindow(); if (-not $Target.process.WaitForExit(5000)) { $Forced = $true; $Target.process.Kill(); $null = $Target.process.WaitForExit(5000) } }
            $CaseResult.targetCleanup = Get-PreloadProcessEvidence $Target 'target-cleanup-complete'
            $CaseResult.targetCleanup.wasRunningBeforeCleanup = $WasAlive; $CaseResult.targetCleanup.closeRequested = $CloseRequested; $CaseResult.targetCleanup.forcedTermination = $Forced
            $CaseResult.targetDiagnostics = Get-PreloadTargetDiagnostics
            Save-PreloadJson $CaseResult.targetCleanup (Join-Path $CaseDirectory 'target-cleanup.json')
            Save-PreloadLogs $Target $TargetDirectory
        } catch { $CaseResult.cleanupErrors.Add($_.Exception.Message) }
    }
    if ($CaseResult.cleanupErrors.Count -gt 0) { $CaseResult.status = 'failed'; if (-not $CaseResult.error) { $CaseResult.error = 'Owned process cleanup failed.' } }
    Save-PreloadJson $CaseResult (Join-Path $CaseDirectory 'report.json')
}
if ($Failure) { throw $Failure }
if ($CaseResult.status -ne 'passed') { throw 'Mixed-version compatibility cleanup failed.' }
Write-Host "${BackendLabel}_CLIENT_SDK_UNREGISTERED_ADDON_COMPATIBILITY_GATE_PASS $CaseDirectory"
