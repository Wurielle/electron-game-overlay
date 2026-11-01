# rc.4 fractional scaling

Local candidate: `electron-game-overlay-0.1.0-rc.4.tgz`, runtime generation **6**,
add-on build ID **1CAEA7482B41451AB31FC2F91B46F2DD**. Includes the
[rc.3 wheel/cursor fixes](sdk-rc3-wheel-and-cursor.md).

## Raster and coordinate contract

Electron 42+ defaults offscreen rendering to scale 1 independently of the display.
Electron 46 paint/capture NativeImage size is in truncated DIP while the bitmap
contains the selected representation pixels. rc.3 assumed display DPI was the
raster scale and treated getSize() as pixel dimensions. At 125%, this rejected a
real 600x480 raster against an expected 750x600 before input could be validated.

rc.4 separates window bounds in Electron DIP, existing NativeImage representation
pixels, and the destination rectangle in physical game-client coordinates. Native
compositing already supports independent texture and destination dimensions; no
required wire field or protocol major was added. Input is localized in physical
coordinates and divided by the display scale tag, including both wheel axes.
Wheel deltas retain their original units.

The SDK reads an existing representation only. It checks bitmap byte count against
that representation scale and truncated DIP extents. Rare ambiguous extents use
the same representation PNG IHDR for exact dimensions. It never creates a missing
representation, resamples a paint, or labels a small buffer as a larger raster.
Contradictory dimensions fail closed. Existing stale-frame and resize barriers
remain active. Float-valued scales use the existing integer micro-scale contract
when converting raster extents to physical placement.

Modern Electron registrations retain immutable OSR scale independently of monitor
changes; Electron 39 retains its display-derived raster contract. The constructor
preserves explicit offscreen options. SDK-created windows default to
thickFrame:false so Windows hidden resize borders do not add a different OSR
viewport. Caller-owned BrowserWindows retain caller settings.

For a 600x480 window on a 125% display, genuine Electron 46 native acceptance
verified these independent quantities:

| OSR scale | Actual bitmap | Bytes | Physical destination |
| --- | --- | --- | --- |
| default 1 | 600x480 | 1152000 | 750x600 |
| explicit 1.25 | 750x600 | 1800000 | 750x600 |
| explicit 1.5 | 900x720 | 2592000 | 750x600 |

## Native hook correction

Validation also exposed Win32 error 126 during same-process hook installation.
Both target-thread SetWindowsHookExW calls now pass NULL for hMod, as required
for callbacks installed on a thread in the current process. Native generation,
add-on ID, injector exact pin, staging pins and terminal source hash advanced
together. Successful reports verify the mapped add-on SHA-256. Running older
runtimes are never replaced; controlled targets were newly launched.

## Validation

- Complete x64/x86 SDK/native build with pinned Node 26.12.1: passed.
- SDK suite: **699 passed, 9 skipped, 0 failed**, `build/rc4-final-sdk-tests.log`.
- Packaging tests including actual npm archive provenance: **19 passed**,
  `build/rc4-final-package-tests.log`.
- Rust transport: **108 passed per architecture**, x64 and x86.
- x64/x86 transport ABI smoke: passed, transport version 1.
- Demo TypeScript check: passed.
- Independently compiled v1 mixed-package acceptance: **5/5**, mutation controls
  and clean rerun passed; `build/rc4-mixed-package.log`.
- Installed archive, strict consumer types, sealed payload verification and genuine
  Electron 46 DOM smoke: `build/sdk-rc4-scaling/consumer-electron46.json`.
  This smoke does not itself inject; the native cases below do.

All **20** native cases below passed actual composited red/blue pixels at scaled
CSS coordinates, real Windows text/hand/resize cursors, pointer-dependent cursor
restoration, nested/outer wheel scrolling on both axes, partial/reverse deltas,
wheel coordinate localization, no-click typing on first show/reopen, and release
to the game. Each human-facing case has its own test-cases launcher. Reports and
source-calibration images remain under build/.

| Electron | Native case | Report directory | Result |
| --- | --- | --- | --- |
| 46.0.0-alpha.2 | d3d11 x64, display 1.25, OSR 0, attached=True, legacy | native-pointer-20261031-111137 | passed |
| 46.0.0-alpha.2 | d3d11 x64, display 1.25, OSR 0, attached=False, legacy | native-pointer-20261031-111152 | passed |
| 46.0.0-alpha.2 | d3d11 x64, display 1.25, OSR 1.25, attached=False, legacy | native-pointer-20261031-111158 | passed |
| 46.0.0-alpha.2 | d3d11 x64, display 1.25, OSR 1.5, attached=True, legacy | native-pointer-20261031-111203 | passed |
| 46.0.0-alpha.2 | d3d11 x64, display 1.5, OSR 0, attached=False, legacy | native-pointer-20261031-111209 | passed |
| 46.0.0-alpha.2 | d3d9 x64, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111215 | passed |
| 46.0.0-alpha.2 | d3d9 x86, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111221 | passed |
| 46.0.0-alpha.2 | d3d10 x64, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111226 | passed |
| 46.0.0-alpha.2 | d3d10 x86, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111232 | passed |
| 46.0.0-alpha.2 | d3d11 x64, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111237 | passed |
| 46.0.0-alpha.2 | d3d12 x64, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111243 | passed |
| 46.0.0-alpha.2 | d3d11 x64, display 1, OSR 0, attached=False, wm-input | native-pointer-20261031-111248 | passed |
| 46.0.0-alpha.2 | d3d11 x64, display 1, OSR 0, attached=False, raw-buffer | native-pointer-20261031-111253 | passed |
| 39.8.10 | d3d11 x64, display 1.25, OSR 0, attached=False, legacy | native-pointer-20261031-111312 | passed |
| 39.8.10 | d3d9 x64, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111319 | passed |
| 39.8.10 | d3d9 x86, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111324 | passed |
| 39.8.10 | d3d10 x64, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111330 | passed |
| 39.8.10 | d3d10 x86, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111335 | passed |
| 39.8.10 | d3d11 x64, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111340 | passed |
| 39.8.10 | d3d12 x64, display 1, OSR 0, attached=False, legacy | native-pointer-20261031-111346 | passed |

Initial diagnostic attempts before the successful idle-input runs remain in
build/native-pointer-20261031-110553 and -110636; they failed the on-screen pixel
check and are not counted as passes. Final complete runs above include all checks.

## Artifact and source provenance

The candidate is local and uncommitted on feat/sdk-release-candidate, based on
1ff4baeb5930bb20d6dff0d8e69ca05c8eb8be98. That base commit is not claimed as the
source revision of this modified archive. SDK_PROVENANCE.json records dirty-source
snapshot and per-file manifest SHA-256 values, plus both native build identities.
The source ZIP contains all tracked and unignored source files at packing; the
manifest and Git binary diff provide exact bytes and base comparison.
Candidate checksum and packaging result are in build/sdk-rc4-scaling/sdk-preview-report.json.
No package was published, no commit created, and no PR merged. The running Izabela
instance was untouched.

Custom bitmap cursors still fall back to the system arrow. Real multi-monitor
physical moves were not exercised; scale transitions and stale-raster behavior
are covered by unit tests. Supported game restrictions and existing-ReShade
fail-closed rules remain those of the SDK attachment guide.
