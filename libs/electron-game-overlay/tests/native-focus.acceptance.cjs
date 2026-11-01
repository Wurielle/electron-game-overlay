// Genuine Electron + public SDK + native target. Driven by the dedicated
// PowerShell launcher; no webContents.sendInputEvent or synthetic pointer input.
const { app, BrowserWindow } = require('electron');
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
} = require('../dist/index.js');
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
    launcher?.dispose();
  } catch {}
  try {
    overlay?.dispose();
  } catch {}
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
app.on('before-quit', cleanup);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app
  .whenReady()
  .then(async () => {
    overlay = new ElectronGameOverlay({ allowPrereleaseBroker: true });
    session = overlay.createSession();
    session.on('diagnostic', (diagnostic) => {
      state.events.push({ code: diagnostic.code, pid: diagnostic.pid });
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
    window = session.windows.create({
      id: `focus-${member}`,
      bounds: { x: member === 'a' ? 20 : 450, y: 60, width: 400, height: 180 },
    });
    state.windowId = window.nativeId;
    await window.browserWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<html><body style="background:#183044;color:white;font:24px sans-serif"><p id="prompt">Native keyboard focus ${member}</p><input id="text" autofocus style="font:24px sans-serif;width:95%"><script>window.downs=0;window.keys=0;window.heldKeys=new Set();addEventListener('pointerdown',()=>downs++);addEventListener('keydown',e=>{keys++;heldKeys.add(e.code)});addEventListener('keyup',e=>heldKeys.delete(e.code));document.querySelector('input').focus()</script></body></html>`,
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
        ? path.join(root, 'target', 'focus-native-host.exe')
        : args.target);
    let targetPid = Number(args.pid);
    if (member === 'a' && !args.game) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(args.host, targetPath);
      fs.writeFileSync(
        path.join(
          path.dirname(targetPath),
          'electron-game-overlay-startup-barrier.enabled',
        ),
        'owned acceptance target',
      );
      if (!args.future) {
        host = spawn(targetPath, [], {
          cwd: path.dirname(targetPath),
          windowsHide: false,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        targetPid = host.pid;
        state.targetPid = targetPid;
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        peer = spawn(
          process.execPath,
          [
            __filename,
            `--evidence=${root}`,
            '--member=b',
            `--pid=${targetPid}`,
            `--target=${targetPath}`,
          ],
          { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] },
        );
        state.peerPid = peer.pid;
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
            "({value:document.querySelector('input').value,pointerDowns:window.downs,keys:window.keys,heldKeys:[...window.heldKeys]})",
          ),
        );
        state.visible = window.visible;
        persist();
      } finally {
        reading = false;
      }
    }, 80);
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
