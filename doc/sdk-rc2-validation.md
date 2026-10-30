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
| Electron 46.0.0-alpha.2 consumer | External standalone installation with matching Electron-46 declarations, strict types and genuine Electron-46 DOM smoke passed. |
| Electron 46 native focus | Actual D3D11 host and two independent SDK Electron processes passed authenticated rendering, no-click first show, hide/reopen, focus transfer, member exit, conditional blur, interception-off and foreground loss/regain. Private test broker pipe; Windows SendInput virtual keys, zero pointer-downs. |

The public focus example is `window.show(); window.focus();
session.input.intercept();`, with the desired DOM input focused by the page.
No sole-window heuristic or synthetic click is used.

The new candidate's 130-second full future-target/render/input and real Gun Frog
checks are **not claimed passed**: the running Izabela dev application owns the
existing exclusive precreation rendezvous. It was left running. The dedicated
launchers are available once that watcher is released. Historical rc.1 consumer
patch tests (including Gun Frog) are diagnostic evidence, not acceptance of these
new artifact bytes. A human physical-key run is also distinct from the automated
SendInput acceptance and remains available with `-PhysicalKeyboard`.

No Izabela files were edited, no existing ReShade installation was rewritten,
and no live coordinator/runtime was replaced. The candidate has an exact
Electron-46 prerelease peer exception, not a general Electron 40–46 range.
