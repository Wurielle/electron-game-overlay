# Owned deferred D3D11 gate

`node run-gate.cjs x64 all` (or x86) runs the normal production host against the
immutable 1012 missed-adoption baseline. It creates real hardware devices with
hidden HWND swap chains or a null-HWND composition chain and a visible-style
presentation window verified outside all monitors. The latter is shown with
SW_SHOWNOACTIVATE; foreground and offscreen placement are checked. It does not
attach a DirectComposition visual, launch games, activate a window or
send input. Individual launchers select each production case; parameterized
execution is internal automation.

The contended case holds the actual production delayed-scan mutex at one owned
GetModuleHandleExW API barrier. The first original device/chain succeeds while
the mutex is held. After publication the production host must adopt that same
chain on a later Present. The baseline returns 3/gatePassed:false. Passing the
orchestrator's expected-baseline assertion never relabels it as runtime success.

The contended-composition case exercises the same missed-first-device boundary
with a real BGRA composition chain. GetDesc/GetHwnd confirm its absent native
HWND. The runtime callback must resolve exactly the offscreen presentation HWND,
paint/read the original backbuffer, resume after resize, and retire normally.
Both contended cases retain failing 1012 baselines on each architecture.

A second owned API observer wraps QueueUserWorkItem only for calls originating
in the loaded host. It forwards the opaque callback/argument once and signals a
test-owned event after callback completion. It checks owner, flags, thread
separation and one queue attempt. Queue-failure injection returns an actual
failed API result. No production test exports or private layouts are required.

Callback counters use fixed size/version POD. A registered reshade_present
callback paints the actual D3D11 backbuffer red and performs a native GPU
readback. Separate green readbacks prove the original chain remains usable.
Present/Present1 flags, exactly-once forwarding, a forced downstream error,
resize/resume and final lifetime retirement are checked. Automatic proxy
controls must not be manually adopted. Foreign, unready, no-backend, queue-error
and revoked stage/readiness cases remain inactive.

The notification control clears SteamOverlayGameId only in its own fixture
process, requires no Steam renderer image, and checks that the notification
lane keeps automatic runtime rendering with zero deferred work items.

`run-prototype.cjs` explicitly selects the unsealed experimental shadow DLL,
whose fixed POD observation exports are test instrumentation only. Prototype
evidence version 2 was sealed before subsequent production-gate changes.
`source-cache-gate.cjs` exercises the exact normal CMake tail's reverse/replay,
partial publication, idempotence, unknown-source, extra-file and altered-patch
refusal in an isolated synthetic Git fixture. That is distinct from runtime,
production package, actual-game, Steam and physical-key acceptance.
