# Automated SDK releases

The **SDK release** workflow publishes GitHub Releases on pushes (including PR
merges) to `main`, `dev`, `rc`, `alpha`, and `beta`. It never publishes to npm.
Each release uploads only `electron-game-overlay-<version>.tgz`, built on Windows
with both x64 and x86 native payloads. GitHub also supplies its own automatic
source archives; those are not uploaded build artifacts.

## Versions and changelog

`semantic-release` reads Conventional Commits since the previous applicable tag:

- `fix:` and `perf:` produce a patch release on `main`.
- `feat:` produces a minor release on `main`.
- `!` after a type/scope, or a `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer,
  produces a major release on `main`.
- `dev` produces `X.Y.Z-nightly.N`.
- `rc`, `alpha`, and `beta` produce `X.Y.Z-rc.N`, `X.Y.Z-alpha.N`, and
  `X.Y.Z-beta.N`, respectively.

Prerelease counters are independent per channel. Merge the actual prerelease
commits into `main` to promote them to the stable version. Preserve Conventional
Commit subjects when merging: a non-conventional squash title loses the original
commit information. Ordinary merge commits preserve the underlying subjects.
Docs, CI, chores and other non-release changes alone do not create stable,
RC, alpha or beta releases. On `dev`, every new commit can create a nightly,
including docs/CI-only pushes; feature and breaking changes still select the
correct next base version. Nightly denotes the development channel, not a
scheduled daily build.

The generated, categorized changelog is the GitHub Release body, including
breaking changes and commit links. No release commit or tracked `CHANGELOG.md`
is generated, so the workflow does not create push loops. The workspace package
version is not rewritten; the staged package metadata and distribution seal use
the computed release version, preserving sealed implementation bytes.

## Initial setup

The repository currently uses `dev` as its default branch and retains the legacy
`master` branch. Until `main` exists, `master` is used only as semantic-release's
stable-history anchor; pushes to `master` never trigger this workflow. Once `main`
is created, it automatically becomes the sole stable branch. This lets nightly
releases run before the first stable branch is created. Do not delete the legacy
anchor before creating `main`.

There are no existing release tags. The first computed release therefore starts
at `1.0.0` (`1.0.0-nightly.1`, etc. on prerelease branches), independent of the
workspace's manually maintained `0.1.0-rc.7` preview label. Existing previews are
not retroactively tagged or published. Subsequent versions follow release tags.
Create `main`, `rc`, `alpha`, and `beta` from the intended shared history when
those channels are needed; this change does not create or merge base branches.

Only the built-in `GITHUB_TOKEN` with `contents: write` is needed. No npm token
or additional repository secret is required. Repository rules must permit the
Actions token to create `v*` tags and GitHub Releases.

## Verification

Release-policy tests exercise real semantic-release tags and Git notes against
an isolated local bare repository, including all prerelease counters, RC
promotion, patch/major bumps and no-op commits. They also check generated release
notes and the absence of the npm publishing plugin:

```sh
npm ci --prefix .github/release-tools --ignore-scripts
node --test .github/release-tools/release.test.cjs
```

The Windows job builds and seals the native SDK, runs packaging/process-policy
checks, and installs the release tarball in an isolated offline consumer. The
installed tarball SHA-256 must equal the uploaded file. Pull requests touching
the release pipeline exercise that packaging path with a controlled
`0.0.0-nightly.0` version but do not publish releases or tags. Existing broker
compatibility checks remain separate required evidence for SDK behavior.
