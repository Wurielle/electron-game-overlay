[CmdletBinding()]
param(
    [string]$InjectorPath,
    [string]$ReShadePath,
    [string]$HostPath
)

$ErrorActionPreference = "Stop"

function Start-ControlledProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [hashtable]$Environment = @{}
    )

    foreach ($Argument in $Arguments) {
        if ($Argument -match '\s') {
            throw "The controlled preflight gate requires whitespace-free arguments: $Argument"
        }
    }

    $StartInfo = New-Object Diagnostics.ProcessStartInfo
    $StartInfo.FileName = $FilePath
    $StartInfo.Arguments = $Arguments -join " "
    $StartInfo.WorkingDirectory = Split-Path -Parent $FilePath
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true
    foreach ($Entry in $Environment.GetEnumerator()) {
        $StartInfo.EnvironmentVariables[[string]$Entry.Key] = [string]$Entry.Value
    }

    $Process = New-Object Diagnostics.Process
    $Process.StartInfo = $StartInfo
    if (-not $Process.Start()) {
        $Process.Dispose()
        throw "Unable to start the controlled process: $FilePath"
    }
    return $Process
}

function Stop-ControlledProcess([Diagnostics.Process]$Process) {
    if ($null -eq $Process) {
        return
    }

    try {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            $Process.Kill()
            $Process.WaitForExit()
        }
    }
    finally {
        $Process.Dispose()
    }
}

function Get-FileSnapshot([string[]]$Paths) {
    $Snapshot = [ordered]@{}
    foreach ($Path in $Paths) {
        $Item = Get-Item -LiteralPath $Path -Force
        $Snapshot[$Item.FullName] = [pscustomobject]@{
            Length = $Item.Length
            Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Item.FullName).Hash
        }
    }
    return $Snapshot
}

function Copy-IncompatibleRuntimeFixture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    $Bytes = [IO.File]::ReadAllBytes($Source)
    $HostAbiExport = "ElectronGameOverlayReShadeHostAbi"
    $BinaryText = [Text.Encoding]::ASCII.GetString($Bytes)
    $Matches = @()
    $SearchFrom = 0
    while ($SearchFrom -lt $BinaryText.Length) {
        $Match = $BinaryText.IndexOf(
            $HostAbiExport,
            $SearchFrom,
            [StringComparison]::Ordinal
        )
        if ($Match -lt 0) {
            break
        }
        $AfterMatch = $Match + $HostAbiExport.Length
        if ($AfterMatch -lt $Bytes.Length -and
            $Bytes[$AfterMatch] -eq 0) {
            $Matches += $Match
        }
        $SearchFrom = $Match + 1
    }

    if ($Matches.Count -gt 1) {
        throw (
            "The controlled ReShade fixture contains multiple private host " +
            "ABI export-name candidates."
        )
    }
    if ($Matches.Count -eq 1) {
        # The default runtime is this project's compatible private host. Make
        # only the temporary copy incompatible by changing the final export
        # character from 'i' to 'j'. This retains export-table ordering and all
        # proxy behavior, while making the injector's exact ABI lookup miss.
        $FinalCharacter = $Matches[0] + $HostAbiExport.Length - 1
        if ($Bytes[$FinalCharacter] -ne [byte][char]'i') {
            throw "The private host ABI export fixture has unexpected bytes."
        }
        $Bytes[$FinalCharacter] = [byte][char]'j'
    }
    [IO.File]::WriteAllBytes($Destination, $Bytes)
}

function Assert-FileSnapshotUnchanged(
    [Collections.IDictionary]$Before
) {
    foreach ($Entry in $Before.GetEnumerator()) {
        if (-not (Test-Path -LiteralPath $Entry.Key -PathType Leaf)) {
            throw "A preservation fixture was removed: $($Entry.Key)"
        }
        $Item = Get-Item -LiteralPath $Entry.Key -Force
        $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Entry.Key).Hash
        if ($Item.Length -ne $Entry.Value.Length -or
            $Hash -ne $Entry.Value.Sha256) {
            throw "A preservation fixture changed: $($Entry.Key)"
        }
    }
}

function Assert-ModuleNotLoaded {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)]
        [string]$ModulePath
    )

    $Target.Refresh()
    if ($Target.HasExited) {
        throw "The target exited before its loaded modules could be checked."
    }
    foreach ($Module in $Target.Modules) {
        if ([IO.Path]::GetFullPath($Module.FileName).Equals(
                $ModulePath,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "The injector loaded a preservation fixture: $ModulePath"
        }
    }
}

function Wait-ModuleLoaded {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)]
        [string]$ModulePath
    )

    $Deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $Deadline) {
        $Target.Refresh()
        if ($Target.HasExited) {
            throw "The target exited before loading the controlled runtime."
        }
        foreach ($Module in $Target.Modules) {
            if ([IO.Path]::GetFullPath($Module.FileName).Equals(
                    $ModulePath,
                    [StringComparison]::OrdinalIgnoreCase)) {
                return
            }
        }
        Start-Sleep -Milliseconds 25
    }
    throw "The target did not load the controlled runtime: $ModulePath"
}

function Assert-PreflightRefusal {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Injector,
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Target,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedCode,
        [string]$ExpectedEvidencePath,
        [Parameter(Mandatory = $true)]
        [int]$ExpectedExitCode,
        [string]$ExpectedReShadeBasePath,
        [string]$ExpectedAddonDirectoryPath,
        [bool]$ExpectedAddonDisabled = $false,
        [switch]$ExpectWindowsError
    )

    $StdoutTask = $Injector.StandardOutput.ReadToEndAsync()
    $StderrTask = $Injector.StandardError.ReadToEndAsync()
    if (-not $Injector.WaitForExit(10000)) {
        throw "The injector did not finish its global/BasePath preflight."
    }
    $Injector.WaitForExit()
    if (-not $StdoutTask.Wait(1000) -or -not $StderrTask.Wait(1000)) {
        throw "The injector output streams did not close."
    }
    if ($Injector.ExitCode -ne $ExpectedExitCode) {
        throw (
            "The injector returned $($Injector.ExitCode), expected " +
            "$ExpectedExitCode.`nstdout:`n$($StdoutTask.Result)`nstderr:`n$($StderrTask.Result)"
        )
    }
    if (-not [string]::IsNullOrEmpty($StderrTask.Result)) {
        throw "The injector wrote unexpected stderr: $($StderrTask.Result)"
    }

    $Lines = @(
        $StdoutTask.Result -split '\r?\n' |
            Where-Object { $_ -ne "" }
    )
    $Prefix = "ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC "
    $DiagnosticLines = @(
        $Lines | Where-Object { $_.StartsWith($Prefix) }
    )
    if ($DiagnosticLines.Count -ne 1) {
        throw "Expected one structured preflight diagnostic, got $($DiagnosticLines.Count)."
    }
    try {
        $Diagnostic = $DiagnosticLines[0].Substring(
            $Prefix.Length
        ) | ConvertFrom-Json
    }
    catch {
        throw "The injector diagnostic is not valid JSON: $($DiagnosticLines[0])"
    }

    $ExpectedProperties = @(
        "code",
        "injectionStarted",
        "pid",
        "schemaVersion",
        "stage",
        "targetExecutablePath"
    )
    $ExpectModulePath = -not [string]::IsNullOrEmpty(
        $ExpectedEvidencePath
    )
    if ($ExpectModulePath) {
        $ExpectedProperties += "modulePath"
    }
    $ExpectEffectiveSettings = -not [string]::IsNullOrEmpty(
        $ExpectedReShadeBasePath
    )
    if ($ExpectEffectiveSettings) {
        if ([string]::IsNullOrEmpty($ExpectedAddonDirectoryPath)) {
            throw "An expected ReShade base path requires an add-on directory path."
        }
        $ExpectedProperties += @(
            "addonDirectoryPath",
            "electronGameOverlayAddonDisabled",
            "reshadeBasePath"
        )
    }
    if ($ExpectWindowsError) {
        $ExpectedProperties += "windowsErrorCode"
    }
    $ActualProperties = @(
        $Diagnostic.PSObject.Properties.Name |
            Sort-Object
    )
    if (($ActualProperties -join ",") -cne
        (($ExpectedProperties | Sort-Object) -join ",")) {
        throw "The preflight diagnostic schema was not exact: $($ActualProperties -join ',')"
    }
    if ($Diagnostic.schemaVersion -ne 1 -or
        $Diagnostic.stage -ne "target-preflight" -or
        $Diagnostic.code -ne $ExpectedCode -or
        $Diagnostic.pid -ne $Target.Id -or
        $Diagnostic.injectionStarted -ne $false -or
        -not ([string]$Diagnostic.targetExecutablePath).Equals(
            [IO.Path]::GetFullPath($Target.MainModule.FileName),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The preflight diagnostic had unexpected fields: $($DiagnosticLines[0])"
    }
    if ($ExpectModulePath -and
        -not ([string]$Diagnostic.modulePath).Equals(
            $ExpectedEvidencePath,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "The preflight diagnostic had unexpected module evidence: $($DiagnosticLines[0])"
    }
    if ($ExpectEffectiveSettings -and (
            -not ([string]$Diagnostic.reshadeBasePath).Equals(
                [IO.Path]::GetFullPath($ExpectedReShadeBasePath),
                [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$Diagnostic.addonDirectoryPath).Equals(
                [IO.Path]::GetFullPath($ExpectedAddonDirectoryPath),
                [StringComparison]::OrdinalIgnoreCase) -or
            [bool]$Diagnostic.electronGameOverlayAddonDisabled -ne
                $ExpectedAddonDisabled)) {
        throw "The preflight diagnostic had unexpected effective ReShade settings: $($DiagnosticLines[0])"
    }
    if ($ExpectWindowsError) {
        if ([int64]$Diagnostic.windowsErrorCode -le 0) {
            throw "The fail-closed diagnostic omitted its Windows error: $($DiagnosticLines[0])"
        }
    }
    elseif ($null -ne $Diagnostic.windowsErrorCode) {
        throw "The preservation diagnostic included an unexpected Windows error: $($DiagnosticLines[0])"
    }

    if ($Lines -notcontains "ReShade injection not started.") {
        throw "The injector omitted its conservative not-started marker."
    }
    if (($Lines -join "`n") -match "Injecting ReShade") {
        throw "The injector entered the payload-loading path after refusing injection."
    }
    if (@($Lines | Where-Object {
                $_.StartsWith("ELECTRON_GAME_OVERLAY_INJECTOR_RESULT ")
            }).Count -ne 0) {
        throw "The injector published a success result after refusing injection."
    }

    $Target.Refresh()
    if ($Target.HasExited) {
        throw "The target exited during the preservation preflight."
    }
}

function New-PingTarget {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CaseRoot,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $TargetPath = Join-Path $CaseRoot $Name
    Copy-Item -LiteralPath "$env:WINDIR\System32\ping.exe" -Destination $TargetPath
    return [IO.Path]::GetFullPath($TargetPath)
}

function Start-PingTarget {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetPath,
        [hashtable]$Environment = @{}
    )

    return Start-ControlledProcess `
        -FilePath $TargetPath `
        -Arguments @("127.0.0.1", "-n", "30") `
        -Environment $Environment
}

function Start-ExactPidInjector {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Injector,
        [Parameter(Mandatory = $true)]
        [string]$TargetPath,
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Target,
        [hashtable]$Environment = @{}
    )

    return Start-ControlledProcess `
        -FilePath $Injector `
        -Arguments @(
            [IO.Path]::GetFileName($TargetPath),
            "--pid",
            [string]$Target.Id
        ) `
        -Environment $Environment
}

function Invoke-GlobalLayerCase {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("Vulkan", "OpenXR")]
        [string]$Kind,
        [Parameter(Mandatory = $true)]
        [ValidateSet("ExactPid", "PathWatcher")]
        [string]$Lane,
        [Parameter(Mandatory = $true)]
        [string]$GateRoot,
        [Parameter(Mandatory = $true)]
        [string]$RegistryRoot,
        [Parameter(Mandatory = $true)]
        [string]$Injector,
        [Parameter(Mandatory = $true)]
        [string]$ReShade
    )

    $CaseRoot = Join-Path $GateRoot $Kind.ToLowerInvariant()
    $InstallationRoot = Join-Path $CaseRoot "GlobalReShade"
    New-Item -ItemType Directory -Path $InstallationRoot -Force | Out-Null
    $TargetPath = New-PingTarget `
        -CaseRoot $CaseRoot `
        -Name ("global-$($Kind.ToLowerInvariant())-fixture.exe")
    $ModulePath = [IO.Path]::GetFullPath(
        (Join-Path $InstallationRoot "ReShade64.dll")
    )
    Copy-Item -LiteralPath $ReShade -Destination $ModulePath

    $ManifestName = if ($Kind -eq "Vulkan") {
        "ReShade64.json"
    }
    else {
        "ReShade64_XR.json"
    }
    $ManifestPath = [IO.Path]::GetFullPath(
        (Join-Path $InstallationRoot $ManifestName)
    )
    $Manifest = if ($Kind -eq "Vulkan") {
        @'
{
    "file_format_version": "1.0.0",
    "layer": {
        "name": "VK_LAYER_reshade",
        "type": "GLOBAL",
        "library_path": ".\\ReShade64.dll",
        "api_version": "1.3.268",
        "implementation_version": "1",
        "description": "controlled ReShade global layer fixture"
    }
}
'@
    }
    else {
        @'
{
    "file_format_version": "1.0.0",
    "api_layer": {
        "name": "XR_APILAYER_reshade",
        "library_path": ".\\ReShade64.dll",
        "api_version": "1.0",
        "implementation_version": "2",
        "description": "controlled ReShade global layer fixture"
    }
}
'@
    }
    Set-Content -LiteralPath $ManifestPath -Value $Manifest -Encoding UTF8
    $AppsPath = Join-Path $InstallationRoot "ReShadeApps.ini"
    Set-Content -LiteralPath $AppsPath -Value "Apps=$TargetPath" -Encoding UTF8

    $RegistryRelativePath = if ($Kind -eq "Vulkan") {
        "$RegistryRoot\Vulkan\ImplicitLayers"
    }
    else {
        "$RegistryRoot\OpenXR\1\ApiLayers\Implicit"
    }
    $RegistryProviderPath = "Registry::HKEY_CURRENT_USER\$RegistryRelativePath"
    New-Item -Path $RegistryProviderPath -Force | Out-Null
    New-ItemProperty `
        -Path $RegistryProviderPath `
        -Name $ManifestPath `
        -PropertyType DWord `
        -Value 0 `
        -Force | Out-Null

    $FilesBefore = Get-FileSnapshot @(
        $TargetPath,
        $ModulePath,
        $ManifestPath,
        $AppsPath
    )
    $Target = $null
    $InjectorProcess = $null
    try {
        if ($Lane -eq "PathWatcher") {
            $InjectorProcess = Start-ControlledProcess `
                -FilePath $Injector `
                -Arguments @(
                    "--path-contains",
                    [IO.Path]::GetFileName($GateRoot)
                ) `
                -Environment @{
                    ELECTRON_GAME_OVERLAY_TEST_LAYER_REGISTRY_ROOT = $RegistryRoot
                }
            $ReadyTask = $InjectorProcess.StandardOutput.ReadLineAsync()
            if (-not $ReadyTask.Wait(10000) -or
                $ReadyTask.Result -ne "ReShade path watcher armed.") {
                throw "The global-layer path watcher did not arm."
            }
            $Target = Start-PingTarget $TargetPath
        }
        else {
            $Target = Start-PingTarget $TargetPath
        }
        Assert-ModuleNotLoaded -Target $Target -ModulePath $ModulePath
        if ($Lane -eq "ExactPid") {
            $InjectorProcess = Start-ExactPidInjector `
                -Injector $Injector `
                -TargetPath $TargetPath `
                -Target $Target `
                -Environment @{
                    ELECTRON_GAME_OVERLAY_TEST_LAYER_REGISTRY_ROOT = $RegistryRoot
                }
        }
        Assert-PreflightRefusal `
            -Injector $InjectorProcess `
            -Target $Target `
            -ExpectedCode "target-existing-reshade-global-layer" `
            -ExpectedEvidencePath $ModulePath `
            -ExpectedExitCode 183 `
            -ExpectedReShadeBasePath $CaseRoot `
            -ExpectedAddonDirectoryPath $CaseRoot
        Assert-ModuleNotLoaded -Target $Target -ModulePath $ModulePath
        Assert-FileSnapshotUnchanged $FilesBefore

        $Key = Get-Item -Path $RegistryProviderPath
        $ValueNames = @($Key.GetValueNames())
        if ($ValueNames.Count -ne 1 -or
            $ValueNames[0] -cne $ManifestPath -or
            $Key.GetValueKind($ManifestPath) -ne
                [Microsoft.Win32.RegistryValueKind]::DWord -or
            [int]$Key.GetValue($ManifestPath) -ne 0) {
            throw "The controlled $Kind registration changed during preflight."
        }
        if (Test-Path -LiteralPath (Join-Path $CaseRoot "ReShade.ini")) {
            throw "The global-layer preflight created a target configuration."
        }
    }
    finally {
        Stop-ControlledProcess $InjectorProcess
        Stop-ControlledProcess $Target
    }
}

function Invoke-BasePathCase {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GateRoot,
        [Parameter(Mandatory = $true)]
        [string]$Injector,
        [Parameter(Mandatory = $true)]
        [string]$ReShade
    )

    $CaseRoot = Join-Path $GateRoot "base-path"
    $BasePath = Join-Path $CaseRoot "render,bin"
    $AddonRoot = Join-Path $BasePath "addons"
    $IgnoredBasePath = Join-Path $CaseRoot "ignored-list-element"
    $DuplicateBasePath = Join-Path $CaseRoot "ignored-duplicate-key"
    New-Item `
        -ItemType Directory `
        -Path $BasePath, $AddonRoot, $IgnoredBasePath, $DuplicateBasePath `
        -Force | Out-Null
    $TargetPath = New-PingTarget -CaseRoot $CaseRoot -Name "base-path-fixture.exe"
    $CandidatePath = [IO.Path]::GetFullPath(
        (Join-Path $BasePath "dxgi.dll")
    )
    Copy-Item -LiteralPath $ReShade -Destination $CandidatePath
    $IgnoredCandidatePath = [IO.Path]::GetFullPath(
        (Join-Path $IgnoredBasePath "dxgi.dll")
    )
    $DuplicateCandidatePath = [IO.Path]::GetFullPath(
        (Join-Path $DuplicateBasePath "dxgi.dll")
    )
    Copy-Item -LiteralPath $ReShade -Destination $IgnoredCandidatePath
    Copy-Item -LiteralPath $ReShade -Destination $DuplicateCandidatePath
    $ConfigPath = Join-Path $CaseRoot "ReShade.ini"
    $EncodedBasePath = [IO.Path]::GetFullPath($BasePath).Replace(",", ",,")
    Set-Content `
        -LiteralPath $ConfigPath `
        -Value (
            "[INSTALL]`r`n" +
            "BasePath=$EncodedBasePath,$([IO.Path]::GetFullPath($IgnoredBasePath))`r`n" +
            "BasePath=$([IO.Path]::GetFullPath($DuplicateBasePath))`r`n"
        ) `
        -Encoding UTF8
    $EffectiveConfigPath = [IO.Path]::GetFullPath(
        (Join-Path $BasePath "ReShade.ini")
    )
    Set-Content `
        -LiteralPath $EffectiveConfigPath `
        -Value (
            "[ADDON]`r`n" +
            "AddonPath=addons`r`n" +
            "DisabledAddons=Electron Game Overlay Runtime`r`n"
        ) `
        -Encoding UTF8
    $FilesBefore = Get-FileSnapshot @(
        $TargetPath,
        $CandidatePath,
        $IgnoredCandidatePath,
        $DuplicateCandidatePath,
        $ConfigPath,
        $EffectiveConfigPath
    )

    $Target = $null
    $InjectorProcess = $null
    try {
        $Target = Start-PingTarget $TargetPath
        Assert-ModuleNotLoaded -Target $Target -ModulePath $CandidatePath
        Assert-ModuleNotLoaded -Target $Target -ModulePath $IgnoredCandidatePath
        Assert-ModuleNotLoaded -Target $Target -ModulePath $DuplicateCandidatePath
        $InjectorProcess = Start-ExactPidInjector `
            -Injector $Injector `
            -TargetPath $TargetPath `
            -Target $Target
        Assert-PreflightRefusal `
            -Injector $InjectorProcess `
            -Target $Target `
            -ExpectedCode "target-existing-reshade-installation" `
            -ExpectedEvidencePath $CandidatePath `
            -ExpectedExitCode 183 `
            -ExpectedReShadeBasePath $BasePath `
            -ExpectedAddonDirectoryPath $AddonRoot `
            -ExpectedAddonDisabled $true
        Assert-ModuleNotLoaded -Target $Target -ModulePath $CandidatePath
        Assert-ModuleNotLoaded -Target $Target -ModulePath $IgnoredCandidatePath
        Assert-ModuleNotLoaded -Target $Target -ModulePath $DuplicateCandidatePath
        Assert-FileSnapshotUnchanged $FilesBefore
    }
    finally {
        Stop-ControlledProcess $InjectorProcess
        Stop-ControlledProcess $Target
    }
}

function Invoke-EnvironmentBasePathCase {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GateRoot,
        [Parameter(Mandatory = $true)]
        [string]$Injector,
        [Parameter(Mandatory = $true)]
        [string]$ReShade
    )

    $CaseRoot = Join-Path $GateRoot "target-environment-base-path"
    $BasePath = Join-Path $CaseRoot "target-only-render-bin"
    New-Item -ItemType Directory -Path $BasePath -Force | Out-Null
    $TargetPath = New-PingTarget `
        -CaseRoot $CaseRoot `
        -Name "target-environment-base-path-fixture.exe"
    $CandidatePath = [IO.Path]::GetFullPath(
        (Join-Path $BasePath "dxgi.dll")
    )
    Copy-Item -LiteralPath $ReShade -Destination $CandidatePath
    $ConfigPath = [IO.Path]::GetFullPath(
        (Join-Path $CaseRoot "ReShade.ini")
    )
    Set-Content `
        -LiteralPath $ConfigPath `
        -Value (
            "[INSTALL]`r`n" +
            'BasePath=%EGO_TEST_RESHADE_BASE_PATH%' +
            "`r`n"
        ) `
        -Encoding UTF8
    $FilesBefore = Get-FileSnapshot @(
        $TargetPath,
        $CandidatePath,
        $ConfigPath
    )

    $Target = $null
    $InjectorProcess = $null
    try {
        $Target = Start-PingTarget `
            -TargetPath $TargetPath `
            -Environment @{
                EGO_TEST_RESHADE_BASE_PATH = [IO.Path]::GetFullPath($BasePath)
            }
        Assert-ModuleNotLoaded -Target $Target -ModulePath $CandidatePath
        $InjectorProcess = Start-ExactPidInjector `
            -Injector $Injector `
            -TargetPath $TargetPath `
            -Target $Target
        Assert-PreflightRefusal `
            -Injector $InjectorProcess `
            -Target $Target `
            -ExpectedCode "target-existing-reshade-installation" `
            -ExpectedEvidencePath $CandidatePath `
            -ExpectedExitCode 183 `
            -ExpectedReShadeBasePath $BasePath `
            -ExpectedAddonDirectoryPath $BasePath
        Assert-ModuleNotLoaded -Target $Target -ModulePath $CandidatePath
        Assert-FileSnapshotUnchanged $FilesBefore
    }
    finally {
        Stop-ControlledProcess $InjectorProcess
        Stop-ControlledProcess $Target
    }
}

function Invoke-IniCaseAndOverrideCase {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GateRoot,
        [Parameter(Mandatory = $true)]
        [string]$RegistryRoot,
        [Parameter(Mandatory = $true)]
        [string]$Injector,
        [Parameter(Mandatory = $true)]
        [string]$ReShade
    )

    $CaseRoot = Join-Path $GateRoot "ini-case-and-override"
    $InstallationRoot = Join-Path $CaseRoot "GlobalReShade"
    $OverrideRoot = Join-Path $CaseRoot "target-override"
    $AddonRoot = Join-Path $OverrideRoot "addons"
    $OutsideRoot = Join-Path $GateRoot "ini-case-outside"
    New-Item `
        -ItemType Directory `
        -Path $InstallationRoot, $OverrideRoot, $AddonRoot, $OutsideRoot `
        -Force | Out-Null
    $TargetPath = New-PingTarget `
        -CaseRoot $CaseRoot `
        -Name "ini-case-and-override-fixture.exe"
    $ModulePath = [IO.Path]::GetFullPath(
        (Join-Path $InstallationRoot "ReShade64.dll")
    )
    Copy-Item -LiteralPath $ReShade -Destination $ModulePath
    $OutsideModulePath = [IO.Path]::GetFullPath(
        (Join-Path $OutsideRoot "dxgi.dll")
    )
    Copy-Item -LiteralPath $ReShade -Destination $OutsideModulePath
    $ManifestPath = [IO.Path]::GetFullPath(
        (Join-Path $InstallationRoot "ReShade64.json")
    )
    Set-Content -LiteralPath $ManifestPath -Encoding UTF8 -Value @'
{
    "file_format_version": "1.0.0",
    "layer": {
        "name": "VK_LAYER_reshade",
        "type": "GLOBAL",
        "library_path": ".\\ReShade64.dll"
    }
}
'@
    $ConfigPath = [IO.Path]::GetFullPath(
        (Join-Path $CaseRoot "ReShade.ini")
    )
    Set-Content `
        -LiteralPath $ConfigPath `
        -Value (
            "[install]`r`n" +
            "BasePath=$([IO.Path]::GetFullPath($OutsideRoot))`r`n"
        ) `
        -Encoding UTF8
    $EffectiveConfigPath = [IO.Path]::GetFullPath(
        (Join-Path $OverrideRoot "ReShade.ini")
    )
    Set-Content `
        -LiteralPath $EffectiveConfigPath `
        -Value (
            "[ADDON]`r`n" +
            "AddonPath=addons`r`n" +
            "DisabledAddons=unrelated,@electron_game_overlay.addon64`r`n"
        ) `
        -Encoding UTF8

    $CaseRegistryRoot = "$RegistryRoot\CaseOverride"
    $RegistryProviderPath = (
        "Registry::HKEY_CURRENT_USER\$CaseRegistryRoot\Vulkan\ImplicitLayers"
    )
    New-Item -Path $RegistryProviderPath -Force | Out-Null
    New-ItemProperty `
        -Path $RegistryProviderPath `
        -Name $ManifestPath `
        -PropertyType DWord `
        -Value 0 `
        -Force | Out-Null
    $FilesBefore = Get-FileSnapshot @(
        $TargetPath,
        $ModulePath,
        $OutsideModulePath,
        $ManifestPath,
        $ConfigPath,
        $EffectiveConfigPath
    )

    $Target = $null
    $InjectorProcess = $null
    try {
        $Target = Start-PingTarget `
            -TargetPath $TargetPath `
            -Environment @{
                RESHADE_BASE_PATH_OVERRIDE = [IO.Path]::GetFullPath($OverrideRoot)
            }
        Assert-ModuleNotLoaded -Target $Target -ModulePath $ModulePath
        Assert-ModuleNotLoaded -Target $Target -ModulePath $OutsideModulePath
        $InjectorProcess = Start-ExactPidInjector `
            -Injector $Injector `
            -TargetPath $TargetPath `
            -Target $Target `
            -Environment @{
                ELECTRON_GAME_OVERLAY_TEST_LAYER_REGISTRY_ROOT = $CaseRegistryRoot
            }
        Assert-PreflightRefusal `
            -Injector $InjectorProcess `
            -Target $Target `
            -ExpectedCode "target-existing-reshade-global-layer" `
            -ExpectedEvidencePath $ModulePath `
            -ExpectedExitCode 183 `
            -ExpectedReShadeBasePath $OverrideRoot `
            -ExpectedAddonDirectoryPath $AddonRoot `
            -ExpectedAddonDisabled $true
        Assert-ModuleNotLoaded -Target $Target -ModulePath $ModulePath
        Assert-ModuleNotLoaded -Target $Target -ModulePath $OutsideModulePath
        Assert-FileSnapshotUnchanged $FilesBefore

        $Key = Get-Item -Path $RegistryProviderPath
        $ValueNames = @($Key.GetValueNames())
        if ($ValueNames.Count -ne 1 -or
            $ValueNames[0] -cne $ManifestPath -or
            $Key.GetValueKind($ManifestPath) -ne
                [Microsoft.Win32.RegistryValueKind]::DWord -or
            [int]$Key.GetValue($ManifestPath) -ne 0) {
            throw "The target-override registration changed during preflight."
        }
    }
    finally {
        Stop-ControlledProcess $InjectorProcess
        Stop-ControlledProcess $Target
    }
}

function Invoke-ExplicitLayerEnvironmentCase {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GateRoot,
        [Parameter(Mandatory = $true)]
        [string]$Injector
    )

    $CaseRoot = Join-Path $GateRoot "explicit-layer-environment"
    New-Item -ItemType Directory -Path $CaseRoot -Force | Out-Null
    $TargetPath = New-PingTarget `
        -CaseRoot $CaseRoot `
        -Name "explicit-layer-environment-fixture.exe"
    $MarkerPath = Join-Path $CaseRoot "environment-preservation.marker"
    Set-Content `
        -LiteralPath $MarkerPath `
        -Value "controlled explicit-layer environment fixture" `
        -Encoding UTF8
    $FilesBefore = Get-FileSnapshot @($TargetPath, $MarkerPath)

    $Target = $null
    $InjectorProcess = $null
    try {
        $Target = Start-PingTarget `
            -TargetPath $TargetPath `
            -Environment @{
                VK_INSTANCE_LAYERS = "VK_LAYER_reshade"
            }
        $InjectorProcess = Start-ExactPidInjector `
            -Injector $Injector `
            -TargetPath $TargetPath `
            -Target $Target
        Assert-PreflightRefusal `
            -Injector $InjectorProcess `
            -Target $Target `
            -ExpectedCode "target-global-reshade-layer-inspection-failed" `
            -ExpectedExitCode 50 `
            -ExpectWindowsError
        Assert-FileSnapshotUnchanged $FilesBefore
    }
    finally {
        Stop-ControlledProcess $InjectorProcess
        Stop-ControlledProcess $Target
    }
}

function Invoke-LoadedIncompatibleRuntimeCase {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GateRoot,
        [Parameter(Mandatory = $true)]
        [string]$Injector,
        [Parameter(Mandatory = $true)]
        [string]$ReShade,
        [Parameter(Mandatory = $true)]
        [string]$HostExecutable
    )

    $CaseRoot = Join-Path $GateRoot "loaded-incompatible-runtime"
    $AddonRoot = Join-Path $CaseRoot "official-addons"
    New-Item `
        -ItemType Directory `
        -Path $CaseRoot, $AddonRoot `
        -Force | Out-Null
    $TargetPath = [IO.Path]::GetFullPath(
        (Join-Path $CaseRoot "loaded-incompatible-runtime-host.exe")
    )
    $RuntimePath = [IO.Path]::GetFullPath(
        (Join-Path $CaseRoot "d3d11.dll")
    )
    Copy-Item -LiteralPath $HostExecutable -Destination $TargetPath
    Copy-IncompatibleRuntimeFixture `
        -Source $ReShade `
        -Destination $RuntimePath
    $ConfigPath = [IO.Path]::GetFullPath(
        (Join-Path $CaseRoot "ReShade.ini")
    )
    Set-Content `
        -LiteralPath $ConfigPath `
        -Value (
            "[INSTALL]`r`n" +
            "Logging=0`r`n" +
            "[ADDON]`r`n" +
            "AddonPath=official-addons`r`n" +
            "DisabledAddons=@electron_game_overlay.addon64`r`n"
        ) `
        -Encoding UTF8
    $FilesBefore = Get-FileSnapshot @(
        $TargetPath,
        $RuntimePath,
        $ConfigPath
    )

    $Target = $null
    $InjectorProcess = $null
    try {
        $Target = Start-ControlledProcess `
            -FilePath $TargetPath
        Wait-ModuleLoaded -Target $Target -ModulePath $RuntimePath
        $InjectorProcess = Start-ExactPidInjector `
            -Injector $Injector `
            -TargetPath $TargetPath `
            -Target $Target
        Assert-PreflightRefusal `
            -Injector $InjectorProcess `
            -Target $Target `
            -ExpectedCode "target-runtime-incompatible" `
            -ExpectedEvidencePath $RuntimePath `
            -ExpectedExitCode 50 `
            -ExpectedReShadeBasePath $CaseRoot `
            -ExpectedAddonDirectoryPath $AddonRoot `
            -ExpectedAddonDisabled $true `
            -ExpectWindowsError
        Wait-ModuleLoaded -Target $Target -ModulePath $RuntimePath
        Assert-FileSnapshotUnchanged $FilesBefore
    }
    finally {
        Stop-ControlledProcess $InjectorProcess
        Stop-ControlledProcess $Target
    }
}

function Invoke-MalformedGlobalLayerCase {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GateRoot,
        [Parameter(Mandatory = $true)]
        [string]$RegistryRoot,
        [Parameter(Mandatory = $true)]
        [string]$Injector,
        [Parameter(Mandatory = $true)]
        [string]$ReShade
    )

    $CaseRoot = Join-Path $GateRoot "malformed-global"
    $InstallationRoot = Join-Path $CaseRoot "GlobalReShade"
    New-Item -ItemType Directory -Path $InstallationRoot -Force | Out-Null
    $TargetPath = New-PingTarget `
        -CaseRoot $CaseRoot `
        -Name "malformed-global-fixture.exe"
    $ModulePath = [IO.Path]::GetFullPath(
        (Join-Path $InstallationRoot "ReShade64.dll")
    )
    Copy-Item -LiteralPath $ReShade -Destination $ModulePath
    $ManifestPath = [IO.Path]::GetFullPath(
        (Join-Path $InstallationRoot "ReShade64.json")
    )
    Set-Content -LiteralPath $ManifestPath -Encoding UTF8 -Value @'
{
    "file_format_version": "1.0.0",
    "layer": {
        "name": "VK_LAYER_reshade",
        "type": "GLOBAL",
        "library_path": ".\\NotReShade64.dll"
    }
}
'@
    $AppsPath = Join-Path $InstallationRoot "ReShadeApps.ini"
    Set-Content -LiteralPath $AppsPath -Value "Apps=$TargetPath" -Encoding UTF8

    $CaseRegistryRoot = "$RegistryRoot\Malformed"
    $RegistryProviderPath = (
        "Registry::HKEY_CURRENT_USER\$CaseRegistryRoot\Vulkan\ImplicitLayers"
    )
    New-Item -Path $RegistryProviderPath -Force | Out-Null
    New-ItemProperty `
        -Path $RegistryProviderPath `
        -Name $ManifestPath `
        -PropertyType DWord `
        -Value 0 `
        -Force | Out-Null
    $FilesBefore = Get-FileSnapshot @(
        $TargetPath,
        $ModulePath,
        $ManifestPath,
        $AppsPath
    )

    $Target = $null
    $InjectorProcess = $null
    try {
        $Target = Start-PingTarget $TargetPath
        Assert-ModuleNotLoaded -Target $Target -ModulePath $ModulePath
        $InjectorProcess = Start-ExactPidInjector `
            -Injector $Injector `
            -TargetPath $TargetPath `
            -Target $Target `
            -Environment @{
                ELECTRON_GAME_OVERLAY_TEST_LAYER_REGISTRY_ROOT = $CaseRegistryRoot
            }
        Assert-PreflightRefusal `
            -Injector $InjectorProcess `
            -Target $Target `
            -ExpectedCode "target-global-reshade-layer-inspection-failed" `
            -ExpectedEvidencePath $ManifestPath `
            -ExpectedExitCode 13 `
            -ExpectWindowsError
        Assert-ModuleNotLoaded -Target $Target -ModulePath $ModulePath
        Assert-FileSnapshotUnchanged $FilesBefore

        $Key = Get-Item -Path $RegistryProviderPath
        $ValueNames = @($Key.GetValueNames())
        if ($ValueNames.Count -ne 1 -or
            $ValueNames[0] -cne $ManifestPath -or
            $Key.GetValueKind($ManifestPath) -ne
                [Microsoft.Win32.RegistryValueKind]::DWord -or
            [int]$Key.GetValue($ManifestPath) -ne 0) {
            throw "The malformed controlled registration changed during preflight."
        }
    }
    finally {
        Stop-ControlledProcess $InjectorProcess
        Stop-ControlledProcess $Target
    }
}

function Invoke-UnsafeBasePathCase {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("Escape", "Reparse")]
        [string]$Kind,
        [Parameter(Mandatory = $true)]
        [string]$GateRoot,
        [Parameter(Mandatory = $true)]
        [string]$Injector,
        [Parameter(Mandatory = $true)]
        [string]$ReShade
    )

    $CaseRoot = Join-Path $GateRoot ("unsafe-" + $Kind.ToLowerInvariant())
    $OutsideRoot = Join-Path $GateRoot ("outside-" + $Kind.ToLowerInvariant())
    New-Item -ItemType Directory -Path $CaseRoot, $OutsideRoot -Force | Out-Null
    $TargetPath = New-PingTarget `
        -CaseRoot $CaseRoot `
        -Name ("unsafe-$($Kind.ToLowerInvariant())-fixture.exe")
    $OutsideModule = Join-Path $OutsideRoot "dxgi.dll"
    Copy-Item -LiteralPath $ReShade -Destination $OutsideModule

    $ConfiguredBasePath = $OutsideRoot
    if ($Kind -eq "Reparse") {
        $ConfiguredBasePath = Join-Path $CaseRoot "render-bin"
        New-Item `
            -ItemType Junction `
            -Path $ConfiguredBasePath `
            -Target $OutsideRoot | Out-Null
    }
    $ConfigPath = [IO.Path]::GetFullPath(
        (Join-Path $CaseRoot "ReShade.ini")
    )
    Set-Content `
        -LiteralPath $ConfigPath `
        -Value "[INSTALL]`r`nBasePath=$([IO.Path]::GetFullPath($ConfiguredBasePath))`r`n" `
        -Encoding UTF8
    $FilesBefore = Get-FileSnapshot @(
        $TargetPath,
        $OutsideModule,
        $ConfigPath
    )

    $Target = $null
    $InjectorProcess = $null
    try {
        $Target = Start-PingTarget $TargetPath
        Assert-ModuleNotLoaded `
            -Target $Target `
            -ModulePath ([IO.Path]::GetFullPath($OutsideModule))
        $InjectorProcess = Start-ExactPidInjector `
            -Injector $Injector `
            -TargetPath $TargetPath `
            -Target $Target
        $ExpectedExitCode = if ($Kind -eq "Escape") { 161 } else { 1920 }
        Assert-PreflightRefusal `
            -Injector $InjectorProcess `
            -Target $Target `
            -ExpectedCode "target-module-inspection-failed" `
            -ExpectedEvidencePath $ConfigPath `
            -ExpectedExitCode $ExpectedExitCode `
            -ExpectWindowsError
        Assert-FileSnapshotUnchanged $FilesBefore
    }
    finally {
        Stop-ControlledProcess $InjectorProcess
        Stop-ControlledProcess $Target
    }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$DefaultRuntimeDirectory = Join-Path $RepoRoot (
    "libs\electron-game-overlay-runtime\dist\win32-x64"
)
$Injector = if ([string]::IsNullOrWhiteSpace($InjectorPath)) {
    Join-Path $DefaultRuntimeDirectory "inject.exe"
}
else {
    [IO.Path]::GetFullPath($InjectorPath)
}
$ReShade = if ([string]::IsNullOrWhiteSpace($ReShadePath)) {
    Join-Path $DefaultRuntimeDirectory "ReShade64.dll"
}
else {
    [IO.Path]::GetFullPath($ReShadePath)
}
$DefaultHost = Join-Path $RepoRoot (
    "build\electron-game-overlay-runtime-production\" +
    "RelWithDebInfo\d3d11_overlay_test_host.exe"
)
$HostExecutable = if ([string]::IsNullOrWhiteSpace($HostPath)) {
    $DefaultHost
}
else {
    [IO.Path]::GetFullPath($HostPath)
}
foreach ($RequiredPath in @($Injector, $ReShade, $HostExecutable)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
        throw "Build the runtime before running the global-layer preflight gate: $RequiredPath"
    }
}
$Injector = (Resolve-Path -LiteralPath $Injector).Path
$ReShade = (Resolve-Path -LiteralPath $ReShade).Path
$HostExecutable = (Resolve-Path -LiteralPath $HostExecutable).Path

$Token = "global-layer-" + [Guid]::NewGuid().ToString("N")
$GateRoot = Join-Path $env:TEMP (
    "electron-game-overlay-global-reshade-preflight-" + $Token
)
$RegistryRoot = "Software\ElectronGameOverlay\Tests\$Token"
$RegistryProviderRoot = "Registry::HKEY_CURRENT_USER\$RegistryRoot"
if (Test-Path -Path $RegistryProviderRoot) {
    throw "The isolated test registry root already exists: $RegistryProviderRoot"
}

try {
    New-Item -ItemType Directory -Path $GateRoot -Force | Out-Null
    Invoke-GlobalLayerCase `
        -Kind Vulkan `
        -Lane ExactPid `
        -GateRoot $GateRoot `
        -RegistryRoot $RegistryRoot `
        -Injector $Injector `
        -ReShade $ReShade
    Invoke-GlobalLayerCase `
        -Kind OpenXR `
        -Lane PathWatcher `
        -GateRoot $GateRoot `
        -RegistryRoot $RegistryRoot `
        -Injector $Injector `
        -ReShade $ReShade
    Invoke-MalformedGlobalLayerCase `
        -GateRoot $GateRoot `
        -RegistryRoot $RegistryRoot `
        -Injector $Injector `
        -ReShade $ReShade
    Invoke-BasePathCase `
        -GateRoot $GateRoot `
        -Injector $Injector `
        -ReShade $ReShade
    Invoke-EnvironmentBasePathCase `
        -GateRoot $GateRoot `
        -Injector $Injector `
        -ReShade $ReShade
    Invoke-IniCaseAndOverrideCase `
        -GateRoot $GateRoot `
        -RegistryRoot $RegistryRoot `
        -Injector $Injector `
        -ReShade $ReShade
    Invoke-ExplicitLayerEnvironmentCase `
        -GateRoot $GateRoot `
        -Injector $Injector
    Invoke-LoadedIncompatibleRuntimeCase `
        -GateRoot $GateRoot `
        -Injector $Injector `
        -ReShade $ReShade `
        -HostExecutable $HostExecutable
    Invoke-UnsafeBasePathCase `
        -Kind Escape `
        -GateRoot $GateRoot `
        -Injector $Injector `
        -ReShade $ReShade
    Invoke-UnsafeBasePathCase `
        -Kind Reparse `
        -GateRoot $GateRoot `
        -Injector $Injector `
        -ReShade $ReShade

    Write-Host (
        "Global/loaded ReShade, exact INI semantics, target environment, " +
        "and configured BasePath preservation gate passed."
    )
}
finally {
    if (Test-Path -Path $RegistryProviderRoot) {
        Remove-Item -Path $RegistryProviderRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $GateRoot -PathType Container) {
        $ResolvedGateRoot = (Resolve-Path -LiteralPath $GateRoot).Path
        $ResolvedTemp = (Resolve-Path -LiteralPath $env:TEMP).Path
        if (-not $ResolvedGateRoot.StartsWith(
                $ResolvedTemp + [IO.Path]::DirectorySeparatorChar,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clean a gate root outside TEMP: $ResolvedGateRoot"
        }
        Remove-Item -LiteralPath $ResolvedGateRoot -Recurse -Force
    }
}
