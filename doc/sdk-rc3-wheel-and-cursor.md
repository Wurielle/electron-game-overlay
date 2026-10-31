# rc.3 wheel and cursor fixes

Local candidate: `electron-game-overlay-0.1.0-rc.3.tgz`, runtime generation **5**,
add-on build ID **EAC95E70AFD34317B9DB0139BEA8FA65**. Work was performed on
`feat/sdk-release-candidate` at base `1ff4baeb5930bb20d6dff0d8e69ca05c8eb8be98`.
The changes and local archive are uncommitted; the base hash is not presented as
the source revision of the modified archive. No package publication or PR merge
was performed. This extends PR #2's v1 broker and focus contract.

## Root causes and complete input paths

The controlled D3D11 host reproduced the reported wheel failure on Electron
46.0.0-alpha.2: no-click typing worked, but a wheel gesture produced neither a DOM
wheel event nor scrolling. The native add-on deliberately discarded
`WM_POINTERWHEEL` and `WM_POINTERHWHEEL` after blocking them from the game.
The controlled host enables mouse-in-pointer, exposing the same missing route.

The add-on now projects both pointer-wheel messages into the existing legacy
wheel route, preserving their signed high-word delta and screen-space point.
Pointer-wheel wParam's high word is a delta, so it must not be interpreted as
PRIMARY/FIRSTBUTTON flags. Authoritative NOLEGACY raw streams retain their own
wheel projection and suppress duplicate legacy/pointer projections.

The existing Rust router converts both wheel axes from screen to game-client
coordinates, hit-tests/captures the destination window, and localizes the point.
The authenticated broker maps the target-global ID to the owning application's
local ID. The translator preserves vertical deltas, negates horizontal deltas for
Electron's convention, and the session divides local physical x/y by the
packet's authoritative scale tag before `webContents.sendInputEvent`. Deltas are
not divided by display scale. Direct Electron 39.8.10 and 46.0.0-alpha.2 probes
confirmed the original Electron wheel event shape already scrolls overflow DOM.

The SDK previously had no `cursor-changed` handler or cursor transport. The native
runtime only selected whether to draw a software arrow. rc.3 subscribes to
Chromium's cursor event, retains state across hide/reopen, negotiates optional
`window-cursor-v1` at each hop, and routes only owned window IDs. The native
router selects the hovered/captured window independently of keyboard focus.
A window-thread subclass applies system cursors, preserves the game's original
cursor/visibility state, and restores it outside overlays, on release, and on
teardown. Common software fallback shapes are retained for games that hide
hardware cursors. Hover position comes from CURSORINFO: ReShade intentionally
freezes GetCursorPos while suppressing game input.

The add-on ID, injector exact pin, package/staging pins and full patched-source
hash were advanced together. CMake can migrate an earlier terminal injector
build ID only when normalization produces the exact pinned source hash.

## Exact checks and evidence

The complete x64/x86 SDK build passed using Node **26.12.1**, the existing
Windows PowerShell module path, and a process-local Git safe-directory entry
for the existing generated ReShade source. No global Git configuration changed.

- `cargo test --manifest-path libs/electron-overlay-transport/Cargo.toml --lib --quiet`: **108 passed** on x64 and **108 passed** with `--target i686-pc-windows-msvc`.
- Complete SDK suite under Node 26: **688 passed, 9 skipped**, with one required
  native-helper fixture missing from the environment. Rerunning that exact test
  with EGO_NATIVE_MANAGER_PATH set to the built manager passed, resolving all
  **689 distinct** SDK checks. Log: `build/pointer-sdk-tests-node26.log`.
- Directly changed SDK tests after cleanup: **134 passed**. Log:
  `build/pointer-focused-tests.log`.
- SDK TypeScript build and `tsc --noEmit --project demos/tsconfig.json`: passed.
- Both x64/x86 `electron_overlay_transport_abi_smoke.exe`: passed.
- Existing independently compiled mixed-package acceptance against
  `build/compat-v1/libs/electron-game-overlay/dist`: **5/5**, mutation sensitivity
  verified and clean rerun **5/5**. Log: `build/pointer-mixed-package.log`.
- Isolated tarball install, strict consumer types and real DOM smoke on Electron
  **46.0.0-alpha.2**: passed. Report:
  `build/sdk-rc3-pointer/consumer-electron46.json`.

Real injected graphics acceptance used the SDK's controlled host EXEs, not Gun
Frog. Each case has its own launcher in
`libs/electron-game-overlay-runtime/scripts/test-cases`:

| Case | Report directory | Result |
| --- | --- | --- |
| D3D9 x64 | native-pointer-20261031-100010 | passed |
| D3D9 x86 | native-pointer-20261031-100403 | passed |
| D3D10 x64 | native-pointer-20261031-100409 | passed |
| D3D10 x86 | native-pointer-20261031-100415 | passed |
| D3D11 x64 | native-pointer-20261031-100420 | passed |
| D3D12 x64 | native-pointer-20261031-100426 | passed |
| D3D11 x64, NOLEGACY WM_INPUT | native-pointer-20261031-100744 | passed |
| D3D11 x64, NOLEGACY GetRawInputBuffer | native-pointer-20261031-100750 | passed |

Directories are under `build/` and contain `report.json`, Electron DOM state and
native logs. These cases verify actual Windows text/hand/resize cursor handles,
nested vertical/horizontal scrolling, both directions, partial detents, outer
overflow scrolling, game/overlay cursor transitions, game input suppression,
release back to the host, first-key typing and reopen with zero pointer-downs.
The nested DOM wheel point is verified at **60,110**. Raw hosts restore their
initially hidden game cursor, rather than assuming every game uses an arrow.

Before the quiet input window, two runs were contaminated by unrelated desktop
typing/foreground changes. They are preserved as failures and do not count as
SDK regressions or passes. The user confirmed they were using the PC; the quiet
reruns above are the accepted results.

## Remaining limits

- Custom bitmap cursors are not transported. They and unmapped exotic Chromium
  shapes fall back to arrow; common system cursor shapes and CSS `none` are
  supported.
- The additional Electron 46 **125% forced-scale** run cannot reach input
  acceptance because its OSR frame is rejected before rendering/interception.
  Expected physical raster: **750x600**; observed image: **602x481**. The isolated
  image probe has only representation scale **1**, and requesting size/bitmap
  at 1.25 returns the same bytes. Evidence:
  `build/native-pointer-20261031-100432/` and
  `build/dpi-image-probe.stdout.txt`. This separate raster-publication issue is
  not fixed or counted as a DPI input pass.
- These are Windows API/SendInput acceptance runs, not a human physical-wheel
  test or a guarantee against remote-desktop input interference. Software cursor
  fallback rendering was not visually certified for games that continuously
  override cursor APIs.
- An already frozen older coordinator/runtime retains its negotiated behavior.
  Close the target and consumers before testing the new native candidate; this
  release does not hot-replace a mapped runtime or modify existing ReShade
  installations.

Follow-up: [rc.4 fractional scaling and native hook correction](sdk-rc4-fractional-scaling.md) supersedes this local candidate.
