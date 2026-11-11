# Owned Steam loader/factory ordering model

Run `scripts/test-cases/steam-loaded-renderer-hook-order.ps1` with `-Architecture
x64` or `x86`, the corrected `-Runtime`, and a preserved generation-29
`-BaselineRuntime`. Defaults use the local production distribution and preserved
candidate 1006. Builds reuse the pinned ReShade MinHook checkout and fixed paths.

The DLL is an owned model of the documented foreign-vtable skip rule, compiled
with the renderer basename so the exact production loaded-module condition can
be exercised. It is never installed into Steam, a game or any system location.
Eight cases per architecture cover the baseline missing-key failure, corrected
registration, environment-only registration, exact-name negative control,
no-model factory creation and the remaining later-renderer ordering limitation.

The gate creates a DXGI factory and deliberately supplies no device or swapchain.
It creates no HWND, graphics device, Present, actual Steam frame or input.
The skipped factory hook is a model result; actual Steam/Overwatch attribution
and rendered acceptance require correlated evidence from the exact game process.
