# Host-derived input capability acceptance

The two recorded Windows x64 D3D11 lanes passed on native generation 14,
build ID `412D57BEA49440738CC4C3903038F2E7`. The portable
[evidence summary](evidence-2026-11-01.json) retains report hashes, actual hello
tokens, socket counters, input observations, module identities and protected
file metadata. The build-directory reports remain the original local evidence.

| Host | Required capability | Observed result |
| --- | --- | --- |
| Project-owned patched host | `copied-raw-input-buffer` | Admitted; actual buffered mouse, key and wheel input reached the overlay while game counters stayed unchanged. Release restored game input, with two accepted buffered batches and no buffer error. |
| Unmodified ReShade 6.7.3.2148 with public adapter | `copied-raw-input-buffer` | Typed unsupported rejection before authentication or any scene, frame or interception packet. Both observed connection attempts wrote zero bytes. |
| Same stock process, separate permissive app | `copied-wm-input` | Rendered and accepted input before and after strict rejection, retaining one authentication and the exact private TCP connection and credential fingerprint. |

The stock hello advertised `input-capabilities-v1` and `copied-wm-input-v1`,
with no buffered-copy token. The public read API reported buffered input as
unsupported. The owned hello also advertised `copied-raw-input-buffer-v1` and
reported both features as supported. No capability advertisement was fabricated
by either live fixture.

Stock acceptance verified one ReShade host, its public adapter, two private EGO
engines, the foreign API-18 FPS Limiter add-on, and a compiled pass-through
witness effect. All seven protected seed files retained their SHA-256, length,
attributes and exact decimal last-write ticks before preparation, during the
test, and after host exit and manager removal. Only the native transaction
helper prepared and removed the reserved adapter and marker. No file restoration
was used to manufacture preservation.

The owned run used SDK graph
`7afdd2183b9a8c57a15ba1135df91a79e927853d976512a148af22e2dbe7a3ff`.
Both stock apps used graph
`c0d9d9d8a84549b4e4d43227ce63fd5a7007a0d38fe90c20d8771a6dc6091c26`.
They share native generation 14 and the development package label
`0.1.0-rc.7`; this is not independently released-package or mixed-native-version
acceptance.

## Reproduce

Build and seal the current package first. Run each visual case separately from
the repository root. Supply the pristine full-add-on stock DLL and API-18 FPS
Limiter artifact explicitly for the stock case:

```powershell
pwsh -NoProfile -File libs/electron-game-overlay-runtime/scripts/test-cases/d3d11-owned-input-capabilities.ps1 -SkipBuild
pwsh -NoProfile -File libs/electron-game-overlay-runtime/scripts/test-cases/d3d11-stock-input-capabilities.ps1 -SkipBuild -OfficialRuntimePath <stock-6.7.3-x64-dll> -ForeignAddonPath <pristine-fps_limit.addon64>
```

Both launchers accept `-ElectronExecutable` and `-SdkDist`. They create a fresh
owned controlled target directory; neither uses a real game's installation.
The display lease requires an observed ON state and releases its temporary
request during cleanup. It does not change display settings.

The fixture records actual native hellos and credential-redacted packet
metadata at the socket boundary. It records no token, frame payload or arbitrary
JSON body. Native PE exports and file hashes are inspected while the exact
target and private stages are alive. Final validation retains that proof after
stage cleanup and checks post-exit preservation.

## Scope

These are controlled `SendInput` tests using `VK_SPACE`, mouse clicks and wheel
input. They are not human physical-key evidence. The result establishes explicit
stock buffered-input rejection, not stock `GetRawInputBuffer` parity or a new
stock input hook. It does not establish other graphics APIs, x86, arbitrary
registration layouts, touch/pen, or concurrent input-pump behavior.

Original reports:

- [Owned positive](../../../../build/electron-game-overlay-runtime/client-sdk-input-capabilities-owned-20261101-173046-95cf02b1/report.json)
- [Stock rejection and permissive survivor](../../../../build/electron-game-overlay-runtime/client-sdk-input-capabilities-stock-20261101-174851-aae4a8da/report.json)

Pure tooling checks, separate from live acceptance:

```powershell
node --test apps/client/tests/cooperative-input-capabilities-fixture.test.cjs apps/client/tests/cooperative-input-capabilities-evidence.test.cjs apps/client/tests/cooperative-input-capability-gate.test.cjs libs/electron-game-overlay/tests/cooperative-native-input-capabilities.test.cjs
```
