#requires -Version 7.2
# Production SDK injection into a copied repository x86 D3D9 demo only.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-client-sdk-shared-addon-directory-gate.ps1') -Backend d3d9 -Architecture x86 @args
exit $LASTEXITCODE
