# Managed overlay consumer

Copy this folder outside the source checkout, then install the complete candidate
as a production dependency:

```powershell
npm install --save-exact "C:\downloads\electron-game-overlay-0.1.0-rc.7.tgz"
npm start -- --smoke
npm start -- "--target=C:\Games\game.exe"
```

Smoke verifies a hidden genuine Electron DOM and a lazy SDK session. It does not
start a broker, observe processes or inject. Normal attachment requires Windows
x64 and an explicitly authorized, newly launched target. Keep the game closed
until the initial watcher is armed.

Folder authorization is explicit; an exact target never silently authorizes its
parent directory. Repeat `--deny` for each application-chosen native rule:

```powershell
npm start -- "--directory=C:\Games" "--deny=**/private/**"
```

There are no default executable-name expansions or helper exclusions. Deny wins.
The [SDK API guide](../../doc/sdk-api.md) documents programmatic configuration,
all watcher options/methods/events, process policy, read-only observation and
manual attachment. `main.cjs` demonstrates lifecycle ownership and the separate
steps for showing/focusing an overlay, choosing a DOM input and intercepting input.

`update(policy)` replaces the full policy and preserves an allowed live target.
`discovery-blocked` reports a future discovery problem without cancelling it or
claiming new readiness. Genuine denial still revokes the target. Dispose the
controller, release input and close the session/owner on application shutdown.
Uncertain injection is never retried without authoritative target exit.

Future-process polling can miss graphics initialization, including when the
native watcher was armed. The [rc.7 evidence](../../doc/sdk-rc7-discovery-policy.md)
separates the passing policy regression from the unresolved startup reliability
limit. The early lane remains exclusive across applications; exact-PID attachment
is the shared route. Readiness is not authenticated or rendered attachment.

`electron-builder.config.cjs` uses the Node-only SDK afterPack helper and complete
ASAR unpack pattern. Keep the entire sealed package, including nested dependency
notices. See [packaging contracts](../../doc/sdk-api.md#electron-builder-packaging)
for hook composition, source overrides, return values and verification.
