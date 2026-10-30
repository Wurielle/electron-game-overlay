[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OfficialRuntimePath,
    [switch]$SkipBuild
)

# Positive controlled production-path gate for an official full-add-on ReShade
# installation. Before launch, the packaged ownership manager installs the
# production API-18 add-on and marker against the exact copied stock runtime;
# attachment then uses static exact-PID rendezvous and the injector's
# non-mutating official-addon result.
& (Join-Path `
    $PSScriptRoot `
    "..\run-client-sdk-process-start-injection-gate.ps1") `
    -Backend d3d11 `
    -OfficialRuntimePath $OfficialRuntimePath `
    -SkipBuild:$SkipBuild
