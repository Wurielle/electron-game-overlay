[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OfficialRuntimePath,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# Reuse the controlled-host, process-discovery, cleanup, window, and native
# input helpers without running the normal successful-injection gate.
. (Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1") `
    -Backend d3d11 `
    -SkipBuild:$SkipBuild `
    -FunctionsOnly

$GateSlug = "existing-reshade-installation"
$RunDirectory = Join-Path `
    $BuildRoot `
    "client-sdk-d3d11-$GateSlug-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$TargetDirectory = Join-Path $RunDirectory "target"
$TargetExecutablePath = Join-Path $TargetDirectory $HostName
$OfficialRuntimeTargetPath =
    Join-Path $TargetDirectory "official-reshade-inactive.dll"
$OfficialConfigurationPath = Join-Path $TargetDirectory "ReShade.ini"
$OfficialCacheDirectory = Join-Path $RunDirectory "official-cache"
$StartupBarrierFileName = "electron-game-overlay-startup-barrier.enabled"
$StartupBarrierPath = Join-Path $TargetDirectory $StartupBarrierFileName
$UserData = Join-Path $RunDirectory "user-data"
$ClientStdout = Join-Path $RunDirectory "client.stdout.log"
$ClientStderr = Join-Path $RunDirectory "client.stderr.log"
$ResultMarker =
    "D3D11_REAL_CLIENT_SDK_EXISTING_RESHADE_INSTALLATION_GATE_PASS"
$ExpectedDiagnosticCode = "target-existing-reshade-installation"
$DiagnosticPrefix = "ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC "
$ResultPrefix = "ELECTRON_GAME_OVERLAY_INJECTOR_RESULT "
$ClientProcess = $null
$HostProcess = $null
$ReShadeRunDirectory = $null
$HostExitedNormally = $false
$Summary = $null

function Wait-ForLogRegex {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
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
            throw "The production Electron client exited while waiting for '$Pattern'. Inspect $Path."
        }
        Start-Sleep -Milliseconds 50
    }

    throw "Timed out waiting for client pattern '$Pattern'. Inspect $Path."
}

function Get-StagedRunDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [Text.RegularExpressions.Match]$Match
    )

    $Directory = $Match.Groups["directory"].Value | ConvertFrom-Json
    if (-not [IO.Path]::IsPathRooted($Directory)) {
        throw "The SDK staged a non-absolute ReShade run directory: $Directory"
    }
    return [IO.Path]::GetFullPath($Directory)
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
    throw "Controlled target PID $ProcessId came from an unexpected path/command: path=$($Target.ExecutablePath) command=$($Target.CommandLine)"
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
        Get-ChildItem -LiteralPath $Path -Recurse -File |
            ForEach-Object {
                $FullPath = [IO.Path]::GetFullPath($_.FullName)
                if (-not $FullPath.StartsWith(
                        $RootPath,
                        [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Manifest entry escaped the controlled target directory: $FullPath"
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

function Get-ComparableManifestJson {
    param(
        [Parameter(Mandatory = $true)][object[]]$Manifest,
        [string[]]$IgnoredRelativePaths = @()
    )

    $Ignored = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($RelativePath in $IgnoredRelativePaths) {
        [void]$Ignored.Add($RelativePath.Replace("\", "/"))
    }

    return @(
        $Manifest |
            Where-Object { -not $Ignored.Contains($_.RelativePath) }
    ) | ConvertTo-Json -Depth 4 -Compress
}

function Assert-ManifestsEqual {
    param(
        [Parameter(Mandatory = $true)][object[]]$Expected,
        [Parameter(Mandatory = $true)][object[]]$Actual,
        [string[]]$IgnoredRelativePaths = @(),
        [Parameter(Mandatory = $true)][string]$Boundary
    )

    $ExpectedJson = Get-ComparableManifestJson `
        -Manifest $Expected `
        -IgnoredRelativePaths $IgnoredRelativePaths
    $ActualJson = Get-ComparableManifestJson `
        -Manifest $Actual `
        -IgnoredRelativePaths $IgnoredRelativePaths
    if ($ExpectedJson -cne $ActualJson) {
        throw "The controlled ReShade installation changed across '$Boundary'. Compare the preserved manifest JSON files."
    }
}

function Wait-ForStableDirectoryManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )

    $Previous = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        $Current = Get-DirectoryManifest -Path $Path
        if ($null -ne $Previous) {
            $PreviousJson = Get-ComparableManifestJson -Manifest $Previous
            $CurrentJson = Get-ComparableManifestJson -Manifest $Current
            if ($PreviousJson -ceq $CurrentJson) {
                return $Current
            }
        }
        $Previous = $Current

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "The controlled host exited before its ReShade installation became stable."
        }
        Start-Sleep -Milliseconds 250
    }

    throw "The controlled ReShade installation did not become stable before attachment."
}

function Save-JsonEvidence {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$Depth = 8
    )

    $Value |
        ConvertTo-Json -Depth $Depth |
        Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-ProcessModuleSnapshot {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    return @(
        ([Diagnostics.Process]::GetProcessById($ProcessId)).Modules |
            Where-Object { $_.FileName } |
            ForEach-Object {
                [pscustomobject]@{
                    ModuleName = $_.ModuleName
                    FileName = [IO.Path]::GetFullPath($_.FileName)
                    ModuleMemorySize = [int64]$_.ModuleMemorySize
                }
            } |
            Sort-Object FileName
    )
}

function Assert-CandidateAndProjectModulesAbsent {
    param(
        [Parameter(Mandatory = $true)][object[]]$Modules,
        [Parameter(Mandatory = $true)][string]$InstallationCandidate,
        [Parameter(Mandatory = $true)][string]$StagedRuntime,
        [Parameter(Mandatory = $true)][string]$StagedAddon,
        [Parameter(Mandatory = $true)][string]$Boundary
    )

    $CandidateMatches = @(
        $Modules |
            Where-Object {
                [string]::Equals(
                    $_.FileName,
                    $InstallationCandidate,
                    [StringComparison]::OrdinalIgnoreCase)
            }
    )
    if ($CandidateMatches.Count -ne 0) {
        throw "The inactive ReShade installation candidate was unexpectedly loaded at '$Boundary': $InstallationCandidate"
    }

    $ForbiddenModules = @(
        $Modules |
            Where-Object {
                [string]::Equals(
                    $_.FileName,
                    $StagedRuntime,
                    [StringComparison]::OrdinalIgnoreCase) -or
                [string]::Equals(
                    $_.FileName,
                    $StagedAddon,
                    [StringComparison]::OrdinalIgnoreCase) -or
                [string]::Equals(
                    [IO.Path]::GetFileName($_.FileName),
                    "electron_game_overlay.addon64",
                    [StringComparison]::OrdinalIgnoreCase)
            }
    )
    if ($ForbiddenModules.Count -ne 0) {
        throw "The project runtime/add-on was loaded despite the existing ReShade installation at '$Boundary': $($ForbiddenModules.FileName -join ', ')"
    }

    $SystemDxgi = @(
        $Modules |
            Where-Object {
                [string]::Equals(
                    [IO.Path]::GetFileName($_.FileName),
                    "dxgi.dll",
                    [StringComparison]::OrdinalIgnoreCase)
            }
    )
    if ($SystemDxgi.Count -ne 1 -or
        [string]::Equals(
            $SystemDxgi[0].FileName,
            $InstallationCandidate,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The controlled D3D11 host did not retain one non-candidate DXGI module at '$Boundary'."
    }
}

function Get-OwnedInjectorProcesses {
    if (-not $ReShadeRunDirectory) {
        return @()
    }
    $ExpectedInjectorPath = [IO.Path]::GetFullPath(
        (Join-Path $ReShadeRunDirectory "inject.exe")
    )
    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name='inject.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                [string]::Equals(
                    [IO.Path]::GetFullPath($_.ExecutablePath),
                    $ExpectedInjectorPath,
                    [StringComparison]::OrdinalIgnoreCase)
            }
    )
}

function Stop-OwnedProcesses {
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

    foreach ($Injector in @(Get-OwnedInjectorProcesses)) {
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

if (-not (Test-Path -LiteralPath $OfficialRuntimePath -PathType Leaf)) {
    throw "The official/stock ReShade runtime is unavailable: $OfficialRuntimePath"
}
$ResolvedOfficialRuntime = (
    Resolve-Path -LiteralPath $OfficialRuntimePath -ErrorAction Stop
).Path
if ([IO.Path]::GetExtension($ResolvedOfficialRuntime) -ine ".dll") {
    throw "The official/stock ReShade runtime must be a DLL: $ResolvedOfficialRuntime"
}

if (-not (Test-Path -LiteralPath $Electron -PathType Leaf)) {
    throw "Electron is unavailable: $Electron"
}
if (-not (Test-Path -LiteralPath $Nx -PathType Leaf)) {
    throw "The local Nx CLI is unavailable: $Nx"
}

$ExistingHosts = Get-MatchingHosts
$ExistingClients = Get-MatchingClientProcesses
$ExistingInjectors = Get-MatchingInjectors
if ($ExistingHosts.Count -ne 0 -or
    $ExistingClients.Count -ne 0 -or
    $ExistingInjectors.Count -ne 0) {
    $ProcessIds = @(
        @($ExistingHosts.ProcessId) +
            @($ExistingClients.ProcessId) +
            @($ExistingInjectors.ProcessId) |
            Where-Object { $null -ne $_ }
    )
    throw "Close the existing controlled host/ReShade client run before this test (PID: $($ProcessIds -join ', '))."
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
            throw "The controlled D3D11 host build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $BuiltHost -PathType Leaf)) {
    throw "The controlled D3D11 host is unavailable: $BuiltHost"
}

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $OfficialCacheDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $UserData -Force | Out-Null
New-Item `
    -ItemType Directory `
    -Path (Join-Path $TargetDirectory "existing-addons") `
    -Force | Out-Null
New-Item `
    -ItemType Directory `
    -Path (Join-Path $TargetDirectory "existing-effects") `
    -Force | Out-Null
New-Item `
    -ItemType Directory `
    -Path (Join-Path $TargetDirectory "existing-textures") `
    -Force | Out-Null

Copy-Item -LiteralPath $BuiltHost -Destination $TargetExecutablePath
Copy-Item `
    -LiteralPath $ResolvedOfficialRuntime `
    -Destination $OfficialRuntimeTargetPath
New-Item -ItemType File -Path $StartupBarrierPath -Force | Out-Null
New-Item `
    -ItemType File `
    -Path (Join-Path $TargetDirectory "reshade-input-gate.enabled") `
    -Force | Out-Null

@"
[INSTALL]
BasePath=.

[ADDON]
AddonPath=.\existing-addons
DisabledAddons=Existing Installation Canary@existing-installation-canary.addon64

[GENERAL]
EffectSearchPaths=.\existing-effects
IntermediateCachePath=$OfficialCacheDirectory
NoDebugInfo=1
NoEffectCache=0
NoReloadOnInit=0
PerformanceMode=0
PresetPath=.\ReShadePreset.ini
SkipLoadingDisabledEffects=1
TextureSearchPaths=.\existing-textures

[INPUT]
InputProcessing=2
KeyOverlay=36,0,0,0

[OVERLAY]
AutoSavePreset=0
ShowClock=0
ShowFPS=0
ShowFrameTime=0
ShowPresetName=0
ShowScreenshotMessage=0
TutorialProgress=4
"@ | Set-Content -LiteralPath $OfficialConfigurationPath -Encoding UTF8

@"
[GENERAL]
PreprocessorDefinitions=
Techniques=
TechniqueSorting=
"@ |
    Set-Content `
        -LiteralPath (Join-Path $TargetDirectory "ReShadePreset.ini") `
        -Encoding UTF8

@"
// Existing installation effect canary.
// It is deliberately disabled by the empty preset and must remain byte-exact.
"@ |
    Set-Content `
        -LiteralPath (
            Join-Path `
                $TargetDirectory `
                "existing-effects\existing-installation-canary.fx"
        ) `
        -Encoding UTF8

@"
Existing installation add-on canary.
The seeded ReShade configuration disables this filename before discovery.
"@ |
    Set-Content `
        -LiteralPath (
            Join-Path `
                $TargetDirectory `
                "existing-addons\existing-installation-canary.addon64"
        ) `
        -Encoding UTF8

$OnePixelPng = [Convert]::FromBase64String(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
[IO.File]::WriteAllBytes(
    (Join-Path `
        $TargetDirectory `
        "existing-textures\existing-installation-canary.png"),
    $OnePixelPng
)

@"
This file belongs to the modeled pre-existing ReShade installation.
The Electron overlay must not modify, replace, or remove it.
"@ |
    Set-Content `
        -LiteralPath (
            Join-Path $TargetDirectory "existing-installation-canary.txt"
        ) `
        -Encoding UTF8

$SeedManifest = Get-DirectoryManifest -Path $TargetDirectory
$SeedManifestPath = Join-Path $RunDirectory "seed-manifest.json"
Save-JsonEvidence -Value $SeedManifest -Path $SeedManifestPath

$OfficialSourceHash = (
    Get-FileHash `
        -Algorithm SHA256 `
        -LiteralPath $ResolvedOfficialRuntime
).Hash
$OfficialTargetHash = (
    Get-FileHash `
        -Algorithm SHA256 `
        -LiteralPath $OfficialRuntimeTargetPath
).Hash
if ($OfficialTargetHash -ne $OfficialSourceHash) {
    throw "The isolated target-local runtime does not match the supplied official/stock runtime."
}

Write-Host ""
Write-Host "Production client/SDK D3D11 existing ReShade installation no-break gate"
Write-Host "  - Official/stock runtime source: $ResolvedOfficialRuntime"
Write-Host "  - Inactive isolated target copy: $OfficialRuntimeTargetPath"
Write-Host "  - The host loads system DXGI and waits behind a pre-device barrier."
Write-Host "  - The production SDK requests this exact PID and must fail before injection."
Write-Host "  - The on-disk stock runtime, configuration, add-on/effect, and canaries are preserved."
Write-Host "  - The barrier is then released and the controlled host must exit normally."
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
    $HostProcess = Start-Process `
        -FilePath $TargetExecutablePath `
        -WorkingDirectory $TargetDirectory `
        -PassThru
    $HostPid = $HostProcess.Id
    Assert-ExactTargetProcess `
        -ProcessId $HostPid `
        -ExpectedPath $TargetExecutablePath

    $GraphicsModuleDeadline = [DateTime]::UtcNow.AddSeconds(10)
    $PreAttachModules = $null
    while ([DateTime]::UtcNow -lt $GraphicsModuleDeadline) {
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) {
            throw "The controlled host exited before reaching its startup barrier."
        }
        $CandidateModules = Get-ProcessModuleSnapshot -ProcessId $HostPid
        $LoadedDxgi = @(
            $CandidateModules |
                Where-Object {
                    [string]::Equals(
                        [IO.Path]::GetFileName($_.FileName),
                        "dxgi.dll",
                        [StringComparison]::OrdinalIgnoreCase)
                }
        )
        if ($LoadedDxgi.Count -eq 1 -and
            -not [string]::Equals(
                $LoadedDxgi[0].FileName,
                [IO.Path]::GetFullPath($OfficialRuntimeTargetPath),
                [StringComparison]::OrdinalIgnoreCase)) {
            $PreAttachModules = $CandidateModules
            break
        }
        Start-Sleep -Milliseconds 50
    }
    if ($null -eq $PreAttachModules) {
        throw "The controlled host did not load system DXGI before attachment."
    }
    Start-Sleep -Milliseconds 250
    $HostProcess.Refresh()
    if ($HostProcess.HasExited -or
        $HostProcess.MainWindowHandle -ne [IntPtr]::Zero -or
        -not (Test-Path -LiteralPath $StartupBarrierPath -PathType Leaf)) {
        throw "The controlled host was not held at its pre-device startup barrier."
    }

    $PreAttachModules = Get-ProcessModuleSnapshot -ProcessId $HostPid
    $PreAttachModulesPath = Join-Path $RunDirectory "pre-attach-modules.json"
    Save-JsonEvidence -Value $PreAttachModules -Path $PreAttachModulesPath
    Assert-CandidateAndProjectModulesAbsent `
        -Modules $PreAttachModules `
        -InstallationCandidate (
            [IO.Path]::GetFullPath($OfficialRuntimeTargetPath)
        ) `
        -StagedRuntime (
            Join-Path $RunDirectory "not-staged-yet-ReShade64.dll"
        ) `
        -StagedAddon (
            Join-Path $RunDirectory "not-staged-yet-electron_game_overlay.addon64"
        ) `
        -Boundary "pre-attach"

    $PreAttachManifest = Wait-ForStableDirectoryManifest `
        -Path $TargetDirectory `
        -Process $HostProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    $PreAttachManifestPath = Join-Path $RunDirectory "pre-attach-manifest.json"
    Save-JsonEvidence `
        -Value $PreAttachManifest `
        -Path $PreAttachManifestPath
    Assert-ManifestsEqual `
        -Expected $SeedManifest `
        -Actual $PreAttachManifest `
        -Boundary "controlled host startup barrier"

    $ClientArguments = @(
        "`"$RepoRoot`"",
        "--no-sandbox",
        "--reshade-overlay",
        "--start-overlay-session",
        "--reshade-auto-target-process=$HostName",
        "--reshade-expected-target-pid=$HostPid",
        "`"--user-data-dir=$UserData`""
    )
    $ClientProcess = Start-Process `
        -FilePath $Electron `
        -ArgumentList $ClientArguments `
        -WorkingDirectory $RepoRoot `
        -RedirectStandardOutput $ClientStdout `
        -RedirectStandardError $ClientStderr `
        -PassThru

    $AttachDeadline = [DateTime]::UtcNow.AddSeconds(120)
    $Staged = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(?<directory>.+)\r?$' `
        -Deadline $AttachDeadline
    $ReShadeRunDirectory = Get-StagedRunDirectory -Match $Staged
    $ReShadeRunDirectory |
        Set-Content `
            -LiteralPath (Join-Path $RunDirectory "reshade-run-directory.txt") `
            -Encoding UTF8

    $InjectorStarted = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern '(?m)^RESHADE_CLIENT_INJECTOR_STARTED target=.+ arguments=(?<arguments>\[.+\])\r?$' `
        -Deadline $AttachDeadline
    [object[]]$InjectorArguments =
        $InjectorStarted.Groups["arguments"].Value | ConvertFrom-Json
    $ExpectedInjectorArguments = @($HostName, "--pid", [string]$HostPid)
    if (($InjectorArguments | ConvertTo-Json -Compress) -cne
        ($ExpectedInjectorArguments | ConvertTo-Json -Compress)) {
        throw "The production SDK did not invoke the injector with the exact controlled PID: $($InjectorArguments | ConvertTo-Json -Compress)"
    }

    $InjectorFailed = Wait-ForLogRegex `
        -Path $ClientStderr `
        -Process $ClientProcess `
        -Pattern "(?m)^RESHADE_CLIENT_INJECTOR_FAILED target=`"process:$([regex]::Escape($HostName)):pid:$HostPid`" detail=.+\r?`$" `
        -Deadline $AttachDeadline
    $AttachmentIdle = Wait-ForLogRegex `
        -Path $ClientStdout `
        -Process $ClientProcess `
        -Pattern "(?m)^RESHADE_CLIENT_ATTACHMENT_STATE phase=idle processName=`"$([regex]::Escape($HostName))`" pid=(?:none|$HostPid) reason=attach-failed code=$ExpectedDiagnosticCode stage=target-preflight\r?`$" `
        -Deadline $AttachDeadline

    $InjectorStdout = Join-Path $ReShadeRunDirectory "inject.stdout.log"
    $InjectorStderr = Join-Path $ReShadeRunDirectory "inject.stderr.log"
    if (-not (Test-Path -LiteralPath $InjectorStdout -PathType Leaf)) {
        throw "The SDK did not preserve injector stdout: $InjectorStdout"
    }
    $InjectorLog = Get-Content -Raw -LiteralPath $InjectorStdout
    $DiagnosticLines = @(
        $InjectorLog -split "\r?\n" |
            Where-Object { $_.StartsWith($DiagnosticPrefix) }
    )
    if ($DiagnosticLines.Count -ne 1) {
        throw "Expected one structured existing-installation diagnostic, found $($DiagnosticLines.Count). Inspect $InjectorStdout."
    }
    $Diagnostic = $DiagnosticLines[0].Substring(
        $DiagnosticPrefix.Length
    ) | ConvertFrom-Json
    $DiagnosticPropertyNames = @(
        $Diagnostic.PSObject.Properties.Name |
            Sort-Object
    )
    if (($DiagnosticPropertyNames -join ",") -cne
        "addonDirectoryPath,code,electronGameOverlayAddonDisabled,injectionStarted,modulePath,pid,reshadeBasePath,schemaVersion,stage,targetExecutablePath") {
        throw "The existing-installation diagnostic did not contain the exact fixed schema: $($DiagnosticPropertyNames -join ',')."
    }
    if ($Diagnostic.schemaVersion -ne 1 -or
        $Diagnostic.stage -cne "target-preflight" -or
        $Diagnostic.code -cne $ExpectedDiagnosticCode -or
        $Diagnostic.pid -ne $HostPid -or
        $Diagnostic.injectionStarted -ne $false -or
        -not [IO.Path]::IsPathRooted($Diagnostic.targetExecutablePath) -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath($Diagnostic.targetExecutablePath),
            [IO.Path]::GetFullPath($TargetExecutablePath),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::IsPathRooted($Diagnostic.modulePath) -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath($Diagnostic.modulePath),
            [IO.Path]::GetFullPath($OfficialRuntimeTargetPath),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath($Diagnostic.reshadeBasePath),
            [IO.Path]::GetFullPath($TargetDirectory),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath($Diagnostic.addonDirectoryPath),
            [IO.Path]::GetFullPath(
                (Join-Path $TargetDirectory "existing-addons")
            ),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The existing-installation diagnostic did not identify the exact untouched target runtime: $($Diagnostic | ConvertTo-Json -Compress)"
    }
    if ($Diagnostic.electronGameOverlayAddonDisabled -ne $false) {
        throw "The existing-installation diagnostic incorrectly marked the overlay add-on disabled."
    }
    if (-not $InjectorLog.Contains("ReShade injection not started.") -or
        $InjectorLog.Contains($ResultPrefix) -or
        $InjectorLog.Contains("Succeeded!")) {
        throw "The injector did not provide an unambiguous no-injection outcome. Inspect $InjectorStdout."
    }

    Assert-ExactTargetProcess `
        -ProcessId $HostPid `
        -ExpectedPath $TargetExecutablePath
    $HostProcess.Refresh()
    if ($HostProcess.HasExited) {
        throw "The controlled host exited during the rejected SDK attachment."
    }
    if (-not (Test-Path -LiteralPath $StartupBarrierPath -PathType Leaf)) {
        throw "The controlled host startup barrier was released before the no-injection proof completed."
    }

    $StagedProjectRuntime = [IO.Path]::GetFullPath(
        (Join-Path $ReShadeRunDirectory "ReShade64.dll")
    )
    $StagedProjectAddon = [IO.Path]::GetFullPath(
        (Join-Path $ReShadeRunDirectory "electron_game_overlay.addon64")
    )
    $PostAttachModules = Get-ProcessModuleSnapshot -ProcessId $HostPid
    $PostAttachModulesPath = Join-Path $RunDirectory "post-attach-modules.json"
    Save-JsonEvidence -Value $PostAttachModules -Path $PostAttachModulesPath
    Assert-CandidateAndProjectModulesAbsent `
        -Modules $PostAttachModules `
        -InstallationCandidate (
            [IO.Path]::GetFullPath($OfficialRuntimeTargetPath)
        ) `
        -StagedRuntime $StagedProjectRuntime `
        -StagedAddon $StagedProjectAddon `
        -Boundary "post-attach"

    if (Test-Path `
            -LiteralPath (
                Join-Path $TargetDirectory "electron_game_overlay.addon64"
            )) {
        throw "The rejected SDK attachment copied its add-on into the existing ReShade installation."
    }

    $PostAttachManifest = Get-DirectoryManifest -Path $TargetDirectory
    $PostAttachManifestPath = Join-Path $RunDirectory "post-attach-manifest.json"
    Save-JsonEvidence `
        -Value $PostAttachManifest `
        -Path $PostAttachManifestPath
    Assert-ManifestsEqual `
        -Expected $PreAttachManifest `
        -Actual $PostAttachManifest `
        -Boundary "production SDK attachment"

    Remove-Item -LiteralPath $StartupBarrierPath -Force
    $HostWindow = Wait-ForHostWindow `
        -HostProcess $HostProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(30))
    $StableHostTitle = Wait-ForStableHostTitle `
        -Window $HostWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(10))

    $PostReleaseModules = Get-ProcessModuleSnapshot -ProcessId $HostPid
    $PostReleaseModulesPath = Join-Path $RunDirectory "post-release-modules.json"
    Save-JsonEvidence -Value $PostReleaseModules -Path $PostReleaseModulesPath
    Assert-CandidateAndProjectModulesAbsent `
        -Modules $PostReleaseModules `
        -InstallationCandidate (
            [IO.Path]::GetFullPath($OfficialRuntimeTargetPath)
        ) `
        -StagedRuntime $StagedProjectRuntime `
        -StagedAddon $StagedProjectAddon `
        -Boundary "post-release rendering"

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow(
            $HostWindow)) {
        throw "Could not foreground the controlled D3D11 host for normal exit."
    }
    Start-Sleep -Milliseconds 250
    [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
    if (-not $HostProcess.WaitForExit(10000)) {
        throw "The official/stock ReShade host did not exit normally after released Escape."
    }
    $HostProcess.WaitForExit()
    $HostProcess.Refresh()
    if ($HostProcess.ExitCode -ne 0) {
        throw "The official/stock ReShade host exited with code $($HostProcess.ExitCode)."
    }
    $HostExitedNormally = $true

    $FinalManifest = Get-DirectoryManifest -Path $TargetDirectory
    $FinalManifestPath = Join-Path $RunDirectory "final-manifest.json"
    Save-JsonEvidence -Value $FinalManifest -Path $FinalManifestPath
    Assert-ManifestsEqual `
        -Expected $PreAttachManifest `
        -Actual $FinalManifest `
        -IgnoredRelativePaths @($StartupBarrierFileName) `
        -Boundary "controlled-host graphics startup and normal shutdown"
    Assert-ManifestsEqual `
        -Expected $SeedManifest `
        -Actual $FinalManifest `
        -IgnoredRelativePaths @($StartupBarrierFileName) `
        -Boundary "seeded installation canaries"

    $FinalClientLog = Get-ClientLogText -Path $ClientStdout
    if ($FinalClientLog.Contains(
            "RESHADE_CLIENT_TARGET_CONNECTED pid=$HostPid") -or
        $FinalClientLog.Contains("RESHADE_CLIENT_INJECTOR_RETURNED")) {
        throw "The production client reported a successful project-runtime connection despite the rejected existing installation."
    }

    $Summary = [pscustomobject]@{
        Result = $ResultMarker
        Backend = "d3d11"
        Case = "exact-pid-existing-reshade-installation-no-break"
        TargetProcessId = $HostPid
        TargetExecutablePath = $TargetExecutablePath
        OfficialRuntime = [pscustomobject]@{
            SourcePath = $ResolvedOfficialRuntime
            SourceSha256 = $OfficialSourceHash
            InactiveTargetPath = [IO.Path]::GetFullPath(
                $OfficialRuntimeTargetPath
            )
            TargetSha256 = $OfficialTargetHash
        }
        SdkAttempt = [pscustomobject]@{
            Arguments = $ExpectedInjectorArguments
            RunDirectory = $ReShadeRunDirectory
            InjectorStdout = $InjectorStdout
            InjectorStderr = $InjectorStderr
            InjectorFailedMarkerIndex = $InjectorFailed.Index
            AttachmentIdleMarkerIndex = $AttachmentIdle.Index
            Diagnostic = $Diagnostic
        }
        PreservationEvidence = [pscustomobject]@{
            SeedManifest = $SeedManifestPath
            PreAttachManifest = $PreAttachManifestPath
            PostAttachManifest = $PostAttachManifestPath
            FinalManifest = $FinalManifestPath
            PreAttachModules = $PreAttachModulesPath
            PostAttachModules = $PostAttachModulesPath
            PostReleaseModules = $PostReleaseModulesPath
            ExactAttachManifestMatch = $true
            FinalAllowedChanges = @($StartupBarrierFileName)
        }
        NoBreakProof = [pscustomobject]@{
            InstallationCandidateRemainedInactive = $true
            SystemDxgiRemainedLoaded = $true
            ProjectRuntimeLoaded = $false
            ProjectAddonLoaded = $false
            StableHostTitle = $StableHostTitle
            ExitCode = $HostProcess.ExitCode
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

Start-Sleep -Milliseconds 500
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
$RemainingInjectors = @(Get-OwnedInjectorProcesses)
if ($RemainingElectron.Count -ne 0 -or
    $RemainingHost.Count -ne 0 -or
    $RemainingInjectors.Count -ne 0) {
    $ProcessIds = @(
        @($RemainingElectron.ProcessId) +
            @($RemainingHost.ProcessId) +
            @($RemainingInjectors.ProcessId) |
            Where-Object { $null -ne $_ }
    )
    throw "The existing-installation gate left an owned client/host/injector process behind (PID: $($ProcessIds -join ', '))."
}
if (-not $HostExitedNormally -or -not $Summary) {
    throw "The existing-installation gate did not complete its normal-exit proof."
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
