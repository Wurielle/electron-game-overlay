# Multiple overlay windows

One overlay session can publish multiple independent Electron windows. This
example creates a controls panel and a telemetry panel from the same renderer,
gives them separate IDs and bounds, and attaches the session to one game.

```powershell
npm run demo:multiple-windows
```

This defaults to `Gun Frog.exe`; append `-- --target-process="game.exe"` to use
another target. Wait for `Injector watcher ready` in the terminal, and then
launch the game. This confirms the native name watcher is armed before graphics
initialization. In [`main.ts`](./main.ts), look for the two
`session.windows.create(...)` calls. Each wrapper has its own lifecycle and can
later be shown, hidden, moved, or destroyed independently.

Both pages use [`index.html`](./index.html); a small `?panel=` query selects the
content in [`renderer.ts`](./renderer.ts). This keeps the example compact while
still demonstrating two real offscreen `BrowserWindow` instances.
