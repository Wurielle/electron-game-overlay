# SDK-first, late foreign Present GPU contract

`scripts/test-cases/late-foreign-present-readback-gen36.ps1` runs this same
32-case matrix against immutable candidate 1013, with separate generation-36
stage, build, logs and reports. The original launcher retains candidate 1009.
On 2026-11-11 both architectures passed the generation-36 matrix: 2,820
assertions, 96 green and 32 red GPU readbacks each. This does not reproduce the
remote Steam failure; see `../snapshot-destinations/README.md` for the bounded,
unapplied diagnostic proposal and remaining evidence gap.

`scripts/test-cases/late-foreign-present-readback.ps1` runs 32 bounded cases per
architecture using immutable production candidate 1009. The host DLL is linked
once into a fixed owned fixture stage, not copied for each case. All fixture
windows are hidden and never shown or activated. No game, Steam code, injection,
desktop activation or input runs.

The production owned bootstrap installs actual raw Present hooks before the
independent foreign renderer DLL loads. An optional third owned DLL installs a
pre-existing detour before the SDK. The late renderer observes the real ReShade
proxy-factory registration skip, then tracks the exact original swapchain through
an explicit native-parent-factory observation seam. That seam models the later
successful tracking boundary proven in the Steam trace; it does not recreate
Valve's factory wrapper or registration implementation.

The main chain is an actual production proxy and the raw shim receives its same
original chain with `g_in_dxgi_runtime` true. Actual public test-adapter callbacks
verify the proxy runtime path; the authenticated EGO feature transport/scene is
not substituted by this adapter. Independent late inline/vtable hooks paint the
real native backbuffer green and read it back from a staging texture. A disabled
green-rendering control reads the deterministic red baseline instead. The lower
third-party hook counts once-only native forwarding. Both proxy and raw device/
IUnknown identities, Present/Present1, test flags and native HRESULTs are checked.
A final forced `DXGI_ERROR_WAS_STILL_DRAWING` control must propagate unchanged.

The matrix includes Overwatch's observed legacy `CreateSwapChain` RGBA8/discard,
two buffers, video-device flags `0x800`, plus modern BGRA8/flip and ordinary-device
controls, each with and without the pre-existing detour. It uses 32-pixel targets
and bounded process timeouts. Native diagnostic records bind proxy downstream
identity, raw identity and the foreign tracker's numeric identity.

Passing proves foreign callback execution and GPU work for this owned chain.
It does not prove that Steam's actual hooks execute, recognize/enable rendering,
share frames with gameoverlayui, or display frames on the user's visible game
surface. If it passes while actual Steam still reports no rendered frames, these
remain the evidence gaps; the factory warning alone does not justify a production
delay, retry, hook rewrite or game-specific exclusion.

# Additional relay-placement model

`scripts/test-cases/late-foreign-present-relay-chain.ps1` runs the current
production runtime with a later independent renderer installed through the
existing relay. On x64 the fixture redirects the existing E9/FF25 pointer slot
to a fixture-owned private jump stub, which then reaches its renderer. The
renderer retains and calls the prior EGO raw callback. On x86, where MinHook
uses a direct branch without the x64 relay, it detours that branch destination.

The 24 cases per architecture cover an earlier independent detour present or
absent, video/ordinary devices, legacy/flip chains, positive GPU readback,
disabled-rendering red controls and a forced HRESULT. They preserve the original
identity, once-only forwarding and callback assertions. x64 log checks require
the same relay address, a changed private endpoint, and an unchanged saved
trampoline destination. Reports use a separate `-relay` suffix.

This is an owned placement model, not Steam or RTSS code. A passing result does
not reproduce or resolve the remote three-party failure, establish the owner
of its private allocation, or prove actual Steam toast/panel acceptance. No
production hook behavior or sealed candidate is changed by this fixture.

`scripts/test-cases/late-foreign-present-relay-detours.ps1` selects official
Microsoft Detours v4.0.1 for the earlier fixture detour. Place its exact checkout
at `build/fixture-detours-v4.0.1`; CMake checks every source against the existing
`early-process-bootstrap/detours-source-lock.json` before compilation. The
independent later renderer still uses the private-relay model. Separate
`-relay-detours` reports record the dependency lock and selected engine, and the
fixture verifies the loaded earlier DLL reports that engine. The original relay
launcher remains the independent MinHook comparison, including no-prior controls.

This comparison tests the two known fixture implementations. RTSS's default
engine and embedded Detours version are not established by the user-facing
setting, and neither RTSS callback body is replaced by this test. Changing the
earlier fixture library must not be reported as reproducing RTSS's mode switch.

`scripts/test-cases/earlier-hook-restore-repatch.ps1` tests a separate mechanism
model suggested by read-only disassembly of the supplied RTSS DLL. The earlier
owned callback temporarily restores five original target bytes, calls that
target, and then restores either its old hook bytes or the bytes current at entry.
It uses MinHook only for initial fixture installation. This is a single-caller
owned test model, not copied RTSS implementation or a production hook policy.

Each architecture runs eight fixed-repatch cases and eight current-byte-preserving
controls. With an earlier fixed-repatch hook present, the model must reproduce
loss on the second application Present: one later-renderer call, one raw-shim
call, two surviving proxy callbacks, and continuing earlier/native forwarding.
The first later renderer call must have painted green. Cases without the earlier
hook and all preserving controls require normal once-only forwarding and GPU
readback. Expected loss is explicitly labeled `expected-repatch-loss` and is not
reported as a successful overlay-rendering case. The real failing process's
mutable flags, copy length and target pointer remain necessary to confirm that
it took the same branch; static code and this model alone do not prove that.
