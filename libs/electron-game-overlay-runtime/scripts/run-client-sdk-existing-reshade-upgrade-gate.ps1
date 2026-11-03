[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OfficialRuntimePath,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'process-environment.ps1')
# Reuse the controlled-host, native-input, process-discovery, and scoped
# Electron-cleanup helpers without running the successful injection gate.
. (Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1") `
    -Backend d3d11 `
    -SkipBuild:$SkipBuild `
    -FunctionsOnly

$GateSlug = "existing-reshade-upgrade"
$RunDirectory = Join-Path `
    $BuildRoot `
    "client-sdk-d3d11-$GateSlug-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$TargetDirectory = Join-Path `
    $RunDirectory `
    "steamapps\common\Existing ReShade Upgrade"
$TargetExecutablePath = Join-Path $TargetDirectory $HostName
$StartupBarrierFileName = "electron-game-overlay-startup-barrier.enabled"
$StartupBarrierPath = Join-Path $TargetDirectory $StartupBarrierFileName
$InputGateMarkerPath =
    Join-Path $TargetDirectory "reshade-input-gate.enabled"
$ReShadeModulePath =
    Join-Path $TargetDirectory "dxgi.dll"
$ReShadeConfigurationPath = Join-Path $TargetDirectory "ReShade.ini"
$ReShadePresetPath = Join-Path $TargetDirectory "ReShadePreset.ini"
$AddonDirectory = Join-Path $TargetDirectory "existing-addons"
$EffectDirectory = Join-Path $TargetDirectory "existing-effects"
$TextureDirectory = Join-Path $TargetDirectory "existing-textures"
$OwnedAddonPath =
    Join-Path $AddonDirectory "electron_game_overlay.addon64"
$OwnershipMarkerPath =
    Join-Path $AddonDirectory ".electron-game-overlay-addon.json"
$TransactionPath =
    Join-Path `
        $AddonDirectory `
        ".electron-game-overlay-addon.transaction.json"
$RuntimeDistributionDirectory =
    Join-Path $RepoRoot "libs\electron-game-overlay\dist\runtime\win32-x64\reshade"
$AddonManagerPath =
    Join-Path `
        $RuntimeDistributionDirectory `
        "electron_game_overlay_reshade_manager.exe"
$ProductionAddonPath =
    Join-Path `
        $RuntimeDistributionDirectory `
        "electron_game_overlay.addon64"
$UserData = Join-Path $RunDirectory "user-data"
$ClientStdout = Join-Path $RunDirectory "client.stdout.log"
$ClientStderr = Join-Path $RunDirectory "client.stderr.log"
$ResultMarker =
    "D3D11_REAL_CLIENT_SDK_EXISTING_RESHADE_UPGRADE_GATE_PASS"
$ClientProcess = $null
$HostProcess = $null
$HostExitedNormally = $false
$Summary = $null
$RunOwnedInjectorRecords = @{}
$ObservedPathWatcherInjector = $false

function Wait-ForLogRegex {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $InspectOnce = $true
    while ($InspectOnce -or [DateTime]::UtcNow -lt $Deadline) {
        $InspectOnce = $false
        $Text = Get-ClientLogText -Path $Path
        if ($null -eq $Text) {
            $Text = ""
        }
        $Match = [regex]::Match($Text, $Pattern)
        if ($Match.Success) {
            return $Match
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw (
                "The production Electron client exited while waiting for " +
                "'$Pattern'. Inspect $Path."
            )
        }
        Start-Sleep -Milliseconds 50
    }

    throw "Timed out waiting for client pattern '$Pattern'. Inspect $Path."
}

function Get-UpgradeBoundArguments {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$CreationTime100ns,
        [ValidateSet('initial', 'official-wait', 'participant')][string]$Phase = 'initial'
    )
    [uint64]$ParsedCreationTime = 0
    if ($ProcessId -le 0 -or -not [IO.Path]::IsPathRooted($ExecutablePath) -or
        $CreationTime100ns -cnotmatch '^[1-9][0-9]{0,19}$' -or
        -not [uint64]::TryParse($CreationTime100ns, [ref]$ParsedCreationTime)) {
        throw 'The upgrade gate requires an exact retained OS process identity.'
    }
    $Arguments = @(
        [IO.Path]::GetFullPath($ExecutablePath), '--pid', [string]$ProcessId,
        '--expected-creation-time-100ns', $CreationTime100ns
    )
    if ($Phase -eq 'official-wait') {
        $Arguments += @('--wait-for-official-addon', '30000')
    }
    elseif ($Phase -eq 'participant') {
        $Arguments += '--addon-only'
    }
    return $Arguments
}

function Assert-UpgradeBoundArguments {
    param(
        [Parameter(Mandatory = $true)][object[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$CreationTime100ns,
        [ValidateSet('initial', 'official-wait', 'participant')][string]$Phase = 'initial'
    )
    $Expected = @(Get-UpgradeBoundArguments -ExecutablePath $ExecutablePath `
        -ProcessId $ProcessId -CreationTime100ns $CreationTime100ns -Phase $Phase)
    if (@($Arguments | Where-Object { $_ -isnot [string] }).Count -ne 0 -or
        ($Arguments | ConvertTo-Json -Compress) -cne ($Expected | ConvertTo-Json -Compress)) {
        throw "The $Phase invocation did not retain the exact target PID, creation FILETIME and phase flags."
    }
}

function Assert-UpgradePrearmedSelection {
    param(
        [Parameter(Mandatory = $true)][string]$InjectorOutput,
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$CreationTime100ns
    )
    $Records = @([regex]::Matches($InjectorOutput,
        '(?m)^EGO_TARGET_SELECTED_V2\t(?<pid>[1-9][0-9]*)\t(?<created>[1-9][0-9]*)\t(?<image>[^\t\r\n]+)\r?$'))
    if ($Records.Count -ne 1 -or
        $Records[0].Groups['pid'].Value -cne [string]$ProcessId -or
        $Records[0].Groups['created'].Value -cne $CreationTime100ns -or
        -not [string]::Equals($Records[0].Groups['image'].Value,
            [IO.Path]::GetFullPath($ExecutablePath), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The prearmed native selection did not prove the exact retained target incarnation.'
    }
}

function Assert-UpgradeLifecycleOrder {
    param(
        [Parameter(Mandatory = $true)][long]$WatcherReadyIndex,
        [Parameter(Mandatory = $true)][long]$DetectedIndex,
        [Parameter(Mandatory = $true)][long]$InitialIndex,
        [Parameter(Mandatory = $true)][long]$OfficialWaitIndex,
        [Parameter(Mandatory = $true)][long]$ReleaseBoundaryIndex,
        [Parameter(Mandatory = $true)][long]$ParticipantIndex,
        [Parameter(Mandatory = $true)][long]$ReturnedIndex,
        [Parameter(Mandatory = $true)][long]$ConnectedIndex,
        [Parameter(Mandatory = $true)][long]$AutoConnectedIndex,
        [Parameter(Mandatory = $true)][bool]$Prearmed
    )
    foreach ($Index in @($WatcherReadyIndex, $DetectedIndex, $InitialIndex,
            $OfficialWaitIndex, $ReleaseBoundaryIndex, $ParticipantIndex,
            $ReturnedIndex, $ConnectedIndex, $AutoConnectedIndex)) {
        if ($Index -lt 0) { throw 'The upgrade lifecycle is missing required evidence.' }
    }
    # The target may authenticate while its member-only native call is still
    # completing. Require both independent proofs after release, not a total
    # ordering between TCP authentication and injector completion callbacks.
    if ($WatcherReadyIndex -ge $DetectedIndex -or
        $DetectedIndex -ge $InitialIndex -or
        $InitialIndex -gt $ReleaseBoundaryIndex -or
        $WatcherReadyIndex -ge $OfficialWaitIndex -or
        (-not $Prearmed -and $InitialIndex -ge $OfficialWaitIndex) -or
        $OfficialWaitIndex -gt $ReleaseBoundaryIndex -or
        $ParticipantIndex -le $ReleaseBoundaryIndex -or
        $ParticipantIndex -ge $ReturnedIndex -or
        $ConnectedIndex -le $ReleaseBoundaryIndex -or
        $AutoConnectedIndex -le $ReleaseBoundaryIndex) {
        throw 'The upgrade lifecycle must be armed and instance-bound before release, then independently prove member completion and authenticated connection after release.'
    }
}

function Assert-NoTargetFailureOrMaintenance {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$TargetDescriptionJson
    )

    $StdoutText = Get-ClientLogText -Path $ClientStdout
    $StderrText = Get-ClientLogText -Path $ClientStderr
    $CombinedText = "$StdoutText`n$StderrText"
    $EscapedTargetDescription = [regex]::Escape($TargetDescriptionJson)
    foreach ($Pattern in @(
            "(?m)^STEAM_GAME_AUTO_ATTACH_FAILED pid=$ProcessId(?: .*)?\r?`$",
            (
                "(?m)^RESHADE_CLIENT_INJECTOR_FAILED " +
                "target=$EscapedTargetDescription(?: .*)?\r?`$"
            ),
            (
                "(?m)^ELECTRON_GAME_OVERLAY_RESHADE_MAINTENANCE_" +
                "(?:COMPLETED|FAILED) pid=$ProcessId(?: .*)?\r?`$"
            ),
            (
                "(?m)^STEAM_GAME_AUTO_ATTACH_FAILED pid=$ProcessId " +
                "[^\r\n]*existing-reshade-addon-maintenance-deferred" +
                "(?: .*)?\r?`$"
            ))) {
        if ([regex]::IsMatch($CombinedText, $Pattern)) {
            throw (
                "The version-agnostic official-add-on path emitted a target " +
                "failure or deferred maintenance marker matching '$Pattern'."
            )
        }
    }
}

function Assert-UpgradeParticipantResult {
    param(
        [Parameter(Mandatory = $true)][object]$Record,
        [Parameter(Mandatory = $true)][int]$ExpectedPid,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath,
        [Parameter(Mandatory = $true)][string]$ExpectedRuntimePath,
        [Parameter(Mandatory = $true)][string]$ExpectedAddonPath,
        [Parameter(Mandatory = $true)][string]$ExpectedBasePath
    )

    $ExpectedKeys = @(
        'schemaVersion', 'pid', 'targetExecutablePath', 'runtimeMode',
        'runtimeModulePath', 'reshadeBasePath', 'addonModulePath',
        'addonAbi', 'memberProtocolVersion'
    )
    $ActualKeys = @($Record.PSObject.Properties.Name)
    if ($ActualKeys.Count -ne $ExpectedKeys.Count -or
        @(Compare-Object $ExpectedKeys $ActualKeys -CaseSensitive).Count -ne 0) {
        throw 'The private participant result has unexpected or missing fields.'
    }
    foreach ($Field in @('schemaVersion', 'pid', 'addonAbi', 'memberProtocolVersion')) {
        if ($Record.$Field -isnot [int] -and $Record.$Field -isnot [long]) {
            throw "The private participant result has a non-integer $Field."
        }
    }
    if ($ExpectedPid -le 0 -or $Record.schemaVersion -ne 1 -or
        $Record.pid -ne $ExpectedPid -or
        $Record.runtimeMode -cne 'participant-addon' -or
        $Record.addonAbi -ne 1 -or $Record.memberProtocolVersion -ne 1) {
        throw 'The injector did not load this application as a protocol-1 participant in the exact upgraded target.'
    }
    $ExpectedPaths = @{
        targetExecutablePath = $ExpectedExecutablePath
        runtimeModulePath = $ExpectedRuntimePath
        addonModulePath = $ExpectedAddonPath
        reshadeBasePath = $ExpectedBasePath
    }
    foreach ($Field in $ExpectedPaths.Keys) {
        $Actual = $Record.$Field
        if ($Actual -isnot [string] -or
            [string]::IsNullOrWhiteSpace($Actual) -or
            -not [IO.Path]::IsPathRooted($Actual) -or
            -not [string]::Equals(
                [IO.Path]::GetFullPath($Actual),
                [IO.Path]::GetFullPath($ExpectedPaths[$Field]),
                [StringComparison]::OrdinalIgnoreCase
            )) {
            throw "The private participant result has a foreign or relative $Field."
        }
    }
}

function Select-UpgradeParticipantResult {
    param(
        [Parameter(Mandatory = $true)][object[]]$Results,
        [Parameter(Mandatory = $true)][int]$ExpectedPid
    )

    $TargetResults = @($Results | Where-Object { $_.Result.pid -eq $ExpectedPid })
    $Participants = @($TargetResults | Where-Object { $_.Result.runtimeMode -ceq 'participant-addon' })
    $Intermediate = @($TargetResults | Where-Object { $_.Result.runtimeMode -ceq 'official-addon' })
    if ($Participants.Count -ne 1 -or $Intermediate.Count -gt 1 -or
        $TargetResults.Count -ne (1 + $Intermediate.Count)) {
        throw 'Expected exactly one final private participant result and at most one intermediate official add-on proof for this target.'
    }
    $Participant = $Participants[0]
    if ($Participant.StdoutPath -isnot [string] -or
        -not [IO.Path]::IsPathRooted($Participant.StdoutPath)) {
        throw 'The private participant proof must originate in an absolute application stage.'
    }
    if ($Intermediate.Count -eq 1) {
        $Proof = $Intermediate[0]
        if ($TargetResults[0].Result.runtimeMode -cne 'official-addon' -or
            $Proof.StdoutPath -isnot [string] -or
            -not [IO.Path]::IsPathRooted($Proof.StdoutPath) -or
            -not [string]::Equals(
                [IO.Path]::GetFullPath($Proof.StdoutPath),
                [IO.Path]::GetFullPath($Participant.StdoutPath),
                [StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'The intermediate official proof must precede this application stage participant.'
        }
        foreach ($Field in @('targetExecutablePath', 'runtimeModulePath', 'reshadeBasePath')) {
            if ($Proof.Result.$Field -isnot [string] -or
                -not [IO.Path]::IsPathRooted($Proof.Result.$Field) -or
                -not [string]::Equals(
                    [IO.Path]::GetFullPath($Proof.Result.$Field),
                    [IO.Path]::GetFullPath($Participant.Result.$Field),
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                throw "The intermediate official proof changed target identity: $Field."
            }
        }
    }
    return [pscustomobject]@{
        Result = $Participant.Result
        StdoutPath = $Participant.StdoutPath
        IntermediateOfficialResults = $Intermediate
    }
}

function Assert-UpgradeParticipantModules {
    param(
        [Parameter(Mandatory = $true)][object[]]$Modules,
        [Parameter(Mandatory = $true)][string]$ExpectedRuntimePath,
        [Parameter(Mandatory = $true)][string]$ExpectedAdapterPath,
        [Parameter(Mandatory = $true)][string]$ExpectedParticipantPath
    )

    $ExpectedPaths = @($ExpectedRuntimePath, $ExpectedAdapterPath, $ExpectedParticipantPath) |
        ForEach-Object { [IO.Path]::GetFullPath($_) }
    if (@($ExpectedPaths | Sort-Object -Unique).Count -ne 3) {
        throw 'The official host, installed adapter and application engine must have distinct module paths.'
    }
    foreach ($ExpectedPath in $ExpectedPaths) {
        $Matches = @($Modules | Where-Object {
            $_.FileName -and [string]::Equals(
                [IO.Path]::GetFullPath($_.FileName), $ExpectedPath,
                [StringComparison]::OrdinalIgnoreCase
            )
        })
        if ($Matches.Count -ne 1) {
            throw "The upgraded target did not load exactly one expected module: $ExpectedPath"
        }
    }
    $ReShadeModules = @($Modules | Where-Object {
        $_.FileName -and (
            $_.FileVersionInfo.ProductName -ieq 'ReShade' -or
            [IO.Path]::GetFileName($_.FileName) -imatch '^ReShade(?:32|64)\.dll$' -or
            [string]::Equals(
                [IO.Path]::GetFullPath($_.FileName),
                [IO.Path]::GetFullPath($ExpectedRuntimePath),
                [StringComparison]::OrdinalIgnoreCase
            )
        )
    })
    if ($ReShadeModules.Count -ne 1) {
        throw 'The upgraded target must contain exactly one ReShade runtime, including renamed runtime modules.'
    }
    $UnexpectedEngines = @($Modules | Where-Object {
        $_.FileName -and
        [IO.Path]::GetFileName($_.FileName) -imatch '^electron_game_overlay\.addon(?:32|64)$' -and
        -not [string]::Equals(
            [IO.Path]::GetFullPath($_.FileName), [IO.Path]::GetFullPath($ExpectedAdapterPath),
            [StringComparison]::OrdinalIgnoreCase
        ) -and -not [string]::Equals(
            [IO.Path]::GetFullPath($_.FileName), [IO.Path]::GetFullPath($ExpectedParticipantPath),
            [StringComparison]::OrdinalIgnoreCase
        )
    })
    if ($UnexpectedEngines.Count -ne 0) {
        throw 'The upgraded target loaded an unexpected extra application engine.'
    }
}

function Assert-UpgradeParticipantArtifact {
    param(
        [Parameter(Mandatory = $true)][string]$StagePath,
        [Parameter(Mandatory = $true)][string]$ExpectedAddonHash,
        [Parameter(Mandatory = $true)][string]$PackageDirectory
    )

    if (-not [IO.Path]::IsPathRooted($StagePath) -or
        -not [IO.Path]::IsPathRooted($PackageDirectory) -or
        $ExpectedAddonHash -cnotmatch '^[0-9A-F]{64}$') {
        throw 'The expected private engine stage, sealed package or hash is invalid.'
    }
    $AddonPath = Join-Path $StagePath 'electron_game_overlay.addon64'
    $ManifestPath = Join-Path $StagePath 'electron_game_overlay_runtime.build.json'
    $Stamp = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    $PackageStamp = Get-Content -LiteralPath (Join-Path $PackageDirectory 'electron_game_overlay_runtime.build.json') -Raw |
        ConvertFrom-Json
    foreach ($Manifest in @($Stamp, $PackageStamp)) {
        foreach ($Field in @('schemaVersion', 'cooperativeAddonProtocol', 'injectorProcessInstanceBinding')) {
            if ($Manifest.$Field -isnot [int] -and $Manifest.$Field -isnot [long]) {
                throw "The private engine or sealed package manifest has a non-integer $Field."
            }
        }
        if ($Manifest.schemaVersion -ne 4 -or
            $Manifest.cooperativeAddonProtocol -ne 1 -or
            $Manifest.injectorProcessInstanceBinding -ne 1 -or
            $Manifest.addonBuildId -isnot [string] -or
            $Manifest.addonBuildId -cnotmatch '^[0-9A-F]{32}$' -or
            $Manifest.addonSha256 -cne $ExpectedAddonHash) {
            throw 'The private engine and sealed package must both prove schema 4, cooperative protocol 1 and exact current engine identity.'
        }
    }
    $ActualHash = (Get-FileHash -LiteralPath $AddonPath -Algorithm SHA256).Hash
    $PackageHash = (Get-FileHash -LiteralPath (Join-Path $PackageDirectory 'electron_game_overlay.addon64') -Algorithm SHA256).Hash
    if ($Stamp.addonBuildId -cne $PackageStamp.addonBuildId -or
        $ActualHash -cne $ExpectedAddonHash -or $PackageHash -cne $ExpectedAddonHash) {
        throw 'The private engine stage does not match the exact sealed package build ID and bytes.'
    }
    return [pscustomobject]@{
        AddonPath = [IO.Path]::GetFullPath($AddonPath)
        ManifestPath = [IO.Path]::GetFullPath($ManifestPath)
        AddonBuildId = $Stamp.addonBuildId
        AddonSha256 = $ActualHash
        CooperativeAddonProtocol = $Stamp.cooperativeAddonProtocol
        StagePath = [IO.Path]::GetFullPath($StagePath)
    }
}

function Get-DirectoryManifest {
    param([Parameter(Mandatory = $true)][string]$Path)

    $RootPath = [IO.Path]::GetFullPath($Path)
    if (-not $RootPath.EndsWith(
            [string][IO.Path]::DirectorySeparatorChar,
            [StringComparison]::Ordinal)) {
        $RootPath += [IO.Path]::DirectorySeparatorChar
    }

    return @(
        Get-ChildItem -LiteralPath $Path -Recurse -Force -File |
            ForEach-Object {
                $FullPath = [IO.Path]::GetFullPath($_.FullName)
                if (-not $FullPath.StartsWith(
                        $RootPath,
                        [StringComparison]::OrdinalIgnoreCase)) {
                    throw (
                        "Manifest entry escaped the controlled target " +
                        "directory: $FullPath"
                    )
                }
                [pscustomobject]@{
                    RelativePath =
                        $FullPath.Substring($RootPath.Length).Replace("\", "/")
                    Length = [int64]$_.Length
                    Sha256 = (
                        Get-FileHash `
                            -Algorithm SHA256 `
                            -LiteralPath $_.FullName
                    ).Hash
                    Attributes = [string]$_.Attributes
                    LastWriteTimeUtc = $_.LastWriteTimeUtc.ToString("o")
                }
            } |
            Sort-Object RelativePath
    )
}

function Get-SeedFileManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object[]]$SeedManifest,
        [string[]]$IgnoredRelativePaths = @()
    )

    $RootPath = [IO.Path]::GetFullPath($Path)
    if (-not $RootPath.EndsWith(
            [string][IO.Path]::DirectorySeparatorChar,
            [StringComparison]::Ordinal)) {
        $RootPath += [IO.Path]::DirectorySeparatorChar
    }
    $Ignored = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($RelativePath in $IgnoredRelativePaths) {
        [void]$Ignored.Add($RelativePath.Replace("\", "/"))
    }

    return @(
        foreach ($SeedEntry in $SeedManifest) {
            if ($Ignored.Contains($SeedEntry.RelativePath)) {
                continue
            }
            $FullPath = [IO.Path]::GetFullPath(
                (Join-Path `
                    $RootPath `
                    $SeedEntry.RelativePath.Replace(
                        "/",
                        [string][IO.Path]::DirectorySeparatorChar))
            )
            if (-not $FullPath.StartsWith(
                    $RootPath,
                    [StringComparison]::OrdinalIgnoreCase)) {
                throw (
                    "Seed manifest entry escaped the controlled target " +
                    "directory: $FullPath"
                )
            }
            if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
                continue
            }
            $File = Get-Item -LiteralPath $FullPath
            [pscustomobject]@{
                RelativePath = $SeedEntry.RelativePath
                Length = [int64]$File.Length
                Sha256 = (
                    Get-FileHash `
                        -Algorithm SHA256 `
                        -LiteralPath $FullPath
                ).Hash
                Attributes = [string]$File.Attributes
                LastWriteTimeUtc = $File.LastWriteTimeUtc.ToString("o")
            }
        }
    ) | Sort-Object RelativePath
}

function Convert-ManifestToJson {
    param([Parameter(Mandatory = $true)][object[]]$Manifest)

    return ConvertTo-Json -InputObject @($Manifest) -Depth 4 -Compress
}

function Assert-SeedFilesPreserved {
    param(
        [Parameter(Mandatory = $true)][object[]]$Expected,
        [Parameter(Mandatory = $true)][object[]]$Actual,
        [Parameter(Mandatory = $true)][string]$Boundary,
        [string[]]$IgnoredRelativePaths = @()
    )

    $Ignored = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($RelativePath in $IgnoredRelativePaths) {
        [void]$Ignored.Add($RelativePath.Replace("\", "/"))
    }
    $ExpectedPreserved = @(
        $Expected |
            Where-Object { -not $Ignored.Contains($_.RelativePath) }
    )
    $ExpectedPaths = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($Entry in $ExpectedPreserved) {
        [void]$ExpectedPaths.Add($Entry.RelativePath)
    }
    $ActualPreserved = @(
        $Actual |
            Where-Object { $ExpectedPaths.Contains($_.RelativePath) }
    )
    $ExpectedJson = Convert-ManifestToJson -Manifest $ExpectedPreserved
    $ActualJson = Convert-ManifestToJson -Manifest $ActualPreserved
    if ($ExpectedJson -cne $ActualJson) {
        throw (
            "A seeded ReShade installation file changed across " +
            "'$Boundary'. Compare the preserved manifest JSON files."
        )
    }
}

function Save-JsonEvidence {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$Depth = 8
    )

    ConvertTo-Json -InputObject $Value -Depth $Depth |
        Set-Content -LiteralPath $Path -Encoding UTF8
}

function Assert-ExactTargetProcess {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedPath
    )

    $Target = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId=$ProcessId" `
        -ErrorAction SilentlyContinue
    if ($Target -and
        [string]::Equals(
            [IO.Path]::GetFullPath($Target.ExecutablePath),
            [IO.Path]::GetFullPath($ExpectedPath),
            [StringComparison]::OrdinalIgnoreCase)) {
        return
    }
    throw (
        "Controlled target PID $ProcessId came from an unexpected " +
        "path/command: path=$($Target.ExecutablePath) " +
        "command=$($Target.CommandLine)"
    )
}

function Get-StagedInjectorPaths {
    $Paths = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    $ClientLog = Get-ClientLogText -Path $ClientStdout
    foreach ($Match in [regex]::Matches(
            $ClientLog,
            '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(.+)\r?$')) {
        try {
            $Directory = $Match.Groups[1].Value | ConvertFrom-Json
        }
        catch {
            throw (
                "A production staged-runtime marker contained invalid JSON: " +
                $Match.Groups[1].Value
            )
        }
        if (-not [IO.Path]::IsPathRooted($Directory)) {
            throw "The production client staged a non-absolute run: $Directory"
        }
        [void]$Paths.Add(
            [IO.Path]::GetFullPath((Join-Path $Directory "inject.exe"))
        )
    }
    return ,$Paths
}

function Get-StructuredInjectorResults {
    $Prefix = "ELECTRON_GAME_OVERLAY_INJECTOR_RESULT "
    return @(
        foreach ($InjectorPath in (Get-StagedInjectorPaths)) {
            $StdoutPath = Join-Path `
                ([IO.Path]::GetDirectoryName($InjectorPath)) `
                "inject.stdout.log"
            if (-not (Test-Path -LiteralPath $StdoutPath -PathType Leaf)) {
                continue
            }
            foreach ($Line in @(Get-Content -LiteralPath $StdoutPath)) {
                if (-not $Line.StartsWith(
                        $Prefix,
                        [StringComparison]::Ordinal)) {
                    continue
                }
                try {
                    $Result = $Line.Substring($Prefix.Length) |
                        ConvertFrom-Json
                }
                catch {
                    throw (
                        "A production injector returned invalid JSON in " +
                        "$StdoutPath`: $Line"
                    )
                }
                [pscustomobject]@{
                    Result = $Result
                    StdoutPath = $StdoutPath
                }
            }
        }
    )
}

function Get-ClientDescendantProcesses {
    if (-not $ClientProcess) {
        return @()
    }

    $Processes = @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    )
    $OwnedProcessIds =
        [Collections.Generic.HashSet[int]]::new()
    [void]$OwnedProcessIds.Add([int]$ClientProcess.Id)
    $Changed = $true
    while ($Changed) {
        $Changed = $false
        foreach ($Process in $Processes) {
            if ($OwnedProcessIds.Contains([int]$Process.ParentProcessId) -and
                $OwnedProcessIds.Add([int]$Process.ProcessId)) {
                $Changed = $true
            }
        }
    }

    return @(
        $Processes |
            Where-Object {
                $_.ProcessId -ne $ClientProcess.Id -and
                $OwnedProcessIds.Contains([int]$_.ProcessId)
            }
    )
}

function Get-ProcessCreationIdentity {
    param([Parameter(Mandatory = $true)]$Process)

    if ($null -eq $Process.CreationDate) {
        throw (
            "Could not read creation identity for run-owned PID " +
            "$($Process.ProcessId)."
        )
    }
    return ([DateTime]$Process.CreationDate).ToUniversalTime().ToString("o")
}

function Register-RunOwnedInjectors {
    $RuntimeObserverPath = [IO.Path]::GetFullPath(
        (Join-Path $RuntimeDistributionDirectory "inject.exe")
    )
    $StagedInjectorPaths = Get-StagedInjectorPaths
    foreach ($Process in @(Get-ClientDescendantProcesses)) {
        if ($Process.Name -ine "inject.exe") {
            continue
        }
        if (-not $Process.ExecutablePath) {
            $Current = Get-CimInstance `
                Win32_Process `
                -Filter "ProcessId=$($Process.ProcessId)" `
                -ErrorAction SilentlyContinue
            if (-not $Current -or $Current.Name -ine "inject.exe") {
                continue
            }
            if (-not $Current.ExecutablePath) {
                throw (
                    "A live run-owned injector had no readable executable " +
                    "path (PID $($Process.ProcessId))."
                )
            }
            $Process = $Current
        }

        $ExecutablePath = [IO.Path]::GetFullPath($Process.ExecutablePath)
        $CommandLine = [string]$Process.CommandLine
        $IsRuntimeObserver = [string]::Equals(
            $ExecutablePath,
            $RuntimeObserverPath,
            [StringComparison]::OrdinalIgnoreCase
        )
        $IsStagedInjector = $StagedInjectorPaths.Contains($ExecutablePath)
        if (-not $IsRuntimeObserver -and -not $IsStagedInjector) {
            $StageMarkerDeadline = [DateTime]::UtcNow.AddSeconds(1)
            while ([DateTime]::UtcNow -lt $StageMarkerDeadline) {
                Start-Sleep -Milliseconds 25
                $StagedInjectorPaths = Get-StagedInjectorPaths
                if ($StagedInjectorPaths.Contains($ExecutablePath)) {
                    $IsStagedInjector = $true
                    break
                }
                $Current = Get-CimInstance `
                    Win32_Process `
                    -Filter "ProcessId=$($Process.ProcessId)" `
                    -ErrorAction SilentlyContinue
                if (-not $Current -or $Current.Name -ine "inject.exe") {
                    break
                }
            }
        }
        if (-not $IsRuntimeObserver -and -not $IsStagedInjector) {
            $Current = Get-CimInstance `
                Win32_Process `
                -Filter "ProcessId=$($Process.ProcessId)" `
                -ErrorAction SilentlyContinue
            if (-not $Current -or $Current.Name -ine "inject.exe") {
                continue
            }
            throw (
                "A client-descendant injector used an unowned executable " +
                "path: $ExecutablePath"
            )
        }
        if ($IsRuntimeObserver) {
            if ($CommandLine.IndexOf(
                    "--observe-path-contains",
                    [StringComparison]::Ordinal) -lt 0 -or
                $CommandLine.IndexOf(
                    "--parent-pid",
                    [StringComparison]::Ordinal) -lt 0) {
                throw (
                    "The run-owned native path watcher used an unexpected " +
                    "invocation: $CommandLine"
                )
            }
            $script:ObservedPathWatcherInjector = $true
        }
        elseif ($CommandLine.IndexOf(
                "--path-contains",
                [StringComparison]::Ordinal) -lt 0 -and
            $CommandLine.IndexOf(
                "--pid",
                [StringComparison]::Ordinal) -lt 0) {
            throw (
                "A run-owned staged injector used an unexpected invocation: " +
                $CommandLine
            )
        }

        $CreationIdentity = Get-ProcessCreationIdentity -Process $Process
        $Existing = $RunOwnedInjectorRecords[[int]$Process.ProcessId]
        if ($Existing -and
            ($Existing.CreationIdentity -cne $CreationIdentity -or
                -not [string]::Equals(
                    $Existing.ExecutablePath,
                    $ExecutablePath,
                    [StringComparison]::OrdinalIgnoreCase))) {
            throw (
                "A run-owned injector PID changed identity during the gate: " +
                $Process.ProcessId
            )
        }
        $RunOwnedInjectorRecords[[int]$Process.ProcessId] =
            [pscustomobject]@{
                ProcessId = [int]$Process.ProcessId
                CreationIdentity = $CreationIdentity
                ExecutablePath = $ExecutablePath
                CommandLine = $CommandLine
                RuntimeObserver = $IsRuntimeObserver
            }
    }
}

function Get-LiveRecordedRunOwnedInjectors {
    return @(
        foreach ($Record in $RunOwnedInjectorRecords.Values) {
            $Current = Get-CimInstance `
                Win32_Process `
                -Filter "ProcessId=$($Record.ProcessId)" `
                -ErrorAction SilentlyContinue
            if (-not $Current -or
                $Current.Name -ine "inject.exe" -or
                -not $Current.ExecutablePath) {
                continue
            }
            if ((Get-ProcessCreationIdentity -Process $Current) -cne
                    $Record.CreationIdentity -or
                -not [string]::Equals(
                    [IO.Path]::GetFullPath($Current.ExecutablePath),
                    $Record.ExecutablePath,
                    [StringComparison]::OrdinalIgnoreCase)) {
                continue
            }
            $Current
        }
    )
}

function Get-LiveStagedRunInjectors {
    $StagedInjectorPaths = Get-StagedInjectorPaths
    if ($StagedInjectorPaths.Count -eq 0) {
        return @()
    }
    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name='inject.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                $StagedInjectorPaths.Contains(
                    [IO.Path]::GetFullPath($_.ExecutablePath)
                )
            }
    )
}

function Stop-OwnedProcesses {
    if ($ClientProcess) {
        $ClientProcess.Refresh()
        if (-not $ClientProcess.HasExited) {
            Register-RunOwnedInjectors
        }
    }
    if ($ClientProcess) {
        $ClientProcess.Refresh()
        if (-not $ClientProcess.HasExited) {
            Stop-Process `
                -Id $ClientProcess.Id `
                -Force `
                -ErrorAction SilentlyContinue
            Wait-Process `
                -Id $ClientProcess.Id `
                -Timeout 5 `
                -ErrorAction SilentlyContinue
        }
    }
    Stop-AttemptElectronProcesses -UserData $UserData

    $OwnedInjectors = @(
        @(
            Get-LiveRecordedRunOwnedInjectors
            Get-LiveStagedRunInjectors
        ) |
            Group-Object ProcessId |
            ForEach-Object { $_.Group[0] }
    )
    foreach ($Injector in $OwnedInjectors) {
        Stop-Process `
            -Id $Injector.ProcessId `
            -Force `
            -ErrorAction SilentlyContinue
        Wait-Process `
            -Id $Injector.ProcessId `
            -Timeout 5 `
            -ErrorAction SilentlyContinue
    }

    if ($HostProcess) {
        $HostProcess.Refresh()
        if (-not $HostProcess.HasExited) {
            Stop-Process `
                -Id $HostProcess.Id `
                -Force `
                -ErrorAction SilentlyContinue
            Wait-Process `
                -Id $HostProcess.Id `
                -Timeout 5 `
                -ErrorAction SilentlyContinue
        }
    }
}

if (-not ("ExistingReShadeUpgradeGate.NativeLibrary" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace ExistingReShadeUpgradeGate
{
    public static class NativeLibrary
    {
        private const uint DONT_RESOLVE_DLL_REFERENCES = 0x00000001;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibraryExW(
            string fileName,
            IntPtr file,
            uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FreeLibrary(IntPtr module);

        public static int ProveImageLoadable(string path)
        {
            IntPtr module = LoadLibraryExW(
                path,
                IntPtr.Zero,
                DONT_RESOLVE_DLL_REFERENCES);
            if (module == IntPtr.Zero)
            {
                return Marshal.GetLastWin32Error();
            }
            if (!FreeLibrary(module))
            {
                return Marshal.GetLastWin32Error();
            }
            return 0;
        }
    }
}
"@
}

if (-not (Test-Path -LiteralPath $OfficialRuntimePath -PathType Leaf)) {
    throw "The official ReShade runtime is unavailable: $OfficialRuntimePath"
}
$ResolvedOfficialRuntime = (
    Resolve-Path -LiteralPath $OfficialRuntimePath -ErrorAction Stop
).Path
if ([IO.Path]::GetExtension($ResolvedOfficialRuntime) -ine ".dll") {
    throw "OfficialRuntimePath must identify the official x64 ReShade DLL."
}
$OfficialSourceHash = (
    Get-FileHash `
        -Algorithm SHA256 `
        -LiteralPath $ResolvedOfficialRuntime
).Hash
if (-not (Test-Path -LiteralPath $Electron -PathType Leaf)) {
    throw "Electron is unavailable: $Electron"
}
if (-not (Test-Path -LiteralPath $Nx -PathType Leaf)) {
    throw "The local Nx CLI is unavailable: $Nx"
}

$ExistingHosts = Get-MatchingHosts
$ExistingClients = Get-MatchingClientProcesses
if ($ExistingHosts.Count -ne 0 -or
    $ExistingClients.Count -ne 0) {
    $ProcessIds = @(
        @($ExistingHosts.ProcessId) +
            @($ExistingClients.ProcessId) |
            Where-Object { $null -ne $_ }
    )
    throw (
        "Close the existing controlled host/ReShade client run before this " +
        "test (PID: $($ProcessIds -join ', '))."
    )
}

if (-not $SkipBuild) {
    & $Nx run client:build
    if ($LASTEXITCODE -ne 0) {
        throw "The production client/SDK build failed with exit code $LASTEXITCODE."
    }

    Push-Location $RuntimeRoot
    try {
        & cmake.exe --preset vs2022-x64-production
        if ($LASTEXITCODE -ne 0) {
            throw "CMake configure failed with exit code $LASTEXITCODE."
        }
        & cmake.exe --build $ProductionBuildRoot `
            --config RelWithDebInfo `
            --target $HostTarget `
            --parallel
        if ($LASTEXITCODE -ne 0) {
            throw (
                "The controlled D3D11 host build failed with exit code " +
                "$LASTEXITCODE."
            )
        }
    }
    finally {
        Pop-Location
    }
}

foreach ($RequiredArtifact in @(
        $BuiltHost,
        $AddonManagerPath,
        $ProductionAddonPath,
        (Join-Path $RuntimeDistributionDirectory "inject.exe"),
        (Join-Path $RuntimeDistributionDirectory "inject32.exe"),
        (Join-Path $RuntimeDistributionDirectory "ReShade64.dll"),
        (Join-Path $RuntimeDistributionDirectory "ReShade32.dll"),
        (Join-Path $RuntimeDistributionDirectory "ReShade64.build.json"),
        (Join-Path $RuntimeDistributionDirectory "ReShade32.build.json"),
        (Join-Path $RuntimeDistributionDirectory "electron_game_overlay.addon32"),
        (Join-Path $RuntimeDistributionDirectory "electron_game_overlay_reshade_manager32.exe"),
        (Join-Path `
            $RuntimeDistributionDirectory `
            "electron_game_overlay_runtime.build.json"),
        (Join-Path `
            $RuntimeDistributionDirectory `
            "electron_game_overlay_runtime32.build.json"),
        (Join-Path $RuntimeDistributionDirectory "ReShade.ini"))) {
    if (-not (Test-Path -LiteralPath $RequiredArtifact -PathType Leaf)) {
        throw "A required production gate artifact is unavailable: $RequiredArtifact"
    }
}

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $AddonDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $EffectDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $TextureDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $UserData -Force | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination $TargetExecutablePath
Copy-Item `
    -LiteralPath $ResolvedOfficialRuntime `
    -Destination $ReShadeModulePath
New-Item -ItemType File -Path $StartupBarrierPath -Force | Out-Null
New-Item -ItemType File -Path $InputGateMarkerPath -Force | Out-Null

@"
[INSTALL]
BasePath=.

[ADDON]
AddonPath=.\existing-addons
DisabledAddons=Foreign Canary@foreign-canary.addon64

[GENERAL]
EffectSearchPaths=.\existing-effects
IntermediateCachePath=.\cache
NoDebugInfo=1
PerformanceMode=0
PresetPath=.\ReShadePreset.ini
TextureSearchPaths=.\existing-textures

[INPUT]
InputProcessing=2

[OVERLAY]
ShowFPS=0
TutorialProgress=4
"@ | Set-Content -LiteralPath $ReShadeConfigurationPath -Encoding UTF8

@"
[GENERAL]
PreprocessorDefinitions=
Techniques=
TechniqueSorting=
"@ | Set-Content -LiteralPath $ReShadePresetPath -Encoding UTF8

@"
Foreign add-on canary owned by the modeled existing ReShade installation.
"@ | Set-Content `
    -LiteralPath (Join-Path $AddonDirectory "foreign-canary.addon64") `
    -Encoding UTF8
@"
Existing ReShade effect canary. Electron Game Overlay must preserve it.
"@ | Set-Content `
    -LiteralPath (Join-Path $EffectDirectory "existing-canary.fx") `
    -Encoding UTF8
$OnePixelPng = [Convert]::FromBase64String(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
[IO.File]::WriteAllBytes(
    (Join-Path $TextureDirectory "existing-canary.png"),
    $OnePixelPng
)
@"
Existing ReShade installation canary. Only reserved project artifacts may move.
"@ | Set-Content `
    -LiteralPath (Join-Path $TargetDirectory "existing-canary.txt") `
    -Encoding UTF8

# Stock ReShade serializes normalized defaults on shutdown. Make only its
# pre-existing configuration and preset immutable so the gate isolates project
# writes while every other installation canary remains writable.
Set-ItemProperty `
    -LiteralPath $ReShadeConfigurationPath `
    -Name IsReadOnly `
    -Value $true
Set-ItemProperty `
    -LiteralPath $ReShadePresetPath `
    -Name IsReadOnly `
    -Value $true

$CopiedOfficialHash = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $ReShadeModulePath
).Hash
if ($CopiedOfficialHash -cne $OfficialSourceHash) {
    throw "The target-local official ReShade seed copy changed."
}
$ProductionAddonHash = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $ProductionAddonPath
).Hash
$ManagerOutput = @(
    & $AddonManagerPath `
        prepare `
        --directory $AddonDirectory `
        --source $ProductionAddonPath `
        --source-sha256 $ProductionAddonHash `
        --reshade-module $ReShadeModulePath `
        --reshade-module-sha256 $CopiedOfficialHash
)
$ManagerExitCode = $LASTEXITCODE
if ($ManagerExitCode -ne 0 -or $ManagerOutput.Count -ne 1) {
    throw (
        "The packaged native manager could not seed the owned add-on " +
        "(exit $ManagerExitCode): " +
        ($ManagerOutput -join "`n")
    )
}
try {
    $ManagerResult = $ManagerOutput[0] | ConvertFrom-Json
}
catch {
    throw "The packaged native manager returned invalid JSON: $ManagerOutput"
}
if ($ManagerResult.schemaVersion -ne 1 -or
    $ManagerResult.kind -cne
        "electron-game-overlay-reshade-addon-manager-result" -or
    $ManagerResult.operation -cne "prepare" -or
    $ManagerResult.status -cne "installed" -or
    $ManagerResult.addonSha256 -cne $ProductionAddonHash -or
    $ManagerResult.reshadeModuleSha256 -cne $CopiedOfficialHash -or
    -not ([string]$ManagerResult.addonPath).Equals(
        [IO.Path]::GetFullPath($OwnedAddonPath),
        [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not ([string]$ManagerResult.markerPath).Equals(
        [IO.Path]::GetFullPath($OwnershipMarkerPath),
        [StringComparison]::OrdinalIgnoreCase
    )) {
    throw (
        "The packaged native manager returned an unexpected seed contract: " +
        ($ManagerResult | ConvertTo-Json -Compress)
    )
}

# A trailing PE overlay byte changes the recognized runtime hash without
# changing headers, sections, imports, exports, or the mapped image. Prove the
# resulting x64 DLL is still accepted by the Windows image loader without
# running its entry point.
$RuntimeStream = [IO.File]::Open(
    $ReShadeModulePath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Write,
    [IO.FileShare]::Read
)
try {
    [void]$RuntimeStream.Seek(0, [IO.SeekOrigin]::End)
    $RuntimeStream.WriteByte(0)
    $RuntimeStream.Flush($true)
}
finally {
    $RuntimeStream.Dispose()
}
$UpgradedRuntimeHash = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $ReShadeModulePath
).Hash
if ($UpgradedRuntimeHash -ceq $CopiedOfficialHash) {
    throw "The benign PE overlay byte did not change the runtime hash."
}
$LoadProofError =
    [ExistingReShadeUpgradeGate.NativeLibrary]::ProveImageLoadable(
        $ReShadeModulePath
    )
if ($LoadProofError -ne 0) {
    throw (
        "The benign hash-modified ReShade x64 image was not loadable " +
        "(Win32 error $LoadProofError)."
    )
}

$SeedManifest = Get-DirectoryManifest -Path $TargetDirectory
$SeedManifestPath = Join-Path $RunDirectory "seed-manifest.json"
Save-JsonEvidence -Value $SeedManifest -Path $SeedManifestPath
$SeedAddonHash = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $OwnedAddonPath
).Hash
$SeedMarkerHash = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $OwnershipMarkerPath
).Hash
if ($SeedAddonHash -cne $ProductionAddonHash) {
    throw "The seeded manager-owned add-on changed before target launch."
}

Write-Host ""
Write-Host "Production Steam auto-attach existing ReShade upgrade gate"
Write-Host "  - Version-agnostic ReShade seed: $ResolvedOfficialRuntime"
Write-Host "  - Isolated Steam target: $TargetExecutablePath"
Write-Host "  - The manager-owned add-on is seeded before the runtime identity changes."
Write-Host "  - A benign PE overlay byte models a still-loadable ReShade upgrade."
Write-Host "  - The production watcher must load its private participant through the existing official host."
Write-Host "  - The owned add-on, marker, and every seeded file must be preserved."
Write-Host "  - Evidence is preserved in: $RunDirectory"
Write-Host ""

$ControlledEnvironmentVariables = @(
    "ELECTRON_GAME_OVERLAY_RUN_DIRECTORY",
    "RESHADE_BASE_PATH_OVERRIDE",
    "RESHADE_DISABLE_GRAPHICS_HOOK",
    "RESHADE_DISABLE_INPUT_HOOK",
    "RESHADE_DISABLE_LOGGING"
)
$PreviousEnvironment = @{}
foreach ($VariableName in $ControlledEnvironmentVariables) {
    $PreviousEnvironment[$VariableName] =
        Get-OverlayProcessEnvironmentVariable -Name $VariableName
    Set-OverlayProcessEnvironmentVariable -Name $VariableName -Value $null
}

try {
    $ClientArguments = @(
        "`"$RepoRoot`"",
        "--no-sandbox",
        "--reshade-overlay",
        "`"--reshade-runtime-dir=$RuntimeDistributionDirectory`"",
        "--steam-auto-attach",
        "--demo-presentation",
        "`"--user-data-dir=$UserData`""
    )
    $ClientProcess = Start-Process `
        -FilePath $Electron `
        -ArgumentList $ClientArguments `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $ClientStdout `
        -RedirectStandardError $ClientStderr

    $StartupDeadline = [DateTime]::UtcNow.AddSeconds(120)
    [void](Wait-ForLogRegex `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^RESHADE_CLIENT_CONFIGURED(?: .*)?\r?$' `
            -Deadline $StartupDeadline)
    [void](Wait-ForLogRegex `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^STEAM_GAME_PROCESS_WATCHER_READY(?: .*)?\r?$' `
            -Deadline $StartupDeadline)
    [void](Wait-ForLogRegex `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^STEAM_GAME_AUTO_ATTACH_ARMING(?: .*)?\r?$' `
            -Deadline $StartupDeadline)
    $PrearmedWatcherReady = Wait-ForLogRegex `
            -Path $ClientStdout `
            -Process $ClientProcess `
            -Pattern '(?m)^RESHADE_CLIENT_INJECTOR_WATCHER_READY(?: .*)?\r?$' `
            -Deadline $StartupDeadline
    Register-RunOwnedInjectors
    if (-not $ObservedPathWatcherInjector) {
        throw (
            "The production Steam watcher reached ready without a " +
            "client-descendant native path-watcher injector."
        )
    }

    $HostProcess = Start-Process `
        -FilePath $TargetExecutablePath `
        -WorkingDirectory $TargetDirectory `
        -PassThru
    $HostPid = $HostProcess.Id
    $HostCreationTime100ns = $HostProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(
        [Globalization.CultureInfo]::InvariantCulture)
    Assert-ExactTargetProcess `
        -ProcessId $HostPid `
        -ExpectedPath $TargetExecutablePath

    $TargetPathJson = ConvertTo-Json `
        -InputObject ([IO.Path]::GetFullPath($TargetExecutablePath)) `
        -Compress
    $EscapedTargetPathJson = [regex]::Escape($TargetPathJson)
    $TargetDescriptionJson = ConvertTo-Json `
        -InputObject ([IO.Path]::GetFullPath($TargetExecutablePath)) `
        -Compress
    $EscapedTargetDescriptionJson =
        [regex]::Escape($TargetDescriptionJson)
    $BoundTargetIdentity = @{
        ExecutablePath = $TargetExecutablePath
        ProcessId = $HostPid
        CreationTime100ns = $HostCreationTime100ns
    }
    $InitialInjectorArgumentsJson = ConvertTo-Json `
        -InputObject @(Get-UpgradeBoundArguments @BoundTargetIdentity -Phase initial) `
        -Compress
    $EscapedInitialInjectorArgumentsJson =
        [regex]::Escape($InitialInjectorArgumentsJson)
    $AddonWaitArgumentsJson = ConvertTo-Json `
        -InputObject @(Get-UpgradeBoundArguments @BoundTargetIdentity -Phase official-wait) `
        -Compress
    $EscapedAddonWaitArgumentsJson =
        [regex]::Escape($AddonWaitArgumentsJson)
    $ParticipantArgumentsJson = ConvertTo-Json `
        -InputObject @(Get-UpgradeBoundArguments @BoundTargetIdentity -Phase participant) `
        -Compress
    $EscapedParticipantArgumentsJson = [regex]::Escape($ParticipantArgumentsJson)

    $ExpectedRuntimePath = [IO.Path]::GetFullPath($ReShadeModulePath)
    $ExpectedAddonPath = [IO.Path]::GetFullPath($OwnedAddonPath)
    $RuntimeLoadDeadline = [DateTime]::UtcNow.AddSeconds(15)
    $LoadedRuntimeBeforeRelease = @()
    $LoadedAddonBeforeRelease = @()
    while ([DateTime]::UtcNow -lt $RuntimeLoadDeadline) {
        $LoadedBeforeRelease = @(
            ([Diagnostics.Process]::GetProcessById($HostPid)).Modules
        )
        $LoadedRuntimeBeforeRelease = @(
            $LoadedBeforeRelease |
                Where-Object {
                    $_.FileName -and
                    [string]::Equals(
                        [IO.Path]::GetFullPath($_.FileName),
                        $ExpectedRuntimePath,
                        [StringComparison]::OrdinalIgnoreCase)
                }
        )
        $LoadedAddonBeforeRelease = @(
            $LoadedBeforeRelease |
                Where-Object {
                    $_.FileName -and
                    [string]::Equals(
                        [IO.Path]::GetFullPath($_.FileName),
                        $ExpectedAddonPath,
                        [StringComparison]::OrdinalIgnoreCase)
                }
        )
        if ($LoadedRuntimeBeforeRelease.Count -eq 1) {
            break
        }
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) {
            throw (
                "The controlled target exited before loading the upgraded " +
                "ReShade proxy."
            )
        }
        Start-Sleep -Milliseconds 10
    }
    if ($LoadedRuntimeBeforeRelease.Count -ne 1) {
        throw (
            "The controlled target did not load the upgraded ReShade proxy " +
            "behind its startup barrier: $ExpectedRuntimePath"
        )
    }
    if ($LoadedAddonBeforeRelease.Count -ne 0) {
        throw "The managed ReShade add-on loaded before graphics startup."
    }

    $Detected = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern (
            "(?m)^STEAM_GAME_AUTO_ATTACH_DETECTED pid=$HostPid " +
            "path=$EscapedTargetPathJson\r?`$"
        ) `
        -Deadline $StartupDeadline
    $InjectorStarted = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern (
            "(?m)^RESHADE_CLIENT_INJECTOR_STARTED " +
            "target=$EscapedTargetDescriptionJson " +
            "arguments=$EscapedInitialInjectorArgumentsJson\r?`$|" +
            "(?m)^STEAM_GAME_AUTO_ATTACH_EXACT_COORDINATED pid=$HostPid " +
            "creationTime100ns=$HostCreationTime100ns code=prearmed-target-selected\r?`$"
        ) `
        -Deadline $StartupDeadline
    $PrearmedTargetSelected = $InjectorStarted.Value.StartsWith(
        'STEAM_GAME_AUTO_ATTACH_EXACT_COORDINATED ', [StringComparison]::Ordinal)
    $AddonWaitStarted = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern (
            "(?m)^RESHADE_CLIENT_INJECTOR_STARTED " +
            "target=$EscapedTargetDescriptionJson " +
            "arguments=$EscapedAddonWaitArgumentsJson\r?`$"
        ) `
        -Deadline $StartupDeadline
    if (-not $PrearmedTargetSelected) {
        $ActualInitialArguments = [regex]::Match($InjectorStarted.Value,
            ' arguments=(?<arguments>\[[^\r\n]+\])').Groups['arguments'].Value | ConvertFrom-Json
        Assert-UpgradeBoundArguments -Arguments $ActualInitialArguments @BoundTargetIdentity -Phase initial
    }
    $ActualWaitArguments = [regex]::Match($AddonWaitStarted.Value,
        ' arguments=(?<arguments>\[[^\r\n]+\])').Groups['arguments'].Value | ConvertFrom-Json
    Assert-UpgradeBoundArguments -Arguments $ActualWaitArguments @BoundTargetIdentity -Phase official-wait
    $PrearmedSelectionEvidencePath = $null
    $PrearmedSelectionStdoutPath = $null
    if ($PrearmedTargetSelected) {
        # The SDK writes this completed selection before starting official wait,
        # then replaces its stdout file with later phase output. Preserve it now.
        $SelectionEvidence = @(
            foreach ($InjectorPath in (Get-StagedInjectorPaths)) {
                $OutputPath = Join-Path ([IO.Path]::GetDirectoryName($InjectorPath)) 'inject.stdout.log'
                if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) { continue }
                $Output = Get-Content -Raw -LiteralPath $OutputPath
                if ($Output -notmatch "(?m)^EGO_TARGET_SELECTED_V2\t$HostPid\t$HostCreationTime100ns\t") { continue }
                Assert-UpgradePrearmedSelection -InjectorOutput $Output @BoundTargetIdentity
                [pscustomobject]@{Path=$OutputPath;Text=$Output}
            }
        )
        if ($SelectionEvidence.Count -ne 1) {
            throw 'The pending official wait did not retain exactly one own-stage native selection proof.'
        }
        $PrearmedSelectionStdoutPath = [IO.Path]::GetFullPath($SelectionEvidence[0].Path)
        $PrearmedSelectionEvidencePath = Join-Path $RunDirectory 'prearmed-selected-identity.stdout.log'
        Set-Content -LiteralPath $PrearmedSelectionEvidencePath -Value $SelectionEvidence[0].Text -Encoding UTF8
    }

    Register-RunOwnedInjectors
    Assert-ExactTargetProcess `
        -ProcessId $HostPid `
        -ExpectedPath $TargetExecutablePath
    $HostProcess.Refresh()
    if ($HostProcess.HasExited) {
        throw "The controlled target exited before startup-barrier release."
    }
    if (-not (Test-Path -LiteralPath $StartupBarrierPath -PathType Leaf)) {
        throw "The target startup barrier was released before the gate requested it."
    }
    if (-not (Test-Path -LiteralPath $OwnedAddonPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $OwnershipMarkerPath -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $OwnedAddonPath).Hash -cne
            $SeedAddonHash -or
        (Get-FileHash `
            -Algorithm SHA256 `
            -LiteralPath $OwnershipMarkerPath).Hash -cne $SeedMarkerHash) {
        throw "Owned artifacts changed while the exact target PID was live."
    }
    if (Test-Path -LiteralPath $TransactionPath) {
        throw "Version-agnostic live-target inspection created a transaction journal."
    }

    $PreReleaseClientLog = Get-ClientLogText -Path $ClientStdout
    $PreReleaseClientLogBoundaryIndex = $PreReleaseClientLog.Length - 1
    if ([regex]::IsMatch(
            $PreReleaseClientLog,
            "(?m)^RESHADE_CLIENT_INJECTOR_RETURNED(?: .*)?\r?`$") -or
        [regex]::IsMatch(
            $PreReleaseClientLog,
            "(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=$HostPid\r?`$") -or
        [regex]::IsMatch(
            $PreReleaseClientLog,
            "(?m)^STEAM_GAME_AUTO_ATTACH_CONNECTED pid=$HostPid(?: .*)?\r?`$")) {
        throw "The target connected before its startup barrier was released."
    }
    Assert-NoTargetFailureOrMaintenance `
        -ProcessId $HostPid `
        -TargetDescriptionJson $TargetDescriptionJson

    $PreReleaseManifest = Get-SeedFileManifest `
        -Path $TargetDirectory `
        -SeedManifest $SeedManifest
    $PreReleaseManifestPath =
        Join-Path $RunDirectory "pre-release-manifest.json"
    Save-JsonEvidence -Value $PreReleaseManifest -Path $PreReleaseManifestPath
    Assert-SeedFilesPreserved `
        -Expected $SeedManifest `
        -Actual $PreReleaseManifest `
        -Boundary "loaded runtime and pending official add-on startup"

    Remove-Item -LiteralPath $StartupBarrierPath -Force
    $HostWindow = Wait-ForHostWindow `
        -HostProcess $HostProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(30))
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow(
            $HostWindow)) {
        throw "Could not foreground the controlled D3D11 host for normal exit."
    }
    $AttachDeadline = [DateTime]::UtcNow.AddSeconds(45)
    $ParticipantStarted = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern (
            "(?m)^RESHADE_CLIENT_INJECTOR_STARTED " +
            "target=$EscapedTargetDescriptionJson " +
            "arguments=$EscapedParticipantArgumentsJson\r?`$"
        ) `
        -Deadline $AttachDeadline
    $ActualParticipantArguments = [regex]::Match($ParticipantStarted.Value,
        ' arguments=(?<arguments>\[[^\r\n]+\])').Groups['arguments'].Value | ConvertFrom-Json
    Assert-UpgradeBoundArguments -Arguments $ActualParticipantArguments @BoundTargetIdentity -Phase participant
    $InjectorReturned = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern (
            "(?m)^RESHADE_CLIENT_INJECTOR_RETURNED " +
            "target=$([regex]::Escape((ConvertTo-Json -InputObject $HostName -Compress)))\r?`$"
        ) `
        -Deadline $AttachDeadline
    $Connected = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=$HostPid\r?`$" `
        -Deadline $AttachDeadline
    $AutoConnected = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern (
            "(?m)^STEAM_GAME_AUTO_ATTACH_CONNECTED pid=$HostPid " +
            "processName=$([regex]::Escape((ConvertTo-Json -InputObject $HostName -Compress)))\r?`$"
        ) `
        -Deadline $AttachDeadline
    Assert-UpgradeLifecycleOrder `
        -WatcherReadyIndex $PrearmedWatcherReady.Index `
        -DetectedIndex $Detected.Index `
        -InitialIndex $InjectorStarted.Index `
        -OfficialWaitIndex $AddonWaitStarted.Index `
        -ReleaseBoundaryIndex $PreReleaseClientLogBoundaryIndex `
        -ParticipantIndex $ParticipantStarted.Index `
        -ReturnedIndex $InjectorReturned.Index `
        -ConnectedIndex $Connected.Index `
        -AutoConnectedIndex $AutoConnected.Index `
        -Prearmed $PrearmedTargetSelected

    $ParticipantResult = Select-UpgradeParticipantResult `
        -Results @(Get-StructuredInjectorResults) -ExpectedPid $HostPid
    # Retain the final proof wrapper for summary/log evidence. An optional
    # read-only official proof is only a phase leading to this private engine.
    $TargetInjectorResults = @($ParticipantResult)
    $IntermediateOfficialResults = @($ParticipantResult.IntermediateOfficialResults)
    $InjectorResult = $ParticipantResult.Result
    $ParticipantStage = [IO.Path]::GetDirectoryName($ParticipantResult.StdoutPath)
    $ParticipantArtifact = Assert-UpgradeParticipantArtifact -StagePath $ParticipantStage `
        -ExpectedAddonHash $ProductionAddonHash -PackageDirectory $RuntimeDistributionDirectory
    if ($PrearmedTargetSelected) {
        if (-not [string]::Equals($PrearmedSelectionStdoutPath,
                [IO.Path]::GetFullPath($ParticipantResult.StdoutPath), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The final private participant changed the prearmed native selection stage.'
        }
        Assert-UpgradePrearmedSelection `
            -InjectorOutput (Get-Content -Raw -LiteralPath $PrearmedSelectionEvidencePath) `
            @BoundTargetIdentity
    }
    Assert-UpgradeParticipantResult -Record $InjectorResult `
        -ExpectedPid $HostPid -ExpectedExecutablePath $TargetExecutablePath `
        -ExpectedRuntimePath $ExpectedRuntimePath -ExpectedAddonPath $ParticipantArtifact.AddonPath `
        -ExpectedBasePath $TargetDirectory
    foreach ($Intermediate in $IntermediateOfficialResults) {
        if ($Intermediate.Result.schemaVersion -ne 1 -or
            $Intermediate.Result.addonAbi -ne 1 -or
            $Intermediate.Result.electronGameOverlayAddonDisabled -ne $false -or
            -not [string]::Equals(
                [IO.Path]::GetFullPath($Intermediate.Result.addonModulePath),
                $ExpectedAddonPath, [StringComparison]::OrdinalIgnoreCase
            ) -or -not [string]::Equals(
                [IO.Path]::GetFullPath($Intermediate.Result.addonDirectoryPath),
                [IO.Path]::GetFullPath($AddonDirectory), [StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'The intermediate official proof did not identify the preserved installed adapter.'
        }
    }

    $LoadedAfterConnection = @(
        ([Diagnostics.Process]::GetProcessById($HostPid)).Modules
    )
    Assert-UpgradeParticipantModules -Modules $LoadedAfterConnection `
        -ExpectedRuntimePath $ExpectedRuntimePath -ExpectedAdapterPath $ExpectedAddonPath `
        -ExpectedParticipantPath $ParticipantArtifact.AddonPath
    Save-JsonEvidence -Value @($LoadedAfterConnection | ForEach-Object {
        [pscustomobject]@{FileName=$_.FileName;ProductName=$_.FileVersionInfo.ProductName}
    }) -Path (Join-Path $RunDirectory 'connected-modules.json')

    Register-RunOwnedInjectors
    Assert-ExactTargetProcess `
        -ProcessId $HostPid `
        -ExpectedPath $TargetExecutablePath
    $HostProcess.Refresh()
    if ($HostProcess.HasExited -or
        -not (Test-Path -LiteralPath $OwnedAddonPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $OwnershipMarkerPath -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $OwnedAddonPath).Hash -cne
            $SeedAddonHash -or
        (Get-FileHash `
            -Algorithm SHA256 `
            -LiteralPath $OwnershipMarkerPath).Hash -cne $SeedMarkerHash) {
        throw "The connected target or its managed add-on pair changed."
    }
    if (Test-Path -LiteralPath $TransactionPath) {
        throw "Official-add-on attachment created a transaction journal."
    }
    Assert-NoTargetFailureOrMaintenance `
        -ProcessId $HostPid `
        -TargetDescriptionJson $TargetDescriptionJson

    $ConnectedManifest = Get-SeedFileManifest `
        -Path $TargetDirectory `
        -SeedManifest $SeedManifest `
        -IgnoredRelativePaths @($StartupBarrierFileName)
    $ConnectedManifestPath =
        Join-Path $RunDirectory "connected-manifest.json"
    Save-JsonEvidence -Value $ConnectedManifest -Path $ConnectedManifestPath
    Assert-SeedFilesPreserved `
        -Expected $SeedManifest `
        -Actual $ConnectedManifest `
        -Boundary "official-add-on attachment" `
        -IgnoredRelativePaths @($StartupBarrierFileName)

    [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
    if (-not $HostProcess.WaitForExit(10000)) {
        throw "The controlled D3D11 host did not exit normally."
    }
    $HostProcess.WaitForExit()
    $HostProcess.Refresh()
    if ($HostProcess.ExitCode -ne 0) {
        throw "The controlled host exited with code $($HostProcess.ExitCode)."
    }
    $HostExitedNormally = $true

    $ReleaseDeadline = [DateTime]::UtcNow.AddSeconds(30)
    $Released = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^STEAM_GAME_AUTO_ATTACH_RELEASED pid=$HostPid\r?`$" `
        -Deadline $ReleaseDeadline
    if ($AutoConnected.Index -ge $Released.Index) {
        throw "The production watcher released the target before connecting it."
    }
    Start-Sleep -Milliseconds 750
    Assert-NoTargetFailureOrMaintenance `
        -ProcessId $HostPid `
        -TargetDescriptionJson $TargetDescriptionJson

    if (-not (Test-Path -LiteralPath $OwnedAddonPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $OwnershipMarkerPath -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $OwnedAddonPath).Hash -cne
            $SeedAddonHash -or
        (Get-FileHash `
            -Algorithm SHA256 `
            -LiteralPath $OwnershipMarkerPath).Hash -cne $SeedMarkerHash) {
        throw "Normal target exit removed or modified the managed add-on pair."
    }
    if (Test-Path -LiteralPath $TransactionPath) {
        throw "Normal target exit left a transaction journal."
    }
    $FinalManifest = Get-DirectoryManifest -Path $TargetDirectory
    $FinalManifestPath = Join-Path $RunDirectory "final-manifest.json"
    Save-JsonEvidence -Value $FinalManifest -Path $FinalManifestPath
    Assert-SeedFilesPreserved `
        -Expected $SeedManifest `
        -Actual $FinalManifest `
        -Boundary "normal target exit" `
        -IgnoredRelativePaths @($StartupBarrierFileName)

    $FinalRuntimeHash = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $ReShadeModulePath
    ).Hash
    if ($FinalRuntimeHash -cne $UpgradedRuntimeHash) {
        throw "Official-add-on attachment modified the upgraded ReShade runtime."
    }
    $FinalSourceHash = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $ResolvedOfficialRuntime
    ).Hash
    if ($FinalSourceHash -cne $OfficialSourceHash) {
        throw "The gate modified its source ReShade runtime."
    }

    $Summary = [pscustomobject]@{
        Result = $ResultMarker
        Backend = "d3d11"
        Case = "steam-watcher-version-agnostic-reshade-upgrade-coexistence"
        TargetProcessId = $HostPid
        TargetCreationTime100ns = $HostCreationTime100ns
        TargetExecutablePath = $TargetExecutablePath
        Runtime = [pscustomobject]@{
            SourcePath = $ResolvedOfficialRuntime
            SourceSha256 = $OfficialSourceHash
            TargetPath = $ReShadeModulePath
            SeedSha256 = $CopiedOfficialHash
            UpgradedSha256 = $UpgradedRuntimeHash
            WindowsImageLoadableAfterHashChange = $true
            LoadedThroughExistingProxy = $true
            SourcePreserved = $true
        }
        OwnedArtifacts = [pscustomobject]@{
            AddonPath = $OwnedAddonPath
            SeedAddonSha256 = $SeedAddonHash
            MarkerPath = $OwnershipMarkerPath
            SeedMarkerSha256 = $SeedMarkerHash
            PresentWhileTargetLive = $true
            PresentAfterObservedExit = $true
            TransactionJournalCreated = $false
        }
        ProductionLifecycle = [pscustomobject]@{
            InitialMode = if ($PrearmedTargetSelected) { 'prearmed-native-selection' } else { 'instance-bound-exact' }
            InitialArguments = if ($PrearmedTargetSelected) { $null } else { $ActualInitialArguments }
            PrearmedSelectionEvidence = $PrearmedSelectionEvidencePath
            OfficialWaitArguments = $ActualWaitArguments
            ParticipantArguments = $ActualParticipantArguments
            WatcherDetectedMarkerIndex = $Detected.Index
            InjectorStartedMarkerIndex = $InjectorStarted.Index
            AddonWaitStartedMarkerIndex = $AddonWaitStarted.Index
            StartupReleaseLogBoundaryIndex = $PreReleaseClientLogBoundaryIndex
            ParticipantStartedMarkerIndex = $ParticipantStarted.Index
            InjectorReturnedMarkerIndex = $InjectorReturned.Index
            TargetConnectedMarkerIndex = $Connected.Index
            AutoAttachConnectedMarkerIndex = $AutoConnected.Index
            WatcherReleasedMarkerIndex = $Released.Index
            RuntimeMode = [string]$InjectorResult.runtimeMode
            PrivateParticipant = $ParticipantArtifact
            ConnectedModuleEvidence = Join-Path $RunDirectory 'connected-modules.json'
            InjectorStdout = $TargetInjectorResults[0].StdoutPath
            DeferredMaintenanceEmitted = $false
            HostExitCode = $HostProcess.ExitCode
        }
        PreservationEvidence = [pscustomobject]@{
            SeedManifest = $SeedManifestPath
            PreReleaseManifest = $PreReleaseManifestPath
            ConnectedManifest = $ConnectedManifestPath
            FinalManifest = $FinalManifestPath
            SeedFilesByteAttributeTimeIdentical = $true
            OnlyIgnoredSeedFile = $StartupBarrierFileName
        }
        ClientProcessId = $ClientProcess.Id
        ClientArguments = $ClientArguments
        ClientStdout = $ClientStdout
        ClientStderr = $ClientStderr
    }
}
finally {
    try {
        Stop-OwnedProcesses
    }
    finally {
        foreach ($VariableName in $ControlledEnvironmentVariables) {
            Set-OverlayProcessEnvironmentVariable -Name $VariableName -Value $PreviousEnvironment[$VariableName]
        }
    }
}

Start-Sleep -Milliseconds 750
$RemainingElectron = @(
    Get-CimInstance `
        Win32_Process `
        -Filter "Name='electron.exe'" `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$UserData*" }
)
$RemainingHost = @()
if ($HostProcess) {
    $RemainingHost = @(
        Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId=$($HostProcess.Id)" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                [string]::Equals(
                    $_.ExecutablePath,
                    $TargetExecutablePath,
                    [StringComparison]::OrdinalIgnoreCase)
            }
    )
}
$RemainingInjectors = @(
    @(
        Get-LiveRecordedRunOwnedInjectors
        Get-LiveStagedRunInjectors
    ) |
        Group-Object ProcessId |
        ForEach-Object { $_.Group[0] }
)
if ($RemainingElectron.Count -ne 0 -or
    $RemainingHost.Count -ne 0 -or
    $RemainingInjectors.Count -ne 0) {
    $ProcessIds = @(
        @($RemainingElectron.ProcessId) +
            @($RemainingHost.ProcessId) +
            @($RemainingInjectors.ProcessId) |
            Where-Object { $null -ne $_ }
    )
    throw (
        "The existing-ReShade upgrade gate left a scoped " +
        "client/host/injector process " +
        "behind (PID: $($ProcessIds -join ', '))."
    )
}
if (-not $HostExitedNormally -or -not $Summary) {
    throw (
        "The existing-ReShade upgrade gate did not complete its " +
        "normal-exit proof."
    )
}

Save-JsonEvidence `
    -Value $Summary `
    -Path (Join-Path $RunDirectory "summary.json")
$ResultMarker |
    Set-Content `
        -LiteralPath (Join-Path $RunDirectory "result.txt") `
        -Encoding UTF8
Write-Host $ResultMarker
Write-Host "Evidence preserved in: $RunDirectory"
