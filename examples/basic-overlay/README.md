# Standalone SDK consumer

A plain CommonJS Electron application, independent of the repository workspace.
No Nx, TypeScript build, native compiler, source aliases, or SDK-relative imports
are needed. Electron is pinned to **39.8.10**.

## Install a candidate

Copy this entire folder **outside the checkout** (for example to
`C:\overlay-consumer`). Obtain `electron-game-overlay-0.1.0-rc.1.tgz` from the
SDK candidate artifact, then run in the copied folder:

```powershell
npm install --save-exact "C:\downloads\electron-game-overlay-0.1.0-rc.1.tgz"
npm start -- --smoke
```

`npm install` installs this application's pinned Electron as well as the local
SDK tarball. The SDK is intentionally added by this command rather than resolved
from a workspace. It writes a consumer-local lockfile; do not run it at the
repository root. A normal first install needs registry access and the Electron
download, or an already populated npm/Electron cache. There is no public npm
release implied by this candidate.

Smoke mode creates a real ordinary Electron `BrowserWindow`, loads `index.html`,
checks its DOM, constructs `ElectronGameOverlay` and an **unstarted** session,
prints `SMOKE_OK`, cleans up and exits. It never parses runtime configuration,
starts the session/broker, constructs a launcher, or attaches/injects. It is not
proof of Windows game rendering, input, or native runtime compatibility.

## Attach on Windows

Use Windows 10+ x64, a normal unelevated application, and a supported Direct3D
9/10/11/12 game without anti-cheat. Keep the game **closed** initially:

```powershell
npm start -- --target-process=game.exe --reshade-overlay
```

Replace `game.exe` with the executable **basename**, not a path or PID. Only the
inline `--target-process=name.exe` form is accepted. The second flag is the SDK's
existing explicit native-runtime opt-in; it is not added automatically. This
example uses the candidate's bundled runtime and its validated manifests, not a
custom runtime path or auto-target setting.

Wait for `Injector watcher ready. Launch game.exe now.`, then start that game.
The public name watcher observes newly created processes; it does **not** attach
to an already-running game. Attachment must occur before graphics initialization.
`Connected to ...` reports launcher completion, not a substitute for inspecting
the game. Close/quit the consumer to dispose its launcher, session and owner.
Attachment/setup failures print an error, dispose resources and exit nonzero.
Do not elevate, disable antivirus, add security exceptions, or use protected games.

## Public API used

`ElectronGameOverlay`, `createSession()`, `session.start()`,
`session.windows.create()`, overlay-window `show()`/`browserWindow`,
`parseReShadeLaunchConfig(process.argv)`, `ReShadeOverlayLauncher`,
`launcher.onEvent()`, `launcher.attach(session, { processName })`,
`launcher.dispose()`, `session.close()` and `overlay.dispose()` are imported or
reached through the package's public root. No broker management API is required.
The static page has no Node integration or preload and opens no secondary windows.

## Verification boundaries

`npm test` executes the actual `main.cjs` using controlled Electron and SDK
boundaries for CLI, lifecycle and error-path checks. It does not exercise native
attachment. For artifact acceptance, copy this folder outside the checkout,
install the actual candidate tarball, ensure `require.resolve('electron-game-overlay')`
points into that copy's `node_modules` (not the repository), then run smoke mode.
When using the repository's existing TypeScript compiler for an additional
`checkJs` gate, resolve all SDK/Electron declarations from the installed consumer,
not source path mappings. No TypeScript dependency is required to run the app.
