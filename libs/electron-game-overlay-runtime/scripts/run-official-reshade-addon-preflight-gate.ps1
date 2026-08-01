[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OfficialRuntimePath,
    [string]$InjectorPath,
    [string]$AddonPath,
    [string]$HostPath,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ExpectedAddonBuildId = "35C07911C9EB418B9F439374A4191009"

function Wait-ForCondition {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Condition,
        [Parameter(Mandatory = $true)]
        [string]$FailureMessage,
        [int]$TimeoutMilliseconds = 30000
    )

    $Deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        if (& $Condition) {
            return
        }
        Start-Sleep -Milliseconds 25
    }

    throw $FailureMessage
}

function Get-LoadedModulePaths([Diagnostics.Process]$Process) {
    $Process.Refresh()
    if ($Process.HasExited) {
        return @()
    }

    try {
        return @(
            $Process.Modules |
                Where-Object { $_.FileName } |
                ForEach-Object { [IO.Path]::GetFullPath($_.FileName) }
        )
    }
    catch {
        return @()
    }
}

function Test-ModuleLoaded {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    foreach ($ModulePath in Get-LoadedModulePaths $Process) {
        if ($ModulePath.Equals($Path, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Invoke-Injector {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string]$TargetName,
        [Parameter(Mandatory = $true)]
        [int]$TargetPid
    )

    if ($TargetName -match '\s') {
        throw "The controlled host name must not contain whitespace: $TargetName"
    }

    $StartInfo = New-Object Diagnostics.ProcessStartInfo
    $StartInfo.FileName = $FilePath
    $StartInfo.Arguments = "$TargetName --pid $TargetPid"
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true

    $Process = New-Object Diagnostics.Process
    $Process.StartInfo = $StartInfo
    try {
        if (-not $Process.Start()) {
            throw "Unable to start the controlled injector."
        }

        $StdoutTask = $Process.StandardOutput.ReadToEndAsync()
        $StderrTask = $Process.StandardError.ReadToEndAsync()
        if (-not $Process.WaitForExit(10000)) {
            $Process.Kill()
            throw "The injector did not finish its official-add-on preflight."
        }
        $Process.WaitForExit()
        $Process.Refresh()
        if (-not $StdoutTask.Wait(1000) -or -not $StderrTask.Wait(1000)) {
            throw "The injector output streams did not close after process exit."
        }

        return [pscustomobject]@{
            ExitCode = $Process.ExitCode
            Stdout = $StdoutTask.Result
            Stderr = $StderrTask.Result
        }
    }
    finally {
        $Process.Dispose()
    }
}

function Copy-StaleAddonBuildFixture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    $StaleAddonBuildId = "0D6A3C9E21F84B50A4D17E63C8B9025F"
    $Bytes = [IO.File]::ReadAllBytes($Source)
    $ExpectedBytes = [Text.Encoding]::ASCII.GetBytes($ExpectedAddonBuildId)
    $StaleBytes = [Text.Encoding]::ASCII.GetBytes($StaleAddonBuildId)
    $Matches = [Collections.Generic.List[int]]::new()
    for ($Offset = 0;
        $Offset -le $Bytes.Length - $ExpectedBytes.Length;
        $Offset++) {
        $MatchesAtOffset = $true
        for ($Index = 0; $Index -lt $ExpectedBytes.Length; $Index++) {
            if ($Bytes[$Offset + $Index] -ne $ExpectedBytes[$Index]) {
                $MatchesAtOffset = $false
                break
            }
        }
        if ($MatchesAtOffset) {
            $Matches.Add($Offset)
        }
    }
    if ($Matches.Count -ne 1) {
        throw "Expected exactly one immutable add-on build ID in the fixture, found $($Matches.Count)."
    }
    [Array]::Copy(
        $StaleBytes,
        0,
        $Bytes,
        $Matches[0],
        $StaleBytes.Length
    )
    [IO.File]::WriteAllBytes($Destination, $Bytes)
}

function Invoke-StaleAddonBuildIdCase {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GateRoot,
        [Parameter(Mandatory = $true)]
        [string]$OfficialRuntime,
        [Parameter(Mandatory = $true)]
        [string]$Injector,
        [Parameter(Mandatory = $true)]
        [string]$Addon,
        [Parameter(Mandatory = $true)]
        [string]$HostExecutable
    )

    $CaseRoot = Join-Path $GateRoot "stale-addon-build-id"
    $RouteRoot = Join-Path $GateRoot "stale-route"
    New-Item -ItemType Directory -Path $CaseRoot, $RouteRoot -Force |
        Out-Null
    $TargetHost = [IO.Path]::GetFullPath(
        (Join-Path $CaseRoot "stale-addon-host.exe")
    )
    $TargetRuntime = [IO.Path]::GetFullPath(
        (Join-Path $CaseRoot "d3d11.dll")
    )
    $TargetAddon = [IO.Path]::GetFullPath(
        (Join-Path $CaseRoot "electron_game_overlay.addon64")
    )
    $StartupBarrier = Join-Path $CaseRoot (
        "electron-game-overlay-startup-barrier.enabled"
    )
    Copy-Item -LiteralPath $HostExecutable -Destination $TargetHost
    Copy-Item -LiteralPath $OfficialRuntime -Destination $TargetRuntime
    Copy-StaleAddonBuildFixture `
        -Source $Addon `
        -Destination $TargetAddon
    New-Item -ItemType File -Path $StartupBarrier -Force | Out-Null
    @"
[INSTALL]
BasePath=.
Logging=0

[ADDON]
AddonPath=.
DisabledAddons=
"@ | Set-Content `
        -LiteralPath (Join-Path $CaseRoot "ReShade.ini") `
        -Encoding UTF8

    $RuntimeHash = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $TargetRuntime
    ).Hash
    $AddonHash = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $TargetAddon
    ).Hash
    [Environment]::SetEnvironmentVariable(
        "ELECTRON_GAME_OVERLAY_RUN_DIRECTORY",
        $RouteRoot,
        "Process"
    )

    $Process = $null
    try {
        $Process = Start-Process `
            -FilePath $TargetHost `
            -WorkingDirectory $CaseRoot `
            -PassThru
        Wait-ForCondition `
            -Condition {
                Test-ModuleLoaded -Process $Process -Path $TargetRuntime
            } `
            -FailureMessage "The stale-build host did not load stock ReShade."
        Remove-Item -LiteralPath $StartupBarrier -Force
        Wait-ForCondition `
            -Condition {
                $Process.Refresh()
                -not $Process.HasExited -and
                    $Process.MainWindowHandle -ne [IntPtr]::Zero -and
                    (Test-ModuleLoaded -Process $Process -Path $TargetAddon)
            } `
            -FailureMessage "The stale ABI-1 add-on did not load."

        $Result = Invoke-Injector `
            -FilePath $Injector `
            -TargetName ([IO.Path]::GetFileName($TargetHost)) `
            -TargetPid $Process.Id
        if ($Result.ExitCode -ne 50 -or
            -not [string]::IsNullOrEmpty($Result.Stderr)) {
            throw "The stale-build injector outcome was unexpected: $($Result | ConvertTo-Json -Compress)"
        }

        $Prefix = "ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC "
        $DiagnosticLines = @(
            $Result.Stdout -split '\r?\n' |
                Where-Object { $_.StartsWith($Prefix) }
        )
        if ($DiagnosticLines.Count -ne 1) {
            throw "Expected one stale-build diagnostic: $($Result.Stdout)"
        }
        $Diagnostic = $DiagnosticLines[0].Substring(
            $Prefix.Length
        ) | ConvertFrom-Json
        $Properties = @(
            $Diagnostic.PSObject.Properties.Name |
                Sort-Object
        )
        if (($Properties -join ",") -cne
            "addonDirectoryPath,code,electronGameOverlayAddonDisabled,injectionStarted,modulePath,pid,reshadeBasePath,schemaVersion,stage,targetExecutablePath,windowsErrorCode") {
            throw "The stale-build diagnostic schema was not exact: $($Properties -join ',')"
        }
        if ($Diagnostic.schemaVersion -ne 1 -or
            $Diagnostic.stage -cne "target-preflight" -or
            $Diagnostic.code -cne "target-runtime-incompatible" -or
            $Diagnostic.pid -ne $Process.Id -or
            $Diagnostic.injectionStarted -ne $false -or
            $Diagnostic.windowsErrorCode -ne 50 -or
            $Diagnostic.electronGameOverlayAddonDisabled -ne $false -or
            -not ([string]$Diagnostic.targetExecutablePath).Equals(
                $TargetHost,
                [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$Diagnostic.modulePath).Equals(
                $TargetRuntime,
                [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$Diagnostic.reshadeBasePath).Equals(
                $CaseRoot,
                [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$Diagnostic.addonDirectoryPath).Equals(
                $CaseRoot,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "The stale-build diagnostic was unexpected: $($Diagnostic | ConvertTo-Json -Compress)"
        }
        if ($Result.Stdout.Contains(
                "ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ") -or
            -not $Result.Stdout.Contains("ReShade injection not started.")) {
            throw "The stale ABI-1 add-on was incorrectly accepted."
        }
        if (-not (Test-ModuleLoaded -Process $Process -Path $TargetAddon) -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $TargetRuntime).Hash -ne
                $RuntimeHash -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $TargetAddon).Hash -ne
                $AddonHash) {
            throw "The stale-build refusal changed the controlled module set."
        }

        if (-not $Process.CloseMainWindow() -or
            -not $Process.WaitForExit(10000)) {
            throw "The stale-build host did not close normally."
        }
        $Process.WaitForExit()
        if ($Process.ExitCode -ne 0) {
            throw "The stale-build host exited with code $($Process.ExitCode)."
        }
    }
    finally {
        if ($null -ne $Process) {
            try {
                $Process.Refresh()
                if (-not $Process.HasExited) {
                    $Process.Kill()
                    $Process.WaitForExit()
                }
            }
            finally {
                $Process.Dispose()
            }
        }
    }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$RuntimeRoot = Join-Path $RepoRoot "libs\electron-game-overlay-runtime"
$NativeBuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
$ProductionBuildRoot =
    Join-Path $RepoRoot "build\electron-game-overlay-runtime-production"
$DefaultInjector = Join-Path $NativeBuildRoot (
    "_deps\reshade-src\bin\x64\Release\inject.exe"
)
$DefaultAddon = Join-Path $ProductionBuildRoot (
    "RelWithDebInfo\electron_game_overlay.addon64"
)
$DefaultHost = Join-Path $ProductionBuildRoot (
    "RelWithDebInfo\d3d11_overlay_test_host.exe"
)

if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot "build-reshade-runtime.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "The native injector build failed with exit code $LASTEXITCODE."
    }

    Push-Location $RuntimeRoot
    try {
        & cmake.exe --preset vs2022-x64-production
        if ($LASTEXITCODE -ne 0) {
            throw "CMake configure failed with exit code $LASTEXITCODE."
        }
        & cmake.exe --build $ProductionBuildRoot `
            --config RelWithDebInfo `
            --target electron_game_overlay d3d11_overlay_test_host `
            --parallel
        if ($LASTEXITCODE -ne 0) {
            throw "The official-add-on gate build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

$OfficialRuntime = [IO.Path]::GetFullPath($OfficialRuntimePath)
$Injector = if ([string]::IsNullOrWhiteSpace($InjectorPath)) {
    $DefaultInjector
}
else {
    [IO.Path]::GetFullPath($InjectorPath)
}
$Addon = if ([string]::IsNullOrWhiteSpace($AddonPath)) {
    $DefaultAddon
}
else {
    [IO.Path]::GetFullPath($AddonPath)
}
$HostExecutable = if ([string]::IsNullOrWhiteSpace($HostPath)) {
    $DefaultHost
}
else {
    [IO.Path]::GetFullPath($HostPath)
}
foreach ($RequiredPath in @(
        $OfficialRuntime,
        $Injector,
        $Addon,
        $HostExecutable)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
        throw "The official-add-on preflight gate is missing: $RequiredPath"
    }
}
$OfficialRuntime = (Resolve-Path -LiteralPath $OfficialRuntime).Path
$Injector = (Resolve-Path -LiteralPath $Injector).Path
$Addon = (Resolve-Path -LiteralPath $Addon).Path
$HostExecutable = (Resolve-Path -LiteralPath $HostExecutable).Path
$SourceAddonHash = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $Addon
).Hash

$GateRoot = Join-Path $env:TEMP (
    "electron-game-overlay-official-addon-preflight-" +
    [Guid]::NewGuid().ToString("N")
)
$TargetDirectory = Join-Path $GateRoot "target"
$RouteDirectory = Join-Path $GateRoot "route"
$TargetHost = Join-Path $TargetDirectory "official-addon-host.exe"
$TargetRuntime = Join-Path $TargetDirectory "d3d11.dll"
$TargetAddon = Join-Path $TargetDirectory "electron_game_overlay.addon64"
$StartupBarrier = Join-Path $TargetDirectory (
    "electron-game-overlay-startup-barrier.enabled"
)
$HostProcess = $null
$GatePassed = $false
$PreviousRunDirectory = [Environment]::GetEnvironmentVariable(
    "ELECTRON_GAME_OVERLAY_RUN_DIRECTORY",
    "Process"
)
$PreviousBasePath = [Environment]::GetEnvironmentVariable(
    "RESHADE_BASE_PATH_OVERRIDE",
    "Process"
)

try {
    New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $RouteDirectory -Force | Out-Null
    Copy-Item -LiteralPath $HostExecutable -Destination $TargetHost
    Copy-Item -LiteralPath $OfficialRuntime -Destination $TargetRuntime
    Copy-Item -LiteralPath $Addon -Destination $TargetAddon
    New-Item -ItemType File -Path $StartupBarrier -Force | Out-Null

    @"
[INSTALL]
BasePath=.

[ADDON]
AddonPath=.
DisabledAddons=

[GENERAL]
EffectSearchPaths=.
IntermediateCachePath=.\cache
NoDebugInfo=1
PerformanceMode=0
PresetPath=.\ReShadePreset.ini
TextureSearchPaths=.

[INPUT]
InputProcessing=2

[OVERLAY]
ShowFPS=0
TutorialProgress=4
"@ | Set-Content `
        -LiteralPath (Join-Path $TargetDirectory "ReShade.ini") `
        -Encoding UTF8
    @"
[GENERAL]
PreprocessorDefinitions=
Techniques=
TechniqueSorting=
"@ | Set-Content `
        -LiteralPath (Join-Path $TargetDirectory "ReShadePreset.ini") `
        -Encoding UTF8

    $RuntimeHash = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $TargetRuntime
    ).Hash
    $AddonHash = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $TargetAddon
    ).Hash

    [Environment]::SetEnvironmentVariable(
        "ELECTRON_GAME_OVERLAY_RUN_DIRECTORY",
        $RouteDirectory,
        "Process"
    )
    [Environment]::SetEnvironmentVariable(
        "RESHADE_BASE_PATH_OVERRIDE",
        $null,
        "Process"
    )

    $HostProcess = Start-Process `
        -FilePath $TargetHost `
        -WorkingDirectory $TargetDirectory `
        -PassThru
    $TargetRuntime = [IO.Path]::GetFullPath($TargetRuntime)
    $TargetAddon = [IO.Path]::GetFullPath($TargetAddon)

    Wait-ForCondition `
        -Condition {
            Test-ModuleLoaded -Process $HostProcess -Path $TargetRuntime
        } `
        -FailureMessage "The controlled host did not load stock ReShade before its startup barrier."
    $HostProcess.Refresh()
    if ($HostProcess.MainWindowHandle -ne [IntPtr]::Zero -or
        -not (Test-Path -LiteralPath $StartupBarrier -PathType Leaf)) {
        throw "The controlled host did not remain behind its pre-device barrier."
    }
    if (Test-ModuleLoaded -Process $HostProcess -Path $TargetAddon) {
        throw "The Electron add-on loaded before stock ReShade initialized its graphics runtime."
    }

    Remove-Item -LiteralPath $StartupBarrier -Force
    Wait-ForCondition `
        -Condition {
            $HostProcess.Refresh()
            -not $HostProcess.HasExited -and
                $HostProcess.MainWindowHandle -ne [IntPtr]::Zero -and
                (Test-ModuleLoaded -Process $HostProcess -Path $TargetAddon)
        } `
        -FailureMessage "Stock ReShade did not load the ABI-1 Electron add-on at graphics startup."

    $ProjectRuntime = [IO.Path]::GetFullPath(
        (Join-Path (Split-Path -Parent $Injector) "ReShade64.dll")
    )
    if (Test-ModuleLoaded -Process $HostProcess -Path $ProjectRuntime) {
        throw "The project runtime was loaded before the controlled injector ran."
    }

    $Result = Invoke-Injector `
        -FilePath $Injector `
        -TargetName ([IO.Path]::GetFileName($TargetHost)) `
        -TargetPid $HostProcess.Id
    if ($Result.ExitCode -ne 0) {
        throw "The injector returned $($Result.ExitCode), expected success: $($Result.Stdout)"
    }
    if (-not [string]::IsNullOrEmpty($Result.Stderr)) {
        throw "The injector wrote unexpected stderr: $($Result.Stderr)"
    }

    $ResultPrefix = "ELECTRON_GAME_OVERLAY_INJECTOR_RESULT "
    $ResultLines = @(
        $Result.Stdout -split '\r?\n' |
            Where-Object { $_.StartsWith($ResultPrefix) }
    )
    if ($ResultLines.Count -ne 1) {
        throw "Expected one structured official-add-on result: $($Result.Stdout)"
    }
    $Record = $ResultLines[0].Substring(
        $ResultPrefix.Length
    ) | ConvertFrom-Json
    $PropertyNames = @($Record.PSObject.Properties.Name | Sort-Object)
    if (($PropertyNames -join ",") -cne
        "addonAbi,addonBuildId,addonDirectoryPath,addonModulePath,electronGameOverlayAddonDisabled,pid,reshadeBasePath,runtimeMode,runtimeModulePath,schemaVersion,targetExecutablePath") {
        throw "The official-add-on result schema was not exact: $($PropertyNames -join ',')"
    }
    $ExpectedEffectiveDirectory = [IO.Path]::GetFullPath($TargetDirectory)
    if ($Record.schemaVersion -ne 1 -or
        $Record.pid -ne $HostProcess.Id -or
        $Record.runtimeMode -cne "official-addon" -or
        $Record.addonAbi -ne 1 -or
        $Record.addonBuildId -cne $ExpectedAddonBuildId -or
        ([string]$Record.addonBuildId) -cnotmatch '^[0-9A-F]{32}$' -or
        $Record.electronGameOverlayAddonDisabled -ne $false -or
        -not ([string]$Record.targetExecutablePath).Equals(
            [IO.Path]::GetFullPath($TargetHost),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$Record.reshadeBasePath).Equals(
            $ExpectedEffectiveDirectory,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$Record.addonDirectoryPath).Equals(
            $ExpectedEffectiveDirectory,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$Record.runtimeModulePath).Equals(
            $TargetRuntime,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$Record.addonModulePath).Equals(
            $TargetAddon,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The official-add-on result identified unexpected modules: $($Record | ConvertTo-Json -Compress)"
    }
    $EffectiveAddonPrefix = $ExpectedEffectiveDirectory
    if (-not $EffectiveAddonPrefix.EndsWith(
            [IO.Path]::DirectorySeparatorChar
        )) {
        $EffectiveAddonPrefix += [IO.Path]::DirectorySeparatorChar
    }
    if (-not $TargetAddon.StartsWith(
            $EffectiveAddonPrefix,
            [StringComparison]::OrdinalIgnoreCase) -and
        -not $TargetAddon.Equals(
            $ExpectedEffectiveDirectory,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The loaded official add-on was outside the effective add-on directory."
    }
    if ($Result.Stdout.Contains(
            "ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ") -or
        $Result.Stdout.Contains("ReShade injection not started.") -or
        -not $Result.Stdout.Contains("Succeeded!")) {
        throw "The official-add-on success contract was ambiguous: $($Result.Stdout)"
    }

    $HostProcess.Refresh()
    if ($HostProcess.HasExited -or
        -not (Test-ModuleLoaded -Process $HostProcess -Path $TargetRuntime) -or
        -not (Test-ModuleLoaded -Process $HostProcess -Path $TargetAddon) -or
        (Test-ModuleLoaded -Process $HostProcess -Path $ProjectRuntime)) {
        throw "The injector changed the controlled official ReShade module set."
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $TargetRuntime).Hash -ne
        $RuntimeHash -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $TargetAddon).Hash -ne
        $AddonHash) {
        throw "The injector modified the official runtime or preinstalled add-on."
    }

    if (-not $HostProcess.CloseMainWindow() -or
        -not $HostProcess.WaitForExit(10000)) {
        throw "The controlled official ReShade host did not close normally."
    }
    $HostProcess.WaitForExit()
    $HostProcess.Refresh()
    if ($HostProcess.ExitCode -ne 0) {
        throw "The controlled host exited with code $($HostProcess.ExitCode)."
    }
    $HostProcess.Dispose()
    $HostProcess = $null

    Invoke-StaleAddonBuildIdCase `
        -GateRoot $GateRoot `
        -OfficialRuntime $OfficialRuntime `
        -Injector $Injector `
        -Addon $Addon `
        -HostExecutable $HostExecutable
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Addon).Hash -ne
        $SourceAddonHash) {
        throw "The stale-build gate modified the source add-on."
    }

    $GatePassed = $true
    Write-Host (
        "Official ReShade preinstalled add-on native preflight gate passed: " +
        "runtimeMode=official-addon, exact add-on build ID, stale ABI-1 " +
        "mismatch refused, no injection."
    )
}
finally {
    [Environment]::SetEnvironmentVariable(
        "ELECTRON_GAME_OVERLAY_RUN_DIRECTORY",
        $PreviousRunDirectory,
        "Process"
    )
    [Environment]::SetEnvironmentVariable(
        "RESHADE_BASE_PATH_OVERRIDE",
        $PreviousBasePath,
        "Process"
    )

    if ($null -ne $HostProcess) {
        try {
            $HostProcess.Refresh()
            if (-not $HostProcess.HasExited) {
                $HostProcess.Kill()
                $HostProcess.WaitForExit()
            }
        }
        catch {
            Write-Warning "Unable to stop controlled host $($HostProcess.Id): $_"
        }
        $HostProcess.Dispose()
    }

    if ($GatePassed -and
        (Test-Path -LiteralPath $GateRoot -PathType Container)) {
        Remove-Item -LiteralPath $GateRoot -Recurse -Force
    }
    elseif (Test-Path -LiteralPath $GateRoot -PathType Container) {
        Write-Warning "Preserved failed gate evidence: $GateRoot"
    }
}
