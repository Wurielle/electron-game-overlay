function Get-CapabilityProtectedManifest {
    param([Parameter(Mandatory = $true)][string]$Root)

    if (-not [IO.Path]::IsPathRooted($Root)) {
        throw 'The capability preservation root must be absolute.'
    }
    $RootItem = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
    if (-not $RootItem.PSIsContainer -or
        ($RootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The capability preservation root must be a real directory.'
    }
    $RootPath = [IO.Path]::GetFullPath($RootItem.FullName).TrimEnd('\', '/') +
        [IO.Path]::DirectorySeparatorChar
    $Pending = [Collections.Generic.Stack[string]]::new()
    $Pending.Push($RootItem.FullName)
    $Entries = [Collections.Generic.List[object]]::new()
    while ($Pending.Count -ne 0) {
        $Directory = $Pending.Pop()
        foreach ($Item in @(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop)) {
            $FullPath = [IO.Path]::GetFullPath($Item.FullName)
            if (-not $FullPath.StartsWith($RootPath, [StringComparison]::OrdinalIgnoreCase) -or
                ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "A capability preservation entry escaped its real root: $FullPath"
            }
            $RelativePath = $FullPath.Substring($RootPath.Length).Replace('\', '/')
            if ($Item.PSIsContainer) {
                if (-not [string]::Equals($RelativePath, 'cache', [StringComparison]::OrdinalIgnoreCase)) {
                    $Pending.Push($FullPath)
                }
                continue
            }
            if (@('ReShade.log', 'addons/electron_game_overlay.addon64',
                    'addons/.electron-game-overlay-addon.json') -icontains $RelativePath) {
                continue
            }
            $Stream = $null
            $Hasher = $null
            try {
                $Stream = [IO.File]::OpenRead($FullPath)
                $Hasher = [Security.Cryptography.SHA256]::Create()
                $Hash = [BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant()
            }
            finally {
                if ($null -ne $Hasher) { $Hasher.Dispose() }
                if ($null -ne $Stream) { $Stream.Dispose() }
            }
            $Entries.Add([pscustomobject][ordered]@{
                RelativePath = $RelativePath
                Sha256 = $Hash
                Length = [int64]$Item.Length
                Attributes = [int]$Item.Attributes
                LastWriteUtcTicks = $Item.LastWriteTimeUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
            })
        }
    }
    return @($Entries | Sort-Object RelativePath)
}

function Assert-CapabilityProtectedManifest {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Expected,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Actual
    )

    $Canonical = @()
    foreach ($Manifest in @(@{ Entries = $Expected }, @{ Entries = $Actual })) {
        $Paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $Entries = @(
            foreach ($Entry in $Manifest.Entries) {
                $Names = @($Entry.PSObject.Properties.Name | Sort-Object)
                if (($Names -join '|') -cne 'Attributes|LastWriteUtcTicks|Length|RelativePath|Sha256' -or
                    $Entry.RelativePath -isnot [string] -or
                    $Entry.RelativePath -eq '' -or
                    -not $Paths.Add($Entry.RelativePath) -or
                    $Entry.Sha256 -isnot [string] -or
                    $Entry.Sha256 -cnotmatch '^[a-f0-9]{64}$' -or
                    $Entry.LastWriteUtcTicks -isnot [string] -or
                    $Entry.LastWriteUtcTicks -cnotmatch '^[0-9]+$') {
                    throw 'The capability protected-file manifest is malformed or ambiguous.'
                }
                [pscustomobject][ordered]@{
                    RelativePath = $Entry.RelativePath
                    Sha256 = $Entry.Sha256
                    Length = $Entry.Length
                    Attributes = $Entry.Attributes
                    LastWriteUtcTicks = $Entry.LastWriteUtcTicks
                }
            }
        )
        $Canonical += ConvertTo-Json -InputObject @($Entries | Sort-Object RelativePath) -Depth 4 -Compress
    }
    if ($Canonical[0] -cne $Canonical[1]) {
        throw 'The capability gate changed a protected installation file or its metadata.'
    }
}

function Invoke-CapabilityAddonTransaction {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('prepare', 'remove')][string]$Operation,
        [Parameter(Mandatory = $true)][string]$Manager,
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Runtime,
        [Parameter(Mandatory = $true)][string]$RuntimeHash,
        [string]$Source,
        [string]$SourceHash
    )

    if (-not [IO.Path]::IsPathRooted($Directory) -or
        -not [IO.Path]::IsPathRooted($Runtime) -or
        $RuntimeHash -cnotmatch '^[a-fA-F0-9]{64}$' -or
        ($Operation -eq 'prepare' -and
            (-not [IO.Path]::IsPathRooted($Source) -or $SourceHash -cnotmatch '^[a-fA-F0-9]{64}$'))) {
        throw 'The reserved add-on transaction requires exact absolute paths and SHA-256 identities.'
    }
    $DirectoryPath = [IO.Path]::GetFullPath($Directory)
    $RuntimePath = [IO.Path]::GetFullPath($Runtime)
    # The native manager's frozen CLI accepts uppercase hexadecimal identities.
    # Evidence remains case-insensitive; normalize only its command arguments.
    $Arguments = @($Operation, '--directory', $DirectoryPath,
        '--reshade-module', $RuntimePath, '--reshade-module-sha256', $RuntimeHash.ToUpperInvariant())
    if ($Operation -eq 'prepare') {
        $Arguments += @('--source', [IO.Path]::GetFullPath($Source), '--source-sha256', $SourceHash.ToUpperInvariant())
    }
    $Output = @(& $Manager @Arguments)
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 0 -or $Output.Count -ne 1 -or $Output[0] -isnot [string]) {
        $PublicFailure = ''
        if ($Output.Count -eq 1 -and $Output[0] -is [string]) {
            try {
                $ErrorResult = $Output[0] | ConvertFrom-Json -ErrorAction Stop
                if ($ErrorResult.schemaVersion -eq 1 -and
                    $ErrorResult.kind -ceq 'electron-game-overlay-reshade-addon-manager-result' -and
                    $ErrorResult.status -ceq 'error' -and $ErrorResult.code -is [string] -and
                    $ErrorResult.code -cmatch '^[a-z0-9-]+$' -and $ErrorResult.message -is [string]) {
                    $Message = $ErrorResult.message.Replace("`r", ' ').Replace("`n", ' ')
                    if ($Message.Length -gt 1024) { $Message = $Message.Substring(0, 1024) }
                    $PublicFailure = "; code=$($ErrorResult.code); message=$Message"
                }
            }
            catch { $PublicFailure = '' }
        }
        throw "The reserved add-on manager failed '$Operation' or returned ambiguous output (exit $ExitCode$PublicFailure)."
    }
    try { $Result = $Output[0] | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'The reserved add-on manager returned invalid JSON.' }
    $Names = @($Result.PSObject.Properties.Name | Sort-Object)
    $ExpectedNames = @('addonPath', 'addonSha256', 'expectedAddonSha256', 'kind',
        'markerPath', 'operation', 'previousAddonSha256', 'recoveredTransaction',
        'reshadeModulePath', 'reshadeModuleSha256', 'restartRequired', 'schemaVersion', 'status')
    if (($Names -join '|') -cne (($ExpectedNames | Sort-Object) -join '|') -or
        ($Result.schemaVersion -isnot [int] -and $Result.schemaVersion -isnot [long]) -or
        $Result.schemaVersion -ne 1 -or
        $Result.kind -cne 'electron-game-overlay-reshade-addon-manager-result' -or
        $Result.operation -cne $Operation -or
        $Result.recoveredTransaction -isnot [bool] -or $Result.restartRequired -isnot [bool]) {
        throw 'The reserved add-on manager returned an unexpected result schema or operation.'
    }
    foreach ($Pair in @(
            @{ Observed = $Result.reshadeModulePath; Expected = $RuntimePath },
            @{ Observed = $Result.addonPath; Expected = (Join-Path $DirectoryPath 'electron_game_overlay.addon64') },
            @{ Observed = $Result.markerPath; Expected = (Join-Path $DirectoryPath '.electron-game-overlay-addon.json') })) {
        if ($Pair.Observed -isnot [string] -or -not [IO.Path]::IsPathRooted($Pair.Observed) -or
            -not [string]::Equals([IO.Path]::GetFullPath($Pair.Observed), $Pair.Expected,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The reserved add-on manager returned a different runtime or managed destination.'
        }
    }
    if ($Result.reshadeModuleSha256 -isnot [string] -or
        -not [string]::Equals($Result.reshadeModuleSha256, $RuntimeHash, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The reserved add-on manager returned a different runtime hash.'
    }
    if ($null -ne $Result.previousAddonSha256 -and
        ($Result.previousAddonSha256 -isnot [string] -or $Result.previousAddonSha256 -cnotmatch '^[a-fA-F0-9]{64}$')) {
        throw 'The reserved add-on manager returned an invalid previous add-on hash.'
    }
    if ($Operation -eq 'prepare') {
        if (@('installed', 'already-current') -cnotcontains $Result.status -or
            $Result.addonSha256 -isnot [string] -or $Result.expectedAddonSha256 -isnot [string] -or
            -not [string]::Equals($Result.addonSha256, $SourceHash, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($Result.expectedAddonSha256, $SourceHash, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The reserved add-on manager did not prepare the exact public adapter.'
        }
    }
    elseif (@('removed', 'not-installed') -cnotcontains $Result.status -or
        $null -ne $Result.addonSha256 -or $null -ne $Result.expectedAddonSha256) {
        throw 'The reserved add-on manager did not remove the reserved public adapter.'
    }
    return $Result
}
