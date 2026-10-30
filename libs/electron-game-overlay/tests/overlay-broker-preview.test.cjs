const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

function ownerHarness() {
  const calls = [];
  const nativePath = path.resolve(__dirname, '../dist/lib/native.js');
  const ownerPath = path.resolve(
    __dirname,
    '../dist/lib/electron-game-overlay.js',
  );
  const native = new Module(nativePath, module);
  native.filename = nativePath;
  native.paths = Module._nodeModulePaths(path.dirname(nativePath));
  native.require = (id) =>
    id === './overlay-broker-client.js'
      ? {
          OverlayBrokerClient: class {
            constructor(options) {
              calls.push(options);
            }
          },
        }
      : require(id);
  native._compile(fs.readFileSync(nativePath, 'utf8'), nativePath);
  const owner = new Module(ownerPath, module);
  owner.filename = ownerPath;
  owner.paths = Module._nodeModulePaths(path.dirname(ownerPath));
  owner.require = (id) => {
    if (id === './native.js') return native.exports;
    if (id === './overlay-session.js')
      return {
        createOverlaySession() {
          throw new Error('constructor must remain session-lazy');
        },
      };
    return require(id);
  };
  owner._compile(fs.readFileSync(ownerPath, 'utf8'), ownerPath);
  return { Owner: owner.exports.ElectronGameOverlay, calls };
}

test('stable broker selection stays the default for existing and explicit-false callers', () => {
  const { Owner, calls } = ownerHarness();
  new Owner();
  new Owner({ allowPrereleaseBroker: false });
  assert.deepEqual(calls, [undefined, undefined]);
});

test('public owner explicitly opts into prerelease broker selection without starting a session', () => {
  const { Owner, calls } = ownerHarness();
  new Owner({ allowPrereleaseBroker: true });
  assert.deepEqual(calls, [{ brokerInstallation: { allowPrerelease: true } }]);
});
