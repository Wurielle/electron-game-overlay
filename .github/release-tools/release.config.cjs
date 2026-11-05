'use strict';
const { spawnSync } = require('node:child_process');
// The legacy master branch anchors semantic-release before main is created.
// It is never a release trigger; once main exists, only main is stable.
const mainExists = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main']).status === 0;
module.exports = {
  branches: [
    mainExists ? 'main' : 'master',
    { name: 'alpha', channel: 'alpha', prerelease: 'alpha' },
    { name: 'beta', channel: 'beta', prerelease: 'beta' },
    { name: 'rc', channel: 'rc', prerelease: 'rc' },
    { name: 'dev', channel: 'nightly', prerelease: 'nightly' },
  ],
  tagFormat: 'v${version}',
  plugins: [
    [require.resolve('@semantic-release/commit-analyzer'), {
      preset: 'conventionalcommits',
      parserOpts: { noteKeywords: ['BREAKING CHANGE', 'BREAKING-CHANGE'] },
      releaseRules: process.env.GITHUB_REF_NAME === 'dev'
        ? [{ breaking: true, release: 'major' }, { type: 'feat', release: 'minor' }, { release: 'patch' }]
        : [{ breaking: true, release: 'major' }],
    }],
    [require.resolve('@semantic-release/release-notes-generator'), {
      preset: 'conventionalcommits',
      parserOpts: { noteKeywords: ['BREAKING CHANGE', 'BREAKING-CHANGE'] },
    }],
    [require.resolve('@semantic-release/exec'), {
      prepareCmd: 'node .github/release-tools/prepare.cjs ${nextRelease.version}',
    }],
    [require.resolve('@semantic-release/github'), {
      assets: [{ path: 'artifacts/release/*.tgz' }],
      successComment: false,
      failComment: false,
      failTitle: false,
      addReleases: false,
      releasedLabels: false,
    }],
  ],
};
