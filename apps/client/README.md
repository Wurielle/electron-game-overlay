# Validation client

This Electron application is the repository's broad demo and compatibility
harness. It is intentionally more complicated than a normal SDK consumer: it
contains Steam process observation, hybrid prearmed/exact-PID attachment,
multiple test windows, compatibility recording, deterministic test markers, and
controlled-host automation.

Developers learning the SDK should start with the small examples under
[`demos`](../../demos) and the [root API guide](../../README.md), not this
application.

## Run the presentation demo

From the workspace root:

```powershell
npm run dev
```

Start the client before launching a Steam game. The demo:

- prearms one broad native `\steamapps\` path attachment with no executable
  exclusions;
- independently attempts exact-PID attachment for every observed `.exe` under
  `steamapps`;
- keeps one isolated launcher/runtime run per target attempt;
- releases a PID only after authoritative process deletion;
- keeps Electron alive so a closed and relaunched game can attach again.

Inside an attached game, press **Ctrl+I** to request input interception. The
compact dock expands after the target acknowledges interception and can open a
fullscreen playground, status strip, popups, and video surface. Press
**Ctrl+I** again or use **Release input** to return input to the game.

The shortcut is registered with Electron's `globalShortcut`; it is demo policy,
not a hard-coded SDK key.

## Gun Frog acceptance scene

Close Gun Frog, then run:

```powershell
npm run dev:gun-frog
```

This arms `Gun Frog.exe` before launch and exposes the fixed two-window input
proof scene. The dedicated acceptance wrapper is:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\gun-frog-client-sdk.ps1
```

## Compatibility evidence

Every ReShade-enabled run writes bounded JSONL and summary evidence under the
client's application log directory in `compatibility-runs`. Override the root
with the absolute `ELECTRON_GAME_OVERLAY_COMPATIBILITY_RUNS_DIR` environment
variable.

Evidence records process-local lifecycle, attachment, authenticated transport,
surface/API/FPS, diagnostics, and input acknowledgement. It deliberately avoids
raw input, typed text, credentials, full executable paths, HWNDs, monitor IDs,
and arbitrary remote error messages. Rendering and click-blocking still require
a controlled oracle or human observation.

## Build and test

```powershell
npx nx run client:typecheck
npx nx run client:test
npx nx run client:build
```

Building the client first builds `electron-game-overlay` and stages its x64/x86
runtime package. The client itself contains no injector or injected payload;
all native behavior comes through the public SDK.

Human-facing runtime gates are indexed by their own launchers under
[`libs/electron-game-overlay-runtime/scripts/test-cases`](../../libs/electron-game-overlay-runtime/scripts/test-cases).
