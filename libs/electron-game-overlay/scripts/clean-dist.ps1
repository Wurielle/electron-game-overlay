[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DistDirectory = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "dist"))
$ExpectedPrefix = $ProjectRoot.TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
) + [IO.Path]::DirectorySeparatorChar

if (-not $DistDirectory.StartsWith(
        $ExpectedPrefix,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean an SDK output outside the project: $DistDirectory"
}

if (Test-Path -LiteralPath $DistDirectory) {
    $ReparsePoint = @(
        Get-Item -LiteralPath $DistDirectory -Force
        Get-ChildItem -LiteralPath $DistDirectory -Recurse -Force
    ) | Where-Object {
        ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    } | Select-Object -First 1

    if ($ReparsePoint) {
        throw "Refusing to clean an SDK output containing a reparse point: $($ReparsePoint.FullName)"
    }

    Remove-Item -LiteralPath $DistDirectory -Recurse -Force
}

Write-Host "ELECTRON_GAME_OVERLAY_SDK_DIST_CLEANED directory=$DistDirectory"
