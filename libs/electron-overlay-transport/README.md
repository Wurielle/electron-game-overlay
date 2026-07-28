# Electron overlay transport

This Rust library owns the backend-neutral transport between the Electron
producer and an injected overlay runtime. It receives window frames and scene
metadata, routes overlay input, and exposes the resulting state through both a
Rust API and a stable C ABI for native rendering backends.

When ReShade supplies `RESHADE_BASE_PATH_OVERRIDE`, the injected client prefers
`electron-overlay-transport-v1.json` beside that isolated runtime. Exact-PID
producers first place `electron-overlay-transport-v1.targeted` beside it to
declare persistent run-local route intent. The marker pins that route even when
the credential record has already been revoked, preventing a payload that
initializes late from falling back to the global producer.

The legacy temporary-directory fallback is used only when neither an adjacent
record nor the route-intent marker has selected the run-local route. Malformed,
mismatched, or previously selected local routing fails closed, including a
reconnect attempt after the local record is deleted. The producer retains the
marker after credential revocation, and staged-run cleanup removes it with the
directory. This file-based routing prevents normal metadata collisions; it is
not a hostile same-user security boundary.
