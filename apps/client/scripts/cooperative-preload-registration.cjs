'use strict';

// Pure Node installer/controller fixture. It never imports Electron or starts an
// application. Selection reads the stable directory without copying any files;
// production attachment is exercised separately through the public launcher.
const fs = require('node:fs');
const path = require('node:path');
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const at = value.indexOf('=');
  if (!value.startsWith('--') || at < 3) throw new Error('Expected --name=value arguments');
  return [value.slice(2, at), value.slice(at + 1)];
}));

async function main() {
  for (const name of ['sdk-dist', 'application-id', 'action', 'output']) {
    if (!args[name]) throw new Error(`Missing ${name}`);
  }
  if (Boolean(args['storage-root']) === Boolean(args['addon-directory']))
    throw new Error('Specify exactly one isolated storage-root or addon-directory');
  const dist = fs.realpathSync(args['sdk-dist']);
  const output = path.resolve(args.output);
  const options = { applicationId: args['application-id'],
    ...(args['addon-directory'] ? { addonDirectory: path.resolve(args['addon-directory']) }
      : { storageRoot: path.resolve(args['storage-root']) }) };
  const api = require(path.join(dist, 'preload.js'));
  let result;
  if (args.action === 'register') {
    result = await api.registerOverlayAddonInstallation({ ...options, packageRoot: path.dirname(dist) });
  } else if (args.action === 'unregister') {
    await api.unregisterOverlayAddonInstallation(options);
    result = { ...options, unregistered: true };
  } else if (args.action === 'select' || args.action === 'snapshot') {
    const installation = await api.registerOverlayAddonInstallation({ ...options, packageRoot: path.dirname(dist) });
    const internal = require(path.join(dist, 'lib', 'overlay-addon-preload.js'));
    const selection = internal.resolveAddonPreloadSelection(options, installation);
    const snapshot = { directory: installation.addonDirectory,
      addonPath: installation.addonPath, x86AddonPath: installation.x86AddonPath };
    result = { installation, selection, snapshot,
      scope: 'Test-only selection of the registered stable directory. No snapshot, copy or move is performed.' };
  } else {
    throw new Error('Unknown action');
  }
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
