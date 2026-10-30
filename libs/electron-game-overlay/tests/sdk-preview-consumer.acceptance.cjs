'use strict';
// Install the candidate into a standalone consumer, check its public types and run noninjecting Electron smoke.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const report = { status:'failed', stage:'setup', nativeExecuted:false, commands:[] };
let reportPath, owned;
const inside = (root,file) => { const r=path.relative(root,file); return r==='' || (!path.isAbsolute(r) && r!=='..' && !r.startsWith('..'+path.sep)); };
function run(args,cwd,env,executable=process.execPath) {
  const result=spawnSync(executable,args,{cwd,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,shell:false});
  report.commands.push({executable,args,exitCode:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr,error:result.error?.message});
  assert.equal(result.status,0,result.stderr || result.error?.message || result.stdout);
  return result.stdout;
}
try {
  const at=process.argv.indexOf('--report');
  if(at<0 || !process.argv[at+1]) throw Error('--report is required');
  reportPath=path.resolve(process.argv[at+1]);
  fs.mkdirSync(path.dirname(reportPath),{recursive:true});
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  const {values}=parseArgs({options:Object.fromEntries(['candidate-report','example-root','scratch-root','report'].map(key=>[key,{type:'string'}]))});
  for(const key of ['candidate-report','example-root','scratch-root']) assert.ok(values[key],`--${key} is required`);
  const candidate=JSON.parse(fs.readFileSync(values['candidate-report'],'utf8'));
  assert.equal(candidate.status,'passed');
  const tarball=fs.realpathSync(candidate.tarball);
  report.tarballSha256=createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  assert.equal(report.tarballSha256,candidate.tarballSha256);
  owned=fs.mkdtempSync(path.join(fs.realpathSync(values['scratch-root']),'sdk-installed-consumer-'));
  const consumer=path.join(owned,'consumer');
  fs.cpSync(fs.realpathSync(values['example-root']),consumer,{recursive:true,filter:file=>!['node_modules','tests','package-lock.json'].includes(path.basename(file))});
  const env={...process.env,NODE_PATH:'',NODE_OPTIONS:'',ELECTRON_SKIP_BINARY_DOWNLOAD:'1',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'};
  delete env.NODE_TEST_CONTEXT; delete env.ELECTRON_RUN_AS_NODE;
  const bin=path.dirname(process.execPath);
  const npm=[process.env.npm_execpath,path.join(bin,'node_modules/npm/bin/npm-cli.js'),path.join(bin,'../lib/node_modules/npm/bin/npm-cli.js')].find(file=>file && /npm-cli\.js$/.test(file) && fs.existsSync(file));
  assert.ok(npm,'npm JavaScript CLI required beside Node');
  report.stage='install';
  run([npm,'install','--ignore-scripts','--prefer-offline','--no-audit','--no-fund','--package-lock=false',tarball],consumer,env);
  const req=createRequire(path.join(consumer,'package.json'));
  const installed=fs.realpathSync(path.join(consumer,'node_modules/electron-game-overlay'));
  assert.ok(inside(consumer,installed),'SDK must not be a workspace symlink');
  const entry=req.resolve('electron-game-overlay');
  assert.ok(inside(installed,fs.realpathSync(entry)));
  const metadata=req('electron-game-overlay/package.json');
  assert.equal(metadata.version,candidate.version);
  assert.equal(metadata.private,false);
  report.installed={version:metadata.version,entry:path.relative(consumer,entry),electronVersion:req('electron/package.json').version};
  report.stage='types';
  const ts=require('typescript');
  const main=path.join(consumer,'main.cjs');
  const options={allowJs:true,checkJs:true,noEmit:true,strict:true,module:ts.ModuleKind.Node16,target:ts.ScriptTarget.ES2022,types:['node'],typeRoots:[path.join(consumer,'node_modules/@types')]};
  const host=ts.createCompilerHost(options); host.getCurrentDirectory=()=>consumer;
  const program=ts.createProgram([main],options,host);
  const diagnostics=ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>consumer,getNewLine:()=>os.EOL}));
  const rootSource=program.getSourceFile(main); assert.ok(rootSource);
  report.typeFiles=program.getSourceFiles().filter(file=>!program.isSourceFileDefaultLibrary(file) && file!==rootSource).map(file=>{
    assert.ok(inside(path.join(consumer,'node_modules'),fs.realpathSync(file.fileName)),'declaration escaped installed dependency tree: '+file.fileName);
    return path.relative(consumer,file.fileName);
  });
  report.stage='electron';
  const electron=require('electron');
  assert.ok(typeof electron==='string' && fs.existsSync(electron),'genuine installed Electron executable required');
  const wrapper=path.join(consumer,'smoke-driver.cjs');
  fs.writeFileSync(wrapper,`const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict'),Module=require('node:module');
const root=__dirname, sdk=fs.realpathSync(path.join(root,'node_modules/electron-game-overlay'));
const within=(a,b)=>{const r=path.relative(a,b);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));};
const resolve=Module._resolveFilename;
Module._resolveFilename=function(request,parent,...rest){const value=resolve.call(this,request,parent,...rest);if(parent&&typeof parent.filename==='string'&&within(sdk,parent.filename)&&!Module.isBuiltin(value)&&value!=='electron')assert.ok(within(path.join(root,'node_modules'),fs.realpathSync(value)),'SDK ancestor fallback');return value;};
assert.ok(within(sdk,require.resolve('electron-game-overlay')));
const {app}=require('electron');app.setPath('userData',path.join(root,'profile'));app.setPath('sessionData',path.join(root,'session'));
process.argv=[process.execPath,path.join(root,'main.cjs'),'--smoke'];require('./main.cjs');\n`);
  const stdout=run(['--disable-gpu',...(process.platform==='linux'?['--no-sandbox','--ozone-platform=headless']:[]),wrapper],consumer,env,electron);
  assert.ok(stdout.includes('SMOKE_OK:'),'real consumer must report completed DOM smoke');
  report.electronSmokePassed=true;
  report.status='passed';report.stage='complete';
} catch(error) { report.error=error.message;process.exitCode=1; }
finally {
  try { if(owned) fs.rmSync(owned,{recursive:true,force:true,maxRetries:3}); report.cleanup='completed'; }
  catch(error) { report.status='failed';report.cleanup=error.message;process.exitCode=1; }
  if(reportPath) fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,stage:report.stage,electronSmokePassed:report.electronSmokePassed||false,error:report.error}));
}
