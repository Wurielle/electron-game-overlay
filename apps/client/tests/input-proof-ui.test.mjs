import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(testDirectory, '..');

function readClientFile(...segments) {
  return readFileSync(path.join(clientRoot, ...segments), 'utf8');
}

test('the real client arms and forwards the main overlay input proof', () => {
  const windowSource = readClientFile(
    'src',
    'main',
    'electron',
    'example-overlay-windows.ts',
  );
  const mainOverlay = readClientFile(
    'public',
    'index',
    'example-main-overlay.html',
  );

  assert.match(windowSource, /once\(['"]did-finish-load['"]/);
  assert.match(windowSource, /proof\.enable\(\)/);
  assert.match(windowSource, /HUDHOOK_CLIENT_INPUT_PROOF_ARMED/);
  assert.match(windowSource, /OVERLAY_CLIENT_INPUT_TARGET/);
  assert.match(windowSource, /role:\s*['"]main['"]/);
  assert.match(windowSource, /startsWith\(HUDHOOK_CLIENT_INPUT_MARKER\)/);
  assert.match(mainOverlay, /HUDHOOK_CLIENT_INPUT_PROOF_READY/);
  assert.match(mainOverlay, /HUDHOOK_CLIENT_INPUT_DIAGNOSTIC/);
});

test('the status overlay exposes and forwards visible input diagnostics', () => {
  const windowSource = readClientFile(
    'src',
    'main',
    'electron',
    'example-overlay-windows.ts',
  );
  const statusOverlay = readClientFile(
    'public',
    'index',
    'example-status-overlay.html',
  );

  assert.match(windowSource, /forwardHudhookInputDiagnostics\(window\)/);
  assert.match(windowSource, /enableStatusInputProof\(window\)/);
  assert.match(statusOverlay, /id="hudhook-status-input-diagnostic"/);
  assert.match(statusOverlay, /id="hudhook-status-input-target"/);
  assert.match(statusOverlay, /HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC/);
});

test('the Gun Frog client proof publishes four aligned Electron controls and readiness markers', () => {
  const appEntry = readClientFile('src', 'main', 'electron', 'app-entry.ts');
  const windowSource = readClientFile(
    'src',
    'main',
    'electron',
    'example-overlay-windows.ts',
  );
  const mainOverlay = readClientFile(
    'public',
    'index',
    'example-main-overlay.html',
  );

  assert.match(windowSource, /gunFrogInputProof[\s\S]{0,40}?\? 64/);
  assert.match(windowSource, /gunFrogInputProof[\s\S]{0,40}?\? 270/);
  assert.match(windowSource, /demoPresentation[\s\S]{0,40}?\? 440/);
  assert.match(windowSource, /HUDHOOK_GUN_FROG_BUTTONS_READY/);
  assert.match(appEntry, /HUDHOOK_CLIENT_GUN_FROG_PROOF_READY/);
  assert.match(appEntry, /HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK/);

  for (const [name, top] of [
    ['continue', 80],
    ['new-game', 154],
    ['settings', 227],
    ['quit', 301],
  ]) {
    assert.match(
      mainOverlay,
      new RegExp(`name:\\s*['"]${name}['"][\\s\\S]{0,200}?top:\\s*${top}`),
    );
  }
  assert.match(mainOverlay, /left: 36/);
  assert.match(mainOverlay, /width: 335px/);
  assert.match(mainOverlay, /height: 56px/);
  assert.match(
    mainOverlay,
    /HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click/,
  );
});

test('the client exposes a restart-safe ReShade attachment lifecycle', () => {
  const appEntry = readClientFile('src', 'main', 'electron', 'app-entry.ts');
  const renderer = readClientFile('src', 'renderer', 'main.ts');
  const clientPage = readClientFile('index', 'index.html');

  assert.match(appEntry, /phase: ReShadeAttachmentPhase/);
  assert.match(appEntry, /'idle' \| 'attaching' \| 'connected'/);
  assert.match(appEntry, /RESHADE_CLIENT_ATTACHMENT_STATE/);
  assert.match(appEntry, /event === 'game\.process\.transport-lost'/);
  assert.match(appEntry, /event === 'game\.process\.disconnected'/);
  assert.doesNotMatch(appEntry, /PendingReShadeConnection/);
  assert.doesNotMatch(appEntry, /basename\(payload\.path\)/);
  assert.match(appEntry, /this\.reshadeLauncher\.state === 'idle'/);
  assert.match(appEntry, /'attach-indeterminate'/);
  assert.match(appEntry, /this\.reshadeAttachment\.phase !== 'connected'/);
  assert.match(appEntry, /this\.reshadeAttachment\.pid !== disconnectedPid/);
  assert.match(
    appEntry,
    /pid: result\.pid,[\s\S]{0,160}?this\.markGunFrogTargetConnected\(\)/,
  );
  assert.match(appEntry, /attachOverlayToProcess\(processName, pid\)/);
  assert.match(appEntry, /normalizeOptionalTargetPid\(pid\)/);
  assert.match(
    appEntry,
    /processName: normalizedProcessName,[\s\S]{0,100}?pid: normalizedPid/,
  );
  assert.match(appEntry, /\+\+this\.reshadeAttachmentAttempt/);
  assert.match(appEntry, /new TargetInputInterceptState\(\)/);
  assert.match(appEntry, /this\.handleTargetTransportEnded\(payload\)/);
  assert.match(appEntry, /attachment: this\.reshadeAttachment/);

  const reconnectHandler = sourceSection(
    appEntry,
    'private handleReShadeTargetReconnected',
    'private handleReShadeTargetTransportLost',
  );
  assert.match(reconnectHandler, /phase !== 'connected'/);
  assert.match(
    reconnectHandler,
    /this\.reshadeAttachment\.pid !== payload\.pid/,
  );
  assert.match(reconnectHandler, /this\.markGunFrogTargetConnected\(\)/);

  const transportLostHandler = sourceSection(
    appEntry,
    'private handleReShadeTargetTransportLost',
    'private handleReShadeTargetDisconnected',
  );
  assert.match(transportLostHandler, /phase === 'connected'/);
  assert.match(transportLostHandler, /phase !== 'attaching'/);
  assert.doesNotMatch(transportLostHandler, /setReShadeAttachmentState/);

  assert.match(
    renderer,
    /state\.runtime === null \|\|[\s\S]{0,100}?steamAutoAttachEnabled \|\|[\s\S]{0,100}?state\.attachment\.phase !== 'idle'/,
  );
  assert.match(
    renderer,
    /injectButton\.disabled = true;[\s\S]{0,160}?ipcRenderer\.invoke\('overlay:inject'/,
  );
  assert.match(
    renderer,
    /statusElement\.dataset\.attachmentPhase = state\.attachment\.phase/,
  );
  assert.match(renderer, /Ready to inject again/);
  assert.match(clientPage, /data-attachment-phase="idle"/);
  assert.match(clientPage, /id="process-pid"/);
  assert.match(clientPage, /max="4294967295"/);
  assert.match(
    renderer,
    /ipcRenderer\.invoke\('overlay:inject', processName, pid\)/,
  );
  assert.match(renderer, /Number\.isSafeInteger\(pid\)/);
  assert.match(renderer, /Injecting ReShade into/);

  const statusRenderer = sourceSection(
    renderer,
    'function renderAttachmentStatus',
    'function getErrorMessage',
  );
  assert.ok(
    statusRenderer.indexOf('if (state.attachment.error)') <
      statusRenderer.indexOf("state.attachment.phase === 'attaching'"),
    'attachment errors should render before the generic attaching status',
  );
});

test('the demo prearms native Steam-path injection before WMI lifecycle events', () => {
  const appEntry = readClientFile('src', 'main', 'electron', 'app-entry.ts');
  const devLaunch = readClientFile('src', 'main', 'dev-launch.ts');
  const renderer = readClientFile('src', 'renderer', 'main.ts');
  const watcher = readClientFile('process-watcher', 'index.cjs');
  const autoAttacher = readClientFile(
    'src',
    'main',
    'electron',
    'steam-game-auto-attacher.ts',
  );

  assert.match(devLaunch, /--steam-auto-attach/);
  assert.match(appEntry, /new SteamGameAutoAttacher/);
  assert.match(appEntry, /new ForkedProcessWatcher/);
  assert.match(appEntry, /this\.steamGameAutoAttacher\.start\(\)/);
  assert.match(appEntry, /this\.steamGameAutoAttacher\?\.dispose\(\)/);
  assert.match(
    appEntry,
    /steamAutoAttach: this\.steamGameAutoAttacher\?\.state/,
  );
  assert.match(
    appEntry,
    /Manual injection is disabled while Steam process auto-attach is enabled/,
  );
  assert.match(renderer, /steamAutoAttachEnabled/);
  assert.match(renderer, /Launch a Steam game to inject automatically/);
  assert.match(watcher, /import\('wql-process-monitor'\)/);
  assert.match(watcher, /process\.once\('disconnect'/);
  assert.match(watcher, /closeEventSink/);
  assert.match(
    autoAttacher,
    /STEAM_APPS_PATH_FRAGMENT = ['"]\\\\steamapps\\\\/,
  );
  assert.match(autoAttacher, /UnityCrashHandler64\.exe/);
  assert.match(autoAttacher, /this\.armNextSteamProcess\(\)/);
  assert.match(
    autoAttacher,
    /launcher\.attach[\s\S]{0,180}?pathContains: STEAM_APPS_PATH_FRAGMENT/,
  );
  assert.doesNotMatch(
    autoAttacher,
    /launcher\.attach[\s\S]{0,120}?processName,[\s\S]{0,80}?pid: info\.pid/,
  );
});

test('the normal demo presents an always-visible Ctrl+I dock and an interception menu', () => {
  const appEntry = readClientFile('src', 'main', 'electron', 'app-entry.ts');
  const devLaunch = readClientFile('src', 'main', 'dev-launch.ts');
  const windowNames = readClientFile(
    'src',
    'main',
    'electron',
    'window-names.ts',
  );
  const windowFactories = readClientFile(
    'src',
    'main',
    'electron',
    'example-overlay-windows.ts',
  );
  const controlOverlay = readClientFile(
    'public',
    'index',
    'demo-control-overlay.html',
  );

  assert.match(devLaunch, /--demo-presentation/);
  assert.match(windowNames, /demoControlOverlay = ["']demo-control-overlay/);
  assert.match(windowFactories, /createDemoControlOverlayWindow/);
  assert.match(windowFactories, /demo-control-overlay\.html/);
  assert.match(
    windowFactories,
    /if \(context\.demoPresentation\)[\s\S]{0,100}followTarget\(\{ area: 'render' \}\)/,
  );
  assert.match(appEntry, /DEMO_PRESENTATION_FLAG/);
  assert.match(
    appEntry,
    /process\.argv\.includes\(DEMO_PRESENTATION_FLAG\)[\s\S]{0,100}!this\.gunFrogInputProof/,
  );
  assert.match(
    appEntry,
    /this\.inputInterceptRequested[\s\S]{0,100}DEMO_CONTROL_OVERLAY_EXPANDED_SIZE[\s\S]{0,100}DEMO_CONTROL_OVERLAY_COMPACT_SIZE/,
  );
  assert.match(appEntry, /this\.syncDemoControlOverlay\(\)/);
  assert.match(appEntry, /for \(const window of this\.windows\.values\(\)\)/);
  assert.match(appEntry, /presentation: this\.demoPresentationEnabled/);
  assert.match(appEntry, /this\.overlaySession\.targets\.list\(\)\.at\(-1\)/);
  assert.match(appEntry, /targetSurfaceChanged/);
  assert.match(appEntry, /targetSurfaceRemoved/);
  assert.match(appEntry, /ipcMain\.handle\('overlay:create-popup'/);
  assert.match(appEntry, /event === 'game\.window\.focused'/);
  assert.match(appEntry, /this\.keepDemoControlOverlayOnTop\(payload\)/);
  assert.match(
    appEntry,
    /current\.hide\(\);[\s\S]{0,80}?current\.show\(\);[\s\S]{0,100}?webContents\.invalidate\(\)/,
  );
  const sessionStartup = sourceSection(
    appEntry,
    'private startOverlaySession',
    'private async attachOverlayToProcess',
  );
  assert.match(sessionStartup, /if \(this\.demoPresentationEnabled\)/);
  assert.match(sessionStartup, /this\.syncDemoControlOverlay\(\)/);
  assert.match(sessionStartup, /AppWindows\.exampleMainOverlay/);
  assert.match(sessionStartup, /AppWindows\.exampleStatusOverlay/);

  for (const id of [
    'demo-open-main',
    'demo-open-status',
    'demo-open-popup',
    'demo-open-video',
    'demo-release-input',
  ]) {
    assert.match(controlOverlay, new RegExp(`id=["']${id}["']`));
  }
  assert.match(controlOverlay, /overlay:get-state/);
  assert.match(controlOverlay, /overlay:state-changed/);
  assert.match(controlOverlay, /overlay:set-window-visible/);
  assert.match(controlOverlay, /overlay:create-popup/);
  assert.match(controlOverlay, /overlay:set-input-intercept/);
  assert.match(controlOverlay, /inputInterceptEffective/);
  assert.match(controlOverlay, /state\.targetSurface/);
  assert.match(controlOverlay, /surface\.graphicsApi/);
  assert.match(controlOverlay, /surface\?\.renderSize\?\.width/);
  assert.match(controlOverlay, /Ctrl\+I/);
});

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
