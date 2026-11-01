[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OfficialRuntimePath,
    [Parameter(Mandatory = $true)]
    [string]$ReShadeIncludeDirectory
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Runtime = (Resolve-Path -LiteralPath $OfficialRuntimePath).Path
$Headers = (Resolve-Path -LiteralPath $ReShadeIncludeDirectory).Path
if ([IO.Path]::GetExtension($Runtime) -ine '.dll') {
    throw 'Supply the official x64 full-add-on ReShade DLL.'
}
$PublicHeader = Join-Path $Headers 'reshade.hpp'
if (-not ((Get-Content -LiteralPath $PublicHeader -Raw) -match '#define RESHADE_API_VERSION 18\b')) {
    throw 'Supply unmodified public API-18 headers; patched API-19 headers are not accepted.'
}
$RuntimeHash = (Get-FileHash -LiteralPath $Runtime -Algorithm SHA256).Hash
$HeaderHashes = @(Get-ChildItem -LiteralPath $Headers -File | Sort-Object Name | ForEach-Object {
    [ordered]@{ name = $_.Name; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
$BuildDirectory = Join-Path $RepoRoot 'build\reshade-addon-isolation\compile'
$RunDirectory = Join-Path $RepoRoot (
    'build\reshade-addon-isolation\run-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') +
    '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $RunDirectory -ErrorAction Stop | Out-Null

& cmake -S $PSScriptRoot -B $BuildDirectory -G 'Visual Studio 17 2022' -A x64 "-DRESHADE_INCLUDE_DIRECTORY=$Headers"
if ($LASTEXITCODE -ne 0) { throw 'Probe configure failed.' }
& cmake --build $BuildDirectory --config RelWithDebInfo
if ($LASTEXITCODE -ne 0) { throw 'Probe build failed.' }

$ControlledVariables = @(
    'ELECTRON_GAME_OVERLAY_RUN_DIRECTORY', 'RESHADE_BASE_PATH_OVERRIDE',
    'RESHADE_DISABLE_LOADING_CHECK', 'RESHADE_DISABLE_GRAPHICS_HOOK',
    'RESHADE_DISABLE_INPUT_HOOK', 'RESHADE_DISABLE_LOGGING', 'RESHADE_DISABLE_NETWORK_HOOK'
)
$Results = @()
foreach ($Order in @('a-first', 'b-first')) {
    $Stage = Join-Path $RunDirectory $Order
    New-Item -ItemType Directory -Path $Stage -ErrorAction Stop | Out-Null
    foreach ($File in @('reshade_addon_isolation_host.exe', 'probe_a.dll', 'probe_b.dll', 'probe_duplicate.dll')) {
        Copy-Item -LiteralPath (Join-Path $BuildDirectory "RelWithDebInfo\$File") -Destination (Join-Path $Stage $File)
    }
    Rename-Item -LiteralPath (Join-Path $Stage 'reshade_addon_isolation_host.exe') -NewName 'ego_probe_host.exe'
    Copy-Item -LiteralPath $Runtime -Destination (Join-Path $Stage 'd3d11.dll')
    Copy-Item -LiteralPath $Runtime -Destination (Join-Path $Stage 'second-runtime.dll')
    @'
[GENERAL]
EffectSearchPaths=
TextureSearchPaths=

[INPUT]
GamepadNavigation=0
KeyOverlay=36,0,0,0
'@ | Set-Content -LiteralPath (Join-Path $Stage 'ReShade.ini') -Encoding ASCII
    $Stdout = Join-Path $Stage 'stdout.json'
    $Stderr = Join-Path $Stage 'stderr.txt'
    $StartInfo = [Diagnostics.ProcessStartInfo]::new()
    $StartInfo.FileName = Join-Path $Stage 'ego_probe_host.exe'
    $StartInfo.Arguments = $Order
    $StartInfo.WorkingDirectory = $Stage
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true
    foreach ($Variable in $ControlledVariables) { $StartInfo.Environment.Remove($Variable) | Out-Null }
    $Process = [Diagnostics.Process]::new()
    $Process.StartInfo = $StartInfo
    if (-not $Process.Start()) { throw 'Could not start the owned probe host.' }
    $ReadStdout = $Process.StandardOutput.ReadToEndAsync()
    $ReadStderr = $Process.StandardError.ReadToEndAsync()
    try {
        if (-not $Process.WaitForExit(30000)) { throw "Controlled $Order probe timed out." }
    }
    finally {
        if (-not $Process.HasExited) { $Process.Kill(); $Process.WaitForExit() }
        [IO.File]::WriteAllText($Stdout, $ReadStdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText($Stderr, $ReadStderr.GetAwaiter().GetResult())
        $ExitCode = $Process.ExitCode
        $Process.Dispose()
    }
    if ($ExitCode -ne 0) {
        throw "Controlled $Order probe failed (exit $ExitCode): $(Get-Content -LiteralPath $Stderr -Raw)"
    }
    $Record = Get-Content -LiteralPath $Stdout -Raw | ConvertFrom-Json
    $Logs = @(Get-ChildItem -LiteralPath $Stage -File | Where-Object { $_.Name -match '^ReShade\.log\d*$' })
    $LogText = ($Logs | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
    if ($LogText -notmatch 'Another ReShade instance was already loaded') {
        throw "The $Order second runtime rejection did not prove ReShade's duplicate-instance guard."
    }
    if ($LogText -notmatch 'another one with the same name') {
        throw "The $Order duplicate add-on rejection did not prove the exported-NAME collision."
    }
    foreach ($File in @('d3d11.dll', 'second-runtime.dll')) {
        if ((Get-FileHash -LiteralPath (Join-Path $Stage $File) -Algorithm SHA256).Hash -ne $RuntimeHash) {
            throw "The controlled copy of $File changed."
        }
    }
    $Results += $Record
}
if ((Get-FileHash -LiteralPath $Runtime -Algorithm SHA256).Hash -ne $RuntimeHash) {
    throw 'The supplied runtime changed during the probe.'
}
$Evidence = [ordered]@{
    schemaVersion = 1
    scope = 'Controlled D3D11 public add-on callback/lifecycle research; no EGO scene or input acceptance.'
    runtimeSourcePath = $Runtime
    runtimeSha256 = $RuntimeHash
    runtimeFileVersion = (Get-Item -LiteralPath $Runtime).VersionInfo.FileVersion
    publicHeaderSourceDirectory = $Headers
    publicHeaderHashes = $HeaderHashes
    results = $Results
}
$EvidencePath = Join-Path $RunDirectory 'evidence.json'
$Evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
Write-Host "Public add-on isolation probe passed in both startup orders. Evidence: $EvidencePath"
