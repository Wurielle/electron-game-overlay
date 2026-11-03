#requires -Version 7.2
[CmdletBinding()]
param(
    [ValidateSet('x64', 'Win32')][string]$Architecture = 'x64',
    [switch]$Warp,
    [ValidateRange(60, 3600)][int]$Frames = 60
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$sourceDirectory = Join-Path $repoRoot 'libs\electron-game-overlay-runtime\tests\late-d3d12-queue-query'
$buildRoot = Join-Path $repoRoot 'build\late-d3d12-queue-query'
$compileDirectory = Join-Path $buildRoot "compile-$Architecture"
& cmake -S $sourceDirectory -B $compileDirectory -G 'Visual Studio 17 2022' -A $Architecture
if ($LASTEXITCODE -ne 0) { throw "Probe configure failed: $LASTEXITCODE" }
& cmake --build $compileDirectory --config Release --target late_d3d12_queue_query_host
if ($LASTEXITCODE -ne 0) { throw "Probe build failed: $LASTEXITCODE" }

$runDirectory = Join-Path $buildRoot ('runs\run-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$hostPath = Join-Path $runDirectory 'late_d3d12_queue_query_host.exe'
Copy-Item -LiteralPath (Join-Path $compileDirectory 'Release\late_d3d12_queue_query_host.exe') -Destination $hostPath
$reportPath = Join-Path $runDirectory 'report.json'
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $hostPath
$start.WorkingDirectory = $runDirectory
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.ArgumentList.Add('--report')
$start.ArgumentList.Add($reportPath)
$start.ArgumentList.Add('--frames')
$start.ArgumentList.Add([string]$Frames)
if ($Warp) { $start.ArgumentList.Add('--warp') }
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
try {
    if (-not $process.Start()) { throw 'Could not start owned D3D12 probe.' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit(180000)
    if ($timedOut) {
        $process.Kill()
        $process.WaitForExit()
    }
    $stdout.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $runDirectory 'stdout.log') -Encoding utf8
    $stderr.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $runDirectory 'stderr.log') -Encoding utf8
    if ($timedOut) { throw "Owned D3D12 probe timed out. Stage: $runDirectory" }
    if ($process.ExitCode -ne 0) { throw "Owned D3D12 probe failed with exit $($process.ExitCode). Stage: $runDirectory" }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if (-not $report.probeCompleted -or $report.completedFramesBeforeQueries -ne $Frames) {
        throw "Probe report is incomplete: $reportPath"
    }
    Write-Output "Capability report (not overlay/game acceptance): $reportPath"
} finally {
    $process.Dispose()
}
