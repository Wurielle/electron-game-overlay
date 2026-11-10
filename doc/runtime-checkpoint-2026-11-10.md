# Runtime checkpoint, 2026-11-10

This is a work-in-progress source checkpoint. It is not a release candidate or
evidence that the actual PAGER or Overwatch acceptance failures are fixed.

## Integrated generation 31

The build and distribution contract remains generation 31. The integrated work
adds the loaded Steam-renderer loader guard and bounded compatibility snapshots,
with exact patch/source provenance, separate native fixtures and dedicated
launchers. Snapshot records describe hook ownership and forwarding; they do not
prove that Steam rendered its overlay.

Candidate `1.0.1-alpha.2026111008` is immutable. Its package SHA-256 is
`61cccbe098112caf6eca34651cfb209e2f92d585e87d295a20ce216576b22ed7`.
Both architecture builds and native console fixtures passed. The offline run
reported 805 passes, one cleanup failure and one unavailable historical fixture
skip; the unchanged launcher suite subsequently passed all 248 checks.
Consumer package checks, packaged smokes and controlled graphics cases passed.

Actual full-application PAGER acceptance failed at both high and medium integrity:
the composition swap chain exposes no HWND, no target surface was published and
input routing failed. The earlier transport/WebGL probe did not establish the
actual application's scene rendering. Only the high-integrity run displayed the
ReShade configuration-save warning. Actual Overwatch still lacked its Steam
overlay; fresh generation-31 logs show that it already selected LoadLibrary, so
the missing environment guard does not explain that failure.

## Unfinished follow-up source

- `reshade-owned-composition-policy.patch` is an unintegrated prototype. It
  proposes a null-HWND fallback to exactly one visible top-level window belonging
  to the target process, lifetime-token checks and refusal of ambiguous windows.
  It also proposes keeping reserved owned-stage INI changes in memory. It has
  not been added to the CMake patch/provenance pipeline or built and validated.
  Its diagnostic generation is intended for a future generation 32.
- The D3D11 test host adds a true DirectComposition swap-chain mode and a
  separate composition executable target. The new mode still needs native
  compilation, a dedicated human-facing launcher and renderer/input acceptance.
- The manager adds an optional read-only process-incarnation query. SDK recovery
  invokes it only after the exact image-query error 31, and accepts only strict
  PID/creation-time evidence of exit, absence or reuse. This addresses retained
  exited process objects whose image path can no longer be queried. Native
  compilation, retained-handle regression coverage and public maintenance
  validation remain pending; error 31 alone never permits retirement.

The feature add-on implementation and its build ID are unchanged. No generation
32 package has been produced. Further work must integrate and pin the new host
patch, bump runtime generation, build both architectures, verify native and SDK
regressions, and obtain actual scene, input, resize/recreation and ambiguity
acceptance before declaring these follow-ups complete. Existing ReShade
installations and uncertain process ownership must remain fail-closed.

## Checkpoint verification

The current source passes TypeScript checking and all eight stage/provenance
guard tests. Those checks do not validate the unfinished native changes.
Generated binaries, candidate archives and machine-specific logs remain outside
Git; the earlier immutable candidates retain their separate source captures.
