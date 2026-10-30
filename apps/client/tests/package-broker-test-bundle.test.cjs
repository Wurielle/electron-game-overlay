'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/package-broker-test-bundle.cjs');
const cells = ['x64-d3d9','x64-d3d10','x64-d3d11','x64-d3d12','x86-d3d9','x86-d3d10'];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function inventory(root) {
  return fs.readdirSync(root,{withFileTypes:true}).flatMap(e => e.isDirectory() ? inventory(path.join(root,e.name)).map(([p,h])=>[e.name+'/'+p,h]) : [[e.name,hash(fs.readFileSync(path.join(root,e.name)))]]).sort((a,b)=>a[0].localeCompare(b[0]));
}
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bundle ü space-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const options={current:path.join(root,'current source'),previous:path.join(root,'previous source'),output:path.join(root,'ego')};
  for(const role of ['current','previous']) {
    const app=options[role];
    const write=(p,b)=>{const f=path.join(app,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);};
    write('ElectronGameOverlayDemo.exe','controlled non-executable Electron fixture');
    write('resources/node/node.exe','controlled non-executable Node fixture');
    write('resources/app/package.json',JSON.stringify({main:'dist/main/main.js'}));
    write('resources/app/dist/main/main.js','controlled app');
    write('Start Broker Test.cmd','@echo off\r\n');
    const sdk='resources/app/node_modules/electron-game-overlay/';
    write(sdk+'package.json',JSON.stringify({name:'electron-game-overlay',version:'1.0.0'}));
    const impl='controlled '+role+' implementation\r\n';
    write(sdk+'dist/lib/overlay-broker-native-provider.js',impl);
    const sealed=Buffer.from([0,255,13,10,127]);
    write(sdk+'dist/broker/node_modules/tslib/tslib.js',sealed);
    write(sdk+'dist/broker/broker-manifest.json',JSON.stringify({schema:1,files:[{path:'node_modules/tslib/tslib.js',size:sealed.length,sha256:hash(sealed)}]}));
    write('SDK-REVISION.json','\uFEFF'+JSON.stringify({role,sdkSourceRevision:(role==='current'?'a':'b').repeat(40),sdkImplementationSha256:hash(impl),packageVersion:'1.0.0',...(role==='previous'?{sdkArtifactId:'12780691390'}:{})}));
    const hosts=cells.map(cell=>{const [architecture,backend]=cell.split('-');const p=`hosts/${architecture}/${backend}.exe`;const b=Buffer.from('controlled parser fixture '+cell);write('smoke/'+p,b);return {architecture,backend,path:p,size:b.length,sha256:hash(b)};});
    const runner=fs.readFileSync(path.resolve(__dirname,'../scripts/broker-smoke-host-runner.cjs'));
    write('smoke/broker-smoke-host-runner.cjs',runner);
    write('smoke/manifest.json',JSON.stringify({schemaVersion:1,hosts,runner:{path:'broker-smoke-host-runner.cjs',size:runner.length,sha256:hash(runner)}}));
  }
  return {root,options};
}
test('real CLI copies complete apps unchanged and creates exactly six automatically paired relative launchers',t=>{
  const {options}=fixture(t);const before=Object.fromEntries(['current','previous'].map(r=>[r,inventory(options[r])]));
  const result=spawnSync(process.execPath,[script,'--current',options.current,'--previous',options.previous,'--output',options.output],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.nativeExecuted,false);
  t.diagnostic(JSON.stringify({fixtureOnly:true,entryCount:report.entryCount,pairedLauncherCount:report.pairedLauncherCount,sourceFileCounts:{current:before.current.length,previous:before.previous.length}}));
  for(const role of ['current','previous']) {assert.deepEqual(inventory(options[role]),before[role]);assert.deepEqual(inventory(path.join(options.output,role)),before[role]);}
  const entries=inventory(options.output);assert.equal(entries.length,before.current.length+before.previous.length+9);assert.equal(report.entryCount,entries.length);
  assert.deepEqual(fs.readdirSync(path.join(options.output,'tests')).sort(),cells.map(c=>c+'.cmd').sort());
  for(const cell of cells) {
    const cmd=fs.readFileSync(path.join(options.output,'tests',cell+'.cmd'),'utf8');
    for(const quoted of ['"%~dp0..\\current\\resources\\node\\node.exe"','--app-a "%~dp0..\\current\\ElectronGameOverlayDemo.exe"','--app-b "%~dp0..\\previous\\ElectronGameOverlayDemo.exe"']) assert.ok(cmd.includes(quoted),quoted);
    assert.ok(cmd.includes('--architecture '+cell.split('-')[0]));assert.ok(cmd.includes('--backend '+cell.split('-')[1]));assert.doesNotMatch(cmd,/%\*|taskkill|powershell|npm/i);
    for(const match of cmd.matchAll(/"(%~dp0[^"]+)"/g)) {const resolved=path.resolve(options.output,'tests',match[1].replace('%~dp0','').replaceAll('\\',path.sep));assert.ok(!path.relative(options.output,resolved).startsWith('..'));if(!resolved.includes(path.sep+'results'+path.sep))assert.ok(fs.existsSync(resolved),resolved);}
  }
  for(const role of ['current','previous'])assert.ok(fs.readFileSync(path.join(options.output,role+'.cmd'),'utf8').includes(`call "%~dp0${role}\\Start Broker Test.cmd"`));
  const readme=fs.readFileSync(path.join(options.output,'README.md'),'utf8');assert.match(readme,/hotkey.*label/i);assert.match(readme,/tray/i);assert.match(readme,/desktop/i);assert.doesNotMatch(readme,/Ctrl\+I|Ctrl\+Shift\+I/);
});
module.exports={fixture,inventory};
test('rejects incomplete apps, mismatched raw SDK identities and unsafe sources without mutation',t=>{
  const {packageBundle}=require(script);
  for(const kind of ['node','revision','hash','same','symlink','seal']) {
    const {root,options}=fixture(t);
    const sdk=path.join(options.current,'resources/app/node_modules/electron-game-overlay/dist');
    if(kind==='node')fs.unlinkSync(path.join(options.current,'resources/node/node.exe'));
    if(kind==='revision')fs.writeFileSync(path.join(options.current,'SDK-REVISION.json'),'{}');
    if(kind==='hash')fs.appendFileSync(path.join(sdk,'lib/overlay-broker-native-provider.js'),'changed');
    if(kind==='same'){options.previous=options.current;}
    if(kind==='symlink'){const outside=path.join(root,'outside');fs.writeFileSync(outside,'private');fs.symlinkSync(outside,path.join(options.current,'escape'));}
    if(kind==='seal')fs.writeFileSync(path.join(sdk,'broker/node_modules/tslib/tslib.js'),'tampered');
    assert.throws(()=>packageBundle(options),undefined,kind);assert.equal(fs.existsSync(options.output),false,kind);
  }
});
test('preserves an existing destination and removes only its owned partial output after a real write failure',t=>{
  const {packageBundle}=require(script);const {root,options}=fixture(t);
  fs.mkdirSync(options.output);fs.writeFileSync(path.join(options.output,'keep'),'unchanged');
  assert.throws(()=>packageBundle(options));assert.equal(fs.readFileSync(path.join(options.output,'keep'),'utf8'),'unchanged');
  fs.rmSync(options.output,{recursive:true});const before=inventory(options.current);const original=fs.copyFileSync;
  try {fs.copyFileSync=function(from,to,...rest){if(String(to).includes(path.sep+'previous'+path.sep))throw Error('controlled copy failure');return original.call(this,from,to,...rest);};assert.throws(()=>packageBundle(options),/controlled copy failure/);}finally{fs.copyFileSync=original;}
  assert.equal(fs.existsSync(options.output),false);assert.deepEqual(inventory(options.current),before);assert.ok(fs.existsSync(options.previous));
});
