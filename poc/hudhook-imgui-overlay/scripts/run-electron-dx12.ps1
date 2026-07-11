[CmdletBinding(DefaultParameterSetName = "Diagnostic")]
param(
    [switch]$Wait,

    [Parameter(ParameterSetName = "Client")]
    [switch]$Client,

    [Parameter(ParameterSetName = "ClientWindow")]
    [switch]$ClientWindow,

    [Parameter(ParameterSetName = "ClientInput")]
    [switch]$ClientInput,

    [Parameter(ParameterSetName = "ClientInputManual")]
    [switch]$ClientInputManual,

    [Parameter(ParameterSetName = "ClientMultiWindow")]
    [switch]$ClientMultiWindow,

    [Parameter(ParameterSetName = "ClientMultiWindowManual")]
    [switch]$ClientMultiWindowManual,

    [Parameter()]
    [ValidateSet(1, 1.25, 1.5, 2)]
    [double]$DeviceScaleFactor = 1
)

$ErrorActionPreference = "Stop"
$Runner = (Resolve-Path (Join-Path $PSScriptRoot "run-electron-dx11.ps1")).Path
$ForwardParameters = @{}
foreach ($Entry in $PSBoundParameters.GetEnumerator()) {
    $ForwardParameters[$Entry.Key] = $Entry.Value
}

& $Runner -Backend d3d12 @ForwardParameters
$ExitCode = $LASTEXITCODE
exit $ExitCode
