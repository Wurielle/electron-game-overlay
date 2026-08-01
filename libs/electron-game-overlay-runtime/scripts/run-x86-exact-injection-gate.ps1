[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("d3d9", "d3d10")]
    [string]$Backend,
    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $RuntimeRoot "..\..")).Path
$SharedBuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
$X86BuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime-x86"
$OutputDirectory = Join-Path $X86BuildRoot "RelWithDebInfo"
$ReShadeOutputDirectory =
    Join-Path $SharedBuildRoot "_deps\reshade-src\bin\Win32\Release"
$HostName = "${Backend}_overlay_test_host.exe"
$BuiltHost = Join-Path $OutputDirectory $HostName
$BuiltAddon =
    Join-Path $OutputDirectory "native_input_gate_addon.addon32"
$BuiltRuntime = Join-Path $ReShadeOutputDirectory "ReShade32.dll"
$BuiltInjector = Join-Path $ReShadeOutputDirectory "inject.exe"
$Config = Join-Path $RuntimeRoot "config\ReShade.ini"
$BuildPreset = switch ($Backend) {
    "d3d9" { "relwithdebinfo-x86-dx9" }
    "d3d10" { "relwithdebinfo-x86-dx10" }
}
$RunDirectory = Join-Path $X86BuildRoot "exact-injection-gate-$Backend"
$TargetDirectory = Join-Path $RunDirectory "target"
$WrongTargetDirectory = Join-Path $RunDirectory "wrong-target"
$RuntimeDirectory = Join-Path $RunDirectory "runtime"
$RuntimeLogMarker =
    "Native input gate add-on rendered its first ImGui frame."

function Assert-X86PortableExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $Stream = [IO.File]::Open(
        $Path,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::ReadWrite)
    $Reader = New-Object IO.BinaryReader($Stream)
    try {
        if ($Stream.Length -lt 64 -or $Reader.ReadUInt16() -ne 0x5A4D) {
            throw "Artifact is not a PE image: $Path"
        }
        $Stream.Position = 0x3C
        $PeOffset = $Reader.ReadUInt32()
        if ($PeOffset -gt $Stream.Length - 6) {
            throw "Artifact has an invalid PE header offset: $Path"
        }
        $Stream.Position = $PeOffset
        if ($Reader.ReadUInt32() -ne 0x00004550) {
            throw "Artifact has an invalid PE signature: $Path"
        }
        $Machine = $Reader.ReadUInt16()
        if ($Machine -ne 0x014C) {
            throw (
                "Expected an x86 PE image, but '{0}' has machine 0x{1:X4}." -f
                $Path,
                $Machine)
        }
    }
    finally {
        $Reader.Dispose()
        $Stream.Dispose()
    }
}

function Remove-IsolatedRunDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$BuildRoot
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $ResolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $ResolvedBuildRoot = (Resolve-Path -LiteralPath $BuildRoot).Path
    if (-not $ResolvedPath.StartsWith(
            $ResolvedBuildRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean an exact-injection gate directory outside the x86 build root: $ResolvedPath"
    }

    $Item = Get-Item -LiteralPath $ResolvedPath -Force
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to clean a reparse-point exact-injection gate directory: $ResolvedPath"
    }
    Remove-Item -LiteralPath $ResolvedPath -Recurse -Force
}

function Wait-ForProcessExit {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]
        [int]$Milliseconds
    )

    try {
        $Exited = $Process.WaitForExit($Milliseconds)
        if ($Exited) {
            # Complete redirected-stream draining and refresh PowerShell's
            # process wrapper before reading ExitCode.
            $Process.WaitForExit()
            $Process.Refresh()
        }
        return $Exited
    }
    catch [InvalidOperationException] {
        return $true
    }
}

function Stop-ControlledHost {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Process,
        [switch]$RequireGraceful
    )

    $Process.Refresh()
    if ($Process.HasExited) {
        return $true
    }

    $Graceful = $Process.CloseMainWindow() -and
        (Wait-ForProcessExit -Process $Process -Milliseconds 5000)
    if ($Graceful) {
        return $true
    }
    if ($RequireGraceful) {
        return $false
    }

    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $Process.Id -Timeout 5 -ErrorAction SilentlyContinue
    return $false
}

function Wait-ForLogMarker {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Marker,
        [Parameter(Mandatory = $true)]
        [DateTime]$Deadline,
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$HostProcess
    )

    while ([DateTime]::UtcNow -lt $Deadline) {
        $HostProcess.Refresh()
        if ($HostProcess.HasExited) {
            throw "The controlled $Backend x86 host exited before ReShade rendered its first ImGui frame."
        }

        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            try {
                $LogText = [string](Get-Content -Raw -LiteralPath $Path)
                if ($LogText.IndexOf(
                        $Marker,
                        [StringComparison]::Ordinal) -ge 0) {
                    return
                }
            }
            catch [IO.IOException] {
                # ReShade may be appending while the gate samples the log.
            }
        }
        Start-Sleep -Milliseconds 50
    }

    throw "Timed out waiting for '$Marker' in $Path."
}

Push-Location $RuntimeRoot
try {
    & cmake.exe --preset vs2022-x86
    if ($LASTEXITCODE -ne 0) {
        throw "CMake x86 configure failed with exit code $LASTEXITCODE."
    }
    & cmake.exe --build --preset $BuildPreset
    if ($LASTEXITCODE -ne 0) {
        throw "Controlled $Backend x86 host build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

& (Join-Path $PSScriptRoot "build-reshade-runtime.ps1") -Architecture x86
if ($LASTEXITCODE -ne 0) {
    throw "Building the x86 ReShade runtime and injector failed with exit code $LASTEXITCODE."
}

$RequiredFiles = @(
    $BuiltHost,
    $BuiltAddon,
    $BuiltRuntime,
    $BuiltInjector,
    $Config
)
foreach ($RequiredFile in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "Required x86 exact-injection artifact is missing: $RequiredFile"
    }
}
foreach ($PortableExecutable in @(
        $BuiltHost,
        $BuiltAddon,
        $BuiltRuntime,
        $BuiltInjector)) {
    Assert-X86PortableExecutable -Path $PortableExecutable
}

Remove-IsolatedRunDirectory -Path $RunDirectory -BuildRoot $X86BuildRoot
New-Item -ItemType Directory -Path $RunDirectory | Out-Null
New-Item -ItemType Directory -Path $TargetDirectory | Out-Null
New-Item -ItemType Directory -Path $WrongTargetDirectory | Out-Null
New-Item -ItemType Directory -Path $RuntimeDirectory | Out-Null

$TargetPath = Join-Path $TargetDirectory $HostName
$WrongTargetPath = Join-Path $WrongTargetDirectory $HostName
$InjectorPath = Join-Path $RuntimeDirectory "inject.exe"
$ReShadeLog = Join-Path $RuntimeDirectory "ReShade.log"
$NegativeInjectorStdout =
    Join-Path $RuntimeDirectory "inject.wrong-target.stdout.log"
$NegativeInjectorStderr =
    Join-Path $RuntimeDirectory "inject.wrong-target.stderr.log"
$InjectorStdout = Join-Path $RuntimeDirectory "inject.stdout.log"
$InjectorStderr = Join-Path $RuntimeDirectory "inject.stderr.log"
Copy-Item -LiteralPath $BuiltHost -Destination $TargetPath
Copy-Item -LiteralPath $BuiltHost -Destination $WrongTargetPath
Copy-Item -LiteralPath $BuiltAddon -Destination (
    Join-Path $RuntimeDirectory "native_input_gate_addon.addon32")
Copy-Item -LiteralPath $BuiltRuntime -Destination (
    Join-Path $RuntimeDirectory "ReShade32.dll")
Copy-Item -LiteralPath $BuiltInjector -Destination $InjectorPath
Copy-Item -LiteralPath $Config -Destination (
    Join-Path $RuntimeDirectory "ReShade.ini")
New-Item -ItemType File -Path (
    Join-Path $TargetDirectory "reshade-input-gate.enabled") | Out-Null
New-Item -ItemType File -Path (
    Join-Path $TargetDirectory "reshade-injection-wait.enabled") | Out-Null

$ControlledEnvironmentVariables = @(
    "ELECTRON_GAME_OVERLAY_RUN_DIRECTORY",
    "RESHADE_BASE_PATH_OVERRIDE",
    "RESHADE_DISABLE_GRAPHICS_HOOK",
    "RESHADE_DISABLE_INPUT_HOOK",
    "RESHADE_DISABLE_LOADING_CHECK",
    "RESHADE_DISABLE_LOGGING"
)
$PreviousEnvironment = @{}
$HostProcess = $null
$InjectorProcess = $null
$Passed = $false

foreach ($VariableName in $ControlledEnvironmentVariables) {
    $PreviousEnvironment[$VariableName] =
        [Environment]::GetEnvironmentVariable($VariableName, "Process")
    [Environment]::SetEnvironmentVariable($VariableName, $null, "Process")
}

try {
    Write-Host ""
    Write-Host "Controlled x86 $Backend exact-PID injection gate"
    Write-Host "  run directory: $RunDirectory"

    $HostStartInfo = New-Object Diagnostics.ProcessStartInfo
    $HostStartInfo.FileName = $TargetPath
    $HostStartInfo.WorkingDirectory = $TargetDirectory
    $HostStartInfo.UseShellExecute = $false
    $HostProcess = New-Object Diagnostics.Process
    $HostProcess.StartInfo = $HostStartInfo
    if (-not $HostProcess.Start()) {
        throw "The controlled $Backend x86 host could not be started."
    }
    $ExpectedTargetPath = [IO.Path]::GetFullPath($TargetPath)
    $WrongExpectedTargetPath = [IO.Path]::GetFullPath($WrongTargetPath)
    if (-not [IO.Path]::GetFileName($WrongExpectedTargetPath).Equals(
            [IO.Path]::GetFileName($ExpectedTargetPath),
            [StringComparison]::OrdinalIgnoreCase) -or
        $WrongExpectedTargetPath.Equals(
            $ExpectedTargetPath,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The wrong-path preflight must use a different absolute path with the same basename."
    }

    $NegativeInjectorStartInfo = New-Object Diagnostics.ProcessStartInfo
    $NegativeInjectorStartInfo.FileName = $InjectorPath
    $NegativeInjectorStartInfo.Arguments =
        "`"$WrongExpectedTargetPath`" --pid $($HostProcess.Id)"
    $NegativeInjectorStartInfo.WorkingDirectory = $RuntimeDirectory
    $NegativeInjectorStartInfo.UseShellExecute = $false
    $NegativeInjectorStartInfo.CreateNoWindow = $true
    $NegativeInjectorStartInfo.RedirectStandardOutput = $true
    $NegativeInjectorStartInfo.RedirectStandardError = $true
    $InjectorProcess = New-Object Diagnostics.Process
    $InjectorProcess.StartInfo = $NegativeInjectorStartInfo
    if (-not $InjectorProcess.Start()) {
        throw "The x86 wrong-target exact-PID injector could not be started."
    }
    $NegativeInjectorStdoutTask =
        $InjectorProcess.StandardOutput.ReadToEndAsync()
    $NegativeInjectorStderrTask =
        $InjectorProcess.StandardError.ReadToEndAsync()
    $NegativeInjectorCompleted = Wait-ForProcessExit `
            -Process $InjectorProcess `
            -Milliseconds ($TimeoutSeconds * 1000)
    if (-not $NegativeInjectorCompleted) {
        Stop-Process -Id $InjectorProcess.Id -Force -ErrorAction SilentlyContinue
        $null = Wait-ForProcessExit `
            -Process $InjectorProcess `
            -Milliseconds 5000
    }
    $NegativeInjectorLog = [string]$NegativeInjectorStdoutTask.Result
    $NegativeInjectorError = [string]$NegativeInjectorStderrTask.Result
    $NegativeInjectorLog |
        Set-Content `
            -LiteralPath $NegativeInjectorStdout `
            -Encoding UTF8 `
            -NoNewline
    $NegativeInjectorError |
        Set-Content `
            -LiteralPath $NegativeInjectorStderr `
            -Encoding UTF8 `
            -NoNewline
    if (-not $NegativeInjectorCompleted) {
        throw "The x86 wrong-target exact-PID injector timed out after $TimeoutSeconds seconds."
    }
    $NegativeInjectorExitCode = $InjectorProcess.ExitCode
    if ($null -eq $NegativeInjectorExitCode) {
        throw "The x86 wrong-target exact-PID injector exited without publishing an exit code."
    }
    if ($NegativeInjectorExitCode -ne 123) {
        throw "Expected the x86 wrong-target exact-PID injector to exit with ERROR_INVALID_NAME (123), but it exited with $NegativeInjectorExitCode. Inspect $NegativeInjectorStdout and $NegativeInjectorStderr."
    }

    $NotStartedLines = @(
        $NegativeInjectorLog -split '\r?\n' |
            Where-Object {
                $_ -ceq "ReShade injection not started."
            }
    )
    if ($NotStartedLines.Count -ne 1) {
        throw "Expected exactly one 'ReShade injection not started.' marker from the wrong-target preflight, found $($NotStartedLines.Count). Inspect $NegativeInjectorStdout."
    }
    $NegativeInjectorEvidence =
        $NegativeInjectorLog + [Environment]::NewLine + $NegativeInjectorError
    if ($NegativeInjectorEvidence.Contains(
            "ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ") -or
        $NegativeInjectorEvidence.Contains(
            "ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ") -or
        $NegativeInjectorEvidence.Contains("Succeeded!")) {
        throw "The x86 wrong-target preflight emitted a structured result, diagnostic, or success marker. Inspect $NegativeInjectorStdout."
    }
    $ExpectedMismatchPrefix =
        "Target process executable path mismatch: PID $($HostProcess.Id)"
    if ($NegativeInjectorLog.IndexOf(
            $ExpectedMismatchPrefix,
            [StringComparison]::Ordinal) -lt 0) {
        throw "The x86 wrong-target preflight did not identify the exact PID path mismatch. Inspect $NegativeInjectorStdout."
    }

    $HostProcess.Refresh()
    if ($HostProcess.HasExited) {
        throw "The controlled $Backend x86 host exited during the wrong-target preflight."
    }
    if (Test-Path -LiteralPath $ReShadeLog) {
        throw "The wrong-target preflight created a ReShade log before the valid injection."
    }

    $InjectorProcess.Dispose()
    $InjectorProcess = $null

    $InjectorStartInfo = New-Object Diagnostics.ProcessStartInfo
    $InjectorStartInfo.FileName = $InjectorPath
    $InjectorStartInfo.Arguments =
        "`"$ExpectedTargetPath`" --pid $($HostProcess.Id)"
    $InjectorStartInfo.WorkingDirectory = $RuntimeDirectory
    $InjectorStartInfo.UseShellExecute = $false
    $InjectorStartInfo.CreateNoWindow = $true
    $InjectorStartInfo.RedirectStandardOutput = $true
    $InjectorStartInfo.RedirectStandardError = $true
    $InjectorProcess = New-Object Diagnostics.Process
    $InjectorProcess.StartInfo = $InjectorStartInfo
    if (-not $InjectorProcess.Start()) {
        throw "The x86 exact-PID injector could not be started."
    }
    $InjectorStdoutTask = $InjectorProcess.StandardOutput.ReadToEndAsync()
    $InjectorStderrTask = $InjectorProcess.StandardError.ReadToEndAsync()
    $InjectorCompleted = Wait-ForProcessExit `
            -Process $InjectorProcess `
            -Milliseconds ($TimeoutSeconds * 1000)
    if (-not $InjectorCompleted) {
        Stop-Process -Id $InjectorProcess.Id -Force -ErrorAction SilentlyContinue
        $null = Wait-ForProcessExit `
            -Process $InjectorProcess `
            -Milliseconds 5000
    }
    $InjectorLog = [string]$InjectorStdoutTask.Result
    $InjectorError = [string]$InjectorStderrTask.Result
    $InjectorLog |
        Set-Content -LiteralPath $InjectorStdout -Encoding UTF8 -NoNewline
    $InjectorError |
        Set-Content -LiteralPath $InjectorStderr -Encoding UTF8 -NoNewline
    if (-not $InjectorCompleted) {
        throw "The x86 exact-PID injector timed out after $TimeoutSeconds seconds."
    }
    $InjectorExitCode = $InjectorProcess.ExitCode
    if ($null -eq $InjectorExitCode) {
        throw "The x86 exact-PID injector exited without publishing an exit code."
    }
    if ($InjectorExitCode -ne 0) {
        throw "The x86 exact-PID injector exited with code $InjectorExitCode. $($InjectorError.Trim())"
    }

    $ResultPrefix = "ELECTRON_GAME_OVERLAY_INJECTOR_RESULT "
    $ResultLines = @(
        $InjectorLog -split '\r?\n' |
            Where-Object {
                $_.StartsWith($ResultPrefix, [StringComparison]::Ordinal)
            }
    )
    if ($ResultLines.Count -ne 1) {
        throw "Expected exactly one structured injector result, found $($ResultLines.Count). Inspect $InjectorStdout."
    }
    if ($InjectorLog.Contains("ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ") -or
        $InjectorLog.Contains("ReShade injection not started.")) {
        throw "The x86 injector emitted an ambiguous success contract. Inspect $InjectorStdout."
    }

    try {
        $InjectorResult = $ResultLines[0].Substring(
            $ResultPrefix.Length) | ConvertFrom-Json
    }
    catch {
        throw "The x86 injector emitted malformed result JSON. Inspect $InjectorStdout."
    }
    if ($InjectorResult.schemaVersion -ne 1 -or
        $InjectorResult.pid -ne $HostProcess.Id -or
        $InjectorResult.runtimeMode -cne "injected-runtime" -or
        -not [IO.Path]::GetFullPath(
            [string]$InjectorResult.targetExecutablePath).Equals(
                $ExpectedTargetPath,
                [StringComparison]::OrdinalIgnoreCase)) {
        throw "The x86 injector result did not identify the exact requested PID, path, and injected runtime mode: $($InjectorResult | ConvertTo-Json -Compress)"
    }

    Wait-ForLogMarker `
        -Path $ReShadeLog `
        -Marker $RuntimeLogMarker `
        -Deadline ([DateTime]::UtcNow.AddSeconds($TimeoutSeconds)) `
        -HostProcess $HostProcess

    if (-not (Stop-ControlledHost -Process $HostProcess -RequireGraceful)) {
        throw "The controlled $Backend x86 host did not close gracefully."
    }
    if ($HostProcess.ExitCode -ne 0) {
        throw "The controlled $Backend x86 host exited with code $($HostProcess.ExitCode)."
    }

    $Passed = $true
    $ResultMarker = "$($Backend.ToUpperInvariant())_X86_EXACT_INJECTION_GATE_PASS"
    $ResultMarker |
        Set-Content -LiteralPath (
            Join-Path $RunDirectory "result.txt") -Encoding UTF8
    Write-Host $ResultMarker
    Write-Host "Evidence preserved in: $RunDirectory"
}
finally {
    if ($InjectorProcess) {
        $InjectorProcess.Refresh()
        if (-not $InjectorProcess.HasExited) {
            Stop-Process `
                -Id $InjectorProcess.Id `
                -Force `
                -ErrorAction SilentlyContinue
            Wait-Process `
                -Id $InjectorProcess.Id `
                -Timeout 5 `
                -ErrorAction SilentlyContinue
        }
    }
    if ($HostProcess) {
        $null = Stop-ControlledHost -Process $HostProcess
    }
    foreach ($VariableName in $ControlledEnvironmentVariables) {
        [Environment]::SetEnvironmentVariable(
            $VariableName,
            $PreviousEnvironment[$VariableName],
            "Process")
    }

    if (-not $Passed) {
        Write-Host "Failed evidence preserved in: $RunDirectory"
    }
}
