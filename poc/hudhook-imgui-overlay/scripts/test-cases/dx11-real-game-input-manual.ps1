[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
$Npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source

Push-Location $RepoRoot
try {
    & $Npm run build:all
    if ($LASTEXITCODE -ne 0) {
        throw "Building the SDK/client and staging the D3D11 payload failed with exit code $LASTEXITCODE."
    }

    Write-Host ""
    Write-Host "Real-game D3D11 input test client is starting."
    Write-Host "Launch the game, attach through the client, then press Ctrl+I to toggle interception."
    Write-Host "Click/type in the fixed DOM proof field and the native ImGui probe, then verify the game menu stays unchanged underneath."
    Write-Host "The PID-specific payload log records User32 and buffered-raw-input masking counters for diagnosis."
    Write-Host "Close the Electron client when the manual test is finished."
    Write-Host ""

    & $Npm run dev:d3d11
    $ExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $ExitCode
