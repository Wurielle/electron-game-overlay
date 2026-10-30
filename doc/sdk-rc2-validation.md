# SDK 0.1.0-rc.2 validation evidence

Local Windows validation on 2026-10-30. The candidate's provenance file identifies
the exact source commit; tarball hashes and machine-readable reports accompany
the built artifact. These results do not imply every game or Electron build works.

The mapped add-on identity is `B6A6721DEF914B38A040AC08A87F31A2`, with runtime
generation 4 and target transport v1 on both architectures. Private package
schema 4 additionally declares `injectorFutureTargets: 1`; older schema-4
manifests remain accepted without acquiring that capability.

| Check | Result and boundary |
| --- | --- |
| SDK unit/regression suite | 692 tests: 683 passed, 9 skipped, zero failures. Includes controlled broker crash/recovery, ownership, late join, routing and cancellation cases. |
| Rust x64/x86 | 107 tests passed on each architecture. The new case dispatches real native focus packets and routes Win32 keyboard messages with no pointer-down. |
| Windows ABI smoke | Passed on x64 and x86. |
| Native injectors | 38 checks passed, plus both legacy marker-load controls. Actual owned x64/x86 processes and inert DLLs verify matching/mismatched creation identities, malformed requests, future-only baseline exclusion and rejection of a same-named executable at another path before injection. This does not prove game graphics-hook timing. |
| Public process observer | Actual Windows native observer passed readiness, baseline exclusion, Unicode image path, exact creation FILETIME comparison with an independent OS query, retained-handle exit and idempotent disposal. No injection. |
| Independently built rc.1/current package graphs | Five matrix checks plus mutation sensitivity and clean rerun passed. Both coordinator versions and both client startup orders; optional focus is suppressed against the actual older coordinator. The native/injection boundary is controlled. |
| Election/load hardening | Eleven checks passed with independently compiled old/current implementations. Controlled native boundary, 32/64 socket members, late arrivals, isolation and ownership freeze; not a 500-app/500-version capacity result. |
| Installed package | Complete npm tarball installed offline with its real dependency; all 49 sealed payloads, public exports, declarations, native PE architectures and SDK/provider byte identity verified. |
| Electron 39.8.10 consumer | External standalone installation, strict consumer types and genuine Electron DOM smoke passed. |
| Electron 39 native focus | The final two-process D3D11 no-click focus/input-gate case also passed on Electron 39.8.10. |
| Electron 46.0.0-alpha.2 consumer | External standalone installation with matching Electron-46 declarations, strict types and genuine Electron-46 DOM smoke passed. |
| Electron 46 native focus | Actual D3D11 host and two independent SDK Electron processes passed authenticated rendering, no-click first show, hide/reopen, focus transfer, member exit, conditional blur, interception-off and foreground loss/regain. Private test broker pipe; Windows SendInput virtual keys, zero pointer-downs. |
| Older creation-identity reader/recovery | Independently compiled v1 implementation `9f26185` and current transport passed private durable-claim reader/rewrite/recovery cases, mutation detection and a clean rerun. This is controlled filesystem/transport evidence, not OS identity or injection acceptance. |

The public focus example is `window.show(); window.focus();
session.input.intercept();`, with the desired DOM input focused by the page.
No sole-window heuristic or synthetic click is used.

The full future-target/render/input check passed after **130.012 seconds idle**
with Electron 46.0.0-alpha.2. Gun Frog (Steam 3173130), prearmed by its exact
executable path, passed authenticated rendering, no-click first opening/reopen,
blur, interception-off and foreground restore using SendInput. Gun Frog did not
produce a background interception-off acknowledgement while its renderer was
inactive; that acknowledgement is not claimed. The restore check waits for a
fresh presentation sample and native keyboard ownership rather than reusing a
stale acknowledgement. This does not establish arbitrary late-PID attachment.

A human physical first-key run is distinct from SendInput and has its dedicated
`gun-frog-physical-first-key.ps1` launcher. It is awaiting human participation;
no physical hardware-key acceptance is claimed yet.

No Izabela files were edited, no existing ReShade installation was rewritten,
and no live coordinator/runtime was replaced. The candidate has an exact
Electron-46 prerelease peer exception, not a general Electron 40–46 range.
