[CmdletBinding()]
param(
    [switch]$Force,
    [ValidateSet("x64", "x86")]
    [string]$Architecture = "x64",
    [string]$BuildCacheRoot
)

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $RuntimeRoot "..\..")).Path
$BuildRoot = Join-Path $RepoRoot "build\electron-game-overlay-runtime"
if ($BuildCacheRoot) {
    if (-not [IO.Path]::IsPathRooted($BuildCacheRoot)) { $BuildCacheRoot = Join-Path $RepoRoot $BuildCacheRoot }
    $BuildCacheRoot = [IO.Path]::GetFullPath($BuildCacheRoot)
    $BuildRoot = Join-Path $BuildCacheRoot "native"
}
$ReShadeSource = Join-Path $BuildRoot "_deps\reshade-src"
$ArchitectureConfig = if ($Architecture -eq "x86") {
    [pscustomobject]@{
        OutputDirectory = "bin\Win32\Release"
        RuntimeName = "ReShade32.dll"
        StampName = "ReShade32.build.json"
        RuntimePlatform = "32-bit"
        InjectorPlatform = "Win32"
    }
}
else {
    [pscustomobject]@{
        OutputDirectory = "bin\x64\Release"
        RuntimeName = "ReShade64.dll"
        StampName = "ReShade64.build.json"
        RuntimePlatform = "64-bit"
        InjectorPlatform = "x64"
    }
}
$Runtime = Join-Path $ReShadeSource (
    Join-Path $ArchitectureConfig.OutputDirectory $ArchitectureConfig.RuntimeName)
$Injector = Join-Path $ReShadeSource (
    Join-Path $ArchitectureConfig.OutputDirectory "inject.exe")
$BuildStamp = Join-Path $ReShadeSource (
    Join-Path $ArchitectureConfig.OutputDirectory $ArchitectureConfig.StampName)
$ExpectedReShadeCommit = "4a50d1eddace85734871d91792ff214f13f66c01"
$ObserverPatch = Join-Path $RuntimeRoot "patches\reshade-input-observer.patch"
$ObserverPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ObserverPatch).Hash
$InjectorBasePathPatch = Join-Path $RuntimeRoot "patches\reshade-injector-base-path.patch"
$InjectorBasePathPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorBasePathPatch).Hash
$PointerInputPatch = Join-Path $RuntimeRoot "patches\reshade-pointer-input-block.patch"
$PointerInputPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $PointerInputPatch).Hash
$RawInputNormalizationPatch =
    Join-Path $RuntimeRoot "patches\reshade-raw-input-normalization.patch"
$RawInputNormalizationPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $RawInputNormalizationPatch).Hash
$RawInputRegistrationReconciliationPatch =
    Join-Path $RuntimeRoot "patches\reshade-raw-input-registration-reconciliation.patch"
$RawInputRegistrationReconciliationPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $RawInputRegistrationReconciliationPatch).Hash
$RawInputFocusFollowingRootPatch =
    Join-Path $RuntimeRoot "patches\reshade-raw-input-focus-following-root.patch"
$RawInputFocusFollowingRootPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $RawInputFocusFollowingRootPatch).Hash
$InjectorExactPidPatch = Join-Path $RuntimeRoot "patches\reshade-injector-exact-pid.patch"
$InjectorExactPidPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorExactPidPatch).Hash
$InjectorPathWatcherPatch = Join-Path $RuntimeRoot "patches\reshade-injector-path-watcher.patch"
$InjectorPathWatcherPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorPathWatcherPatch).Hash
$InjectorPathWatcherIdentityPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-path-watcher-process-identity.patch"
$InjectorPathWatcherIdentityPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorPathWatcherIdentityPatch).Hash
$InjectorProcessObserverPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-persistent-path-observer.patch"
$InjectorProcessObserverPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorProcessObserverPatch).Hash
$InjectorResilientProcessObserverPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-resilient-path-observer.patch"
$InjectorResilientProcessObserverPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorResilientProcessObserverPatch).Hash
$InjectorConflictPreflightPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-conflict-preflight.patch"
$InjectorConflictPreflightPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorConflictPreflightPatch).Hash
$InjectorPerPidClaimPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-per-pid-claim.patch"
$InjectorPerPidClaimPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorPerPidClaimPatch).Hash
$SharedRuntimeHostPatch =
    Join-Path $RuntimeRoot "patches\reshade-shared-runtime-host.patch"
$SharedRuntimeHostPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $SharedRuntimeHostPatch).Hash
$InjectorExportReadBoundsPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-export-read-bounds.patch"
$InjectorExportReadBoundsPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorExportReadBoundsPatch).Hash
$InjectorExistingInstallationPreflightPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-existing-installation-preflight.patch"
$InjectorExistingInstallationPreflightPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorExistingInstallationPreflightPatch).Hash
$InjectorOfficialAddonHostPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-official-addon-host.patch"
$InjectorOfficialAddonHostPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorOfficialAddonHostPatch).Hash
$InjectorGlobalLayerPreflightPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-global-layer-preflight.patch"
$InjectorGlobalLayerPreflightPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorGlobalLayerPreflightPatch).Hash
$SharedRuntimeHardeningPatch =
    Join-Path $RuntimeRoot "patches\reshade-shared-runtime-hardening.patch"
$SharedRuntimeHardeningPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $SharedRuntimeHardeningPatch).Hash
$SuppressSplashPatch = Join-Path $RuntimeRoot "patches\reshade-suppress-splash.patch"
$SuppressSplashPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $SuppressSplashPatch).Hash
$X86RuntimePatch = Join-Path $RuntimeRoot "patches\reshade-x86-runtime.patch"
$X86RuntimePatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $X86RuntimePatch).Hash
$X86TargetArchitectureDiagnosticPatch =
    Join-Path $RuntimeRoot "patches\reshade-x86-target-architecture-diagnostic.patch"
$X86TargetArchitectureDiagnosticPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $X86TargetArchitectureDiagnosticPatch).Hash
$InjectorExactTargetPathPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-exact-target-path.patch"
$InjectorExactTargetPathPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorExactTargetPathPatch).Hash
$InjectorNameWatcherReadyPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-name-watcher-ready.patch"
$InjectorNameWatcherReadyPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorNameWatcherReadyPatch).Hash
$FutureTargetsPatch = Join-Path $RuntimeRoot "patches\reshade-injector-future-targets.patch"
$ProcessPolicyPatch = Join-Path $RuntimeRoot "patches\reshade-injector-process-policy.patch"
$FutureTargetsPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $FutureTargetsPatch).Hash
$ProcessPolicyPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ProcessPolicyPatch).Hash
$InjectorProcessInstanceBindingPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-process-instance-binding.patch"
$InjectorProcessInstanceBindingPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorProcessInstanceBindingPatch).Hash
$CooperativeMembersPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-cooperative-members.patch"
$CooperativeMembersPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $CooperativeMembersPatch).Hash
$OwnedLateD3d11Patch =
    Join-Path $RuntimeRoot "patches\reshade-owned-late-d3d11.patch"
$OwnedLateD3d11PatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $OwnedLateD3d11Patch).Hash
if ($OwnedLateD3d11PatchHash -cne
    "51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE") {
    throw "The owned late D3D11 production patch does not match its frozen source."
}
$InjectorFirstHostResultPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-first-host-result.patch"
$InjectorFirstHostResultPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorFirstHostResultPatch).Hash
if ($InjectorFirstHostResultPatchHash -cne
    "B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554") {
    throw "The injector first-host result patch does not match its frozen source."
}
$InjectorAddonPreloadPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-preloaded-addon.patch"
$InjectorAddonPreloadPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorAddonPreloadPatch).Hash
if ($InjectorAddonPreloadPatchHash -cne
    "E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D") {
    throw "The injector add-on preload patch does not match its frozen source."
}
$InjectorPreloadedFirstHostPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-preloaded-first-host.patch"
$InjectorPreloadedFirstHostPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorPreloadedFirstHostPatch).Hash
if ($InjectorPreloadedFirstHostPatchHash -cne
    "A8C494EF02E08E5084D7EDC27ABCB73639C18D23469F244F99F090A27DB46309") {
    throw "The injector preloaded first-host patch does not match its frozen source."
}
$InjectorPreloadLongPathPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-preload-long-path.patch"
$InjectorPreloadLongPathPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorPreloadLongPathPatch).Hash
if ($InjectorPreloadLongPathPatchHash -cne
    "FFFF684D2E60D36F1CEC4D073B91A014B7F497A50C4F5B00F7B7F2A57714397B") {
    throw "The injector preload long-path patch does not match its frozen source."
}
$OwnedLateD3d11AdapterReadyLongPathPatch =
    Join-Path $RuntimeRoot "patches\reshade-owned-late-d3d11-adapter-ready-long-path.patch"
$OwnedLateD3d11AdapterReadyLongPathPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $OwnedLateD3d11AdapterReadyLongPathPatch).Hash
if ($OwnedLateD3d11AdapterReadyLongPathPatchHash -cne
    "BCC0F0CD455B80DB3ED6D850B63600116B1D9881F1C85602CF76CEF7B23C35A6") {
    throw "The owned late D3D11 adapter-ready long-path patch does not match its frozen source."
}
$InjectorInitialInspectionRecoveryPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-initial-inspection-recovery.patch"
$InjectorInitialInspectionRecoveryPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorInitialInspectionRecoveryPatch).Hash
if ($InjectorInitialInspectionRecoveryPatchHash -cne
    "5E9E7D2C8A2EE66F9A478CA193B5962C4F635943D040B121593AD70A3177D8A7") {
    throw "The injector initial-inspection recovery patch does not match its frozen source."
}
$InjectorSharedAddonDirectoryPatch =
    Join-Path $RuntimeRoot "patches\reshade-injector-shared-addon-directory.patch"
$InjectorSharedAddonDirectoryPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorSharedAddonDirectoryPatch).Hash
if ($InjectorSharedAddonDirectoryPatchHash -cne
    "54AE1F9ABCE02CBB66481C7C2AB30E4D3E7925CD83F27F31D8551D76DEF85125") {
    throw "The injector shared add-on directory patch does not match its frozen source."
}
$OwnedLateD3d11ForeignAddonIsolationPatch =
    Join-Path $RuntimeRoot "patches\reshade-owned-late-d3d11-addon-failure-isolation.patch"
$OwnedLateD3d11ForeignAddonIsolationPatchHash =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $OwnedLateD3d11ForeignAddonIsolationPatch).Hash
if ($OwnedLateD3d11ForeignAddonIsolationPatchHash -cne
    "2A1FF13D7F76258ECF9D5CFB565D68C2522BEE772053A5373A3645823D310F99") {
    throw "The owned late D3D11 foreign add-on isolation patch does not match its frozen source."
}
$D3d11ResourceIdentityPatch = Join-Path $RuntimeRoot "patches\reshade-d3d11-swapchain-resource-identity.patch"
$D3d11ResourceIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $D3d11ResourceIdentityPatch).Hash
if ($D3d11ResourceIdentityPatchHash -cne "25DA093F15FAACF74AA16ED0BFFA233B58D10C7FC1BEA15B667C0E9F5F6AAEF2") { throw "The D3D11 resource identity patch differs from its pinned implementation." }
$PrivateStageDiagnosticsPatch = Join-Path $RuntimeRoot "patches\reshade-injector-private-stage-diagnostics.patch"
$PrivateStageDiagnosticsPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PrivateStageDiagnosticsPatch).Hash
if ($PrivateStageDiagnosticsPatchHash -cne "D73FF95608079571FC6438F8B5E280BB710AD8467F19CA31B664E371929C05F1") { throw "The private stage diagnostics patch differs from its pinned implementation." }
$SteamLoadedModuleHookOrderPatch = Join-Path $RuntimeRoot "patches\reshade-steam-loaded-module-hook-order.patch"
$SteamLoadedModuleHookOrderPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SteamLoadedModuleHookOrderPatch).Hash
if ($SteamLoadedModuleHookOrderPatchHash -cne "560BF8A6DB17643F7FA095F75FDBE0677211FC4354BEB6C869C7D4ECD7DB1241") { throw "The Steam loaded-module hook-order patch differs from its pinned implementation." }
$CompatibilitySnapshotPatch = Join-Path $RuntimeRoot "patches\reshade-compatibility-snapshot.patch"
$CompatibilitySnapshotPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $CompatibilitySnapshotPatch).Hash
if ($CompatibilitySnapshotPatchHash -cne "C63E22F1768770469C770FB6D4124AE1A293A6D5ACD8402E8EC86F33B1CA1C66") { throw "Compatibility snapshot patch differs from its pinned implementation." }
$OwnedCompositionPolicyPatch = Join-Path $RuntimeRoot "patches\reshade-owned-composition-policy.patch"
$OwnedCompositionPolicyPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OwnedCompositionPolicyPatch).Hash
if ($OwnedCompositionPolicyPatchHash -cne "7AF52928DCAAD1914993D2CC29D99862461F1A46AF2448A82C7F2C42E87E68CF") { throw "Owned composition policy patch differs from its pinned implementation." }
$CompositionBindingDiagnosticsPatch = Join-Path $RuntimeRoot "patches\reshade-owned-composition-binding-diagnostics.patch"
$CompositionBindingDiagnosticsPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $CompositionBindingDiagnosticsPatch).Hash
if ($CompositionBindingDiagnosticsPatchHash -cne "0180A6FACEEC7FA89174F4CED311A926DC98D292FB114347813F0E29C6B150DE") { throw "Composition binding diagnostic patch differs from its pinned implementation." }
$WindowEligibilityPatch = Join-Path $RuntimeRoot "patches\reshade-owned-composition-window-eligibility.patch"
$WindowEligibilityPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $WindowEligibilityPatch).Hash
if ($WindowEligibilityPatchHash -cne "080DA1FD83FE48CB782FA9268B82A386E75BE081D107F2A5013F06675107B97F") { throw "Composition window eligibility patch differs from its pinned implementation." }
$DeferredD3d11Patch = Join-Path $RuntimeRoot "patches\reshade-owned-deferred-d3d11.patch"
$DeferredD3d11PatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $DeferredD3d11Patch).Hash
if ($DeferredD3d11PatchHash -cne "779D9D41768FE61BC5FF3DCF69E2EE11B360DC00B5B58C24E0B1F83552A2D9BB") { throw "Owned deferred D3D11 patch differs from its pinned implementation." }
$AuxiliaryLifetimePatch = Join-Path $RuntimeRoot "patches\reshade-owned-composition-auxiliary-lifetime.patch"
$AuxiliaryLifetimePatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $AuxiliaryLifetimePatch).Hash
if ($AuxiliaryLifetimePatchHash -cne "3E80D0D05CA9F383D9E5216034E687B93CC858334B2F61514ADE91EF18573E61") { throw "Composition auxiliary lifetime patch differs from its pinned implementation." }
$ExpectedPatchedFiles = @(
    "source/ego_owned_late_d3d11/owned_runtime_policy.hpp"
    "source/dxgi/dxgi_swapchain.hpp"
    "source/ini_file.cpp"
    "source/ego_owned_late_d3d11/compatibility_snapshot.hpp"
    "source/dxgi/dxgi.cpp"
    "source/hook_manager.cpp"
    "source/dxgi/dxgi_swapchain.cpp"
    "ReShade.vcxproj"
    "include/reshade.hpp"
    "include/reshade_api.hpp"
    "include/reshade_events.hpp"
    "source/addon.cpp"
    "source/addon_manager.cpp"
    "source/addon_manager.hpp"
    "source/d3d11/d3d11_impl_swapchain.cpp"
    "source/d3d11/d3d11_impl_swapchain.hpp"
    "source/ego_owned_late_d3d11/owned_config_file.hpp"
    "source/ego_owned_late_d3d11/owned_late_d3d11.hpp"
    "source/ego_owned_late_d3d11/owned_late_d3d11.inl"
    "source/input_frame_consumer.hpp"
    "source/input.cpp"
    "source/input.hpp"
    "source/runtime.cpp"
    "source/runtime.hpp"
    "source/runtime_gui.cpp"
    "tools/injector.cpp"
)
$InjectorInspectionContextPatch = Join-Path $RuntimeRoot "patches\reshade-injector-inspection-context.patch"
$InjectorInspectionContextPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorInspectionContextPatch).Hash
if ($InjectorInspectionContextPatchHash -cne "288C2A76AEDBC827BB00117A455FFE87ECB708CA33411449CD56E2BEA190160E") {
    throw "The injector inspection-context patch does not match its frozen source."
}
$InjectorSelectionBeforeOpenPatch = Join-Path $RuntimeRoot "patches\reshade-injector-selection-before-open.patch"
$InjectorSelectionBeforeOpenPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorSelectionBeforeOpenPatch).Hash
if ($InjectorSelectionBeforeOpenPatchHash -cne "F83053E59EE9443E98D31A4C238B3D19D6B847D1F6F5E238E05B899FFC87E555") {
    throw "The injector selection-before-open patch does not match its frozen source."
}
$InjectorMemberDiagnosticsPatch = Join-Path $RuntimeRoot "patches\reshade-injector-member-diagnostics.patch"
$InjectorMemberDiagnosticsPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorMemberDiagnosticsPatch).Hash
if ($InjectorMemberDiagnosticsPatchHash -cne "D56162D2EA444DB44E7F21128A5F316E124E11E08EC1B6F3328D769EA4048A57") {
    throw "The injector member-diagnostics patch does not match its frozen source."
}
$InjectorStartupReadinessPatch = Join-Path $RuntimeRoot "patches\reshade-injector-startup-readiness.patch"
$InjectorStartupReadinessPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorStartupReadinessPatch).Hash
if ($InjectorStartupReadinessPatchHash -cne "29C8D7ACA8919189D484B2E22F83DBD564B00D344E8C860058AFCCEAFC808D9D") { throw "The startup-readiness patch differs from its frozen implementation." }
$InjectorElevatedPrivatePatch = Join-Path $RuntimeRoot "patches\reshade-injector-elevated-private-authorization.patch"
$InjectorElevatedPrivatePatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InjectorElevatedPrivatePatch).Hash
if ($InjectorElevatedPrivatePatchHash -cne "DF33E210E32A3994866ECDA8F6B0461C113A3F27DEC1A79133D4D0AF347B9697") { throw "The elevated-private patch differs from its frozen implementation." }
$ExpectedPatchedContentSha256 = [ordered]@{
    "source/ego_owned_late_d3d11/owned_runtime_policy.hpp" = "A06E427C7EA2AE73F3FF90E14C204719FC247B9DE02EB5F84E066B602623F524"
    "source/dxgi/dxgi_swapchain.hpp" = "C5A155BE0321F30DB18B4FC4578A41BF728414DD0927A789D5C335041922BC55"
    "source/ini_file.cpp" = "08ACD295DB065D11E5A8388F074CFC6C384D29896E5DA9B20227222D8A61C688"
    "source/ego_owned_late_d3d11/compatibility_snapshot.hpp" = "C0FE868ED8B0FA7FE7688DB19252BE427316DFC1D73C5F4AF5BBD299A8662F50"
    "source/dxgi/dxgi.cpp" = "41A686B186910B4C0FAA1B631356C2D7FD0F4BE772EFB32D7328DAA2DC65B88F"
    "source/hook_manager.cpp" = "355E78AC03E71D2101585EC8C8C64A458978A17BA6E20F0D218D7E6ED312A49E"
    "source/dxgi/dxgi_swapchain.cpp" = "C064C8BBE74B659C423516FB9F7F9A663D5A7A42CCCC6F43354A14AA8F11CC21"
    "ReShade.vcxproj" = "9FC55C36B9B4E55E8FE9D87401CEFE69858B5FA5110023840BEAF2FC5B8D2A9C"
    "include/reshade.hpp" = "CC102FA21D311B85713ED167F0E182A4EECCD40CDF3FBE360AD9F83A0CF40767"
    "include/reshade_api.hpp" = "80E9F0CBC06BF96943DC79CA2D133DB5D8E69D3A4CD516B6D89D675B8B965218"
    "include/reshade_events.hpp" = "8090912CD69854818C294F7C0F848EBAB7C712AB6D601E6889E62514249EE6A7"
    "source/addon.cpp" = "DF69C9E8BE88244B54D92849A183B8A149A74FA959ED49A7109824EF0D8E3D9C"
    "source/addon_manager.cpp" = "E6524902A07A0B4E2947B372503679A84CAA0FD1840329E89564559C3160349E"
    "source/addon_manager.hpp" = "C1D27EA4C9996F1EAD408FAD0D0DB3AEEAE16A4BEFEB4A0F71EC6C616116989B"
    "source/d3d11/d3d11_impl_swapchain.cpp" = "9CC88315C5F2A4DAAA7E4AEAEBBA6584851AE565EC5D250C28BE2AE3B4347DDF"
    "source/d3d11/d3d11_impl_swapchain.hpp" = "D6010A43C93302C056AF62E1BBE7523E6A8D023DEDFB9D3F50DC689EAA9169B6"
    "source/ego_owned_late_d3d11/owned_config_file.hpp" = "98D7B1D5D55841FDDD0320378C130D61DFF688EC42C47E6C14BAC7ADDE87C8D8"
    "source/ego_owned_late_d3d11/owned_late_d3d11.hpp" = "99C928A9D56A8A029F0E02C354C22142A95DCDEE849359B2C31E8077F3C589B6"
    "source/ego_owned_late_d3d11/owned_late_d3d11.inl" = "2E89DBEED170BD1D5C2247D7373F89D82544CD217951826EE5F953F8B1567080"
    "source/input_frame_consumer.hpp" = "50808217A78ABD97417CA57694A5275895F8F0318AF6172658C087C26D3F8CA0"
    "source/input.cpp" = "B5778EA4DFD482F1E3E0C8A5337BCCFF351EA2CCF85AD0FDF565669CB9852D72"
    "source/input.hpp" = "6F9AF2B09AC6FF491AA2BC96A024E3B90F703985FFAD7A96C2BBB862667A4C1E"
    "source/runtime.cpp" = "96B12143E7A13B607D101AE7FD573C86334DD1BFDEEC2CA21520C74FE0200CD7"
    "source/runtime.hpp" = "1F2CF88559AE52D62DC3A8B236A734093E74864CAC44A069DD54440FBCCE3D11"
    "source/runtime_gui.cpp" = "6B8A8D3ACECE1E9C687062360FABBFAC04397222973A23565B661A7505F3187A"
    "tools/injector.cpp" = "7A6DC34363FF8EBD78484D8AEE6CE0463F22E90AB35DD1261FC9FBD9B09A3A3E"
}

function Get-NormalizedTextSha256([string]$Path) {
    $Text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n").Replace("`r", "`n")
    $Sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $Bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return ($Sha256.ComputeHash($Bytes) |
            ForEach-Object { $_.ToString("X2") }) -join ""
    }
    finally {
        $Sha256.Dispose()
    }
}

function Test-GitPatchApplied([string]$Patch, [int]$Strip = 1) {
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        # A failed reverse check is expected on a clean or superseded cache.
        # Windows PowerShell otherwise promotes git's redirected stderr to a
        # terminating NativeCommandError while the script is in Stop mode.
        $ErrorActionPreference = "Continue"
        & git.exe -C $ReShadeSource apply "-p$Strip" --reverse --check $Patch 2>$null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
}

function Test-ReShadePatchedSourceState {
    if (-not (Test-Path -LiteralPath $ReShadeSource -PathType Container)) {
        return $false
    }

    $SourceChanges = @(
        & git.exe -C $ReShadeSource status --porcelain --untracked-files=all --ignore-submodules=none 2>$null
    )
    if ($LASTEXITCODE -ne 0 -or $SourceChanges.Count -ne $ExpectedPatchedFiles.Count) {
        return $false
    }

    $ChangedFiles = @(
        $SourceChanges | ForEach-Object {
            if ($_.Length -lt 4) {
                return ""
            }
            $_.Substring(3).Replace("\", "/")
        }
    )
    if (@($ChangedFiles | Where-Object { $_ -notin $ExpectedPatchedFiles }).Count -ne 0) {
        return $false
    }

    foreach ($Entry in $ExpectedPatchedContentSha256.GetEnumerator()) {
        $PatchedFile = Join-Path $ReShadeSource $Entry.Key
        if (-not (Test-Path -LiteralPath $PatchedFile -PathType Leaf) -or
            (Get-NormalizedTextSha256 $PatchedFile) -ne $Entry.Value) {
            return $false
        }
    }
    # Check independent terminal seams after the exact file/content proof.
    # Deferred adoption supersedes the old inl include-context and composition
    # seams; their bytes remain covered by the complete vector and patch pins.
    foreach ($Patch in @(
        $InjectorSharedAddonDirectoryPatch
        $InjectorSelectionBeforeOpenPatch
        $InjectorStartupReadinessPatch
        $PrivateStageDiagnosticsPatch
        $DeferredD3d11Patch
        $OwnedLateD3d11ForeignAddonIsolationPatch
    )) {
        if (-not (Test-GitPatchApplied $Patch)) {
            return $false
        }
    }
    return $true
}

function Test-RuntimeBuildCache {
    if (-not (Test-Path -LiteralPath $Runtime -PathType Leaf) -or
        -not (Test-Path -LiteralPath $Injector -PathType Leaf) -or
        -not (Test-Path -LiteralPath $BuildStamp -PathType Leaf)) {
        return $false
    }

    $CachedCommit = (& git.exe -C $ReShadeSource rev-parse HEAD 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or -not $CachedCommit -or
        $CachedCommit.Trim() -ne $ExpectedReShadeCommit) {
        return $false
    }

    if (-not (Test-ReShadePatchedSourceState)) {
        return $false
    }

    try {
        $Stamp = Get-Content -Raw -LiteralPath $BuildStamp | ConvertFrom-Json
        $RuntimeHash = (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Runtime).Hash
        $InjectorHash = (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Injector).Hash
        return $Stamp.schemaVersion -eq 30 -and
            $Stamp.commit -eq $ExpectedReShadeCommit -and
            $Stamp.observerPatchSha256 -eq $ObserverPatchHash -and
            $Stamp.injectorBasePathPatchSha256 -eq $InjectorBasePathPatchHash -and
            $Stamp.pointerInputPatchSha256 -eq $PointerInputPatchHash -and
            $Stamp.rawInputNormalizationPatchSha256 -eq $RawInputNormalizationPatchHash -and
            $Stamp.rawInputRegistrationReconciliationPatchSha256 -eq $RawInputRegistrationReconciliationPatchHash -and
            $Stamp.rawInputFocusFollowingRootPatchSha256 -eq $RawInputFocusFollowingRootPatchHash -and
            $Stamp.injectorExactPidPatchSha256 -eq $InjectorExactPidPatchHash -and
            $Stamp.injectorPathWatcherPatchSha256 -eq $InjectorPathWatcherPatchHash -and
            $Stamp.injectorPathWatcherIdentityPatchSha256 -eq $InjectorPathWatcherIdentityPatchHash -and
            $Stamp.injectorProcessObserverPatchSha256 -eq $InjectorProcessObserverPatchHash -and
            $Stamp.injectorResilientProcessObserverPatchSha256 -eq $InjectorResilientProcessObserverPatchHash -and
            $Stamp.injectorConflictPreflightPatchSha256 -eq $InjectorConflictPreflightPatchHash -and
            $Stamp.injectorPerPidClaimPatchSha256 -eq $InjectorPerPidClaimPatchHash -and
            $Stamp.sharedRuntimeHostPatchSha256 -eq $SharedRuntimeHostPatchHash -and
            $Stamp.injectorExportReadBoundsPatchSha256 -eq $InjectorExportReadBoundsPatchHash -and
            $Stamp.injectorExistingInstallationPreflightPatchSha256 -eq $InjectorExistingInstallationPreflightPatchHash -and
            $Stamp.injectorOfficialAddonHostPatchSha256 -eq $InjectorOfficialAddonHostPatchHash -and
            $Stamp.injectorGlobalLayerPreflightPatchSha256 -eq $InjectorGlobalLayerPreflightPatchHash -and
            $Stamp.sharedRuntimeHardeningPatchSha256 -eq $SharedRuntimeHardeningPatchHash -and
            $Stamp.suppressSplashPatchSha256 -eq $SuppressSplashPatchHash -and
            $Stamp.x86RuntimePatchSha256 -eq $X86RuntimePatchHash -and
            $Stamp.x86TargetArchitectureDiagnosticPatchSha256 -eq $X86TargetArchitectureDiagnosticPatchHash -and
            $Stamp.injectorExactTargetPathPatchSha256 -eq $InjectorExactTargetPathPatchHash -and
            $Stamp.injectorNameWatcherReadyPatchSha256 -eq $InjectorNameWatcherReadyPatchHash -and
            $Stamp.injectorProcessInstanceBindingPatchSha256 -eq $InjectorProcessInstanceBindingPatchHash -and
            $Stamp.injectorFutureTargetsPatchSha256 -eq $FutureTargetsPatchHash -and
            $Stamp.injectorProcessPolicyPatchSha256 -eq $ProcessPolicyPatchHash -and
            $Stamp.injectorCooperativeMembersPatchSha256 -eq $CooperativeMembersPatchHash -and
            $Stamp.ownedLateD3d11PatchSha256 -eq $OwnedLateD3d11PatchHash -and
            $Stamp.injectorFirstHostResultPatchSha256 -eq $InjectorFirstHostResultPatchHash -and
            $Stamp.injectorAddonPreloadPatchSha256 -eq $InjectorAddonPreloadPatchHash -and
            $Stamp.injectorPreloadedFirstHostPatchSha256 -eq $InjectorPreloadedFirstHostPatchHash -and
            $Stamp.injectorPreloadLongPathPatchSha256 -eq $InjectorPreloadLongPathPatchHash -and
            $Stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256 -eq $OwnedLateD3d11AdapterReadyLongPathPatchHash -and
            $Stamp.injectorInitialInspectionRecoveryPatchSha256 -eq $InjectorInitialInspectionRecoveryPatchHash -and
            $Stamp.injectorSharedAddonDirectoryPatchSha256 -eq $InjectorSharedAddonDirectoryPatchHash -and
            $Stamp.injectorInspectionContextPatchSha256 -eq $InjectorInspectionContextPatchHash -and
            $Stamp.injectorSelectionBeforeOpenPatchSha256 -eq $InjectorSelectionBeforeOpenPatchHash -and
            $Stamp.injectorMemberDiagnosticsPatchSha256 -eq $InjectorMemberDiagnosticsPatchHash -and
            $Stamp.injectorStartupReadinessPatchSha256 -eq $InjectorStartupReadinessPatchHash -and
            $Stamp.injectorElevatedPrivatePatchSha256 -eq $InjectorElevatedPrivatePatchHash -and
            $Stamp.d3d11SwapchainResourceIdentityPatchSha256 -eq $D3d11ResourceIdentityPatchHash -and
            $Stamp.injectorPrivateStageDiagnosticsPatchSha256 -eq $PrivateStageDiagnosticsPatchHash -and
            $Stamp.steamLoadedModuleHookOrderPatchSha256 -eq $SteamLoadedModuleHookOrderPatchHash -and
            $Stamp.ownedDeferredD3d11PatchSha256 -eq $DeferredD3d11PatchHash -and
            $Stamp.ownedCompositionAuxiliaryLifetimePatchSha256 -eq $AuxiliaryLifetimePatchHash -and
            $Stamp.ownedCompositionWindowEligibilityPatchSha256 -eq $WindowEligibilityPatchHash -and
            $Stamp.ownedCompositionBindingDiagnosticsPatchSha256 -eq $CompositionBindingDiagnosticsPatchHash -and
            $Stamp.ownedCompositionPolicyPatchSha256 -eq $OwnedCompositionPolicyPatchHash -and
            $Stamp.compatibilitySnapshotPatchSha256 -eq $CompatibilitySnapshotPatchHash -and
            $Stamp.ownedLateD3d11ForeignAddonIsolationPatchSha256 -eq $OwnedLateD3d11ForeignAddonIsolationPatchHash -and
            ($Stamp.addonPreloadProtocol -is [int] -or $Stamp.addonPreloadProtocol -is [long]) -and
            $Stamp.addonPreloadProtocol -eq 1 -and
            $Stamp.cooperativeAddonProtocol -eq 1 -and
            $Stamp.injectorProcessInstanceBinding -eq 1 -and
            $Stamp.injectorFutureTargets -eq 2 -and
            $Stamp.configuration -eq "Release" -and
            $Stamp.platform -eq $ArchitectureConfig.RuntimePlatform -and
            $Stamp.addonLevel -eq 2 -and
            $Stamp.runtimeSha256 -eq $RuntimeHash -and
            $Stamp.injectorSha256 -eq $InjectorHash
    }
    catch {
        return $false
    }
}

if ((Test-RuntimeBuildCache) -and -not $Force) {
    Write-Host "RESHade full-add-on runtime already built: $Runtime"
    Write-Host "ReShade $Architecture injector already built: $Injector"
    return
}

Push-Location $RuntimeRoot
try {
    $ConfigureOptions = @('--preset', 'vs2022-x64')
    if ($BuildCacheRoot) {
        $ConfigureOptions += @('-B', $BuildRoot)
        # A clean checkout may be seeded from verified local Git objects. Once
        # populated, never ask FetchContent to reset a patched source checkout.
        foreach ($Dependency in @('reshade', 'imgui')) {
            $SourceDirectory = Join-Path $BuildRoot "_deps/$Dependency-src"
            if (Test-Path -LiteralPath (Join-Path $SourceDirectory '.git')) {
                $ConfigureOptions += "-DFETCHCONTENT_SOURCE_DIR_$($Dependency.ToUpperInvariant())=$SourceDirectory"
            }
        }
    }
    & cmake.exe @ConfigureOptions
    if ($LASTEXITCODE -ne 0) {
        throw "CMake configure failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath (Join-Path $ReShadeSource "ReShade.sln") -PathType Leaf)) {
    throw "Pinned ReShade source was not fetched into $ReShadeSource."
}

$ActualReShadeCommit = (& git.exe -C $ReShadeSource rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualReShadeCommit -ne $ExpectedReShadeCommit) {
    throw "Fetched ReShade source is $ActualReShadeCommit, expected pinned commit $ExpectedReShadeCommit."
}

& git.exe -C $ReShadeSource submodule update --init --recursive --depth 1
if ($LASTEXITCODE -ne 0) {
    throw "ReShade dependency checkout failed with exit code $LASTEXITCODE."
}

if (-not (Test-ReShadePatchedSourceState)) {
    throw "Pinned ReShade source does not contain exactly the expected source patches."
}

$ReShadeProject = Join-Path $ReShadeSource "ReShade.vcxproj"
$ProjectText = Get-Content -Raw -LiteralPath $ReShadeProject
if ($ProjectText -notmatch "RESHADE_ADDON=2") {
    throw "Pinned ReShade Release project no longer declares full add-on support."
}
$InjectorProject = Join-Path $ReShadeSource "ReShadeInject.vcxproj"
if (-not (Test-Path -LiteralPath $InjectorProject -PathType Leaf)) {
    throw "Pinned ReShade injector project was not found: $InjectorProject"
}

$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) {
    throw "Visual Studio locator was not found: $VsWhere"
}

$VsInstall = (& $VsWhere `
    -latest `
    -products * `
    -requires Microsoft.Component.MSBuild `
    -property installationPath | Select-Object -First 1)
if (-not $VsInstall) {
    throw "Visual Studio 2022 C++ Build Tools were not found."
}

$MsBuild = Join-Path $VsInstall.Trim() "MSBuild\Current\Bin\MSBuild.exe"
if (Test-Path -LiteralPath $Runtime -PathType Leaf) {
    Remove-Item -LiteralPath $Runtime -Force
}
if (Test-Path -LiteralPath $Injector -PathType Leaf) {
    Remove-Item -LiteralPath $Injector -Force
}
if (Test-Path -LiteralPath $BuildStamp -PathType Leaf) {
    Remove-Item -LiteralPath $BuildStamp -Force
}
& $MsBuild (Join-Path $ReShadeSource "ReShade.sln") `
    /t:ReShade `
    /m `
    /p:Configuration=Release `
    /p:Platform=$($ArchitectureConfig.RuntimePlatform) `
    /verbosity:minimal
if ($LASTEXITCODE -ne 0) {
    throw "ReShade runtime build failed with exit code $LASTEXITCODE."
}

& $MsBuild $InjectorProject `
    /m `
    /p:Configuration=Release `
    /p:Platform=$($ArchitectureConfig.InjectorPlatform) `
    /verbosity:minimal
if ($LASTEXITCODE -ne 0) {
    throw "ReShade injector build failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $Runtime -PathType Leaf)) {
    throw "ReShade build completed without producing $Runtime."
}
if (-not (Test-Path -LiteralPath $Injector -PathType Leaf)) {
    throw "ReShade injector build completed without producing $Injector."
}

$RuntimeHash = (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Runtime).Hash
$InjectorHash = (Get-FileHash -ErrorAction Stop -Algorithm SHA256 -LiteralPath $Injector).Hash
[ordered]@{
    schemaVersion = 30
    commit = $ActualReShadeCommit
    observerPatchSha256 = $ObserverPatchHash
    injectorBasePathPatchSha256 = $InjectorBasePathPatchHash
    pointerInputPatchSha256 = $PointerInputPatchHash
    rawInputNormalizationPatchSha256 = $RawInputNormalizationPatchHash
    rawInputRegistrationReconciliationPatchSha256 = $RawInputRegistrationReconciliationPatchHash
    rawInputFocusFollowingRootPatchSha256 = $RawInputFocusFollowingRootPatchHash
    injectorExactPidPatchSha256 = $InjectorExactPidPatchHash
    injectorPathWatcherPatchSha256 = $InjectorPathWatcherPatchHash
    injectorPathWatcherIdentityPatchSha256 = $InjectorPathWatcherIdentityPatchHash
    injectorProcessObserverPatchSha256 = $InjectorProcessObserverPatchHash
    injectorResilientProcessObserverPatchSha256 = $InjectorResilientProcessObserverPatchHash
    injectorConflictPreflightPatchSha256 = $InjectorConflictPreflightPatchHash
    injectorPerPidClaimPatchSha256 = $InjectorPerPidClaimPatchHash
    sharedRuntimeHostPatchSha256 = $SharedRuntimeHostPatchHash
    injectorExportReadBoundsPatchSha256 = $InjectorExportReadBoundsPatchHash
    injectorExistingInstallationPreflightPatchSha256 = $InjectorExistingInstallationPreflightPatchHash
    injectorOfficialAddonHostPatchSha256 = $InjectorOfficialAddonHostPatchHash
    injectorGlobalLayerPreflightPatchSha256 = $InjectorGlobalLayerPreflightPatchHash
    sharedRuntimeHardeningPatchSha256 = $SharedRuntimeHardeningPatchHash
    suppressSplashPatchSha256 = $SuppressSplashPatchHash
    x86RuntimePatchSha256 = $X86RuntimePatchHash
    x86TargetArchitectureDiagnosticPatchSha256 = $X86TargetArchitectureDiagnosticPatchHash
    injectorExactTargetPathPatchSha256 = $InjectorExactTargetPathPatchHash
    injectorNameWatcherReadyPatchSha256 = $InjectorNameWatcherReadyPatchHash
    injectorFutureTargetsPatchSha256 = $FutureTargetsPatchHash
    injectorProcessPolicyPatchSha256 = $ProcessPolicyPatchHash
    injectorCooperativeMembersPatchSha256 = $CooperativeMembersPatchHash
    ownedLateD3d11PatchSha256 = $OwnedLateD3d11PatchHash
    injectorFirstHostResultPatchSha256 = $InjectorFirstHostResultPatchHash
    injectorAddonPreloadPatchSha256 = $InjectorAddonPreloadPatchHash
    injectorPreloadedFirstHostPatchSha256 = $InjectorPreloadedFirstHostPatchHash
    injectorPreloadLongPathPatchSha256 = $InjectorPreloadLongPathPatchHash
    ownedLateD3d11AdapterReadyLongPathPatchSha256 = $OwnedLateD3d11AdapterReadyLongPathPatchHash
    injectorInitialInspectionRecoveryPatchSha256 = $InjectorInitialInspectionRecoveryPatchHash
    injectorSharedAddonDirectoryPatchSha256 = $InjectorSharedAddonDirectoryPatchHash
    injectorInspectionContextPatchSha256 = $InjectorInspectionContextPatchHash
    injectorSelectionBeforeOpenPatchSha256 = $InjectorSelectionBeforeOpenPatchHash
    injectorMemberDiagnosticsPatchSha256 = $InjectorMemberDiagnosticsPatchHash
    injectorStartupReadinessPatchSha256 = $InjectorStartupReadinessPatchHash
    injectorPrivateStageDiagnosticsPatchSha256 = $PrivateStageDiagnosticsPatchHash
    steamLoadedModuleHookOrderPatchSha256 = $SteamLoadedModuleHookOrderPatchHash
    ownedDeferredD3d11PatchSha256 = $DeferredD3d11PatchHash
    ownedCompositionAuxiliaryLifetimePatchSha256 = $AuxiliaryLifetimePatchHash
    ownedCompositionWindowEligibilityPatchSha256 = $WindowEligibilityPatchHash
    ownedCompositionBindingDiagnosticsPatchSha256 = $CompositionBindingDiagnosticsPatchHash
    ownedCompositionPolicyPatchSha256 = $OwnedCompositionPolicyPatchHash
    compatibilitySnapshotPatchSha256 = $CompatibilitySnapshotPatchHash
    d3d11SwapchainResourceIdentityPatchSha256 = $D3d11ResourceIdentityPatchHash
    injectorElevatedPrivatePatchSha256 = $InjectorElevatedPrivatePatchHash
    ownedLateD3d11ForeignAddonIsolationPatchSha256 = $OwnedLateD3d11ForeignAddonIsolationPatchHash
    addonPreloadProtocol = 1
    cooperativeAddonProtocol = 1
    injectorProcessInstanceBindingPatchSha256 = $InjectorProcessInstanceBindingPatchHash
    injectorProcessInstanceBinding = 1
    injectorFutureTargets = 2
    configuration = "Release"
    platform = $ArchitectureConfig.RuntimePlatform
    addonLevel = 2
    runtimeSha256 = $RuntimeHash
    injectorSha256 = $InjectorHash
} | ConvertTo-Json | Set-Content -LiteralPath $BuildStamp -Encoding UTF8

Write-Host "RESHade full-add-on runtime built: $Runtime"
Write-Host "ReShade $Architecture injector built: $Injector"
