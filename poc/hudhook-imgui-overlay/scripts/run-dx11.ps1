[CmdletBinding()]
param(
    [switch]$Wait
)

$ErrorActionPreference = "Stop"
$env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$RunDirectory = Join-Path $RepoRoot "build\hudhook-imgui-overlay\run\dx11"
$HostExecutable = Join-Path $RunDirectory "d3d11_overlay_test_host.exe"
$Injector = Join-Path $RunDirectory "hudhook_overlay_injector.exe"
$Payload = Join-Path $RunDirectory "hudhook_imgui_overlay_dx11.dll"
$WindowTitle = "Controlled D3D11 overlay test host"

foreach ($Artifact in @($HostExecutable, $Injector, $Payload)) {
    if (-not (Test-Path $Artifact -PathType Leaf)) {
        throw "POC artifact not found: $Artifact. Run build-dx11.ps1 first."
    }
}

$ForbiddenNames = @(
    "d3d9.dll",
    "d3d10.dll",
    "d3d11.dll",
    "dinput8.dll",
    "dxgi.dll",
    "opengl32.dll",
    "ReShade.ini"
)

foreach ($Name in $ForbiddenNames) {
    $ForbiddenPath = Join-Path $RunDirectory $Name
    if (Test-Path $ForbiddenPath) {
        throw "Refusing to run with a ReShade/proxy artifact present: $ForbiddenPath"
    }
}

$UnexpectedAddons = Get-ChildItem -Path $RunDirectory -Filter "*.addon*" -ErrorAction SilentlyContinue
if ($UnexpectedAddons) {
    throw "Refusing to run with a ReShade add-on present: $($UnexpectedAddons.FullName -join ', ')"
}

$ExistingHosts = Get-Process -Name "d3d11_overlay_test_host" -ErrorAction SilentlyContinue
if ($ExistingHosts) {
    throw "Close the existing controlled host before starting this test. hudhook selects the first exact process-name match."
}

$HostProcess = $null
try {
    $HostProcess = Start-Process `
        -PassThru `
        -WorkingDirectory $RunDirectory `
        -FilePath $HostExecutable

    $Deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 100
        $HostProcess.Refresh()

        if ($HostProcess.HasExited) {
            throw "The controlled host exited before injection with code $($HostProcess.ExitCode)."
        }
    } while ($HostProcess.MainWindowTitle -ne $WindowTitle -and [DateTime]::UtcNow -lt $Deadline)

    if ($HostProcess.MainWindowTitle -ne $WindowTitle) {
        throw "Timed out waiting for the controlled host window."
    }

    $LogPath = Join-Path $RunDirectory "hudhook_imgui_overlay_dx11-$($HostProcess.Id).log"
    if (Test-Path $LogPath) {
        Remove-Item -LiteralPath $LogPath -Force
    }

    & $Injector `
        --title $WindowTitle `
        --backend d3d11 `
        --dll $Payload

    if ($LASTEXITCODE -ne 0) {
        throw "The injector failed with exit code $LASTEXITCODE."
    }

    $ProofDeadline = [DateTime]::UtcNow.AddSeconds(10)
    $HasTexture = $false
    $HasFirstFrame = $false
    do {
        Start-Sleep -Milliseconds 100
        $HostProcess.Refresh()

        if ($HostProcess.HasExited) {
            throw "The controlled host exited before the payload rendered."
        }

        if (Test-Path $LogPath) {
            $LogContent = Get-Content -LiteralPath $LogPath -Raw
            $HasTexture = $LogContent.Contains("generated RGBA texture uploaded")
            $HasFirstFrame = $LogContent.Contains("first ImGui frame rendered")
        }
    } while ((-not $HasTexture -or -not $HasFirstFrame) -and [DateTime]::UtcNow -lt $ProofDeadline)

    if (-not $HasTexture -or -not $HasFirstFrame) {
        throw "Injection returned, but the current payload log did not prove texture upload and first-frame rendering: $LogPath"
    }

    Write-Host ""
    Write-Host "Verified texture upload and first-frame rendering in:"
    Write-Host "  $LogPath"
    Write-Host "Expected result: an always-visible hudhook + ImGui panel with a teal checkerboard."
    Write-Host "Resize the window to exercise ResizeBuffers. Press Escape in the host to close it."
    Write-Host "Payload log: $LogPath"

    if ($Wait) {
        $HostProcess.WaitForExit()
        exit $HostProcess.ExitCode
    }
}
catch {
    if ($HostProcess -and -not $HostProcess.HasExited) {
        $HostProcess.CloseMainWindow() | Out-Null
    }
    throw
}
