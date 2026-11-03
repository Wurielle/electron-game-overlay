#requires -Version 7.2
# Production SDK injection into a copied repository D3D12 demo only.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-client-sdk-shared-addon-directory-gate.ps1') -Backend d3d12 -Architecture x64 @args
exit $LASTEXITCODE
