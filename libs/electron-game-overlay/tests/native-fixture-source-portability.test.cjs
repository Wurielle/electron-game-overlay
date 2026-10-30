'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

for (const ending of ['LF', 'CRLF']) {
  test(`native-free harness extraction accepts an actual ${ending} checkout`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-harness-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['native-fixture-lifecycle.test.cjs', 'native-injection-binding.acceptance.cjs']) {
      const original = fs.readFileSync(path.join(__dirname, name), 'utf8');
      const lf = original.replace(/\r\n/g, '\n');
      const content = ending === 'CRLF' ? lf.replace(/\n/g, '\r\n') : lf;
      fs.writeFileSync(path.join(root, name), content);
      if (ending === 'CRLF') assert.ok(content.includes('\r\n'));
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--test', '--test-name-pattern=legacy-positive',
      path.join(root, 'native-fixture-lifecycle.test.cjs'),
    ], { env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /legacy-positive precondition/);
  });
}
