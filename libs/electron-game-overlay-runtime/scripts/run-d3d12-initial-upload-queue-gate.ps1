#requires -Version 7.2
[CmdletBinding()]
param(
    [string]$RuntimePath,
    [ValidateSet('x64', 'Win32')][string]$Architecture = 'x64',
    [switch]$Warp,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$BuildRoot = Join-Path $RepoRoot 'build\d3d12-initial-upload-queue'
$Fixture = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\d3d12-initial-upload-queue'
$Compile = Join-Path $BuildRoot "compile-$Architecture"
$Header = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\src\ego_initial_texture_upload.hpp'
$Include = Join-Path $RepoRoot 'build\electron-game-overlay-runtime\_deps\reshade-src\include'
if (-not $RuntimePath) {
    $Leaf = if ($Architecture -eq 'x64') { 'ReShade64.dll' } else { 'ReShade32.dll' }
    $RuntimePath = Join-Path $RepoRoot "libs\electron-game-overlay\dist\runtime\win32-x64\reshade\$Leaf"
}
$RuntimePath = (Resolve-Path -LiteralPath $RuntimePath).Path
$RuntimeHash = (Get-FileHash -LiteralPath $RuntimePath -Algorithm SHA256).Hash.ToLowerInvariant()
$HeaderHash = (Get-FileHash -LiteralPath $Header -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $SkipBuild) {
    & cmake -S $Fixture -B $Compile -G 'Visual Studio 17 2022' -A $Architecture "-DRESHADE_INCLUDE_DIR=$Include"
    if ($LASTEXITCODE -ne 0) { throw 'The initial-upload queue fixture could not be configured.' }
    & cmake --build $Compile --config Release --target d3d12_initial_upload_queue
    if ($LASTEXITCODE -ne 0) { throw 'The initial-upload queue fixture could not be built.' }
}
$BuiltHost = Join-Path $Compile 'Release\d3d12_initial_upload_queue.exe'
if (-not (Test-Path -LiteralPath $BuiltHost -PathType Leaf)) { throw "Fixture executable is missing: $BuiltHost" }
$Run = Join-Path $BuildRoot ('run-' + [Guid]::NewGuid().ToString('N'))
$Stage = Join-Path $Run 'stage'
$Target = Join-Path $Run 'target'
New-Item -ItemType Directory -Path $Stage, $Target | Out-Null
$RuntimeCopy = Join-Path $Stage ([IO.Path]::GetFileName($RuntimePath))
$HostPath = Join-Path $Target 'd3d12_initial_upload_queue.exe'
Copy-Item -LiteralPath $RuntimePath -Destination $RuntimeCopy
Copy-Item -LiteralPath $BuiltHost -Destination $HostPath
Copy-Item -LiteralPath (Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\config\ReShade.ini') -Destination (Join-Path $Stage 'ReShade.ini')
. (Join-Path $PSScriptRoot 'owned-stage-marker.ps1')
Write-OwnedOverlayRunMarker -RunDirectory $Stage -BuildRoot $BuildRoot
$Report = [ordered]@{
    schemaVersion = 1; status = 'failed'; architecture = $Architecture
    scope = 'Console GPU regression using public ReShade device/queue APIs; no game, overlay, input or swap-chain acceptance claim.'
    runtimeSource = $RuntimePath; runtimeSha256 = $RuntimeHash
    helperSha256 = $HeaderHash; hostSha256 = (Get-FileHash -LiteralPath $HostPath).Hash.ToLowerInvariant()
    evidence = $Run; cases = @()
}

try {
    if ((Get-FileHash -LiteralPath $RuntimeCopy).Hash.ToLowerInvariant() -cne $RuntimeHash) { throw 'Staging changed the owned runtime bytes.' }
    foreach ($Mode in @('exact-runtime-queue', 'legacy-device-upload')) {
        $CaseDirectory = Join-Path $Run $Mode
        New-Item -ItemType Directory -Path $CaseDirectory | Out-Null
        $ChildReport = Join-Path $CaseDirectory 'report.json'
        $Info = [Diagnostics.ProcessStartInfo]::new()
        $Info.FileName = $HostPath; $Info.WorkingDirectory = $Target
        $Info.UseShellExecute = $false; $Info.CreateNoWindow = $true
        $Info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $Info.RedirectStandardOutput = $true; $Info.RedirectStandardError = $true
        foreach ($Name in @('RESHADE_BASE_PATH_OVERRIDE', 'RESHADE_DISABLE_GRAPHICS_HOOK', 'RESHADE_DISABLE_INPUT_HOOK', 'RESHADE_DISABLE_LOGGING')) {
            $Info.EnvironmentVariables.Remove($Name)
        }
        $Info.EnvironmentVariables['RESHADE_BASE_PATH_OVERRIDE'] = $Stage
        foreach ($Argument in @('--runtime', $RuntimeCopy, '--report', $ChildReport)) { $Info.ArgumentList.Add($Argument) }
        if ($Mode -eq 'legacy-device-upload') { $Info.ArgumentList.Add('--legacy-device-upload') }
        if ($Warp) { $Info.ArgumentList.Add('--warp') }
        $Process = [Diagnostics.Process]::new(); $Process.StartInfo = $Info
        try {
            if (-not $Process.Start()) { throw 'Could not start the owned console GPU fixture.' }
            $null = $Process.Handle
            $Creation = $Process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
            $Stdout = $Process.StandardOutput.ReadToEndAsync(); $Stderr = $Process.StandardError.ReadToEndAsync()
            if (-not $Process.WaitForExit(30000)) {
                $Process.Kill(); $Process.WaitForExit()
                throw "The owned console fixture timed out in $Mode."
            }
            $Stdout.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $CaseDirectory 'stdout.log') -Encoding utf8
            $Stderr.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $CaseDirectory 'stderr.log') -Encoding utf8
            if ($Process.ExitCode -ne 0) { throw "The owned console fixture failed in $Mode with exit $($Process.ExitCode)." }
            $Child = Get-Content -LiteralPath $ChildReport -Raw | ConvertFrom-Json
            if ($Child.processId -ne $Process.Id -or $Child.creationTime100ns -cne $Creation -or
                -not [string]::Equals($Child.executablePath, $HostPath, [StringComparison]::OrdinalIgnoreCase) -or
                $Child.helperSha256 -cne $HeaderHash -or -not $Child.completed) {
                throw "The $Mode result did not prove this exact owned child and current helper."
            }
            if ($Mode -eq 'exact-runtime-queue') {
                if (-not $Child.uploadCompletedWhileForeignQueueBlocked -or -not $Child.pixelsMatch -or $Child.watchdogReleasedGate) { throw 'The exact-queue upload did not complete correctly while the foreign queue remained blocked.' }
            } elseif (-not $Child.negativeControlDetected -or -not $Child.watchdogReleasedGate) {
                throw 'The legacy negative control did not expose the original queue-selection defect.'
            }
            $Report.cases += $Child
        } finally { $Process.Dispose() }
    }
    if ((Get-FileHash -LiteralPath $RuntimePath).Hash.ToLowerInvariant() -cne $RuntimeHash -or
        (Get-FileHash -LiteralPath $RuntimeCopy).Hash.ToLowerInvariant() -cne $RuntimeHash -or
        (Get-FileHash -LiteralPath $Header).Hash.ToLowerInvariant() -cne $HeaderHash) { throw 'A verified source or staged input changed during the regression.' }
    $Report.status = 'passed'
    Write-Output "D3D12_INITIAL_UPLOAD_QUEUE_PASS evidence=$Run"
} catch {
    $Report.error = $_.Exception.Message
    throw
} finally {
    $Report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $Run 'evidence.json') -Encoding utf8
}
