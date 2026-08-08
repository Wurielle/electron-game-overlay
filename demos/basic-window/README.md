# Basic overlay window

This is the smallest complete Electron Game Overlay application. It creates an
overlay session, publishes one offscreen `BrowserWindow`, and prearms the
bundled ReShade runtime for a newly launched target process.

From the repository root, run the demo first:

```powershell
npm run demo:basic-window
```

This defaults to `Gun Frog.exe`. To use another game, append
`-- --target-process="game.exe"`. Wait for the corresponding `Injector watcher
ready` message in the terminal, then launch the game. This confirms the native
name watcher is armed, not merely that its child process was created. Name-only
attachment is a prearmed operation; it does not adopt a process that is already
rendering. If a process watcher gives you an exact PID near process creation,
see `../exact-process-attachment` instead.

Read the files in this order:

1. [`main.ts`](./main.ts) starts the SDK session, creates the overlay window,
   and attaches to the game.
2. [`preload.ts`](./preload.ts) exposes a narrow status bridge to the page.
3. [`renderer.ts`](./renderer.ts) contains ordinary browser-side UI code.
4. [`index.html`](./index.html) and [`assets/styles.css`](./assets/styles.css)
   define the rendered overlay.

The runner adds `--reshade-overlay` automatically. Games with anti-cheat may
block injection.
