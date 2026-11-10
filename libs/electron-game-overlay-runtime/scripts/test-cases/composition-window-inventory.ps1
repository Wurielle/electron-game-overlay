param(
    [Parameter(Mandatory=$true)][uint32]$TargetPid,
    [Parameter(Mandatory=$true)][string]$CreationTime100ns,
    [Parameter(Mandatory=$true)][string]$NewLogPath,
    [ValidateRange(1,120000)][uint32]$DurationMs=60000
)
$ErrorActionPreference="Stop"
$RepositoryRoot=(Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
$Executable=Join-Path $RepositoryRoot "build\overlay-compatibility\owned-policy-x64\Release\composition_window_inventory.exe"
if(-not(Test-Path -LiteralPath $Executable -PathType Leaf)){throw "Build the composition_window_inventory test target first."}
& $Executable $TargetPid $CreationTime100ns $DurationMs $NewLogPath
if($LASTEXITCODE -ne 0){throw "Read-only composition window inventory failed."}
