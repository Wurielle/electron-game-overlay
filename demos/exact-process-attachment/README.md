# Exact process attachment

This API-shape example shows the hand-off from a process watcher to an already
running Electron main process. The watcher supplies a process name, an exact
PID, and (when available) the full executable path. Exact identity avoids
attaching to another process with the same name and lets the SDK safely inspect
existing ReShade setups. The launcher calls `prepare()` before attachment so
runtime staging can normally finish before the watcher callback.

Run it from the workspace root:

```powershell
npm run demo:exact-process -- --target-process="Game.exe" --target-pid=1234 --target-path="C:\Games\Game.exe"
```

`--target-process` and `--target-pid` are required. `--target-path` is optional,
although a real process watcher should provide it whenever Windows exposes it.
The shared demo launcher adds the SDK's explicit `--reshade-overlay` opt-in.
The direct command is useful with a cooperating target held before graphics
initialization. In a real application, keep Electron and a prepared launcher
alive, then invoke this same `attach()` call immediately from the process
creation callback. Starting a new Electron process after manually finding the
PID is too slow for general games, and an already-rendering target is not
supported.

Read the example in this order:

1. `main.ts` creates the SDK session, publishes an Electron window, and calls
   `ReShadeOverlayLauncher.attach` with the exact target.
2. `preload.ts` exposes a narrow context bridge instead of Node.js.
3. `renderer.ts` renders lifecycle state and controls input interception.

The overlay stays attached until the target exits or this Electron process is
closed. `Ctrl+C` in the launching terminal stops the demo.
