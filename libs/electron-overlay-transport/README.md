# Electron overlay transport

This Rust library owns the backend-neutral transport between the Electron
producer and an injected overlay runtime. It receives window frames and scene
metadata, routes overlay input, and exposes the resulting state through both a
Rust API and a stable C ABI for native rendering backends.
