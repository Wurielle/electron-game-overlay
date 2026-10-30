const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const packager = require('../scripts/package-demo.cjs');

test('portable recovery diagnostic launcher uses bundled Node and canonical read-only case', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-recovery-package-'));
  try {
    fs.mkdirSync(path.join(root, 'resources/app'), { recursive: true });
    packager.writeLaunchers(root);
    const file = path.join(root, 'Start Broker Recovery Diagnostic.cmd');
    assert.equal(fs.existsSync(file), true, 'portable package must include the read-only diagnostic launcher');
    const launcher = fs.readFileSync(file, 'utf8');
    const canonical = fs.readFileSync(path.resolve(__dirname, '../../..', 'libs/electron-game-overlay-runtime/scripts/test-cases/broker-recovery-diagnostic.cmd'), 'utf8');
    assert.equal(launcher, canonical);
    assert.match(launcher, /resources\\node\\node\.exe/);
    assert.match(launcher, /resources\\app\\scripts\\broker-recovery-diagnostic\.cjs/);
    assert.match(launcher, /--output-dir/);
    assert.match(launcher, /--samples 180 --interval-ms 2000/);
    for (const hook of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) {
      assert.equal(launcher.includes(`set "${hook}="`), true, `clear inherited ${hook} before starting the bundled Node`);
    }
    assert.doesNotMatch(launcher, /taskkill|Stop-Process|Remove-Item|--register|--unregister|ElectronGameOverlayDemo\.exe/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery diagnostic copying preserves both modules without executing them', () => {
  assert.equal(typeof packager.copyRecoveryDiagnostic, 'function', 'diagnostic module copier must be available');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-recovery-modules-'));
  try {
    const source = path.join(root, 'source');
    const app = path.join(root, 'app');
    fs.mkdirSync(source);
    for (const name of ['broker-recovery-diagnostic.cjs', 'windows-broker-identity.cjs']) {
      fs.writeFileSync(path.join(source, name), `throw new Error('must not execute while copying ${name}');`);
    }
    packager.copyRecoveryDiagnostic(source, app);
    for (const name of fs.readdirSync(source)) {
      assert.deepEqual(fs.readFileSync(path.join(app, 'scripts', name)), fs.readFileSync(path.join(source, name)));
    }
    fs.unlinkSync(path.join(source, 'windows-broker-identity.cjs'));
    const invalidOutput = path.join(root, 'invalid-app');
    assert.throws(() => packager.copyRecoveryDiagnostic(source, invalidOutput), /ENOENT|missing/);
    assert.equal(fs.existsSync(invalidOutput), false, 'all source modules must validate before copying');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
