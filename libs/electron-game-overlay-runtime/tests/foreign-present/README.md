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
