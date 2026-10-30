# Electron overlay transport

This Rust library owns the backend-neutral transport between the Electron
producer and an injected overlay runtime. It receives window frames and scene
metadata, routes overlay input, and exposes the resulting state through both a
Rust API and a stable C ABI for native rendering backends.

## Build prerequisites

Install Rust through rustup with both supported Windows MSVC targets. The local
`rust-toolchain.toml` pins the stable minimal toolchain and requests the same
target set for Cargo commands run from this package.

```powershell
rustup target add --toolchain stable x86_64-pc-windows-msvc i686-pc-windows-msvc
```

The C ABI exposes a monotonic producer-session epoch. Zero is initially
dormant; every authenticated connection and disconnect advances it once, so odd
epochs are active and even epochs are dormant. Native renderers must invalidate
prior session-owned input and graphics state whenever the value changes. This
also preserves a complete disconnect/reconnect transition that occurs between
two render callbacks.

The injected client resolves its run-local route directory from
`ELECTRON_GAME_OVERLAY_RUN_DIRECTORY` first, then falls back to
`RESHADE_BASE_PATH_OVERRIDE`. The explicit overlay directory lets a compatible
ReShade runtime already loaded in the target host the SDK's private staged
add-on without redirecting transport lookup to the target's own ReShade
directory. The client prefers `electron-overlay-transport-v1.json` in the
selected directory. Exact-PID producers first place
`electron-overlay-transport-v1.targeted` beside it to declare persistent
run-local route intent. The marker pins that route even when the credential
record has already been revoked, preventing a payload that initializes late
from falling back to the global producer.

The legacy temporary-directory fallback is used only when neither an adjacent
record nor the route-intent marker has selected the run-local route. Malformed,
mismatched, or previously selected local routing fails closed, including a
reconnect attempt after the local record is deleted. The producer retains the
marker after credential revocation, and staged-run cleanup removes it with the
directory. This file-based routing prevents normal metadata collisions; it is
not a hostile same-user security boundary.

Compatible-runtime reuse is deliberately restricted to an exact-PID
repository-built host whose ABI-1 add-on-registration gate is still open. The
SDK's strict injector result distinguishes that `existing-runtime` route from
`injected-runtime`. A separate `official-addon` route attempts every detected
target-local x64 ReShade identity without a version/hash allowlist. The loaded
add-on must register with public API 18 and obtain its exact Dear ImGui function
table, then uses a deterministic exact-PID temporary credential because an
existing public add-on cannot inherit the run-directory environment. A current
add-on that was not loaded is host-incompatible. Incompatible or indeterminate
hosts fail closed and never become transport fallback cases; the route neither
rewrites ReShade-owned files nor loads a fallback runtime alongside the host.
