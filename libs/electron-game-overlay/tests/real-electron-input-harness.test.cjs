const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('real Electron acceptance preserves a failure report when SDK setup cannot load', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-ui-setup-failure-'));
  try {
    const loader = path.join(root, 'unavailable-sdk.cjs');
    const report = path.join(root, 'result.json');
    fs.writeFileSync(loader, `const Module=require('node:module'); const original=Module._load; Module._load=function(request,...args){if(request==='../dist/lib/overlay-broker-server.js')throw new Error('CONTROLLED_ACCEPTANCE_SETUP_UNAVAILABLE');return original.call(this,request,...args)};`);
    const result = spawnSync(process.execPath, ['--require', loader, path.join(__dirname, 'real-electron-input.acceptance.cjs'), report], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(report), true, 'fallible SDK setup must not prevent the failure-default report');
    const evidence = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(evidence.passed, false);
    assert.equal(evidence.electronReady, false);
    assert.equal(evidence.stage, 'setup');
    assert.equal(evidence.children.length, 0);
    assert.match(evidence.error, /CONTROLLED_ACCEPTANCE_SETUP_UNAVAILABLE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
