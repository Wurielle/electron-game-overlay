# Broker regression coverage

This records bugs encountered while developing the shared broker and demo. It is
an automated regression map, not another operator smoke-test checklist. The
working production implementation is unchanged by the regression-lock work.

## Geometry and new windows

- **Adding another app/window replayed stale geometry, moving existing windows.**
  `libs/electron-game-overlay/tests/interaction-position-reset.test.cjs` covers
  ordinary additions over the real broker/client sockets.
  `window-order-placement.test.cjs` in the same directory covers negotiated
  order-only insertion/restoration, unchanged survivor frames, legacy fallback
  and atomic rejection of invalid orders, including sparse arrays.
- **Popup/video creation could reset windows belonging to either app.**
  `apps/client/tests/popup-video-real-graph.acceptance.cjs`, through
  `apps/client/scripts/run-popup-video-regression.cjs`, exercises the real
  application IPC paths, independent SDK graphs and private coordinator sockets.
  Regular PR CI builds the pinned previous SDK and checks current/previous client
  combinations, order-capable reconnection and explicit legacy characterizations.
  Its Electron/native boundaries are controlled: it does not invent native
  dragged positions or claim to render a game.
- **Native movement and existing window sizes must survive additions/reordering.**
  The `window_order` tests in
  `libs/electron-overlay-transport/src/electron_frame.rs` exercise the production
  native scene and input implementation. The Windows production job executes
  the filtered native tests on both x64 and x86. Native unit tests are distinct
  from Electron producer-window bounds and from physical GPU/game acceptance.
- **Main expanded to the target surface and trapped access to controls.**
  `apps/client/tests/demo-main-window.test.cjs` guards bounded Main/proof geometry
  and absence of unintended target following.
  `real-electron-demo-main.acceptance.cjs` exercises genuine Electron Main
  renderers, fresh popup/video factories, typed input, Hide and peer geometry.

## Input and controls

- **Typing/focus crossed app namespaces or stopped reaching the renderer.**
  `libs/electron-game-overlay/tests/keyboard-focus-routing.test.cjs` checks real
  broker/session translation and isolation. `real-electron-input.acceptance.cjs`
  and its child fixture exercise independent genuine Electron processes,
  offscreen BrowserWindows, real SDK/broker sockets and actual DOM input events.
  Native ingress is controlled and is not a Windows hook/game injection test.
- **Focus callbacks and collapsing/releasing controls reset placement.**
  `apps/client/tests/app-demo-focus.test.mjs` invokes the real application graph
  with controlled OS/SDK boundaries; `input-proof-ui.test.mjs` and
  `real-electron-control-panel.acceptance.cjs` cover fixed backing geometry,
  collapse states and genuine transparent offscreen paint.
- **Both apps competed for the same shortcut, leaving one inaccessible.**
  `apps/client/tests/input-intercept-shortcut.test.mjs`,
  `app-demo-shortcuts.test.mjs` and `target-input-intercept-state.test.mjs`
  exercise independent shortcut acquisition, fallback, cleanup and interception.

## Startup and delivery

- **Cold preparation raced startup/readiness.**
  `libs/electron-game-overlay/tests/overlay-broker-cold-cache-deadline.test.cjs`
  and `apps/client/tests/steam-game-auto-attacher.test.mjs` cover bounded startup,
  independent readiness/preparation completion orders and first-ready pool slots.
- **The watcher attached to already-running processes or lost its private Node.**
  `steam-game-auto-attacher.test.mjs`, `process-watcher-bridge.test.mjs` and
  `package-demo.test.cjs` cover baseline silence/new process handling, detailed
  startup failures, environment sanitization and packaged Node resolution.
  Windows-only observer execution is explicitly skipped on other hosts.
- **Packaging paths, paired launchers or cleanup could misreport success.**
  `apps/client/tests/package-broker-smoke-hosts.test.cjs`,
  `package-broker-test-bundle.test.cjs`, `broker-smoke-host-runner.test.cjs` and
  `run-popup-video-regression.test.cjs` cover package closure/paths, launcher
  ownership, and nonzero failure through cleanup/final report writes.

## Continuous enforcement and limits

`.github/workflows/broker-compatibility.yml` runs SDK tests, the application
regressions, popup/video mixed-SDK graph, genuine Electron acceptances and native
ordering tests on ordinary pull requests. `demo-usability-workflow.test.cjs`
guards against accidentally relegating these checks to optional manual builds.
Reports are retained by the workflow's always-running artifact steps.

A legacy coordinator or native target without the optional ordering capability
retains its documented fallback behavior; a current client cannot repair that
already-serving implementation. The matrix preserves those known failures as
explicit characterizations rather than calling them fixed. No test promises
cross-disconnect persistence of native dragged positions or persistence for a
window that was destroyed and recreated.

Isolated negative controls establish that geometry reset/resize and dropped
input fail the relevant assertions. They do not establish that every imaginable
future fault is impossible. Graphics drivers, physical display/input behavior
and antivirus quarantine are not guaranteed by these automated tests.
