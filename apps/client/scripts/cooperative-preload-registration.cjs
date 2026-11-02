'use strict';

// Pure Node installer/controller fixture. It never imports Electron or starts an
// application. Only the self-load test uses the internal snapshot builder;
// production attachment is exercised separately through the public launcher.
const fs = require('node:fs');
const path = require('node:path');
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const at = value.indexOf('=');
  if (!value.startsWith('--') || at < 3) throw new Error('Expected --name=value arguments');
  return [value.slice(2, at), value.slice(at + 1)];
}));

async function main() {
  for (const name of ['sdk-dist', 'application-id', 'storage-root', 'action', 'output']) {
    if (!args[name]) throw new Error(`Missing ${name}`);
  }
  const dist = fs.realpathSync(args['sdk-dist']);
  const output = path.resolve(args.output);
  const options = { applicationId: args['application-id'], storageRoot: path.resolve(args['storage-root']) };
  const api = require(path.join(dist, 'preload.js'));
  let result;
  if (args.action === 'register') {
    result = await api.registerOverlayAddonInstallation({ ...options, packageRoot: path.dirname(dist) });
  } else if (args.action === 'unregister') {
    await api.unregisterOverlayAddonInstallation(options);
    result = { ...options, unregistered: true };
  } else if (args.action === 'snapshot') {
    if (!args.destination) throw new Error('Missing snapshot destination');
    const installation = await api.registerOverlayAddonInstallation({ ...options, packageRoot: path.dirname(dist) });
    const internal = require(path.join(dist, 'lib', 'overlay-addon-preload.js'));
    const selection = internal.resolveAddonPreloadSelection(options, installation);
    const snapshot = await internal.createOverlayAddonPreloadSnapshot(path.resolve(args.destination), selection);
    result = { installation, selection, snapshot, scope: 'Test-only snapshot assembly; not a public installer API claim.' };
  } else {
    throw new Error('Unknown action');
  }
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
