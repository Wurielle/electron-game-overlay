# Stable shared add-on directory acceptance — 2026-11-03

Generation 23 replaces per-run registered-DLL snapshots with one stable flat
shared ReShade add-on directory. The default is the Windows account profile's
`AppData\Local\ReShade\Addons`; `addonDirectory` selects another location. All
validation uses isolated directories. The user's actual registry and games are
not test targets.

Registration atomically publishes complete immutable per-app/build files once.
Subsequent hosts point their private INI at those same files. The catalog lives
under `.electron-game-overlay` inside the shared directory. Ordinary foreign
ReShade add-ons coexist without EGO registration. Unregistering retains files
that games may still have mapped and disables retired EGO filenames in future
owned-host configurations. Existing hosts keep their initialization and modules.

The injector admits a canonical shared directory while retaining owned-host,
reparse, exact selected-file hash and immutable file-handle checks. The owned
host reports its own readiness/adoption errors independently of an unrelated
add-on's scanner failure. The two frozen source tails are independently pinned
through normal builds, staging and sealed package validation. Prior patch
versions and historical source-cache vectors are unchanged.

## Build and SDK checks

- Normal x64 and x86 native builds passed, followed by both console ABI CTests.
- The EGO engine bytes remain identical to RC.12: x64
  `f45ca8feb398fa4caa543a174a393d45e555f9eeac8167fd94b66e1a46da9918`,
  x86 `3850842892b3a00b7cc4cbfa0fd03d105645acb8cf0a0f14f711cc55f03a9f8a`.
  Its BID remains `CCE20935ADD44EF6A5A7973014B2E07F`.
- Both architectures staged and the SDK sealed with 154 payloads.
- All 261 source-cache regression tests passed, including 19 new controls.
- Focused installer/launcher checks passed 217/217; seal/package/staging checks
  passed 232/232. These are overlapping selections of the full SDK suite.
- The final full SDK suite passed: 1,434 tests, 1,424 passed, zero failures and
  10 skips. An earlier run found one public API documentation assertion: the
  deprecated alias had only a JSDoc tag. Its declaration description was
  restored, all three documentation checks passed, and the SDK was rebuilt and
  resealed before the clean full rerun. The correction changes documentation,
  not runtime behavior.

Logs are retained under `build/shared-addon-{native-x64,native-x86,stage-x64,stage-x86,
source-cache-tests,focused-tests,seal-focused,sdk-suite,sdk-suite-final,public-api-docs-retest}.log`.

The uncommitted local npm preview also passed independent tarball extraction,
public package validation, and Node-only installation checks using the real
native payload bytes without executing them. It contains 154 sealed payloads
and 158 packaged files. Tarball SHA-256:
`b3bb39baaf30f0264ddece841714f001b7508e59c12a81e6067f2c4487149b07`.
The original input SDK manifest was unchanged. The report is retained at
`build/shared-addon-package-preview/verification-report.json`. This is a local
preview without a source-commit provenance claim, not a published release.

## Inert native controls

The [native console record](../libs/electron-game-overlay-runtime/tests/shared-addon-directory/evidence.windows-console-20261103.json)
contains source/executable hashes and separate frozen-generation-22 controls:

- Exact injector policy, x64 and x86: nine grouped cases and 744 assertions each.
- Complete extracted owned-host initializer, x64 and x86: 18 cases and 54 assertions each.
- Long-path policy: all 290 conditions, 1,843 assertions, zero skips.

The old-source controls reproduce shared-directory rejection and foreign-addon
failure blocking EGO. Candidate controls retain own callback, ownership, gate
and hook failures. These are console fixtures with inert scanner/graphics seams;
they do not constitute production graphics acceptance.

## Production DX demos

All thirteen final target cases passed using only copied repository demos.
Eleven use the current SDK, and two exercise a retained earlier implementation:

| API | x64 | x86 |
| --- | --- | --- |
| D3D9 | Passed | Passed |
| D3D10 | Passed | Passed |
| D3D11 | Passed | Not part of the repository x86 demo matrix |
| D3D12 | Passed | Not part of the repository x86 demo matrix |

Each of these six cells used genuine public-SDK injection, exact target/process
identity, architecture-correct native handoff, authenticated producers and
read-only OS module observations with full file hashes. The host mapped both
apps' DLLs directly from the stable directory while the second app was offline.
Ordinary successful and deliberately rejected `.addon` fixtures followed stock
ReShade loading rules. A third registered-then-unregistered app's retained files
were disabled in the private INI and absent from the mapped inventory.

Late D3D11 first-host attachment also passed. Its pre-attachment oracle records
successful primary Present calls and zero ReShade/add-on modules before either
producer starts. The native host's foreign-add-on failure warning is compatible
with actual EGO rendering and hook adoption.

The strong D3D11 and D3D12 suites each passed their offline self-load and public
production-injection cells, adding four target cases. They preserve alpha hit
testing, per-window order, caption dragging, cursors, both wheel axes,
interception/release, keyboard isolation, crash survivors, app restart and
unregistration of mapped modules. All six matrix cells also check exact surface
pixels and rendering/input survival after the initiating application crashes.

The unchanged retained-generation-16 compatibility cases passed on D3D11 and
D3D12. An older unregistered implementation joins the new host while the current
dispatcher app is offline, retains its own rendering/input implementation and
interleaved alpha surfaces, and survives the current app crashing. Together,
the thirteen cases cover 30 authenticated producer lifecycles. All final target
exits returned zero without forced termination, and cleanup reports contain no
errors.

Synthetic keyboard tests remain distinct from the physical-key gate waived by
the user. No user game is used.

An earlier D3D10 run loaded/authenticated both modules but timed out on its blue
surface pixel. Its root cause was not established. The failure is retained;
two fresh D3D10 runs subsequently passed exact blue pixels and survivor checks.
The first x86 attempt stopped in the test controller because its x64-only parser
rejected the expected architecture-mismatch diagnostic before x86 success.
The controller was corrected to accept only that exact, pre-injection 706
handoff; its strict console cases and both final x86 graphics cases passed.
Neither issue prompted a production SDK or native-code change.

The compact [graphics evidence record](evidence/shared-addon-directory-acceptance-2026-11-03.json)
retains final and earlier report paths/hashes and cleanup observations separately.

## Merge CI follow-up

The first clean GitHub Actions checkout exposed two CI assumptions that the
prepared local workspace did not exercise. Two historical cooperative injector
patches lacked explicit LF attributes: a `core.autocrlf=true` checkout reproduced
the migration-fixture failures. Pinning those files to LF preserves their exact
committed hashes; both affected suites passed with 118 passes, two expected
retained-source skips and no failures.

The nested migration fixture also creates its own parent directory: SDK-only CI
does not prepare the repository's ignored `build` directory. Its focused case
and both affected suites passed again from a fresh checkout with that directory
absent, without precreating it in test setup.

The installed-package acceptance script also expected the retired standalone
broker manifest. Its existing CI entrypoint now verifies the direct cooperative
SDK seal, all eight architecture-correct native payloads, offline installation,
public Node-only helpers and declarations, afterPack restoration and isolated
shared-directory registration/removal. Both real CI invocation forms passed,
including an exact repack of the preview tarball. Missing installer JavaScript
and missing x86 injector negative controls fail before SDK code execution.
The separate generic consumer and historical controlled broker fixtures remain
unchanged. These fixes do not change mapped runtime code or the tested SDK bytes.

The native process-binding fixture now stages the exact companion EGO DLL beside
each copied injector for mandatory local export validation with
`DONT_RESOLVE_DLL_REFERENCES`. Its remote payload remains the inert owned test
DLL. The complete x64/x86 gate passed locally, and passive observations through
the retained target handle verified that the real EGO member was absent from
all six successful target-module snapshots. Exact process/time rejection and
future-process selection checks remain enabled. No production injector or
feature-engine changes were required.

The pinned-old-SDK popup/video comparison explicitly injects its historical
broker backend at the native factory boundary. Previously it replaced an import
that the new default backend no longer uses. All popup, video, placement,
order-token and reconnect assertions are retained; the complete 17-outcome
matrix passed against the intact pinned old SDK. Reports identify this as a
controlled legacy broker characterization and explicitly exclude execution of
the default cooperative transport or native runtime. Actual cooperative/default
backend acceptance remains the separate SDK transport and DX-demo evidence.

## Limits

ReShade scans only top-level architecture-compatible add-on files. Already
initialized hosts do not rescan; ordinary private attachment remains the fallback
for an app registered after startup. Existing user-managed ReShade configurations
are preserved. Only EGO modules promise dormant behavior while their app is
offline; ordinary add-ons retain their own initialization and callback behavior.
