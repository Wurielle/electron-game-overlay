param([Parameter(Mandatory=$true)][string]$GameExecutable, [string]$ElectronExecutable, [switch]$PhysicalKeyboard, [switch]$PhysicalFirstKeys)
$ErrorActionPreference = 'Stop'
$PriorAppId = $env:SteamAppId
$PriorGameId = $env:SteamGameId
try {
    $env:SteamAppId = '3173130'
    $env:SteamGameId = '3173130'
    & (Join-Path $PSScriptRoot '..\run-explicit-focus-gate.ps1') -GameExecutable $GameExecutable -ElectronExecutable $ElectronExecutable -PhysicalKeyboard:$PhysicalKeyboard -PhysicalFirstKeys:$PhysicalFirstKeys
} finally {
    $env:SteamAppId = $PriorAppId
    $env:SteamGameId = $PriorGameId
}
