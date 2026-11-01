#requires -Version 7.2
[CmdletBinding()]
param([switch]$Probe)
$ErrorActionPreference = 'Stop'
if ($Probe) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EgoLateEnvironmentProbe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern uint GetEnvironmentVariable(string name,IntPtr buffer,uint size);
}
'@
    [ordered]@{
        basePath=[Environment]::GetEnvironmentVariable('RESHADE_BASE_PATH_OVERRIDE','Process')
        graphicsDisableSize=[EgoLateEnvironmentProbe]::GetEnvironmentVariable('RESHADE_DISABLE_GRAPHICS_HOOK',[IntPtr]::Zero,0)
        inputDisableSize=[EgoLateEnvironmentProbe]::GetEnvironmentVariable('RESHADE_DISABLE_INPUT_HOOK',[IntPtr]::Zero,0)
        loggingDisableSize=[EgoLateEnvironmentProbe]::GetEnvironmentVariable('RESHADE_DISABLE_LOGGING',[IntPtr]::Zero,0)
        staleRoute=[Environment]::GetEnvironmentVariable('ELECTRON_GAME_OVERLAY_RUN_DIRECTORY','Process')
    } | ConvertTo-Json -Compress
    exit
}
$RepoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
. (Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\scripts\late-d3d11-child-environment.ps1')
$FixtureRoot=Join-Path $RepoRoot 'build\late-d3d11-adoption'
$Stage=Join-Path $FixtureRoot ('environment-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Stage | Out-Null
'[GENERAL]' | Set-Content -LiteralPath (Join-Path $Stage 'ReShade.ini') -Encoding ascii
$ParentBase=[Environment]::GetEnvironmentVariable('RESHADE_BASE_PATH_OVERRIDE','Process')
$Info=[Diagnostics.ProcessStartInfo]::new()
$Info.FileName=[Environment]::ProcessPath
$Info.UseShellExecute=$false; $Info.CreateNoWindow=$true; $Info.RedirectStandardOutput=$true; $Info.RedirectStandardError=$true
foreach ($Argument in @('-NoLogo','-NoProfile','-File',$PSCommandPath,'-Probe')) { $Info.ArgumentList.Add($Argument) }
$Info.Environment['RESHADE_BASE_PATH_OVERRIDE']='wrong-inherited-stage'
foreach ($Name in @('RESHADE_DISABLE_GRAPHICS_HOOK','RESHADE_DISABLE_INPUT_HOOK','RESHADE_DISABLE_LOGGING','ELECTRON_GAME_OVERLAY_RUN_DIRECTORY')) { $Info.Environment[$Name]='stale-inherited-value' }
$Result=Set-LateD3D11OwnedStageChildEnvironment -StartInfo $Info -StageDirectory $Stage -FixtureRoot $FixtureRoot
$Child=[Diagnostics.Process]::new(); $Child.StartInfo=$Info
try {
    if (-not $Child.Start()) { throw 'Environment probe child did not start.' }
    $Out=$Child.StandardOutput.ReadToEndAsync(); $Err=$Child.StandardError.ReadToEndAsync()
    if (-not $Child.WaitForExit(10000)) { $Child.Kill(); $Child.WaitForExit(); throw 'Environment probe child timed out.' }
    $Observed=$Out.GetAwaiter().GetResult() | ConvertFrom-Json
    if ($Child.ExitCode -ne 0) { throw $Err.GetAwaiter().GetResult() }
    if ($Observed.basePath -ine $Stage -or $Result.stageDirectory -ine $Stage -or
        $Observed.graphicsDisableSize -ne 0 -or $Observed.inputDisableSize -ne 0 -or
        $Observed.loggingDisableSize -ne 0 -or $null -ne $Observed.staleRoute) { throw 'The native child environment contract failed.' }
    if ([Environment]::GetEnvironmentVariable('RESHADE_BASE_PATH_OVERRIDE','Process') -cne $ParentBase) { throw 'The helper changed its parent environment.' }
    $Rejected=$false
    try { Set-LateD3D11OwnedStageChildEnvironment -StartInfo $Info -StageDirectory $RepoRoot -FixtureRoot $FixtureRoot | Out-Null } catch { $Rejected=$true }
    if (-not $Rejected) { throw 'An outside-root stage was accepted.' }
    [ordered]@{ sameChildOwnedBasePath=$true; nativeDisableFlagsAbsent=$true; stalePrivateRouteRemoved=$true; parentEnvironmentUnchanged=$true; outsideRootRejected=$true } | ConvertTo-Json
} finally { $Child.Dispose() }
