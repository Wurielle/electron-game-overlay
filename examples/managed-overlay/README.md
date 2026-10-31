# Managed overlay consumer

Copy this folder outside the repository. Install the complete local
electron-game-overlay-0.1.0-rc.7.tgz as a production dependency:

```powershell
npm install --save-exact "C:\downloads\electron-game-overlay-0.1.0-rc.7.tgz"
npm start -- --smoke
npm start -- "--target=C:\Games\game.exe"
```

Keep the target closed until "Watcher armed". The exact path is the application's
explicit authorization. The controller baselines already-running processes and
rearms after authoritative exit. An uncertain attempt is never retried.
The early lane is exclusive across apps; best-effort exact-PID policy is available
for multi-application attachment but can miss fast graphics initialization.

Smoke creates a hidden genuine Electron DOM and a lazy SDK session, then exits.
It never creates a controller, starts a broker or injects. The native example
shows the established show/focus/intercept sequence and separately chooses its
DOM input. The app still owns input release, UI state and cleanup.

electron-builder.config.cjs demonstrates the SDK-owned afterPack helper and
required ASAR unpack pattern. Compose it with the application's other hooks.
No manual SDK path construction or nested-notice copy/filter logic is needed.

See [the rc.5 API and migration guide](../../doc/sdk-rc5-managed-attachment.md)
for update/cancel behavior, selector reservations and validation limits.

Current process-policy behavior and fast-start limitations: [rc.6 guide](../../doc/sdk-rc6-process-policy.md).

Folder authorization is explicit and optional:

```powershell
npm start -- "--directory=C:\Games" "--deny=**/UnityCrashHandler64.exe"
```

Native filtering happens before mutation, but future-process polling can lose the
race with graphics startup. The rc.6 no-barrier fast-host runs were intermittent: one full lifecycle case
passed and another fresh start failed. This candidate is not accepted for reliable
fast startup. No helper names are excluded
unless supplied as application policy. Do not retry an uncertain live target.

The basename-glob update fix and discovery readiness contract are documented in [rc.7](../../doc/sdk-rc7-discovery-policy.md).
