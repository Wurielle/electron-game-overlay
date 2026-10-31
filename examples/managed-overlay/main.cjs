// @ts-check
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const {
  ElectronGameOverlay,
  createReShadeLaunchConfig,
  OverlayTargetWatcher,
} = require('electron-game-overlay');
app.disableHardwareAcceleration();
/** @type {import('electron-game-overlay').ElectronGameOverlay | undefined} */
let owner;
/** @type {import('electron-game-overlay').OverlaySession | undefined} */
let session;
/** @type {import('electron-game-overlay').OverlayTargetWatcher | undefined} */
let targets;
function dispose() {
  targets?.dispose();
  session?.close();
  owner?.dispose();
}
app.on('before-quit', dispose);
void app
  .whenReady()
  .then(async () => {
    owner = new ElectronGameOverlay({ allowPrereleaseBroker: true });
    session = owner.createSession();
    if (process.argv.includes('--smoke')) {
      const page = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true },
      });
      await page.loadURL('data:text/html,<h1>Managed overlay example</h1>');
      if (
        (await page.webContents.executeJavaScript(
          "document.querySelector('h1').textContent",
        )) !== 'Managed overlay example'
      )
        throw Error('DOM smoke failed');
      console.log('SMOKE_OK: real Electron DOM and lazy SDK; no attachment.');
      page.destroy();
      app.quit();
      return;
    }
    const executablePath =
      process.argv.find((a) => a.startsWith('--target='))?.slice(9) ?? '';
    const directory = process.argv
      .find((a) => a.startsWith('--directory='))
      ?.slice(12);
    const deny = process.argv
      .filter((a) => a.startsWith('--deny='))
      .map((a) => a.slice(7));
    if (
      !!executablePath === !!directory ||
      !path.win32.isAbsolute(executablePath || directory || '')
    )
      throw Error(
        'Use --target=C:\\Games\\game.exe or --directory=C:\\Games with the game closed, or --smoke.',
      );
    if (deny.length && !directory) throw Error('--deny requires --directory.');
    if (directory && /[*?\[\]{}]/.test(directory))
      throw Error('--directory must be a literal absolute directory.');
    const config = createReShadeLaunchConfig({
      runsRootDirectory: path.join(app.getPath('userData'), 'overlay-runs'),
    });
    session.start();
    const panel = session.windows.create({
      id: 'managed-example',
      bounds: { x: 40, y: 60, width: 440, height: 280 },
      browserWindow: {
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    });
    await panel.browserWindow.loadURL(
      'data:text/html,<body style="background:%23183044;color:white"><h1>Managed overlay</h1><input id="message" autofocus placeholder="Type here"></body>',
    );
    // The application chooses the DOM input. SDK focus only chooses the overlay window.
    await panel.browserWindow.webContents.executeJavaScript(
      "document.querySelector('#message').focus()",
    );
    panel.show();
    panel.focus();
    session.input.intercept();
    targets = new OverlayTargetWatcher(session, {
      config,
      // Folder policy is checked natively before mutation; polling can miss fast startup.
      ...(directory
        ? {
            earlyPolicy: {
              allow: [directory.replace(/\\/g, '/').replace(/\/$/, '') + '/**'],
              deny,
            },
          }
        : {
            earlyTargets: [
              {
                processName: path.win32.basename(executablePath),
                executablePath,
              },
            ],
          }),
      onEvent(event) {
        if (event.type === 'armed')
          console.log('Watcher armed; launch the game now.');
        if (event.type === 'connected')
          console.log('Authenticated target', event.target.pid);
        if (
          event.type === 'exited' ||
          event.type === 'transport-lost' ||
          event.type === 'cancelled'
        )
          session?.input.release();
        if (event.type === 'error' || event.type === 'discovery-blocked')
          console.error(
            'Attachment stopped; no automatic retry.',
            event.error.message,
          );
      },
    });
    await targets.ready;
  })
  .catch((error) => {
    console.error(error.message);
    dispose();
    app.exit(1);
  });
