const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process');
const {
  createOverlayProcessPolicy: policy,
  overlayProcessPolicyAllows: allows,
  serializeOverlayProcessPolicy: serialize,
} = require('../dist/lib/process-policy.js');
const cases = [
  ['C:\\Steam\\steamapps\\common\\Gun Frog\\Gun Frog.exe', true],
  ['D:/STEAMAPPS/game.exe', true],
  ['C:/steamapps-evil/game.exe', false],
  ['C:/other/game.exe', false],
  ['C:/steamapps/UnityCrashHandler64.exe', false],
  ['C:/steamapps/a/private/game.exe', false],
  ['C:/steamapps/a/game.exe', true],
  ['C:/steamapps/.hidden/game.exe', true],
  ['C:/Program Files (x86)/Steam/steamapps/a/game.exe', true],
  ['C:/steamapps/日本語/é.exe', true],
  ['C:/STEAMAPPS/UnityCrashHandler32.exe', false],
];
const rules = {
  allow: ['**/steamapps/**'],
  deny: ['**/UnityCrashHandler??.exe', '**/private/**'],
};
test('folder policy has component boundaries, full-path deny precedence, Unicode and no hidden helper heuristic', () => {
  const p = policy(rules);
  for (const [file, expected] of cases)
    assert.equal(allows(p, file), expected, file);
  assert.equal(
    allows(
      policy({ allow: ['**/steamapps/**'] }),
      'C:/steamapps/UnityCrashHandler64.exe',
    ),
    true,
  );
  assert.equal(
    allows(policy({ allow: ['C:/Games/*/game?.exe'] }), 'C:/Games/a/game1.exe'),
    true,
  );
  assert.equal(
    allows(
      policy({ allow: ['C:/Games/*/game?.exe'] }),
      'C:/Games/a/b/game1.exe',
    ),
    false,
  );
  assert.equal(
    allows(
      policy({ allow: ['//server/share/**'] }),
      '\\\\server\\share\\game.exe',
    ),
    true,
  );
});
test('unrepresentable policies fail closed rather than broadening permission or accepting a post-creation predicate', () => {
  for (const pattern of [
    '!**/blocked/**',
    '**/{a,b}/**',
    '**/[ab]/**',
    '**/@(a|b)/**',
    'relative/game.exe',
    '**/../game.exe',
    '**/ab**cd.exe',
    '**/x\t.exe',
    '**/+(a|b)/**',
    '**/\ud800/**',
  ]) {
    assert.throws(
      () => policy({ allow: [pattern] }),
      /policy|pattern/i,
      pattern,
    );
  }
  assert.equal(allows(policy(rules), 'C:/steamapps/\ud800.exe'), false);
  assert.equal(
    allows(
      policy({ allow: ['C:/Program Files (x86)/**'] }),
      'C:/Program Files (x86)/game.exe',
    ),
    true,
  );
  assert.throws(() => policy({ allow: [] }), /1..256/);
  assert.throws(
    () => policy({ allow: ['**/' + Array(129).fill('a').join('/')] }),
    /pattern/i,
  );
  const input = { allow: ['**/STEAMAPPS/**', '**/steamapps/**'], deny: [] },
    p = policy(input);
  input.allow.push('**/other/**');
  assert.equal(p.allow.length, 1);
  assert.equal(Object.isFrozen(p.allow), true);
  assert.equal(allows(p, 'C:/other/game.exe'), false);
});
for (const arch of ['x64', 'x86'])
  test(
    'real ' +
      arch +
      ' native evaluator agrees with the production JS policy; invalid documents reject without injection',
    (t) => {
      if (process.platform !== 'win32') {
        t.skip('Windows native evaluator');
        return;
      }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-native-policy-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const exe = path.resolve(
          __dirname,
          '../dist/runtime/win32-x64/reshade',
          arch === 'x64' ? 'inject.exe' : 'inject32.exe',
        ),
        file = path.join(root, 'policy.txt');
      fs.writeFileSync(file, serialize(policy(rules)));
      for (const [image, expected] of cases) {
        const r = spawnSync(exe, ['--check-process-policy', file, image], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(
          r.stdout.trim(),
          expected ? 'EGO_PROCESS_POLICY_ALLOW' : 'EGO_PROCESS_POLICY_DENY',
          image,
        );
      }
      for (const doc of [
        'invalid',
        'EGO_PROCESS_POLICY_V1\nA\t**/{a,b}/**\n',
        'EGO_PROCESS_POLICY_V1\nA\t**/steamapps/**\nB\t0\n',
        'EGO_PROCESS_POLICY_V1\nA\t**/steamapps/**\nX\t42\t01\n',
      ]) {
        fs.writeFileSync(file, doc);
        const r = spawnSync(
          exe,
          ['--check-process-policy', file, 'C:/steamapps/game.exe'],
          { encoding: 'utf8', timeout: 5000, windowsHide: true },
        );
        assert.notEqual(r.status, 0);
        assert.equal(r.stdout.includes('EGO_TARGET_SELECTED'), false);
      }
    },
  );
