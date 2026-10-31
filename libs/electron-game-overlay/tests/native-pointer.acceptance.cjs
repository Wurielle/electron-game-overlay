// Genuine Electron + public SDK + native target. Driven by the dedicated
// PowerShell launcher; no webContents.sendInputEvent or synthetic pointer input.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((s) => s.startsWith('--'))
    .map((s) => {
      const i = s.indexOf('=');
      return [s.slice(2, i), s.slice(i + 1)];
    }),
);
const root = path.resolve(args.evidence);
const member = args.member || 'a';
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', path.join(root, `profile-${member}`));
app.disableHardwareAcceleration();
const {
  ElectronGameOverlay,
  ReShadeOverlayLauncher,
  parseReShadeLaunchConfig,
  OverlayTargetWatcher,
} = require('../dist/index.js');
let managed;
const auxiliaries = [];
let policyBroad;
let policyDeny;
const acceptOwnedBestEffort = (identity) =>
  identity.executablePath
    .replace(/\\/g, '/')
    .toLowerCase()
    .startsWith(policyBroad.slice(0, -2).toLowerCase());
let overlay,
  session,
  launcher,
  window,
  host,
  peer,
  probe,
  timer,
  done = false;
const state = {
  member,
  electron: process.versions.electron,
  attached: false,
  rendering: false,
  intercepting: false,
  events: [],
};
const persist = () =>
  fs.writeFileSync(
    path.join(root, `${member}-state.json`),
    JSON.stringify(state, null, 2),
  );
function cleanup() {
  if (done) return;
  done = true;
  clearInterval(timer);
  try {
    managed?.dispose();
    launcher?.dispose();
  } catch {}
  try {
    overlay?.dispose();
  } catch {}
  for (const child of auxiliaries) child.kill();
  peer?.kill();
  host?.kill();
}
function fail(error) {
  if (done) return;
  state.error = error.stack || String(error);
  persist();
  cleanup();
  app.exit(1);
}
async function waitManaged(predicate, label) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error('Timed out: ' + label);
}
app.on('before-quit', cleanup);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app
  .whenReady()
  .then(async () => {
    overlay = new ElectronGameOverlay({ allowPrereleaseBroker: true });
    session = overlay.createSession();
    session.on('diagnostic', (diagnostic) => {
      state.events.push({
        code: diagnostic.code,
        pid: diagnostic.pid,
        context: diagnostic.context,
      });
      if (diagnostic.code === 'runtime-scene-rendering-started')
        state.rendering = true;
    });
    session.on('inputInterceptionChanged', (value) => {
      state.intercepting = value.intercepting;
    });
    session.on('windowFocused', (value) => {
      state.nativeFocusedWindowId = value.windowId;
      state.focusRevision = (state.focusRevision || 0) + 1;
    });
    session.on('fps', () => {
      state.lastFpsAt = Date.now();
    });
    const config = parseReShadeLaunchConfig(['--reshade-overlay'], {
      runsRootDirectory: path.join(root, `runs-${member}`),
    });
    launcher = new ReShadeOverlayLauncher(config);
    launcher.onEvent((event) => {
      state.events.push({ type: event.type, at: Date.now() });
      if (event.type === 'injector-returned' && member === 'a' && !args.game) {
        fs.rmSync(
          path.join(
            root,
            'target/electron-game-overlay-startup-barrier.enabled',
          ),
          { force: true },
        );
      }
      if (
        event.type === 'injector-watcher-ready' &&
        (args.game || args.future) &&
        !host
      ) {
        setTimeout(
          () => {
            const executable = args.game || targetPath;
            host = spawn(executable, [], {
              cwd: path.dirname(executable),
              windowsHide: false,
              stdio: ['ignore', 'ignore', 'ignore'],
            });
            state.targetPid = host.pid;
            state.spawnedAt = Date.now();
          },
          Number(args['idle-ms'] || 0),
        );
      }
    });
    const windowOptions = {
      id: `focus-${member}`,
      bounds: { x: 20, y: 60, width: 600, height: 480 },
      browserWindow: {
        frame: false,
        thickFrame: false,
        resizable: false,
        webPreferences: {
          offscreen: args['osr-scale']
            ? { deviceScaleFactor: Number(args['osr-scale']) }
            : true,
          backgroundThrottling: false,
        },
      },
    };
    if (args.attached === 'true') {
      const backing = new BrowserWindow({
        ...windowOptions.browserWindow,
        ...windowOptions.bounds,
        show: false,
      });
      window = session.windows.attach(backing, {
        id: windowOptions.id,
        bounds: windowOptions.bounds,
      });
    } else window = session.windows.create(windowOptions);
    window.browserWindow.webContents.on('paint', (_, dirty, image) => {
      if (image.getScaleFactors().length === 0 || image.getSize().width <= 0)
        return;
      state.paintCount = (state.paintCount || 0) + 1;
      const sf = Math.max(...image.getScaleFactors()),
        data = image.toBitmap({ scaleFactor: sf });
      const stride = Math.round(600 * sf) * 4,
        at = Math.floor(40 * sf) * stride + Math.floor(460 * sf) * 4;
      state.sourceRed = [...data.subarray(at, at + 4)];
      if (
        !state.sourceCalibrationSaved &&
        data[at] === 53 &&
        data[at + 1] === 57 &&
        data[at + 2] === 229
      ) {
        fs.writeFileSync(
          path.join(root, 'source-calibration.png'),
          image.toPNG({ scaleFactor: sf }),
        );
        state.sourceCalibrationSaved = true;
      }

      if (!state.paint) {
        const scales = image.getScaleFactors();
        const scale = Math.max(...scales),
          bitmap = image.toBitmap({ scaleFactor: scale });
        state.paint = {
          dipSize: image.getSize(),
          scales,
          bytes: bitmap.length,
        };
      }
    });
    state.windowId = window.nativeId;
    state.scaleFactor = screen.getDisplayMatching(
      window.getBounds(),
    ).scaleFactor;
    window.browserWindow.webContents.on('cursor-changed', (_, type) => {
      state.cursor = type;
    });
    await window.browserWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<html><body style="margin:0;background:#183044;color:white;font:20px sans-serif"><input id="text" autofocus style="position:absolute;left:20px;top:10px;width:200px;height:30px"><a href="#" style="position:absolute;left:250px;top:10px;cursor:pointer">Link</a><div style="position:absolute;left:350px;top:10px;width:80px;height:30px;cursor:ew-resize">Resize</div><div id="pixel-red" style="position:absolute;left:440px;top:30px;width:40px;height:20px;background:#e53935"></div><div id="pixel-blue" style="position:absolute;left:500px;top:30px;width:40px;height:20px;background:#1e88e5"></div><div id="outer" style="position:absolute;left:20px;top:70px;width:520px;height:330px;overflow:auto"><div style="width:1100px;height:1500px"><div id="inner" style="width:300px;height:180px;overflow:auto;overscroll-behavior:contain"><div style="width:900px;height:900px;background:linear-gradient(#246,#654)">Nested scroller</div></div></div></div><script>window.downs=0;window.keys=0;window.heldKeys=new Set();window.wheels=[];addEventListener('pointerdown',()=>downs++);addEventListener('keydown',e=>{keys++;heldKeys.add(e.code)});addEventListener('keyup',e=>heldKeys.delete(e.code));addEventListener('wheel',e=>wheels.push({x:e.clientX,y:e.clientY,dx:e.deltaX,dy:e.deltaY,target:e.target.closest('[id]')?.id}));document.querySelector('input').focus()</script></body></html>`,
        ),
    );
    window.show();
    if (member === 'a') {
      window.focus();
      session.input.intercept();
    }
    const targetPath =
      args.game ||
      (member === 'a'
        ? path.join(
            root,
            args.policy ? 'steamapps' : 'target',
            args['basename-rule']
              ? path.basename(args.host)
              : 'focus-native-host.exe',
          )
        : args.target);
    let targetPid = Number(args.pid);
    if (member === 'a' && !args.game) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(args.host, targetPath);
      fs.writeFileSync(
        path.join(
          path.dirname(targetPath),
          {
            'wm-input': 'reshade-raw-wm-input-gate.enabled',
            'raw-buffer': 'reshade-raw-buffer-input-gate.enabled',
          }[args['input-mode']] || 'reshade-input-gate.enabled',
        ),
        'owned input oracle',
      );
      if (!args.policy)
        fs.writeFileSync(
          path.join(
            path.dirname(targetPath),
            'electron-game-overlay-startup-barrier.enabled',
          ),
          'owned acceptance target',
        );
      if (!args.future && !args.policy) {
        host = spawn(targetPath, [], {
          cwd: path.dirname(targetPath),
          windowsHide: false,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        targetPid = host.pid;
        state.targetPid = targetPid;
      }
    }
    state.policyUpdates = [];
    async function applyManagedPolicy(policy) {
      const record = {
        allow: policy.earlyPolicy.allow,
        deny: policy.earlyPolicy.deny ?? [],
        status: 'pending',
      };
      state.policyUpdates.push(record);
      try {
        await managed.update(policy);
        record.status = 'applied';
      } catch (error) {
        record.status = 'failed';
        record.error = String(error);
        throw error;
      }
    }
    let lastCommand = -1,
      reading = false;
    timer = setInterval(async () => {
      if (reading || done) return;
      reading = true;
      try {
        const commandPath = path.join(root, `${member}-command.json`);
        if (fs.existsSync(commandPath)) {
          const command = JSON.parse(
            fs.readFileSync(commandPath, 'utf8').replace(/^\uFEFF/, ''),
          );
          if (command.sequence !== lastCommand) {
            lastCommand = command.sequence;
            switch (command.action) {
              case 'prompt-a':
              case 'prompt-b':
                await window.browserWindow.webContents.executeJavaScript(
                  `document.querySelector('#prompt').textContent=${JSON.stringify(`Tap lowercase ${command.action.slice(-1)} once, then release. No click.`)}`,
                );
                break;
              case 'policy-add-redundant': {
                await applyManagedPolicy({
                  earlyPolicy: {
                    allow: [
                      policyBroad,
                      args['basename-rule']
                        ? '**/' + path.basename(targetPath)
                        : policyBroad.slice(0, -2) + path.basename(targetPath),
                    ],
                    deny: policyDeny,
                  },
                  ...(args['basename-rule']
                    ? {}
                    : { acceptBestEffort: acceptOwnedBestEffort }),
                });
                state.addedRedundantPreserved = managed.targets.some(
                  (t) =>
                    t.pid === state.targetPid &&
                    !t.cancelled &&
                    t.status === 'connected',
                );
                break;
              }
              case 'policy-redundant': {
                const before = managed.targets.find(
                  (t) => t.pid === state.targetPid,
                );
                await applyManagedPolicy({
                  earlyPolicy: { allow: [policyBroad], deny: policyDeny },
                  ...(args['basename-rule']
                    ? {}
                    : { acceptBestEffort: acceptOwnedBestEffort }),
                });
                state.redundantTargetPreserved =
                  before &&
                  managed.targets.some(
                    (t) =>
                      t.pid === before.pid &&
                      !t.cancelled &&
                      t.status === 'connected',
                  );
                break;
              }
              case 'policy-revoke': {
                const revision = applyManagedPolicy({
                  earlyPolicy: {
                    allow: [policyBroad],
                    deny: [
                      ...policyDeny,
                      policyBroad.slice(0, -2) + path.basename(targetPath),
                    ],
                  },
                  ...(args['basename-rule']
                    ? {}
                    : { acceptBestEffort: acceptOwnedBestEffort }),
                });
                state.revokedSynchronously = managed.targets.some(
                  (t) => t.pid === state.targetPid && t.cancelled,
                );
                await revision;
                break;
              }
              case 'policy-relaunch': {
                const pid = state.targetPid;
                host.kill();
                await waitManaged(
                  () =>
                    state.managedEvents.some(
                      (e) => e.type === 'exited' && e.pid === pid,
                    ),
                  'authoritative old target exit',
                );
                state.attached = false;
                state.rendering = false;
                host = spawn(targetPath, [], {
                  cwd: path.dirname(targetPath),
                  windowsHide: false,
                  stdio: 'ignore',
                });
                state.targetPid = host.pid;
                break;
              }
              case 'capture':
                fs.writeFileSync(
                  path.join(root, 'capture.png'),
                  (
                    await window.browserWindow.webContents.capturePage()
                  ).toPNG(),
                );
                state.contentBounds = window.browserWindow.getContentBounds();
                state.bounds = window.getBounds();
                break;
              case 'focus':
                await window.browserWindow.webContents.executeJavaScript(
                  "document.querySelector('input').focus()",
                );
                window.focus();
                break;
              case 'blur':
                window.blur();
                break;
              case 'hide':
                window.hide();
                break;
              case 'show':
                window.show();
                break;
              case 'clear':
                await window.browserWindow.webContents.executeJavaScript(
                  "document.querySelector('input').value=''",
                );
                break;
              case 'intercept':
                session.input.intercept();
                break;
              case 'release':
                session.input.release();
                break;
              case 'probe':
                probe = new BrowserWindow({ width: 320, height: 160 });
                await probe.loadURL(
                  'data:text/html,Owned foreground-focus probe',
                );
                probe.show();
                probe.focus();
                state.probeHwnd = probe
                  .getNativeWindowHandle()
                  .readBigUInt64LE()
                  .toString();
                break;
              case 'close-probe':
                probe?.destroy();
                probe = undefined;
                break;
              case 'exit':
                state.commandSequence = lastCommand;
                persist();
                cleanup();
                app.exit();
                return;
            }
            state.commandSequence = lastCommand;
          }
        }
        Object.assign(
          state,
          await window.browserWindow.webContents.executeJavaScript(
            "({value:document.querySelector('input').value,pointerDowns:window.downs,keys:window.keys,heldKeys:[...window.heldKeys],renderer:{dpr:devicePixelRatio,width:innerWidth,height:innerHeight},inner:{x:inner.scrollLeft,y:inner.scrollTop},outer:{x:outer.scrollLeft,y:outer.scrollTop},wheels:window.wheels})",
          ),
        );
        state.visible = window.visible;
        persist();
      } finally {
        reading = false;
      }
    }, 80);
    if (args.policy) {
      state.noStartupBarrier =
        !fs.existsSync(
          path.join(
            path.dirname(targetPath),
            'electron-game-overlay-startup-barrier.enabled',
          ),
        ) &&
        !fs.existsSync(
          path.join(path.dirname(targetPath), 'reshade-injection-wait.enabled'),
        );
      state.managedEvents = [];
      const baseline = spawn(targetPath, [], {
        cwd: path.dirname(targetPath),
        windowsHide: true,
        stdio: 'ignore',
      });
      auxiliaries.push(baseline);
      state.baselinePid = baseline.pid;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const helperPath = path.join(
        path.dirname(targetPath),
        'UnityCrashHandler64.exe',
      );
      fs.copyFileSync(args.host, helperPath);
      policyBroad = path.dirname(targetPath).replace(/\\/g, '/') + '/**';
      policyDeny = [policyBroad.slice(0, -2) + 'UnityCrashHandler64.exe'];
      state.initialPolicy = { allow: [policyBroad], deny: policyDeny };
      const outsidePath = path.join(root, 'outside', 'focus-native-host.exe');
      fs.mkdirSync(path.dirname(outsidePath));
      fs.copyFileSync(args.host, outsidePath);
      managed = new OverlayTargetWatcher(session, {
        config,
        earlyPolicy: state.initialPolicy,
        ...(args['basename-rule']
          ? {}
          : {
              acceptBestEffort: (identity) => {
                if (acceptOwnedBestEffort(identity))
                  throw Error(
                    'Native policy must never invoke JS best-effort fallback',
                  );
                return false;
              },
            }),
        onEvent: (event) => {
          state.managedEvents.push({
            type: event.type,
            ...(event.target
              ? {
                  pid: event.target.pid,
                  cancelled: event.target.cancelled,
                  identity: event.target.identity,
                }
              : {}),
            ...(event.error ? { error: event.error.message } : {}),
          });
          if (event.type === 'armed' && !host) {
            const outside = spawn(outsidePath, [], {
              cwd: path.dirname(outsidePath),
              windowsHide: true,
              stdio: 'ignore',
            });
            auxiliaries.push(outside);
            state.outsidePid = outside.pid;
            const helper = spawn(helperPath, [], {
              cwd: path.dirname(helperPath),
              windowsHide: true,
              stdio: 'ignore',
            });
            auxiliaries.push(helper);
            state.helperPid = helper.pid;
            host = spawn(targetPath, [], {
              cwd: path.dirname(targetPath),
              windowsHide: false,
              stdio: 'ignore',
            });
            state.targetPid = host.pid;
          }
          if (event.type === 'connected' && !event.target.cancelled) {
            state.attached = true;
            state.targetPid = event.target.pid;
            state.runtimeMode = 'managed-native-policy';
          }
          if (event.type === 'error' || event.type === 'discovery-blocked')
            state.managedFailure = event.error.message;
        },
      });
      await managed.ready;
      state.policyReady = true;
      persist();
      return;
    }
    const result = await launcher.attach(session, {
      processName: path.basename(targetPath),
      executablePath: targetPath,
      ...(args.game || args.future ? {} : { pid: targetPid }),
    });
    state.attached = true;
    state.targetPid = result.pid;
    state.runtimeMode = result.runtimeMode;
    persist();
  })
  .catch(fail);
