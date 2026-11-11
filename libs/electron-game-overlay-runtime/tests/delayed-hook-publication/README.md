# Deterministic delayed-hook publication boundary

Individual launchers are `delayed-hook-publication-serialized.ps1` and
`delayed-hook-publication-contended.ps1`, each accepting x64 or x86. The serialized
control passes. The contended production gate deliberately returns exit 3 on
immutable candidate 1012 because its first real device misses ReShade's device
observation. The diagnostic runner's explicit `--expect-reproduction` option can
capture both cases without suppressing `gatePassed:false` or native exit 3 in
their report. It is not an acceptance pass.

The runner verifies the pinned 26-file native source vector and the sealed 1012
runtime hash, then uses one runtime hardlink per architecture across sequential
fresh fixture processes. It never edits that runtime, production locking, games,
Steam, consumer code, or launch configuration. The fixture has no static D3D11 /
DXGI imports and creates no windows or input. It dynamically creates actual
hardware D3D11 devices and verifies native green texture readback.

An inert public ReShade adapter counts device-init/destroy callbacks through an
explicit size/versioned POD test export. An owned MinHook detour on the Win32
`GetModuleHandleExW` API pauses exactly one designated scan-thread call with PIN
and a return address inside the actual production host. In the pinned source,
that call executes during `install_delayed_hooks` while the delayed-path mutex
is held. This is an external scheduling seam inside the owned test process,
not access to a private C++ mutex layout, a test replacement for that mutex, a
production source patch, or a Steam/game callback hook.

The serialized control releases that scan before the graphics-loading thread
starts. The contended case holds it until the graphics thread's first device
and GPU readback complete. Native logs prove the graphics thread skips its
D3D11 scan, then the other thread installs D3D11 hooks after release. A second
device through the same cached export pointer is observed, while the original
device stays native and usable. Event handshakes establish order; there is no
fixed 196 ms delay, sleep, retry or process reinjection. Ten-second waits and an
outer process deadline are failure bounds, not a scheduling mechanism.

This is a causal reproduction against the frozen runtime, not a universal
post-fix liveness test. A future design that blocks a graphics load until
publication would need a revised release/arrival handshake rather than waiting
for the first device before releasing the artificial barrier. Preserve this
known failure and add appropriate reentrant / DLL-loader-lock controls when
reviewing a loader correction. See `doc/delayed-hook-publication-reproduction.md`.
