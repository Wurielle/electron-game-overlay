const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const packageRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');

const read = (...segments) => readFileSync(path.join(...segments), 'utf8');

test('consumer docs point to the canonical TypeScript declarations', () => {
  const readme = read(workspaceRoot, 'README.md');
  const packageJson = JSON.parse(read(packageRoot, 'package.json'));

  assert.equal(packageJson.types, './dist/index.d.ts');
  assert.match(readme, /## API map/);
  assert.match(
    readme,
    /exported TypeScript\s+declarations are the API source of truth/,
  );
  assert.match(readme, /libs\/electron-game-overlay\/src\/lib\/sdk\.ts/);
  assert.doesNotMatch(readme, /## Public API reference/);
});

test('every package-root export has declaration-site documentation', () => {
  const configPath = path.join(packageRoot, 'tsconfig.lib.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined);

  const config = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    packageRoot,
    undefined,
    configPath,
  );
  assert.deepEqual(config.errors, []);

  const program = ts.createProgram(config.fileNames, config.options);
  const checker = program.getTypeChecker();
  const sdkSource = program.getSourceFile(
    path.join(packageRoot, 'src', 'lib', 'sdk.ts'),
  );
  assert.ok(sdkSource, 'expected the package SDK entry point');

  const moduleSymbol = checker.getSymbolAtLocation(sdkSource);
  assert.ok(moduleSymbol, 'expected a symbol for the package SDK entry point');

  const undocumented = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) =>
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol,
    )
    .filter(
      (symbol) =>
        ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
          .length === 0,
    )
    .map((symbol) => symbol.getName())
    .sort();

  assert.deepEqual(undocumented, []);
});

test('emitted declarations expose the typed consumer API only', () => {
  const sdk = read(packageRoot, 'dist', 'lib', 'sdk.d.ts');
  const session = read(packageRoot, 'dist', 'lib', 'overlay-session.d.ts');
  const window = read(
    packageRoot,
    'dist',
    'lib',
    'electron-overlay-window.d.ts',
  );
  const launcher = read(packageRoot, 'dist', 'lib', 'reshade-launcher.d.ts');
  const types = read(packageRoot, 'dist', 'lib', 'types.d.ts');

  assert.doesNotMatch(sdk, /\bbuildReShadeInvocation\b/);
  assert.doesNotMatch(sdk, /\bReShadeInvocation\b/);
  assert.doesNotMatch(sdk, /\bElectronOverlayWindowOptions\b/);

  assert.match(session, /private constructor\(\);/);
  assert.doesNotMatch(session, /\bauthorizeTarget\s*\(/);
  assert.match(window, /private constructor\(\);/);

  assert.match(launcher, /attach\(session: OverlaySession,/);
  assert.doesNotMatch(launcher, /\bacceptTargetConnection\s*\(/);
  assert.doesNotMatch(launcher, /\blaunch\s*\(/);

  for (const eventName of [
    'targetConnected',
    'targetTransportLost',
    'targetDisconnected',
    'inputInterceptionChanged',
    'windowFocused',
  ]) {
    assert.match(types, new RegExp(`\\b${eventName}\\b`));
  }
  assert.doesNotMatch(types, /\bnativeEvent\b/);
  assert.doesNotMatch(types, /\bany\b/);
});
