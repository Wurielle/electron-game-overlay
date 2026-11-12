# Runtime storage

The SDK retains payloads for live or indeterminate attempts. It compacts a run
only after positive non-execution evidence or authoritative exit of the exact
target process. App shutdown, cancellation, socket loss, age and a reused PID
alone are insufficient. Existing ReShade installations and registered foreign
add-ons are outside this storage policy.

## Active payloads

Generation 40 passes watcher policy over the injector's stdin pipe. The SDK
sends a bounded, length-prefixed UTF-8 document and closes stdin. The injector
checks the entire frame before arming. Earlier validated runtimes still use a
private policy file. The streamed policy removes that file from the stage.
The native member's rendezvous and owned host configuration still use the
stage directory.

Generation 41 keeps the owned late D3D11 configuration for each swap chain in
memory. The initial owned host reads the staged `ReShade.ini` template and
validates the stage marker. Its directory-based transport still writes the
startup record. Injector and owned ReShade file logging default to off for
this generation. `createReShadeLaunchConfig({ logging: true })` enables them.

Generation 42 uses the version cache directly for managed ordinary attachments
without registered add-on preloading. The watcher holds the version while
armed. The injector hands the exact process a cache handle before loading and
sends the producer route over its stdin pipe. The target keeps that handle until
Windows ends the process. With logging enabled, the launcher creates a separate
directory containing only injector logs and the owned host's ReShade log when
it initializes a host. A cache preflight that proves the exact target disabled
the official add-on can return the disabled status after read-only path
validation. Other official installation cases that require the native add-on
transaction still enter the legacy stage after a verified preflight rejection.
That flow uses the stage for the restart or startup-wait decision, deferred
maintenance, and directory-based member authorization when needed.

Generation 44 also uses the cache for managed ordinary callers with
`addonPreload` configured. The SDK resolves the exact registered application
and sends the current shared path and retired-filename disable list in a
bounded INI frame after exact target selection. The cached INI stays sealed.
The owned host uses the in-memory settings for its startup scan and the
injector activates the exact registered image through the private memory route.

Ordinary preparation uses a verified content-addressed sibling store,
`<runsRootDirectory>.payloads-v2`. Helpers, ReShade and immutable manifests are
hard links to that snapshot. Package files are never linked directly. Each
participant add-on DLL and each mutable INI has a distinct file identity;
Windows can merge hard-linked DLL paths into one module with shared globals.

Starting with generation 40, ordinary SDK launches publish one verified binary snapshot
per package version in `<runsRootDirectory>.sdk-versions-v1`. The directory key
is the SHA-256 of the exact package version so case-sensitive version identifiers
cannot collide on Windows. The SDK checks the version and all payload hashes
before reusing it. Two different payloads declaring the same version cannot
replace each other. Active stages continue to retain hard-link aliases until
their lifetime evidence permits retirement.

`clearOldReShadeRuntimeCache({ runsRootDirectory })` removes verified unused
snapshots that have strictly lower SemVer precedence than the running SDK. It
returns the versions removed. Active aliases, current and newer versions, and
versions with equal precedence are preserved. Earlier content-addressed stores
lack SDK version ownership and remain outside this operation.

An in-progress preparation holds a hard link to the snapshot's ownership marker.
That lease closes the gap before all stage links have been established. Cache
collection skips leased snapshots and snapshots with any stage aliases. It
quarantines an unused candidate, verifies its complete inventory, hashes and
link counts again, then unlinks it without rewriting bytes or changing file
attributes. A bound collection receipt allows interrupted collection to resume.
Preparations retry if collection won immediately before lease acquisition.

The cache retains at most two **unused verified** versions, plus every version
still leased or referenced by a live/uncertain run. Unknown, corrupt or foreign
entries are preserved, so this limit is not permission to delete arbitrary data.

The new store uses `payloads-v2`. Older SDKs do not acquire preparation leases
in `payloads-v1`, so automatic collection cannot safely race those readers.
That legacy store is left untouched; new SDK runs do not add versions to it.
Moving to the new namespace preserves concurrent older consumers instead of
requiring a coordinated SDK upgrade.

Publication itself has a separate stage-linked receipt, established before any
payload copies. A crashed producer's positively unused stage can release that
lease after exact owner-exit proof. Unleased, never-published copies can then be
removed even when incomplete. Live publication leases and foreign contents are
preserved. Completed publications also recover stale publication receipts.

Generation 43 adds a protected version cache for managed elevated attachment
to the owned host. The native manager creates the directory, thirteen payloads,
and ownership record at high integrity with the caller and System access list.
It verifies the canonical paths, single-link files, labels, and sealed hashes,
then keeps the namespace and files pinned through injector launch. The injector
keeps the existing exact user, session, token, and selected payload checks.
The high cache uses `<runsRootDirectory>.elevated\runs.sdk-versions-v1`.
Explicit logging creates a `logs-*` directory under the protected sibling
`runs`. The host receives a write handle for its log without opening a path
for write from the target token.

The medium and high stores each have one folder per version. High publication
uses the verified package and leaves any existing medium copy in place.
Changing permissions on a medium snapshot would leave previously granted
handles and mapped aliases in use. Medium callers publish and collect in
their own store. The protected store requires a high caller for publication
and collection. Legacy private stages retain their earlier security contract.

## Retirement and diagnostics

Positive retirement removes the run's eight verified executable/DLL/add-on
images, build manifests, private INI, staging lease and private transport/policy
files. Unlinking an ordinary stage removes its directory entries as well as its
private add-on allocation; it does not merely reduce Explorer's sum through
hard links. The cache's bytes, attributes and file identities remain unchanged.
Legacy full copies with an existing strong unmapping marker can be compacted
using their own package digests; missing or mismatching evidence is preserved.

Retired stdout, stderr and ReShade logs retain their last 64 KiB each. The native
startup record is bounded to 256 bytes. Only regular, single-link data files are
trimmed, after unmapping proof. Completed diagnostic bundles retain at most 16
directories, seven days and 4 MiB in total. Only recognized, alias-free diagnostic
bundles are eligible for whole-directory pruning. A foreign entry prevents it.
Interrupted diagnostic-only quarantines resume after the same ownership and
unmapping evidence is checked again.

Each run is maintained independently. A medium caller can read an elevated
run's exit proof while lacking permission to remove its protected metadata.
That run is preserved with a per-directory warning and retried by a later
authorized sweep; it cannot stop compaction or retention of eligible peer runs.
The count, age and byte bounds apply to accessible, recognized diagnostic
bundles. Inaccessible stages and foreign entries can remain outside those
bounds. Maintenance never changes their labels, permissions or ownership.
The synchronous unused-watcher drain removes its fixed private policy,
ownership and transport leaves as well as payloads and cache leases, so its
completed stages become eligible diagnostic bundles without a later API call.
Both consumed-target retirement and unused-watcher drain remove known control
files before deleting payloads. Observing all thirteen payload entries gone
therefore leaves no pending control-file cleanup that early Electron shutdown
could interrupt. A denied or temporarily shared control preserves the payloads
and persisted exit proof for a later authorized sweep; it never changes access
permissions, releases ownership early or treats an incomplete stage as complete.

On normal Electron shutdown, await `OverlayTargetWatcher.disposeAsync()` before
exiting the application. It stops discovery immediately and gives owned launchers
up to five seconds to finish their pending shutdown work. The watcher child must
exit and drain its output without selection or contradictory records before the
SDK publishes unused-run proof. A forced application exit before that callback
can still leave an attempted run without proof. An already elevated consumer can
complete retention of protected diagnostics in its own shutdown or maintenance
sweep. A caller denied write access leaves protected diagnostics at their original
paths for a later authorized sweep.

These bounds cover completed SDK-owned storage. They do not impose an unsafe
expiry on possibly mapped images or unrecognized data.

## Explicit inspection and recovery

```ts
import {
  createReShadeLaunchConfig,
  inspectReShadeRuntimeStorage,
  pruneReShadeRuntimeStorage,
} from 'electron-game-overlay';

const config = createReShadeLaunchConfig();
const before = await inspectReShadeRuntimeStorage({
  runsRootDirectory: config.runsRootDirectory,
}); // Filesystem inspection only: no process queries or deletion.

const after = await pruneReShadeRuntimeStorage({
  config,
  maxRecoveryProbes: 8, // Default 8; range 0..32. Zero uses existing proof only.
});
```

Inspection classifies each run as `unrecognized`, `proven-unmapped`,
`exact-target-recorded`, `prepared-owner-recorded` or `exit-proof-missing`.
Maintenance queries the validated native helper only for a recorded PID plus
creation FILETIME. A different OS-reported incarnation, or the helper's exact
`OpenProcess` invalid-PID response, proves the old incarnation exited. Access
denial, timeouts, malformed responses and later query failures mean unknown.

New runs persist a storage journal before execution. The attempted state is
durable before spawning; native V2 selection records retain the exact target
identity. If the exact producer of an unattempted preparation has exited,
maintenance can establish non-execution. An attempted run needs target-exit
proof or a persisted complete unused-watcher drain. A missing journal update
leaves the attempt uncertain. Legacy V2 stdout
can supply an exact target identity when no newer target record is available.
Maintenance does not release possibly consumed initialization claims early.

The audited older production history had 88 folders, 19 weak retirement markers
and zero `privateImagesUnmapped=true` markers, from generations 2, 3, 22 or
missing metadata. Its roughly 1.5 GB is not evidence that generation 28 created
those copies. A weak marker or age cannot make that history safe to remove.
Folders lacking exact lifetime evidence remain `exit-proof-missing`; there is
no force-delete option. The audit and offline work do not delete user run data.

## Offline validation

`tests/runtime-storage.test.cjs` covers actual SDK prepare/dispose, passive
high-lane file layout, allocation and file identities, cancellation/restart
models, exact OS-query responses, legacy proof, version rollover, concurrent
preparation, collection races and interrupted collection. It executes no payload,
application, game, graphics fixture or foreground input. High-lane filesystem
models do not establish actual token/mandatory-label acceptance.

The storage-only launcher remains
`libs/electron-game-overlay-runtime/scripts/test-cases/runtime-payload-storage.ps1`.
It hashes real payload files without executing them and includes a separate Node
filesystem restart. Its 2026-11-10 measurement used 19,802,976 payload bytes:

| State                                                       | Unique allocated file bytes |
| ----------------------------------------------------------- | --------------------------: |
| One positively unused preparation after retirement          |                  19,836,928 |
| Twelve retired preparations                                 |                  19,881,984 |
| Separate Node restart and retirement                        |                  19,886,080 |
| Thirty-two retirements, with 16 diagnostic folders retained |                  19,898,368 |

Allocation is `stat.blocks * 512` counted once per file identity within the gate's
owned roots. It excludes filesystem metadata. The small increase is bounded
diagnostic/ownership metadata; all retired payload entries are absent. Do not
sum separate root totals when those roots may share hard links. This gate is
storage evidence, not real-game, graphics, physical-key or actual-high acceptance.
