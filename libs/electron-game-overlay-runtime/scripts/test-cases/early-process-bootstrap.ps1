#requires -Version 7.2
[CmdletBinding()]
param(
    [ValidateSet('x64', 'Win32')][string]$Architecture = 'x64',
    [string]$DetoursSourceDirectory,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$sourceRoot = Join-Path $repoRoot 'libs\electron-game-overlay-runtime\tests\early-process-bootstrap'
$buildRoot = Join-Path $repoRoot 'build\early-process-bootstrap'
if (-not $DetoursSourceDirectory) {
    $DetoursSourceDirectory = Join-Path $repoRoot 'build\early-process-bootstrap-deps\Detours-v4.0.1'
}
$DetoursSourceDirectory = (Resolve-Path -LiteralPath $DetoursSourceDirectory).Path
$lock = Get-Content -LiteralPath (Join-Path $sourceRoot 'detours-source-lock.json') -Raw | ConvertFrom-Json
foreach ($file in $lock.files) {
    $body = [IO.File]::ReadAllText((Join-Path $DetoursSourceDirectory $file.path)).Replace("`r`n", "`n")
    $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($body))).ToLowerInvariant()
    if ($actual -cne $file.lfSha256) { throw "Official Detours source identity mismatch: $($file.path)" }
}
$compileRoot = Join-Path $buildRoot "compile-$Architecture"
if (-not $SkipBuild) {
    & cmake -S $sourceRoot -B $compileRoot -G 'Visual Studio 17 2022' -A $Architecture "-DDETOURS_SOURCE_DIR=$DetoursSourceDirectory"
    if ($LASTEXITCODE -ne 0) { throw "Isolated first-import proof configure failed: $LASTEXITCODE" }
    & cmake --build $compileRoot --config Release
    if ($LASTEXITCODE -ne 0) { throw "Isolated first-import proof build failed: $LASTEXITCODE" }
}
$bits = if ($Architecture -eq 'x64') { '64' } else { '32' }
$runRoot = Join-Path $buildRoot ('runs\run-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
$assets = @()
foreach ($leaf in @('early_process_bootstrap_launcher.exe', 'early_process_bootstrap_host.exe', 'early_original_graphics.dll', "early_process_bootstrap$bits.dll")) {
    $original = (Resolve-Path -LiteralPath (Join-Path $compileRoot "Release\$leaf")).Path
    $staged = Join-Path $runRoot $leaf
    Copy-Item -LiteralPath $original -Destination $staged
    $originalHash = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash
    $stagedHash = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash
    if ($originalHash -cne $stagedHash) { throw "Proof copy identity mismatch: $leaf" }
    $assets += [ordered]@{ leaf=$leaf; source=$original; staged=$staged; sha256=$stagedHash }
}
Copy-Item -LiteralPath (Join-Path $DetoursSourceDirectory 'LICENSE.md') -Destination (Join-Path $runRoot 'LICENSE.Detours.md')
[IO.File]::WriteAllText((Join-Path $runRoot 'owned-run.txt'), "EGO_EARLY_PROCESS_BOOTSTRAP_V1`n", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $runRoot 'trace.ndjson'), '', [Text.UTF8Encoding]::new($false))
$sourceAssets = @(Get-ChildItem -LiteralPath $sourceRoot -File | Sort-Object Name | ForEach-Object {
    [ordered]@{ leaf=$_.Name; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
$evidence = [ordered]@{
    schemaVersion=1
    scope='isolated-first-import-D3D12-pre-main-proof'
    status='failed'
    architecture=$Architecture
    runDirectory=$runRoot
    detoursRepository=$lock.repository
    detoursCommit=$lock.commit
    detoursSourceVerified=$true
    assets=$assets
    sourceAssets=$sourceAssets
    loadsReShade=$false
    productionActivation=$false
    automaticAttachmentProven=$false
}
$process = [Diagnostics.Process]::new()
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $runRoot 'early_process_bootstrap_launcher.exe'
$start.WorkingDirectory = $runRoot
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process.StartInfo = $start
$started = $false
try {
    $started = $process.Start()
    if (-not $started) { throw 'Could not start owned first-import launcher.' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(45000)) {
        # This exact retained helper handle belongs to this run. It never
        # attaches to an existing game, and the native child timeout is 30s.
        $process.Kill()
        $process.WaitForExit()
        throw 'Owned first-import launcher exceeded its outer 45-second bound.'
    }
    $stdout.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $runRoot 'stdout.log') -Encoding utf8
    $stderr.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $runRoot 'stderr.log') -Encoding utf8
    $evidence.launcherExitCode = $process.ExitCode
    if ($process.ExitCode -ne 0) { throw "Owned first-import launcher failed: $($process.ExitCode). Inspect $runRoot" }
    & node (Join-Path $sourceRoot 'validate-evidence.cjs') $runRoot
    if ($LASTEXITCODE -ne 0) { throw "First-import evidence validation failed: $LASTEXITCODE" }
    $evidence.validation = Get-Content -LiteralPath (Join-Path $runRoot 'validation-result.json') -Raw | ConvertFrom-Json
    foreach ($asset in $assets) {
        if ((Get-FileHash -LiteralPath $asset.staged -Algorithm SHA256).Hash -cne $asset.sha256) {
            throw "Proof binary changed during execution: $($asset.leaf)"
        }
    }
    $evidence.status = 'passed'
    Write-Output "First-import controlled proof passed (not ReShade/overlay acceptance): $runRoot"
} catch {
    $evidence.error = $_.Exception.Message
    throw
} finally {
    if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
    $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runRoot 'evidence.json') -Encoding utf8
}
