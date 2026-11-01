$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'result-contract.ps1')
$Target = [pscustomobject]@{ Process=[pscustomobject]@{Id=42}; Executable='C:\owned\target\game.exe' }
$HostStage = 'C:\owned\app-a'
$MemberStage = 'C:\owned\app-b'
$RuntimeLeaf = 'ReShade64.dll'
$AddonLeaf = 'electron_game_overlay.addon64'
$Assertions = [Collections.Generic.List[string]]::new()

function New-Owner {
    return [pscustomobject]@{ ExitCode=0; ResultLineCount=1; Result=[pscustomobject][ordered]@{
        schemaVersion=1; pid=42; targetExecutablePath=$Target.Executable; runtimeMode='injected-runtime'
    } }
}
function New-Member {
    return [pscustomobject]@{ ExitCode=0; ResultLineCount=1; Result=[pscustomobject][ordered]@{
        schemaVersion=1; pid=42; targetExecutablePath=$Target.Executable; runtimeMode='participant-addon'
        runtimeModulePath=(Join-Path $HostStage $RuntimeLeaf); addonModulePath=(Join-Path $MemberStage $AddonLeaf)
        reshadeBasePath=$HostStage; addonAbi=1; memberProtocolVersion=1
    } }
}
function Assert-Contract($Record,[string]$Mode,[string]$Stage) {
    Assert-OwnedLoaderResultContract -Record $Record -Target $Target -Stage $Stage -HostStage $HostStage `
        -RuntimeLeaf $RuntimeLeaf -AddonLeaf $AddonLeaf -ExpectedMode $Mode
}
function Expect-Rejection([string]$Name,[scriptblock]$Action) {
    $Rejected = $false
    try { & $Action } catch { $Rejected = $true }
    if (-not $Rejected) { throw "Expected rejection: $Name" }
    $Assertions.Add($Name)
}

Assert-Contract (New-Owner) 'injected-runtime' $HostStage
$Assertions.Add('initial-owner-exact-four-fields')
Assert-Contract (New-Member) 'participant-addon' $MemberStage
$Assertions.Add('participant-exact-nine-fields')
foreach ($Reverse in @($false,$true)) {
    $Owner=[pscustomobject]@{Record=(New-Owner);Stage=$HostStage}
    $Member=[pscustomobject]@{Record=(New-Member);Stage=$MemberStage}
    $Attachments=if($Reverse){@($Member,$Owner)}else{@($Owner,$Member)}
    $Pair=Get-OwnedLoaderFirstPair -Attachments $Attachments
    if($Pair.HostStage -ne $HostStage -or $Pair.Owner.Stage -ne $HostStage -or $Pair.Member.Stage -ne $MemberStage){throw 'Completion order changed the inferred first host.'}
    Assert-Contract $Pair.Owner.Record 'injected-runtime' $Pair.Owner.Stage
    Assert-Contract $Pair.Member.Record 'participant-addon' $Pair.Member.Stage
    $Assertions.Add("first-pair-order-reversed-$Reverse")
}
Expect-Rejection 'owner-must-not-grow-addon-path' {
    $Record=New-Owner; $Record.Result|Add-Member -NotePropertyName addonModulePath -NotePropertyValue 'C:\untrusted\member.dll'
    Assert-Contract $Record 'injected-runtime' $HostStage
}
Expect-Rejection 'participant-requires-all-nine-fields' {
    $Record=New-Member; $Record.Result.PSObject.Properties.Remove('reshadeBasePath')
    Assert-Contract $Record 'participant-addon' $MemberStage
}
Expect-Rejection 'owner-exact-target-pid' {
    $Record=New-Owner; $Record.Result.pid=43
    Assert-Contract $Record 'injected-runtime' $HostStage
}
Expect-Rejection 'owner-exact-target-path' {
    $Record=New-Owner; $Record.Result.targetExecutablePath='C:\other\game.exe'
    Assert-Contract $Record 'injected-runtime' $HostStage
}
Expect-Rejection 'participant-original-runtime-path' {
    $Record=New-Member; $Record.Result.runtimeModulePath=Join-Path $MemberStage $RuntimeLeaf
    Assert-Contract $Record 'participant-addon' $MemberStage
}
Expect-Rejection 'participant-private-addon-path' {
    $Record=New-Member; $Record.Result.addonModulePath=Join-Path $HostStage $AddonLeaf
    Assert-Contract $Record 'participant-addon' $MemberStage
}
Expect-Rejection 'duplicate-success-result' {
    $Record=New-Owner; $Record.ResultLineCount=2
    Assert-Contract $Record 'injected-runtime' $HostStage
}
Expect-Rejection 'initial-pair-cannot-be-two-participants' {
    $null=Get-OwnedLoaderFirstPair -Attachments @([pscustomobject]@{Record=(New-Member);Stage=$HostStage},[pscustomobject]@{Record=(New-Member);Stage=$MemberStage})
}
Expect-Rejection 'initial-pair-cannot-be-two-owners' {
    $null=Get-OwnedLoaderFirstPair -Attachments @([pscustomobject]@{Record=(New-Owner);Stage=$HostStage},[pscustomobject]@{Record=(New-Owner);Stage=$MemberStage})
}
[ordered]@{schemaVersion=1;fixture='owned-loader-result-contract-pure';status='passed';assertionCount=$Assertions.Count;assertions=@($Assertions);nativeExecution=$false}|ConvertTo-Json -Depth 4
