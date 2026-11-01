[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PairReport,
    [string]$GameExecutable = 'C:/Program Files (x86)/Steam/steamapps/common/Gun Frog/Gun Frog.exe',
    [string]$ElectronExecutable,
    [ValidateSet('a-first', 'b-first', 'both')][string]$StartupOrder = 'both',
    [ValidateSet('graceful', 'crash', 'both')][string]$FirstAppExit = 'both'
)

$Arguments = @{ PairReport = $PairReport; GameExecutable = $GameExecutable; StartupOrder = $StartupOrder; FirstAppExit = $FirstAppExit }
if ($ElectronExecutable) { $Arguments.ElectronExecutable = $ElectronExecutable }
& (Join-Path $PSScriptRoot '..\run-client-sdk-installed-package-game-gate.ps1') @Arguments
