# RC.10 registered add-on long paths

Consumer follow-up on 2026-11-03: the original long-profile case now loads and
registers the DLL, but activation still fails with owned late D3D11 error
`0x15` (`ERROR_NOT_READY`). Fresh short-profile positive and negative controls
pass. RC.10 is therefore not accepted for the original long-profile case. The
[RC.11 investigation](sdk-rc11-preload-activation.md) addresses that separate
readiness failure. The original RC.10 package and source snapshots are retained.

The consumer's unchanged RC.9 SDK failed during a fresh D3D11 test when the
registered add-on's complete path was 289 characters. A fresh shorter profile
produced a 233-character path and passed that consumer test and its separate
negative control. ReShade initialized in the failed run, so its observer's
`nativeInjectionExecuted: false` classification is not proof that no injection
occurred. No structured native result or numeric loader error was captured in
that historical failure.

An independent inert Windows console fixture reproduced a matching mechanism.
The target explicitly declares `longPathAware=false`. At paths of 259, 260, 289
and 320 characters, ordinary `LoadLibraryW`, stock scanner `LoadLibraryExW`
flags and the native participant thunk failed with Windows error 206 before
mapping. The exact extended path spelling succeeded at all five tested lengths,
including the 233-character control. Both Windows module-path queries preserved
that spelling. Prefixing the load alone while keeping an ordinary expected path
mapped the DLL but correctly failed identity validation with error 123.

This establishes the SDK loader failure mechanism; it does not prove that the
historical consumer failure has no additional cause.

## Correction

The SDK writes an extended Windows path into each newly created private host's
`AddonPath`. Stock ReShade's directory iterator preserves it in each filename,
allowing dormant offline peers to load through its ordinary scanner. Source
package INIs and user-managed installations are not rewritten.

The injector similarly prefixes an owned snapshot DLL's load path. Already
mapped preloads retain the path representation reported by Windows, preserving
old/new host compatibility. It compares subsequent module identity against a
local immutable expected path, independent of the returned remote arguments.
Snapshot admission accepts only the two exact spellings of the same owned
directory. Canonical stage, reparse, marker, pinned handle and full hash checks
remain mandatory.

The new patch changes only `tools/injector.cpp`. Native generation is 20;
the mapped add-on implementation, bytes, build ID
`CCE20935ADD44EF6A5A7973014B2E07F` and cooperative ABI remain unchanged. Normal
builds relink ReShade, so the newly recorded host DLL hashes differ from RC.9.
The new patch hash is
`FFFF684D2E60D36F1CEC4D073B91A014B7F497A50C4F5B00F7B7F2A57714397B`;
the normalized final injector source hash is
`91D82243D81D2CDC082DA1AF9BFF55A13315BF59F1FE5F9ACA1DFAE8442C8A10`.

Generation-20 packaging requires the exact new patch provenance on both
architectures and its literal sealed SDK implementation marker. Retained
generation-19 packages remain valid without that capability. Cached source
migration recognizes the complete known generation-20 vector, validates all
terminal patch pins, and atomically reverses/reapplies the new tail under the
existing lock. Unknown edits remain untouched. Historical generation-19 pins
and migration meanings are unchanged.

## Validation boundary

The [evidence record](evidence/sdk-rc10-preload-long-path.json) records the final
SDK, build and package checks. The retained native reports distinguish loader
behavior, selector policy and actual overlay acceptance.

The 45 fresh loader/scanner children include ordinary, extended and deliberately
mismatched controls at 233/259/260/289/320 characters. The policy fixture passes
290 selector cases and 1,833 assertions: 20 admissions and 270 rejections,
including all 30 actual reparse controls, with no skips. No explicit remote
mutation call occurs in either fixture. SDK staging tests cover registered
paths beyond 300 characters, unchanged source templates, comma escaping and
prefixed participant proof. Both native architectures build and pass their
console ABI smoke test.

The complete SDK suite passes 1,276 of 1,286 tests, with zero failures and ten
expected skips, using concurrency four. It includes the retained 203 frozen
source-cache tests and nine new generation-20 cache cases. The complete sealed
SDK contains 154 payloads. Final tarball hashes, source snapshot provenance and
offline installed-package validation are retained separately in the release
directory so they do not create a self-referential source manifest.

This is a local, uncommitted/unpushed RC.10 candidate based on commit
`f51777621927ff090d0281ad069b720ed553d589` plus its exact working-tree source
snapshot. No Izabela files, running applications, games or security settings
were changed. No graphics test ran for this correction. The original consumer
long-profile D3D11 positive and separate native-focus negative control remain
pending; install or test a replacement in that workspace only when authorized.
Existing runtime base-path limits are outside this registered-filename fix.
The paused Windows 299 investigation remains paused.
