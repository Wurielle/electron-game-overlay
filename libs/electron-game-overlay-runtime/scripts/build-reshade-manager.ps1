[CmdletBinding()]
param(
    [ValidateSet('x64', 'x86')]
    [string]$Architecture = 'x64',
    [Parameter(Mandatory)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The native ReShade manager requires Windows and Visual Studio C++ Build Tools.'
}
$sourcePath = Join-Path $PSScriptRoot '..\src\electron_game_overlay_reshade_manager.cpp'
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
$managerPath = Join-Path $outputPath 'electron_game_overlay_reshade_manager.exe'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw "Visual Studio locator is required: $vswhere"
}
$vsInstall = (& $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($vsInstall)) {
    throw 'Visual Studio x64/x86 C++ Build Tools are required.'
}
$devShellModule = Join-Path $vsInstall 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
Import-Module $devShellModule
Enter-VsDevShell -VsInstallPath $vsInstall -SkipAutomaticLocation `
    -DevCmdArguments "-arch=$Architecture -host_arch=x64"
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
Push-Location $outputPath
try {
    # Match the production CMake target's dynamic MSVC runtime; no test faults.
    & cl.exe /nologo /std:c++20 /W4 /WX /permissive- /EHsc /MD `
        /DUNICODE /D_UNICODE $sourcePath `
        "/Fo:$(Join-Path $outputPath 'electron_game_overlay_reshade_manager.obj')" `
        "/Fe:$managerPath" /link /INCREMENTAL:NO
    if ($LASTEXITCODE -ne 0) { throw 'Native manager compilation failed.' }
    if (-not (Test-Path -LiteralPath $managerPath -PathType Leaf)) {
        throw 'Native manager compiler did not produce the requested executable.'
    }
} finally {
    Pop-Location
}
Write-Output $managerPath
