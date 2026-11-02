# Optional add-on preloading acceptance — 2026-11-02

**Generation 19 passes all six core preload/compatibility demo cells and all
nine additional default-path regressions.** The
registered self-load and public-SDK injection paths pass on D3D11 and D3D12;
the retained unregistered gen16 SDK also joins and survives the current app's
crash on both backends. The complete recorded matrix is accepted within its
controlled-demo scope.

Only copied repository DirectX demos were used for this feature. No user game
was launched. The earlier [gen16 game acceptance](readiness-acceptance-2026-11-01.md)
remains historical evidence for those exact bytes, not a generation-19 rerun.

The [portable record](evidence/addon-preloading-2026-11-02.json) retains exact
candidate identities, case snapshots, failures and per-file hashes.
[Installation and API instructions](addon-preloading.md) describe the optional
`electron-game-overlay/preload` entrypoint and `addonPreload` launch option.

## Exact accepted core candidate

| Identity | Value |
| --- | --- |
| Native generation / add-on build ID | 19 / `CCE20935ADD44EF6A5A7973014B2E07F` |
| SDK seal SHA-256 | `43e069e4c76651443d0734517754b22b713601387123dd4654e18c21013f48bf` |
| JavaScript graph SHA-256 | `e501e622e0fa543e00854598a199bc5076efc8ae391058b32f565ee7b7a63c56` |
| Sealed payloads | 154 files, 20,779,905 bytes |
| x64 add-on SHA-256 | `f45ca8feb398fa4caa543a174a393d45e555f9eeac8167fd94b66e1a46da9918` |
| x86 add-on SHA-256 | `3850842892b3a00b7cc4cbfa0fd03d105645acb8cf0a0f14f711cc55f03a9f8a` |
| Preload protocol | 1 on both native architectures |

The [compiled-package audit](../build/gen19-final-sdk-seal-audit.json) verifies
all sealed bytes, native stamp bindings and PE architectures. It binds normalized
injector source
`a8ecf5046dd3bedb748b77202504b234e39444fd96a9eafc35a5877febc683e6`
and the final first-host patch
`a8c494ef02e08e5084d7edc27abcb73639c18d23469f244f99f090a27db46309`.
Package label `0.1.0-rc.7` and source milestone labels are informational.

The [public-entrypoint audit](../build/gen19-final-sdk-entrypoint-retained-audit.json)
imports `electron-game-overlay/preload` through CommonJS and ESM without
loading Electron or the main SDK entrypoint. Guarded filesystem mutation,
process, network and native-load attempts were zero. This is an import audit;
actual registration is exercised separately by unit tests and the demos.

## Six actual x64 demo cells

| Backend | Initialization / compatibility boundary | Recorded result |
| --- | --- | --- |
| D3D11 | [Public SDK first-host injection](../build/pl/r-aaaf378c453f/report.json) | PASS, 15 checks |
| D3D11 | [Self-load with both apps initially offline](../build/pl/r-b0fa03869c0b/report.json) | PASS, 16 checks |
| D3D12 | [Self-load and public SDK injection](../build/pl/r-9a0ad5d1c091/report.json) | Both PASS, 16 and 15 checks |
| D3D11 | [Current registered dispatcher + old unregistered gen16](../build/pl/c-f63b05aec63c/report.json) | PASS, 9 checks |
| D3D12 | [Current registered dispatcher + old unregistered gen16](../build/pl/c-816d31b47fc6/report.json) | PASS, 9 checks |

There are four registered cells and two true mixed-native-version cells, with
80 recorded controller checks in total. The two registered application
identities both use the same gen19 payload: `distinctNativeBuilds=false`.
Their separate cache/module identities prove application isolation, not
different registered library versions.

In self-load cells, real ReShade scans an external flat `AddonPath` while both
apps are offline. Two add-ons are mapped with zero private participants, slots,
windows, ranks, TCP workers or EGO frame workers. The first scanner-loaded
adapter's app stays offline while the other app activates its existing mapped
module. In injection cells the initiating app is active and its peer dormant;
these cells separately prove public-SDK snapshot wiring and the strict
four-field first-host result. They do not claim both apps were initially offline.

The registered controllers assert exact composited red/blue/interleaved/alpha
pixels, isolated text with colliding local IDs, individual raising, caption
dragging, three Windows cursors and wheel behavior. Interception OR is checked
through requested/effective ACK states in these cells; this is not a separate
native game-counter-freeze measurement.

Crashing a peer preserves the survivor's private route and interaction.
Restarting a consumed app adds exactly one fresh engine. Unregistering changes
the future snapshot while existing mapped bases and the target stay intact.
Final no-app state has zero TCP/windows/ranks/focus/capture/interception, with
**three intentionally retained engines, slots and frame workers** until target
exit. All targets exited normally with empty cleanup errors. No ReShade
runtime/add-on/INI was installed in the target directories; test markers and
copied demo executables are distinct from such an installation.

The two mixed cells use the genuinely older installed gen16 public entrypoint.
Its 148 sealed files and JavaScript graph are revalidated in the entrypoint
audit. It dynamically joins the dormant current baseline while the registered
app is offline, then remains interactive with the same private identity after
that app crashes. Current activation reuses its original mapped base. Final
state retains two engines/slots/frame workers, with zero active TCP/window/input
ownership. This does not claim gen16 supports preload registration or that a
manually configured foreign host is accepted.

All cells use a controlled pre-device startup barrier. The D3D12 results do not
establish generic late swap-chain queue recovery. Preload/compatibility graphics
acceptance here is x64. Additional x86 default-path cases do not establish x86
preloading graphics support; native compilation, PE integrity and console tests
remain separate boundaries.

## Native and SDK checks

- [SDK suite](../build/sdk-unit-gen19-final-audit.json): 1,240 tests, 1,230
  passed, zero failed, ten expected skips, Node 26.12.1 with concurrency four.
  The complete distribution inventory remained identical.
- [Native console acceptance](../build/native-gen19-final/evidence.json):
  eight CTests, four loader suites and all 16 owned-late named cases passed.
  Current-build preload policy/race fixtures passed 32 cases and 2,662
  assertions. First-host output retains four fields, private joins nine, and
  failed bootstrap emits no success record. These are console/inert-target
  checks, not graphics acceptance.
- Actual-DLL small-stack recovery passed on x64 and Win32 using the same fixture
  binaries as the expected gen17 failures, separately from those counts.
- [Final client suite](../build/preload-client-gen19-action-boundary-final-audit.json):
  374 tests, 370 passed, zero failed, four skipped. Its 36 action-boundary
  datasets across PowerShell 5/7 retain exact-count, missing-release and
  duplicate checks. All 155 SDK distribution files stayed unchanged.

## Nine default-path regressions

All nine distinct ordinary unregistered cases passed across the retained
[initial batch](../build/preload-gen19-default-regressions.json),
[remaining batch](../build/preload-gen19-default-regressions-remaining.json) and
[final x86 batch](../build/preload-gen19-default-regressions-x86-final.json):
D3D11 SDK input, D3D11/D3D12 multi-swapchain, session close, final surface drain,
buffered raw input, attached DPI/OSR configuration, and D3D9/D3D10 x86. Each
x86 backend passed two fresh cycles. The configured DPI/OSR labels do not
independently prove a requested raster/display mismatch was observed.

The first two aggregate reports remain failed historical attempts. In the
first, the display collector exhausted its per-process eight-observation limit
before test four ran. In the next, the D3D9 controller included the legitimate
Ctrl+I release shortcut in its typed-action counting phase. Freezing the action
log before sending the shortcut corrected that phase boundary; counts and
release/duplicate checks were not relaxed, and no runtime/SDK change was made.
Only their three and four passing records, plus the final two x86 passes, are
selected for the nine-case result.

## Retained failures and paired recovery

Generation 17's [first demo attempt](../build/pl/r-20fb93af0e88/report.json)
and [diagnostic repeat](../build/pl/r-d552a294514f/report.json) remain failed.
Empty preload-directory control stayed alive and acknowledged eight Presents;
one- and two-preload controls exited with `0xC00000FD` before a Present
acknowledgement. That control acknowledgement is not pixel/SDK feature proof.

The retained [debugger log](../build/pl/d-b5e0fdf1a7/debug-stack/debug-events.log),
dump identity and [actual x64 disassembly](../build/preload-small-stack-gen17-negative-656890e4e98f4a798d0259ed103975ec/old17-dllmain-prologue-x64.txt)
bind the stack-overflow cause: old `DllMain` reserved 65,888 bytes and probed
the stack before checking the notification reason. Filename classification now
runs behind a non-inlined process-attach helper using bounded heap storage.

The [gen17 negative fixture report](../build/pl/n-012ba2a70b/evidence.json)
has `passed:true` because the expected overflow occurred; neither old candidate
passed runtime acceptance. The [final gen19 wrapper](../build/pl/p-8fe4c30a91/evidence.json)
and actual [x64](../build/ss/r-x64-61acca6c0490/evidence.json) /
[Win32](../build/ss/r-Win32-2bd2bea64f9d/evidence.json) results use the exact same
per-architecture fixture hashes. Both final DLLs exited zero and completed three
worker entry/detach sequences with participant readiness zero. Requested stack
sizes were 16/32/64 KiB; Windows rounds reservations, so these are not claims of
actual 16 KiB reservations. The inert shim loads no real ReShade, graphics,
transport or input path.

Generation 18's [ordering report](../build/pl/r-3d165278d07e/report.json)
also remains failed despite its passing self-load cell. First-host injection
mapped an ordinary private engine plus both registered engines, then activated
the ordinary copy rather than the selected scanned implementation. Generation
19 validates/waits for the owned snapshot and selected scanned module.
The final production cells each have exactly two initial engine modules.
Earlier PowerShell/proof-parser harness failures remain separately recorded;
their reports were not rewritten or counted as positive cells.

## Acceptance limits

No case remains pending in this recorded six-plus-nine demo matrix. The runtime
fix is committed as `3af9c64`; passing demo/test sources are `bb42f57`, following
installer milestone `864554b` and stack fix `a4f9701`. The controller's final
read-only public package verification passed all 154 sealed payloads unchanged.
All owned demo/Electron fixture processes and master display requests were
closed. No new game compatibility claim is made.

D3D11 shutdown logs retain bounded outbound-drain warnings after producers have
disconnected; they are not described as warning-free. Initially dormant add-ons
have no private worker, but consumed session modules and workers intentionally
stay resident. Shared native address space is not fault containment, and no
500-app/version capacity or flat-resource usage was measured.

Preloading is optional and affects a new owned host's snapshot. It cannot make
an initialized host rescan, replace a mapped host or modify foreign ReShade
configuration. Older member-readiness-only injectors may time out on manually
configured stock-only dormant hosts; the accepted compatibility path uses the
latest owned host. Authenticated `ReadyV1` meaning is unchanged. Disablement and
elevation policies have native console/source coverage; no user-managed game
installation was altered to test them.

This diagnosed gen17 CPU stack overflow does not diagnose or retrospectively
close the earlier historical D3D11 GPU hang.
