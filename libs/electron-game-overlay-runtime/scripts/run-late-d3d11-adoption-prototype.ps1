#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$AddonPath,
    [ValidateSet('x64', 'Win32')][string]$Architecture = 'x64',
    [string]$ReshadeIncludeDirectory,
    [ValidateRange(1000, 600000)][int]$LifetimeMs = 20000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$FixtureSource = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\late-d3d11-adoption'
$FixtureRoot = Join-Path $RepoRoot 'build\late-d3d11-adoption'
$CompileDirectory = Join-Path $FixtureRoot "compile-$Architecture"
$RunDirectory = Join-Path $FixtureRoot ('run-' + [Guid]::NewGuid().ToString('N'))
$StageDirectory = Join-Path $RunDirectory 'stage'
$TargetDirectory = Join-Path $RunDirectory 'target'
if (-not $ReshadeIncludeDirectory) {
    $ReshadeIncludeDirectory = Join-Path $RepoRoot 'build\electron-game-overlay-runtime\_deps\reshade-src\include'
}
$Runtime = (Resolve-Path -LiteralPath $RuntimePath).Path
$Addon = (Resolve-Path -LiteralPath $AddonPath).Path
$Includes = (Resolve-Path -LiteralPath $ReshadeIncludeDirectory).Path
if (-not (Test-Path -LiteralPath $Runtime -PathType Leaf) -or
    -not (Test-Path -LiteralPath $Addon -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $Includes 'reshade_api.hpp') -PathType Leaf)) {
    throw 'Supply existing runtime/add-on files and the exact matching ReShade include directory.'
}

New-Item -ItemType Directory -Path $StageDirectory, $TargetDirectory -Force | Out-Null
$RuntimeLeaf = if ($Architecture -eq 'x64') { 'ReShade64.dll' } else { 'ReShade32.dll' }
$AddonLeaf = if ($Architecture -eq 'x64') { 'electron_game_overlay.addon64' } else { 'electron_game_overlay.addon32' }
$StagedRuntime = Join-Path $StageDirectory $RuntimeLeaf
$StagedAddon = Join-Path $StageDirectory $AddonLeaf
$TargetExecutable = Join-Path $TargetDirectory 'late_d3d11_adoption_host.exe'
$ManualConfig = Join-Path $StageDirectory 'manual-runtime.ini'
$ManualReport = Join-Path $StageDirectory 'manual-api-report.json'
$EvidencePath = Join-Path $RunDirectory 'evidence.json'
$ConfigureLog = Join-Path $RunDirectory 'configure.log'
$BuildLog = Join-Path $RunDirectory 'build.log'
$StdoutLog = Join-Path $RunDirectory 'host.stdout.log'
$StderrLog = Join-Path $RunDirectory 'host.stderr.log'
$Utf8 = [Text.UTF8Encoding]::new($false)
$Child = $null
$StdoutTask = $null
$StderrTask = $null
$Failure = $null
$ManualEvidence = $null
$RuntimeHash = (Get-FileHash -LiteralPath $Runtime -Algorithm SHA256).Hash
$AddonHash = (Get-FileHash -LiteralPath $Addon -Algorithm SHA256).Hash
$Summary = [ordered]@{
    schemaVersion = 1
    fixture = 'host-assisted-late-d3d11-adoption'
    status = 'running'
    architecture = $Architecture
    automaticDiscoveryProven = $false
    renderedOverlayPixelsProven = $false
    inputAcceptanceProven = $false
    sceneProducer = 'none; private add-on may remain dormant'
    runtimeSourcePath = $Runtime
    addonSourcePath = $Addon
    runtimeSha256 = $RuntimeHash
    addonSha256 = $AddonHash
    hostSha256 = $null
    fixtureSourceSha256 = (Get-FileHash -LiteralPath (Join-Path $FixtureSource 'host.cpp') -Algorithm SHA256).Hash
    reshadeApiHeaderSha256 = (Get-FileHash -LiteralPath (Join-Path $Includes 'reshade_api.hpp') -Algorithm SHA256).Hash
    stagedRuntimeSha256 = $null
    stagedAddonSha256 = $null
    requestedLifetimeMs = $LifetimeMs
    childPid = $null
    exitCode = $null
    childEnvironmentRemoved = @()
    failure = $null
    manualApi = $null
}

function Save-Evidence {
    [IO.File]::WriteAllText($EvidencePath, ($Summary | ConvertTo-Json -Depth 12), $Utf8)
}

function Read-ManualReport {
    # The host publishes by atomic replacement; readers must allow deleting the
    # old file while retaining their already-open read handle.
    $Sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $Stream = [IO.File]::Open($ManualReport, [IO.FileMode]::Open, [IO.FileAccess]::Read, $Sharing)
    $Reader = $null
    try {
        $Reader = [IO.StreamReader]::new($Stream, [Text.Encoding]::UTF8)
        return ($Reader.ReadToEnd() | ConvertFrom-Json)
    }
    finally {
        if ($null -ne $Reader) { $Reader.Dispose() }
        else { $Stream.Dispose() }
    }
}

function Copy-VerifiedFile([string]$Source, [string]$Destination, [string]$ExpectedHash) {
    Copy-Item -LiteralPath $Source -Destination $Destination
    $CopiedHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
    if ($CopiedHash -ne $ExpectedHash) {
        throw "File bytes changed during staging: $Destination"
    }
    return $CopiedHash
}

try {
    Save-Evidence
    & cmake -S $FixtureSource -B $CompileDirectory -G 'Visual Studio 17 2022' -A $Architecture "-DRESHADE_INCLUDE_DIR=$Includes" *> $ConfigureLog
    if ($LASTEXITCODE -ne 0) { throw "Standalone host configure failed; see $ConfigureLog" }
    & cmake --build $CompileDirectory --config Release --target late_d3d11_adoption_host *> $BuildLog
    if ($LASTEXITCODE -ne 0) { throw "Standalone host build failed; see $BuildLog" }
    $CompiledHost = Join-Path $CompileDirectory 'Release\late_d3d11_adoption_host.exe'
    $Summary.hostSha256 = (Get-FileHash -LiteralPath $CompiledHost -Algorithm SHA256).Hash
    $null = Copy-VerifiedFile $CompiledHost $TargetExecutable $Summary.hostSha256
    $Summary.stagedRuntimeSha256 = Copy-VerifiedFile $Runtime $StagedRuntime $RuntimeHash
    $Summary.stagedAddonSha256 = Copy-VerifiedFile $Addon $StagedAddon $AddonHash

    # All configuration is new and owned by this run. No existing host is altered.
    $OwnedConfig = "[GENERAL]`r`nNoReloadOnInit=1`r`n"
    [IO.File]::WriteAllText((Join-Path $StageDirectory 'ReShade.ini'), $OwnedConfig, $Utf8)
    [IO.File]::WriteAllText($ManualConfig, $OwnedConfig, $Utf8)

    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = $TargetExecutable
    $Info.WorkingDirectory = $TargetDirectory
    $Info.UseShellExecute = $false
    $Info.CreateNoWindow = $false
    $Info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    foreach ($Argument in @(
        '--stage-directory', $StageDirectory,
        '--reshade', $StagedRuntime,
        '--addon', $StagedAddon,
        '--config', $ManualConfig,
        '--report', $ManualReport,
        '--frames-before-load', '60',
        '--resize-after-frames', '120',
        '--lifetime-ms', [string]$LifetimeMs
    )) {
        $Info.ArgumentList.Add($Argument)
    }
    . (Join-Path $PSScriptRoot 'late-d3d11-child-environment.ps1')
    $ChildEnvironment = Set-LateD3D11OwnedStageChildEnvironment -StartInfo $Info -StageDirectory $StageDirectory -FixtureRoot $FixtureRoot
    $Summary.childEnvironmentRemoved = $ChildEnvironment.removedNames
    $Summary.childOwnedBasePath = $ChildEnvironment.stageDirectory
    $Child = [Diagnostics.Process]::new()
    $Child.StartInfo = $Info
    if (-not $Child.Start()) { throw 'Could not start the owned visible D3D11 host.' }
    $Summary.childPid = $Child.Id
    $StdoutTask = $Child.StandardOutput.ReadToEndAsync()
    $StderrTask = $Child.StandardError.ReadToEndAsync()
    Save-Evidence
    Write-Host "Visible host-assisted D3D11 prototype PID $($Child.Id); evidence $EvidencePath"
    $Deadline = [DateTime]::UtcNow.AddMilliseconds(60000 + $LifetimeMs + 15000)
    while (-not $Child.HasExited) {
        if ([DateTime]::UtcNow -ge $Deadline) {
            throw 'The owned D3D11 host exceeded its startup/lifetime/cleanup deadline.'
        }
        if (Test-Path -LiteralPath $ManualReport -PathType Leaf) {
            $ManualEvidence = Read-ManualReport
            if ($ManualEvidence.pid -ne $Child.Id) { throw 'The host report identifies a different process.' }
            $Summary.manualApi = $ManualEvidence
            Save-Evidence
        }
        Start-Sleep -Milliseconds 250
        $Child.Refresh()
    }
    $Child.WaitForExit()
    $Summary.exitCode = $Child.ExitCode
    if (-not (Test-Path -LiteralPath $ManualReport -PathType Leaf)) {
        throw 'The owned host exited without a manual API report.'
    }
    $ManualEvidence = Read-ManualReport
    $Summary.manualApi = $ManualEvidence
    if ($ManualEvidence.pid -ne $Child.Id -or $Child.ExitCode -ne 0 -or
        $ManualEvidence.status -ne 'passed' -or
        $ManualEvidence.framesBeforeLoad -lt 60 -or
        $ManualEvidence.framesAfterResize -lt 60 -or
        -not $ManualEvidence.automaticResizeCompleted -or
        $ManualEvidence.manualCreateSuccesses -lt 2 -or
        $ManualEvidence.manualDestroyCalls -ne $ManualEvidence.manualCreateSuccesses -or
        $ManualEvidence.stateChecks -lt 1 -or $ManualEvidence.stateMismatches -ne 0 -or
        -not $ManualEvidence.manualDestroyedBeforeGraphics -or
        $ManualEvidence.automaticDiscoveryProven -or $ManualEvidence.renderedOverlayPixelsProven) {
        throw 'The host-assisted manual API lifecycle did not satisfy its explicit evidence contract.'
    }
    $Summary.status = 'passed'
}
catch {
    $Failure = $_.Exception.Message
    $Summary.status = 'failed'
    $Summary.failure = $Failure
}
finally {
    if ($null -ne $Child) {
        try {
            if (-not $Child.HasExited) {
                # This Process instance is the one child started above. No name/PID search.
                $Child.Kill()
                if (-not $Child.WaitForExit(5000)) {
                    throw 'The owned child did not exit after termination.'
                }
            }
            $Summary.exitCode = $Child.ExitCode
        }
        catch {
            $Summary.status = 'failed'
            $Summary.failure = if ($Failure) { $Failure + '; cleanup: ' + $_.Exception.Message } else { $_.Exception.Message }
        }
        if ($null -ne $StdoutTask -and $StdoutTask.Wait(5000)) {
            [IO.File]::WriteAllText($StdoutLog, $StdoutTask.Result, $Utf8)
        }
        if ($null -ne $StderrTask -and $StderrTask.Wait(5000)) {
            [IO.File]::WriteAllText($StderrLog, $StderrTask.Result, $Utf8)
        }
        $Child.Dispose()
    }
    Save-Evidence
    Write-Output "LATE_D3D11_ADOPTION_EVIDENCE=$EvidencePath"
}
if ($Summary.status -ne 'passed') {
    throw "Host-assisted late D3D11 prototype failed: $($Summary.failure). Evidence: $EvidencePath"
}
Write-Host 'Host-assisted manual D3D11 lifecycle passed; pixels, input, and automatic discovery remain unproven.'
