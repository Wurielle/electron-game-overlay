# Isolated owned ReShade first-import proof

This experiment tests loading the existing owned ReShade binary before a new
controlled target initializes graphics. It changes no ReShade source/binary,
game file, foreign installation, registry value, or global environment. It is
not activated by SDK production packaging and is not generic late attachment or
Steam folder-watcher acceptance.

The earlier [ordering proof](../early-process-bootstrap/README.md) passed an
actual x64 run with a small observation detour and 60 D3D12 presents, but loaded
no ReShade. This separate proof supplies the actual owned runtime and EGO add-on
and requires real overlay pixels/input through normal ReShade initialization.

## Startup mechanism

The architecture-matched native launcher uses official, unchanged Detours
4.0.1 `DetourCreateProcessWithDllsW` with exactly two first imports:

1. The exact supplied owned `ReShade64.dll` or `ReShade32.dll` in the stage.
2. The small `early_reshade_restore64.dll` or `early_reshade_restore32.dll`.

The existing ReShade images already export ordinal 1 (`D2D1CreateFactory`).
Detours inserts an import thunk for that ordinal; normal loading resolves it
without invoking it. The launcher checks the actual PE architecture, DLL flag,
ordinal presence, executable RVA, and absence of a forwarded ordinal before
creating any process. Both import files remain held read-only against
write/rename during the launch.

Detours' optional helper fallback is forbidden. Its helper would invoke ordinal
1 with the helper signature, which is invalid for ReShade's factory export. A
one-shot process-creation callback forwards only the controlled target creation
and rejects every fallback. The proof uses matching launcher/target/import
architectures and never starts an unbound `rundll32` helper.

ReShade executes its existing loader entry point. The second DLL verifies that
the owned ReShade is mapped from the same exact stage, then calls the official
`DetourRestoreAfterWith`. That restores the original in-memory PE headers and
does not unload the added DLLs or free their import-thunk storage. This
restoration DLL contains no scene, feature engine, transport, version election,
graphics call, or `LoadLibrary` call. It publishes only a sized/versioned private
POD result for the controlled host to verify.

The original imported graphics DLL records attach entry/return only. An EXE CRT
initializer, after DLL loader initialization and before `wmain`, verifies the
exact ReShade/restorer identities and restoration result, then calls the
original graphics DLL's initializer. Its real D3D12 device and DIRECT queue are
therefore created through the actual ReShade hooks. The executable uses those
same objects for its swap chain. ReShade's ordinary `AddonPath=.` scan and
`AddonInit` load the staged EGO engine; there is no explicit EGO initialization
or manual effect-runtime creation in this host.

The private SDK scene producer is reused from the isolated D3D11 manual-runtime
fixture only as an OSR producer. It neither launches nor injects the target.
The new controller supplies the exact owned runtime/add-on/SDK, normal owned
configuration, stage marker, authenticated private route, and child-only base
path override before startup. It does not enable `LoadFromDllMain` or bypass
ReShade's configuration enablement check.

Primary sources: [Detours import construction](https://github.com/microsoft/Detours/blob/e4bfd6b03e50de46b47abfbd1e46b384f0c5f833/src/uimports.cpp),
[multiple-import creation](https://github.com/microsoft/Detours/blob/e4bfd6b03e50de46b47abfbd1e46b384f0c5f833/src/creatwth.cpp),
[restoration API](https://github.com/microsoft/Detours/wiki/DetourRestoreAfterWith),
and [ReShade's ordinal definitions](https://github.com/crosire/reshade/blob/4a50d1eddace85734871d91792ff214f13f66c01/res/exports.def).

## Identity and lifetime bounds

The native launcher starts only the fixed copied host beside itself, in a new
private kill-on-close job assigned atomically at process creation. It validates
the retained process handle, exact executable path, PID and creation FILETIME
before resuming. Atomic initial/final journals let the controller bind that
same process instance. Failed Detours output handles are not queried or closed
again. The native child wait is bounded to 210 seconds; the host's own lifetime
bound is 180 seconds. The controller uses bounded individual readiness,
assertion, resize, shutdown and cleanup waits; it has no single 225-second
global deadline.

All source dependencies are the exact official Detours checkout already
described by the sibling ordering proof. CMake validates its 14 source/header/
license identities before compilation, and each run retains the complete
unchanged MIT license. No arbitrary registered code is built or run.

PE import paths use strict `CP_ACP` encoding with exact round-trip validation.
Unrepresentable paths fail before process creation. Passing UTF-8 to the narrow
Detours API is not treated as a general Unicode-path solution. Production still
needs an explicit staging strategy covering all supported Unicode profiles.

The kill-on-close job is appropriate for a controlled proof and startup cleanup.
A future production operation must remove that termination policy after durable
target ownership and readiness handoff. Otherwise the launching app's later
crash could kill the game and other apps, violating the cooperative contract.
This experiment is not that production handoff implementation.

## Assertions and execution

The dedicated `scripts/test-cases/early-reshade-overlay-proof.ps1` launcher
builds only this standalone fixture and stages it under a fresh owned
`build/early-reshade-bootstrap` run directory. Supply the exact matching owned
runtime/add-on paths and SDK distribution. `-SkipBuild` selects existing proof
binaries; it does not rebuild or change production runtime files.

The controller requires strict red scene pixels and actual DOM keyboard/pointer
delivery in the foreground controlled target, native input suppression while
intercepting, a real `ResizeBuffers` transition from 800x600 to 960x640, strict
post-resize scene/input, and released input reaching the native host. Input is
Windows `SendInput`, not human physical-key evidence. A resize request is written
only after the pre-resize assertions, so elapsed startup timing cannot skip that
boundary. The target must complete at least 60 native presents before resize
and 60 afterward, then handle the controller's ordinary `WM_CLOSE` with GPU
drain, owned resource release and a final successful report.

Live module paths/hashes must identify exactly the staged runtime and engine
while the target is alive. Source/binary hashes and native journals, scene
evidence, trace, final lifecycle and validator results are retained. The normal
pixel oracle remains strict; native lifecycle/trace validation alone cannot
certify overlay rendering or input success.

The [actual x64 run](evidence-owned-reshade-x64-2026-11-01.json) and
[separate Win32 run](evidence-owned-reshade-Win32-2026-11-01.json) on 2026-11-01
each passed the outer controller and native lifecycle validator. In each run,
both foreground desktop samples were exactly RGB 198/40/40. The DOM received `az`
and a pointer down/up before resize, then `b` afterward; released `C` reached
native input while the DOM remained `b`. One TCP/authentication survived the
800x600 to 960x640 resize with zero transport losses. Native evidence recorded
16 ordered events, exactly one ReShade, import restoration before pre-main
device creation, 164 successful presents (104 after resize), and graceful
GPU/resource/window cleanup. Each architecture's six staged binaries still
match their recorded source hashes, including its unchanged packaged ReShade
and EGO engine.

The native validator deliberately reports pixels/input as unproven; only the
distinct outer desktop/DOM/input controller establishes those assertions. Raw
before/after native suppression/release counter pairs were not serialized,
although the executed comparisons and final corroborating state are retained.
The log also records a final transport-drain warning after the producer's
intentional shutdown; this is not a warning-free native-log claim.

These passes establish this controlled D3D12 startup/render/input boundary only.
Other backends, real games, foreign-install handling, concurrent-app startup
and survival, production ownership/configuration integration, Unicode staging,
and generic unbarriered Steam attachment remain separate acceptance. See the
[broader design](../../../../doc/late-graphics-attachment.md).
