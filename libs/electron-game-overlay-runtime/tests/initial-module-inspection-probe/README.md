# Early module-inspection console probe

This Windows/MSVC x64/x86 probe includes a frozen configure-time copy of the
exact injector source and directly calls `inspect_cooperative_host`. The
production injector entrypoint is renamed and never executed. Allocation,
process-memory writes, remote threads and cross-process handle transfer are
compile-trapped and must remain unused.

Every target is a fresh owned instance of this inert console executable. The
observer retains a read-only process handle and checks its PID, authoritative
creation time and full image identity before every inspection. Anonymous
inherited events let the child announce that its own `wmain` has run and then
exit on request. Only the handle returned for an owned child can be terminated
as an exceptional cleanup fallback; no other process is selected or affected.

Two controlled children begin with `CREATE_SUSPENDED`, for 8 ms and 250 ms,
then resume. Thirty-two more children start normally and are inspected as soon
as their identity is verified. An optional adjacent inert DLL enables four
150 ms child-local load/free windows, each followed by an explicit stable state.
Each observation records the exact helper's
result, module-enumeration error/required bytes, remote-read failures, elapsed
time, child-main state and retained identity. The native API results establish
whether a real uninitialized loader can produce error 299 before eventually
becoming inspectable. No ReShade, actual add-on, graphics target, game or
consumer application runs, and no security setting changes.

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/initial-module-inspection-probe `
  -B build/initial-module-probe-x64 -G "Visual Studio 17 2022" -A x64 `
  -DINJECTOR_SOURCE="$PWD/build/electron-game-overlay-runtime/_deps/reshade-src/tools/injector.cpp"
cmake --build build/initial-module-probe-x64 --config Release
$root = Join-Path $PWD ('build/im-probe-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
& build/initial-module-probe-x64/Release/initial_module_inspection_probe.exe --root $root `
  --churn-member "$PWD/build/initial-module-probe-x64/Release/initial_module_churn_member.dll"
node libs/electron-game-overlay-runtime/tests/initial-module-inspection-probe/verify.cjs `
  (Join-Path $root report.json) build/initial-module-probe-x64/included-injector.cpp
```

Use a separate build directory and `-A Win32` for the x86 run. The fresh evidence
root must be an immediate `im-probe-*` child of this SDK's canonical `build`
directory. Reports and verification records are retained. These observations
are separate from deterministic recovery-policy tests and actual target/game
acceptance; a suspended child is a control, not a claim that a game is suspended.

If the included source defines the new initial read-only recovery helper, the
same binary additionally executes that exact helper against real retained child
handles: steady process, suspended/resumed during the call, persistent suspension
until the recovery deadline, and authoritative owned-child exit during the call.
One short-lived controller thread resumes or stops only that owned child. The
exit control deliberately terminates its own suspended child through the
retained creation handle and records that control operation separately. It does
not terminate any remote loader thread or infer exit from timeouts.

With the churn member supplied, up to sixteen additional owned children sample
the new helper until its own telemetry records a real 299-to-success recovery
during child-local DLL churn. This is a bounded observation strategy, not a
synthetic API failure. The controller ends local churn after 75 ms; the child
then remains alive until cleanup. No DLL is loaded remotely by the observer.

For candidate acceptance, pass the following final verifier flag; it rejects a
binary that skipped the new helper or did not record actual churn recovery:

```powershell
node libs/electron-game-overlay-runtime/tests/initial-module-inspection-probe/verify.cjs `
  (Join-Path $root report.json) build/initial-module-probe-x64/included-injector.cpp `
  --require-recovery
```

## Observed evidence on 2026-11-03

Baseline source normalized SHA-256:
`91D82243D81D2CDC082DA1AF9BFF55A13315BF59F1FE5F9ACA1DFAE8442C8A10`.
The suspended controls produced actual enumeration error 299 and later became
inspectable on both architectures. In the first simple x64 run, normally
started children did not return 299; the x86 run returned it on all 32 first
inspections. This is not a claim that natural startup always fails.

With child-local inert DLL churn, x64 recorded 586 helper errors 299: 17 from
enumeration and 569 from real remote-export memory reads. The x86 run recorded
514: 53 enumeration and 461 remote-read failures. All observed children settled
and exited; the reports retain successful and failing observations.

- x64 baseline: `build/im-probe-churn-x64-424af15b/report.json`, SHA-256
  `A675C0FD01DD77E8D2B5CFCE8B6DF1652631C5073C546B9227558DBB06F98875`.
- x86 baseline: `build/im-probe-churn-x86-12624ac0/report.json`, SHA-256
  `E3BF74C8AC0D738E9C00C3EF09548BF815F8E5AB1798E6AF893C321AF79A0084`.

Candidate source normalized SHA-256:
`58ED5A9C5F0B0806D7D4AE65D060271AD8D62676A62332F0BE6FEAD88B6D8BFA`.
Both final candidate runs verified all four fixed recovery controls plus an
actual 299-to-success churn recovery. Steady processes completed in one attempt.
Suspended/resumed children recovered after 9 attempts in 110 ms on x64 and
125 ms on x86. Persistent suspension returned 299 at 250 ms. Authoritative exit
returned 1067 after 31 ms. Real churn recovered in two attempts. No trapped
allocation/write/remote-thread/handle-transfer operation occurred, and every
owned child exited.

- x64 candidate: `build/im-probe-candidate-x64-644a0387/report.json`, SHA-256
  `C7EF2A041983E064506E63CD1B1798FE31F8E771B106565995214300F0AF8DC6`.
- x86 candidate: `build/im-probe-candidate-x86-f9a5f9a9/report.json`, SHA-256
  `AB8AA83EA50BBA2ED4A4A9717784C2A65B8CB2FFBB20E4EE3DBB6DDD8FA7CFE2`.

The candidate also rejects successful enumeration with zero module bytes. For
example, a fresh x64 child returned enumeration success with zero bytes before
its main function ran; the old helper treated that state as clear. The candidate
reports a transient partial copy instead. Raw reports keep this distinct from
an enumeration API failure or a remote-read failure.

Microsoft documents that module enumeration may fail when the loader's module
list is not initialized or changes during the query:
[EnumProcessModules](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-enumprocessmodules).
