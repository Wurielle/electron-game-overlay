#requires -Version 7.2
# Console-only acceptance-result parser checks. No native/game/Electron launch.
$ErrorActionPreference = 'Stop'
$Repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
. (Join-Path $Repository 'libs\electron-game-overlay-runtime\scripts\run-client-sdk-preloaded-addons-gate.ps1') -Backend d3d11 -FunctionsOnly
$Directory = Join-Path $Repository ('build\preloaded-demo-controller-tests\' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Directory | Out-Null
$Target = @{ process = @{ Id = 12345 } }; $TargetPath = 'C:\controlled\p.exe'
$Prefix = 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT '
$Valid = @{ schemaVersion = 1; pid = 12345; runtimeMode = 'injected-runtime'; targetExecutablePath = $TargetPath }
$Checks = [Collections.Generic.List[object]]::new()
function Test-InitialRecord([string]$Name, [string]$Text, [bool]$Accepted) {
    $Path = Join-Path $Directory "$Name.stdout.log"
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
    $Actual = $false
    try { $Result = Read-PreloadInitialResult $Path; $Actual = $Result.pid -eq 12345 -and $Result.runtimeMode -ceq 'injected-runtime' } catch { }
    $Checks.Add(@{ name = $Name; expectedAccepted = $Accepted; accepted = $Actual })
    if ($Actual -ne $Accepted) { throw "Initial-result parser expectation failed: $Name" }
}
Test-InitialRecord valid ($Prefix + ($Valid | ConvertTo-Json -Compress)) $true
Test-InitialRecord progress ($Prefix + ($Valid | ConvertTo-Json -Compress) + "`nDone") $true
Test-InitialRecord duplicate (($Prefix + ($Valid | ConvertTo-Json -Compress) + "`n") * 2) $false
Test-InitialRecord diagnostic ('ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC unsafe' + "`n" + $Prefix + ($Valid | ConvertTo-Json -Compress)) $false
Test-InitialRecord no-result 'Done' $false
Test-InitialRecord malformed ($Prefix + '{') $false
foreach ($Case in @(
    @{ name = 'extra-field'; change = @{ surprise = 1 } },
    @{ name = 'wrong-mode'; change = @{ runtimeMode = 'participant-addon' } },
    @{ name = 'wrong-pid'; change = @{ pid = 12346 } },
    @{ name = 'string-pid'; change = @{ pid = '12345' } },
    @{ name = 'wrong-image'; change = @{ targetExecutablePath = 'C:\controlled\other.exe' } },
    @{ name = 'relative-image'; change = @{ targetExecutablePath = 'p.exe' } },
    @{ name = 'wrong-schema'; change = @{ schemaVersion = 2 } },
    @{ name = 'boolean-schema'; change = @{ schemaVersion = $true } }
)) {
    $Record = $Valid.Clone(); foreach ($Key in $Case.change.Keys) { $Record[$Key] = $Case.change[$Key] }
    Test-InitialRecord $Case.name ($Prefix + ($Record | ConvertTo-Json -Compress)) $false
}
Test-InitialRecord oversized ('x' * (1MB + 1)) $false
$Console = Start-PreloadProcess (New-PreloadProcessInfo (Get-Command node.exe).Source @('-e', 'process.exit(23)'))
if (-not $Console.process.WaitForExit(5000)) { $Console.process.Kill(); throw 'Console exit-evidence fixture timed out.' }
$ExitEvidence = Get-PreloadProcessEvidence $Console 'console-exit-fixture'
$ExitPassed = $ExitEvidence.hasExited -and $ExitEvidence.exitCode -eq 23 -and $ExitEvidence.exitCodeHex -ceq '0x00000017' -and $ExitEvidence.observedCreationMatches
$Checks.Add(@{ name = 'retained-console-exit-code'; passed = $ExitPassed; evidence = $ExitEvidence })
if (-not $ExitPassed) { throw 'Retained process exit evidence did not preserve its code and creation identity.' }
$Reserved = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($Variable in Get-Variable -Scope Global) {
    if (($Variable.Options -band ([Management.Automation.ScopedItemOptions]::ReadOnly -bor [Management.Automation.ScopedItemOptions]::Constant)) -ne 0) { $null = $Reserved.Add($Variable.Name) }
}
foreach ($Name in @('HOME', 'CODEX_HOME')) { $null = $Reserved.Add($Name) }
$ControllerFiles = @(
    'scripts\run-client-sdk-preloaded-addons-gate.ps1',
    'scripts\run-client-sdk-unregistered-addon-compatibility-gate.ps1',
    'scripts\test-cases\d3d11-client-sdk-preloaded-addons.ps1',
    'scripts\test-cases\d3d12-client-sdk-preloaded-addons.ps1',
    'scripts\test-cases\d3d11-client-sdk-unregistered-addon-compatibility.ps1',
    'scripts\test-cases\d3d12-client-sdk-unregistered-addon-compatibility.ps1',
    'tests\preloaded-demo-controller-test.ps1'
)
foreach ($ControllerFile in $ControllerFiles) {
    $ParseErrors = $null; $ParseTokens = $null
    $Ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Repository "libs\electron-game-overlay-runtime\$ControllerFile"), [ref]$ParseTokens, [ref]$ParseErrors)
    if ($ParseErrors) { throw "PowerShell parse failure in $ControllerFile" }
    foreach ($Node in $Ast.FindAll({ param($Candidate) $Candidate -is [Management.Automation.Language.VariableExpressionAst] }, $true)) {
        $IsWrite = ($Node.Parent -is [Management.Automation.Language.AssignmentStatementAst] -and $Node.Parent.Left -eq $Node) -or
            ($Node.Parent -is [Management.Automation.Language.ForEachStatementAst] -and $Node.Parent.Variable -eq $Node) -or
            ($Node.Parent -is [Management.Automation.Language.ParameterAst] -and $Node.Parent.Name -eq $Node)
        if ($IsWrite -and $Reserved.Contains(($Node.VariablePath.UserPath -split ':')[-1])) { throw "Reserved PowerShell variable write in ${ControllerFile}:$($Node.Extent.StartLineNumber): $($Node.Extent.Text)" }
    }
}
$Checks.Add(@{ name = 'controller-reserved-variable-safety'; passed = $true; parsedFiles = $ControllerFiles.Count })
$Checks | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Directory 'checks.json') -Encoding utf8
Write-Output "PRELOADED_DEMO_CONTROLLER_PASS $($Checks.Count) $Directory"
