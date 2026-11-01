function Read-OwnedOverlayMarkerBytes {
    param([string]$Path, [int]$MaximumLength)
    $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($Item.PSIsContainer -or
        ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "The owned stage marker is not a regular file: $Path"
    }
    $File = [IO.FileStream]::new($Path, [IO.FileMode]::Open,
        [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($File.Length -eq 0 -or $File.Length -gt $MaximumLength) {
            throw "The owned stage marker has an invalid size: $Path"
        }
        $Bytes = [byte[]]::new([int]$File.Length)
        $Offset = 0
        while ($Offset -lt $Bytes.Length) {
            $Read = $File.Read($Bytes, $Offset, $Bytes.Length - $Offset)
            if ($Read -eq 0) { throw "The owned stage marker could not be read completely: $Path" }
            $Offset += $Read
        }
        return ,$Bytes
    }
    finally { $File.Dispose() }
}

function Assert-OwnedOverlayRuntimeMarker {
    param([string]$Path, [byte[]]$Expected)
    $Actual = Read-OwnedOverlayMarkerBytes -Path $Path -MaximumLength $Expected.Length
    if ($Actual.Length -ne $Expected.Length) {
        throw "The owned runtime stage marker has unexpected contents: $Path"
    }
    for ($Index = 0; $Index -lt $Expected.Length; $Index++) {
        if ($Actual[$Index] -ne $Expected[$Index]) {
            throw "The owned runtime stage marker has unexpected contents: $Path"
        }
    }
}

function Assert-OwnedOverlayRunMarker {
    param([string]$Path, [string]$DirectoryName)
    $Bytes = Read-OwnedOverlayMarkerBytes -Path $Path -MaximumLength 4096
    $Text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
    # Match the native ownership reader's bounded, unescaped schema.
    if ($Text.Contains('\')) { throw "The owned run marker contains unsupported escapes: $Path" }
    $Document = [Text.Json.JsonDocument]::Parse($Text)
    try {
        if ($Document.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Object) {
            throw "The owned run marker is not an object: $Path"
        }
        $Fields = [Collections.Generic.Dictionary[string, Text.Json.JsonElement]]::new([StringComparer]::Ordinal)
        $Allowed = @('schemaVersion', 'kind', 'runId', 'directoryName', 'createdAt')
        foreach ($Property in $Document.RootElement.EnumerateObject()) {
            if ($Property.Name -cnotin $Allowed -or $Fields.ContainsKey($Property.Name)) {
                throw "The owned run marker has unexpected or repeated fields: $Path"
            }
            $Fields.Add($Property.Name, $Property.Value)
        }
        $Schema = 0
        $CreatedAt = [DateTime]::MinValue
        if ($Fields.Count -ne 5 -or
            -not $Fields['schemaVersion'].TryGetInt32([ref]$Schema) -or $Schema -ne 1 -or
            $Fields['kind'].GetString() -cne 'electron-game-overlay-reshade-run' -or
            $Fields['directoryName'].GetString() -cne $DirectoryName -or
            $Fields['runId'].GetString() -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
            -not [DateTime]::TryParseExact($Fields['createdAt'].GetString(),
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$CreatedAt)) {
            throw "The owned run marker has unexpected ownership: $Path"
        }
    }
    finally { $Document.Dispose() }
}

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
    $HelperDirectory = Split-Path -Parent $MyInvocation.MyCommand.ScriptBlock.File
    $RepositoryBuildRoot = [IO.Path]::GetFullPath((Join-Path $HelperDirectory '..\..\..\build')).TrimEnd(
        [IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if (-not [string]::Equals($ResolvedRoot, $RepositoryBuildRoot, [StringComparison]::OrdinalIgnoreCase) -and
        -not $ResolvedRoot.StartsWith($RepositoryBuildRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to mark a native run outside the repository build area: $ResolvedRoot"
    }
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
        if ([string]::Equals($Ancestor.FullName, $RepositoryBuildRoot, [StringComparison]::OrdinalIgnoreCase)) {
            break
        }
    }

    $MarkerPath = Join-Path $ResolvedRun '.electron-game-overlay-run.json'
    $RuntimeMarkerPath = Join-Path $ResolvedRun 'electron-game-overlay-owned-runtime-v1.marker'
    $RuntimeBytes = [Text.Encoding]::ASCII.GetBytes("ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1`n")
    # Validate every existing marker before creating either missing file.
    if (Test-Path -LiteralPath $RuntimeMarkerPath) {
        Assert-OwnedOverlayRuntimeMarker -Path $RuntimeMarkerPath -Expected $RuntimeBytes
    }
    if (Test-Path -LiteralPath $MarkerPath) {
        Assert-OwnedOverlayRunMarker -Path $MarkerPath -DirectoryName $Directory.Name
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
    if (-not (Test-Path -LiteralPath $MarkerPath)) {
        try {
            $File = [IO.File]::Open($MarkerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            try { $File.Write($Bytes, 0, $Bytes.Length); $File.Flush() }
            finally { $File.Dispose() }
        }
        catch [IO.IOException] {
            if (-not (Test-Path -LiteralPath $MarkerPath)) { throw }
            Assert-OwnedOverlayRunMarker -Path $MarkerPath -DirectoryName $Directory.Name
        }
    }
    if (-not (Test-Path -LiteralPath $RuntimeMarkerPath)) {
        try {
            $File = [IO.File]::Open($RuntimeMarkerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            try { $File.Write($RuntimeBytes, 0, $RuntimeBytes.Length); $File.Flush() }
            finally { $File.Dispose() }
        }
        catch [IO.IOException] {
            if (-not (Test-Path -LiteralPath $RuntimeMarkerPath)) { throw }
            Assert-OwnedOverlayRuntimeMarker -Path $RuntimeMarkerPath -Expected $RuntimeBytes
        }
    }
}
