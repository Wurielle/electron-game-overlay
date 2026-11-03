#requires -Version 7.2
# First ReShade injection after a successful Present sample beyond eight calls.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\run-client-sdk-shared-addon-directory-gate.ps1') -Backend d3d11 -Architecture x64 -AttachmentTiming late @args
exit $LASTEXITCODE
