# Resource-soak SDK producer

This is a genuine Electron/public-SDK producer for a separately owned acceptance
controller. It neither starts nor terminates the target. Its state reports SDK,
window and private-route observations; the controller must independently inspect
the target's modules, resources and rendering/input behavior.

Example arguments after the fixture script path:

```text
--member=churn --slot=churn --evidence=C:/absolute/owned-run
--sdk-dist=C:/absolute/package/dist --game=C:/absolute/owned-target.exe
--pid=1234 --max-cycles=32
```

`member` is a lowercase safe name of up to 32 characters. `slot` is `survivor`
or `churn` and selects distinct window positions/colors. The target PID is
mandatory. `max-cycles` defaults to 1,024 and must be between 1 and 1,024. The
current SDK evidence collector and staged add-on check are for x64.

The producer writes `<member>-sdk.json`, atomically publishes
`<member>-state.json`, and appends observations to `<member>-events.jsonl`.
The state keeps at most 64 recent events and 32 live windows. Route credentials
are represented only by SHA-256 token fingerprints. `native` describes verified
staged file bytes; it does not assert that those bytes are mapped in the target.
`injectorProof` and `selectedTarget` retain an allowlisted completion mode and
exact native PID/image/creation selection read from its bounded owned stdout
file. Raw injector output and credentials are not copied into producer state.

The controller atomically replaces `<member>-command.json` with, for example:

```json
{"sequence":1,"action":"close-session"}
```

Successful commands advance `state.commandSequence`. Repeated or older sequence
numbers are ignored. New malformed or failed commands terminate the producer
with exit code 1 and retain `state.error` when state publication is possible.

| Action | Behavior |
| --- | --- |
| `close-session` | Closes the current public session and launcher; leaves Electron alive. |
| `recreate-session` | Closes a live session if present, then creates a new public session and a fresh stage root; increments `cycle`. |
| `create-window` | Creates/shows the named window; `window` defaults to `main`. Duplicate names or the live window bound fail. |
| `close-window` | Closes the named window and removes its state. |
| `focus` | Focuses the named window's input and requests native window focus. |
| `clear` | Clears the named input. |
| `intercept` / `release` | Calls the active session's public input request API. |
| `exit` | Closes/disposes owned SDK state, acknowledges the command and exits 0. |

Startup creates/shows `main` and attaches to the exact PID. Attachment is
asynchronous: `ready` and command acknowledgement do not imply `attached` or
`rendering`. The controller must wait for both, verify the expected cycle and
private route, and require fresh rendering/input evidence. Old-session events and
late attachment completions cannot alter the current cycle.

Every recreation uses `runs-<member>/cycle-<cycle>` as a new stage parent. This
exercises additive staged engine/module lifetimes. It does **not** claim socket
reconnection to a fixed existing engine or participant reuse. Whole application
restart is performed by the controller, which must use fresh evidence/profile
directories or account for existing cycle paths explicitly.

The isolated Node tests use controlled public-API objects, not an executing
native engine:

```powershell
node --test apps/client/tests/cooperative-resource-soak-fixture.test.cjs
```
