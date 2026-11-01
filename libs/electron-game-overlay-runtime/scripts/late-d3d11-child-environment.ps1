function Set-LateD3D11OwnedStageChildEnvironment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][Diagnostics.ProcessStartInfo]$StartInfo,
        [Parameter(Mandatory = $true)][string]$StageDirectory,
        [Parameter(Mandatory = $true)][string]$FixtureRoot
    )
    $Root = [IO.Path]::GetFullPath($FixtureRoot).TrimEnd('\','/')
    $Stage = [IO.Path]::GetFullPath($StageDirectory).TrimEnd('\','/')
    if (-not $Stage.StartsWith($Root + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'The late-runtime child stage must be inside its owned fixture root.'
    }
    $Current = $Stage
    while ($true) {
        $Item = Get-Item -LiteralPath $Current -Force
        if (-not $Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'The late-runtime child stage cannot traverse a reparse point.'
        }
        if ([string]::Equals($Current,$Root,[StringComparison]::OrdinalIgnoreCase)) { break }
        $Current = [IO.Path]::GetDirectoryName($Current)
    }
    $Configuration = Get-Item -LiteralPath (Join-Path $Stage 'ReShade.ini') -Force
    if ($Configuration.PSIsContainer -or ($Configuration.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The owned child stage must contain a regular ReShade.ini.'
    }
    $Removed = [Collections.Generic.List[string]]::new()
    foreach ($Name in @($StartInfo.Environment.Keys)) {
        if ($Name.Equals('RESHADE_BASE_PATH_OVERRIDE',[StringComparison]::OrdinalIgnoreCase) -or
            $Name.StartsWith('RESHADE_DISABLE_',[StringComparison]::OrdinalIgnoreCase) -or
            $Name.StartsWith('ELECTRON_GAME_OVERLAY',[StringComparison]::OrdinalIgnoreCase) -or
            $Name.StartsWith('EGO_',[StringComparison]::OrdinalIgnoreCase)) {
            $StartInfo.Environment.Remove($Name) | Out-Null
            $Removed.Add($Name)
        }
    }
    # A non-proxy ReShade DLL otherwise resolves its base to the target's
    # executable directory. This override belongs only to this owned child.
    $StartInfo.Environment['RESHADE_BASE_PATH_OVERRIDE'] = $Stage
    return [pscustomobject]@{ stageDirectory=$Stage; removedNames=@($Removed.ToArray()) }
}
