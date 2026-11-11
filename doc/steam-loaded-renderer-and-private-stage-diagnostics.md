# Loaded Steam renderer detection and private-stage diagnostics

The combined generation-30 source builds on the generation-29 D3D11 composition
identity correction. It adds an exact-process loaded renderer check and
failure-only private-stage diagnostics. The feature add-on, build ID and ABI
remain unchanged. Existing ReShade installations are preserved.

## Narrow loader correction

Pinned ReShade 6.7.3 chooses its loader-hook path when `SteamOverlayGameId` exists,
so Steam's factory hook can run before ReShade wraps its returned factory.
Otherwise it normally uses DLL notifications, which run before the outer
`LoadLibrary` hook returns. An already-loaded renderer with the optional key
absent therefore takes a different ordering path despite its presence.

The correction retains the environment check and additionally checks
`GameOverlayRenderer64.dll` on x64 or `GameOverlayRenderer.dll` on x86 through
`GetModuleHandleW`. It examines only the current target process, loads no DLL,
changes no user setting, and adds no wait or executable-name exclusion.

The owned model DLL implements only the documented foreign-vtable skip rule.
It installs a loader/factory hook using the pinned MinHook source. A factory
created with the unchanged generation-29 runtime and missing key exposes a
foreign vtable before the model can install its hook. The corrected runtime
keeps the model's registration working in that exact already-loaded case.

Use `scripts/test-cases/steam-loaded-renderer-hook-order.ps1` for each architecture.
The eight controls cover the retained baseline failure, key present/absent,
wrong DLL basename with key present/absent, no renderer, and the remaining
later-renderer order limitation. The fixture creates no window, device,
swapchain, Present or input. It does not establish actual Steam internals or
rendered frames. Actual Overwatch process attribution and acceptance remain
unconfirmed pending correlated main-process evidence.

## Failure diagnostics

The high x86 fallback's Windows error 32 does not identify which private-stage
I/O failed. The injector now emits an optional
`EGO_PRIVATE_ELEVATED_STAGE_DIAGNOSTIC_V1` record containing its PID, a fixed
artifact name, the operation and the original Windows error. It emits no user
paths, tokens or private file data. It returns the same refusal and restores
the original `GetLastError`.

Restrictive file sharing, exact hashes, architecture/ABI checks, owner/DACL/high
label validation, initialization ownership and existing-installation protection
are unchanged. There is no retry, unlock, relabel or acceptance fallback.
Use `scripts/test-cases/private-elevated-stage-diagnostics.ps1` for both
architectures. Real owned sharing conflicts verify the failure record, original
error and read-guard exclusion; the gate never calls injection or requests
elevation. The actual consumer failure remains unresolved until its new record
is collected and the cause is demonstrated.

## Build and provenance

Both changes are mandatory generation-30 pins in the sealed SDK and each native
stamp. CMake peels the Steam tail before the diagnostics/identity tails and
replays it last. Complete source inventories and exact pre/post hashes are
checked before and after each atomic source-file publication. Unknown edits are
preserved and rejected. Repeated architecture builds reuse one source cache.

The checkpoint document dated 2026-11-10 records the earlier committed state,
when Steam remained a prototype. This follow-up integrates that prototype;
it requires a new complete candidate and separate consumer/game acceptance.
