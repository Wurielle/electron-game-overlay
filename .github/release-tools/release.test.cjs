'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
function configFor(branch) {
  const previous = process.env.GITHUB_REF_NAME;
  process.env.GITHUB_REF_NAME = branch;
  const file = require.resolve('./release.config.cjs');
  delete require.cache[file];
  try { return require(file); }
  finally {
    if (previous === undefined) delete process.env.GITHUB_REF_NAME;
    else process.env.GITHUB_REF_NAME = previous;
  }
}

test('dev emits a nightly for docs and chores without hiding feature or breaking bumps', async () => {
  const [entry, options] = configFor('dev').plugins[0];
  const { analyzeCommits } = await import(pathToFileURL(entry));
  for (const [message, expected] of [['docs: clarify setup', 'patch'], ['chore: refresh tooling', 'patch'], ['feat: add API', 'minor'], ['feat!: replace API', 'major']]) {
    assert.equal(await analyzeCommits(options, { cwd: root, commits: [{ hash: 'abcdef0', message }], logger: { log() {} } }), expected, message);
  }
});

test('release configuration exposes all channels and only a tgz GitHub asset', () => {
  const config = configFor('main');
  const channels = config.branches.filter(branch => typeof branch === 'object');
  assert.deepEqual(channels.map(({ name, prerelease }) => [name, prerelease]), [
    ['alpha', 'alpha'], ['beta', 'beta'], ['rc', 'rc'], ['dev', 'nightly'],
  ]);
  assert.equal(config.tagFormat, 'v${version}');
  assert.equal(config.plugins.some(plugin => JSON.stringify(plugin).includes('@semantic-release/npm')), false);
  const github = config.plugins.find(plugin => Array.isArray(plugin) && plugin[0].includes('@semantic-release/github'))[1];
  assert.deepEqual(github.assets, [{ path: 'artifacts/release/*.tgz' }]);
  assert.equal(github.successComment, false);
  assert.equal(github.failComment, false);
  assert.equal(github.addReleases, false);
});

test('Conventional Commits determine stable major, minor and patch releases', async () => {
  const [entry, options] = configFor('main').plugins[0];
  const { analyzeCommits } = await import(pathToFileURL(entry));
  for (const [message, expected] of [
    ['feat: add overlay API', 'minor'],
    ['fix(input): correct routing', 'patch'],
    ['perf: avoid a copy', 'patch'],
    ['feat!: replace API', 'major'],
    ['fix(api)!: remove old argument', 'major'],
    ['chore: change contract\n\nBREAKING CHANGE: old API removed', 'major'],
    ['docs: clarify setup', null],
  ]) {
    assert.equal(await analyzeCommits(options, {
      cwd: root, commits: [{ hash: 'abcdef0', message }], logger: { log() {} },
    }), expected, message);
  }
});

test('real local releases increment each prerelease channel and promote rc to stable', { timeout: 120000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-release-policy-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp,
    SystemRoot: process.env.SystemRoot, TMPDIR: temp, TMP: temp, TEMP: temp };
  const result = spawnSync(process.execPath, [path.join(__dirname, 'release-scenario.cjs'), temp], {
    cwd: root, env, encoding: 'utf8', timeout: 110000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Verified four prerelease channels/);
});

test('generated changelog contains features, fixes and breaking changes', async () => {
  const [entry, options] = configFor('main').plugins[1];
  const { generateNotes } = await import(pathToFileURL(entry));
  const notes = await generateNotes(options, {
    cwd: root, options: { repositoryUrl: 'https://github.com/Wurielle/electron-game-overlay' },
    lastRelease: { version: '1.2.3', gitTag: 'v1.2.3' },
    nextRelease: { version: '2.0.0', gitTag: 'v2.0.0' },
    commits: ['feat: add overlay API', 'fix: correct input', 'feat!: remove old API'].map((message, index) => ({ hash: String(index).repeat(40), message })),
    logger: { log() {} },
  });
  for (const expected of ['add overlay API', 'correct input', 'BREAKING CHANGES', 'remove old API']) assert.ok(notes.includes(expected), notes);
});
