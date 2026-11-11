# Compatibility checkpoint, 2026-11-10

This source checkpoint contains the integrated generation-29 D3D11 composition
resource identity correction and generation-30 private-stage failure diagnostics.
Generation 30 has not been packaged or handed off as a validated consumer candidate.
Candidate `1.0.1-alpha.2026111006` remains the separately captured generation-29
consumer baseline; its archive and source capture have not been replaced.

## Integrated changes

The D3D11 correction installs ReShade's existing resource `GetDevice` hook before
returning the first composition back buffer. See
[the identity investigation](d3d11-composition-resource-identity.md) and its dedicated
x64/x86 console/offscreen launcher. The coordinating consumer subsequently reported
PAGER medium and high runs working, an early wrapped D3D11 Electron/WebGL smoke,
and the normal graphics/scaling/focus matrix passing with candidate 1006. Those
consumer results are separate from this repository's native fixtures.

The private-stage diagnostics identify the precise failed artifact and operation
without changing acceptance, read guards, authorization, error codes or retry
behavior. The original high D3D9 x86 sharing violation (Windows error 32) remains
unresolved. Both native architectures built successfully; the production-helper
console fixtures passed 17 assertions per architecture with actual owned file and
directory sharing conflicts. They do not establish actual elevated acceptance.

The owned late-Present fixture extracts the exact production forwarding functions.
Its 19 cases per architecture passed, including render exceptions and device-loss
paths. This proves downstream callback forwarding through controlled seams;
it does not prove actual Steam trampoline identity or rendered Steam frames.

The feature add-on implementation and build ID are unchanged. Runtime generation
30 binds the new injector implementation; source inventory, patch digests and SDK
manifest checks require its exact implementation on both architectures.

## Unintegrated Steam prototype

`reshade-steam-loaded-module-hook-order.patch` is saved for review only. It is not
referenced by the production CMake patch stack, build stamps or SDK validator.
It adds exact-process loaded renderer detection alongside the existing optional
`SteamOverlayGameId` environment check when choosing ReShade's loader hook path.

An owned factory-hook model reproduced a narrower defect in unchanged candidate
1006: loading the renderer-model DLL first registers its factory hook when the
environment key exists, but skips it when that key is absent. The prototype x64
host compiled, but its corrected-model controls, x86 build, atomic source-cache
migration, provenance integration and consumer acceptance are still pending.
The model uses an owned test DLL and never runs actual Steam or Overwatch.

The user's Steam logs contain a factory-hook skip and later successful hooks, but
do not yet correlate those records to one exact Overwatch process lifetime.
Actual Overwatch attribution and acceptance remain unconfirmed. No combined
candidate 1007 has been declared final, and no existing candidate may be silently
replaced. A later complete candidate must integrate and validate the prototype
before making any production Steam compatibility claim.

Generated binaries, test reports, source archives and reusable native caches stay
outside version control. The local native cache contains the experimental Steam
host; production builds must return to the recognized source vector or finish
the prototype's pinned migration before reusing that cache.
