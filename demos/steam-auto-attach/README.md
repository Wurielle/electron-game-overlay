# Steam auto-attach

This example turns process-watcher events into independent exact-PID overlay
attachments. It attempts **every detected `.exe` whose normalized full path
contains `\\steamapps\\`**. It deliberately has no game-name allowlist, helper
exclusions, or executable plausibility heuristics.

```powershell
npm run demo:steam-auto-attach
```

The important lifecycle is in `main.ts`:

1. `wql-process-monitor` reports process creation and deletion from a Node-mode
   child process. The monitor runs out of process because its COM threading
   requirements are incompatible with Electron's main thread.
2. A creation event that matches the path contract receives its own
   `ReShadeOverlayLauncher`. A launcher owns one target connection, while the
   shared `OverlaySession` can publish windows to all connected targets.
3. Only a currently live PID is deduplicated. No executable is silently
   filtered. A deletion event confirms target exit, disposes that PID's
   launcher, and frees the PID for a later creation event.
4. Shutdown asks the watcher to close its WQL event sink before terminating it.

Some protected/elevated processes may not expose their executable path to a
non-elevated watcher. Such an event cannot satisfy the full-path contract and is
reported as ignored in the terminal rather than guessed.

This teaching example deliberately creates and prepares the per-PID launcher
after WQL reports process creation. That makes the lifecycle easy to read, but
very fast games can initialize graphics before staging and exact-PID injection
finish. The validation client in [`apps/client`](../../apps/client) adds a
prearmed native Steam-path lane and uses exact-PID observation as the
authoritative fallback; use that pattern for production-like timing.
