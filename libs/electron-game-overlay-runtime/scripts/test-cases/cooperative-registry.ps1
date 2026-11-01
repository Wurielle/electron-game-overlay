[CmdletBinding()]
param(
    [ValidateSet('x64', 'x86', 'all')]
    [string]$Architecture = 'all'
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-cooperative-registry-gate.ps1') -Architecture $Architecture
