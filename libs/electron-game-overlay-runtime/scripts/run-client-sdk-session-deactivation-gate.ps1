[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d11", "d3d12")]
    [string]$Backend,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# Reuse the controlled host's window, input-oracle, SendInput, and process
# helpers without running the larger interaction gate.
. (Join-Path $PSScriptRoot "run-client-sdk-input-gate.ps1") `
    -Backend $Backend `
    -SkipBuild:$SkipBuild `
    -FunctionsOnly

$RuntimeDistribution = Join-Path $RuntimeRoot "dist\win32-x64"
$RuntimeSource = Join-Path $RuntimeDistribution "ReShade64.dll"
$InjectorSource = Join-Path $RuntimeDistribution "inject.exe"
$AddonSource = Join-Path $RuntimeDistribution "electron_game_overlay.addon64"
$ConfigSource = Join-Path $RuntimeDistribution "ReShade.ini"
$ProducerRoot = Join-Path $RepoRoot "tools\electron-overlay-scene-producer"
$RunDirectory = Join-Path `
    $BuildRoot `
    "client-sdk-$Backend-session-deactivation-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$TargetDirectory = Join-Path $RunDirectory "target"
$TargetExecutablePath = Join-Path $TargetDirectory $HostName
$ReShadeLog = Join-Path $RunDirectory "ReShade.log"
$InjectorStdout = Join-Path $RunDirectory "inject.stdout.log"
$InjectorStderr = Join-Path $RunDirectory "inject.stderr.log"
$ProducerStdout = Join-Path $RunDirectory "electron-producer.stdout.log"
$ProducerStderr = Join-Path $RunDirectory "electron-producer.stderr.log"
$InputControlFile = Join-Path $RunDirectory "producer-control.txt"
$UserData = Join-Path $RunDirectory "producer-user-data"
$TargetDirectoryLog = Join-Path $TargetDirectory "ReShade.log"
$StartupBarrierPath =
    Join-Path $TargetDirectory "electron-game-overlay-startup-barrier.enabled"
$InjectionWaitPath =
    Join-Path $TargetDirectory "reshade-injection-wait.enabled"
$ResultMarker = "${BackendLabel}_REAL_CLIENT_SDK_SESSION_DEACTIVATION_GATE_PASS"
$DormantMarker =
    "Electron game overlay runtime deactivated its producer session, released input, and retired "
$InjectorProcess = $null
$ProducerProcess = $null
$HostProcess = $null
$RunCompleted = $false

function Wait-ForLogMarker {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Marker,
        [Parameter(Mandatory = $true)][DateTime]$Deadline,
        [System.Diagnostics.Process]$ObservedProcess,
        [string]$ObservedProcessLabel = "observed process"
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        if ((Test-Path -LiteralPath $Path -PathType Leaf) -and
            (Select-String -LiteralPath $Path -SimpleMatch $Marker -Quiet)) {
            return
        }
        if ($ObservedProcess) {
            $ObservedProcess.Refresh()
            if ($ObservedProcess.HasExited) {
                throw "$ObservedProcessLabel exited before marker '$Marker'. Inspect $Path."
            }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Timed out waiting for '$Marker'. Inspect $Path."
}

function Get-TargetModulePaths {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    $Process = Get-Process -Id $ProcessId -ErrorAction Stop
    try {
        return @(
            $Process.Modules |
                ForEach-Object { [IO.Path]::GetFullPath($_.FileName) }
        )
    }
    catch {
        throw "Could not enumerate modules for controlled host PID $ProcessId`: $($_.Exception.Message)"
    }
}

function Assert-ModuleMapped {
    param(
        [Parameter(Mandatory = $true)][string[]]$ModulePaths,
        [Parameter(Mandatory = $true)][string]$ExpectedPath,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    $Expected = [IO.Path]::GetFullPath($ExpectedPath)
    $Found = $ModulePaths |
        Where-Object {
            [string]::Equals(
                $_,
                $Expected,
                [StringComparison]::OrdinalIgnoreCase)
        } |
        Select-Object -First 1
    if (-not $Found) {
        throw "The $Stage target no longer maps the exact module $Expected."
    }
}

function Stop-ProcessTreeByUserData {
    param([Parameter(Mandatory = $true)][string]$Path)

    $ProcessIds = @(
        Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*$Path*" } |
            ForEach-Object { $_.ProcessId }
    )
    foreach ($ProcessId in $ProcessIds) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
    foreach ($ProcessId in $ProcessIds) {
        Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
}

$ExistingHosts = Get-MatchingHosts
$ExistingClients = Get-MatchingClientProcesses
$ExistingInjectors = Get-MatchingInjectors
$ExistingProducers = @(
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$ProducerRoot*" }
)
if ($ExistingHosts.Count -ne 0 -or
    $ExistingClients.Count -ne 0 -or
    $ExistingInjectors.Count -ne 0 -or
    $ExistingProducers.Count -ne 0) {
    $ProcessIds = @(
        @($ExistingHosts.ProcessId) +
            @($ExistingClients.ProcessId) +
            @($ExistingInjectors.ProcessId) +
            @($ExistingProducers.ProcessId) |
            Where-Object { $null -ne $_ }
    )
    throw "Close the existing controlled overlay run before this test (PID: $($ProcessIds -join ', '))."
}

if (-not $SkipBuild) {
    & $Nx run electron-game-overlay:build --skip-nx-cache
    if ($LASTEXITCODE -ne 0) {
        throw "The production SDK/runtime build failed with exit code $LASTEXITCODE."
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
            throw "The controlled $BackendLabel host build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

foreach ($RequiredFile in @(
        $RuntimeSource,
        $InjectorSource,
        $AddonSource,
        $ConfigSource,
        $BuiltHost,
        $Electron)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "Required session-deactivation artifact is missing: $RequiredFile"
    }
}
if (-not (Test-Path -LiteralPath $ProducerRoot -PathType Container)) {
    throw "The controlled Electron producer is unavailable: $ProducerRoot"
}

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination $TargetExecutablePath
Copy-Item -LiteralPath $RuntimeSource -Destination (Join-Path $RunDirectory "ReShade64.dll")
Copy-Item -LiteralPath $InjectorSource -Destination (Join-Path $RunDirectory "inject.exe")
Copy-Item -LiteralPath $AddonSource -Destination (Join-Path $RunDirectory "electron_game_overlay.addon64")
Copy-Item -LiteralPath $ConfigSource -Destination (Join-Path $RunDirectory "ReShade.ini")
New-Item `
    -ItemType File `
    -Path (Join-Path $TargetDirectory "reshade-input-gate.enabled") `
    -Force | Out-Null
New-Item `
    -ItemType File `
    -Path $StartupBarrierPath `
    -Force | Out-Null
New-Item `
    -ItemType File `
    -Path $InjectionWaitPath `
    -Force | Out-Null
[IO.File]::WriteAllText($InputControlFile, "", [Text.UTF8Encoding]::new($false))

$ControlledEnvironmentVariables = @(
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

Write-Host ""
Write-Host "Production $BackendLabel producer-session deactivation gate"
Write-Host "  - Public session.close() runs while the target and producer process stay alive."
Write-Host "  - Input must fail open, GPU textures must retire, and runtime modules must remain mapped."
Write-Host "  - Evidence is preserved in: $RunDirectory"
Write-Host ""

try {
    $InjectorProcess = Start-Process `
        -FilePath (Join-Path $RunDirectory "inject.exe") `
        -ArgumentList "`"$HostName`"" `
        -WorkingDirectory $RunDirectory `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $InjectorStdout `
        -RedirectStandardError $InjectorStderr

    $HostProcess = Start-Process `
        -FilePath $TargetExecutablePath `
        -WorkingDirectory $TargetDirectory `
        -PassThru

    if (-not $InjectorProcess.WaitForExit(10000)) {
        throw "The injector did not finish after selecting the controlled target."
    }
    $InjectorProcess.WaitForExit()
    $InjectorProcess.Refresh()
    $InjectorExitCode = $InjectorProcess.ExitCode
    if (($null -ne $InjectorExitCode -and $InjectorExitCode -ne 0) -or
        -not (Select-String `
            -LiteralPath $InjectorStdout `
            -SimpleMatch "Injecting ReShade ... Succeeded!" `
            -Quiet)) {
        throw "The injector did not report a normal successful injection. Inspect $InjectorStdout and $InjectorStderr."
    }
    Remove-Item -LiteralPath $StartupBarrierPath -Force -ErrorAction Stop
    Remove-Item -LiteralPath $InjectionWaitPath -Force -ErrorAction Stop

    $HostWindow = Wait-ForHostWindow `
        -HostProcess $HostProcess `
        -Deadline ([DateTime]::UtcNow.AddSeconds(20))
    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($HostWindow)) {
        throw "Could not make the controlled host the foreground window."
    }

    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "Electron game overlay runtime initialized its transport and input router." `
        -Deadline ([DateTime]::UtcNow.AddSeconds(120)) `
        -HostProcess $HostProcess

    $ProducerArguments = @(
        "`"$ProducerRoot`"",
        "--hudhook-client-multiwindow-runner",
        "`"--input-control-file=$InputControlFile`"",
        "--hudhook-device-scale-factor=1",
        "`"--user-data-dir=$UserData`"",
        "--no-sandbox"
    )
    $ProducerProcess = Start-Process `
        -FilePath $Electron `
        -ArgumentList $ProducerArguments `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $ProducerStdout `
        -RedirectStandardError $ProducerStderr

    $ReadyDeadline = [DateTime]::UtcNow.AddSeconds(45)
    Wait-ForLogMarker `
        -Path $ProducerStdout `
        -Marker "HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_ENABLED" `
        -Deadline $ReadyDeadline `
        -ObservedProcess $ProducerProcess `
        -ObservedProcessLabel "controlled Electron producer"
    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker "rendered its first transported multi-window scene (2 window(s))." `
        -Deadline $ReadyDeadline `
        -HostProcess $HostProcess

    $BaselineTitle = Wait-ForStableHostTitle `
        -Window $HostWindow `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    $Baseline = Get-HostInputSnapshot -Title $BaselineTitle
    if ($Baseline.Clip -ne "off") {
        throw "Cursor confinement remained enabled during interception: $BaselineTitle"
    }

    $ExpectedRuntime = Join-Path $RunDirectory "ReShade64.dll"
    $ExpectedAddon = Join-Path $RunDirectory "electron_game_overlay.addon64"
    $ModulesBefore = Get-TargetModulePaths -ProcessId $HostProcess.Id
    Assert-ModuleMapped -ModulePaths $ModulesBefore -ExpectedPath $ExpectedRuntime -Stage "active"
    Assert-ModuleMapped -ModulePaths $ModulesBefore -ExpectedPath $ExpectedAddon -Stage "active"

    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $HostWindow,
        900,
        600
    )
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    Start-Sleep -Milliseconds 500
    $InterceptedTitle =
        [ReShadeClientSdkGate.NativeInputMethods]::WindowTitle($HostWindow)
    if ($InterceptedTitle -ne $BaselineTitle) {
        throw "The controlled host received mouse input before session deactivation.`nBefore: $BaselineTitle`nAfter:  $InterceptedTitle"
    }

    [IO.File]::WriteAllText(
        $InputControlFile,
        "deactivate-session",
        [Text.UTF8Encoding]::new($false))
    Wait-ForLogMarker `
        -Path $ProducerStdout `
        -Marker "HUDHOOK_CLIENT_MULTIWINDOW_SESSION_DEACTIVATED" `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15)) `
        -ObservedProcess $ProducerProcess `
        -ObservedProcessLabel "controlled Electron producer"
    Wait-ForReShadeMarker `
        -Path $ReShadeLog `
        -Marker $DormantMarker `
        -Deadline ([DateTime]::UtcNow.AddSeconds(15)) `
        -HostProcess $HostProcess

    $ProducerProcess.Refresh()
    $HostProcess.Refresh()
    if ($ProducerProcess.HasExited) {
        throw "The Electron producer exited instead of remaining alive after session.close()."
    }
    if ($HostProcess.HasExited) {
        throw "The controlled host exited during producer-session deactivation."
    }

    $ReShadeText = Get-Content -Raw -LiteralPath $ReShadeLog
    $DormantMatches = [regex]::Matches(
        $ReShadeText,
        [regex]::Escape($DormantMarker) + '(\d+) transported texture\(s\)')
    if ($DormantMatches.Count -ne 1) {
        throw "Expected one runtime dormant transition, found $($DormantMatches.Count)."
    }
    $RetiredTextures = [int]$DormantMatches[0].Groups[1].Value
    if ($RetiredTextures -lt 2) {
        throw "The dormant transition retired only $RetiredTextures texture(s); the two-window scene was not fully retired."
    }

    $ModulesAfter = Get-TargetModulePaths -ProcessId $HostProcess.Id
    Assert-ModuleMapped -ModulePaths $ModulesAfter -ExpectedPath $ExpectedRuntime -Stage "dormant"
    Assert-ModuleMapped -ModulePaths $ModulesAfter -ExpectedPath $ExpectedAddon -Stage "dormant"

    if (-not [ReShadeClientSdkGate.NativeInputMethods]::ActivateWindow($HostWindow)) {
        throw "Could not restore controlled-host foreground ownership after deactivation."
    }
    [void][ReShadeClientSdkGate.NativeInputMethods]::MoveMouseToClientPoint(
        $HostWindow,
        1150,
        650
    )
    [ReShadeClientSdkGate.NativeInputMethods]::SendLeftClick()
    $Released = Wait-ForReleasedMouseInput `
        -Window $HostWindow `
        -Baseline $Baseline `
        -Deadline ([DateTime]::UtcNow.AddSeconds(8))
    if ($Released.Clip -ne "on") {
        throw "Cursor confinement did not resume after session close: $($Released.Title)"
    }

    [ReShadeClientSdkGate.NativeInputMethods]::SendEscape()
    if (-not $HostProcess.WaitForExit(10000)) {
        throw "Released Escape did not close the healthy dormant target."
    }
    $HostProcess.Refresh()
    if ($HostProcess.ExitCode -ne 0) {
        throw "The dormant controlled host exited with code $($HostProcess.ExitCode)."
    }

    $Fault = Select-String `
        -LiteralPath $ReShadeLog `
        -Pattern "out of global sequence|router was reset|input.*(failed|error)|queue.*(failed|error)|FATAL" `
        -CaseSensitive:$false
    if ($Fault) {
        throw "ReShade reported a session-deactivation fault: $($Fault.Line -join ' | ')"
    }
    if (Test-Path -LiteralPath $TargetDirectoryLog -PathType Leaf) {
        throw "The isolated run wrote an unexpected game-directory log: $TargetDirectoryLog"
    }

    [pscustomobject]@{
        backend = $Backend
        hostPid = $HostProcess.Id
        producerPid = $ProducerProcess.Id
        retiredTextures = $RetiredTextures
        runtimeModule = $ExpectedRuntime
        addonModule = $ExpectedAddon
        baselineTitle = $BaselineTitle
        releasedTitle = $Released.Title
    } |
        ConvertTo-Json -Depth 3 |
        Set-Content -LiteralPath (Join-Path $RunDirectory "summary.json") -Encoding UTF8
    $ResultMarker |
        Set-Content -LiteralPath (Join-Path $RunDirectory "result.txt") -Encoding UTF8
    $RunCompleted = $true
    Write-Host $ResultMarker
    Write-Host "Evidence preserved in: $RunDirectory"
}
finally {
    Stop-ProcessTreeByUserData -Path $UserData

    if ($ProducerProcess) {
        $ProducerProcess.Refresh()
        if (-not $ProducerProcess.HasExited) {
            Stop-Process -Id $ProducerProcess.Id -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $ProducerProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
        }
    }
    if ($InjectorProcess) {
        $InjectorProcess.Refresh()
        if (-not $InjectorProcess.HasExited) {
            Stop-Process -Id $InjectorProcess.Id -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $InjectorProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
        }
    }
    if ($HostProcess) {
        $HostProcess.Refresh()
        if (-not $HostProcess.HasExited) {
            $null = $HostProcess.CloseMainWindow()
            Wait-Process -Id $HostProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
            $HostProcess.Refresh()
            if (-not $HostProcess.HasExited) {
                Stop-Process -Id $HostProcess.Id -Force -ErrorAction SilentlyContinue
                Wait-Process -Id $HostProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
            }
        }
    }
    foreach ($VariableName in $ControlledEnvironmentVariables) {
        [Environment]::SetEnvironmentVariable(
            $VariableName,
            $PreviousEnvironment[$VariableName],
            "Process")
    }
}

if (-not $RunCompleted) {
    throw "The $BackendLabel producer-session deactivation gate did not complete."
}
