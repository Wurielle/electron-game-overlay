[CmdletBinding()]
param(
    [ValidateSet('x64', 'x86', 'all')][string]$Architecture = 'all'
)
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$Source = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\tests\cooperative-resource-soak'
$Header = Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\src\ego_cooperative_registry.hpp'
$Node = (Get-Command node.exe -CommandType Application -All -ErrorAction Stop | Select-Object -First 1).Source
$Run = Join-Path $RepoRoot ('build\cooperative-resource-soak\run-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Run | Out-Null
$Cases = if ($Architecture -eq 'all') { @('x64', 'x86') } else { @($Architecture) }
$Report = [ordered]@{
    schemaVersion = 1; status = 'failed'
    scope = 'Controlled registry metadata/resource fixture only; no native engine, injector, ReShade, GPU, SDK or game acceptance.'
    resourceOracle = 'Exact quiescent tracked C++ allocations, handles, threads and modules; private bytes diagnostic only.'
    architectures = @(); error = $null
}
try {
    $SourceHash = (Get-FileHash -LiteralPath (Join-Path $Source 'fixture.cpp') -Algorithm SHA256).Hash
    $HeaderHash = (Get-FileHash -LiteralPath $Header -Algorithm SHA256).Hash
    foreach ($Case in $Cases) {
        $Build = Join-Path $RepoRoot "build\cooperative-resource-soak\compile-$Case"
        $Platform = if ($Case -eq 'x86') { 'Win32' } else { 'x64' }
        & cmake.exe -S $Source -B $Build -G 'Visual Studio 17 2022' -A $Platform
        if ($LASTEXITCODE -ne 0) { throw "Resource soak $Case configure failed." }
        & cmake.exe --build $Build --config RelWithDebInfo
        if ($LASTEXITCODE -ne 0) { throw "Resource soak $Case build failed." }
        $Executable = (Resolve-Path -LiteralPath (Join-Path $Build 'RelWithDebInfo\cooperative_resource_soak.exe')).Path
        $Results = @()
        foreach ($Mode in @('stable-participant', 'lifetime-capacity', 'concurrent-departure', 'admission-transaction')) {
            $Info = [Diagnostics.ProcessStartInfo]::new()
            $Info.FileName = $Executable; $Info.Arguments = $Mode; $Info.WorkingDirectory = $Run
            $Info.UseShellExecute = $false; $Info.CreateNoWindow = $true
            $Info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
            $Info.RedirectStandardOutput = $true; $Info.RedirectStandardError = $true
            $Child = [Diagnostics.Process]::new(); $Child.StartInfo = $Info
            try {
                if (-not $Child.Start()) { throw "Could not start $Case $Mode fixture." }
                $Out = $Child.StandardOutput.ReadToEndAsync(); $Err = $Child.StandardError.ReadToEndAsync()
                if (-not $Child.WaitForExit(60000)) { $Child.Kill(); $Child.WaitForExit(); throw "$Case $Mode fixture timed out." }
                $Stdout = $Out.GetAwaiter().GetResult(); $Stderr = $Err.GetAwaiter().GetResult()
                $Stdout | Set-Content -LiteralPath (Join-Path $Run "$Case-$Mode.stdout.json") -Encoding UTF8
                $Stderr | Set-Content -LiteralPath (Join-Path $Run "$Case-$Mode.stderr.log") -Encoding UTF8
                if ($Child.ExitCode -ne 0) { throw "$Case $Mode fixture failed: $Stderr" }
                $Results += $Stdout | ConvertFrom-Json
            } finally { $Child.Dispose() }
        }
        $ResultsPath = Join-Path $Run "$Case-results.json"
        ConvertTo-Json -InputObject @($Results) -Depth 8 | Set-Content -LiteralPath $ResultsPath -Encoding UTF8
        & $Node (Join-Path $Source 'evidence.cjs') $Case $ResultsPath
        if ($LASTEXITCODE -ne 0) { throw "$Case resource soak evidence was incomplete." }
        $Report.architectures += [ordered]@{ architecture = $Case; sourceSha256 = $SourceHash; registrySha256 = $HeaderHash; executableSha256 = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash; results = $Results }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $Source 'fixture.cpp') -Algorithm SHA256).Hash -ne $SourceHash -or
        (Get-FileHash -LiteralPath $Header -Algorithm SHA256).Hash -ne $HeaderHash) { throw 'Resource fixture source changed during validation.' }
    $Report.status = 'passed'
} catch {
    $Report.error = $_.Exception.Message
    throw
} finally {
    $Report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $Run 'evidence.json') -Encoding UTF8
    Write-Host "Controlled resource soak evidence: $Run"
}
