# Bounded Present destination diagnostics — generation 37

Generation 37 makes the existing registration and first-Present snapshots
identify decoded jump destinations. It does not change hook registration,
forwarding, rendering, input, loader choice, deferred work, or host ownership.
The feature add-on implementation and build ID are unchanged.

The paired remote candidate-1013 traces showed Steam in every working Present
stack and none of the failing stacks, with RTSS present in both. The first raw
Present log only classified its saved trampoline's destination as `other-image`.
These observations justify resolving that address; they do not establish a
particular hook overwrite, a Steam bypass, or an RTSS defect. The owned
three-party D3D11 fixture passed all 64 x64/x86 cases against unchanged candidate
1013. It did not reproduce the actual Steam D3D12 failure.

## Diagnostic contract

Existing current/target/saved callback entries retain their original fields and
add `addressDetailsVersion: 1` plus `JumpFirst`, `JumpSecond`, `JumpDestination`,
`JumpAllocationBase`, and `JumpAllocationOffset`, prefixed by each entry name.
The allocation offset is hexadecimal. An allocation base can identify private
code and must not automatically be interpreted as an image base.

The same observer reads at most two direct E9 or indirect FF25 jumps, with six
instruction bytes and at most one pointer read per hop. It records the endpoint
actually inspected, including an unreadable endpoint; it does not decode an
arbitrary trampoline or guarantee that two hops reach the final callback.
Three bounded VirtualQuery calls add endpoint allocation ranges. No memory is
written and no callback or COM method is invoked by observation. Null, malformed,
unreadable, cyclic and page-boundary inputs are covered by the native fixture.

Record sites, first non-TEST role gates, discovery exclusion, exception handling,
GetLastError preservation and the existing 17-record fixture bound remain.
There is no new first-use site, polling, timer, worker, module load, hook rewrite,
game-specific exception, or interaction with a foreign ReShade installation.
Module/range observations can race unload and require a separately qualified
same-process module map. The capture does not identify a later Steam load if the
first recorded Present precedes that load.

## Build identity and validation

The new terminal patch is `reshade-present-destinations.patch`. Its exact digest
is required by both native build stamps, SDK staging and the distribution
validator for runtime generation 37. Older packages retain their prior meanings.
The verified source-cache tail recognizes only exact generation-36/37 file states
and supports interrupted publication and reverse/replay; unknown edits, extra
files and altered patch inputs fail without being replaced.

The patch modifies the snapshot header plus generation labels in the existing
composition-binding and reset diagnostics. It leaves the raw hook manager and
the mapped feature add-on implementation unchanged. Candidate 1013 and all
prior source archives and acceptance reports remain immutable.

Dedicated launchers under `libs/electron-game-overlay-runtime/scripts/test-cases`
include `bounded-present-destinations.ps1`,
`present-destinations-source-cache.ps1`, and
`late-foreign-present-readback-current.ps1`. The original proposal launcher and
generation-36 GPU launcher retain their historical inputs. SDK validation also
covers missing, malformed and mismatched destination-patch provenance for both
architectures.

Root owns consumer integration and game acceptance. A root-selected fresh
failing lifetime should bind direct candidate hashes, PID/birth, the new bounded
log and a full read-only module base/size map of that same process. Correlate raw
registration, first proxy/raw Present and Steam startup times before assigning
any destination to a module. Another identical passive trace pair is not needed
just to resolve the existing address gap. Successful fixture GPU readbacks or
Present HRESULTs do not establish automatic-toast/full-panel acceptance; no
synthetic input is physical-key acceptance.
