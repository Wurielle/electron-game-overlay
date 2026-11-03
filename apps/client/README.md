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

## Package the portable demo

The ordinary SDK/client build seals the application-private engine distribution
in `dist/overlay-manifest.json`; it does not build or require a standalone
broker executable. Portable demo packaging verifies that seal and both native
architectures before copying the SDK.

The Steam observer still needs its own Node.js executable in the portable
bundle. Supply the matching Node.js license independently from the SDK:

```powershell
node apps/client/scripts/package-demo.cjs `
  --output 'C:/absolute/path/to/repository/artifacts/demo' `
  --node-license 'C:/path/to/the/current/node-distribution/LICENSE'
```

By default the packager copies the Node executable running that command. Use
`--node-runtime 'C:/path/to/node.exe'` to supply another supported runtime. It
checks the executable's version, records executable/license hashes in
`resources/node/runtime.json`, and refuses a missing license. The required Node
range matches the workspace: `^20.19.0 || >=22.12.0`.

The bounded packaged-runtime smoke uses the bundled observer runtime and its
recorded version rather than a broker's Node version:

```powershell
node apps/client/scripts/smoke-packaged-demo.cjs `
  --package 'C:/absolute/path/to/repository/artifacts/demo'
```

This validates packaging and a genuine Electron/observer startup. It is not
evidence of game injection or overlay input/rendering acceptance.

Human-facing runtime gates are indexed by their own launchers under
[`libs/electron-game-overlay-runtime/scripts/test-cases`](../../libs/electron-game-overlay-runtime/scripts/test-cases).
