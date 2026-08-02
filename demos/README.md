# SDK demos

These examples are intentionally small Electron applications. Each folder keeps
its SDK setup, preload bridge, renderer code, HTML, CSS, and explanation next to
each other so you can read one example without understanding the validation
client in `apps/client`.

| Example                                                        | What it demonstrates                                                          | Command                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`basic-window`](./basic-window)                               | One Electron window rendered inside one target                                | `npm run demo:basic-window -- --target-process=game.exe`                                                    |
| [`exact-process-attachment`](./exact-process-attachment)       | Injecting a process watcher result by PID and executable path                 | `npm run demo:exact-process -- --target-process=game.exe --target-pid=1234 --target-path=C:\Games\game.exe` |
| [`input-interception`](./input-interception)                   | Toggling game-input interception with `Ctrl+I`                                | `npm run demo:input -- --target-process=game.exe`                                                           |
| [`multiple-windows`](./multiple-windows)                       | Publishing and managing more than one Electron window                         | `npm run demo:multiple-windows -- --target-process=game.exe`                                                |
| [`target-follow-and-telemetry`](./target-follow-and-telemetry) | Target surface metadata, FPS, and target-following bounds                     | `npm run demo:target-follow -- --target-process=game.exe --target-pid=1234`                                 |
| [`steam-auto-attach`](./steam-auto-attach)                     | Watching Steam processes and attaching each detected executable independently | `npm run demo:steam-auto-attach`                                                                            |

Install the repository once with `npm install`, then run any command from the
workspace root. The launcher incrementally rebuilds the SDK/runtime and the
selected example before starting Electron with the bundled overlay runtime
enabled. Arguments after `--` are forwarded to the Electron main process.

For name-only examples, wait for the `Injector watcher ready` terminal message
before launching the game. That message comes from the native watcher's armed
marker, not merely from creation of the injector child process. The exact-PID
examples represent a process-watcher callback and must run close enough to
process creation to beat graphics initialization; attaching after a game is
already rendering is not supported.

These are teaching examples, not compatibility automation. The larger
`apps/client` application and native test-case launchers remain the exhaustive
validation harness.
