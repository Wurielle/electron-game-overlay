// Genuine Electron + public SDK + native target. Driven by the dedicated
// PowerShell launcher; no webContents.sendInputEvent or synthetic pointer input.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readNativeImageRaster } = require('../dist/lib/native-image-raster.js');
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
  lastPaintImage,
  lastPaintScale,
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
function describeSourceRaster(raster, cssBounds) {
  const { width, height, bitmap } = raster;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !Buffer.isBuffer(bitmap) || bitmap.length !== width * height * 4 || !(cssBounds.width > 0) || !(cssBounds.height > 0)) throw new Error('Invalid diagnostic source raster.');
  const scaleX = width / cssBounds.width;
  const scaleY = height / cssBounds.height;
  const calibration = {};
  for (const [name, cssX, cssY] of [['red', 460, 40], ['blue', 520, 40]]) {
    const x = Math.floor(cssX * scaleX), y = Math.floor(cssY * scaleY);
    if (x < 0 || y < 0 || x >= width || y >= height) throw new Error('Diagnostic source calibration point is outside the raster.');
    const offset = (y * width + x) * 4;
    calibration[name] = { cssX, cssY, x, y, bgra: [...bitmap.subarray(offset, offset + 4)] };
  }
  return { width, height, stride: width * 4, bytes: bitmap.length, bitmapSha256: createHash('sha256').update(bitmap).digest('hex'), cssBounds: { ...cssBounds }, scaleX, scaleY, calibration };
}
function describeSourceImage(image, cssBounds) {
  const raster = readNativeImageRaster(image);
  if (!raster) throw new Error('Diagnostic source image has no raster.');
  return { ...describeSourceRaster(raster, cssBounds), representationScaleFactor: raster.scaleFactor, imageSize: image.getSize(raster.scaleFactor), representationScales: image.getScaleFactors() };
}
function readPublishedDiagnostics(backend, windowId, cssBounds) {
  const metadata = backend?.windows?.get?.(windowId);
  const packet = backend?.latestFrames?.get?.(windowId);
  const result = { scope: 'Read-only retained producer transport state; not a native/GPU readback.', window: metadata ? JSON.parse(JSON.stringify(metadata)) : null, frame: null };
  if (Buffer.isBuffer(packet)) {
    if (packet.length < 17 || packet[4] !== 2 || packet.readUInt32LE(0) !== packet.length - 5 || packet.readUInt32LE(5) !== windowId) throw new Error('Diagnostic retained frame packet is malformed.');
    result.frame = describeSourceRaster({ width: packet.readUInt32LE(9), height: packet.readUInt32LE(13), bitmap: packet.subarray(17) }, cssBounds);
    result.frame.packetBytes = packet.length;
  }
  return result;
}
function buildGpuPixelRequest(scaleFactor) {
  if (!Number.isFinite(scaleFactor) || !(scaleFactor > 0) || scaleFactor > 2) throw new Error('GPU pixel diagnostic requires display scale above0 and at most2.');
  const points = [[Math.round(480 * scaleFactor), Math.round(100 * scaleFactor)], [Math.round(540 * scaleFactor), Math.round(100 * scaleFactor)], [1270, 710]];
  return { filename: 'electron-game-overlay-gpu-pixels-v1.request', points, samples: 8, intervalMs: 10000, scope: 'Three pixels only; first dispatcher own window; diagnostic GPU readback does not change strict desktop pixel acceptance.', control: `EGO_GPU_READBACK_V1 ${points.flat().join(' ')} 8 10000\n` };
}
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
      if (event.type === 'runtime-staged' && args['gpu-readback'] === 'true') {
        try {
          const request = buildGpuPixelRequest(state.scaleFactor);
          const filename = path.join(event.runDirectory, request.filename);
          fs.writeFileSync(filename, request.control, { encoding: 'ascii', flag: 'wx' });
          state.gpuPixelRequest = { ...request, file: filename };
        } catch (error) { state.gpuPixelRequestError = error.stack || String(error); }
      }
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
      try {
        const cssBounds = window.browserWindow.getContentBounds();
        state.latestPaint = describeSourceImage(image, cssBounds);
        state.latestPaint.at = Date.now();
        state.latestPaint.paintCount = state.paintCount;
        lastPaintImage = image;
        lastPaintScale = state.latestPaint.representationScaleFactor;
        state.sourceRed = state.latestPaint.calibration.red.bgra;
        state.sourceBlue = state.latestPaint.calibration.blue.bgra;
        state.published = readPublishedDiagnostics(overlay.nativeOverlay, window.nativeId, cssBounds);
        if (!state.sourceFirstPaintSaved) {
          fs.writeFileSync(path.join(root, 'source-first-paint.png'), image.toPNG({ scaleFactor: lastPaintScale }));
          state.sourceFirstPaintSaved = true;
        }
        if (!state.sourceCalibrationSaved && state.sourceRed.join(',') === '53,57,229,255') {
          fs.writeFileSync(path.join(root, 'source-calibration.png'), image.toPNG({ scaleFactor: lastPaintScale }));
          state.sourceCalibrationSaved = true;
        }
        if (!state.paint) state.paint = { dipSize: image.getSize(), scales: image.getScaleFactors(), bytes: state.latestPaint.bytes, rasterWidth: state.latestPaint.width, rasterHeight: state.latestPaint.height };
      } catch (error) { state.paintDiagnosticError = error.message; }
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
              case 'capture': {
                const capture = await window.browserWindow.webContents.capturePage();
                fs.writeFileSync(path.join(root, 'capture.png'), capture.toPNG());
                state.capture = describeSourceImage(capture, window.browserWindow.getContentBounds());
                if (lastPaintImage) fs.writeFileSync(path.join(root, 'source-latest-paint.png'), lastPaintImage.toPNG({ scaleFactor: lastPaintScale }));
                state.published = readPublishedDiagnostics(overlay.nativeOverlay, window.nativeId, window.browserWindow.getContentBounds());
                state.contentBounds = window.browserWindow.getContentBounds();
                state.bounds = window.getBounds();
                break;
              }
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
