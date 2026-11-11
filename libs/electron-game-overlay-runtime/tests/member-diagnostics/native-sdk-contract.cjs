'use strict';
// Read real native formatter output through the exact compiled SDK parser.
// The private export exists in this in-memory test module only.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..');
const entry=path.join(root,'libs/electron-game-overlay/dist/lib/reshade-launcher.js');
const source=fs.readFileSync(entry,'utf8');
assert.match(source,/function parseInjectorDiagnostic\(stdout\)/);
const fixture=new Module(entry,module);fixture.filename=entry;fixture.paths=Module._nodeModulePaths(path.dirname(entry));
fixture._compile(source+'\nexports.__nativeTestParser = parseInjectorDiagnostic;\n',entry);
const records=[];
for(const architecture of ['x64','x86']){
  const log=fs.readFileSync(path.join(root,`build/member-diagnostics-console/${architecture}.stdout.log`),'utf8');
  const lines=log.split(/\r?\n/).filter(line=>line.startsWith('ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC '));
  assert.equal(lines.length,16);
  for(const line of lines){const parsed=fixture.exports.__nativeTestParser(line);assert.equal(parsed.kind,'valid',JSON.stringify(parsed));records.push({architecture,code:parsed.diagnostic.code,stage:parsed.diagnostic.stage,injectionStarted:parsed.diagnostic.injectionStarted});}
}
const report={status:'passed',nativeCases:records.length,sdkParserSha256:crypto.createHash('sha256').update(source).digest('hex'),sdkFileModified:false,graphics:false,injection:false,records};
fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,nativeCases:records.length}));
