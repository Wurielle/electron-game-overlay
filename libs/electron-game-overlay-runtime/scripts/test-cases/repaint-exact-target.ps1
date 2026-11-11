[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][uint32]$TargetPid,
    [Parameter(Mandatory=$true)][uint64]$CreationTime100ns,
    [Parameter(Mandatory=$true)][string]$Hwnd,
    [Parameter(Mandatory=$true)][uint32]$WindowThreadId
)
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../../..")).Path
$Fixture = Join-Path $RepoRoot "build/overlay-compatibility/rendering-failure-probes/x64/build/Release/repaint_exact_target.exe"
if (-not (Test-Path -LiteralPath $Fixture -PathType Leaf)) { throw "Build the owned repaint helper before use." }
& $Fixture $TargetPid $CreationTime100ns $Hwnd $WindowThreadId
if ($LASTEXITCODE -ne 0) { throw "Exact-target repaint refused or failed: $LASTEXITCODE" }
