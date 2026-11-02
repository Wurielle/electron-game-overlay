[CmdletBinding()]
param([switch]$SkipBuild, [string]$SdkDist, [string]$UnregisteredSdkDist, [string]$UnregisteredConsumerRoot)

# Current registered dormant baseline with the retained unregistered gen16 SDK;
# only a copied repository D3D12 demo starts, with ReShade loaded before devices.
& (Join-Path $PSScriptRoot '..\run-client-sdk-unregistered-addon-compatibility-gate.ps1') -Backend d3d12 -SkipBuild:$SkipBuild -SdkDist $SdkDist -UnregisteredSdkDist $UnregisteredSdkDist -UnregisteredConsumerRoot $UnregisteredConsumerRoot
