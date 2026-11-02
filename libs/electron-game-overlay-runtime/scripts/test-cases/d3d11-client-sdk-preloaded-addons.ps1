[CmdletBinding()]
param([switch]$SkipBuild, [string]$SdkDistA, [string]$SdkDistB)

# Only a copied repository DirectX demo is started. Includes all-apps-offline
# self-load scanning and separate real public-SDK injection before devices.
& (Join-Path $PSScriptRoot '..\run-client-sdk-preloaded-addons-gate.ps1') -Backend d3d11 -SkipBuild:$SkipBuild -SdkDistA $SdkDistA -SdkDistB $SdkDistB
