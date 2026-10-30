[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OfficialRuntimePath,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
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
    Join-Path $RuntimeRoot "dist\win32-x64"
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
        (Join-Path $RuntimeDistributionDirectory "ReShade64.dll"),
        (Join-Path $RuntimeDistributionDirectory "ReShade64.build.json"),
        (Join-Path `
            $RuntimeDistributionDirectory `
            "electron_game_overlay_runtime.build.json"),
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
Write-Host "  - The production watcher must connect through official-addon mode."
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
        [Environment]::GetEnvironmentVariable($VariableName, "Process")
    [Environment]::SetEnvironmentVariable($VariableName, $null, "Process")
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
    Assert-ExactTargetProcess `
        -ProcessId $HostPid `
        -ExpectedPath $TargetExecutablePath

    $TargetPathJson = ConvertTo-Json `
        -InputObject ([IO.Path]::GetFullPath($TargetExecutablePath)) `
        -Compress
    $EscapedTargetPathJson = [regex]::Escape($TargetPathJson)
    $TargetDescriptionJson = ConvertTo-Json `
        -InputObject $HostName `
        -Compress
    $EscapedTargetDescriptionJson =
        [regex]::Escape($TargetDescriptionJson)
    $InitialInjectorArgumentsJson = ConvertTo-Json `
        -InputObject @($HostName, "--pid", [string]$HostPid) `
        -Compress
    $EscapedInitialInjectorArgumentsJson =
        [regex]::Escape($InitialInjectorArgumentsJson)
    $AddonWaitArgumentsJson = ConvertTo-Json `
        -InputObject @(
            $HostName,
            "--pid",
            [string]$HostPid,
            "--wait-for-official-addon",
            "30000"
        ) `
        -Compress
    $EscapedAddonWaitArgumentsJson =
        [regex]::Escape($AddonWaitArgumentsJson)

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
            "arguments=$EscapedInitialInjectorArgumentsJson\r?`$"
        ) `
        -Deadline $StartupDeadline
    $AddonWaitStarted = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern (
            "(?m)^RESHADE_CLIENT_INJECTOR_STARTED " +
            "target=$EscapedTargetDescriptionJson " +
            "arguments=$EscapedAddonWaitArgumentsJson\r?`$"
        ) `
        -Deadline $StartupDeadline

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
    if ($Detected.Index -ge $InjectorStarted.Index -or
        $InjectorStarted.Index -ge $AddonWaitStarted.Index -or
        $AddonWaitStarted.Index -gt $PreReleaseClientLogBoundaryIndex -or
        $InjectorReturned.Index -le $PreReleaseClientLogBoundaryIndex -or
        $InjectorReturned.Index -ge $Connected.Index -or
        $InjectorReturned.Index -ge $AutoConnected.Index) {
        throw (
            "The production lifecycle was not watcher detection -> pending " +
            "injector -> startup release -> official add-on return -> " +
            "authenticated transport/auto-attach connection."
        )
    }

    $TargetInjectorResults = @(
        Get-StructuredInjectorResults |
            Where-Object { $_.Result.pid -eq $HostPid }
    )
    if ($TargetInjectorResults.Count -ne 1) {
        throw (
            "Expected exactly one structured injector result/native grace " +
            "owner for controlled PID $HostPid; found " +
            "$($TargetInjectorResults.Count)."
        )
    }
    $InjectorResult = $TargetInjectorResults[0].Result
    if ($InjectorResult.schemaVersion -ne 1 -or
        $InjectorResult.runtimeMode -cne "official-addon" -or
        $InjectorResult.addonAbi -ne 1 -or
        $InjectorResult.electronGameOverlayAddonDisabled -ne $false -or
        -not ([string]$InjectorResult.targetExecutablePath).Equals(
            [IO.Path]::GetFullPath($TargetExecutablePath),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$InjectorResult.runtimeModulePath).Equals(
            $ExpectedRuntimePath,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$InjectorResult.addonModulePath).Equals(
            $ExpectedAddonPath,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$InjectorResult.addonDirectoryPath).Equals(
            [IO.Path]::GetFullPath($AddonDirectory),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw (
            "The production injector did not return the expected " +
            "version-agnostic official-addon contract: " +
            ($InjectorResult | ConvertTo-Json -Compress)
        )
    }

    $LoadedAfterConnection = @(
        ([Diagnostics.Process]::GetProcessById($HostPid)).Modules
    )
    foreach ($ExpectedModulePath in @(
            $ExpectedRuntimePath,
            $ExpectedAddonPath)) {
        $Matches = @(
            $LoadedAfterConnection |
                Where-Object {
                    $_.FileName -and
                    [string]::Equals(
                        [IO.Path]::GetFullPath($_.FileName),
                        $ExpectedModulePath,
                        [StringComparison]::OrdinalIgnoreCase)
                }
        )
        if ($Matches.Count -ne 1) {
            throw (
                "The connected target did not map expected official-add-on " +
                "module exactly once: $ExpectedModulePath"
            )
        }
    }
    $UnexpectedProjectRuntimePath = [IO.Path]::GetFullPath(
        (Join-Path $RuntimeDistributionDirectory "ReShade64.dll")
    )
    $UnexpectedProjectRuntime = @(
        $LoadedAfterConnection |
            Where-Object {
                $_.FileName -and
                [string]::Equals(
                    [IO.Path]::GetFullPath($_.FileName),
                    $UnexpectedProjectRuntimePath,
                    [StringComparison]::OrdinalIgnoreCase)
            }
    )
    if ($UnexpectedProjectRuntime.Count -ne 0) {
        throw (
            "The production launcher loaded its project ReShade runtime " +
            "beside the upgraded existing runtime."
        )
    }

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
            WatcherDetectedMarkerIndex = $Detected.Index
            InjectorStartedMarkerIndex = $InjectorStarted.Index
            AddonWaitStartedMarkerIndex = $AddonWaitStarted.Index
            StartupReleaseLogBoundaryIndex = $PreReleaseClientLogBoundaryIndex
            InjectorReturnedMarkerIndex = $InjectorReturned.Index
            TargetConnectedMarkerIndex = $Connected.Index
            AutoAttachConnectedMarkerIndex = $AutoConnected.Index
            WatcherReleasedMarkerIndex = $Released.Index
            RuntimeMode = [string]$InjectorResult.runtimeMode
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
            [Environment]::SetEnvironmentVariable(
                $VariableName,
                $PreviousEnvironment[$VariableName],
                "Process")
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
