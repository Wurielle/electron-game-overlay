[CmdletBinding()]
param(
    [string]$InjectorPath,
    [string]$ReShadePath
)

$ErrorActionPreference = "Stop"

function Start-InjectorProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    foreach ($Argument in $Arguments) {
        if ($Argument -match '\s') {
            throw "The controlled injector gate requires whitespace-free arguments: $Argument"
        }
    }

    $StartInfo = New-Object Diagnostics.ProcessStartInfo
    $StartInfo.FileName = $FilePath
    $StartInfo.Arguments = $Arguments -join " "
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true

    $Process = New-Object Diagnostics.Process
    $Process.StartInfo = $StartInfo
    if (-not $Process.Start()) {
        $Process.Dispose()
        throw "Unable to start the controlled injector process."
    }

    return $Process
}

function Get-LoadedModulePaths([Diagnostics.Process]$Process) {
    $Process.Refresh()
    if ($Process.HasExited) {
        throw "The target process exited before its module set could be inspected."
    }

    return @(
        $Process.Modules |
            ForEach-Object { [IO.Path]::GetFullPath($_.FileName) }
    )
}

function Assert-CandidateNotLoaded {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]
        [string]$CandidatePath
    )

    foreach ($ModulePath in Get-LoadedModulePaths $Process) {
        if ($ModulePath.Equals(
                $CandidatePath,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "The inactive ReShade fixture was unexpectedly loaded: $CandidatePath"
        }
    }
}

function Assert-Refusal {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Injector,
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)]
        [string]$CandidatePath,
        [Parameter(Mandatory = $true)]
        [string]$CandidateHash,
        [string[]]$StdoutPrefix = @()
    )

    $StdoutTask = $Injector.StandardOutput.ReadToEndAsync()
    $StderrTask = $Injector.StandardError.ReadToEndAsync()
    if (-not $Injector.WaitForExit(10000)) {
        throw "The injector did not finish its inactive-installation preflight."
    }
    $Injector.WaitForExit()
    $Injector.Refresh()
    if ($Injector.ExitCode -ne 183) {
        throw "The injector returned $($Injector.ExitCode), expected ERROR_ALREADY_EXISTS (183)."
    }

    $Target.Refresh()
    if ($Target.HasExited) {
        throw "The target exited while the injector inspected its inactive ReShade installation."
    }

    if (-not $StdoutTask.Wait(1000) -or -not $StderrTask.Wait(1000)) {
        throw "The injector output streams did not close after process exit."
    }
    $Lines = @($StdoutPrefix) + @(
        $StdoutTask.Result -split '\r?\n' |
            Where-Object { $_ -ne "" }
    )
    if (-not [string]::IsNullOrEmpty($StderrTask.Result)) {
        throw "The injector wrote unexpected stderr: $($StderrTask.Result)"
    }

    $DiagnosticPrefix = "ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC "
    $DiagnosticLines = @(
        $Lines | Where-Object { $_.StartsWith($DiagnosticPrefix) }
    )
    if ($DiagnosticLines.Count -ne 1) {
        throw "Expected exactly one structured injector diagnostic, got $($DiagnosticLines.Count)."
    }

    try {
        $Diagnostic = $DiagnosticLines[0].Substring(
            $DiagnosticPrefix.Length
        ) | ConvertFrom-Json
    }
    catch {
        throw "The injector diagnostic was not valid JSON: $($DiagnosticLines[0])"
    }

    $PropertyNames = @(
        $Diagnostic.PSObject.Properties.Name |
            Sort-Object
    )
    if (($PropertyNames -join ",") -cne
        "addonDirectoryPath,code,electronGameOverlayAddonDisabled,injectionStarted,modulePath,pid,reshadeBasePath,schemaVersion,stage,targetExecutablePath") {
        throw "The inactive-installation diagnostic schema was not exact: $($PropertyNames -join ',')"
    }
    $ExpectedBasePath = [IO.Path]::GetFullPath(
        (Split-Path -Parent $CandidatePath)
    )
    if ($Diagnostic.schemaVersion -ne 1 -or
        $Diagnostic.stage -ne "target-preflight" -or
        $Diagnostic.code -ne "target-existing-reshade-installation" -or
        $Diagnostic.pid -ne $Target.Id -or
        $Diagnostic.injectionStarted -ne $false -or
        $Diagnostic.electronGameOverlayAddonDisabled -ne $false -or
        -not ([string]$Diagnostic.targetExecutablePath).Equals(
            [IO.Path]::GetFullPath($Target.MainModule.FileName),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$Diagnostic.modulePath).Equals(
            $CandidatePath,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$Diagnostic.reshadeBasePath).Equals(
            $ExpectedBasePath,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$Diagnostic.addonDirectoryPath).Equals(
            $ExpectedBasePath,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The inactive-installation diagnostic had unexpected fields: $($DiagnosticLines[0])"
    }

    if (@($Lines | Where-Object {
                $_.StartsWith("ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ")
            }).Count -ne 0) {
        throw "The injector published a success result after refusing the existing installation."
    }
    if ($Lines -notcontains "ReShade injection not started.") {
        throw "The injector omitted its conservative not-started marker."
    }
    if (($Lines -join "`n") -match "Injecting ReShade") {
        throw "The injector entered its payload-loading path after the preflight refusal."
    }

    Assert-CandidateNotLoaded -Process $Target -CandidatePath $CandidatePath
    $ActualHash = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $CandidatePath
    ).Hash
    if ($ActualHash -ne $CandidateHash) {
        throw "The inactive ReShade installation fixture was modified."
    }
}

function Invoke-PreflightCase {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("ExactPid", "PathWatcher")]
        [string]$Lane,
        [Parameter(Mandatory = $true)]
        [string]$GateRoot,
        [Parameter(Mandatory = $true)]
        [string]$Injector,
        [Parameter(Mandatory = $true)]
        [string]$ReShade
    )

    $Token = "ego-reshade-preflight-" +
        $Lane.ToLowerInvariant() + "-" +
        [Guid]::NewGuid().ToString("N")
    $CaseRoot = Join-Path $GateRoot $Token
    New-Item -ItemType Directory -Path $CaseRoot -Force | Out-Null

    $TargetPath = Join-Path $CaseRoot "preflight-fixture.exe"
    $CandidateName = if ($Lane -eq "ExactPid") {
        "inactive-reshade.dll"
    }
    else {
        "inactive-reshade.asi"
    }
    $CandidatePath = Join-Path $CaseRoot $CandidateName
    Copy-Item -LiteralPath "$env:WINDIR\System32\ping.exe" -Destination $TargetPath
    Copy-Item -LiteralPath $ReShade -Destination $CandidatePath
    $TargetPath = [IO.Path]::GetFullPath($TargetPath)
    $CandidatePath = [IO.Path]::GetFullPath($CandidatePath)
    $CandidateHash = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $CandidatePath
    ).Hash

    $InjectorProcess = $null
    $TargetProcess = $null
    $StdoutPrefix = @()

    try {
        if ($Lane -eq "PathWatcher") {
            $InjectorProcess = Start-InjectorProcess `
                -FilePath $Injector `
                -Arguments @("--path-contains", $Token)
            $ReadyTask = $InjectorProcess.StandardOutput.ReadLineAsync()
            if (-not $ReadyTask.Wait(10000) -or
                $ReadyTask.Result -ne "ReShade path watcher armed.") {
                throw "The path-watcher injector did not arm."
            }
            $StdoutPrefix = @($ReadyTask.Result)
        }

        $TargetProcess = Start-Process -FilePath $TargetPath `
            -ArgumentList @("127.0.0.1", "-n", "30") `
            -WindowStyle Hidden `
            -PassThru
        Assert-CandidateNotLoaded `
            -Process $TargetProcess `
            -CandidatePath $CandidatePath

        if ($Lane -eq "ExactPid") {
            $InjectorProcess = Start-InjectorProcess `
                -FilePath $Injector `
                -Arguments @(
                    "preflight-fixture.exe",
                    "--pid",
                    [string]$TargetProcess.Id
                )
        }

        Assert-Refusal `
            -Injector $InjectorProcess `
            -Target $TargetProcess `
            -CandidatePath $CandidatePath `
            -CandidateHash $CandidateHash `
            -StdoutPrefix $StdoutPrefix
    }
    finally {
        foreach ($Process in @($InjectorProcess, $TargetProcess)) {
            if ($null -ne $Process) {
                try {
                    $Process.Refresh()
                    if (-not $Process.HasExited) {
                        $Process.Kill()
                        $Process.WaitForExit()
                    }
                }
                catch {
                    Write-Warning "Unable to stop gate process $($Process.Id): $_"
                }
                $Process.Dispose()
            }
        }
    }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$DefaultRuntimeDirectory = Join-Path $RepoRoot (
    "libs\electron-game-overlay-runtime\dist\win32-x64"
)
$Injector = if ([string]::IsNullOrWhiteSpace($InjectorPath)) {
    Join-Path $DefaultRuntimeDirectory "inject.exe"
}
else {
    [IO.Path]::GetFullPath($InjectorPath)
}
$ReShade = if ([string]::IsNullOrWhiteSpace($ReShadePath)) {
    Join-Path $DefaultRuntimeDirectory "ReShade64.dll"
}
else {
    [IO.Path]::GetFullPath($ReShadePath)
}
foreach ($RequiredPath in @($Injector, $ReShade)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
        throw "Build the runtime before running the existing-installation gate: $RequiredPath"
    }
}
$Injector = (Resolve-Path -LiteralPath $Injector).Path
$ReShade = (Resolve-Path -LiteralPath $ReShade).Path

$GateRoot = Join-Path $env:TEMP (
    "electron-game-overlay-existing-reshade-preflight-" +
    [Guid]::NewGuid().ToString("N")
)

try {
    New-Item -ItemType Directory -Path $GateRoot -Force | Out-Null
    Invoke-PreflightCase `
        -Lane ExactPid `
        -GateRoot $GateRoot `
        -Injector $Injector `
        -ReShade $ReShade
    Invoke-PreflightCase `
        -Lane PathWatcher `
        -GateRoot $GateRoot `
        -Injector $Injector `
        -ReShade $ReShade

    Write-Host (
        "Existing inactive ReShade installation preflight gate passed " +
        "for exact-PID and path-watcher injection."
    )
}
finally {
    if (Test-Path -LiteralPath $GateRoot -PathType Container) {
        Remove-Item -LiteralPath $GateRoot -Recurse -Force
    }
}
