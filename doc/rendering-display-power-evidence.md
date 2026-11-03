# Rendering evidence and display preconditions

The retained diagnostics distinguish completed overlay composition from desktop
pixel visibility. They establish successful rendering with an observed active
display, including a passing control using the same generation-12 native bytes
that previously produced white desktop samples. They do not establish the cause
of every earlier white sample or the generation-9 GPU device-loss incident.

The compact, portable record is
[rendering-display-power-evidence.json](rendering-display-power-evidence.json).
It contains repository-relative evidence paths, hashes, measured values and
explicit limits. The larger original records remain under `build`.

## What was measured

| Observation | Retained evidence | Meaning |
|---|---|---|
| Generation-12 pointer output, `175959` | Correct red/blue pixels and changing dark host pixels in eight final-backbuffer GPU reads; white desktop GDI samples with matching foreground/point owners; 63 sampled `S_OK` Presents and one initial `OCCLUDED`, no removal reason. | The reproduced discrepancy occurs after overlay composition. Successful sampled submissions do not themselves prove displayed pixel contents. |
| Standalone power query, `1711` | Session and console initial callbacks both report OFF at 17:10:44 UTC. | Direct power-state evidence at that time. Its timestamp is later than the `180716` failed observation; it is not a per-pixel historical power measurement. Additional 17:06/17:09 tool observations were not retained as standalone files. |
| Generation-13 pointer control, `181726` | Strict desktop red/blue equality passes; start/end observations contain ON callbacks; GPU readback agrees. | A genuine external-pixel pass under contemporaneously observed ON conditions. The display was already ON before the lease was created. |
| Generation-12 late-D3D11 control | Identical verified ReShade/add-on/host bytes previously produced a decoded white desktop sample and now pass desktop pixels, synthetic input, resize and shutdown under an observed-ON lease. | A generation upgrade was unnecessary for the passing demonstration. This is not proof that power state caused the earlier failure. |

The latest DWM prefix layout was independently checked against the installed
Windows SDK: pack 1, 292 bytes, including the four-byte `cFramesOutstanding` at
offset 120. In `175959`, QPC vblank timestamps advance 68.9667 seconds while the
observation timestamps advance 68.9352 seconds. Low frame counters therefore
cannot be described as a frozen timestamp. The global timing API is not
per-target display proof.

## Same-native control

The earlier
[1389097d evidence](../build/late-d3d11-adoption/overlay-proof-x64-1389097d37cd4d2dba7d616d9b7747c5/evidence.json)
and passing
[e0b9f007 evidence](../build/late-d3d11-adoption/overlay-proof-x64-e0b9f007e06f41e2927eee59f0172636/evidence.json)
contain the same verified ReShade, add-on, host and recorded host-source hashes.
The earlier record decoded the first desktop sample as RGB 255,255,255 while
four GPU samples contained the expected RGB 198,40,40. It did not retain raw
COLORREF validity, so `CLR_INVALID` cannot be excluded for that older record.
It did not reach input or resize acceptance.

The passing record measured desktop RGB 198,40,40 before and after resizing
800×600 to 960×640, received synthetic DOM input, released input to the host,
and recorded 1,797 render/state checks with zero state mismatches. Its eight
GPU reads all precede resize; post-resize proof is the desktop pixel, geometry
and host evidence. The current controller allows an eight-unit per-channel
tolerance; the retained passing samples exactly equal the requested color.
Historical producer/controller source hashes were not recorded.

The [lease record](../build/display-active-late-d3d11-gen12-control-verified.json)
reports ON before and after creating its request and holds that request across
the test. It proves the observed starting precondition and request lifetime,
not a continuously sampled power state or what woke the display. Both runs are
host-assisted manual adoption with synthetic input; automatic late discovery
and physical-key input are outside this comparison.

Both records contain the same SDK entry hash, but that entry is an export shim.
The current retained SDK validates all 148 manifest entries; a full historical
SDK tree hash and producer/controller hashes were not recorded. Complete
historical SDK implementation equality is therefore not claimed.

## Harness behavior

The pointer, main SDK input and input-capabilities runners acquire a temporary
`PowerRequestDisplayRequired` handle and require an actual session-display ON
notification before starting visual assertions. They retain the request through
cleanup, then clear and close it. An OFF/unknown result is an unavailable test
precondition; it never turns a wrong pixel into a pass. Other controllers can
use `run-with-display-lease.ps1` explicitly. Human-facing launchers remain in
their existing test-case paths.

For a sequential matrix, `run-with-display-lease.ps1 -MasterLease` can retain a
separate request between cases. It requires a fresh stop-file path inside the
workspace build directory and a hold interval of at most 1,800 seconds. It may
arm while its initial power observation is OFF/unknown; that is not a visual
precondition pass. It publishes an armed record immediately, accepts no test
script, and releases on its stop file, deadline or unwind. Its final status is
`completed`, separate from test acceptance. Per-case guards still require ON.
No actor or operation is credited with waking the display merely because this
master request exists.

The observer reads one bounded power notification per whole pixel observation,
not per grid sample. It creates no window, sends no input and changes no power
scheme or override. Microsoft documents an initial current-value callback after
registration and defines session display states as OFF/ON/DIM.
[Power notification API](https://learn.microsoft.com/en-us/windows/win32/api/powersetting/nf-powersetting-powersettingregisternotification),
[display-state GUIDs](https://learn.microsoft.com/en-us/windows/win32/power/power-setting-guids).

The opt-in native diagnostic copies only three pixels from the final D3D11
backbuffer at public `reshade_present`. Default operation allocates or copies
no diagnostic GPU resource. It preserves source usage, reads a private 3×1
staging texture with a completing read Map and logs bounded values. It captures
no full image and changes no rendering decision.

The generation-9 GPU hang remains separate. Its late manual dump and NVIDIA
events establish device loss but do not identify the offending GPU work. The
display evidence does not retrospectively explain that incident or establish
that every older white-pixel failure had the same cause.
