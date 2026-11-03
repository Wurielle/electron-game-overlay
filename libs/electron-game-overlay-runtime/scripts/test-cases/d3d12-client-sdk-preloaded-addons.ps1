[CmdletBinding()]
param([switch]$SkipBuild, [string]$SdkDistA, [string]$SdkDistB, [string]$SentinelPath, [string]$RejectedAddonPath)

# The test-only pre-device barrier keeps this separate from generic late-D3D12
# adoption. Only the copied repository DirectX demo is started.
& (Join-Path $PSScriptRoot '..\run-client-sdk-preloaded-addons-gate.ps1') -Backend d3d12 -SkipBuild:$SkipBuild -SdkDistA $SdkDistA -SdkDistB $SdkDistB -SentinelPath $SentinelPath -RejectedAddonPath $RejectedAddonPath
