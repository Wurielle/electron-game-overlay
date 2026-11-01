[CmdletBinding()]
param(
    [string]$ElectronExecutable,
    [ValidateSet('wm-input', 'raw-buffer')][string]$InputMode = 'wm-input'
)

$ErrorActionPreference = 'Stop'
$PreviousDiagnostic = [Environment]::GetEnvironmentVariable('ELECTRON_GAME_OVERLAY_CONTROLLED_PRESENT_DIAGNOSTIC', 'Process')
try {
    $env:ELECTRON_GAME_OVERLAY_CONTROLLED_PRESENT_DIAGNOSTIC = '1'
    & (Join-Path $PSScriptRoot '..\run-native-pointer-gate.ps1') -Backend d3d11 -Architecture x64 -InputMode $InputMode -ElectronExecutable $ElectronExecutable -CalibrationOnly -GpuReadback
} finally {
    [Environment]::SetEnvironmentVariable('ELECTRON_GAME_OVERLAY_CONTROLLED_PRESENT_DIAGNOSTIC', $PreviousDiagnostic, 'Process')
}
