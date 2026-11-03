#requires -Version 7.2
# Console-only checks of the actual acceptance controller. No game, injector,
# Electron process or graphics fixture is started by this script.
$ErrorActionPreference = 'Stop'
$Repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
. (Join-Path $Repository 'libs\electron-game-overlay-runtime\scripts\run-client-sdk-preloaded-addons-gate.ps1') -Backend d3d11 -FunctionsOnly -SkipBuild
$Source = Join-Path $Repository 'libs\electron-game-overlay-runtime\scripts\run-client-sdk-shared-addon-directory-gate.ps1'
$Errors = $null; $Tokens = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$Tokens, [ref]$Errors)
if ($Errors) { throw 'Shared-directory controller has a PowerShell parse error.' }
foreach ($Name in @('ConvertTo-SharedModulePath', 'Test-SharedModulePath', 'Read-SharedFolderInitialResult')) {
    $Definition = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name }, $true)
    if ($null -eq $Definition) { throw "Controller helper is missing: $Name" }
    Invoke-Expression $Definition.Extent.Text
}
$Directory = Join-Path $Repository ('build\shared-addon-directory-controller-tests\' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Directory | Out-Null
$Target = @{ process = @{ Id = 12345 } }; $TargetPath = 'C:\controlled\demo.exe'
$Architecture = 'x86'
$Diagnostic = [ordered]@{ schemaVersion = 1; stage = 'target-preflight'; code = 'target-architecture-mismatch'; pid = 12345; targetExecutablePath = $TargetPath; injectionStarted = $false; windowsErrorCode = 706 }
$Result = [ordered]@{ schemaVersion = 1; pid = 12345; runtimeMode = 'injected-runtime'; targetExecutablePath = $TargetPath }
$DiagnosticPrefix = 'ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC '
$ResultPrefix = 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT '
$X64 = "=== x64 injector stdout ===`nEGO_TARGET_SELECTED`t12345`n`nProcess architecture does not match injection tool! Cannot continue.`n" + $DiagnosticPrefix + ($Diagnostic | ConvertTo-Json -Compress) + "`nReShade injection not started.`n"
$X86 = "=== x86 injector stdout ===`nEGO_TARGET_SELECTED`t12345`nFound a matching process with PID 12345! Injecting ReShade ... Succeeded!`n" + $ResultPrefix + ($Result | ConvertTo-Json -Compress) + "`n"
$Valid = $X64 + $X86
$Checks = [Collections.Generic.List[object]]::new()
function Test-Handoff([string]$Name, [string]$Text, [bool]$Expected, [byte[]]$RawBytes = $null) {
    $script:CaseDirectory = Join-Path $Directory $Name
    New-Item -ItemType Directory -Path $script:CaseDirectory | Out-Null
    $Path = Join-Path $script:CaseDirectory 'inject.stdout.log'
    if ($null -ne $RawBytes) { [IO.File]::WriteAllBytes($Path, $RawBytes) }
    else { [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false, $true)) }
    $script:CaseResult = [ordered]@{}
    $Accepted = $false; $Failure = $null
    try { $Parsed = Read-SharedFolderInitialResult $Path; $Accepted = $Parsed.pid -eq 12345 -and $Parsed.runtimeMode -ceq 'injected-runtime' }
    catch { $Failure = $_.Exception.Message }
    $Checks.Add(@{ name = $Name; expectedAccepted = $Expected; accepted = $Accepted; failure = $Failure })
    if ($Accepted -ne $Expected) { throw "Architecture handoff parser case failed: $Name ($Failure)" }
    if ($Accepted -and $Architecture -eq 'x86') {
        if ($CaseResult.architectureHandoff.diagnostic.injectionStarted -ne $false -or $CaseResult.architectureHandoff.sourceSha256 -cne (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -or
            -not (Test-Path -LiteralPath $CaseResult.architectureHandoff.validatedX86Path -PathType Leaf)) { throw 'Validated architecture handoff did not retain exact source and derived evidence.' }
    }
}
Test-Handoff valid $Valid $true
Test-Handoff crlf ($Valid.Replace("`n", "`r`n")) $true
Test-Handoff missing-x64 $X86 $false
Test-Handoff missing-x86 $X64 $false
Test-Handoff reversed ($X86 + $X64) $false
Test-Handoff duplicate-x64 ($X64 + $Valid) $false
Test-Handoff duplicate-x86 ($Valid + $X86) $false
Test-Handoff alternate-header ($Valid.Replace('=== x86 injector stdout ===', '=== arm64 injector stdout ===')) $false
Test-Handoff preamble ("unsafe`n" + $Valid) $false
Test-Handoff x64-result ($X64 + $ResultPrefix + ($Result | ConvertTo-Json -Compress) + "`n" + $X86) $false
Test-Handoff missing-diag ($Valid.Replace($DiagnosticPrefix + ($Diagnostic | ConvertTo-Json -Compress) + "`n", '')) $false
Test-Handoff missing-not-started ($Valid.Replace("ReShade injection not started.`n", '')) $false
Test-Handoff wrong-selected ($Valid.Replace("EGO_TARGET_SELECTED`t12345", "EGO_TARGET_SELECTED`t12346")) $false
Test-Handoff unexpected-x64 ($X64 + "unexpected progress`n" + $X86) $false
Test-Handoff unexpected-x86 ($Valid + "unexpected progress`n") $false
Test-Handoff x86-failure ($Valid + "ReShade injection not started.`n") $false
Test-Handoff duplicate-result ($Valid + $ResultPrefix + ($Result | ConvertTo-Json -Compress) + "`n") $false
Test-Handoff missing-result ($X64 + "=== x86 injector stdout ===`nEGO_TARGET_SELECTED`t12345`nFound a matching process with PID 12345! Injecting ReShade ... Succeeded!`n") $false
foreach ($Mutation in @(
    @{ name = 'diagnostic-pid'; field = 'pid'; value = 12346 },
    @{ name = 'diagnostic-consumed'; field = 'injectionStarted'; value = $true },
    @{ name = 'diagnostic-string-bool'; field = 'injectionStarted'; value = 'false' },
    @{ name = 'diagnostic-code'; field = 'code'; value = 'target-module-inspection-failed' },
    @{ name = 'diagnostic-stage'; field = 'stage'; value = 'post-load' },
    @{ name = 'diagnostic-error'; field = 'windowsErrorCode'; value = 299 },
    @{ name = 'diagnostic-image'; field = 'targetExecutablePath'; value = 'C:\controlled\other.exe' },
    @{ name = 'diagnostic-extra'; field = 'unknown'; value = 1 }
)) {
    $Changed = [ordered]@{}; foreach ($Key in $Diagnostic.Keys) { $Changed[$Key] = $Diagnostic[$Key] }
    $Changed[$Mutation.field] = $Mutation.value
    Test-Handoff $Mutation.name ($Valid.Replace(($Diagnostic | ConvertTo-Json -Compress), ($Changed | ConvertTo-Json -Compress))) $false
}
$WrongResult = [ordered]@{}; foreach ($Key in $Result.Keys) { $WrongResult[$Key] = $Result[$Key] }; $WrongResult.pid = 12346
Test-Handoff wrong-x86-result ($Valid.Replace(($Result | ConvertTo-Json -Compress), ($WrongResult | ConvertTo-Json -Compress))) $false
Test-Handoff invalid-utf8 '' $false ([byte[]]@(0xff, 0xfe, 0xff))
Test-Handoff bom ("$([char]0xfeff)" + $Valid) $false
$Architecture = 'x64'
Test-Handoff strict-x64 ($ResultPrefix + ($Result | ConvertTo-Json -Compress) + "`n") $true
Test-Handoff strict-x64-diagnostic ($DiagnosticPrefix + ($Diagnostic | ConvertTo-Json -Compress) + "`n" + $ResultPrefix + ($Result | ConvertTo-Json -Compress)) $false
$Checks | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Directory 'checks.json') -Encoding utf8
Write-Output "SHARED_ADDON_DIRECTORY_CONTROLLER_PASS $($Checks.Count) $Directory"
