[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('x64', 'Win32')][string]$Architecture,
    [Parameter(Mandatory = $true)][string]$AddonPath,
    [switch]$SkipBuild,
    [string]$FixturePath,
    [switch]$ExpectStackOverflow,
    [switch]$SuppressCrashDialog,
    [ValidateRange(10, 60)][int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$FixtureSource = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\preloaded-addon-small-stack'
$BuildDirectory = Join-Path $RepoRoot ('build\ss\b-' + $Architecture)
$RunDirectory = Join-Path $RepoRoot ('build\ss\r-' + $Architecture + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))

function Assert-WorkspaceOutput([string]$Path) {
    $Absolute = [IO.Path]::GetFullPath($Path)
    $Prefix = $RepoRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $Absolute.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Fixture output escapes the workspace: $Absolute"
    }
    $Current = $RepoRoot
    foreach ($Part in $Absolute.Substring($Prefix.Length).Split([char[]]'\/')) {
        if (-not $Part) { continue }
        $Current = Join-Path $Current $Part
        if (Test-Path -LiteralPath $Current) {
            $Entry = Get-Item -LiteralPath $Current -Force
            if (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Fixture output crosses a reparse point: $Current"
            }
        }
    }
    return $Absolute
}

function Read-FileIdentity([string]$Path) {
    $Entry = Get-Item -LiteralPath $Path -Force
    if ($Entry.PSIsContainer -or ($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Expected a regular file: $Path"
    }
    return [ordered]@{
        path = $Entry.FullName
        bytes = $Entry.Length
        sha256 = (Get-FileHash -LiteralPath $Entry.FullName -Algorithm SHA256).Hash
    }
}

$Addon = (Resolve-Path -LiteralPath $AddonPath).ProviderPath
$Candidate = Read-FileIdentity $Addon
$Extension = if ($Architecture -eq 'x64') { 'addon64' } else { 'addon32' }
$NamePattern = '^ego-preload-[0-9a-f]{32}-[0-9A-Fa-f]{32}-(?<hash>[0-9a-f]{16})\.' + $Extension + '$'
if ([IO.Path]::GetFileName($Addon) -cnotmatch $NamePattern) {
    throw 'AddonPath must name a valid architecture-specific preloaded EGO add-on.'
}
if ($Matches.hash -cne $Candidate.sha256.Substring(0, 16).ToLowerInvariant()) {
    throw 'The preloaded filename hash prefix does not match the supplied add-on bytes.'
}
if ($FixturePath -and -not $SkipBuild) {
    throw 'FixturePath is accepted only with SkipBuild, to run an explicitly retained console fixture.'
}
$BuildDirectory = Assert-WorkspaceOutput $BuildDirectory
$RunDirectory = Assert-WorkspaceOutput $RunDirectory
$null = [IO.Directory]::CreateDirectory($RunDirectory)
$Report = [ordered]@{
    schemaVersion = 1
    scope = 'Actual EGO DLL thread notifications under an inert console API shim; no graphics, ReShade runtime, producer, private transport or input acceptance.'
    architecture = $Architecture
    expectedStackOverflow = [bool]$ExpectStackOverflow
    negativeControlProof = 'Expected exit status only; a separate retained debugger stack establishes the overflow phase and cause.'
    crashDialogSuppressionInheritedFromParent = [bool]$SuppressCrashDialog
    candidate = $Candidate
    fixture = $null
    fixtureSources = @(
        (Read-FileIdentity (Join-Path $FixtureSource 'host.cpp')),
        (Read-FileIdentity (Join-Path $FixtureSource 'CMakeLists.txt'))
    )
    stdoutPath = Join-Path $RunDirectory 'stdout.log'
    stderrPath = Join-Path $RunDirectory 'stderr.log'
    status = 'running'
}
$Failure = $null
$Child = $null
$ChildStarted = $false
$OutTask = $null
$ErrTask = $null
try {
    if (-not $SkipBuild) {
        $null = [IO.Directory]::CreateDirectory($BuildDirectory)
        & cmake.exe -S $FixtureSource -B $BuildDirectory -G 'Visual Studio 17 2022' -A $Architecture *> (Join-Path $RunDirectory 'configure.log')
        if ($LASTEXITCODE -ne 0) { throw "Console fixture configure failed; see $RunDirectory\configure.log" }
        & cmake.exe --build $BuildDirectory --config Release *> (Join-Path $RunDirectory 'build.log')
        if ($LASTEXITCODE -ne 0) { throw "Console fixture build failed; see $RunDirectory\build.log" }
    }
    if (-not $FixturePath) {
        $FixturePath = Join-Path $BuildDirectory 'Release\preloaded_addon_small_stack_fixture.exe'
    }
    $Fixture = (Resolve-Path -LiteralPath $FixturePath).ProviderPath
    $null = Assert-WorkspaceOutput $Fixture
    if ([IO.Path]::GetFileName($Fixture) -cne 'preloaded_addon_small_stack_fixture.exe') {
        throw 'FixturePath must name the standalone small-stack console fixture.'
    }
    $Report.fixture = Read-FileIdentity $Fixture
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = $Fixture
    $Info.Arguments = '--addon "' + $Addon + '"'
    $Info.WorkingDirectory = $RunDirectory
    $Info.UseShellExecute = $false
    $Info.CreateNoWindow = $true
    $Info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $Child = [Diagnostics.Process]::new()
    $Child.StartInfo = $Info

    # SetErrorMode is process-local and inherited only when this owned child
    # starts. Restore the parent immediately; no registry/system setting changes.
    if ($SuppressCrashDialog -and -not ('EgoSmallStackLauncher.ErrorMode' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace EgoSmallStackLauncher {
    public static class ErrorMode {
        [DllImport("kernel32.dll")] public static extern uint GetErrorMode();
        [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);
    }
}
'@
    }
    $PreviousMode = $null
    try {
        if ($SuppressCrashDialog) {
            $PreviousMode = [EgoSmallStackLauncher.ErrorMode]::GetErrorMode()
            $null = [EgoSmallStackLauncher.ErrorMode]::SetErrorMode($PreviousMode -bor 0x8003)
        }
        if (-not $Child.Start()) { throw 'Could not start the owned console fixture.' }
        $ChildStarted = $true
    } finally {
        if ($null -ne $PreviousMode) { $null = [EgoSmallStackLauncher.ErrorMode]::SetErrorMode($PreviousMode) }
    }
    $Report.processId = $Child.Id
    $OutTask = $Child.StandardOutput.ReadToEndAsync()
    $ErrTask = $Child.StandardError.ReadToEndAsync()
    if (-not $Child.WaitForExit($TimeoutSeconds * 1000)) {
        $Child.Kill()
        $null = $Child.WaitForExit(5000)
        throw 'The owned console fixture timed out.'
    }
    $Child.WaitForExit()
    $ExitCode = $Child.ExitCode
    $UnsignedExitCode = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$ExitCode), 0)
    $Report.exitCode = $ExitCode
    $Report.exitCodeHex = '0x{0:X8}' -f $UnsignedExitCode
    if (-not $OutTask.Wait(5000) -or -not $ErrTask.Wait(5000)) { throw 'Fixture output collection timed out.' }
    [IO.File]::WriteAllText($Report.stdoutPath, $OutTask.Result, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($Report.stderrPath, $ErrTask.Result, [Text.UTF8Encoding]::new($false))
    if ((Read-FileIdentity $Addon).sha256 -cne $Candidate.sha256 -or
        (Read-FileIdentity $Fixture).sha256 -cne $Report.fixture.sha256) {
        throw 'The supplied candidate or fixture changed during execution.'
    }
    if ($ExpectStackOverflow) {
        if ($Report.exitCodeHex -cne '0xC00000FD') { throw 'The negative control did not exit with STATUS_STACK_OVERFLOW.' }
        if ($OutTask.Result -match '"status"\s*:\s*"passed"') { throw 'The negative control unexpectedly reported completed worker threads.' }
    } else {
        if ($ExitCode -ne 0) { throw "Actual add-on thread notification regression failed with $($Report.exitCodeHex)." }
        $Result = $OutTask.Result | ConvertFrom-Json
        if ($Result.status -cne 'passed' -or $Result.workerEntryAcks -ne 3 -or $Result.completedThreads -ne 3 -or
            $Result.participantReady -ne 0 -or $Result.registrations -ne 1 -or $Result.registeredEvents -ne 5 -or
            @($Result.requestedStackBytes).Count -ne 3 -or ($Result.requestedStackBytes -join ',') -cne '16384,32768,65536') {
            throw 'The console fixture omitted a required dormant/thread completion proof.'
        }
        $Report.result = $Result
    }
    $Report.status = 'passed'
} catch {
    $Failure = $_
    $Report.status = 'failed'
    $Report.error = $_.Exception.Message
} finally {
    $CleanupErrors = [Collections.Generic.List[string]]::new()
    if ($Child) {
        try {
            if ($ChildStarted -and -not $Child.HasExited) {
                $Child.Kill()
                if (-not $Child.WaitForExit(5000)) { throw 'The owned console fixture survived cleanup.' }
            }
        } catch { $CleanupErrors.Add($_.Exception.Message) }
        foreach ($Stream in @(@{ task = $OutTask; path = $Report.stdoutPath }, @{ task = $ErrTask; path = $Report.stderrPath })) {
            try {
                if ($Stream.task -and $Stream.task.IsCompleted) {
                    if ($Stream.task.IsFaulted -or $Stream.task.IsCanceled) { throw "Fixture output task failed: $($Stream.path)" }
                    [IO.File]::WriteAllText($Stream.path, $Stream.task.Result, [Text.UTF8Encoding]::new($false))
                }
            } catch { $CleanupErrors.Add($_.Exception.Message) }
        }
        try { $Child.Dispose() } catch { $CleanupErrors.Add($_.Exception.Message) }
    }
    if ($CleanupErrors.Count -gt 0) {
        $Report.cleanupErrors = @($CleanupErrors)
        $Report.status = 'failed'
        if (-not $Failure) { $Failure = [InvalidOperationException]::new('Owned console fixture cleanup or output collection failed.') }
    }
    [IO.File]::WriteAllText((Join-Path $RunDirectory 'evidence.json'), ($Report | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}
if ($Failure) { throw $Failure }
Write-Host "PRELOADED_ADDON_SMALL_STACK_PASS $RunDirectory"
