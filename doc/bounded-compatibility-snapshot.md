# Bounded native compatibility snapshot

Generation 31 retains the generation-30 loader correction and failure-only
private-stage diagnostics. Its new read-only snapshot is intended to distinguish
loader choice, early method discovery and the callback path in one exact game
process. It does not claim to resolve the reported Overwatch coexistence failure.

## Records

The normal `ReShade.log` contains at most 17
`EGO_COMPATIBILITY_SNAPSHOT_V1` records per host. Every record identifies its
schema, runtime generation, PID and thread. The exact process creation time and
native payload hashes remain bound by the existing injector/package evidence.

- One `loader` record reports the selected `load-library` or `notification`
  strategy, whether its existing setup completed, and booleans for the Steam
  environment key and architecture's renderer DLL at that decision. No environment
  value is logged. The existing OR condition uses these observed inputs.
- Up to three paired `factory-entry`/`factory-return` snapshots cover the first
  `CreateDXGIFactory2` in owned method discovery, another internal DXGI scope,
  and ordinary application scope. The entry records flags and the actual
  thread-local discovery scope. The return records original/returned interface
  pointers and ownership of their current CreateSwapChain entries.
- Two `native-registration` records distinguish Present and Present1. `current`
  is the installed EGO replacement, `target` is the discovered intercepted entry,
  and `saved` is the actual saved callback returned by the hook manager.
- Four paired `present-entry`/`present-return` snapshots cover the first non-TEST
  proxy/raw Present/Present1. A proxy record's `current` is its current interface
  entry, `target` is its original interface's current virtual entry and `saved`
  is absent because that dispatch is virtual. A raw record's `current` is the
  incoming interface entry; `target` and `saved` identify its existing saved
  trampoline. Return records preserve the actual HRESULT as an unsigned value.

`instance`, `downstreamInstance` and `device` are only already-available interface
pointers. They are not canonical IUnknown identity queries. A raw record leaves
the device absent rather than calling GetDevice or QueryInterface.

Module classes are `reshade-host`, `dxgi`, `d3d11`, `steam-renderer`,
`other-image`, `private-code`, `other-memory`, `absent` or `unknown`.
Classification reports where an address is mapped, not a claim that Steam's
callback executed. Up to two recognized unconditional entry jumps (`E9` and
`FF 25`) additionally report destination class and hop count. Code reads use
self `ReadProcessMemory`, six bytes and at most one pointer per hop. Unreadable
storage is refused; unsupported instructions report `unknown-entry`. This is
neither broader disassembly nor an assertion about the ultimate dispatch path.
No instruction bytes, module lists, file paths, tokens or dump files are emitted.

## Behavior and lock ordering

The observer invokes no callback or COM method, changes no references, and
introduces no loading, retry, timer, setting or executable exception. Original
forwarding, HRESULTs, initialization ownership and stage permissions remain
unchanged. Observation helpers preserve GetLastError, catch log failures and
do not allow logging/allocation exceptions to escape into Present.

The hook manager returns copied callback facts before observation runs. Module
classification and logging occur after its hook-map locks have been released.
Proxy observation runs before its rendering locks and after the original call;
raw observation runs outside the state/context locks inside `present`. Native
registration observation follows hook installation and queued-action completion.
The existing loader registration boundary remains under the loader lock; its
record introduces no hook-map lock. No observer acquires a loader lock while
holding the hook-map lock. Exhausted record guards do not classify, read code,
allocate or log on subsequent frames.

## Console verification

`scripts/test-cases/bounded-compatibility-snapshot.ps1` runs the exact production
helpers against real MinHook detours through an owned foreign DLL and saved
private-code trampolines on x64 or x86. It checks ownership and entry-jump roles,
arguments/HRESULT, one downstream call per invocation, unchanged reference count,
GetLastError, inaccessible reads, an exhausted budget and a throwing log sink.
It creates no HWND, graphics device, target injection, actual Steam frame or input.
The separate Present-forwarding contract retains its existing failure/bypass
cases; the Steam loader model retains its baseline failure and negative controls.

`scripts/test-cases/compatibility-snapshot-source-cache.ps1` runs the actual CMake
tail over one reusable 23-file text fixture in a synthetic Git repository. It
checks all partial-publication boundaries, reverse/replay, idempotence and
fail-closed unknown-edit/file/patch handling. Those fixture commits are isolated
source test data; they do not commit the SDK repository or establish native/game
acceptance. Full source inventory/hash validation remains mandatory.

Use the existing exact-target launcher and preserve its injector output together
with the whole matching ReShade and Steam logs for actual acceptance. Candidate
1007 remains immutable and separately validated. Generation-31 diagnostics must
be distributed as a new complete candidate; no Overwatch or physical-key result
is inferred from these console fixtures.
