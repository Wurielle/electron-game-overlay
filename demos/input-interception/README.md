# Input interception

This example adds one application-level input policy to the basic overlay:
pressing `Ctrl+I` toggles whether game input is intercepted and routed to the
Electron overlay. The same action is exposed to the renderer through a narrow
IPC bridge, so the on-screen button can release interception after it is active.

Run the demo first:

```powershell
npm run demo:input
```

This defaults to `Gun Frog.exe`; append `-- --target-process="game.exe"` to use
another target. Wait for the `Injector watcher ready` message in the terminal,
then launch the game. The message confirms the native name watcher is armed
before process and graphics initialization. Once connected, press `Ctrl+I`; the
badge changes immediately to show the requested state. The shortcut is
registered with Electron's `globalShortcut`, which is the pattern a real desktop
application can use without hard-coding a key in the SDK.

Global shortcut registration can fail if another application owns `Ctrl+I`;
the error is displayed in the overlay and written to the console.
