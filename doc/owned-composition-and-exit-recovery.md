# Owned composition windows and process-exit recovery

Generation 32 extends the owned ReShade host while retaining the existing
feature add-on implementation and build ID. Existing official/foreign hosts
never activate this host policy. The new patch is a reversible, restartable
eight-file tail with exact before/after hashes and a full 26-file source vector;
both architecture manifests bind its implementation digest.

## Composition-window inference

D3D11 composition chains expose a null `OutputWindow`. The owned host may infer
a window only when Windows enumerates exactly one visible top-level window owned
by the current target process. It uses no foreground, size, title, class or game
preference. This is a conservative process-window fallback, not a claim that the
DirectComposition visual graph identifies the HWND. Valid native HWND chains
keep their existing path. D3D10, D3D12 and foreign hosts keep their existing path.

The first binding records the HWND, owning thread and a reserved window-property
token. Each subsequent use requires the same unique visible window, thread and
token. A swap chain never migrates to a different window; destruction removes
the OS property, so an old binding cannot accept a reused HWND. A recreated swap
chain obtains its own binding. Cookie exhaustion, enumeration failure, hidden
windows, lost tokens and ambiguity all refuse inference. A short in-process
mutex serializes token creation, and resolution preserves `GetLastError`.

Unbound owned composition chains defer swap-chain/runtime initialization. They
continue forwarding native Present exactly once. If a previously initialized
chain loses its valid binding, normal reset callbacks retire its surface/input
state. The same lifetime may resume through normal initialization. A deferred
resize retains its resize lifecycle flag. This avoids publishing a null-HWND
surface that the add-on would permanently reject during input setup.

## Immutable owned runtime configuration

The existing owned-stage validation boundary enables the policy before later
runtime creation. Reserved ReShade INIs, generated numbered/VR INIs, the default
preset and owned late-runtime INIs in that exact stage retain transient changes
in the process-local INI cache. Their save operation clears the dirty flag and
succeeds without a filesystem write. It never changes stage ACLs or integrity
labels. Other names and paths retain stock persistence; no foreign installation
is rewritten.

A secondary runtime's GUI save can dirty global `ReShade.ini` while flushing
only its local `ReShade2.ini`. A later global flush then fails against a protected
high-integrity stage read by a medium target and latches the generic save-error
HUD. The owned policy handles both cache entries without requiring disk writes.
The console fixture reproduces this stock failure under an enforced read-only
sharing guard, then verifies unchanged bytes and an unchanged write guard with
the policy enabled. This is separate from actual HUD acceptance in the game.

## Read-only process-incarnation proof

The optional manager operation `--query-process-incarnation PID CREATION_TIME`
opens only query/synchronize rights, reads creation time and tests the same
process handle's exit signal. It returns a versioned record containing the PID,
requested/actual birth and `alive`, `exited`, `reused` or `absent`. Access denial,
invalid identity, unexpected query/wait failures and malformed output never
prove exit.

The SDK uses this additional query only after the exact historical image-query
error 31. That error occurs when another open handle retains an exited Windows
process object after its executable path becomes unavailable. Error 31 alone
remains unknown. The SDK accepts only an absent PID, a different valid birth or
the exact signaled incarnation. Older managers that do not support the optional
operation remain fail-closed. No timeout, socket loss or application shutdown
authorizes reinjection or payload retirement.

Both native architectures run the console/offscreen owned-policy fixture and
the separate ABI, forwarding, diagnostics, callback-chain, owned loader-model
and resource-identity regressions. The source-cache gate tests all publication
boundaries and refusal cases without changing the live cache. The public bounded
maintenance regression recovered all 13 reserved payload entries from the
preserved exited PAGER stage and preserved its extra `ReShade2.ini` bytes.

Actual full-application PAGER rendering, first physical key, warning-HUD absence,
resize/recreation and ambiguity acceptance remain separate packaged-app gates.
`scripts/test-cases/d3d11-composition-window-routing.ps1` launches the true
composition graphics fixture for those runs. No Steam/Overwatch cure is inferred
from this work; generation-31 matched logs already used LoadLibrary and require
a separate owned foreign-hook reproduction before a coexistence correction.
