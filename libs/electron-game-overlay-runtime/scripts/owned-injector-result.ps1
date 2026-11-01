# Structured success proof for controlled tests that stage an owned cooperative
# host. Human-readable injector progress can contain nested attachment messages.
function Read-OwnedOverlayInjectorResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$StdoutPath,
        [Parameter(Mandatory = $true)][int]$ExpectedPid,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath,
        [Parameter(Mandatory = $true)][string]$ExpectedRuntimePath,
        [Parameter(Mandatory = $true)][string]$ExpectedAddonPath,
        [Parameter(Mandatory = $true)][string]$ExpectedBasePath
    )

    if ($ExpectedPid -le 0 -or -not (Test-Path -LiteralPath $StdoutPath -PathType Leaf)) {
        throw 'The owned injector success proof requires an exact positive target PID and a stdout file.'
    }
    $Text = [IO.File]::ReadAllText($StdoutPath)
    if ($Text.Contains('ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ') -or
        $Text.Contains('ReShade injection not started.')) {
        throw 'The owned injector emitted an ambiguous success/diagnostic contract.'
    }
    $Prefix = 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT '
    $Lines = @($Text -split '\r?\n' | Where-Object { $_.StartsWith($Prefix, [StringComparison]::Ordinal) })
    if ($Lines.Count -ne 1) {
        throw "Expected exactly one owned injector result, found $($Lines.Count). Inspect $StdoutPath."
    }
    $Json = $Lines[0].Substring($Prefix.Length).Trim()
    if (-not $Json.StartsWith('{', [StringComparison]::Ordinal) -or
        -not $Json.EndsWith('}', [StringComparison]::Ordinal)) {
        throw 'The owned injector result must be one JSON object.'
    }
    try { $Record = $Json | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "The owned injector emitted malformed result JSON. Inspect $StdoutPath." }
    $Properties = @($Record.PSObject.Properties.Name | Sort-Object)
    if (($Properties -join ',') -cne 'addonAbi,addonModulePath,memberProtocolVersion,pid,reshadeBasePath,runtimeMode,runtimeModulePath,schemaVersion,targetExecutablePath') {
        throw 'The owned injector result did not match the cooperative participant schema.'
    }
    foreach ($Name in @('schemaVersion', 'pid', 'addonAbi', 'memberProtocolVersion')) {
        if ($Record.$Name -isnot [int] -and $Record.$Name -isnot [long]) {
            throw "The owned injector result has an invalid integer field: $Name."
        }
    }
    if ($Record.schemaVersion -ne 1 -or $Record.pid -ne $ExpectedPid -or
        $Record.runtimeMode -isnot [string] -or $Record.runtimeMode -cne 'participant-addon' -or
        $Record.addonAbi -ne 1 -or $Record.memberProtocolVersion -ne 1) {
        throw 'The owned injector result did not identify the requested PID and cooperative runtime mode.'
    }
    foreach ($Pair in @(
            @('targetExecutablePath', $ExpectedExecutablePath),
            @('runtimeModulePath', $ExpectedRuntimePath),
            @('addonModulePath', $ExpectedAddonPath),
            @('reshadeBasePath', $ExpectedBasePath))) {
        $Actual = $Record.($Pair[0])
        if ($Actual -isnot [string] -or -not [IO.Path]::IsPathRooted($Actual) -or
            [IO.Path]::GetPathRoot($Actual).Length -lt 3 -or
            -not [IO.Path]::GetFullPath($Actual).Equals(
                [IO.Path]::GetFullPath($Pair[1]), [StringComparison]::OrdinalIgnoreCase)) {
            throw "The owned injector result reported an unexpected $($Pair[0])."
        }
    }
    return $Record
}

# An initial owned-host request can finish through member attachment after the
# host is loaded. Legacy injected-runtime results contain only PID/image proof;
# callers must additionally inspect exact mapped runtime/add-on paths and hashes
# before treating either result as native startup acceptance.
function Read-OwnedOverlayInitialResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$StdoutPath,
        [Parameter(Mandatory = $true)][int]$ExpectedPid,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath,
        [Parameter(Mandatory = $true)][string]$ExpectedRuntimePath,
        [Parameter(Mandatory = $true)][string]$ExpectedAddonPath,
        [Parameter(Mandatory = $true)][string]$ExpectedBasePath
    )
    if ($ExpectedPid -le 0) { throw 'An initial injector result requires an exact positive target PID.' }
    foreach ($Path in @($ExpectedExecutablePath, $ExpectedRuntimePath, $ExpectedAddonPath, $ExpectedBasePath)) {
        if (-not [IO.Path]::IsPathRooted($Path) -or [IO.Path]::GetPathRoot($Path).Length -lt 3) {
            throw 'Initial injector proof requires absolute expected target and owned-stage paths.'
        }
    }
    $Base = [IO.Path]::GetFullPath($ExpectedBasePath).TrimEnd([char[]]@('\', '/'))
    foreach ($Path in @($ExpectedRuntimePath, $ExpectedAddonPath)) {
        if (-not [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)).Equals($Base, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Expected initial runtime and add-on must belong to the one exact owned staging directory.'
        }
    }
    $Stream = $null
    $Reader = $null
    try {
        # OpenRead holds FileShare.Read, so a writer cannot change this bounded
        # input while participant validation opens the same immutable file.
        $Stream = [IO.File]::OpenRead($StdoutPath)
        if ($Stream.Length -lt 1 -or $Stream.Length -gt 1MB) {
            throw 'Initial injector stdout must contain between one byte and one MiB.'
        }
        $Reader = [IO.StreamReader]::new($Stream, [Text.UTF8Encoding]::new($false, $true), $true)
        $Text = $Reader.ReadToEnd()
        if ($Text.Contains('ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ') -or
            $Text.Contains('ReShade injection not started.')) {
            throw 'The initial injector emitted an ambiguous success/diagnostic contract.'
        }
        $Prefix = 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT '
        $Lines = @($Text -split '\r?\n' | Where-Object { $_.StartsWith($Prefix, [StringComparison]::Ordinal) })
        if ($Lines.Count -ne 1) { throw 'Expected exactly one structured initial injector result.' }
        $Json = $Lines[0].Substring($Prefix.Length).Trim()
        if (-not $Json.StartsWith('{', [StringComparison]::Ordinal) -or
            -not $Json.EndsWith('}', [StringComparison]::Ordinal)) {
            throw 'The initial injector result must be one JSON object.'
        }
        try { $Record = $Json | ConvertFrom-Json -ErrorAction Stop }
        catch { throw 'The initial injector emitted malformed result JSON.' }
        if ($Record.runtimeMode -isnot [string]) { throw 'The initial injector result has an invalid runtime mode.' }
        if ($Record.runtimeMode -ceq 'participant-addon') {
            return Read-OwnedOverlayInjectorResult -StdoutPath $StdoutPath -ExpectedPid $ExpectedPid `
                -ExpectedExecutablePath $ExpectedExecutablePath -ExpectedRuntimePath $ExpectedRuntimePath `
                -ExpectedAddonPath $ExpectedAddonPath -ExpectedBasePath $ExpectedBasePath
        }
        $Properties = @($Record.PSObject.Properties.Name | Sort-Object)
        if (($Properties -join ',') -cne 'pid,runtimeMode,schemaVersion,targetExecutablePath' -or
            $Record.runtimeMode -cne 'injected-runtime' -or
            ($Record.schemaVersion -isnot [int] -and $Record.schemaVersion -isnot [long]) -or
            ($Record.pid -isnot [int] -and $Record.pid -isnot [long]) -or
            $Record.schemaVersion -ne 1 -or $Record.pid -ne $ExpectedPid -or
            $Record.targetExecutablePath -isnot [string] -or
            -not [IO.Path]::IsPathRooted($Record.targetExecutablePath) -or
            [IO.Path]::GetPathRoot($Record.targetExecutablePath).Length -lt 3 -or
            -not [IO.Path]::GetFullPath($Record.targetExecutablePath).Equals(
                [IO.Path]::GetFullPath($ExpectedExecutablePath), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The initial injector result did not match the exact legacy schema, target PID and image.'
        }
        return $Record
    }
    finally {
        if ($Reader) { $Reader.Dispose() }
        elseif ($Stream) { $Stream.Dispose() }
    }
}

# Bind the SDK's displayed exact-PID arguments to one producer's structured
# attachment attempt. This proves bootstrap completion, before graphics starts;
# the caller separately proves the one exact mapped runtime and later features.
function Read-OwnedOverlayStartupAttempt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ClientLogText,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Events,
        [Parameter(Mandatory = $true)][int]$ExpectedPid,
        [Parameter(Mandatory = $true)][int]$ExpectedProducerPid,
        [Parameter(Mandatory = $true)][string]$ExpectedCreationTime100ns,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath
    )
    [UInt64]$Creation = 0
    if ($ExpectedPid -le 0 -or $ExpectedProducerPid -le 0 -or
        $ExpectedCreationTime100ns -cnotmatch '^[1-9][0-9]{0,19}$' -or
        -not [UInt64]::TryParse($ExpectedCreationTime100ns, [ref]$Creation) -or
        -not [IO.Path]::IsPathRooted($ExpectedExecutablePath) -or
        [IO.Path]::GetPathRoot($ExpectedExecutablePath).Length -lt 3) {
        throw 'Startup proof requires exact positive target/producer identities, creation time and absolute target image.'
    }
    $Executable = [IO.Path]::GetFullPath($ExpectedExecutablePath)
    $Leaf = [IO.Path]::GetFileName($Executable)
    $StartedLines = @($ClientLogText -split '\r?\n' | Where-Object {
        $_.StartsWith('RESHADE_CLIENT_INJECTOR_STARTED', [StringComparison]::Ordinal)
    })
    if ($StartedLines.Count -ne 1 -or $StartedLines[0] -cnotmatch
        '^RESHADE_CLIENT_INJECTOR_STARTED target=("(?:\\.|[^"\\])*") arguments=(\[[^\r\n]*\])$') {
        throw 'Expected exactly one complete SDK injector-started argument record.'
    }
    try {
        $Target = $Matches[1] | ConvertFrom-Json -ErrorAction Stop
        $Arguments = $Matches[2] | ConvertFrom-Json -ErrorAction Stop
    } catch { throw 'SDK injector-started arguments were malformed JSON.' }
    if ($Target -isnot [string] -or -not $Target.Equals($Leaf, [StringComparison]::OrdinalIgnoreCase) -or
        $Arguments -isnot [array] -or $Arguments.Count -ne 5) {
        throw 'SDK injector-started target or argument shape was unexpected.'
    }
    $ExpectedArguments = @($Leaf, '--pid', [string]$ExpectedPid, '--expected-creation-time-100ns', $ExpectedCreationTime100ns)
    for ($Index = 0; $Index -lt 5; $Index++) {
        if ($Arguments[$Index] -isnot [string] -or
            -not $Arguments[$Index].Equals($ExpectedArguments[$Index],
                $(if ($Index -eq 0) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }))) {
            throw 'SDK injector-started arguments did not match the retained exact target identity.'
        }
    }
    $Runs = @($Events | Where-Object { $_.type -ceq 'run.started' })
    if ($Runs.Count -ne 1) { throw 'Expected one unambiguous producer compatibility run.' }
    $Run = $Runs[0]
    if (($Run.schemaVersion -isnot [int] -and $Run.schemaVersion -isnot [long]) -or $Run.schemaVersion -ne 1 -or
        ($Run.data.clientPid -isnot [int] -and $Run.data.clientPid -isnot [long]) -or
        $Run.data.clientPid -ne $ExpectedProducerPid -or $Run.runId -isnot [string] -or
        [string]::IsNullOrWhiteSpace($Run.runId)) {
        throw 'Compatibility run did not identify the actual producer process.'
    }
    $Proof = @{}
    foreach ($Type in @('attachment.rendezvous-authorized', 'attachment.injector-started', 'attachment.injector-returned')) {
        $Records = @($Events | Where-Object { $_.runId -ceq $Run.runId -and $_.type -ceq $Type -and $_.pid -eq $ExpectedPid })
        if ($Records.Count -ne 1) { throw "Expected one exact target event: $Type." }
        $Record = $Records[0]
        if (($Record.schemaVersion -isnot [int] -and $Record.schemaVersion -isnot [long]) -or $Record.schemaVersion -ne 1 -or
            ($Record.pid -isnot [int] -and $Record.pid -isnot [long]) -or
            $Record.targetId -isnot [string] -or [string]::IsNullOrWhiteSpace($Record.targetId) -or
            $Record.data.attemptId -isnot [string] -or [string]::IsNullOrWhiteSpace($Record.data.attemptId) -or
            ($Record.sequence -isnot [int] -and $Record.sequence -isnot [long]) -or $Record.sequence -le 0) {
            throw "Compatibility event has an invalid identity/schema: $Type."
        }
        $Proof[$Type] = $Record
    }
    $Authorized = $Proof['attachment.rendezvous-authorized']
    $Started = $Proof['attachment.injector-started']
    $Returned = $Proof['attachment.injector-returned']
    foreach ($Record in @($Authorized, $Returned)) {
        if ($Record.targetId -cne $Started.targetId -or $Record.data.attemptId -cne $Started.data.attemptId) {
            throw 'Startup completion crossed attachment attempts or targets.'
        }
    }
    if ($Started.data.strategy -isnot [string] -or $Started.data.strategy -cne 'exact-pid' -or
        $Returned.data.runtimeMode -isnot [string] -or
        $Returned.data.runtimeMode -cnotin @('injected-runtime', 'participant-addon') -or
        $Authorized.sequence -ge $Started.sequence -or $Started.sequence -ge $Returned.sequence) {
        throw 'Startup completion did not follow an authorized exact-PID attempt with a supported runtime mode.'
    }
    [DateTimeOffset]$ReturnedAt = [DateTimeOffset]::MinValue
    if ($Returned.timestamp -is [DateTimeOffset]) { $ReturnedAt = $Returned.timestamp }
    elseif ($Returned.timestamp -is [DateTime]) { $ReturnedAt = [DateTimeOffset]::new($Returned.timestamp.ToUniversalTime()) }
    elseif ($Returned.timestamp -isnot [string] -or
        -not [DateTimeOffset]::TryParse($Returned.timestamp, [ref]$ReturnedAt)) { throw 'Injector completion timestamp was missing or invalid.' }
    return [pscustomobject]@{
        TargetPid = $ExpectedPid
        ProducerPid = $ExpectedProducerPid
        CreationTime100ns = $ExpectedCreationTime100ns
        TargetExecutablePath = $Executable
        RuntimeMode = $Returned.data.runtimeMode
        InjectorReturnedUtc = $ReturnedAt.UtcDateTime.ToString('o')
        AttemptId = $Started.data.attemptId
        TargetId = $Started.targetId
    }
}
