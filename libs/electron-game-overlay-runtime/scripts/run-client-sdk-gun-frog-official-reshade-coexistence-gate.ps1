[CmdletBinding()]
param(
    [string]$OfficialRuntimePath,
    [ValidateRange(60, 900)]
    [int]$InteractionTimeoutSeconds = 600,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $RuntimeRoot "..\..")).Path
$BuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
$Electron = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
$Nx = Join-Path $RepoRoot "node_modules\.bin\nx.cmd"
$TargetExecutableName = "Gun Frog.exe"
$TargetExecutablePath =
    "C:\Program Files (x86)\Steam\steamapps\common\Gun Frog\Gun Frog.exe"
$TargetDirectory = Split-Path -Parent $TargetExecutablePath
$LaunchUri = "steam://rungameid/3173130"
$TestRootLeaf = ".electron-game-overlay-official-reshade-coexistence-test"
$TargetTestRoot = Join-Path $TargetDirectory $TestRootLeaf
$TargetRuntimePath = Join-Path $TargetDirectory "dxgi.dll"
$TargetBootstrapConfigurationPath =
    Join-Path $TargetDirectory "ReShade.ini"
$TargetConfigurationPath = Join-Path $TargetTestRoot "ReShade.ini"
$TargetLogPath = Join-Path $TargetTestRoot "ReShade.log"
$TargetPresetPath =
    Join-Path $TargetTestRoot "EGO-Coexistence.ini"
$TargetAddonDirectory = Join-Path $TargetTestRoot "addons"
$TargetForeignAddonPath =
    Join-Path $TargetAddonDirectory "fps_limit.addon64"
$TargetOwnedAddonPath =
    Join-Path $TargetAddonDirectory "electron_game_overlay.addon64"
$TargetOwnershipMarkerPath =
    Join-Path $TargetAddonDirectory ".electron-game-overlay-addon.json"
$TargetTransactionPath =
    Join-Path `
        $TargetAddonDirectory `
        ".electron-game-overlay-addon.transaction.json"
$TargetShaderDirectory = Join-Path $TargetTestRoot "shaders"
$TargetEffectPath =
    Join-Path $TargetShaderDirectory "EGOCoexistenceWitness.fx"
$TargetCacheDirectory = Join-Path $TargetTestRoot "cache"
$RuntimeDistributionDirectory =
    Join-Path $RuntimeRoot "dist\win32-x64"
$AddonManagerPath =
    Join-Path `
        $RuntimeDistributionDirectory `
        "electron_game_overlay_reshade_manager.exe"
$ProductionAddonPath =
    Join-Path `
        $RuntimeDistributionDirectory `
        "electron_game_overlay.addon64"
$PackageBuildStampPath =
    Join-Path `
        $RuntimeDistributionDirectory `
        "electron_game_overlay_runtime.build.json"
$ClientRuntimeDirectory =
    Join-Path `
        $RepoRoot `
        "libs\electron-game-overlay\dist\runtime\win32-x64\reshade"
$ClientAddonPath =
    Join-Path $ClientRuntimeDirectory "electron_game_overlay.addon64"
$ClientBuildStampPath =
    Join-Path `
        $ClientRuntimeDirectory `
        "electron_game_overlay_runtime.build.json"
$ReShadeSourceDirectory =
    Join-Path $BuildRoot "_deps\reshade-src"

if ([string]::IsNullOrWhiteSpace($OfficialRuntimePath)) {
    $OfficialRuntimePath =
        Join-Path `
            $RepoRoot `
            "build\official-reshade-6.7.3\d3d11-target\d3d11.dll"
}

$RunDirectory = Join-Path `
    $BuildRoot `
    "client-Gun-Frog-official-reshade-coexistence-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$StageDirectory = Join-Path $RunDirectory "seed"
$ForeignSourceDirectory =
    Join-Path $RunDirectory "stock-api18-addon-source"
$UserData = Join-Path $RunDirectory "user-data"
$ClientStdout = Join-Path $RunDirectory "client.stdout.log"
$ClientStderr = Join-Path $RunDirectory "client.stderr.log"
$ResultPath = Join-Path $RunDirectory "result.json"
$ClientProcess = $null
$TargetProcessId = 0
$ReShadeRunDirectory = $null
$ManagerPrepared = $false
$ManagerInvocationStarted = $false
$TargetSeeded = $false
$TargetRuntimeSeedOwned = $false
$TargetBootstrapSeedOwned = $false
$TargetTestRootOwned = $false
$RunOwnsTargetLaunch = $false
$InitialTargetClean = $false
$RunPassed = $false
$PendingSummary = $null
$GateFailure = $null
$CleanupFailure = $null
$DeferredCleanupFailures = [Collections.Generic.List[string]]::new()
$TargetRootSnapshot = $null
$ProtectedSeedManifest = @()
$PackageBuildStamp = $null
$OfficialRuntimeHash = $null
$ProductionAddonHash = $null
$ForeignAddonHash = $null
$ForeignSourceCommit = $null
$BootstrapSeedHash = $null
$GateMutex = [Threading.Mutex]::new(
    $false,
    "Local\ElectronGameOverlayGunFrogOfficialReShadeCoexistenceGate"
)
$GateMutexHeld = $false

function Save-JsonEvidence {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $Value |
        ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (
        Get-FileHash -LiteralPath $Path -Algorithm SHA256
    ).Hash
}

function Copy-NewSeedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$OwnershipFlag
    )

    $SourceStream = $null
    $DestinationStream = $null
    $Created = $false
    try {
        $SourceStream = [IO.FileStream]::new(
            $Source,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )
        # CreateNew makes the final collision check authoritative at creation
        # time rather than relying on a prior Test-Path result that another
        # process could race.
        $DestinationStream = [IO.FileStream]::new(
            $Destination,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        $Created = $true
        Set-Variable `
            -Name $OwnershipFlag `
            -Value $true `
            -Scope Script
        $SourceStream.CopyTo($DestinationStream)
        $DestinationStream.Flush($true)
        $DestinationStream.Dispose()
        $DestinationStream = $null
        $SourceStream.Dispose()
        $SourceStream = $null

        $SourceItem = Get-Item -LiteralPath $Source -Force
        $DestinationItem = Get-Item -LiteralPath $Destination -Force
        $DestinationItem.CreationTimeUtc = $SourceItem.CreationTimeUtc
        $DestinationItem.LastWriteTimeUtc = $SourceItem.LastWriteTimeUtc
        $DestinationItem.LastAccessTimeUtc = $SourceItem.LastAccessTimeUtc
        $DestinationItem.Attributes = $SourceItem.Attributes
    }
    catch {
        $Failure = $_
        if ($DestinationStream) {
            $DestinationStream.Dispose()
            $DestinationStream = $null
        }
        if ($SourceStream) {
            $SourceStream.Dispose()
            $SourceStream = $null
        }
        if ($Created -and (Test-Path -LiteralPath $Destination)) {
            Remove-Item -LiteralPath $Destination -Force
            Set-Variable `
                -Name $OwnershipFlag `
                -Value $false `
                -Scope Script
        }
        throw (
            "Could not create the new test-owned seed '$Destination' " +
            "without replacement: " +
            $Failure.Exception.Message
        )
    }
    finally {
        if ($DestinationStream) {
            $DestinationStream.Dispose()
        }
        if ($SourceStream) {
            $SourceStream.Dispose()
        }
    }
}

function Get-PathSnapshot {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Item = Get-Item -LiteralPath $Path -Force
    $IsDirectory = $Item.PSIsContainer
    return [pscustomobject]@{
        FullPath = [IO.Path]::GetFullPath($Item.FullName)
        IsDirectory = [bool]$IsDirectory
        Length = if ($IsDirectory) { $null } else { [int64]$Item.Length }
        Sha256 = if ($IsDirectory) {
            $null
        }
        else {
            Get-FileSha256 -Path $Item.FullName
        }
        Attributes = [int]$Item.Attributes
        CreationTimeUtc = $Item.CreationTimeUtc.ToString("o")
        LastWriteTimeUtc = $Item.LastWriteTimeUtc.ToString("o")
        LastAccessTimeUtc = $Item.LastAccessTimeUtc.ToString("o")
    }
}

function Restore-SnapshotMetadata {
    param([Parameter(Mandatory = $true)][object]$Snapshot)

    if (-not (Test-Path -LiteralPath $Snapshot.FullPath)) {
        throw "Cannot restore metadata for missing path '$($Snapshot.FullPath)'."
    }
    $Item = Get-Item -LiteralPath $Snapshot.FullPath -Force
    if (($Item.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
        $Item.Attributes =
            $Item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
    }
    $ExpectedCreationTimeUtc = [DateTime]::Parse(
        [string]$Snapshot.CreationTimeUtc,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
    )
    $ExpectedLastWriteTimeUtc = [DateTime]::Parse(
        [string]$Snapshot.LastWriteTimeUtc,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
    )
    $ExpectedLastAccessTimeUtc = [DateTime]::Parse(
        [string]$Snapshot.LastAccessTimeUtc,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
    )
    if ($Item.CreationTimeUtc -ne $ExpectedCreationTimeUtc) {
        $Item.CreationTimeUtc = $ExpectedCreationTimeUtc
    }
    if ($Item.LastWriteTimeUtc -ne $ExpectedLastWriteTimeUtc) {
        $Item.LastWriteTimeUtc = $ExpectedLastWriteTimeUtc
    }
    if ($Item.LastAccessTimeUtc -ne $ExpectedLastAccessTimeUtc) {
        $Item.LastAccessTimeUtc = $ExpectedLastAccessTimeUtc
    }
    $ExpectedAttributes = [IO.FileAttributes][int]$Snapshot.Attributes
    if ($Item.Attributes -ne $ExpectedAttributes) {
        $Item.Attributes = $ExpectedAttributes
    }
}

function Assert-SnapshotEqual {
    param(
        [Parameter(Mandatory = $true)][object]$Expected,
        [Parameter(Mandatory = $true)][object]$Actual,
        [switch]$IgnoreLastAccessTime
    )

    foreach ($Property in @(
            "FullPath",
            "IsDirectory",
            "Length",
            "Sha256",
            "Attributes",
            "CreationTimeUtc",
            "LastWriteTimeUtc"
        )) {
        if ($Expected.$Property -cne $Actual.$Property) {
            throw (
                "Path '$($Expected.FullPath)' changed property '$Property': " +
                "expected '$($Expected.$Property)', actual '$($Actual.$Property)'."
            )
        }
    }
    if (-not $IgnoreLastAccessTime -and
        $Expected.LastAccessTimeUtc -cne $Actual.LastAccessTimeUtc) {
        throw (
            "Path '$($Expected.FullPath)' changed LastAccessTimeUtc: " +
            "expected '$($Expected.LastAccessTimeUtc)', " +
            "actual '$($Actual.LastAccessTimeUtc)'."
        )
    }
}

function Assert-ProtectedSeedPreserved {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Manifest,
        [switch]$RestoreTestOwnedMetadata
    )

    foreach ($Expected in $Manifest) {
        if (-not (Test-Path -LiteralPath $Expected.FullPath -PathType Leaf)) {
            throw "The coexistence run removed seeded file '$($Expected.FullPath)'."
        }
        $Actual = Get-PathSnapshot -Path $Expected.FullPath
        Assert-SnapshotEqual `
            -Expected $Expected `
            -Actual $Actual `
            -IgnoreLastAccessTime

        # The native manager alone owns the reserved Electron add-on pair.
        # Test setup may restore metadata only on its other seeded files.
        $IsReserved = (
            [string]::Equals(
                $Expected.FullPath,
                [IO.Path]::GetFullPath($TargetOwnedAddonPath),
                [StringComparison]::OrdinalIgnoreCase
            ) -or
            [string]::Equals(
                $Expected.FullPath,
                [IO.Path]::GetFullPath($TargetOwnershipMarkerPath),
                [StringComparison]::OrdinalIgnoreCase
            )
        )
        if ($RestoreTestOwnedMetadata -and -not $IsReserved) {
            Restore-SnapshotMetadata -Snapshot $Expected
            $Restored = Get-PathSnapshot -Path $Expected.FullPath
            Assert-SnapshotEqual -Expected $Expected -Actual $Restored
        }
    }
}

function Assert-NoReparseTree {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Root = Get-Item -LiteralPath $Path -Force
    if (($Root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing a reparse-point cleanup root: $Path"
    }
    foreach ($Entry in @(
            Get-ChildItem -LiteralPath $Path -Recurse -Force
        )) {
        if (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to clean a test tree containing a reparse point: $($Entry.FullName)"
        }
    }
}

function Assert-SafeTestRoot {
    $Expected = [IO.Path]::GetFullPath(
        (Join-Path $TargetDirectory $TestRootLeaf)
    )
    $Actual = [IO.Path]::GetFullPath($TargetTestRoot)
    if (-not [string]::Equals(
            $Expected,
            $Actual,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        [IO.Path]::GetFileName($Actual) -cne $TestRootLeaf -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath((Split-Path -Parent $Actual)),
            [IO.Path]::GetFullPath($TargetDirectory),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "The test cleanup root escaped the exact Gun Frog directory: $Actual"
    }
}

function Get-ReShadeCollisions {
    $ReservedNames = @(
        "dxgi.dll",
        "d3d11.dll",
        "d3d12.dll",
        "d3d10.dll",
        "d3d10_1.dll",
        "d3d9.dll",
        "opengl32.dll",
        "dinput8.dll",
        "version.dll",
        "winmm.dll",
        "ReShade.ini",
        "ReShadePreset.ini",
        "ReShade.log",
        "reshade-shaders",
        "reshade-addons",
        $TestRootLeaf,
        "electron_game_overlay.addon64",
        ".electron-game-overlay-addon.json",
        ".electron-game-overlay-addon.transaction.json"
    )
    return @(
        Get-ChildItem -LiteralPath $TargetDirectory -Force |
            Where-Object {
                $ReservedNames -icontains $_.Name -or
                $_.Name -like "*.addon" -or
                $_.Name -like "*.addon64" -or
                $_.Name -like "ReShade*.dll" -or
                $_.Name -like "ReShade*.ini" -or
                $_.Name -like "ReShade*.log*" -or
                $_.Name -like ".electron-game-overlay-addon.*"
            } |
            Select-Object -ExpandProperty FullName
    )
}

function Assert-CleanTargetDirectory {
    $Collisions = @(Get-ReShadeCollisions)
    if ($Collisions.Count -ne 0) {
        throw (
            "Gun Frog already has ReShade/proxy/mod artifacts. This gate is " +
            "clean-install-only and will not touch them: " +
            ($Collisions -join ", ")
        )
    }
}

function Get-MatchingClientProcesses {
    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name='electron.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -like "*$RepoRoot*" -and
                ($_.CommandLine -like "*--reshade-overlay*" -or
                    $_.CommandLine -like "*--hudhook-overlay*")
            }
    )
}

function Get-OwnedClientProcesses {
    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name='electron.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -like "*$UserData*" -or
                ($ClientProcess -and $_.ProcessId -eq $ClientProcess.Id)
            }
    )
}

function Get-MatchingInjectors {
    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name='inject.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -like "*$TargetExecutableName*" -or
                $_.CommandLine -like "*$TargetExecutablePath*"
            }
    )
}

function Get-StagedRunDirectories {
    $Directories = [Collections.Generic.List[string]]::new()
    $Matches = [regex]::Matches(
        (Get-ClientLogText),
        '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(.+)\r?$'
    )
    foreach ($Match in $Matches) {
        try {
            $Directory = $Match.Groups[1].Value | ConvertFrom-Json
            if ($Directory -is [string] -and
                -not [string]::IsNullOrWhiteSpace($Directory)) {
                $Directories.Add([IO.Path]::GetFullPath($Directory))
            }
        }
        catch {
            # The exact target injector remains covered by
            # Get-MatchingInjectors during cleanup. A malformed unrelated
            # marker must not prevent restoration of test-owned target files.
        }
    }
    return @($Directories | Sort-Object -Unique)
}

function Get-OwnedInjectors {
    $RunDirectories = @(Get-StagedRunDirectories)
    if ($RunDirectories.Count -eq 0) {
        return @()
    }
    $OwnedInjectorPaths = @(
        $RunDirectories |
            ForEach-Object {
                [IO.Path]::GetFullPath((Join-Path $_ "inject.exe"))
            }
    )
    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name='inject.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $ExecutablePath = [string]$_.ExecutablePath
                foreach ($OwnedPath in $OwnedInjectorPaths) {
                    if ([string]::Equals(
                            $ExecutablePath,
                            $OwnedPath,
                            [StringComparison]::OrdinalIgnoreCase
                        )) {
                        return $true
                    }
                }
                return $false
            }
    )
}

function Get-MatchingTargets {
    return @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -eq $TargetExecutableName -and
                $_.ExecutablePath -and
                [string]::Equals(
                    $_.ExecutablePath,
                    $TargetExecutablePath,
                    [StringComparison]::OrdinalIgnoreCase
                )
            }
    )
}

function Assert-NoScopedProcesses {
    $Targets = @(Get-MatchingTargets)
    $Clients = @(Get-MatchingClientProcesses)
    $Injectors = @(Get-MatchingInjectors)
    if ($Targets.Count -ne 0 -or
        $Clients.Count -ne 0 -or
        $Injectors.Count -ne 0) {
        $Ids = @(
            @($Targets.ProcessId) +
                @($Clients.ProcessId) +
                @($Injectors.ProcessId) |
                Where-Object { $null -ne $_ } |
                Sort-Object -Unique
        )
        throw (
            "Close Gun Frog and every scoped overlay client/injector before " +
            "this gate (PID: $($Ids -join ', '))."
        )
    }
}

function Get-ClientLogText {
    if (-not (Test-Path -LiteralPath $ClientStdout -PathType Leaf)) {
        return ""
    }
    $Text = Get-Content -LiteralPath $ClientStdout -Raw
    if ($null -eq $Text) {
        return ""
    }
    return $Text
}

function Get-ClientErrorLogText {
    if (-not (Test-Path -LiteralPath $ClientStderr -PathType Leaf)) {
        return ""
    }
    $Text = Get-Content -LiteralPath $ClientStderr -Raw
    if ($null -eq $Text) {
        return ""
    }
    return $Text
}

function Wait-ForClientMarker {
    param(
        [Parameter(Mandatory = $true)][string]$Marker,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        # Redirected log files exist before Electron writes its first byte, and
        # Get-Content returns no pipeline object for that transient empty file.
        $Text = Get-ClientLogText
        if ($null -eq $Text) {
            $Text = ""
        }
        if ($Text.Contains("RESHADE_CLIENT_INJECTOR_FAILED") -or
            $Text.Contains("ReShade attachment failed")) {
            throw (
                "The production client reported an attachment failure. " +
                "Inspect $ClientStdout and $ClientStderr."
            )
        }
        if ($Text.Contains($Marker)) {
            return
        }
        if ($ClientProcess) {
            $ClientProcess.Refresh()
            if ($ClientProcess.HasExited) {
                throw (
                    "The production client exited before '$Marker'. " +
                    "Inspect $ClientStdout and $ClientStderr."
                )
            }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Timed out waiting for '$Marker'. Inspect $ClientStdout."
}

function Assert-ExactlyOneMarker {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Marker
    )

    $Count = ([regex]::Matches(
            $Text,
            [regex]::Escape($Marker)
        )).Count
    if ($Count -ne 1) {
        throw "Expected exactly one '$Marker' marker, found $Count."
    }
}

function Get-ReShadeRunDirectory {
    param(
        [Parameter(Mandatory = $true)][int]$TargetPid,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )

    $ResultPrefix = "ELECTRON_GAME_OVERLAY_INJECTOR_RESULT "
    $MatchingDirectories = [Collections.Generic.List[string]]::new()
    foreach ($Directory in @(Get-StagedRunDirectories)) {
        $InjectorStdout = Join-Path $Directory "inject.stdout.log"
        if (-not (Test-Path -LiteralPath $InjectorStdout -PathType Leaf)) {
            continue
        }
        foreach ($Line in @(Get-Content -LiteralPath $InjectorStdout)) {
            if (-not $Line.StartsWith($ResultPrefix)) {
                continue
            }
            try {
                $Result =
                    $Line.Substring($ResultPrefix.Length) |
                    ConvertFrom-Json
            }
            catch {
                continue
            }
            if ($Result.schemaVersion -eq 1 -and
                $Result.pid -eq $TargetPid -and
                $Result.targetExecutablePath -is [string] -and
                [string]::Equals(
                    $Result.targetExecutablePath,
                    $TargetPath,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                $MatchingDirectories.Add($Directory)
            }
        }
    }
    $UniqueMatches = @($MatchingDirectories | Sort-Object -Unique)
    if ($UniqueMatches.Count -ne 1) {
        throw (
            "Expected exactly one staged injector directory with a structured " +
            "result for Gun Frog PID $TargetPid, found " +
            "$($UniqueMatches.Count)."
        )
    }
    return $UniqueMatches[0]
}

function Get-ConnectedTargetProcessId {
    $Matches = [regex]::Matches(
        (Get-ClientLogText),
        '(?m)^STEAM_GAME_AUTO_ATTACH_CONNECTED pid=(\d+) processName="Gun Frog\.exe"\r?$'
    )
    if ($Matches.Count -ne 1) {
        throw (
            "Expected exactly one authenticated Gun Frog PID, found " +
            "$($Matches.Count)."
        )
    }
    return [int]$Matches[0].Groups[1].Value
}

function Wait-ForReShadeEvidence {
    param([Parameter(Mandatory = $true)][DateTime]$Deadline)

    $RequiredPatterns = @(
        'Registered add-on "FPS Limiter".*ReShade API version 18',
        'Registered add-on "Electron Game Overlay Runtime".*ReShade API version 18',
        "Successfully compiled '.*EGOCoexistenceWitness\.fx'",
        "rendered its first transported scene"
    )
    while ([DateTime]::UtcNow -lt $Deadline) {
        if (Test-Path -LiteralPath $TargetLogPath -PathType Leaf) {
            $Text = Get-Content -LiteralPath $TargetLogPath -Raw
            $Missing = @(
                $RequiredPatterns |
                    Where-Object {
                        -not [regex]::IsMatch(
                            $Text,
                            $_,
                            [Text.RegularExpressions.RegexOptions]::IgnoreCase
                        )
                    }
            )
            if ($Missing.Count -eq 0) {
                return
            }
        }
        if ($TargetProcessId -ne 0 -and
            -not (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) {
            throw "Gun Frog exited before ReShade coexistence evidence was complete."
        }
        Start-Sleep -Milliseconds 100
    }
    throw (
        "Timed out waiting for official ReShade, API-18 foreign add-on, " +
        "effect compilation, and transported-scene evidence in $TargetLogPath."
    )
}

function Assert-X64PeWithAsciiExports {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$Exports
    )

    $Bytes = [IO.File]::ReadAllBytes($Path)
    if ($Bytes.Length -lt 512 -or
        $Bytes[0] -ne 0x4d -or
        $Bytes[1] -ne 0x5a) {
        throw "Expected a PE image at '$Path'."
    }
    $PeOffset = [BitConverter]::ToInt32($Bytes, 0x3c)
    if ($PeOffset -lt 0x40 -or
        $PeOffset + 24 -ge $Bytes.Length -or
        [BitConverter]::ToUInt32($Bytes, $PeOffset) -ne 0x00004550 -or
        [BitConverter]::ToUInt16($Bytes, $PeOffset + 4) -ne 0x8664 -or
        [BitConverter]::ToUInt16($Bytes, $PeOffset + 24) -ne 0x020b) {
        throw "Expected an x64 PE32+ image at '$Path'."
    }
    $Ascii = [Text.Encoding]::ASCII.GetString($Bytes)
    foreach ($Export in $Exports) {
        if (-not $Ascii.Contains($Export)) {
            throw "The x64 image '$Path' lacks expected export '$Export'."
        }
    }
}

function Find-MSBuild {
    $VsWhere = Join-Path `
        ${env:ProgramFiles(x86)} `
        "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $VsWhere -PathType Leaf) {
        $Found = @(
            & $VsWhere `
                -latest `
                -products * `
                -requires Microsoft.Component.MSBuild `
                -find "MSBuild\**\Bin\MSBuild.exe"
        )
        if ($LASTEXITCODE -eq 0 -and $Found.Count -gt 0) {
            return $Found[0]
        }
    }
    $Command = Get-Command msbuild.exe -ErrorAction SilentlyContinue
    if ($Command) {
        return $Command.Source
    }
    throw "MSBuild is required to build the pristine stock API-18 witness add-on."
}

function Build-StockApi18ForeignAddon {
    if (-not (Test-Path -LiteralPath $ReShadeSourceDirectory -PathType Container)) {
        throw (
            "The configured ReShade source tree is unavailable: " +
            $ReShadeSourceDirectory
        )
    }
    $GitDirectory = Join-Path $ReShadeSourceDirectory ".git"
    if (-not (Test-Path -LiteralPath $GitDirectory)) {
        throw "The ReShade source fixture is not a Git worktree."
    }

    $script:ForeignSourceCommit = (
        & git.exe -C $ReShadeSourceDirectory rev-parse HEAD
    ).Trim()
    if ($LASTEXITCODE -ne 0 -or
        $script:ForeignSourceCommit -notmatch '^[0-9a-f]{40}$') {
        throw "Could not identify the pristine ReShade source commit."
    }
    $PristineHeader = @(
        & git.exe `
            -C $ReShadeSourceDirectory `
            show "HEAD:include/reshade.hpp"
    ) -join "`n"
    if ($LASTEXITCODE -ne 0 -or
        $PristineHeader -notmatch
            '(?m)^#define RESHADE_API_VERSION 18\s*$') {
        throw (
            "The pristine ReShade source does not expose stock add-on API 18."
        )
    }

    $ExpectedImGuiCommit = (
        & git.exe `
            -C $ReShadeSourceDirectory `
            ls-tree HEAD deps/imgui
    ) -replace '^.*commit\s+([0-9a-f]{40}).*$', '$1'
    $ImGuiDirectory = Join-Path $ReShadeSourceDirectory "deps\imgui"
    $ActualImGuiCommit = (
        & git.exe -C $ImGuiDirectory rev-parse HEAD
    ).Trim()
    $ImGuiWorktreeChanges = @(
        & git.exe `
            -C $ImGuiDirectory `
            status `
            --porcelain=v1 `
            --untracked-files=all
    )
    if ($LASTEXITCODE -ne 0 -or
        $ExpectedImGuiCommit -notmatch '^[0-9a-f]{40}$' -or
        $ActualImGuiCommit -cne $ExpectedImGuiCommit -or
        $ImGuiWorktreeChanges.Count -ne 0) {
        throw (
            "The ReShade ImGui submodule is not a pristine checkout of its " +
            "pinned commit."
        )
    }

    New-Item `
        -ItemType Directory `
        -Path $ForeignSourceDirectory `
        -Force |
        Out-Null
    $ArchivePath = Join-Path $RunDirectory "stock-api18-addon-source.zip"
    & git.exe `
        -C $ReShadeSourceDirectory `
        archive `
        --format=zip `
        "--output=$ArchivePath" `
        HEAD `
        include `
        examples/01-fps_limit
    if ($LASTEXITCODE -ne 0) {
        throw "Could not archive the pristine stock API-18 add-on source."
    }
    Expand-Archive `
        -LiteralPath $ArchivePath `
        -DestinationPath $ForeignSourceDirectory
    $PristineImGuiDirectory =
        Join-Path $ForeignSourceDirectory "deps\imgui"
    New-Item `
        -ItemType Directory `
        -Path $PristineImGuiDirectory `
        -Force |
        Out-Null
    Copy-Item `
        -Path (Join-Path $ImGuiDirectory "*.h") `
        -Destination $PristineImGuiDirectory

    $MSBuild = Find-MSBuild
    $Project = Join-Path `
        $ForeignSourceDirectory `
        "examples\01-fps_limit\fps_limit.vcxproj"
    $BuildLog = Join-Path $RunDirectory "stock-api18-addon-build.log"
    # Keep compiler-generated paths comfortably below the legacy MAX_PATH
    # boundary even though the evidence directory is intentionally descriptive.
    # The pristine project otherwise nests its intermediate/output paths below
    # the already-isolated source archive and cl.exe can fail with C1083.
    $BuildIntermediateDirectory = Join-Path $RunDirectory "b\obj"
    $BuildOutputDirectory = Join-Path $RunDirectory "b\bin"
    & $MSBuild `
        $Project `
        /nologo `
        /m:2 `
        /t:Build `
        /p:Configuration=Release `
        /p:Platform=x64 `
        "/p:IntDir=$BuildIntermediateDirectory\" `
        "/p:OutDir=$BuildOutputDirectory\" `
        /verbosity:minimal 2>&1 |
        Tee-Object -FilePath $BuildLog |
        Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw (
            "The stock API-18 FPS Limiter add-on build failed. Inspect " +
            $BuildLog
        )
    }
    $ForeignAddon = Join-Path $BuildOutputDirectory "fps_limit.addon64"
    if (-not (Test-Path -LiteralPath $ForeignAddon -PathType Leaf)) {
        throw "The stock API-18 add-on build produced no x64 add-on."
    }
    Assert-X64PeWithAsciiExports `
        -Path $ForeignAddon `
        -Exports @("NAME", "DESCRIPTION")
    if (-not (
            [Text.Encoding]::ASCII.GetString(
                [IO.File]::ReadAllBytes($ForeignAddon)
            )
        ).Contains("FPS Limiter")) {
        throw "The foreign add-on is not the pristine FPS Limiter example."
    }
    return $ForeignAddon
}

function Invoke-AddonManager {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("prepare", "remove")]
        [string]$Operation
    )

    $Arguments = @(
        $Operation,
        "--directory",
        $TargetAddonDirectory,
        "--reshade-module",
        $TargetRuntimePath,
        "--reshade-module-sha256",
        $OfficialRuntimeHash
    )
    if ($Operation -eq "prepare") {
        $Arguments += @(
            "--source",
            $ProductionAddonPath,
            "--source-sha256",
            $ProductionAddonHash
        )
    }
    $Output = @(& $AddonManagerPath @Arguments)
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 0 -or $Output.Count -ne 1) {
        throw (
            "The native add-on manager '$Operation' operation failed " +
            "(exit $ExitCode): $($Output -join "`n")"
        )
    }
    try {
        return $Output[0] | ConvertFrom-Json
    }
    catch {
        throw "The native add-on manager returned invalid JSON: $($Output[0])"
    }
}

function Stop-ScopedProcesses {
    $CleanupIds = @(
        Get-OwnedClientProcesses |
            ForEach-Object { $_.ProcessId }
    )
    if ($ClientProcess) {
        $ClientProcess.Refresh()
        if (-not $ClientProcess.HasExited) {
            $CleanupIds += $ClientProcess.Id
        }
    }
    foreach ($ProcessId in @($CleanupIds | Sort-Object -Unique)) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
    foreach ($ProcessId in @($CleanupIds | Sort-Object -Unique)) {
        Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }

    if ($ClientProcess -or $RunOwnsTargetLaunch) {
        # The Steam auto-attacher stages multiple exact-PID launchers and
        # immediately rearms its generic path watcher. Read its now-stable log
        # after Electron exits and stop every injector from those owned staged
        # directories, not only the one whose command line names Gun Frog.
        $InjectorDeadline = [DateTime]::UtcNow.AddSeconds(5)
        while ($true) {
            $Injectors = @(
                @(
                    Get-OwnedInjectors
                    Get-MatchingInjectors
                ) |
                    Sort-Object ProcessId -Unique
            )
            if ($Injectors.Count -eq 0) {
                break
            }
            foreach ($Injector in $Injectors) {
                Stop-Process `
                    -Id $Injector.ProcessId `
                    -Force `
                    -ErrorAction SilentlyContinue
                Wait-Process `
                    -Id $Injector.ProcessId `
                    -Timeout 5 `
                    -ErrorAction SilentlyContinue
            }
            if ([DateTime]::UtcNow -ge $InjectorDeadline) {
                break
            }
        }
    }

    if ($RunOwnsTargetLaunch) {
        foreach ($Target in @(Get-MatchingTargets)) {
            $Handle = Get-Process `
                -Id $Target.ProcessId `
                -ErrorAction SilentlyContinue
            if ($Handle) {
                $null = $Handle.CloseMainWindow()
                Wait-Process `
                    -Id $Target.ProcessId `
                    -Timeout 5 `
                    -ErrorAction SilentlyContinue
                if (Get-Process `
                        -Id $Target.ProcessId `
                        -ErrorAction SilentlyContinue) {
                    Stop-Process `
                        -Id $Target.ProcessId `
                        -Force `
                        -ErrorAction SilentlyContinue
                    Wait-Process `
                        -Id $Target.ProcessId `
                        -Timeout 5 `
                        -ErrorAction SilentlyContinue
                }
            }
        }
    }
}

function Remove-VerifiedSeedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Refusing to remove a non-file seed path: $Path"
    }
    if ((Get-FileSha256 -Path $Path) -cne $ExpectedSha256) {
        throw "Refusing to remove changed test seed '$Path'."
    }
    Remove-Item -LiteralPath $Path -Force
}

try {
    if (-not $GateMutex.WaitOne(0)) {
        throw "Another Gun Frog official-ReShade coexistence gate is active."
    }
    $GateMutexHeld = $true

    if (-not (Test-Path -LiteralPath $TargetExecutablePath -PathType Leaf)) {
        throw "Gun Frog executable was not found: $TargetExecutablePath"
    }
    if (-not (Test-Path -LiteralPath $Electron -PathType Leaf)) {
        throw "Electron is unavailable: $Electron"
    }
    if (-not (Test-Path -LiteralPath $Nx -PathType Leaf)) {
        throw "The local Nx CLI is unavailable: $Nx"
    }
    Assert-SafeTestRoot
    Assert-NoScopedProcesses
    Assert-CleanTargetDirectory
    $InitialTargetClean = $true
    $TargetRootSnapshot = Get-PathSnapshot -Path $TargetDirectory

    New-Item -ItemType Directory -Path $RunDirectory | Out-Null
    Save-JsonEvidence `
        -Value $TargetRootSnapshot `
        -Path (Join-Path $RunDirectory "target-root-before.json")
    New-Item -ItemType Directory -Path $StageDirectory | Out-Null
    New-Item -ItemType Directory -Path $UserData | Out-Null

    if (-not $SkipBuild) {
        & $Nx run client:build
        if ($LASTEXITCODE -ne 0) {
            throw "The production client/SDK build failed with exit code $LASTEXITCODE."
        }
    }

    foreach ($RequiredArtifact in @(
            $AddonManagerPath,
            $ProductionAddonPath,
            $PackageBuildStampPath,
            $ClientAddonPath,
            $ClientBuildStampPath
        )) {
        if (-not (Test-Path -LiteralPath $RequiredArtifact -PathType Leaf)) {
            throw "A current production artifact is unavailable: $RequiredArtifact"
        }
    }
    $PackageBuildStamp =
        Get-Content -LiteralPath $PackageBuildStampPath -Raw |
        ConvertFrom-Json
    $ClientBuildStamp =
        Get-Content -LiteralPath $ClientBuildStampPath -Raw |
        ConvertFrom-Json
    $ProductionAddonHash = Get-FileSha256 -Path $ProductionAddonPath
    $ClientAddonHash = Get-FileSha256 -Path $ClientAddonPath
    $AddonManagerHash = Get-FileSha256 -Path $AddonManagerPath
    if ($PackageBuildStamp.schemaVersion -ne 2 -or
        $PackageBuildStamp.kind -cne
            "electron-game-overlay-runtime-build" -or
        ([string]$PackageBuildStamp.addonBuildId) -cnotmatch
            '^[0-9A-F]{32}$' -or
        $PackageBuildStamp.addonSha256 -cne $ProductionAddonHash -or
        $PackageBuildStamp.managerSha256 -cne $AddonManagerHash -or
        $ClientBuildStamp.addonBuildId -cne
            $PackageBuildStamp.addonBuildId -or
        $ClientBuildStamp.addonSha256 -cne $ProductionAddonHash -or
        $ClientAddonHash -cne $ProductionAddonHash) {
        throw (
            "The runtime package and staged client do not contain one exact " +
            "current add-on generation. Rebuild before running this gate."
        )
    }

    if (-not (Test-Path -LiteralPath $OfficialRuntimePath -PathType Leaf)) {
        throw "The stock full-add-on ReShade runtime is unavailable: $OfficialRuntimePath"
    }
    $OfficialRuntimePath = (
        Resolve-Path -LiteralPath $OfficialRuntimePath
    ).Path
    Assert-X64PeWithAsciiExports `
        -Path $OfficialRuntimePath `
        -Exports @(
            "ReShadeRegisterAddon",
            "ReShadeGetImGuiFunctionTable"
        )
    $OfficialRuntimeHash = Get-FileSha256 -Path $OfficialRuntimePath
    if ($OfficialRuntimeHash -ceq $PackageBuildStamp.reshadeRuntimeSha256) {
        throw (
            "OfficialRuntimePath identifies the project's patched fallback " +
            "runtime, not a stock full-add-on ReShade runtime."
        )
    }

    $ForeignAddon = Build-StockApi18ForeignAddon
    $ForeignAddonHash = Get-FileSha256 -Path $ForeignAddon

    $StageRuntimePath = Join-Path $StageDirectory "dxgi.dll"
    $StageBootstrapConfigurationPath =
        Join-Path $StageDirectory "ReShade.ini"
    $StageTestRoot = Join-Path $StageDirectory $TestRootLeaf
    $StageConfigurationPath = Join-Path $StageTestRoot "ReShade.ini"
    $StagePresetPath =
        Join-Path $StageTestRoot "EGO-Coexistence.ini"
    $StageAddonDirectory = Join-Path $StageTestRoot "addons"
    $StageForeignAddonPath =
        Join-Path $StageAddonDirectory "fps_limit.addon64"
    $StageShaderDirectory = Join-Path $StageTestRoot "shaders"
    $StageEffectPath =
        Join-Path $StageShaderDirectory "EGOCoexistenceWitness.fx"
    New-Item -ItemType Directory -Path $StageAddonDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $StageShaderDirectory -Force | Out-Null
    New-Item `
        -ItemType Directory `
        -Path (Join-Path $StageTestRoot "cache") `
        -Force |
        Out-Null
    New-Item `
        -ItemType Directory `
        -Path (Join-Path $StageTestRoot "textures") `
        -Force |
        Out-Null
    Copy-Item -LiteralPath $OfficialRuntimePath -Destination $StageRuntimePath
    Copy-Item -LiteralPath $ForeignAddon -Destination $StageForeignAddonPath

    $Utf8NoBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText(
        $StageBootstrapConfigurationPath,
        @"
[INSTALL]
BasePath=.\$TestRootLeaf
"@,
        $Utf8NoBom
    )
    [IO.File]::WriteAllText(
        $StageConfigurationPath,
        @"
[INSTALL]
BasePath=.

[ADDON]
AddonPath=.\addons
DisabledAddons=

[GENERAL]
EffectSearchPaths=.\shaders
IntermediateCachePath=.\cache
NoDebugInfo=1
PerformanceMode=0
PresetPath=.\EGO-Coexistence.ini
SkipLoadingDisabledEffects=0
TextureSearchPaths=.\textures

[INPUT]
InputProcessing=0

[OVERLAY]
ShowFPS=0
TutorialProgress=4
"@,
        $Utf8NoBom
    )
    [IO.File]::WriteAllText(
        $StagePresetPath,
        @"
PreprocessorDefinitions=
Techniques=EGOCoexistenceWitness@EGOCoexistenceWitness.fx
TechniqueSorting=EGOCoexistenceWitness@EGOCoexistenceWitness.fx
"@,
        $Utf8NoBom
    )
    [IO.File]::WriteAllText(
        $StageEffectPath,
        @"
texture2D EGOBackBufferTex : COLOR;
sampler2D EGOBackBuffer
{
    Texture = EGOBackBufferTex;
};

struct EGOVertexOutput
{
    float4 position : SV_Position;
    float2 texcoord : TEXCOORD;
};

EGOVertexOutput EGOPostProcessVS(uint vertex_id : SV_VertexID)
{
    EGOVertexOutput output;
    output.texcoord.x = (vertex_id == 2) ? 2.0 : 0.0;
    output.texcoord.y = (vertex_id == 1) ? 2.0 : 0.0;
    output.position = float4(
        output.texcoord * float2(2.0, -2.0) + float2(-1.0, 1.0),
        0.0,
        1.0);
    return output;
}

float4 EGOCoexistencePS(EGOVertexOutput input) : SV_Target
{
    return tex2D(EGOBackBuffer, input.texcoord);
}

technique EGOCoexistenceWitness < enabled = true; >
{
    pass
    {
        VertexShader = EGOPostProcessVS;
        PixelShader = EGOCoexistencePS;
    }
}
"@,
        $Utf8NoBom
    )

    # ReShade normally normalizes configuration and presets on shutdown.
    # Keeping these test-owned seeds read-only isolates project writes and
    # makes byte/attribute/timestamp preservation mechanically checkable.
    foreach ($Path in @(
            $StageBootstrapConfigurationPath,
            $StageConfigurationPath,
            $StagePresetPath,
            $StageEffectPath,
            $StageForeignAddonPath
        )) {
        (Get-Item -LiteralPath $Path -Force).IsReadOnly = $true
    }
    $BootstrapSeedHash =
        Get-FileSha256 -Path $StageBootstrapConfigurationPath

    Save-JsonEvidence `
        -Value ([pscustomobject]@{
            SourceRuntimePath = $OfficialRuntimePath
            SourceRuntimeSha256 = $OfficialRuntimeHash
            SourceRuntimeProductVersion =
                (Get-Item -LiteralPath $OfficialRuntimePath).VersionInfo.ProductVersion
            ForeignAddonSourceCommit = $ForeignSourceCommit
            ForeignAddonPath = $ForeignAddon
            ForeignAddonSha256 = $ForeignAddonHash
            AddonBuildId = $PackageBuildStamp.addonBuildId
            ProductionAddonSha256 = $ProductionAddonHash
        }) `
        -Path (Join-Path $RunDirectory "fixture-provenance.json")

    # Build time can be long enough for another app to create a collision.
    # Re-check immediately before the first target-directory write.
    Assert-NoScopedProcesses
    Assert-CleanTargetDirectory

    # Each root-level seed uses an atomic no-replace create. Ownership is
    # recorded only after this process created the exact path, so a collision
    # that appears after the preflight is never overwritten or later removed.
    Copy-NewSeedFile `
        -Source $StageRuntimePath `
        -Destination $TargetRuntimePath `
        -OwnershipFlag "TargetRuntimeSeedOwned"
    $TargetSeeded = $true
    Copy-NewSeedFile `
        -Source $StageBootstrapConfigurationPath `
        -Destination $TargetBootstrapConfigurationPath `
        -OwnershipFlag "TargetBootstrapSeedOwned"

    $null = New-Item `
        -ItemType Directory `
        -Path $TargetTestRoot `
        -ErrorAction Stop
    $TargetTestRootOwned = $true
    foreach ($Directory in @(
            $TargetAddonDirectory,
            $TargetShaderDirectory,
            $TargetCacheDirectory,
            (Join-Path $TargetTestRoot "textures")
        )) {
        $null = New-Item `
            -ItemType Directory `
            -Path $Directory `
            -ErrorAction Stop
    }
    foreach ($Seed in @(
            [pscustomobject]@{
                Source = $StageConfigurationPath
                Destination = $TargetConfigurationPath
            },
            [pscustomobject]@{
                Source = $StagePresetPath
                Destination = $TargetPresetPath
            },
            [pscustomobject]@{
                Source = $StageEffectPath
                Destination = $TargetEffectPath
            },
            [pscustomobject]@{
                Source = $StageForeignAddonPath
                Destination = $TargetForeignAddonPath
            }
        )) {
        [IO.File]::Copy($Seed.Source, $Seed.Destination, $false)
    }
    foreach ($Path in @(
            $TargetBootstrapConfigurationPath,
            $TargetConfigurationPath,
            $TargetPresetPath,
            $TargetEffectPath,
            $TargetForeignAddonPath
        )) {
        (Get-Item -LiteralPath $Path -Force).IsReadOnly = $true
    }
    if ((Get-FileSha256 -Path $TargetRuntimePath) -cne
        $OfficialRuntimeHash -or
        (Get-FileSha256 -Path $TargetForeignAddonPath) -cne
        $ForeignAddonHash) {
        throw "A target seed copy changed before manager preparation."
    }

    $ManagerInvocationStarted = $true
    $PrepareResult = Invoke-AddonManager -Operation prepare
    if ($PrepareResult.schemaVersion -ne 1 -or
        $PrepareResult.operation -cne "prepare" -or
        $PrepareResult.status -cne "installed" -or
        $PrepareResult.addonSha256 -cne $ProductionAddonHash -or
        $PrepareResult.reshadeModuleSha256 -cne $OfficialRuntimeHash -or
        -not ([string]$PrepareResult.addonPath).Equals(
            [IO.Path]::GetFullPath($TargetOwnedAddonPath),
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not ([string]$PrepareResult.markerPath).Equals(
            [IO.Path]::GetFullPath($TargetOwnershipMarkerPath),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw (
            "The native manager returned an unexpected preparation result: " +
            ($PrepareResult | ConvertTo-Json -Compress)
        )
    }
    $ManagerPrepared = $true

    $ProtectedSeedPaths = @(
        $TargetRuntimePath,
        $TargetBootstrapConfigurationPath,
        $TargetConfigurationPath,
        $TargetPresetPath,
        $TargetEffectPath,
        $TargetForeignAddonPath,
        $TargetOwnedAddonPath,
        $TargetOwnershipMarkerPath
    )
    $ProtectedSeedManifest = @(
        $ProtectedSeedPaths |
            ForEach-Object { Get-PathSnapshot -Path $_ }
    )
    Save-JsonEvidence `
        -Value $ProtectedSeedManifest `
        -Path (Join-Path $RunDirectory "target-seed-manifest.json")

    $ClientArguments = @(
        "`"$RepoRoot`"",
        "--no-sandbox",
        "--reshade-overlay",
        "--steam-auto-attach",
        "--start-overlay-session",
        "--gun-frog-input-proof",
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

    $StartupDeadline = [DateTime]::UtcNow.AddSeconds(90)
    Wait-ForClientMarker `
        -Marker "STEAM_GAME_PROCESS_WATCHER_READY" `
        -Deadline $StartupDeadline
    Wait-ForClientMarker `
        -Marker "STEAM_GAME_AUTO_ATTACH_ARMING" `
        -Deadline $StartupDeadline

    $RunOwnsTargetLaunch = $true
    Start-Process -FilePath $LaunchUri | Out-Null
    $StartupDeadline = [DateTime]::UtcNow.AddSeconds(150)
    Wait-ForClientMarker `
        -Marker "RESHADE_CLIENT_INJECTOR_RETURNED" `
        -Deadline $StartupDeadline
    Wait-ForClientMarker `
        -Marker "RESHADE_CLIENT_TARGET_CONNECTED" `
        -Deadline $StartupDeadline
    Wait-ForClientMarker `
        -Marker "STEAM_GAME_AUTO_ATTACH_CONNECTED" `
        -Deadline $StartupDeadline
    Wait-ForClientMarker `
        -Marker "HUDHOOK_CLIENT_GUN_FROG_PROOF_READY" `
        -Deadline $StartupDeadline

    $TargetProcessId = Get-ConnectedTargetProcessId
    $TargetProcess = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId=$TargetProcessId" `
        -ErrorAction SilentlyContinue
    if (-not $TargetProcess -or
        -not $TargetProcess.ExecutablePath -or
        -not [string]::Equals(
            $TargetProcess.ExecutablePath,
            $TargetExecutablePath,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw (
            "The authenticated PID $TargetProcessId is not the exact " +
            "installed Gun Frog executable."
        )
    }

    $ReShadeRunDirectory = Get-ReShadeRunDirectory `
        -TargetPid $TargetProcessId `
        -TargetPath $TargetExecutablePath
    $InjectorStdout = Join-Path $ReShadeRunDirectory "inject.stdout.log"
    if (-not (Test-Path -LiteralPath $InjectorStdout -PathType Leaf)) {
        throw "The SDK did not retain injector evidence: $InjectorStdout"
    }
    $InjectorResultPrefix = "ELECTRON_GAME_OVERLAY_INJECTOR_RESULT "
    $InjectorResultLines = @(
        Get-Content -LiteralPath $InjectorStdout |
            Where-Object { $_.StartsWith($InjectorResultPrefix) }
    )
    if ($InjectorResultLines.Count -ne 1) {
        throw (
            "Expected one structured official-add-on result, found " +
            "$($InjectorResultLines.Count)."
        )
    }
    $InjectorResult =
        $InjectorResultLines[0].Substring($InjectorResultPrefix.Length) |
        ConvertFrom-Json
    if ($InjectorResult.schemaVersion -ne 1 -or
        $InjectorResult.pid -ne $TargetProcessId -or
        $InjectorResult.runtimeMode -cne "official-addon" -or
        $InjectorResult.addonAbi -ne 1 -or
        $InjectorResult.addonBuildId -cne
            $PackageBuildStamp.addonBuildId -or
        $InjectorResult.electronGameOverlayAddonDisabled -ne $false -or
        -not ([string]$InjectorResult.targetExecutablePath).Equals(
            [IO.Path]::GetFullPath($TargetExecutablePath),
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not ([string]$InjectorResult.reshadeBasePath).Equals(
            [IO.Path]::GetFullPath($TargetTestRoot),
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not ([string]$InjectorResult.addonDirectoryPath).Equals(
            [IO.Path]::GetFullPath($TargetAddonDirectory),
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not ([string]$InjectorResult.runtimeModulePath).Equals(
            [IO.Path]::GetFullPath($TargetRuntimePath),
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not ([string]$InjectorResult.addonModulePath).Equals(
            [IO.Path]::GetFullPath($TargetOwnedAddonPath),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw (
            "The injector did not select the exact official-add-on " +
            "installation: " +
            ($InjectorResult | ConvertTo-Json -Compress)
        )
    }

    $LoadedModules = @(
        (Get-Process -Id $TargetProcessId -ErrorAction Stop).Modules
    )
    foreach ($ExpectedModulePath in @(
            $TargetRuntimePath,
            $TargetForeignAddonPath,
            $TargetOwnedAddonPath
        )) {
        $Matches = @(
            $LoadedModules |
                Where-Object {
                    $_.FileName -and
                    [string]::Equals(
                        [IO.Path]::GetFullPath($_.FileName),
                        [IO.Path]::GetFullPath($ExpectedModulePath),
                        [StringComparison]::OrdinalIgnoreCase
                    )
                }
        )
        if ($Matches.Count -ne 1) {
            throw (
                "Gun Frog did not load exactly one expected module: " +
                $ExpectedModulePath
            )
        }
    }
    $UnexpectedProjectRuntime = @(
        $LoadedModules |
            Where-Object {
                $_.FileName -and
                [IO.Path]::GetFileName($_.FileName) -ieq "ReShade64.dll"
            }
    )
    if ($UnexpectedProjectRuntime.Count -ne 0) {
        throw (
            "The official-host gate also loaded a project ReShade64.dll: " +
            ($UnexpectedProjectRuntime.FileName -join ", ")
        )
    }

    Wait-ForReShadeEvidence -Deadline $StartupDeadline
    if (-not (Get-Process `
            -Id $TargetProcessId `
            -ErrorAction SilentlyContinue)) {
        throw "Gun Frog disappeared before the manual input proof."
    }

    Write-Host ""
    Write-Host (
        "REAL GUN FROG OFFICIAL RESHADE COEXISTENCE GATE READY " +
        "(PID $TargetProcessId)"
    )
    Write-Host "  - Stock ReShade loaded its pass-through witness effect."
    Write-Host "  - Stock API-18 FPS Limiter and Electron overlay add-ons both loaded."
    Write-Host "  1. Click Electron Continue, New Game, Settings, and Quit once each."
    Write-Host "  2. Gun Frog must remain on its menu through all four clicks."
    Write-Host "  3. Wait for the runner to accept those clicks before pressing Ctrl+I."
    Write-Host "Client evidence: $ClientStdout"
    Write-Host "Official ReShade evidence: $TargetLogPath"
    Write-Host ""

    $ClickMarkers = @(
        "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click name=continue",
        "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click name=new-game",
        "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click name=settings",
        "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click name=quit"
    )
    $InteractionDeadline =
        [DateTime]::UtcNow.AddSeconds($InteractionTimeoutSeconds)
    $OverlayClicksObservedWhileAlive = $false
    while ([DateTime]::UtcNow -lt $InteractionDeadline) {
        $ClientProcess.Refresh()
        if ($ClientProcess.HasExited) {
            throw "The production client exited during the interaction proof."
        }
        if (-not (Get-Process `
                -Id $TargetProcessId `
                -ErrorAction SilentlyContinue)) {
            throw (
                "Gun Frog closed before all four intercepted Electron clicks " +
                "were accepted while the target was alive."
            )
        }

        $CurrentClientLog = Get-ClientLogText
        $AllClickMarkersPresent = $true
        foreach ($Marker in $ClickMarkers) {
            if (-not $CurrentClientLog.Contains($Marker)) {
                $AllClickMarkersPresent = $false
                break
            }
        }
        if ($AllClickMarkersPresent) {
            Assert-ExactlyOneMarker `
                -Text $CurrentClientLog `
                -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true"
            foreach ($Marker in $ClickMarkers) {
                Assert-ExactlyOneMarker `
                    -Text $CurrentClientLog `
                    -Marker $Marker
            }
            if ($CurrentClientLog.Contains(
                    "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false"
                )) {
                throw (
                    "Input was released before the runner accepted all four " +
                    "overlay clicks while Gun Frog remained alive."
                )
            }

            # Keep the game alive beyond the intercepted Quit edge before
            # inviting release. This catches the exact clickthrough regression
            # the proof is intended to reject.
            $ClickStabilityDeadline =
                [DateTime]::UtcNow.AddMilliseconds(500)
            while ([DateTime]::UtcNow -lt $ClickStabilityDeadline) {
                if (-not (Get-Process `
                        -Id $TargetProcessId `
                        -ErrorAction SilentlyContinue)) {
                    throw (
                        "Gun Frog closed after the intercepted Quit click and " +
                        "before input release."
                    )
                }
                Start-Sleep -Milliseconds 25
            }
            $OverlayClicksObservedWhileAlive = $true
            break
        }
        Start-Sleep -Milliseconds 25
    }
    if (-not $OverlayClicksObservedWhileAlive) {
        throw (
            "Timed out waiting for all four intercepted Electron clicks while " +
            "Gun Frog remained alive."
        )
    }

    Write-Host "GUN_FROG_OVERLAY_CLICKS_CAPTURED_WHILE_TARGET_ALIVE"
    Write-Host "  3. Press Ctrl+I to release interception."
    Write-Host "  4. Wait for the runner to accept release before clicking Quit."

    $ReleaseObservedWhileAlive = $false
    while ([DateTime]::UtcNow -lt $InteractionDeadline) {
        $ClientProcess.Refresh()
        if ($ClientProcess.HasExited) {
            throw "The production client exited before input release."
        }
        if (-not (Get-Process `
                -Id $TargetProcessId `
                -ErrorAction SilentlyContinue)) {
            throw "Gun Frog closed before input release was acknowledged."
        }
        $CurrentClientLog = Get-ClientLogText
        if ($CurrentClientLog.Contains(
                "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false"
            )) {
            Assert-ExactlyOneMarker `
                -Text $CurrentClientLog `
                -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false"
            if (-not (Get-Process `
                    -Id $TargetProcessId `
                    -ErrorAction SilentlyContinue)) {
                throw (
                    "Gun Frog closed before released input was accepted while " +
                    "the target was alive."
                )
            }
            $ReleaseObservedWhileAlive = $true
            break
        }
        Start-Sleep -Milliseconds 25
    }
    if (-not $ReleaseObservedWhileAlive) {
        throw "Timed out waiting for input release while Gun Frog remained alive."
    }

    Write-Host "GUN_FROG_INPUT_RELEASED_WHILE_TARGET_ALIVE"
    Write-Host "  5. Click the same Quit position again; Gun Frog must close."
    while ([DateTime]::UtcNow -lt $InteractionDeadline -and
        (Get-Process `
            -Id $TargetProcessId `
            -ErrorAction SilentlyContinue)) {
        $ClientProcess.Refresh()
        if ($ClientProcess.HasExited) {
            throw "The production client exited during the released Quit proof."
        }
        Start-Sleep -Milliseconds 25
    }
    if (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue) {
        throw (
            "Timed out waiting for the released-input Quit click to close " +
            "Gun Frog."
        )
    }

    $ClientLog = Get-ClientLogText
    foreach ($Marker in $ClickMarkers) {
        Assert-ExactlyOneMarker -Text $ClientLog -Marker $Marker
    }
    Assert-ExactlyOneMarker `
        -Text $ClientLog `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true"
    Assert-ExactlyOneMarker `
        -Text $ClientLog `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false"
    Assert-ExactlyOneMarker `
        -Text $ClientLog `
        -Marker "RESHADE_CLIENT_TARGET_CONNECTED pid=$TargetProcessId"
    Assert-ExactlyOneMarker `
        -Text $ClientLog `
        -Marker (
            "STEAM_GAME_AUTO_ATTACH_CONNECTED pid=$TargetProcessId " +
            'processName="Gun Frog.exe"'
        )

    $InterceptEnabledIndex = $ClientLog.IndexOf(
        "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true",
        [StringComparison]::Ordinal
    )
    $InterceptDisabledIndex = $ClientLog.IndexOf(
        "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false",
        [StringComparison]::Ordinal
    )
    foreach ($Marker in $ClickMarkers) {
        $ClickIndex = $ClientLog.IndexOf(
            $Marker,
            [StringComparison]::Ordinal
        )
        if ($ClickIndex -le $InterceptEnabledIndex -or
            $ClickIndex -ge $InterceptDisabledIndex) {
            throw (
                "Click '$Marker' was not bounded by interception enable/release."
            )
        }
    }
    $ClientErrorLog = Get-ClientErrorLogText
    if ([regex]::IsMatch(
            $ClientErrorLog,
            "(?m)^STEAM_GAME_AUTO_ATTACH_FAILED pid=$TargetProcessId(?: .*)?`r?`$"
        )) {
        throw "The client emitted a coexistence attachment failure."
    }

    $OfficialLog = Get-Content -LiteralPath $TargetLogPath -Raw
    if ([regex]::IsMatch(
            $OfficialLog,
            "failed to compile|preprocessor error|out of global sequence|" +
                "router was reset|input.*(failed|error)|queue.*(failed|error)|FATAL",
            [Text.RegularExpressions.RegexOptions]::IgnoreCase
        )) {
        throw "Official ReShade reported a coexistence, effect, or input fault."
    }

    Assert-ProtectedSeedPreserved `
        -Manifest $ProtectedSeedManifest `
        -RestoreTestOwnedMetadata
    $PreservedManifest = @(
        $ProtectedSeedManifest |
            ForEach-Object { Get-PathSnapshot -Path $_.FullPath }
    )
    Save-JsonEvidence `
        -Value $PreservedManifest `
        -Path (Join-Path $RunDirectory "target-preserved-manifest.json")

    $PendingSummary = [pscustomobject]@{
        Result =
            "GUN_FROG_REAL_CLIENT_OFFICIAL_RESHADE_COEXISTENCE_GATE_PASS"
        TargetProcessId = $TargetProcessId
        TargetExecutablePath = $TargetExecutablePath
        RuntimeMode = $InjectorResult.runtimeMode
        OfficialRuntimePath = $TargetRuntimePath
        OfficialRuntimeSha256 = $OfficialRuntimeHash
        ReShadeBasePath = $TargetTestRoot
        AddonDirectoryPath = $TargetAddonDirectory
        AddonBuildId = $PackageBuildStamp.addonBuildId
        ElectronAddonSha256 = $ProductionAddonHash
        ForeignAddon = [pscustomobject]@{
            Name = "FPS Limiter"
            ApiVersion = 18
            SourceCommit = $ForeignSourceCommit
            Sha256 = $ForeignAddonHash
            Loaded = $true
        }
        Effect = [pscustomobject]@{
            Name = "EGOCoexistenceWitness.fx"
            Technique = "EGOCoexistenceWitness"
            Compiled = $true
            EnabledByPreset = $true
        }
        InputProof = [pscustomobject]@{
            CapturedButtons = @(
                "continue",
                "new-game",
                "settings",
                "quit"
            )
            OverlayClicksObservedWhileTargetAlive =
                $OverlayClicksObservedWhileAlive
            ReleaseObservedWhileTargetAlive = $ReleaseObservedWhileAlive
            ReleasedQuitClosedTarget = $true
        }
        OfficialInstallationFilesByteAttributeTimestampIdentical = $true
        ClientStdout = $ClientStdout
        ClientStderr = $ClientStderr
        OfficialReShadeLog = Join-Path $RunDirectory "official-ReShade.log"
        InjectorStdout = $InjectorStdout
    }
}
catch {
    $GateFailure = $_
}
finally {
    try {
        if ($GateMutexHeld) {
            Stop-ScopedProcesses
            if ($ClientProcess -or $RunOwnsTargetLaunch) {
                Start-Sleep -Milliseconds 500
                $RemainingOwnedClients = @(Get-OwnedClientProcesses)
                if ($RemainingOwnedClients.Count -ne 0) {
                    throw (
                        "The gate left Electron child processes: " +
                        ($RemainingOwnedClients.ProcessId -join ", ")
                    )
                }
            }
            if ($ClientProcess -or
                $RunOwnsTargetLaunch -or
                $TargetRuntimeSeedOwned -or
                $TargetBootstrapSeedOwned -or
                $TargetTestRootOwned -or
                $ManagerInvocationStarted) {
                $RemainingTargets = @(Get-MatchingTargets)
                $RemainingInjectors = @(
                    @(
                        Get-OwnedInjectors
                        Get-MatchingInjectors
                    ) |
                        Sort-Object ProcessId -Unique
                )
                if ($RemainingTargets.Count -ne 0 -or
                    $RemainingInjectors.Count -ne 0) {
                    throw (
                        "The gate cannot restore mapped target files while " +
                        "scoped target/injector processes remain (PID: " +
                        (@(
                                @($RemainingTargets.ProcessId) +
                                    @($RemainingInjectors.ProcessId)
                            ) -join ", ") +
                        ")."
                    )
                }
            }
        }

        try {
            if ($GateMutexHeld -and
                (Test-Path -LiteralPath $TargetLogPath -PathType Leaf)) {
                Copy-Item `
                    -LiteralPath $TargetLogPath `
                    -Destination (
                        Join-Path $RunDirectory "official-ReShade.log"
                    ) `
                    -Force
            }
        }
        catch {
            $DeferredCleanupFailures.Add(
                "Could not retain the official ReShade log: " +
                $_.Exception.Message
            )
        }
        try {
            if ($ProtectedSeedManifest.Count -ne 0) {
                Assert-ProtectedSeedPreserved `
                    -Manifest $ProtectedSeedManifest `
                    -RestoreTestOwnedMetadata
            }
        }
        catch {
            $DeferredCleanupFailures.Add(
                "A protected coexistence seed changed: " +
                $_.Exception.Message
            )
        }

        $ManagedArtifactsPresent = (
            $ManagerInvocationStarted -and
            $TargetTestRootOwned -and
            (Test-Path -LiteralPath $TargetOwnedAddonPath)
        ) -or (
            $ManagerInvocationStarted -and
            $TargetTestRootOwned -and
            (Test-Path -LiteralPath $TargetOwnershipMarkerPath)
        ) -or (
            $ManagerInvocationStarted -and
            $TargetTestRootOwned -and
            (Test-Path -LiteralPath $TargetTransactionPath)
        )
        if ($ManagerPrepared -or $ManagedArtifactsPresent) {
            $RemoveResult = Invoke-AddonManager -Operation remove
            if ($RemoveResult.schemaVersion -ne 1 -or
                $RemoveResult.operation -cne "remove" -or
                $RemoveResult.status -notin @(
                    "removed",
                    "not-installed"
                ) -or
                ($ManagerPrepared -and
                    $RemoveResult.status -cne "removed") -or
                ($RemoveResult.status -ceq "removed" -and
                    $RemoveResult.previousAddonSha256 -cne
                        $ProductionAddonHash)) {
                throw (
                    "The native manager returned an unexpected cleanup result: " +
                    ($RemoveResult | ConvertTo-Json -Compress)
                )
            }
            foreach ($ReservedPath in @(
                    $TargetOwnedAddonPath,
                    $TargetOwnershipMarkerPath,
                    $TargetTransactionPath
                )) {
                if (Test-Path -LiteralPath $ReservedPath) {
                    throw (
                        "The native manager left reserved artifact " +
                        "'$ReservedPath'."
                    )
                }
            }
            $ManagerPrepared = $false
        }

        if ($TargetTestRootOwned) {
            Assert-SafeTestRoot
            if (Test-Path -LiteralPath $TargetTestRoot) {
                Assert-NoReparseTree -Path $TargetTestRoot
                $UnexpectedReserved = @(
                    Get-ChildItem `
                        -LiteralPath $TargetAddonDirectory `
                        -Force `
                        -ErrorAction SilentlyContinue |
                        Where-Object {
                            $_.Name -like ".electron-game-overlay-addon*" -or
                            $_.Name -eq "electron_game_overlay.addon64"
                        }
                )
                if ($UnexpectedReserved.Count -ne 0) {
                    throw (
                        "Refusing recursive cleanup while manager-reserved " +
                        "artifacts remain: " +
                        ($UnexpectedReserved.FullName -join ", ")
                    )
                }
                Remove-Item `
                    -LiteralPath $TargetTestRoot `
                    -Recurse `
                    -Force
            }
            $TargetTestRootOwned = $false
        }
        if ($TargetBootstrapSeedOwned) {
            Remove-VerifiedSeedFile `
                -Path $TargetBootstrapConfigurationPath `
                -ExpectedSha256 $BootstrapSeedHash
            $TargetBootstrapSeedOwned = $false
        }
        if ($TargetRuntimeSeedOwned) {
            Remove-VerifiedSeedFile `
                -Path $TargetRuntimePath `
                -ExpectedSha256 $OfficialRuntimeHash
            $TargetRuntimeSeedOwned = $false
        }
        if ($TargetSeeded) {
            $TargetSeeded = $false
        }

        if ($InitialTargetClean) {
            Assert-CleanTargetDirectory
        }
        if ($TargetRootSnapshot) {
            $MetadataRestoreDeadline = [DateTime]::UtcNow.AddSeconds(5)
            while ($true) {
                try {
                    Restore-SnapshotMetadata -Snapshot $TargetRootSnapshot
                    break
                }
                catch {
                    if ([DateTime]::UtcNow -ge $MetadataRestoreDeadline) {
                        throw
                    }
                    Start-Sleep -Milliseconds 100
                }
            }
            $ActualRoot = Get-PathSnapshot -Path $TargetDirectory
            Assert-SnapshotEqual `
                -Expected $TargetRootSnapshot `
                -Actual $ActualRoot
        }
        if (Test-Path -LiteralPath $RunDirectory -PathType Container) {
            Save-JsonEvidence `
                -Value ([pscustomobject]@{
                    TargetDirectory = $TargetDirectory
                    OriginalRootMetadataRestored = $true
                    OriginalReShadeCollisionSetRestored = $true
                    RemovedOnlyTestOwnedSeedPaths = $true
                    ReservedAddonPairRemovedByNativeManager = $true
                }) `
                -Path (Join-Path $RunDirectory "cleanup-proof.json")
        }
        if ($DeferredCleanupFailures.Count -ne 0) {
            throw (
                "Owned target paths were restored, but cleanup evidence or " +
                "preservation checks failed: " +
                ($DeferredCleanupFailures -join " ")
            )
        }
    }
    catch {
        $CleanupFailure = $_
    }
    finally {
        if ($GateMutexHeld) {
            $GateMutex.ReleaseMutex()
            $GateMutexHeld = $false
        }
        $GateMutex.Dispose()
    }
}

if ($CleanupFailure) {
    if ($GateFailure) {
        throw (
            "The gate failed and cleanup also failed. Gate: " +
            $GateFailure.Exception.Message +
            " Cleanup: " +
            $CleanupFailure.Exception.Message +
            " Evidence: " +
            $RunDirectory
        )
    }
    throw $CleanupFailure
}
if ($GateFailure) {
    throw $GateFailure
}
if ($null -eq $PendingSummary) {
    throw "The Gun Frog official-ReShade coexistence gate did not complete."
}

Save-JsonEvidence -Value $PendingSummary -Path $ResultPath
$RunPassed = $true
Write-Host "GUN_FROG_REAL_CLIENT_OFFICIAL_RESHADE_COEXISTENCE_GATE_PASS"
Write-Host "Evidence preserved in: $RunDirectory"
Write-Host "The original clean Gun Frog directory was restored."
