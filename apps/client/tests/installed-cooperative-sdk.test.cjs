'use strict';
// Package resolution, immutable payloads and isolated assertion helpers only.
// No Electron, game, native add-on, input API or complete game gate executes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writeCooperativeDistribution } = require('../../../libs/electron-game-overlay/tests/helpers/cooperative-package-fixture.cjs');
const { inspectInstalledCooperativeSdk, loadInstalledCooperativeSdk, inspectInstalledPairReport } = require('../scripts/installed-cooperative-sdk.cjs');
const root = path.resolve(__dirname, '../../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-installed-entrypoint-'));
  t.after(() => { assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
function consumer(directory, member) {
  const consumerRoot = path.join(directory, member);
  const packageRoot = path.join(consumerRoot, 'node_modules/electron-game-overlay');
  const dist = path.join(packageRoot, 'dist');
  const version = `0.1.0-development.fixture.${member}`;
  const fixture = writeCooperativeDistribution(dist, { packageVersion: version });
  fs.cpSync(path.join(dist, 'node_modules/tslib'), path.join(packageRoot, 'node_modules/tslib'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.js'), `module.exports = { controlledMarker: '${member}' };\n`);
  fixture.seal();
  json(path.join(consumerRoot, 'package.json'), { name: `controlled-consumer-${member}`, private: true });
  const metadata = { name: 'electron-game-overlay', version, main: './dist/index.js', exports: { '.': { require: './dist/index.js' }, './package.json': './package.json' } };
  json(path.join(packageRoot, 'package.json'), metadata);
  const originalSeal = JSON.parse(fs.readFileSync(path.join(dist, 'overlay-manifest.json'), 'utf8'));
  originalSeal.packageVersion = '0.1.0-rc.7';
  json(path.join(packageRoot, 'SOURCE_OVERLAY_MANIFEST.json'), originalSeal);
  json(path.join(packageRoot, 'SOURCE_PACKAGE.json'), { ...metadata, version: originalSeal.packageVersion });
  const sourceManifestSha256 = hash(fs.readFileSync(path.join(packageRoot, 'SOURCE_OVERLAY_MANIFEST.json')));
  json(path.join(packageRoot, 'SDK_PROVENANCE.json'), { source: { overlayManifestSha256: sourceManifestSha256, packageVersion: originalSeal.packageVersion }, transform: { sealedPayloadBytesChanged: false, sealedFilesInventoryChanged: false } });
  const observed = inspectInstalledCooperativeSdk(consumerRoot);
  return { consumerRoot, packageRoot, dist, version, sourcePackageVersion: originalSeal.packageVersion,
    sourceManifestSha256, sourcePackageJsonSha256: hash(fs.readFileSync(path.join(packageRoot, 'SOURCE_PACKAGE.json'))),
    provenanceSha256: hash(fs.readFileSync(path.join(packageRoot, 'SDK_PROVENANCE.json'))),
    sourceSealedFilesSha256: observed.sealedFilesSha256, stagedManifestSha256: observed.installedManifestSha256,
    installedManifestSha256: observed.installedManifestSha256, installedPackageJsonSha256: hash(fs.readFileSync(path.join(packageRoot, 'package.json'))),
    resolvedEntrypoint: observed.entrypoint };
}

test('independent consumer requires load their own installed public package entrypoints', t => {
  const directory = sandbox(t);
  const a = consumer(directory, 'a');
  const b = consumer(directory, 'b');
  const first = loadInstalledCooperativeSdk(a.consumerRoot);
  const second = loadInstalledCooperativeSdk(b.consumerRoot);
  assert.equal(first.sdk.controlledMarker, 'a');
  assert.equal(second.sdk.controlledMarker, 'b');
  assert.notEqual(first.sdk, second.sdk);
  assert.equal(first.evidence.entrypoint, path.join(a.dist, 'index.js'));
  assert.equal(first.evidence.packageVersion, a.version);
  assert.equal(first.evidence.loadMethod, "createRequire(consumer/package.json)('electron-game-overlay')");
});

test('missing installation and exported index escapes never fall back to the repository SDK', t => {
  const directory = sandbox(t);
  const a = consumer(directory, 'a');
  const metadata = JSON.parse(fs.readFileSync(path.join(a.packageRoot, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(a.packageRoot, 'other.js'), 'module.exports = {};\n');
  metadata.exports['.'].require = './other.js';
  json(path.join(a.packageRoot, 'package.json'), metadata);
  assert.throws(() => inspectInstalledCooperativeSdk(a.consumerRoot), /public entrypoint/u);
  assert.throws(() => inspectInstalledCooperativeSdk(directory), /ENOENT/u);
});

test('installed entrypoint byte changes are rejected by the original payload seal', t => {
  const directory = sandbox(t);
  const a = consumer(directory, 'a');
  fs.appendFileSync(path.join(a.dist, 'index.js'), '// unexpected change\n');
  assert.throws(() => inspectInstalledCooperativeSdk(a.consumerRoot), /integrity|size|hash|sealed/u);
});

test('the installed dependency copy must remain exact to the sealed payload before SDK execution', t => {
  const directory = sandbox(t);
  const a = consumer(directory, 'a');
  fs.appendFileSync(path.join(a.packageRoot, 'node_modules/tslib/tslib.js'), '// modified dependency\n');
  assert.throws(() => loadInstalledCooperativeSdk(a.consumerRoot), /bundled dependency/u);
});

test('pair preflight binds independent versions to saved original seals and unchanged payload inventories', t => {
  const directory = sandbox(t);
  const a = consumer(directory, 'a');
  const b = consumer(directory, 'b');
  const file = path.join(directory, 'report.json');
  const report = { schemaVersion: 1, kind: 'electron-game-overlay-installed-development-pair', status: 'passed', releasedPackageCompatibilityClaimed: false, participants: { a, b } };
  json(file, report);
  const observed = inspectInstalledPairReport(file);
  assert.equal(observed.participants.a.packageVersion, a.version);
  assert.equal(observed.participants.b.packageVersion, b.version);
  report.participants.b = a;
  json(file, report);
  assert.throws(() => inspectInstalledPairReport(file), /independently installed/u);
  report.participants.b = b;
  json(file, report);
  fs.appendFileSync(path.join(a.packageRoot, 'SOURCE_OVERLAY_MANIFEST.json'), ' ');
  assert.throws(() => inspectInstalledPairReport(file), /unchanged source payloads/u);
});

test('installed producer retains the canonical real-game window/input/attachment behavior exactly', () => {
  const read = name => fs.readFileSync(path.join(root, 'apps/client/scripts', name), 'utf8').replace(/\r\n/g, '\n');
  const original = read('cooperative-two-app-game-fixture.cjs');
  const installed = read('installed-two-app-game-fixture.cjs');
  assert.equal(installed.slice(installed.indexOf('let overlay,')), original.slice(original.indexOf('let overlay,')));
  assert.match(installed, /loadInstalledCooperativeSdk\(path\.resolve\(args\['app-root'\]\)\)/u);
  assert.doesNotMatch(installed, /require\(path\.join\(sdkEvidence\.sdkDist/u);
});

test('installed game launcher keeps all four default matrix cells and requires differing implementation bytes', () => {
  const script = fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-installed-package-game-gate.ps1'), 'utf8');
  assert.match(script, /StartupOrder = 'both'/u);
  assert.match(script, /FirstAppExit = 'both'/u);
  assert.match(script, /RequireDifferentImplementations = \$true/u);
  for (const field of ['SdkDistA', 'SdkDistB', 'AppRootA', 'AppRootB', 'FixturePath']) assert.match(script, new RegExp(`\\b${field} =`));
  assert.match(script, /run-client-sdk-cooperative-two-app-game-gate\.ps1/u);
});

test('actual controller installed-entrypoint guard rejects foreign roots, hashes and direct-index load claims', { skip: process.platform !== 'win32' }, t => {
  const directory = sandbox(t);
  const a = consumer(directory, 'a');
  const evidencePath = path.join(directory, 'sdk.json');
  json(evidencePath, { sdkDist: a.dist, packageVersion: a.version, installedPackage: inspectInstalledCooperativeSdk(a.consumerRoot) });
  const runner = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-cooperative-two-app-game-gate.ps1');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile(${quote(runner)},[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
$Function=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Assert-InstalledPackageEvidence'},$true)
if(-not $Function){throw 'Installed public entrypoint assertion missing'}
. ([scriptblock]::Create($Function.Extent.Text))
$Good=Get-Content -LiteralPath ${quote(evidencePath)} -Raw|ConvertFrom-Json
$Consumer=${quote(a.consumerRoot)};$Dist=${quote(a.dist)}
$null=Assert-InstalledPackageEvidence $Good $Consumer $Dist
foreach($Mutation in @('consumerRoot','packageRoot','entrypoint','installedManifestSha256','entrySha256','loadMethod','schemaVersion','releasedPackageCompatibilityClaimed')){
 $Bad=Get-Content -LiteralPath ${quote(evidencePath)} -Raw|ConvertFrom-Json
 switch($Mutation){
  'schemaVersion' {$Bad.installedPackage.schemaVersion='1'}
  'releasedPackageCompatibilityClaimed' {$Bad.installedPackage.releasedPackageCompatibilityClaimed=$true}
  'loadMethod' {$Bad.installedPackage.loadMethod='require(absolute index.js)'}
  'installedManifestSha256' {$Bad.installedPackage.installedManifestSha256='0'*64}
  'entrySha256' {$Bad.installedPackage.entrySha256='0'*64}
  default {$Bad.installedPackage.$Mutation='C:\\foreign\\wrong'}
 }
 $Rejected=$false;try{$null=Assert-InstalledPackageEvidence $Bad $Consumer $Dist}catch{$Rejected=$true}
 if(-not $Rejected){throw ('Accepted incorrect installed package proof: '+$Mutation)}
}
Write-Output 'Installed public-entrypoint evidence accepted only exact private consumer and sealed hashes.'
`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stdout + '\n' + run.stderr);
  assert.match(run.stdout, /accepted only exact private consumer/u);
});
