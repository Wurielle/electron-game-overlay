# Bounded Present destination diagnostic proposal

The frozen proposal below remains independently testable. Generation 37 now
integrates its address fields and new generation labels through the production
patch/source-cache sequence; see `doc/present-destinations-diagnostics.md` at the
repository root. `bounded-present-destinations.ps1` tests the integrated header;
the proposal launcher reconstructs its exact generation-36 basis in scratch.

This is an **unapplied diagnostic proposal**, based on generation 36. It is not
part of the runtime build, source-cache patch sequence, package, or candidate
1013. The runner applies `proposal.patch` only to a pinned header copy under
`build/overlay-compatibility/snapshot-destinations/<architecture>/proposal`.
The original cache and sealed candidates remain unchanged.

## Evidence and source conclusion

The remote November 11 passive ETL pair consistently contains
RTSS → Steam → DXGI in the working Present stacks and ReShade → RTSS → DXGI
in the failing stacks. Those are observed stack subsequences, not complete
call graphs. The failing first-Present log identifies a saved private trampoline
whose second decoded jump ends in `other-image`, but it does not record that
destination's address. It therefore cannot identify that destination as RTSS,
Steam, or another image, or determine where the paths diverged during startup.

Source inspection found that the proxy calls `_orig->Present` while
`g_in_dxgi_runtime` is true. The raw shim resolves its registered hook's saved
trampoline; the nested runtime guard forwards directly to it without adopting
the proxy chain again. MinHook preserves an existing external branch when
constructing its trampoline. These observations do not establish that later
foreign hook installation is always preserved or reproduce Valve's code.

The existing actual-runtime GPU fixture now also supports immutable generation
36 in separate output/stage directories. All 32 cases passed on each of x64 and
x86: an optional independently installed earlier detour, production ReShade
proxy/raw hooks, and a later independently installed inline or vtable renderer.
Every case exercised Present and Present1, exact original identities, once-only
forwarding, native/forced HRESULT propagation, and GPU readback. Per architecture,
2,820 assertions, 96 green and 32 disabled-rendering red readbacks passed.
This is D3D11 fixture coverage; the remote paired trace is D3D12. No actual Steam
code or game ran. No production defect was reproduced to justify a workaround.

## Prepared observation

The patch adds the first and second decoded destination, final observed address,
and its allocation base/offset for each existing current, target, and saved
pointer. Owner categories remain unchanged. An allocation base is not necessarily
an image base: `private-code` remains private. Correlate addresses with an
exact-process module-range snapshot.

The observer retains the two-hop limit and six-byte instruction reads, with at
most one pointer read per hop. It does not decode arbitrary instructions or
promise to reach the end of a longer chain. It adds at most three `VirtualQuery`
calls to an already-selected callback snapshot. No new logging site, per-frame
poll, worker, timer, module load, hook mutation, COM call, target reference, or
memory write is introduced. Existing first-non-TEST role gates and the 17-record
fixture bound remain unchanged. Errors and allocation/logging exceptions preserve
`GetLastError` and cannot escape the observer. Mapping observations are not atomic
with module unload; a module-range snapshot must remain independently qualified.

The proposed header still declares its generation-36 **basis**. It must not be
shipped as generation 36; integrating it requires a new exact host generation,
patch/source digests and package stamps. The feature add-on implementation is
unchanged; if integration changes it, its exact build ID must also change.
Existing or foreign ReShade hosts must never be patched.

## Reproducible local validation

Run each launcher once for `-Architecture x64` and once for `x86`:

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/bounded-present-destinations-proposal.ps1 -Architecture x64
& ./libs/electron-game-overlay-runtime/scripts/test-cases/late-foreign-present-readback-gen36.ps1 -Architecture x64
```

The proposed observer passed 98 assertions and emitted 17 records on each
architecture. It exercises a real independent DLL detour and private trampoline,
known module/range equality, direct and indirect branches, a two-hop cycle,
null/unreadable addresses, a cross-page read into PAGE_NOACCESS, unchanged
arguments/results/reference counts/last-error, and logging/allocation failures.
No test jump-buffer bytes are executed. The unchanged observer separately passed
80 assertions and 17 records on each architecture. The runner also parses and
checks the logged destination fields.

## Exact integration and observation plan

1. If integrating this diagnostic, allocate a new owned-host generation and
   extend the verified patch/source-cache sequence, both architecture stamps,
   packaging pins and matching tests. Preserve candidate 1013 and prior evidence.
   Build both architectures without changing feature behavior.
2. Run the observer gates against the integrated header, production
   Present-forwarding gate, source-cache/identity/ABI policies, loader/bootstrap
   and deferred-startup controls, and actual-runtime three-party GPU matrix
   against the new DLLs. Include notification and LoadLibrary paths, nested and
   DllMain controls, revoked stage/readiness, and foreign-host negative cases.
3. Root owns normal/elevated local game integration and remote interaction.
   Retain functioning-game rendering/input and first-open/reopen checks before
   interpreting a remote diagnostic. No new user action is requested here.
4. On a root-selected fresh failing lifetime, collect the bounded log, exact
   PID/birth, direct binary hashes, and a read-only full module base/size snapshot
   of that same process. No duplicate passive ETL pair or input is required just
   to resolve this jump-address gap. Correlate raw registration with first
   proxy/raw Present and the Steam startup log.
5. Verify that first captured non-TEST Present is after Steam renderer loading;
   the proposal adds no later-first-use trigger. If it precedes loading, or two
   hops still end in private code, report that limitation rather than infer
   bypass. If destinations identify a reproducible broken transition, model it
   in an owned regression before changing hook behavior. Successful Present or
   loaded Steam is not toast/panel acceptance. Synthetic input is not a physical
   key gate.

No commit, push, release, new production runtime build, remote operation, or game
acceptance is part of this proposal's validation.
