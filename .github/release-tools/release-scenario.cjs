'use strict';
// semantic-release intercepts stdout; keep it outside node:test's IPC stream.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Writable } = require('node:stream');

async function main() {
  const { default: release } = await import('./node_modules/semantic-release/index.js');
  const config = require('./release.config.cjs');
  const temp = process.argv[2];
  const remote = path.join(temp, 'remote.git');
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  const env = {
    PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, SystemRoot: process.env.SystemRoot,
    TMPDIR: temp, TMP: temp, TEMP: temp, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(temp, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Wurielle', GIT_AUTHOR_EMAIL: 'Wurielle@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Wurielle', GIT_COMMITTER_EMAIL: 'Wurielle@users.noreply.github.com',
  };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--bare', '--initial-branch=main', remote);
  git('init', '--initial-branch=main');
  git('remote', 'add', 'origin', remote);
  git('commit', '--allow-empty', '-m', 'feat: baseline');
  git('tag', 'v1.2.3');
  git('push', 'origin', 'main', '--tags');
  const quiet = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const run = () => release({ ...config,
    branches: ['main', ...config.branches.filter(branch => typeof branch === 'object')],
    repositoryUrl: remote, plugins: [config.plugins[0]], dryRun: false, ci: false,
  }, { cwd: repo, env, stdout: quiet, stderr: quiet });
  for (const [branch, channel] of [['alpha', 'alpha'], ['beta', 'beta'], ['rc', 'rc'], ['dev', 'nightly']]) {
    git('checkout', '-B', branch, 'main');
    git('commit', '--allow-empty', '-m', 'feat: add ' + channel + ' capability');
    git('push', 'origin', branch);
    assert.equal((await run()).nextRelease.version, `1.3.0-${channel}.1`);
    git('commit', '--allow-empty', '-m', 'fix: correct ' + channel + ' behavior');
    git('push', 'origin', branch);
    assert.equal((await run()).nextRelease.version, `1.3.0-${channel}.2`);
  }
  git('checkout', 'main');
  git('merge', '--ff-only', 'rc');
  git('push', 'origin', 'main');
  assert.equal((await run()).nextRelease.version, '1.3.0');
  git('commit', '--allow-empty', '-m', 'fix: correct stable behavior');
  git('push', 'origin', 'main');
  assert.equal((await run()).nextRelease.version, '1.3.1');
  git('commit', '--allow-empty', '-m', 'feat!: replace stable API');
  git('push', 'origin', 'main');
  assert.equal((await run()).nextRelease.version, '2.0.0');
  git('commit', '--allow-empty', '-m', 'docs: clarify API');
  git('push', 'origin', 'main');
  assert.equal(await run(), false, 'documentation-only commits do not release');
  console.log('Verified four prerelease channels, rc promotion, patch, breaking change and no-op releases');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
