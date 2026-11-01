const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

function ownerHarness() {
  const calls = [];
  const instances = [];
  const nativePath = path.resolve(__dirname, '../dist/lib/native.js');
  const ownerPath = path.resolve(
    __dirname,
    '../dist/lib/electron-game-overlay.js',
  );
  const native = new Module(nativePath, module);
  native.filename = nativePath;
  native.paths = Module._nodeModulePaths(path.dirname(nativePath));
  const nativeRequire = Module.createRequire(nativePath);
  native.require = (id) => {
    if (id === './overlay-broker-client.js') throw new Error('the public owner must not load a feature broker');
    return id === './cooperative-overlay-transport.js'
      ? {
          CooperativeOverlayTransport: class {
            constructor(options) {
              calls.push(options);
              instances.push(this);
            }
            start() { throw new Error('constructor must remain transport-lazy'); }
          },
        }
      : nativeRequire(id);
  };
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
    return Module.createRequire(ownerPath)(id);
  };
  owner._compile(fs.readFileSync(ownerPath, 'utf8'), ownerPath);
  return { Owner: owner.exports.ElectronGameOverlay, calls, instances };
}

test('public owners create independent private backends without starting sessions, transport or a broker', () => {
  const { Owner, calls, instances } = ownerHarness();
  new Owner();
  new Owner({ allowPrereleaseBroker: false });
  assert.deepEqual(calls, [{ requiredInputCapabilities: undefined }, { requiredInputCapabilities: undefined }]);
  assert.equal(instances.length, 2);
  assert.notEqual(instances[0], instances[1]);
});

test('legacy prerelease flags do not elect a broker or discard the owner input-capability requirements', () => {
  const { Owner, calls } = ownerHarness();
  new Owner({ allowPrereleaseBroker: true });
  new Owner({ allowPrereleaseBroker: true, requiredInputCapabilities: ['copied-raw-input-buffer'] });
  assert.deepEqual(calls, [{ requiredInputCapabilities: undefined }, { requiredInputCapabilities: ['copied-raw-input-buffer'] }]);
});
