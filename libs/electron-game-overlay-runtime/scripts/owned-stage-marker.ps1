function Write-OwnedOverlayRunMarker {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RunDirectory,
        [Parameter(Mandatory = $true)]
        [string]$BuildRoot
    )

    $ResolvedRoot = [IO.Path]::GetFullPath($BuildRoot).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar)
    $ResolvedRun = [IO.Path]::GetFullPath($RunDirectory).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar)
    if (-not $ResolvedRun.StartsWith(
            $ResolvedRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to mark a native run outside its owned build root: $ResolvedRun"
    }

    $Directory = Get-Item -LiteralPath $ResolvedRun -Force -ErrorAction Stop
    if (-not $Directory.PSIsContainer) {
        throw "The native run is not a directory: $ResolvedRun"
    }
    for ($Ancestor = $Directory; $null -ne $Ancestor; $Ancestor = $Ancestor.Parent) {
        if (($Ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to mark a native run through a reparse point: $($Ancestor.FullName)"
        }
        if ([string]::Equals($Ancestor.FullName, $ResolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
            break
        }
    }

    $Marker = [ordered]@{
        schemaVersion = 1
        kind = 'electron-game-overlay-reshade-run'
        runId = [Guid]::NewGuid().ToString('D')
        directoryName = $Directory.Name
        createdAt = [DateTime]::UtcNow.ToString(
            "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    }
    $Bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Marker | ConvertTo-Json -Compress))
    if ($Bytes.Length -eq 0 -or $Bytes.Length -gt 4096) {
        throw 'The native run ownership marker exceeds its bounded schema.'
    }
    $MarkerPath = Join-Path $ResolvedRun '.electron-game-overlay-run.json'
    $File = [IO.File]::Open($MarkerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $File.Write($Bytes, 0, $Bytes.Length)
        $File.Flush()
    }
    finally {
        $File.Dispose()
    }
}
