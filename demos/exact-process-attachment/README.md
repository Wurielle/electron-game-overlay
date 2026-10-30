# Exact process attachment

This API-shape example shows the hand-off from a process watcher to an already
running Electron main process. The watcher supplies a process name, an exact
PID, and (when available) the full executable path. Exact identity avoids
attaching to another process with the same name and lets the SDK safely inspect
existing ReShade setups. This standalone demo calls `prepare()` immediately
before attachment. A long-running application should prepare its launcher
earlier, before its process watcher reports a target, so the callback only has
to invoke `attach()`.

Run it from the workspace root:

```powershell
npm run demo:exact-process
```

The no-argument convenience path defaults to `Gun Frog.exe` and prearms the
name watcher. For the exact process-watcher handoff demonstrated by this
example, supply the identity your watcher returned:

```powershell
npm run demo:exact-process -- --target-process="Game.exe" --target-pid=1234 --target-path="C:\Games\Game.exe"
```

`--target-pid` is optional for the convenience path. `--target-path` is used
only with a PID, and a real process watcher should provide both whenever Windows
exposes them. The shared demo launcher adds the SDK's explicit `--reshade-overlay`
opt-in. The direct exact command is useful with a cooperating target held before
graphics initialization. In a real application, keep Electron and a prepared
launcher alive, then invoke this same `attach()` call immediately from the
process creation callback. Starting a new Electron process after manually
finding the PID is too slow for general games, and an already-rendering target
is not supported.

Read the example in this order:

1. `main.ts` creates the SDK session, publishes an Electron window, and calls
   `ReShadeOverlayLauncher.attach` with the exact target.
2. `preload.ts` exposes a narrow context bridge instead of Node.js.
3. `renderer.ts` renders lifecycle state and controls input interception.

The overlay stays attached until the target exits or this Electron process is
closed. `Ctrl+C` in the launching terminal stops the demo.
