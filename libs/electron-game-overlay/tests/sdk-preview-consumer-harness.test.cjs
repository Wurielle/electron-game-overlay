'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('candidate consumer setup failure replaces stale success before launching Electron', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-consumer-report-'));
  try {
    const report = path.join(root, 'report.json');
    fs.writeFileSync(report, JSON.stringify({status:'passed',nativeExecuted:true}));
    const result = spawnSync(process.execPath, [path.join(__dirname,'sdk-preview-consumer.acceptance.cjs'), '--candidate-report',path.join(root,'missing.json'),'--example-root',root,'--scratch-root',root,'--report',report], {encoding:'utf8',timeout:10000});
    const saved = JSON.parse(fs.readFileSync(report,'utf8'));
    assert.equal(saved.status,'failed','setup failure must invalidate stale success');
    assert.equal(saved.nativeExecuted,false);
    assert.equal(saved.stage,'setup');
    assert.match(saved.error,/ENOENT/);
    assert.equal(result.status,1);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
