# SDK demos

These examples are intentionally small Electron applications. Each folder keeps
its SDK setup, preload bridge, renderer code, HTML, CSS, and explanation next to
each other so you can read one example without understanding the validation
client in `apps/client`.

| Example                                                        | What it demonstrates                                                          | One-command launch               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| [`basic-window`](./basic-window)                               | One Electron window rendered inside one target                                | `npm run demo:basic-window`      |
| [`exact-process-attachment`](./exact-process-attachment)       | Name watching or an exact PID/path handoff                                    | `npm run demo:exact-process`     |
| [`input-interception`](./input-interception)                   | Toggling game-input interception with `Ctrl+I`                                | `npm run demo:input`             |
| [`multiple-windows`](./multiple-windows)                       | Publishing and managing more than one Electron window                         | `npm run demo:multiple-windows`  |
| [`target-follow-and-telemetry`](./target-follow-and-telemetry) | Target surface metadata, FPS, and target-following bounds                     | `npm run demo:target-follow`     |
| [`steam-auto-attach`](./steam-auto-attach)                     | Watching Steam processes and attaching each detected executable independently | `npm run demo:steam-auto-attach` |

Install the repository and prepare the native runtime once from the workspace
root:

```powershell
npm install
npm run demo:prepare
```

You can then run any command in the table. Normal demo launches preserve that
staged x64/x86 runtime, incrementally compile only the SDK TypeScript, build the
selected example, and start Electron. This avoids rebuilding unsigned native
artifacts whenever you switch examples. Run `npm run demo:prepare` again after
changing native runtime sources. Arguments after `--` are forwarded to the
Electron main process.

Run `npm run demo:smoke` for a non-injecting runtime check of all six examples.
It uses a unique Electron profile and impossible target name per example, then
requires every main process, preload, renderer bundle, overlay transport, and
process watcher to become ready. The multiple-window example must report both
renderers before it can pass.

The five single-target launchers default to `Gun Frog.exe`, so every npm script
can be started without parameters. Override the target with
`-- --target-process="game.exe"` or set
`ELECTRON_GAME_OVERLAY_DEMO_TARGET_PROCESS`. The exact-process examples also
accept `--target-pid` and `--target-path`; without a PID they use the same
prearmed name-watcher path and begin following the authenticated PID afterward.

For name-only examples, wait for the `Injector watcher ready` terminal message
before launching the game. That message comes from the native watcher's armed
marker, not merely from creation of the injector child process. The exact-PID
examples represent a process-watcher callback and must run close enough to
process creation to beat graphics initialization; attaching after a game is
already rendering is not supported.

These are teaching examples, not compatibility automation. The larger
`apps/client` application and native test-case launchers remain the exhaustive
validation harness.
