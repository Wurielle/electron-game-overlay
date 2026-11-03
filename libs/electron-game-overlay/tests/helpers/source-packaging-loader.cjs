'use strict';
// Test-only current-source seam. The exact trusted workspace validator is
// transpiled in memory under its normal compiled filename. Incoming SDK code,
// canonical dist bytes and npm/native/desktop behavior are never modified.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const sourcePath = path.resolve(__dirname, '../../src/lib/overlay-package-manifest.ts');
const compiledPath = path.resolve(__dirname, '../../dist/lib/overlay-package-manifest.js');
const transformed = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  reportDiagnostics: true,
});
const errors = transformed.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error);
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
  getCanonicalFileName: file => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
}));
const loaded = new Module(compiledPath, module);
loaded.filename = compiledPath;
loaded.paths = Module._nodeModulePaths(path.dirname(compiledPath));
loaded._compile(transformed.outputText, compiledPath);
loaded.loaded = true;
require.cache[compiledPath] = loaded;
module.exports = { validatorSource: transformed.outputText, preloadArgs: ['--require', __filename] };
