'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const compiler = require('typescript');

// Evaluate the actual acceptance filter, located structurally with TypeScript's
// parser, so this cannot pass while a separate replica of the filter is fixed.
const source = compiler.createSourceFile('acceptance.cjs', fs.readFileSync(
  path.join(__dirname, 'broker-package-install.acceptance.cjs'), 'utf8'),
compiler.ScriptTarget.Latest, true, compiler.ScriptKind.JS);
let declaration;
function visit(node) {
  if (compiler.isVariableDeclaration(node) && node.name.getText(source) === 'declarations') declaration = node;
  compiler.forEachChild(node, visit);
}
visit(source);
assert.ok(declaration, 'actual declaration filter must exist');
const filter = declaration.initializer.expression.expression;
assert.equal(filter.expression.name.text, 'filter');

 test('actual installed declaration filter excludes a Windows-normalized consumer by SourceFile identity', () => {
  const typeFile = 'C:\\runner\\temp\\consumer\\consumer.cts';
  const dependency = 'C:/runner/temp/consumer/node_modules/pkg/index.d.ts';
  const options = { target: compiler.ScriptTarget.ES2022, types: [], noEmit: true };
  const host = compiler.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...rest) => {
    const normalized = file.replace(/\\/g, '/');
    if ([typeFile.replace(/\\/g, '/'), dependency].includes(normalized)) {
      return compiler.createSourceFile(file, 'export {};', languageVersion, true);
    }
    return original(file, languageVersion, ...rest);
  };
  const program = compiler.createProgram([typeFile, dependency], options, host);
  const consumerSource = program.getSourceFile(typeFile);
  assert.ok(consumerSource, 'real TypeScript root lookup must succeed');
  assert.equal(consumerSource.fileName, 'C:/runner/temp/consumer/consumer.cts');
  assert.notEqual(consumerSource.fileName, typeFile, 'must reproduce Windows separator mismatch');
  assert.equal(program.isSourceFileDefaultLibrary(consumerSource), false);
  const declarations = vm.runInNewContext(filter.getText(source), { program, typeFile, consumerSource });
  assert.equal(declarations.includes(consumerSource), false, 'consumer root must not enter installed-only declaration assertions');
  assert.deepEqual(Array.from(declarations, (file) => file.fileName), [dependency]);
});
