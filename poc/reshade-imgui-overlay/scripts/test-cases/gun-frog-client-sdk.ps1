[CmdletBinding()]
param(
    [ValidateRange(60, 900)]
    [int]$InteractionTimeoutSeconds = 600,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$PocRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RepoRoot = (Resolve-Path (Join-Path $PocRoot "..\..")).Path
$BuildRoot = Join-Path $RepoRoot "build\reshade-imgui-overlay"
$Electron = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
$Nx = Join-Path $RepoRoot "node_modules\.bin\nx.cmd"
$TargetExecutableName = "Gun Frog.exe"
$TargetExecutablePath = "C:\Program Files (x86)\Steam\steamapps\common\Gun Frog\Gun Frog.exe"
$LaunchUri = "steam://rungameid/3173130"
$RunDirectory = Join-Path $BuildRoot "client-Gun-Frog-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$UserData = Join-Path $RunDirectory "user-data"
$ClientStdout = Join-Path $RunDirectory "client.stdout.log"
$ClientStderr = Join-Path $RunDirectory "client.stderr.log"
$ClientProcess = $null
$TargetProcessId = 0
$ReShadeRunDirectory = $null
$RunPassed = $false

function Get-MatchingClientProcesses {
    @(
        Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -like "*$RepoRoot*" -and
                ($_.CommandLine -like "*--reshade-overlay*" -or
                    $_.CommandLine -like "*--hudhook-overlay*")
            }
    )
}

function Get-ClientLogText {
    if (-not (Test-Path -LiteralPath $ClientStdout -PathType Leaf)) {
        return ""
    }
    return Get-Content -Raw -LiteralPath $ClientStdout
}

function Get-MatchingInjectors {
    @(
        Get-CimInstance Win32_Process -Filter "Name='inject.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*$TargetExecutableName*" }
    )
}

function Wait-ForClientMarker {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Marker,
        [Parameter(Mandatory = $true)]
        [DateTime]$Deadline
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        [string]$LogText = Get-ClientLogText
        if ($LogText.Contains("RESHADE_CLIENT_INJECTOR_FAILED") -or
            $LogText.Contains("ReShade attachment failed")) {
            throw "The ReShade client reported an injection failure. Inspect $ClientStdout and $ClientStderr."
        }
        if ($LogText.Contains($Marker)) {
            return
        }
        if ($ClientProcess) {
            $ClientProcess.Refresh()
            if ($ClientProcess.HasExited) {
                throw "The client exited before marker '$Marker'. Inspect $ClientStdout and $ClientStderr."
            }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Timed out waiting for client marker '$Marker'. Inspect $ClientStdout and $ClientStderr."
}

function Get-ReShadeRunDirectory {
    $LogText = Get-ClientLogText
    $Matches = [regex]::Matches(
        $LogText,
        '(?m)^RESHADE_CLIENT_RUNTIME_STAGED directory=(.+)\r?$'
    )
    if ($Matches.Count -eq 0) {
        return $null
    }
    return ($Matches[$Matches.Count - 1].Groups[1].Value | ConvertFrom-Json)
}

function Get-ConnectedTargetProcessId {
    $Matches = [regex]::Matches(
        (Get-ClientLogText),
        '(?m)^RESHADE_CLIENT_TARGET_CONNECTED pid=(\d+)\r?$'
    )
    if ($Matches.Count -ne 1) {
        throw "Expected exactly one authenticated ReShade target PID, found $($Matches.Count)."
    }
    return [int]$Matches[0].Groups[1].Value
}

function Assert-ExactlyOneMarker {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [string]$Marker
    )

    $Count = ([regex]::Matches($Text, [regex]::Escape($Marker))).Count
    if ($Count -ne 1) {
        throw "Expected exactly one '$Marker' marker, found $Count."
    }
}

if (-not (Test-Path -LiteralPath $TargetExecutablePath -PathType Leaf)) {
    throw "Gun Frog executable was not found: $TargetExecutablePath"
}
if (-not (Test-Path -LiteralPath $Electron -PathType Leaf)) {
    throw "Electron is unavailable: $Electron"
}
if (-not (Test-Path -LiteralPath $Nx -PathType Leaf)) {
    throw "The local Nx CLI is unavailable: $Nx"
}

$ExistingTargets = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq $TargetExecutableName }
)
$ExistingClients = Get-MatchingClientProcesses
$ExistingInjectors = Get-MatchingInjectors
if ($ExistingTargets.Count -ne 0 -or $ExistingClients.Count -ne 0) {
    $ProcessIds = @($ExistingTargets.ProcessId) + @($ExistingClients.ProcessId)
    throw "Close the existing Gun Frog/client run before this test (PID: $($ProcessIds -join ', '))."
}
if ($ExistingInjectors.Count -ne 0) {
    throw "Close the existing Gun Frog ReShade injector before this test (PID: $($ExistingInjectors.ProcessId -join ', '))."
}

if (-not $SkipBuild) {
    & $Nx run client:build
    if ($LASTEXITCODE -ne 0) {
        throw "The real client/SDK build failed with exit code $LASTEXITCODE."
    }
}

New-Item -ItemType Directory -Path $RunDirectory | Out-Null

try {
    $ClientArguments = @(
        "`"$RepoRoot`"",
        "--no-sandbox",
        "--reshade-overlay",
        "`"--reshade-auto-target-process=$TargetExecutableName`"",
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
        -Marker "RESHADE_CLIENT_INJECTOR_STARTED" `
        -Deadline $StartupDeadline

    Start-Process -FilePath $LaunchUri | Out-Null

    # The SDK intentionally allows two minutes for a pre-armed game launch.
    # Reset the deadline after Steam receives the launch request so client
    # startup time does not consume the target's allowance.
    $StartupDeadline = [DateTime]::UtcNow.AddSeconds(150)

    Wait-ForClientMarker `
        -Marker "RESHADE_CLIENT_TARGET_CONNECTED" `
        -Deadline $StartupDeadline
    $TargetProcessId = Get-ConnectedTargetProcessId
    $TargetProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcessId" `
        -ErrorAction SilentlyContinue
    if (-not $TargetProcess -or $TargetProcess.Name -ne $TargetExecutableName) {
        throw "The authenticated target PID $TargetProcessId is not $TargetExecutableName."
    }
    if (-not $TargetProcess.ExecutablePath -or
        -not [string]::Equals(
            $TargetProcess.ExecutablePath,
            $TargetExecutablePath,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The authenticated target PID $TargetProcessId came from an unexpected path: $($TargetProcess.ExecutablePath)"
    }

    Wait-ForClientMarker `
        -Marker "RESHADE_CLIENT_INJECTOR_RETURNED" `
        -Deadline $StartupDeadline
    Wait-ForClientMarker `
        -Marker "HUDHOOK_CLIENT_GUN_FROG_PROOF_READY" `
        -Deadline $StartupDeadline

    $ReShadeRunDirectory = Get-ReShadeRunDirectory
    if (-not $ReShadeRunDirectory) {
        throw "The client did not report its isolated ReShade run directory."
    }
    $ReShadeLog = Join-Path $ReShadeRunDirectory "ReShade.log"
    while ([DateTime]::UtcNow -lt $StartupDeadline) {
        if ((Test-Path -LiteralPath $ReShadeLog -PathType Leaf) -and
            (Select-String -LiteralPath $ReShadeLog `
                -SimpleMatch "rendered its first transported scene" `
                -Quiet)) {
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $ReShadeLog -PathType Leaf) -or
        -not (Select-String -LiteralPath $ReShadeLog `
            -SimpleMatch "rendered its first transported scene" `
            -Quiet)) {
        throw "The real client scene did not render. Inspect $ReShadeLog."
    }

    if (-not (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) {
        throw "Gun Frog disappeared before the interaction proof began."
    }

    Write-Host ""
    Write-Host "REAL CLIENT GUN FROG INPUT GATE READY (PID $TargetProcessId)"
    Write-Host "  1. Click Electron Continue, New Game, Settings, and Quit once each."
    Write-Host "  2. Gun Frog must stay on its menu through all four clicks."
    Write-Host "  3. Press Ctrl+I to release interception."
    Write-Host "  4. Click the same Quit position again; Gun Frog must close."
    Write-Host "Client evidence: $ClientStdout"
    Write-Host "ReShade evidence: $ReShadeLog"
    Write-Host ""

    $InteractionDeadline = [DateTime]::UtcNow.AddSeconds($InteractionTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $InteractionDeadline -and
        (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) {
        $ClientProcess.Refresh()
        if ($ClientProcess.HasExited) {
            throw "The client exited during the Gun Frog interaction proof."
        }
        Start-Sleep -Milliseconds 200
    }
    if (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue) {
        throw "Timed out waiting for the released-input Quit control to close Gun Frog."
    }

    $ClientLog = Get-ClientLogText
    $ClickMarkers = @(
        "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click name=continue",
        "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click name=new-game",
        "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click name=settings",
        "HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click name=quit"
    )
    foreach ($Marker in $ClickMarkers) {
        Assert-ExactlyOneMarker -Text $ClientLog -Marker $Marker
    }
    Assert-ExactlyOneMarker `
        -Text $ClientLog `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true"
    Assert-ExactlyOneMarker `
        -Text $ClientLog `
        -Marker "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false"

    $InterceptEnabledIndex = $ClientLog.IndexOf(
        "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=true",
        [StringComparison]::Ordinal
    )
    $InterceptDisabledIndex = $ClientLog.IndexOf(
        "HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=false",
        [StringComparison]::Ordinal
    )
    foreach ($Marker in $ClickMarkers) {
        $ClickIndex = $ClientLog.IndexOf($Marker, [StringComparison]::Ordinal)
        if ($ClickIndex -le $InterceptEnabledIndex -or
            $ClickIndex -ge $InterceptDisabledIndex) {
            throw "Click marker '$Marker' was not bounded by the intercept enable/release acknowledgements."
        }
    }

    $ReShadeFault = Select-String -LiteralPath $ReShadeLog -Pattern `
        "out of global sequence|router was reset|input.*(failed|error)|queue.*(failed|error)|FATAL" `
        -CaseSensitive:$false
    if ($ReShadeFault) {
        throw "ReShade reported an input/router fault: $($ReShadeFault.Line -join ' | ')"
    }

    $RunPassed = $true
    "GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS" |
        Set-Content -LiteralPath (Join-Path $RunDirectory "result.txt") -Encoding UTF8
    Write-Host "GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS"
    Write-Host "Evidence preserved in: $RunDirectory"
    Write-Host "ReShade evidence preserved in: $ReShadeRunDirectory"
}
finally {
    $CleanupIds = @(
        Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*$UserData*" } |
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

    $InjectorCleanupIds = @(
        Get-MatchingInjectors |
            Where-Object {
                -not $ReShadeRunDirectory -or
                $_.ExecutablePath -like "$ReShadeRunDirectory*" -or
                $_.CommandLine -like "*$ReShadeRunDirectory*"
            } |
            ForEach-Object { $_.ProcessId }
    )
    foreach ($ProcessId in $InjectorCleanupIds) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }

    if (-not $RunPassed -and $TargetProcessId -eq 0) {
        $FailedTarget = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -eq $TargetExecutableName -and
                [string]::Equals(
                    $_.ExecutablePath,
                    $TargetExecutablePath,
                    [StringComparison]::OrdinalIgnoreCase)
            } |
            Select-Object -First 1
        if ($FailedTarget) {
            $TargetProcessId = $FailedTarget.ProcessId
        }
    }
    if (-not $RunPassed -and $TargetProcessId -ne 0) {
        $TargetHandle = Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue
        if ($TargetHandle) {
            $null = $TargetHandle.CloseMainWindow()
            Wait-Process -Id $TargetProcessId -Timeout 5 -ErrorAction SilentlyContinue
            if (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue) {
                Stop-Process -Id $TargetProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
