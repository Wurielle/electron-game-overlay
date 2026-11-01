#requires -Version 7.2
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$RepositoryBuildRoot = Join-Path $RepoRoot 'build'
$FixtureBuildRoot = Join-Path $RepositoryBuildRoot 'owned-stage-marker-tests'
$FixtureRoot = Join-Path $FixtureBuildRoot ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
. (Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\scripts\owned-stage-marker.ps1')

$RuntimeName = 'electron-game-overlay-owned-runtime-v1.marker'
$OwnershipName = '.electron-game-overlay-run.json'
$ExpectedBytes = [Text.Encoding]::ASCII.GetBytes("ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1`n")
$Results = [Collections.Generic.List[object]]::new()
$Skipped = [Collections.Generic.List[object]]::new()

function Assert-True([bool]$Value, [string]$Message) {
    if (-not $Value) { throw $Message }
}

function New-CaseDirectory([string]$Name) {
    $Path = Join-Path $FixtureRoot $Name
    New-Item -ItemType Directory -Path $Path | Out-Null
    return $Path
}

function Get-FileSnapshot([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $Item = Get-Item -LiteralPath $Path -Force
    return [ordered]@{
        directory = $Item.PSIsContainer
        attributes = [long]$Item.Attributes
        lastWriteTicks = $Item.LastWriteTimeUtc.Ticks
        hash = if ($Item.PSIsContainer) { $null } else { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
    }
}

function Assert-SnapshotUnchanged($Before, [string]$Path) {
    $After = Get-FileSnapshot $Path
    Assert-True (($Before | ConvertTo-Json -Compress) -ceq ($After | ConvertTo-Json -Compress)) "Unexpected mutation: $Path"
}

function Assert-Rejected([string]$Name, [scriptblock]$Action) {
    $Rejected = $false
    try { & $Action | Out-Null }
    catch { $Rejected = $true }
    Assert-True $Rejected "Unsafe case was accepted: $Name"
    $Results.Add([ordered]@{ name = $Name; status = 'passed' })
}

function Assert-ExactRuntimeMarker([string]$Directory) {
    $Actual = [IO.File]::ReadAllBytes((Join-Path $Directory $RuntimeName))
    Assert-True ($Actual.Length -eq $ExpectedBytes.Length) 'Runtime marker length differs from exact ASCII contract.'
    for ($Index = 0; $Index -lt $ExpectedBytes.Length; $Index++) {
        Assert-True ($Actual[$Index] -eq $ExpectedBytes[$Index]) 'Runtime marker byte differs from exact ASCII contract.'
    }
}

function Invoke-Marker([string]$Directory) {
    Write-OwnedOverlayRunMarker -RunDirectory $Directory -BuildRoot $FixtureRoot | Out-Null
}

$Status = 'failed'
$Failure = $null
try {
    $Fresh = New-CaseDirectory 'fresh'
    Invoke-Marker $Fresh
    Assert-ExactRuntimeMarker $Fresh
    $OwnershipPath = Join-Path $Fresh $OwnershipName
    $OwnershipText = Get-Content -Raw -LiteralPath $OwnershipPath
    $Ownership = $OwnershipText | ConvertFrom-Json
    Assert-True ($Ownership.schemaVersion -eq 1 -and $Ownership.kind -ceq 'electron-game-overlay-reshade-run') 'Ownership schema differs.'
    Assert-True ($Ownership.directoryName -ceq 'fresh') 'Ownership directory identity differs.'
    Assert-True ($Ownership.runId -cmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') 'Ownership run ID is not a canonical UUID v4.'
    $Document = [Text.Json.JsonDocument]::Parse($OwnershipText)
    try { $CreatedAt = $Document.RootElement.GetProperty('createdAt').GetString() }
    finally { $Document.Dispose() }
    Assert-True ($CreatedAt -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') 'Ownership timestamp differs.'
    $Results.Add([ordered]@{ name = 'fresh-exact-runtime-and-json-markers'; status = 'passed' })

    $RuntimeBefore = Get-FileSnapshot (Join-Path $Fresh $RuntimeName)
    $OwnershipBefore = Get-FileSnapshot $OwnershipPath
    Invoke-Marker $Fresh
    Assert-SnapshotUnchanged $RuntimeBefore (Join-Path $Fresh $RuntimeName)
    Assert-SnapshotUnchanged $OwnershipBefore $OwnershipPath
    $Results.Add([ordered]@{ name = 'idempotent-preserves-both-marker-bytes-and-timestamps'; status = 'passed' })

    $Preexisting = New-CaseDirectory 'preexisting-runtime-marker'
    $PreexistingPath = Join-Path $Preexisting $RuntimeName
    [IO.File]::WriteAllBytes($PreexistingPath, $ExpectedBytes)
    $Before = Get-FileSnapshot $PreexistingPath
    Invoke-Marker $Preexisting
    Assert-SnapshotUnchanged $Before $PreexistingPath
    Assert-True (Test-Path -LiteralPath (Join-Path $Preexisting $OwnershipName) -PathType Leaf) 'Existing correct runtime marker prevented ownership creation.'
    $Results.Add([ordered]@{ name = 'existing-correct-runtime-marker-accepted-without-overwrite'; status = 'passed' })

    $InvalidRuntimeValues = [ordered]@{
        mismatch = [Text.Encoding]::ASCII.GetBytes("UNOWNED`n")
        bom = [byte[]](@(239, 187, 191) + @($ExpectedBytes))
        crlf = [Text.Encoding]::ASCII.GetBytes("ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1`r`n")
        nul = [byte[]](@($ExpectedBytes) + @(0))
        oversized = [Text.Encoding]::ASCII.GetBytes(('x' * 8192))
    }
    foreach ($Entry in $InvalidRuntimeValues.GetEnumerator()) {
        $Directory = New-CaseDirectory ('invalid-runtime-' + $Entry.Key)
        $Marker = Join-Path $Directory $RuntimeName
        [IO.File]::WriteAllBytes($Marker, $Entry.Value)
        $Before = Get-FileSnapshot $Marker
        Assert-Rejected ('runtime-' + $Entry.Key + '-rejected') { Invoke-Marker $Directory }
        Assert-SnapshotUnchanged $Before $Marker
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $Directory $OwnershipName))) 'Mismatched runtime marker gained an ownership marker.'
    }

    $RuntimeDirectory = New-CaseDirectory 'runtime-marker-directory'
    New-Item -ItemType Directory -Path (Join-Path $RuntimeDirectory $RuntimeName) | Out-Null
    Assert-Rejected 'runtime-marker-directory-rejected' { Invoke-Marker $RuntimeDirectory }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RuntimeDirectory $OwnershipName))) 'Runtime marker directory gained ownership.'

    foreach ($Kind in @('malformed', 'wrong-directory', 'duplicate-key', 'unknown-field')) {
        $Directory = New-CaseDirectory ('invalid-json-' + $Kind)
        Invoke-Marker $Directory
        $JsonPath = Join-Path $Directory $OwnershipName
        $Valid = [IO.File]::ReadAllText($JsonPath)
        switch ($Kind) {
            'malformed' { $Invalid = '{ invalid' }
            'wrong-directory' { $Invalid = $Valid.Replace(('"directoryName":"' + (Split-Path $Directory -Leaf) + '"'), '"directoryName":"another-stage"') }
            'duplicate-key' { $Invalid = $Valid.Insert(1, '"schemaVersion":1,') }
            'unknown-field' { $Invalid = $Valid.Insert(1, '"unowned":true,') }
        }
        Assert-True ($Invalid -cne $Valid) 'Invalid JSON test did not change its fixture.'
        [IO.File]::WriteAllText($JsonPath, $Invalid, [Text.UTF8Encoding]::new($false))
        $JsonBefore = Get-FileSnapshot $JsonPath
        $RuntimeBefore = Get-FileSnapshot (Join-Path $Directory $RuntimeName)
        Assert-Rejected ('ownership-' + $Kind + '-rejected') { Invoke-Marker $Directory }
        Assert-SnapshotUnchanged $JsonBefore $JsonPath
        Assert-SnapshotUnchanged $RuntimeBefore (Join-Path $Directory $RuntimeName)
    }

    $OwnershipDirectory = New-CaseDirectory 'ownership-marker-directory'
    New-Item -ItemType Directory -Path (Join-Path $OwnershipDirectory $OwnershipName) | Out-Null
    Assert-Rejected 'ownership-marker-directory-rejected' { Invoke-Marker $OwnershipDirectory }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $OwnershipDirectory $RuntimeName))) 'Ownership directory gained a runtime marker.'

    $FixtureRuntimeBefore = Get-FileSnapshot (Join-Path $FixtureRoot $RuntimeName)
    $FixtureOwnershipBefore = Get-FileSnapshot (Join-Path $FixtureRoot $OwnershipName)
    Assert-Rejected 'run-equals-build-root-rejected' { Write-OwnedOverlayRunMarker -RunDirectory $FixtureRoot -BuildRoot $FixtureRoot }
    Assert-SnapshotUnchanged $FixtureRuntimeBefore (Join-Path $FixtureRoot $RuntimeName)
    Assert-SnapshotUnchanged $FixtureOwnershipBefore (Join-Path $FixtureRoot $OwnershipName)
    Assert-Rejected 'build-root-outside-repository-build-rejected' { Write-OwnedOverlayRunMarker -RunDirectory $FixtureRoot -BuildRoot $RepoRoot }

    $RepositoryRuntimeBefore = Get-FileSnapshot (Join-Path $RepositoryBuildRoot $RuntimeName)
    $RepositoryOwnershipBefore = Get-FileSnapshot (Join-Path $RepositoryBuildRoot $OwnershipName)
    Assert-Rejected 'run-outside-selected-build-root-rejected' { Write-OwnedOverlayRunMarker -RunDirectory $RepositoryBuildRoot -BuildRoot $FixtureRoot }
    Assert-SnapshotUnchanged $RepositoryRuntimeBefore (Join-Path $RepositoryBuildRoot $RuntimeName)
    Assert-SnapshotUnchanged $RepositoryOwnershipBefore (Join-Path $RepositoryBuildRoot $OwnershipName)

    $JunctionTarget = New-CaseDirectory 'junction-target'
    $JunctionStage = Join-Path $JunctionTarget 'stage'
    New-Item -ItemType Directory -Path $JunctionStage | Out-Null
    $Junction = Join-Path $FixtureRoot 'junction'
    $JunctionCreated = $false
    try {
        New-Item -ItemType Junction -Path $Junction -Target $JunctionTarget | Out-Null
        $JunctionCreated = $true
    }
    catch { $Skipped.Add([ordered]@{ name = 'reparse-point-cases'; reason = $_.Exception.Message }) }
    if ($JunctionCreated) {
        $ThroughJunction = Join-Path $Junction 'stage'
        Assert-Rejected 'run-through-junction-rejected' { Write-OwnedOverlayRunMarker -RunDirectory $ThroughJunction -BuildRoot $FixtureRoot }
        Assert-Rejected 'junction-build-root-rejected' { Write-OwnedOverlayRunMarker -RunDirectory $ThroughJunction -BuildRoot $Junction }
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $JunctionStage $RuntimeName))) 'Junction target gained runtime ownership.'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $JunctionStage $OwnershipName))) 'Junction target gained JSON ownership.'
    }

    $Status = 'passed'
}
catch { $Failure = $_.Exception.Message; throw }
finally {
    # Keep these uniquely owned, small filesystem artifacts for audit. No
    # recursive removal or mutation of a caller-supplied directory is performed.
    $Evidence = [ordered]@{
        schemaVersion = 1
        fixture = 'owned-native-stage-markers'
        scope = 'Filesystem-only harness ownership markers; no SDK/native runtime build or GUI'
        status = $Status
        failure = $Failure
        helperSha256 = (Get-FileHash -LiteralPath (Join-Path $RepoRoot 'libs\electron-game-overlay-runtime\scripts\owned-stage-marker.ps1') -Algorithm SHA256).Hash
        artifactDirectory = [IO.Path]::GetRelativePath($RepoRoot, $FixtureRoot).Replace('\', '/')
        cases = @($Results.ToArray())
        skipped = @($Skipped.ToArray())
    }
    $Evidence | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $FixtureRoot 'evidence.json') -Encoding utf8NoBOM
    Write-Output ($Evidence | ConvertTo-Json -Depth 7)
}
