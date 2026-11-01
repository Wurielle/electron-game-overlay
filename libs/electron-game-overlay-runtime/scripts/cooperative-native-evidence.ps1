function Assert-CooperativeRuntimeHash {
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object]$Observed,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Expected
    )

    if ($Observed -isnot [string] -or $Observed -cnotmatch '^[a-fA-F0-9]{64}$' -or $Expected.Count -lt 1 -or $Expected.Count -gt 2) {
        throw 'Runtime identity requires one observed and one or two expected SHA-256 digests.'
    }
    foreach ($Hash in $Expected) {
        if ($Hash -isnot [string] -or $Hash -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'An expected ReShade runtime SHA-256 digest is malformed.' }
    }
    foreach ($Hash in $Expected) {
        if ([string]::Equals($Observed, $Hash, [StringComparison]::OrdinalIgnoreCase)) { return }
    }
    throw 'The controlled host loaded a ReShade runtime whose SHA-256 differs from the expected candidate package.'
}
