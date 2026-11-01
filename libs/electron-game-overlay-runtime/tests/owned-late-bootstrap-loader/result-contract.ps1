# Pure test-local result assertions. This file starts no child and reads no
# runtime files; the console harness supplies its independently observed data.
function Assert-OwnedLoaderResultContract {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)]$Target,
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$HostStage,
        [Parameter(Mandatory = $true)][string]$RuntimeLeaf,
        [Parameter(Mandatory = $true)][string]$AddonLeaf,
        [ValidateSet('injected-runtime','participant-addon')][string]$ExpectedMode = 'participant-addon'
    )
    if ($Record.ExitCode -ne 0 -or $Record.ResultLineCount -ne 1 -or -not $Record.Result) {
        throw 'Successful attachment must emit exactly one structured result.'
    }
    $Result = $Record.Result
    $ExpectedKeys = @('schemaVersion','pid','targetExecutablePath','runtimeMode')
    if ($ExpectedMode -eq 'participant-addon') {
        $ExpectedKeys += @('runtimeModulePath','addonModulePath','reshadeBasePath','addonAbi','memberProtocolVersion')
    }
    $ActualKeys = @($Result.PSObject.Properties.Name | Sort-Object)
    $ExpectedKeys = @($ExpectedKeys | Sort-Object)
    if ($ActualKeys.Count -ne $ExpectedKeys.Count -or
        @($ActualKeys | Where-Object { $_ -notin $ExpectedKeys }).Count -ne 0) {
        throw "$ExpectedMode result has an unexpected field set."
    }
    if ($Result.schemaVersion -ne 1 -or $Result.runtimeMode -ne $ExpectedMode -or
        $Result.pid -ne $Target.Process.Id -or $Result.targetExecutablePath -ine $Target.Executable) {
        throw 'Result did not bind the expected mode and exact target identity.'
    }
    if ($ExpectedMode -eq 'participant-addon' -and
        ($Result.runtimeModulePath -ine (Join-Path $HostStage $RuntimeLeaf) -or
         $Result.addonModulePath -ine (Join-Path $Stage $AddonLeaf) -or
         $Result.reshadeBasePath -ine $HostStage -or
         $Result.addonAbi -ne 1 -or $Result.memberProtocolVersion -ne 1)) {
        throw 'Participant result did not bind the exact original host and private member.'
    }
}

function Get-OwnedLoaderFirstPair {
    param([Parameter(Mandatory = $true)][object[]]$Attachments)
    if ($Attachments.Count -ne 2) { throw 'The first-attachment cell requires two application results.' }
    $Owners = @($Attachments | Where-Object { $_.Record.Result.runtimeMode -eq 'injected-runtime' })
    $Members = @($Attachments | Where-Object { $_.Record.Result.runtimeMode -eq 'participant-addon' })
    if ($Owners.Count -ne 1 -or $Members.Count -ne 1) {
        throw 'Simultaneous attachment must preserve one initial host result and one private participant result.'
    }
    return [pscustomobject]@{ Owner=$Owners[0]; Member=$Members[0]; HostStage=$Owners[0].Stage }
}
