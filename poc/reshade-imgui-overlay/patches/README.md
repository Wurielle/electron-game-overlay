# Pinned ReShade input observer

`reshade-input-observer.patch` applies only to the ReShade 6.7.3 commit pinned
by this POC. It advances the local full-add-on API from 18 to 19 and adds one
passive `input_message` event after ReShade has decided to suppress an input
record.

The callback receives an immutable copied POD. It cannot consume, unblock, or
change ReShade's decision, and transient `HRAWINPUT` pointers are never exposed
for deferred use. The Electron add-on copies the POD into a bounded lock-free
queue and performs routing later on the render callback, outside ReShade's input
and window locks.

Legacy blocked window messages are routed exactly to the Electron core. Copied
`WM_INPUT` and `GetRawInputBuffer` records are retained and counted but their
normalization into Electron events is intentionally post-POC hardening.

CMake applies the patch idempotently to the ignored fetched source and fails if
the pinned revision drifts. `scripts/build-runtime.ps1` also verifies the exact
seven changed files, patch hash, full-add-on configuration, and runtime hash
before accepting its cache.
