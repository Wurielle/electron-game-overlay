# Runtime storage

The SDK retains payloads for live or indeterminate attempts. It compacts a run
only after positive non-execution evidence or authoritative exit of the exact
target process. App shutdown, cancellation, socket loss, age and a reused PID
alone are insufficient. Existing ReShade installations and registered foreign
add-ons are outside this storage policy.

## Active payloads

Ordinary preparation uses a verified content-addressed sibling store,
`<runsRootDirectory>.payloads-v2`. Helpers, ReShade and immutable manifests are
hard links to that snapshot. Package files are never linked directly. Each
participant add-on DLL and each mutable INI has a distinct file identity;
Windows can merge hard-linked DLL paths into one module with shared globals.

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

The elevated lane retains generation 28's native security contract: all thirteen
payload files are private, single-link, explicitly caller-owned and high at
birth. The native manager verifies their labels, ownership and expected hashes
before preparation completes. Elevated staging reads verified package bytes
directly and does not create or read a redundant medium snapshot. The two fixed
diagnostics leaves remain the only medium-label exceptions. No protected high
cache, new aliases, relaxed verifier, label changes or privilege changes are
introduced by this storage change. Sharing high payloads would require a new
native capability and separate actual-high acceptance. These copies are
transient; completed runs retain none of the thirteen payload files.

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
proof. A missing journal update leaves the attempt uncertain. Legacy V2 stdout
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
