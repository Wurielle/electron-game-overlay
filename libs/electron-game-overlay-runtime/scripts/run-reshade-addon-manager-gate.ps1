[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$runtimeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = (Resolve-Path (Join-Path $runtimeRoot '..\..')).Path
$sourcePath = Join-Path $runtimeRoot 'src\electron_game_overlay_reshade_manager.cpp'
$buildDirectory = Join-Path $repositoryRoot 'build\electron-game-overlay-reshade-manager-gate'
$managerPath = Join-Path $buildDirectory 'electron_game_overlay_reshade_manager.exe'

function Assert-Condition {
    param(
        [Parameter(Mandatory)]
        [bool]$Condition,
        [Parameter(Mandatory)]
        [string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Get-FileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-TreeFingerprint {
    param([Parameter(Mandatory)][string]$Path)

    $entries = foreach ($item in Get-ChildItem -LiteralPath $Path -Force) {
        if ($item.PSIsContainer) {
            "D|$($item.Name)"
        } else {
            "F|$($item.Name)|$($item.Length)|$(Get-FileSha256 -Path $item.FullName)"
        }
    }
    return ($entries | Sort-Object) -join "`n"
}

function Assert-ManagerJsonSchema {
    param(
        [Parameter(Mandatory)]
        [psobject]$Result
    )

    $expectedProperties = if ($Result.status -eq 'error') {
        @(
            'code'
            'kind'
            'message'
            'operation'
            'schemaVersion'
            'status'
            'windowsError'
        )
    } else {
        @(
            'addonPath'
            'addonSha256'
            'expectedAddonSha256'
            'kind'
            'markerPath'
            'operation'
            'previousAddonSha256'
            'recoveredTransaction'
            'reshadeModulePath'
            'reshadeModuleSha256'
            'restartRequired'
            'schemaVersion'
            'status'
        )
    }
    $actualProperties = @(
        $Result.PSObject.Properties |
            Select-Object -ExpandProperty Name |
            Sort-Object
    )
    Assert-Condition (
        @(
            Compare-Object `
                ($expectedProperties | Sort-Object) `
                $actualProperties
        ).Count -eq 0
    ) 'Manager JSON did not have the exact protocol property set.'
}

function Invoke-Manager {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [Parameter(Mandatory)]
        [int]$ExpectedExit
    )

    $moduleOptionIndex = [Array]::IndexOf(
        [object[]]$Arguments,
        '--reshade-module'
    )
    if ($moduleOptionIndex -lt 0) {
        $expectedModule = $script:reshadeModule
        $Arguments = @($Arguments) + @(
            '--reshade-module',
            $expectedModule
        )
    } else {
        Assert-Condition ($moduleOptionIndex + 1 -lt $Arguments.Count) (
            'The test supplied --reshade-module without a value.'
        )
        $expectedModule = $Arguments[$moduleOptionIndex + 1]
    }
    $lines = @(& $managerPath @Arguments)
    $exitCode = $LASTEXITCODE
    Assert-Condition ($exitCode -eq $ExpectedExit) (
        "Manager exit mismatch. Expected $ExpectedExit, got $exitCode. Output: " +
        ($lines -join "`n")
    )
    Assert-Condition ($lines.Count -eq 1) (
        "Manager must emit exactly one JSON line, got $($lines.Count)."
    )
    $result = $lines[0] | ConvertFrom-Json
    Assert-Condition ($result.schemaVersion -eq 1) 'Unexpected result schema.'
    Assert-Condition (
        $result.kind -eq 'electron-game-overlay-reshade-addon-manager-result'
    ) 'Unexpected result kind.'
    Assert-ManagerJsonSchema -Result $result
    if ($result.status -ne 'error') {
        Assert-Condition (
            [IO.Path]::GetFullPath([string]$result.reshadeModulePath) -eq
            [IO.Path]::GetFullPath($expectedModule)
        ) 'Success result did not bind the exact held ReShade module path.'
    }
    return $result
}

function Invoke-ManagerAnyExit {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    $moduleOptionIndex = [Array]::IndexOf(
        [object[]]$Arguments,
        '--reshade-module'
    )
    if ($moduleOptionIndex -lt 0) {
        $expectedModule = $script:reshadeModule
        $Arguments = @($Arguments) + @(
            '--reshade-module',
            $expectedModule
        )
    } else {
        Assert-Condition ($moduleOptionIndex + 1 -lt $Arguments.Count) (
            'The test supplied --reshade-module without a value.'
        )
        $expectedModule = $Arguments[$moduleOptionIndex + 1]
    }
    $lines = @(& $managerPath @Arguments)
    $exitCode = $LASTEXITCODE
    Assert-Condition ($lines.Count -eq 1) (
        "Manager must emit exactly one JSON line, got $($lines.Count)."
    )
    $result = $lines[0] | ConvertFrom-Json
    Assert-Condition ($result.schemaVersion -eq 1) 'Unexpected result schema.'
    Assert-Condition (
        $result.kind -eq 'electron-game-overlay-reshade-addon-manager-result'
    ) 'Unexpected result kind.'
    Assert-ManagerJsonSchema -Result $result
    if ($result.status -ne 'error') {
        Assert-Condition (
            [IO.Path]::GetFullPath([string]$result.reshadeModulePath) -eq
            [IO.Path]::GetFullPath($expectedModule)
        ) 'Success result did not bind the exact held ReShade module path.'
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Result = $result
    }
}

function Invoke-ManagerFault {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    if ($Arguments -notcontains '--reshade-module') {
        $Arguments = @($Arguments) + @(
            '--reshade-module',
            $script:reshadeModule
        )
    }
    $lines = @(& $managerPath @Arguments)
    $exitCode = $LASTEXITCODE
    Assert-Condition ($exitCode -eq 197) (
        "Fault injection exit mismatch. Expected 197, got $exitCode. Output: " +
        ($lines -join "`n")
    )
    Assert-Condition ($lines.Count -eq 0) (
        'A hard fault injection unexpectedly emitted a completed result.'
    )
}

function New-TestFile {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Text
    )
    [IO.File]::WriteAllBytes($Path, [Text.Encoding]::UTF8.GetBytes($Text))
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
Assert-Condition (Test-Path -LiteralPath $vswhere -PathType Leaf) (
    "Visual Studio locator is required: $vswhere"
)
$vsInstall = (& $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath | Select-Object -First 1)
Assert-Condition (-not [string]::IsNullOrWhiteSpace($vsInstall)) (
    'Visual Studio x64 C++ Build Tools are required.'
)
$devShellModule = Join-Path $vsInstall 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
Assert-Condition (Test-Path -LiteralPath $devShellModule -PathType Leaf) (
    "Visual Studio developer-shell module is required: $devShellModule"
)
Import-Module $devShellModule
Enter-VsDevShell -VsInstallPath $vsInstall -SkipAutomaticLocation `
    -DevCmdArguments '-arch=x64 -host_arch=x64'

New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null
& cl.exe /nologo /std:c++20 /W4 /WX /permissive- /EHsc `
    /DUNICODE /D_UNICODE `
    /DELECTRON_GAME_OVERLAY_RESHADE_MANAGER_TEST_FAULTS `
    $sourcePath `
    "/Fo:$(Join-Path $buildDirectory 'electron_game_overlay_reshade_manager.obj')" `
    "/Fe:$managerPath" /link /INCREMENTAL:NO
Assert-Condition ($LASTEXITCODE -eq 0) 'Native manager compilation failed.'
Assert-Condition (Test-Path -LiteralPath $managerPath -PathType Leaf) (
    "Native manager output is missing: $managerPath"
)

$sandbox = Join-Path $env:TEMP (
    'electron-game-overlay-reshade-manager-gate-' +
    [guid]::NewGuid().ToString('N')
)
$canonicalTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$canonicalSandbox = [IO.Path]::GetFullPath($sandbox)
Assert-Condition (
    $canonicalSandbox.StartsWith(
        $canonicalTemp,
        [StringComparison]::OrdinalIgnoreCase
    )
) "Refusing to use a sandbox outside TEMP: $canonicalSandbox"

$gatePassed = $false
try {
    New-Item -ItemType Directory -Path $sandbox | Out-Null
    $directory = New-Item -ItemType Directory `
        -Path (Join-Path $sandbox 'official-install') | Select-Object -ExpandProperty FullName
    $source = Join-Path $sandbox 'staged.addon64'
    $reshadeDll = Join-Path $directory 'dxgi.dll'
    $reshadeIni = Join-Path $directory 'ReShade.ini'
    $foreignAddon = Join-Path $directory 'third-party.addon64'
    New-TestFile -Path $source -Text 'addon-v1'
    New-TestFile -Path $reshadeDll -Text 'official-reshade-runtime'
    New-TestFile -Path $reshadeIni -Text '[ADDON] AddonPath=.\'
    New-TestFile -Path $foreignAddon -Text 'foreign-addon'
    $script:reshadeModule = $reshadeDll
    $runtimeHash = Get-FileSha256 -Path $script:reshadeModule
    $protectedHashes = @{
        $reshadeDll = Get-FileSha256 -Path $reshadeDll
        $reshadeIni = Get-FileSha256 -Path $reshadeIni
        $foreignAddon = Get-FileSha256 -Path $foreignAddon
    }

    $sourceHashV1 = Get-FileSha256 -Path $source
    $beforeModuleNegatives = Get-TreeFingerprint -Path $directory
    $wrongModuleHash = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'inspect',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV1,
        '--reshade-module-sha256', ('F' * 64)
    )
    Assert-Condition (
        $wrongModuleHash.status -eq 'error' -and
        $wrongModuleHash.code -eq 'reshade-module-changed'
    ) 'A mismatched ReShade module hash was not rejected.'
    $moduleAlias = Join-Path $sandbox 'ReShade64-hardlink.dll'
    New-Item -ItemType HardLink -Path $moduleAlias -Target $reshadeDll |
        Out-Null
    $hardLinkedModule = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'inspect',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV1,
        '--reshade-module', $moduleAlias,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $hardLinkedModule.status -eq 'error' -and
        $hardLinkedModule.code -eq 'path-identity-invalid'
    ) 'A hard-linked ReShade module was not rejected.'
    Remove-Item -LiteralPath $moduleAlias -Force
    Assert-Condition (
        (Get-TreeFingerprint -Path $directory) -eq $beforeModuleNegatives
    ) 'ReShade module identity rejection changed installation bytes.'

    # Ordinary staging exceptions occur after the durable journal is created,
    # but before any public name is changed. The creating process owns every
    # exact handle and must remove all of them instead of poisoning the
    # reserved journal for future runs.
    $stagingFailureDirectory = (
        New-Item -ItemType Directory -Path (
            Join-Path $sandbox 'uncommitted-staging-failure'
        )
    ).FullName
    $stagingFailureSource = Join-Path $sandbox 'staging-failure.addon64'
    New-TestFile -Path $stagingFailureSource -Text 'staging-failure-v1'
    $stagingFailureHashV1 = Get-FileSha256 -Path $stagingFailureSource
    $env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_UNCOMMITTED_STAGE =
        'install'
    $failedInstallStage = Invoke-Manager -ExpectedExit 5 -Arguments @(
        'prepare',
        '--directory', $stagingFailureDirectory,
        '--source', $stagingFailureSource,
        '--source-sha256', $stagingFailureHashV1,
        '--reshade-module-sha256', $runtimeHash
    )
    Remove-Item (
        'Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_' +
        'FAIL_UNCOMMITTED_STAGE'
    )
    Assert-Condition (
        $failedInstallStage.status -eq 'error' -and
        $failedInstallStage.code -eq 'io-failed' -and
        [string]::IsNullOrEmpty(
            (Get-TreeFingerprint -Path $stagingFailureDirectory)
        )
    ) 'An uncommitted install staging failure poisoned its directory.'
    $stagingFixtureInstall = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $stagingFailureDirectory,
        '--source', $stagingFailureSource,
        '--source-sha256', $stagingFailureHashV1,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($stagingFixtureInstall.status -eq 'installed') (
        'The staging-failure fixture could not install after cleanup.'
    )
    New-TestFile -Path $stagingFailureSource -Text 'staging-failure-v2'
    $stagingFailureHashV2 = Get-FileSha256 -Path $stagingFailureSource
    $stagingTreeBeforeUpdate = Get-TreeFingerprint -Path (
        $stagingFailureDirectory
    )
    $env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_UNCOMMITTED_STAGE =
        'update'
    $failedUpdateStage = Invoke-Manager -ExpectedExit 5 -Arguments @(
        'prepare',
        '--directory', $stagingFailureDirectory,
        '--source', $stagingFailureSource,
        '--source-sha256', $stagingFailureHashV2,
        '--reshade-module-sha256', $runtimeHash
    )
    Remove-Item (
        'Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_' +
        'FAIL_UNCOMMITTED_STAGE'
    )
    Assert-Condition (
        $failedUpdateStage.status -eq 'error' -and
        $failedUpdateStage.code -eq 'io-failed' -and
        (Get-TreeFingerprint -Path $stagingFailureDirectory) -eq
            $stagingTreeBeforeUpdate
    ) 'An uncommitted update staging failure poisoned its directory.'
    $stagingFixtureUpdate = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $stagingFailureDirectory,
        '--source', $stagingFailureSource,
        '--source-sha256', $stagingFailureHashV2,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($stagingFixtureUpdate.status -eq 'updated') (
        'The staging-failure fixture could not update after cleanup.'
    )

    $inspectMissing = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV1,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($inspectMissing.status -eq 'not-installed') (
        'A clean directory must inspect as not-installed.'
    )

    $installed = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV1,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($installed.status -eq 'installed') (
        'First preparation must install.'
    )
    $markerPath = Join-Path $directory '.electron-game-overlay-addon.json'
    $addonPath = Join-Path $directory 'electron_game_overlay.addon64'
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    Assert-Condition (@($marker.PSObject.Properties).Count -eq 6) (
        'Ownership marker must have exactly the schema-1 fields.'
    )
    Assert-Condition (
        $marker.schemaVersion -eq 1 -and
        $marker.kind -eq 'electron-game-overlay-reshade-addon' -and
        $marker.addonFileName -eq 'electron_game_overlay.addon64' -and
        [IO.Path]::GetFullPath($marker.addonPath) -eq [IO.Path]::GetFullPath($addonPath) -and
        $marker.addonSha256 -eq $sourceHashV1 -and
        $marker.reshadeModuleSha256 -eq $runtimeHash
    ) 'Ownership marker does not match the public schema.'

    $sourceHashV1BeforeInspect = Get-TreeFingerprint -Path $directory
    $current = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV1,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($current.status -eq 'already-current') (
        'Installed source must inspect as already-current.'
    )
    Assert-Condition (
        (Get-TreeFingerprint -Path $directory) -eq $sourceHashV1BeforeInspect
    ) 'Inspect changed the installation tree.'

    New-TestFile -Path $source -Text 'addon-v2-with-different-bytes'
    $sourceHashV2 = Get-FileSha256 -Path $source
    $needsUpdate = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV2,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($needsUpdate.status -eq 'update-required') (
        'A different staged source must inspect as update-required.'
    )
    $updated = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV2,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $updated.status -eq 'updated' -and
        $updated.previousAddonSha256 -eq $sourceHashV1 -and
        (Get-FileSha256 -Path $addonPath) -eq $sourceHashV2
    ) 'Update did not replace the exact owned generation.'

    foreach ($entry in $protectedHashes.GetEnumerator()) {
        Assert-Condition ((Get-FileSha256 -Path $entry.Key) -eq $entry.Value) (
            "Protected ReShade/foreign file changed: $($entry.Key)"
        )
    }

    # A crash after publishing the update marker must be recoverable without
    # replacing any unverified path.
    New-TestFile -Path $source -Text 'addon-v3-recovery'
    $sourceHashV3 = Get-FileSha256 -Path $source
    $env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE =
        'update:marker-published'
    Invoke-ManagerFault -Arguments @(
        'prepare',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Remove-Item Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE
    $beforePendingInspect = Get-TreeFingerprint -Path $directory
    $pendingUpdate = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($pendingUpdate.status -eq 'transaction-pending') (
        'Inspect must report, not recover, a pending transaction.'
    )
    Assert-Condition (
        (Get-TreeFingerprint -Path $directory) -eq $beforePendingInspect
    ) 'Read-only inspect changed a pending transaction.'
    $recoveredUpdate = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $recoveredUpdate.status -eq 'already-current' -and
        $recoveredUpdate.recoveredTransaction -eq $true -and
        (Get-FileSha256 -Path $addonPath) -eq $sourceHashV3
    ) 'A journaled update was not recovered to the exact staged generation.'

    # Removal moves both verified files to nonce-bound backups before deleting
    # either. Recover from a process death with no public managed name present.
    $env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE =
        'remove:marker-backed-up'
    Invoke-ManagerFault -Arguments @(
        'remove',
        '--directory', $directory,
        '--reshade-module-sha256', $runtimeHash
    )
    Remove-Item Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE
    $pendingRemove = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $directory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($pendingRemove.status -eq 'transaction-pending') (
        'Inspect must expose a pending removal without changing it.'
    )
    $recoveredRemove = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'remove',
        '--directory', $directory,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $recoveredRemove.status -eq 'not-installed' -and
        $recoveredRemove.recoveredTransaction -eq $true -and
        -not (Test-Path -LiteralPath $addonPath) -and
        -not (Test-Path -LiteralPath $markerPath)
    ) 'A journaled removal was not recovered safely.'

    foreach ($entry in $protectedHashes.GetEnumerator()) {
        Assert-Condition ((Get-FileSha256 -Path $entry.Key) -eq $entry.Value) (
            "Recovery changed a protected ReShade/foreign file: $($entry.Key)"
        )
    }
    Assert-Condition (
        -not (Get-ChildItem -LiteralPath $directory -Force |
            Where-Object Name -Like '.electron-game-overlay-addon.*')
    ) 'A completed recovery left transaction artifacts behind.'

    # Prove first-install recovery independently from the update path.
    $installRecoveryDirectory = (
        New-Item -ItemType Directory -Path (Join-Path $sandbox 'install-recovery')
    ).FullName
    $env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE =
        'install:marker-published'
    Invoke-ManagerFault -Arguments @(
        'prepare',
        '--directory', $installRecoveryDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Remove-Item Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE
    $installRecoveryJournal = Join-Path (
        $installRecoveryDirectory
    ) '.electron-game-overlay-addon.transaction.json'
    Assert-Condition (
        Test-Path -LiteralPath $installRecoveryJournal -PathType Leaf
    ) 'The first-install recovery journal is missing.'
    [IO.File]::AppendAllText(
        $installRecoveryJournal,
        '{"phase":"torn-final-append"'
    )
    $env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE =
        'install:addon-published'
    Invoke-ManagerFault -Arguments @(
        'prepare',
        '--directory', $installRecoveryDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Remove-Item Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE
    $recoveredInstall = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $installRecoveryDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $recoveredInstall.status -eq 'already-current' -and
        $recoveredInstall.recoveredTransaction -eq $true
    ) 'A marker-first install with a torn journal append was not recovered.'

    # A verified runtime upgrade does not change add-on ownership or
    # compatibility. The same managed pair remains current without mutation.
    $upgradeDirectory = (
        New-Item -ItemType Directory -Path (Join-Path $sandbox 'runtime-upgrade')
    ).FullName
    $upgradeModule = Join-Path $sandbox 'upgrade-ReShade64.dll'
    New-TestFile -Path $upgradeModule -Text 'official-runtime-before-upgrade'
    $upgradeHashV1 = Get-FileSha256 -Path $upgradeModule
    $upgradeInstall = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $upgradeDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module', $upgradeModule,
        '--reshade-module-sha256', $upgradeHashV1
    )
    Assert-Condition ($upgradeInstall.status -eq 'installed') (
        'Runtime-upgrade fixture installation failed.'
    )
    New-TestFile -Path $upgradeModule -Text 'official-runtime-after-upgrade'
    $upgradeHashV2 = Get-FileSha256 -Path $upgradeModule
    $upgradeTreeBefore = Get-TreeFingerprint -Path $upgradeDirectory
    $upgradeInspect = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $upgradeDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module', $upgradeModule,
        '--reshade-module-sha256', $upgradeHashV2
    )
    Assert-Condition (
        $upgradeInspect.status -eq 'already-current' -and
        $upgradeInspect.restartRequired -eq $false -and
        (Get-TreeFingerprint -Path $upgradeDirectory) -eq $upgradeTreeBefore
    ) 'Inspect did not retain the managed add-on across a runtime upgrade.'
    $upgradePrepare = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $upgradeDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module', $upgradeModule,
        '--reshade-module-sha256', $upgradeHashV2
    )
    Assert-Condition (
        $upgradePrepare.status -eq 'already-current' -and
        $upgradePrepare.recoveredTransaction -eq $false -and
        (Get-TreeFingerprint -Path $upgradeDirectory) -eq $upgradeTreeBefore
    ) 'Prepare did not retain the managed add-on after a runtime upgrade.'
    Assert-Condition (
        (Get-FileSha256 -Path $upgradeModule) -eq $upgradeHashV2 -and
        (Test-Path -LiteralPath (
            Join-Path $upgradeDirectory 'electron_game_overlay.addon64'
        )) -and
        (Test-Path -LiteralPath (
            Join-Path $upgradeDirectory '.electron-game-overlay-addon.json'
        ))
    ) 'A runtime upgrade removed the managed add-on or ownership marker.'

    # Updating the add-on after a runtime upgrade intentionally preserves the
    # ownership marker's installation provenance. Prove that a crash leaves a
    # journal whose marker/runtime hashes differ and that the same upgraded
    # runtime can recover that exact update.
    $upgradeUpdateDirectory = (
        New-Item -ItemType Directory -Path (
            Join-Path $sandbox 'runtime-upgrade-addon-update-recovery'
        )
    ).FullName
    $upgradeUpdateModule = Join-Path $sandbox 'upgrade-update-ReShade64.dll'
    $upgradeUpdateSource = Join-Path $sandbox 'upgrade-update.addon64'
    New-TestFile -Path $upgradeUpdateModule -Text 'upgrade-update-runtime-v1'
    New-TestFile -Path $upgradeUpdateSource -Text 'upgrade-update-addon-v1'
    $upgradeUpdateRuntimeHashV1 = Get-FileSha256 -Path $upgradeUpdateModule
    $upgradeUpdateSourceHashV1 = Get-FileSha256 -Path $upgradeUpdateSource
    $upgradeUpdateInstall = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $upgradeUpdateDirectory,
        '--source', $upgradeUpdateSource,
        '--source-sha256', $upgradeUpdateSourceHashV1,
        '--reshade-module', $upgradeUpdateModule,
        '--reshade-module-sha256', $upgradeUpdateRuntimeHashV1
    )
    Assert-Condition ($upgradeUpdateInstall.status -eq 'installed') (
        'The upgraded-runtime update-recovery fixture could not install.'
    )
    New-TestFile -Path $upgradeUpdateModule -Text 'upgrade-update-runtime-v2'
    New-TestFile -Path $upgradeUpdateSource -Text 'upgrade-update-addon-v2'
    $upgradeUpdateRuntimeHashV2 = Get-FileSha256 -Path $upgradeUpdateModule
    $upgradeUpdateSourceHashV2 = Get-FileSha256 -Path $upgradeUpdateSource
    Assert-Condition (
        $upgradeUpdateRuntimeHashV1 -ne $upgradeUpdateRuntimeHashV2
    ) 'The upgraded-runtime recovery fixture did not change runtime identity.'
    $env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE =
        'update:marker-published'
    Invoke-ManagerFault -Arguments @(
        'prepare',
        '--directory', $upgradeUpdateDirectory,
        '--source', $upgradeUpdateSource,
        '--source-sha256', $upgradeUpdateSourceHashV2,
        '--reshade-module', $upgradeUpdateModule,
        '--reshade-module-sha256', $upgradeUpdateRuntimeHashV2
    )
    Remove-Item Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE
    $upgradeUpdateJournalPath = Join-Path (
        $upgradeUpdateDirectory
    ) '.electron-game-overlay-addon.transaction.json'
    $upgradeUpdateJournalHeader = (
        Get-Content -LiteralPath $upgradeUpdateJournalPath -TotalCount 1
    ) | ConvertFrom-Json
    Assert-Condition (
        $upgradeUpdateJournalHeader.operation -eq 'update' -and
        $upgradeUpdateJournalHeader.reshadeModuleSha256 -eq
            $upgradeUpdateRuntimeHashV1 -and
        $upgradeUpdateJournalHeader.heldReshadeModuleSha256 -eq
            $upgradeUpdateRuntimeHashV2
    ) (
        'The upgraded-runtime update journal did not retain distinct marker ' +
        'provenance and held-runtime hashes.'
    )
    $upgradeUpdatePending = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $upgradeUpdateDirectory,
        '--source', $upgradeUpdateSource,
        '--source-sha256', $upgradeUpdateSourceHashV2,
        '--reshade-module', $upgradeUpdateModule,
        '--reshade-module-sha256', $upgradeUpdateRuntimeHashV2
    )
    Assert-Condition (
        $upgradeUpdatePending.status -eq 'transaction-pending'
    ) (
        'Inspect did not accept the pending upgraded-runtime update journal.'
    )
    $upgradeUpdateRecovered = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $upgradeUpdateDirectory,
        '--source', $upgradeUpdateSource,
        '--source-sha256', $upgradeUpdateSourceHashV2,
        '--reshade-module', $upgradeUpdateModule,
        '--reshade-module-sha256', $upgradeUpdateRuntimeHashV2
    )
    $upgradeUpdateAddonPath = Join-Path (
        $upgradeUpdateDirectory
    ) 'electron_game_overlay.addon64'
    $upgradeUpdateMarkerPath = Join-Path (
        $upgradeUpdateDirectory
    ) '.electron-game-overlay-addon.json'
    $upgradeUpdateMarker = Get-Content -LiteralPath (
        $upgradeUpdateMarkerPath
    ) -Raw | ConvertFrom-Json
    Assert-Condition (
        $upgradeUpdateRecovered.status -eq 'already-current' -and
        $upgradeUpdateRecovered.recoveredTransaction -eq $true -and
        (Get-FileSha256 -Path $upgradeUpdateAddonPath) -eq
            $upgradeUpdateSourceHashV2 -and
        $upgradeUpdateMarker.addonSha256 -eq $upgradeUpdateSourceHashV2 -and
        $upgradeUpdateMarker.reshadeModuleSha256 -eq
            $upgradeUpdateRuntimeHashV1 -and
        (Get-FileSha256 -Path $upgradeUpdateModule) -eq
            $upgradeUpdateRuntimeHashV2 -and
        -not (Test-Path -LiteralPath $upgradeUpdateJournalPath) -and
        -not (Get-ChildItem -LiteralPath $upgradeUpdateDirectory -Force |
            Where-Object Name -Match (
                '^\.electron-game-overlay-addon\.[0-9a-f]{32}\.' +
                '(addon|marker)\.(tmp|bak)$'
            ))
    ) (
        'The crashed add-on update did not recover under the upgraded runtime.'
    )

    # A runtime replacement must never complete a crashed install/update bound
    # to the previous host. Read-only inspection still exposes the valid
    # journal, while remove performs a deletion-only recovery of every exact
    # journaled generation and preserves unrelated installation files.
    $boundRecoveryDirectory = (
        New-Item -ItemType Directory -Path (
            Join-Path $sandbox 'runtime-bound-recovery'
        )
    ).FullName
    $boundRecoveryModule = Join-Path $sandbox 'bound-ReShade64.dll'
    $boundRecoverySource = Join-Path $sandbox 'bound-recovery.addon64'
    $boundRecoveryIni = Join-Path $boundRecoveryDirectory 'ReShade.ini'
    $boundRecoveryForeign = Join-Path (
        $boundRecoveryDirectory
    ) 'third-party.addon64'
    New-TestFile -Path $boundRecoveryModule -Text 'bound-runtime-v1'
    New-TestFile -Path $boundRecoverySource -Text 'bound-addon-v1'
    New-TestFile -Path $boundRecoveryIni -Text '[BOUND-RECOVERY]'
    New-TestFile -Path $boundRecoveryForeign -Text 'foreign-bound-addon'
    $boundRecoveryHashV1 = Get-FileSha256 -Path $boundRecoveryModule
    $boundRecoverySourceHashV1 = Get-FileSha256 -Path $boundRecoverySource
    $boundInstall = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $boundRecoveryDirectory,
        '--source', $boundRecoverySource,
        '--source-sha256', $boundRecoverySourceHashV1,
        '--reshade-module', $boundRecoveryModule,
        '--reshade-module-sha256', $boundRecoveryHashV1
    )
    Assert-Condition ($boundInstall.status -eq 'installed') (
        'The runtime-bound update fixture could not install its first generation.'
    )
    New-TestFile -Path $boundRecoverySource -Text 'bound-addon-v2'
    $boundRecoverySourceHashV2 = Get-FileSha256 -Path $boundRecoverySource
    $env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE =
        'update:marker-published'
    Invoke-ManagerFault -Arguments @(
        'prepare',
        '--directory', $boundRecoveryDirectory,
        '--source', $boundRecoverySource,
        '--source-sha256', $boundRecoverySourceHashV2,
        '--reshade-module', $boundRecoveryModule,
        '--reshade-module-sha256', $boundRecoveryHashV1
    )
    Remove-Item Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE
    New-TestFile -Path $boundRecoveryModule -Text 'bound-runtime-v2'
    $boundRecoveryHashV2 = Get-FileSha256 -Path $boundRecoveryModule
    $boundRecoveryProtectedHashes = @{
        $boundRecoveryModule = $boundRecoveryHashV2
        $boundRecoveryIni = Get-FileSha256 -Path $boundRecoveryIni
        $boundRecoveryForeign = Get-FileSha256 -Path $boundRecoveryForeign
    }
    $boundRecoveryTree = Get-TreeFingerprint -Path $boundRecoveryDirectory
    $wrongRuntimeInspect = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $boundRecoveryDirectory,
        '--source', $boundRecoverySource,
        '--source-sha256', $boundRecoverySourceHashV2,
        '--reshade-module', $boundRecoveryModule,
        '--reshade-module-sha256', $boundRecoveryHashV2
    )
    Assert-Condition (
        $wrongRuntimeInspect.status -eq 'transaction-pending' -and
        $wrongRuntimeInspect.restartRequired -eq $true -and
        (Get-TreeFingerprint -Path $boundRecoveryDirectory) -eq
            $boundRecoveryTree
    ) 'Inspect did not expose a pending transaction after a runtime upgrade.'
    $wrongRuntimeRecovery = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $boundRecoveryDirectory,
        '--source', $boundRecoverySource,
        '--source-sha256', $boundRecoverySourceHashV2,
        '--reshade-module', $boundRecoveryModule,
        '--reshade-module-sha256', $boundRecoveryHashV2
    )
    Assert-Condition (
        $wrongRuntimeRecovery.status -eq 'installed' -and
        $wrongRuntimeRecovery.recoveredTransaction -eq $true -and
        (Get-FileSha256 -Path (
            Join-Path $boundRecoveryDirectory 'electron_game_overlay.addon64'
        )) -eq $boundRecoverySourceHashV2 -and
        -not (Test-Path -LiteralPath (
            Join-Path (
                $boundRecoveryDirectory
            ) '.electron-game-overlay-addon.transaction.json'
        ))
    ) (
        'Preparation did not deletion-recover the interrupted old-runtime ' +
        'transaction and install against the current runtime.'
    )
    foreach ($entry in $boundRecoveryProtectedHashes.GetEnumerator()) {
        Assert-Condition ((Get-FileSha256 -Path $entry.Key) -eq $entry.Value) (
            "Runtime-change recovery modified a protected file: $($entry.Key)"
        )
    }

    # Tampering with one journal-declared generation prevents every cleanup
    # mutation, even after the host runtime changes.
    $tamperedRecoveryDirectory = (
        New-Item -ItemType Directory -Path (
            Join-Path $sandbox 'runtime-bound-recovery-tampered'
        )
    ).FullName
    $tamperedRecoveryModule = Join-Path $sandbox 'tampered-ReShade64.dll'
    $tamperedRecoverySource = Join-Path $sandbox 'tampered-recovery.addon64'
    New-TestFile -Path $tamperedRecoveryModule -Text 'tampered-runtime-v1'
    New-TestFile -Path $tamperedRecoverySource -Text 'tampered-addon-v1'
    $tamperedRuntimeHashV1 = Get-FileSha256 -Path $tamperedRecoveryModule
    $tamperedSourceHashV1 = Get-FileSha256 -Path $tamperedRecoverySource
    $tamperedInstall = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $tamperedRecoveryDirectory,
        '--source', $tamperedRecoverySource,
        '--source-sha256', $tamperedSourceHashV1,
        '--reshade-module', $tamperedRecoveryModule,
        '--reshade-module-sha256', $tamperedRuntimeHashV1
    )
    Assert-Condition ($tamperedInstall.status -eq 'installed') (
        'The tampered runtime-bound fixture could not install.'
    )
    New-TestFile -Path $tamperedRecoverySource -Text 'tampered-addon-v2'
    $tamperedSourceHashV2 = Get-FileSha256 -Path $tamperedRecoverySource
    $env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE =
        'update:marker-published'
    Invoke-ManagerFault -Arguments @(
        'prepare',
        '--directory', $tamperedRecoveryDirectory,
        '--source', $tamperedRecoverySource,
        '--source-sha256', $tamperedSourceHashV2,
        '--reshade-module', $tamperedRecoveryModule,
        '--reshade-module-sha256', $tamperedRuntimeHashV1
    )
    Remove-Item Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE
    $tamperedJournalPath = Join-Path (
        $tamperedRecoveryDirectory
    ) '.electron-game-overlay-addon.transaction.json'
    $tamperedJournalHeader = (
        Get-Content -LiteralPath $tamperedJournalPath -TotalCount 1
    ) | ConvertFrom-Json
    $tamperedBackupPath = Join-Path (
        $tamperedRecoveryDirectory
    ) ([string]$tamperedJournalHeader.addonBackupName)
    New-TestFile -Path $tamperedBackupPath -Text 'foreign-tampered-backup'
    New-TestFile -Path $tamperedRecoveryModule -Text 'tampered-runtime-v2'
    $tamperedRuntimeHashV2 = Get-FileSha256 -Path $tamperedRecoveryModule
    $tamperedRecoveryTree = Get-TreeFingerprint -Path (
        $tamperedRecoveryDirectory
    )
    $tamperedCleanup = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'remove',
        '--directory', $tamperedRecoveryDirectory,
        '--reshade-module', $tamperedRecoveryModule,
        '--reshade-module-sha256', $tamperedRuntimeHashV2
    )
    Assert-Condition (
        $tamperedCleanup.status -eq 'error' -and
        $tamperedCleanup.code -eq 'transaction-invalid' -and
        (Get-TreeFingerprint -Path $tamperedRecoveryDirectory) -eq
            $tamperedRecoveryTree -and
        (Get-FileSha256 -Path $tamperedRecoveryModule) -eq
            $tamperedRuntimeHashV2
    ) 'Runtime-change cleanup mutated a tampered journal generation.'

    # Exercise the actual Windows image-section behavior instead of assuming
    # whether a loaded add-on can be replaced. The manager must either finish
    # the update atomically or leave a recoverable journal until the image is
    # unloaded.
    if (-not ('EgoManagerNativeLibrary' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class EgoManagerNativeLibrary
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadLibraryW(string path);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FreeLibrary(IntPtr module);
}
'@
    }
    $mappedDirectory = (
        New-Item -ItemType Directory -Path (Join-Path $sandbox 'mapped-addon')
    ).FullName
    $mappedSourceV1 = Join-Path $env:SystemRoot 'System32\version.dll'
    $mappedSourceV2 = Join-Path $env:SystemRoot 'System32\winmm.dll'
    Assert-Condition (
        (Test-Path -LiteralPath $mappedSourceV1 -PathType Leaf) -and
        (Test-Path -LiteralPath $mappedSourceV2 -PathType Leaf)
    ) 'The mapped-image gate requires the version.dll and winmm.dll fixtures.'
    $mappedHashV1 = Get-FileSha256 -Path $mappedSourceV1
    $mappedHashV2 = Get-FileSha256 -Path $mappedSourceV2
    Assert-Condition ($mappedHashV1 -ne $mappedHashV2) (
        'The mapped-image fixtures unexpectedly have the same hash.'
    )
    $mappedInstall = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $mappedDirectory,
        '--source', $mappedSourceV1,
        '--source-sha256', $mappedHashV1,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($mappedInstall.status -eq 'installed') (
        'Mapped-image fixture installation failed.'
    )
    $mappedAddonPath = Join-Path (
        $mappedDirectory
    ) 'electron_game_overlay.addon64'
    $mappedHandle = [EgoManagerNativeLibrary]::LoadLibraryW($mappedAddonPath)
    if ($mappedHandle -eq [IntPtr]::Zero) {
        $loadError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "LoadLibraryW failed for the managed add-on: $loadError"
    }
    $mappedFirstExit = $null
    $mappedFirstResult = $null
    $mappedPending = $false
    try {
        $mappedAttempt = Invoke-ManagerAnyExit -Arguments @(
            'prepare',
            '--directory', $mappedDirectory,
            '--source', $mappedSourceV2,
            '--source-sha256', $mappedHashV2,
            '--reshade-module-sha256', $runtimeHash
        )
        $mappedFirstExit = $mappedAttempt.ExitCode
        $mappedFirstResult = $mappedAttempt.Result
        if ($mappedFirstExit -eq 0) {
            Assert-Condition ($mappedFirstResult.status -eq 'updated') (
                'A successful mapped add-on update had an invalid status.'
            )
        } else {
            Assert-Condition (
                ($mappedFirstExit -eq 4 -or $mappedFirstExit -eq 5) -and
                $mappedFirstResult.status -eq 'error' -and
                (
                    $mappedFirstResult.code -eq 'write-race' -or
                    $mappedFirstResult.code -eq 'io-failed'
                )
            ) (
                'A blocked mapped add-on update did not fail as a typed ' +
                'transaction or I/O result.'
            )
            $mappedInspect = Invoke-Manager -ExpectedExit 0 -Arguments @(
                'inspect',
                '--directory', $mappedDirectory,
                '--source', $mappedSourceV2,
                '--source-sha256', $mappedHashV2,
                '--reshade-module-sha256', $runtimeHash
            )
            Assert-Condition (
                $mappedInspect.status -eq 'transaction-pending' -and
                $mappedInspect.restartRequired -eq $true
            ) 'A blocked mapped add-on update did not leave a durable journal.'
            $mappedPending = $true
        }
    } finally {
        $freed = [EgoManagerNativeLibrary]::FreeLibrary($mappedHandle)
        if (-not $freed) {
            $freeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "FreeLibrary failed for the managed add-on: $freeError"
        }
    }
    $mappedRecovered = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $mappedDirectory,
        '--source', $mappedSourceV2,
        '--source-sha256', $mappedHashV2,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $mappedRecovered.status -eq 'already-current' -and
        $mappedRecovered.recoveredTransaction -eq $mappedPending -and
        (Get-FileSha256 -Path $mappedAddonPath) -eq $mappedHashV2 -and
        -not (Get-ChildItem -LiteralPath $mappedDirectory -Force |
            Where-Object {
                $_.Name -eq (
                    '.electron-game-overlay-addon.transaction.json'
                ) -or $_.Name -match (
                    '^\.electron-game-overlay-addon\.[0-9a-f]{32}\.' +
                    '(addon|marker)\.(tmp|bak)$'
                )
            })
    ) 'The mapped add-on update did not converge cleanly after unload.'
    $mappedUpdateOutcome = if ($mappedPending) {
        "deferred-after-unload:$mappedFirstExit/$($mappedFirstResult.code)"
    } else {
        'completed-while-loaded'
    }
    Write-Host "Mapped add-on update outcome: $mappedUpdateOutcome"

    # A reserved journal name with no exact owned schema is a foreign
    # collision, not a recoverable transaction. Every operation preserves it.
    $foreignJournalDirectory = (
        New-Item -ItemType Directory -Path (
            Join-Path $sandbox 'foreign-journal'
        )
    ).FullName
    New-TestFile -Path (
        Join-Path $foreignJournalDirectory (
            '.electron-game-overlay-addon.transaction.json'
        )
    ) -Text 'foreign-not-a-transaction-journal'
    $foreignJournalBefore = Get-TreeFingerprint -Path $foreignJournalDirectory
    $foreignJournalInspect = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $foreignJournalDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $foreignJournalInspect.status -eq 'foreign-collision' -and
        (Get-TreeFingerprint -Path $foreignJournalDirectory) -eq
            $foreignJournalBefore
    ) 'Inspect misclassified or changed a foreign reserved journal.'
    $foreignJournalPrepare = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'prepare',
        '--directory', $foreignJournalDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $foreignJournalPrepare.status -eq 'error' -and
        $foreignJournalPrepare.code -eq 'transaction-invalid' -and
        (Get-TreeFingerprint -Path $foreignJournalDirectory) -eq
            $foreignJournalBefore
    ) 'Prepare changed a foreign reserved journal.'
    $foreignJournalRemove = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'remove',
        '--directory', $foreignJournalDirectory,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $foreignJournalRemove.status -eq 'error' -and
        $foreignJournalRemove.code -eq 'transaction-invalid' -and
        (Get-TreeFingerprint -Path $foreignJournalDirectory) -eq
            $foreignJournalBefore
    ) 'Remove changed a foreign reserved journal.'

    # A reserved foreign file is a classification, never an invitation to
    # create the matching marker or to touch neighboring ReShade files.
    $foreignDirectory = (
        New-Item -ItemType Directory -Path (Join-Path $sandbox 'foreign')
    ).FullName
    New-TestFile -Path (Join-Path $foreignDirectory 'dxgi.dll') `
        -Text 'official-runtime-foreign-case'
    New-TestFile -Path (Join-Path $foreignDirectory 'ReShade.ini') `
        -Text '[GENERAL]'
    New-TestFile -Path (Join-Path $foreignDirectory 'third-party.addon64') `
        -Text 'third-party-foreign-case'
    New-TestFile -Path (
        Join-Path $foreignDirectory 'electron_game_overlay.addon64'
    ) -Text 'unowned-reserved-file'
    $foreignBefore = Get-TreeFingerprint -Path $foreignDirectory
    $foreignInspect = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $foreignDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($foreignInspect.status -eq 'foreign-collision') (
        'Inspect did not classify an unowned reserved file.'
    )
    $foreignPrepare = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'prepare',
        '--directory', $foreignDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $foreignPrepare.status -eq 'error' -and
        $foreignPrepare.code -eq 'foreign-addon-collision'
    ) 'Prepare did not fail closed on a foreign collision.'
    $foreignRemove = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'remove',
        '--directory', $foreignDirectory,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $foreignRemove.status -eq 'error' -and
        $foreignRemove.code -eq 'foreign-addon-collision'
    ) 'Remove did not fail closed on a foreign collision.'
    Assert-Condition (
        (Get-TreeFingerprint -Path $foreignDirectory) -eq $foreignBefore
    ) 'A negative foreign-collision case changed installation bytes.'

    # A hard-linked reserved name has a second identity alias and therefore
    # cannot become an exclusively owned managed artifact.
    $hardlinkDirectory = (
        New-Item -ItemType Directory -Path (Join-Path $sandbox 'hardlink')
    ).FullName
    $hardlinkOrigin = Join-Path $hardlinkDirectory 'foreign-origin.bin'
    New-TestFile -Path $hardlinkOrigin -Text 'hard-linked-foreign-bytes'
    New-Item -ItemType HardLink `
        -Path (Join-Path $hardlinkDirectory 'electron_game_overlay.addon64') `
        -Target $hardlinkOrigin | Out-Null
    $hardlinkBefore = Get-TreeFingerprint -Path $hardlinkDirectory
    $hardlinkInspect = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $hardlinkDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($hardlinkInspect.status -eq 'foreign-collision') (
        'Inspect did not classify a hard-linked reserved path as foreign.'
    )
    $hardlinkPrepare = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'prepare',
        '--directory', $hardlinkDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $hardlinkPrepare.status -eq 'error' -and
        $hardlinkPrepare.code -eq 'path-identity-invalid'
    ) 'Prepare did not fail closed on a hard-linked reserved path.'
    Assert-Condition (
        (Get-TreeFingerprint -Path $hardlinkDirectory) -eq $hardlinkBefore
    ) 'Hard-link rejection changed foreign bytes.'

    # A formerly owned add-on whose bytes no longer match its marker is
    # reported explicitly and preserved byte-for-byte.
    $tamperedDirectory = (
        New-Item -ItemType Directory -Path (Join-Path $sandbox 'tampered')
    ).FullName
    $tamperedInstall = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'prepare',
        '--directory', $tamperedDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($tamperedInstall.status -eq 'installed') (
        'Tamper fixture installation failed.'
    )
    New-TestFile -Path (
        Join-Path $tamperedDirectory 'electron_game_overlay.addon64'
    ) -Text 'externally-replaced-after-install'
    $tamperedBefore = Get-TreeFingerprint -Path $tamperedDirectory
    $tamperedInspect = Invoke-Manager -ExpectedExit 0 -Arguments @(
        'inspect',
        '--directory', $tamperedDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition ($tamperedInspect.status -eq 'owned-tampered') (
        'Inspect did not classify owned add-on tampering.'
    )
    $tamperedPrepare = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'prepare',
        '--directory', $tamperedDirectory,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $tamperedPrepare.status -eq 'error' -and
        $tamperedPrepare.code -eq 'owned-addon-tampered'
    ) 'Prepare did not preserve a tampered owned add-on.'
    $tamperedRemove = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'remove',
        '--directory', $tamperedDirectory,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $tamperedRemove.status -eq 'error' -and
        $tamperedRemove.code -eq 'owned-addon-tampered'
    ) 'Remove did not preserve a tampered owned add-on.'
    Assert-Condition (
        (Get-TreeFingerprint -Path $tamperedDirectory) -eq $tamperedBefore
    ) 'A negative tamper case changed installation bytes.'

    # The directory handle must resolve to the exact requested non-reparse
    # path. A junction is rejected before any reserved child is opened.
    $junctionTarget = (
        New-Item -ItemType Directory -Path (Join-Path $sandbox 'junction-target')
    ).FullName
    New-TestFile -Path (Join-Path $junctionTarget 'dxgi.dll') `
        -Text 'junction-protected-runtime'
    New-TestFile -Path (Join-Path $junctionTarget 'ReShade.ini') `
        -Text '[JUNCTION]'
    $junctionPath = Join-Path $sandbox 'junction-install'
    New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget |
        Out-Null
    $junctionBefore = Get-TreeFingerprint -Path $junctionTarget
    $junctionResult = Invoke-Manager -ExpectedExit 3 -Arguments @(
        'inspect',
        '--directory', $junctionPath,
        '--source', $source,
        '--source-sha256', $sourceHashV3,
        '--reshade-module-sha256', $runtimeHash
    )
    Assert-Condition (
        $junctionResult.status -eq 'error' -and
        $junctionResult.code -eq 'path-reparse-point'
    ) 'A reparse directory was not rejected.'
    Assert-Condition (
        (Get-TreeFingerprint -Path $junctionTarget) -eq $junctionBefore
    ) 'Reparse rejection changed target bytes.'

    Write-Host (
        'ReShade add-on manager gate passed: x64 /W4 /WX compile, ' +
        'read-only inspection, install/update/remove, journal recovery, ' +
        'runtime upgrades, mapped-image recovery, foreign/tamper ' +
        'preservation, and reparse rejection.'
    )
    $gatePassed = $true
} finally {
    Remove-Item Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE `
        -ErrorAction SilentlyContinue
    Remove-Item (
        'Env:ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_' +
        'FAIL_UNCOMMITTED_STAGE'
    ) -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $sandbox) {
        Remove-Item -LiteralPath $sandbox -Recurse -Force
    }
}

if ($gatePassed) {
    $global:LASTEXITCODE = 0
}
