#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('d3d9', 'd3d10', 'd3d11', 'd3d12')][string]$Backend,
    [ValidateSet('x64', 'x86')][string]$Architecture = 'x64',
    [ValidateSet('pre-device', 'late')][string]$AttachmentTiming = 'pre-device',
    [string]$SdkDistA,
    [string]$SdkDistB,
    [string]$ElectronExecutable,
    [string]$SentinelPath,
    [string]$RejectedAddonPath,
    [switch]$SkipBuild
)

# One controller-owned repository demo, a private shared add-on folder and two
# genuine SDK producers. No user game, production registry or existing host is
# modified. Synthetic keyboard input remains separate from physical-key proof.
$ErrorActionPreference = 'Stop'
if ($Architecture -eq 'x86' -and $Backend -notin @('d3d9', 'd3d10')) { throw 'The repository x86 demos support D3D9 and D3D10.' }
if ($AttachmentTiming -eq 'late' -and ($Backend -ne 'd3d11' -or $Architecture -ne 'x64')) { throw 'Late shared-folder first-host acceptance uses the repository x64 D3D11 demo.' }
$MatrixBackend = $Backend; $MatrixArchitecture = $Architecture; $MatrixSkipBuild = $SkipBuild
$MatrixAttachmentTiming = $AttachmentTiming
$MatrixSdkA = $SdkDistA; $MatrixSdkB = $SdkDistB; $MatrixElectron = $ElectronExecutable
$MatrixSentinel = $SentinelPath; $MatrixRejected = $RejectedAddonPath
. (Join-Path $PSScriptRoot 'run-client-sdk-preloaded-addons-gate.ps1') -Backend d3d11 -FunctionsOnly -SkipBuild
$Backend = $MatrixBackend; $Architecture = $MatrixArchitecture; $AttachmentTiming = $MatrixAttachmentTiming
$BackendLabel = $Backend.ToUpperInvariant()
$ArchitectureSuffix = if ($Architecture -eq 'x86') { '-x86' } else { '' }
$ProductionBuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime-production$ArchitectureSuffix"
$CMakePreset = if ($Architecture -eq 'x86') { 'vs2022-x86-production' } else { 'vs2022-x64-production' }
$HostTarget = "${Backend}_overlay_test_host"
$BuiltHost = Join-Path $ProductionBuildRoot "RelWithDebInfo\$HostTarget.exe"
$SentinelBuild = Join-Path $RepoRoot "build\shared-addon-sentinel-$Architecture"
$CMakeArchitecture = if ($Architecture -eq 'x86') { 'Win32' } else { 'x64' }
if (-not $MatrixSkipBuild) {
    Push-Location $RuntimeRoot
    try {
        & cmake.exe --preset $CMakePreset
        if ($LASTEXITCODE -ne 0) { throw 'Controlled demo configure failed.' }
        & cmake.exe --build $ProductionBuildRoot --config RelWithDebInfo --target $HostTarget --parallel
        if ($LASTEXITCODE -ne 0) { throw 'Controlled demo build failed.' }
    } finally { Pop-Location }
    & cmake.exe -S (Join-Path $RuntimeRoot 'tests\shared-addon-sentinel') -B $SentinelBuild -G 'Visual Studio 17 2022' -A $CMakeArchitecture "-DRESHADE_INCLUDE_DIRECTORY=$(Join-Path $RepoRoot 'build\electron-game-overlay-runtime\_deps\reshade-src\include')"
    if ($LASTEXITCODE -ne 0) { throw 'Ordinary add-on sentinel configure failed.' }
    & cmake.exe --build $SentinelBuild --config Release --parallel
    if ($LASTEXITCODE -ne 0) { throw 'Ordinary add-on sentinel build failed.' }
}
$ElectronExecutable = (Resolve-Path -LiteralPath $(if ($MatrixElectron) { $MatrixElectron } else { Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' })).Path
$NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$Sdks = @{ a = (Resolve-Path -LiteralPath $(if ($MatrixSdkA) { $MatrixSdkA } else { Join-Path $RepoRoot 'libs\electron-game-overlay\dist' })).Path }
$Sdks.b = (Resolve-Path -LiteralPath $(if ($MatrixSdkB) { $MatrixSdkB } else { $Sdks.a })).Path
$Sdks.c = $Sdks.a
$SentinelPath = (Resolve-Path -LiteralPath $(if ($MatrixSentinel) { $MatrixSentinel } else { Join-Path $SentinelBuild 'Release\shared_addon_sentinel.dll' })).Path
$RejectedAddonPath = (Resolve-Path -LiteralPath $(if ($MatrixRejected) { $MatrixRejected } else { Join-Path $SentinelBuild 'Release\shared_addon_reject.dll' })).Path
foreach ($File in @($BuiltHost, $ProducerFixture, $RegistrationFixture, (Join-Path $Sdks.a 'preload.js'), (Join-Path $Sdks.b 'preload.js'))) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Required candidate artifact missing: $File" }
}
$NativeRuntimeName = if ($Architecture -eq 'x86') { 'ReShade32.dll' } else { 'ReShade64.dll' }
$NativeAddonExtension = if ($Architecture -eq 'x86') { '.addon32' } else { '.addon64' }
function ConvertTo-SharedModulePath([string]$Value) {
    if ($Value.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { return '\\' + $Value.Substring(8) }
    if ($Value.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) { return $Value.Substring(4) }
    return $Value
}
function Test-SharedModulePath([string]$Left, [string]$Right) { return [string]::Equals((ConvertTo-SharedModulePath $Left), (ConvertTo-SharedModulePath $Right), [StringComparison]::OrdinalIgnoreCase) }
function Start-SharedFolderApp([string]$Member, [bool]$PreDevice = $false) {
    $Directory = Join-Path $CaseDirectory "p\$Member"; New-Item -ItemType Directory -Path $Directory | Out-Null
    $RunsRoot = Join-Path $CaseDirectory "runs-$Member"
    $Arguments = @($ProducerFixture, "--member=$Member", "--slot=$(if ($Member -eq 'a') { 'first' } else { 'late' })", "--evidence=$Directory", "--sdk-dist=$($Sdks[$Member])", "--game=$TargetPath", "--pid=$($Target.process.Id)", "--runs-root=$RunsRoot", '--exact-pid-proof=1', "--preload-app-id=$($ApplicationIds[$Member])", "--preload-addon-directory=$StorageRoot")
    $Entry = Start-PreloadProcess (New-PreloadProcessInfo $ElectronExecutable $Arguments)
    $Entry.member = $Member; $Entry.directory = $Directory; $Entry.runsRoot = $RunsRoot
    $Apps[$Member] = $Entry; $AllApps.Add($Entry)
    Save-PreloadJson @{ executable = $ElectronExecutable; arguments = $Arguments; processId = $Entry.process.Id; creationTime100ns = $Entry.creationTime100ns } (Join-Path $Directory 'process-launch.json')
    Wait-Preload { $State = Read-PreloadState $Member; $State -and $State.ready -and $(if ($PreDevice) { $State.injectorReturned } else { $State.attached -and $State.rendering }) } "$Member genuine SDK $(if ($PreDevice) { 'native injection return' } else { 'authenticated rendering' })" 75
    $CaseResult["${Member}InjectorBinding"] = Assert-SharedFolderInjectorBinding $Member $Entry (Read-PreloadState $Member)
    Retain-PreloadChildren $Entry
    return $Entry
}
function Assert-SharedFolderInjectorBinding([string]$Member, $Entry, $State) {
    $Binding = $State.injectorBinding; $Proof = $State.injectorProof
    $ExpectedInjector = if ($Architecture -eq 'x86') { 'inject32.exe' } else { 'inject.exe' }
    $ExpectedAddon = if ($Architecture -eq 'x86') { $Registrations[$Member].x86AddonPath } else { $Registrations[$Member].addonPath }
    $Target.process.Refresh()
    if ($Target.process.HasExited -or $Target.process.StartTime.ToFileTimeUtc().ToString() -cne $TargetCreation -or
        -not (Test-SharedModulePath $Target.process.MainModule.FileName $TargetPath)) { throw 'Exact injector binding no longer has the retained target incarnation.' }
    if ($State.processId -ne $Entry.process.Id -or -not $State.injectorReturned -or $null -eq $Binding -or $null -eq $Proof -or
        $Binding.pid -ne $Target.process.Id -or $Binding.creationTime100ns -cne $TargetCreation -or
        -not (Test-SharedModulePath $Binding.executablePath $TargetPath) -or
        $Proof.injectorTargetPid -ne $Target.process.Id -or -not (Test-SharedModulePath $Proof.targetExecutablePath $TargetPath) -or
        -not (Test-SharedModulePath $Binding.runDirectory $Proof.runDirectory) -or
        [IO.Path]::GetFileName($Binding.injectorExecutable) -ine $ExpectedInjector -or
        -not (Test-SharedModulePath ([IO.Path]::GetDirectoryName($Binding.injectorExecutable)) $Binding.runDirectory) -or
        $Binding.preloadedAddonName -cne [IO.Path]::GetFileName($ExpectedAddon)) { throw 'Captured injector binding does not name this producer and exact retained target PID, creation time, image, stage and architecture.' }
    $Relative = [IO.Path]::GetRelativePath($Entry.runsRoot, $Binding.runDirectory)
    if (-not $Relative -or $Relative -in @('.', '..') -or $Relative.StartsWith('..\', [StringComparison]::Ordinal) -or [IO.Path]::IsPathRooted($Relative)) { throw 'Captured exact injector binding escaped its producer-owned runs root.' }
    return $Binding
}
function Read-SharedFolderInitialResult([string]$StdoutPath) {
    if ($Architecture -eq 'x64') { return Read-PreloadInitialResult $StdoutPath }
    $Item = Get-Item -LiteralPath $StdoutPath -Force -ErrorAction Stop
    if ($Item.Length -lt 1 -or $Item.Length -gt 1MB -or ($Item.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)) -ne 0) { throw 'Combined x86 injector stdout must be a bounded regular file.' }
    $Bytes = [IO.File]::ReadAllBytes($StdoutPath)
    if ($Bytes.Length -lt 1 -or $Bytes.Length -gt 1MB) { throw 'Combined injector stdout changed beyond its bound.' }
    $Text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
    if ($Text.StartsWith([string][char]0xfeff, [StringComparison]::Ordinal)) { throw 'Combined injector stdout must be BOM-free.' }
    $Lines = @($Text -split '\r?\n')
    $Headers = @()
    for ($Index = 0; $Index -lt $Lines.Count; $Index++) { if ($Lines[$Index].StartsWith('===', [StringComparison]::Ordinal)) { $Headers += $Index } }
    if ($Headers.Count -ne 2 -or $Headers[0] -ne 0 -or $Lines[$Headers[0]] -cne '=== x64 injector stdout ===' -or $Lines[$Headers[1]] -cne '=== x86 injector stdout ===') { throw 'Expected exactly one ordered x64/x86 injector stdout header pair.' }
    $SelectedLine = "EGO_TARGET_SELECTED`t$($Target.process.Id)"
    $ArchitectureLine = 'Process architecture does not match injection tool! Cannot continue.'
    $DiagnosticPrefix = 'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC '
    $ResultPrefix = 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT '
    $Counts = @{ selected = 0; architecture = 0; diagnostic = 0; notStarted = 0 }
    $Diagnostic = $null
    for ($Index = 1; $Index -lt $Headers[1]; $Index++) {
        $Line = $Lines[$Index]
        if ($Line -ceq '') { continue }
        if ($Line -ceq $SelectedLine) { $Counts.selected++; continue }
        if ($Line -ceq $ArchitectureLine) { $Counts.architecture++; continue }
        if ($Line -ceq 'ReShade injection not started.') { $Counts.notStarted++; continue }
        if ($Line.StartsWith($DiagnosticPrefix, [StringComparison]::Ordinal)) {
            $Counts.diagnostic++
            $Json = $Line.Substring($DiagnosticPrefix.Length)
            $Diagnostic = $Json | ConvertFrom-Json -ErrorAction Stop
            $Keys = @($Diagnostic.PSObject.Properties.Name | Sort-Object)
            if (($Keys -join ',') -cne 'code,injectionStarted,pid,schemaVersion,stage,targetExecutablePath,windowsErrorCode') { throw 'Unexpected architecture handoff diagnostic fields.' }
            foreach ($Key in $Keys) { if ([regex]::Matches($Json, ('"' + [regex]::Escape($Key) + '"\s*:')).Count -ne 1) { throw 'Ambiguous architecture handoff diagnostic fields.' } }
            if (($Diagnostic.schemaVersion -isnot [int] -and $Diagnostic.schemaVersion -isnot [long]) -or $Diagnostic.schemaVersion -ne 1 -or
                $Diagnostic.stage -isnot [string] -or $Diagnostic.stage -cne 'target-preflight' -or
                $Diagnostic.code -isnot [string] -or $Diagnostic.code -cne 'target-architecture-mismatch' -or
                ($Diagnostic.pid -isnot [int] -and $Diagnostic.pid -isnot [long]) -or $Diagnostic.pid -ne $Target.process.Id -or
                $Diagnostic.targetExecutablePath -isnot [string] -or -not (Test-SharedModulePath $Diagnostic.targetExecutablePath $TargetPath) -or
                $Diagnostic.injectionStarted -isnot [bool] -or $Diagnostic.injectionStarted -ne $false -or
                ($Diagnostic.windowsErrorCode -isnot [int] -and $Diagnostic.windowsErrorCode -isnot [long]) -or $Diagnostic.windowsErrorCode -ne 706) { throw 'Architecture handoff does not prove the exact target was rejected before injection.' }
            continue
        }
        throw 'Unexpected x64 injector output before the x86 handoff.'
    }
    foreach ($Count in $Counts.Values) { if ($Count -ne 1) { throw 'Architecture handoff omitted or repeated its required pre-injection evidence.' } }
    $X86Lines = @($Lines[($Headers[1] + 1)..($Lines.Count - 1)])
    $X86Selected = 0; $X86Succeeded = 0; $X86Results = 0
    foreach ($Line in $X86Lines) {
        if ($Line -ceq '') { continue }
        if ($Line -ceq $SelectedLine) { $X86Selected++; continue }
        if ($Line -ceq "Found a matching process with PID $($Target.process.Id)! Injecting ReShade ... Succeeded!") { $X86Succeeded++; continue }
        if ($Line.StartsWith($ResultPrefix, [StringComparison]::Ordinal)) { $X86Results++; continue }
        throw 'Unexpected x86 injector output after architecture handoff.'
    }
    if ($X86Selected -ne 1 -or $X86Succeeded -ne 1 -or $X86Results -ne 1) { throw 'Architecture handoff did not finish with exactly one x86 success and initial result.' }
    $CandidatePath = Join-Path $CaseDirectory ('validated-x86-initial-' + [Guid]::NewGuid().ToString('N') + '.stdout.log')
    $Stream = $null; $Writer = $null
    try {
        $Stream = [IO.File]::Open($CandidatePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $Writer = [IO.StreamWriter]::new($Stream, [Text.UTF8Encoding]::new($false, $true))
        $Writer.Write(($X86Lines -join "`n"))
    } finally { if ($Writer) { $Writer.Dispose() } elseif ($Stream) { $Stream.Dispose() } }
    $Result = Read-PreloadInitialResult $CandidatePath
    $CaseResult.architectureHandoff = @{ scope = 'Only the verified x64 architecture-mismatch pre-injection section is excluded from strict initial-result parsing; exact target creation remains separately bound to retained OS handle and captured native argv.'; sourcePath = $StdoutPath; sourceSha256 = (Get-FileHash -LiteralPath $StdoutPath -Algorithm SHA256).Hash; diagnostic = $Diagnostic; validatedX86Path = $CandidatePath; validatedX86Sha256 = (Get-FileHash -LiteralPath $CandidatePath -Algorithm SHA256).Hash }
    return $Result
}
function Get-SharedFolderModules([string]$Label) {
    $Target.process.Refresh()
    if ($Target.process.HasExited -or $Target.process.StartTime.ToFileTimeUtc().ToString() -cne $TargetCreation -or -not (Test-SharedModulePath $Target.process.MainModule.FileName $TargetPath)) { throw 'Retained controlled target identity changed.' }
    $Records = @($Target.process.Modules | ForEach-Object { [ordered]@{ path = $_.FileName; name = $_.ModuleName; baseAddress = $_.BaseAddress.ToInt64().ToString(); size = $_.ModuleMemorySize } })
    $SelectedPayloadPaths = @($ForeignPath, $Registrations.a.addonPath, $Registrations.a.x86AddonPath, $Registrations.b.addonPath, $Registrations.b.x86AddonPath)
    foreach ($Record in $Records) {
        if ($Record.name -match '^ReShade(?:32|64)\.dll$' -or @($SelectedPayloadPaths | Where-Object { Test-SharedModulePath $_ $Record.path }).Count -ne 0) {
            $Record['sha256'] = (Get-FileHash -LiteralPath $Record.path -Algorithm SHA256).Hash
        }
    }
    $Target.process.Refresh()
    if ($Target.process.HasExited -or $Target.process.StartTime.ToFileTimeUtc().ToString() -cne $TargetCreation) { throw 'Controlled target exited during module observation.' }
    $Hosts = @($Records | Where-Object { $_.name -match '^ReShade(?:32|64)\.dll$' })
    if ($Hosts.Count -ne 1 -or $Hosts[0].name -ine $NativeRuntimeName) { throw 'Expected exactly one architecture-correct ReShade host.' }
    $ExpectedHost = Join-Path (Read-PreloadState a).attachment.runDirectory $NativeRuntimeName
    if (-not (Test-SharedModulePath $Hosts[0].path $ExpectedHost) -or
        (Get-FileHash -LiteralPath $Hosts[0].path -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath (Join-Path $Sdks.a "runtime\win32-x64\reshade\$NativeRuntimeName") -Algorithm SHA256).Hash) { throw 'Mapped host differs from the initiating SDK payload.' }
    foreach ($Member in @('a', 'b')) {
        $ExpectedAddon = if ($Architecture -eq 'x86') { $Registrations[$Member].x86AddonPath } else { $Registrations[$Member].addonPath }
        $Matches = @($Records | Where-Object { Test-SharedModulePath $_.path $ExpectedAddon })
        if ($Matches.Count -ne 1 -or (Get-FileHash -LiteralPath $Matches[0].path -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $ExpectedAddon -Algorithm SHA256).Hash) { throw "Registered $Member add-on was not mapped directly from the stable shared folder." }
    }
    foreach ($Retired in @(@{ path = $RetiredRegistration.addonPath; sha256 = $RetiredAddonHash }, @{ path = $RetiredRegistration.x86AddonPath; sha256 = $RetiredX86AddonHash })) {
        if (@($Records | Where-Object { Test-SharedModulePath $_.path $Retired.path }).Count -ne 0 -or
            -not (Test-Path -LiteralPath $Retired.path -PathType Leaf) -or
            (Get-FileHash -LiteralPath $Retired.path -Algorithm SHA256).Hash -cne $Retired.sha256) { throw 'A retired add-on was loaded, removed or changed while the future host scanned the stable folder.' }
    }
    if (@($Records | Where-Object { [IO.Path]::GetExtension($_.path) -ieq $NativeAddonExtension }).Count -ne 2) { throw 'Initial shared-folder activation mapped an extra private EGO implementation.' }
    if (@($Records | Where-Object { Test-SharedModulePath $_.path $ForeignPath }).Count -ne 1 -or @($Records | Where-Object { Test-SharedModulePath $_.path $RejectedPath }).Count -ne 0) { throw 'Ordinary successful/rejected add-on loading did not follow ReShade rules.' }
    Save-PreloadJson @{ targetPid = $Target.process.Id; creationTime100ns = $TargetCreation; modules = $Records } (Join-Path $CaseDirectory "$Label-modules.json")
    return $Records
}
function Assert-SharedSentinel([string]$Prefix, [int]$Accepted) {
    $Path = Join-Path $StorageRoot "$Prefix-$($Target.process.Id).ready"
    Wait-Preload { Test-Path -LiteralPath $Path -PathType Leaf } "$Prefix ordinary add-on initialization" 15
    $Text = [IO.File]::ReadAllText($Path)
    if ($Text -cne "EGO_ORDINARY_ADDON_RECEIPT_V1`npid=$($Target.process.Id)`ncreationFileTime=$TargetCreation`n") { throw 'Ordinary add-on marker does not identify this exact controlled target.' }
    return @{ path = $Path; accepted = $Accepted; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash; text = $Text }
}
function Read-SharedPreAttachmentPresentOracle {
    $Path = Join-Path $TargetDirectory 'electron-game-overlay-present-v1.log'
    $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($Item.Length -lt 1 -or $Item.Length -gt 256KB -or ($Item.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)) -ne 0) { throw 'Pre-attachment graphics oracle must be a bounded regular file.' }
    $Stream = $null; $Reader = $null
    try {
        $Stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        if ($Stream.Length -gt 256KB) { throw 'Pre-attachment graphics oracle grew beyond its bound.' }
        $Reader = [IO.StreamReader]::new($Stream, [Text.UTF8Encoding]::new($false, $true), $false)
        $Text = $Reader.ReadToEnd()
    } finally { if ($Reader) { $Reader.Dispose() } elseif ($Stream) { $Stream.Dispose() } }
    $Target.process.Refresh()
    if ($Target.process.HasExited -or $Target.process.StartTime.ToFileTimeUtc().ToString() -cne $TargetCreation -or -not (Test-SharedModulePath $Target.process.MainModule.FileName $TargetPath)) { throw 'Pre-attachment graphics observation lost the retained exact target.' }
    $Candidate = $null
    $Lines = $Text.Split([char]10)
    for ($LineIndex = 0; $LineIndex -lt $Lines.Length - 1; $LineIndex++) {
        $Line = $Lines[$LineIndex].TrimEnd([char]13)
        if (-not $Line.StartsWith('EGO_CONTROLLED_PRESENT_V1 ', [StringComparison]::Ordinal)) { continue }
        $Fields = @{}
        foreach ($Token in $Line.Substring('EGO_CONTROLLED_PRESENT_V1 '.Length).Split(' ')) {
            $Separator = $Token.IndexOf('=')
            if ($Separator -le 0) { throw 'Malformed pre-attachment Present diagnostic field.' }
            $Key = $Token.Substring(0, $Separator)
            if ($Fields.ContainsKey($Key)) { throw 'Ambiguous pre-attachment Present diagnostic field.' }
            $Fields[$Key] = $Token.Substring($Separator + 1)
        }
        if ($Fields.pid -cne [string]$Target.process.Id) { throw 'Pre-attachment Present sample names another process.' }
        if ($Fields.surface -ceq 'primary' -and $Fields.calls -cmatch '^[1-9][0-9]{0,18}$' -and [UInt64]$Fields.calls -ge 8 -and
            $Fields.presentHr -ceq '0x00000000' -and $Fields.occluded -ceq 'false' -and $Fields.failed -ceq 'false' -and
            $Fields.deviceRemovedReason -ceq '0x00000000' -and $Fields.scope -ceq 'api-return-not-display-proof') { $Candidate = @{ line = $Line; fields = $Fields } }
    }
    if ($null -eq $Candidate) { throw 'No successful primary Present sample after eight calls has been observed before attachment.' }
    return @{ path = $Path; text = $Text; sample = $Candidate; targetPid = $Target.process.Id; creationTime100ns = $TargetCreation; scope = 'Successful primary Present API return after at least eight calls; exact target creation/image independently rechecked through retained OS handle. This is not display proof.' }
}

$CaseDirectory = Join-Path $RepoRoot ('build\shared-addon-directory\' + $Backend + '-' + $Architecture + '-' + $AttachmentTiming + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
$TargetDirectory = Join-Path $CaseDirectory 'target'; $StorageRoot = Join-Path $CaseDirectory 'addons'
New-Item -ItemType Directory -Path $TargetDirectory, $StorageRoot | Out-Null
$TargetPath = Join-Path $TargetDirectory 'demo.exe'; Copy-Item -LiteralPath $BuiltHost -Destination $TargetPath
$Barrier = Join-Path $TargetDirectory 'electron-game-overlay-startup-barrier.enabled'
[IO.File]::WriteAllText($Barrier, 'controlled pre-device barrier')
[IO.File]::WriteAllText((Join-Path $TargetDirectory 'reshade-input-gate.enabled'), '1')
$ForeignPath = Join-Path $StorageRoot 'ordinary-sentinel.addon'; $RejectedPath = Join-Path $StorageRoot 'ordinary-rejected.addon'
Copy-Item -LiteralPath $SentinelPath -Destination $ForeignPath
Copy-Item -LiteralPath $RejectedAddonPath -Destination $RejectedPath
$ForeignHash = (Get-FileHash -LiteralPath $ForeignPath -Algorithm SHA256).Hash; $RejectedHash = (Get-FileHash -LiteralPath $RejectedPath -Algorithm SHA256).Hash
$ApplicationIds = @{ a = 'com.electron-game-overlay.shared-folder.a'; b = 'com.electron-game-overlay.shared-folder.b'; c = 'com.electron-game-overlay.shared-folder.retired' }
$Apps = @{}; $AllApps = [Collections.Generic.List[object]]::new(); $Target = $null; $script:Sequence = 0
$CaseResult = [ordered]@{ schemaVersion = 1; scope = 'Copied repository DX demo, public SDK production injection and authenticated rendering, read-only exact-process OS module paths/bases plus full current file hashes. Synthetic input is not physical-key acceptance.'; backend = $Backend; architecture = $Architecture; attachmentTiming = $AttachmentTiming; status = 'running'; addonDirectory = $StorageRoot; sdkDistA = $Sdks.a; sdkDistB = $Sdks.b; checks = [Collections.Generic.List[string]]::new(); cleanupErrors = [Collections.Generic.List[string]]::new() }
$CaseResult.foreignAddons = @{ accepted = @{ path = $ForeignPath; sha256 = $ForeignHash }; rejected = @{ path = $RejectedPath; sha256 = $RejectedHash } }
$Failure = $null; $DisplayLease = $null
. (Join-Path $PSScriptRoot 'visual-test-display-lease.ps1')
try {
    $Registrations = @{}
    foreach ($Member in @('a', 'b')) { $Registrations[$Member] = Invoke-PreloadRegistration $Member register (Join-Path $CaseDirectory "$Member-registration.json") }
    $CaseResult.registrations = $Registrations
    $RetiredRegistration = Invoke-PreloadRegistration c register (Join-Path $CaseDirectory 'retired-registration.json')
    $RetiredAddonHash = (Get-FileHash -LiteralPath $RetiredRegistration.addonPath -Algorithm SHA256).Hash
    $RetiredX86AddonHash = (Get-FileHash -LiteralPath $RetiredRegistration.x86AddonPath -Algorithm SHA256).Hash
    $null = Invoke-PreloadRegistration c unregister (Join-Path $CaseDirectory 'retired-unregistration.json')
    $CaseResult.retiredRegistration = @{ installation = $RetiredRegistration; addonSha256 = $RetiredAddonHash; x86AddonSha256 = $RetiredX86AddonHash; producerStarted = $false }
    foreach ($Member in @('a', 'b')) {
        if (-not (Test-SharedModulePath ([IO.Path]::GetDirectoryName($Registrations[$Member].addonPath)) $StorageRoot) -or -not (Test-SharedModulePath ([IO.Path]::GetDirectoryName($Registrations[$Member].x86AddonPath)) $StorageRoot)) { throw 'Registration did not publish directly into the selected stable folder.' }
    }
    $TargetInfo = New-PreloadProcessInfo $TargetPath @() $true
    if ($AttachmentTiming -eq 'late') { $TargetInfo.EnvironmentVariables['ELECTRON_GAME_OVERLAY_CONTROLLED_PRESENT_DIAGNOSTIC'] = '1' }
    $Target = Start-PreloadProcess $TargetInfo
    $TargetCreation = $Target.creationTime100ns
    $CaseResult.target = @{ pid = $Target.process.Id; creationTime100ns = $TargetCreation; executablePath = $TargetPath; sha256 = (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash }
    if ($AttachmentTiming -eq 'late') {
        Remove-Item -LiteralPath $Barrier
        Wait-Preload { try { $null = Read-SharedPreAttachmentPresentOracle; return $true } catch { return $false } } 'successful primary Present after at least eight calls before an overlay app or ReShade host is loaded' 30
        $CaseResult.preAttachmentGraphics = Read-SharedPreAttachmentPresentOracle
        if ($Apps.Count -ne 0) { throw 'Late attachment graphics oracle was observed after an overlay app had already started.' }
        $BeforeModules = @($Target.process.Modules | ForEach-Object { [ordered]@{ path = $_.FileName; name = $_.ModuleName; baseAddress = $_.BaseAddress.ToInt64().ToString(); size = $_.ModuleMemorySize } })
        if (@($BeforeModules | Where-Object { $_.name -match '^ReShade(?:32|64)\.dll$' -or [IO.Path]::GetExtension($_.path) -in @('.addon', '.addon32', '.addon64') }).Count -ne 0) { throw 'Late attachment target already contains a ReShade host or add-on.' }
        $Target.process.Refresh()
        if ($Target.process.HasExited -or $Target.process.StartTime.ToFileTimeUtc().ToString() -cne $TargetCreation) { throw 'Late attachment target exited during the pre-attachment module observation.' }
        $CaseResult.preAttachmentModules = @{ targetPid = $Target.process.Id; creationTime100ns = $TargetCreation; modules = $BeforeModules }
        $CaseResult.checks.Add('Exact target returned a successful primary Present after at least eight calls with no ReShade host, add-on or overlay application before the first SDK injection')
    }
    $null = Start-SharedFolderApp a $true
    $InitialReturn = Read-PreloadState a
    if ($InitialReturn.injectorProof.runtimeMode -cne 'injected-runtime') { throw 'Fresh target did not use the initial injected-runtime route.' }
    $CaseResult.initialNativeResult = Read-SharedFolderInitialResult $InitialReturn.injectorProof.injectorStdoutPath
    if (Test-Path -LiteralPath $Barrier -PathType Leaf) { Remove-Item -LiteralPath $Barrier }
    Wait-Preload { $State = Read-PreloadState a; $State.attached -and $State.rendering } 'first app authenticated rendering after device startup' 60
    $FirstState = Assert-PreloadAuthentication a
    $InitialModules = Get-SharedFolderModules initial
    $CaseResult.sentinel = Assert-SharedSentinel sentinel 1
    $CaseResult.rejectedAddon = Assert-SharedSentinel rejected 0
    if ($Apps.ContainsKey('b')) { throw 'Offline peer unexpectedly has a producer process.' }
    $CaseResult.checks.Add('Initial host scans both stable EGO payloads and an ordinary successful add-on while peer app is offline; unrelated failed AddonInit does not prevent overlay rendering')
    $Config = [IO.File]::ReadAllText((Join-Path $FirstState.attachment.runDirectory 'ReShade.ini'))
    $ExpectedScan = '\\?\' + $StorageRoot
    if ($Config -notmatch ('(?m)^AddonPath=' + [regex]::Escape($ExpectedScan.Replace(',', ',,')) + '\r?$')) { throw 'Private host INI does not point to the shared folder.' }
    $DisabledLines = [regex]::Matches($Config, '(?m)^DisabledAddons=([^\r\n]*)\r?$')
    if ($DisabledLines.Count -ne 1) { throw 'Private host INI does not contain one unambiguous retired add-on disable list.' }
    $DisabledTokens = $DisabledLines[0].Groups[1].Value.Split(',')
    foreach ($RetiredPath in @($RetiredRegistration.addonPath, $RetiredRegistration.x86AddonPath)) {
        if (('@' + [IO.Path]::GetFileName($RetiredPath)) -cnotin $DisabledTokens) { throw 'Private host INI did not exclude both retired architecture filenames before scanning.' }
    }
    $CaseResult.checks.Add('Future host skips both retired EGO filenames through its private disable list while immutable retired DLL files remain in the stable folder')
    if (Test-Path -LiteralPath (Join-Path $FirstState.attachment.runDirectory 'preloaded-addons')) { throw 'Production launch created a moving per-run add-on snapshot.' }
    $null = Start-SharedFolderApp b
    $SecondState = Assert-PreloadAuthentication b
    $BothModules = Get-SharedFolderModules both
    foreach ($Before in $InitialModules | Where-Object { (Test-SharedModulePath $_.path $ForeignPath) -or [IO.Path]::GetExtension($_.path) -ieq $NativeAddonExtension -or $_.name -ieq $NativeRuntimeName }) {
        $After = @($BothModules | Where-Object { Test-SharedModulePath $_.path $Before.path })
        if ($After.Count -ne 1 -or $After[0].baseAddress -cne $Before.baseAddress -or $After[0].size -ne $Before.size) { throw 'Peer activation replaced or remapped a scanned module.' }
    }
    if ($FirstState.transport.port -eq $SecondState.transport.port -or $FirstState.transport.tokenFingerprint -ceq $SecondState.transport.tokenFingerprint) { throw 'Applications did not retain independent authenticated transports.' }
    $CaseResult.checks.Add('Late peer activates its exact existing module base and keeps a private authenticated transport without another ReShade initialization')
    $DisplayLease = Enter-VisualTestDisplayLease $CaseResult
    Activate-PreloadTarget
    Assert-PreloadPixel 55 130 0x2828c6 'first shared-folder app red surface'
    Assert-PreloadPixel 430 210 0xc06515 'second shared-folder app blue surface'
    $PeerFingerprint = $SecondState.transport.tokenFingerprint
    Stop-PreloadApp $Apps.a $true
    Wait-Preload { $State = Read-PreloadState b; $State.attached -and $State.rendering -and $State.transport.tokenFingerprint -ceq $PeerFingerprint } 'peer private route after initiating app crash' 15
    Activate-PreloadTarget
    Assert-PreloadPixel 430 210 0xc06515 'peer surface survives initiating application crash'
    Send-PreloadCommand b intercept
    Type-Preload b survivor
    $CaseResult.checks.Add('Surviving app continues rendering and receiving synthetic keyboard input after initiating app crashes')
    $FinalModules = Get-SharedFolderModules survivor
    if ((Get-FileHash -LiteralPath $ForeignPath -Algorithm SHA256).Hash -cne $ForeignHash -or (Get-FileHash -LiteralPath $RejectedPath -Algorithm SHA256).Hash -cne $RejectedHash) { throw 'SDK changed a foreign add-on file.' }
    foreach ($Leaf in @('ReShade32.dll', 'ReShade64.dll', 'ReShade.ini')) { if (Test-Path -LiteralPath (Join-Path $TargetDirectory $Leaf)) { throw 'The SDK installed ReShade into the target directory.' } }
    $CaseResult.checks.Add('Shared foreign add-on bytes remain unchanged and no runtime/configuration is installed into the demo directory')
    Send-PreloadCommand b release; Stop-PreloadApp $Apps.b
    $CaseResult.status = 'passed'
} catch { $Failure = $_; $CaseResult.status = 'failed'; $CaseResult.error = $_.Exception.Message }
finally {
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
            Save-PreloadLogs $Target $TargetDirectory
        } catch { $CaseResult.cleanupErrors.Add($_.Exception.Message) }
    }
    Exit-VisualTestDisplayLease $DisplayLease $CaseResult
    if ($CaseResult.cleanupErrors.Count -gt 0) { $CaseResult.status = 'failed'; if (-not $CaseResult.error) { $CaseResult.error = 'Owned process cleanup failed.' } }
    Save-PreloadJson $CaseResult (Join-Path $CaseDirectory 'report.json')
}
if ($Failure) { throw $Failure }
if ($CaseResult.status -ne 'passed') { throw 'Shared add-on directory cleanup failed.' }
Write-Output "${BackendLabel}_$($Architecture.ToUpperInvariant())_CLIENT_SDK_SHARED_ADDON_DIRECTORY_PASS $CaseDirectory"
