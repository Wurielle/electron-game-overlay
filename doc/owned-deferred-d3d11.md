# Owned deferred D3D11 adoption

Generation 36 addresses the demonstrated missing-backend initialization path.
The immutable generation-35 fixture shows that delayed-hook contention can let
a real D3D11 device and swap chain bypass automatic wrapping. Later export-hook
installation observes subsequent devices but cannot wrap the original device.
This is a proven owned reproduction, not attribution of the untraced actual
PAGER startup timeout to this mechanism.

## Narrow correction

An initializer that already validated the exact owned stage and completed
cooperative adapter registration may remember only its exact
ERROR_MOD_NOT_FOUND outcome. Other validation, discovery and installation
failures do not become pending work. No irrelevant graphics backend is loaded.

Only the reproduced LoadLibrary path records successful D3D11 hook publication
for deferral. After releasing its delayed-path mutex it can queue one native work item. Its
try-lock, failed-lock early returns and reentrant-load behavior remain intact.
There is no loader-thread wait, timer, consumer retry, reinjection or second
ReShade owner. An atomic seen/pending handshake covers publication racing the
initializer's absent-module result; the queue latch permits one attempt only.

The DLL-notification path neither notes deferred availability nor queues work.
Its automatic behavior remains unchanged. This avoids introducing cross-module
queue calls in the [restricted loader-notification callback context](https://learn.microsoft.com/en-us/windows/win32/devnotes/ldrdllnotification).
A separate notification control requires automatic rendering with zero queued
workers. This correction does not claim recovery of a notification-path miss.

The pinned owned host's worker reopens only that exact pending state and calls
the existing raw D3D11 initializer. It revalidates the stage and adapter before
method discovery or hook activation. A revoked stage or adapter leaves the host
passive with a queryable failure. Queue failure retains the error and never
retries or substitutes another worker. Existing authoritative-target-exit and
per-application implementation ownership rules remain unchanged.

Recovery occurs on a later Present of a supported original swap chain. It does
not retroactively wrap the missed device, emit its historical automatic device
callbacks, or guarantee first-frame observation. The existing manual-runtime
surface/runtime callbacks and rendering path apply. Existing automatic proxies
continue through their normal path and must not be adopted again.

The patch changes the owned ReShade host and generation labels only. Existing
foreign/official ReShade installations and mapped feature add-on implementation
are unchanged. Both native architectures, SDK validation and staging require
the exact generation-36 patch/source pins. No public ABI or private C++ layout
is added to a cooperative module boundary.

## Gates and provenance

The unsealed shadow prototype passed 20 positive/negative cases across x64 and
x86. Two immutable 1012 baseline cases retain exit 3 and gatePassed:false. The
22-case cohort contains 1,974 assertions, 60 green hardware readbacks and 60 red
readbacks painted inside actual public runtime callbacks. Its immutable local
evidence summary SHA-256 is
`960d8047ffa2ec3d046c1d6b7aef38c72f742c6ab3455d3ff2000ccc5805d787`.
Original cache sources and reused objects/libraries were verified unchanged.

The production gate separately observes the public QueueUserWorkItem boundary
with an owned test wrapper. The wrapper calls the opaque native callback once
and signals a test-owned completion event; no private mutex/layout or test
runtime export is used. Cases cover held publication and original-chain
adoption, ordinary automatic proxy behavior, DllMain and nested loads, foreign
stage, unready adapter, absent backend, queue failure, and stage/readiness
revocation, plus the notification-path control. A separate contended composition
case creates a real missed BGRA chain whose GetDesc/GetHwnd have no HWND, then
requires the manual runtime to bind exactly the nonactivating, visible-style
window outside all monitors. No DirectComposition visual is attached. Both
contended paths retain failing immutable 1012 baselines. Actual callback GPU
rendering, forwarding/flags/HRESULTs, resize,
resumed rendering and balanced retirement remain mandatory. Each case has a
dedicated launcher under scripts/test-cases. The final production cohort passed
24 cases across x64/x86, retaining four failing 1012 baselines: 2,744 assertions,
78 green readbacks and 80 callback-painted red readbacks. The first composition
fixture attempt failed its window-setup assertion before adoption; its evidence
is retained. Explicit SW_SHOWNOACTIVATE setup then passed, preserving foreground
and offscreen placement. These production fixture results do not establish
actual-game, application-input or mixed-application acceptance.

## Separate hidden-tooltip observation

The late high-integrity 1012 trace recorded a uniqueness rejection whose first
candidate's captured style had WS_VISIBLE cleared, followed by resumed binding
489.6 microseconds later with the same main HWND/thread/token. No matching reset
record, surface removal or input loss was observed. The reset diagnostic budget
was not exhausted.

The enumeration checks visibility before its candidate predicate reads style.
A window hiding between those reads can invalidate remembered full-style
identity and appear eligible for that scan. This is a plausible visibility
sampling race. The evidence does not identify which get_hwnd caller observed
the null result or show that DXGISwapChain::on_present consumed it; that path
would emit a reset record. Generation 36 does not change this classifier or
infer an unobserved runtime/surface loss. A visibility recheck would require its
own deterministic lifetime controls and acceptance.
