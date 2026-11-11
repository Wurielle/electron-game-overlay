'use strict';
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const assert=require('node:assert/strict'), crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..');
const [probe,architecture='x64',runtimeOverride]=process.argv.slice(2);
assert.ok(['d2d_factory8','on_demand_input'].includes(probe));
assert.ok(['x64','x86'].includes(architecture));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const base=path.join(root,'build/overlay-compatibility/rendering-failure-probes',runtimeOverride?'prototype-validation':'',architecture);
const build=path.join(base,'build');
const headers=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src/include');
const runtime=runtimeOverride?path.resolve(runtimeOverride):path.join(root,'libs/electron-game-overlay-runtime/dist',architecture==='x64'?'win32-x64/ReShade64.dll':'win32-ia32/ReShade32.dll');
fs.mkdirSync(base,{recursive:true});
const run=(exe,args,timeout=120000)=>cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout,maxBuffer:4*1024*1024});
for(const args of [
  ['-S',__dirname,'-B',build,'-A',architecture==='x64'?'x64':'Win32',`-DRESHADE_INCLUDE_DIRECTORY=${headers}`],
  ['--build',build,'--config','Release','--target',probe,'--parallel','4'],
]) { const r=run('cmake.exe',args); assert.ifError(r.error); assert.equal(r.status,0,r.stdout+'\n'+r.stderr); }
const fixture=path.join(build,'Release',probe+'.exe');
const matrix=probe==='d2d_factory8' ? [
  ['clean7','-','7','proxy'],['clean8','-','8','proxy'],
  ['host7',runtime,'7','proxy'],['host8',runtime,'8','proxy'],
  ['original7',runtime,'7','original'],['original8',runtime,'8','original'],
  ['warp7',runtime,'7','warp'],['warp8',runtime,'8','warp'],
] : [['host',runtime]];
const results=[];
for(const [name,dll,...parameters] of matrix) {
  const directory=path.join(base,probe+'-'+name), owner=path.join(directory,'.fixture-owner.json');
  if(fs.existsSync(directory)) assert.deepEqual(JSON.parse(fs.readFileSync(owner)),{kind:'owned-rendering-failure-probe',probe,name,architecture});
  else { fs.mkdirSync(path.join(directory,'addons'),{recursive:true}); fs.writeFileSync(owner,JSON.stringify({kind:'owned-rendering-failure-probe',probe,name,architecture})); }
  fs.writeFileSync(path.join(directory,'ReShade.ini'),'[ADDON]\nAddonPath='+path.join(directory,'addons')+'\n[OVERLAY]\nTutorialProgress=4\n');
  const r=run(fixture,[dll,directory,...parameters],20000);
  fs.writeFileSync(path.join(directory,'stdout.log'),r.stdout??'');
  fs.writeFileSync(path.join(directory,'stderr.log'),r.stderr??'');
  const records=(r.stdout??'').trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  results.push({name,parameters,exitCode:r.status,signal:r.signal,error:r.error?.message??null,records,directory});
  console.log(JSON.stringify({name,exitCode:r.status,record:records.at(-1),error:r.error?.message}));
}
const report={schemaVersion:1,probe,architecture,createdUtc:new Date().toISOString(),runtime,runtimeSha256:sha(runtime),fixtureSha256:sha(fixture),
  sourceSha256:sha(path.join(__dirname,probe+'.cpp')),headers:{reshade:sha(path.join(headers,'reshade.hpp')),events:sha(path.join(headers,'reshade_events.hpp'))},
  actualApplicationAcceptance:false,physicalInput:false,productionMutated:false,results};
const output=path.join(base,probe+'-report.json');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output}));
const successful=r=>r.exitCode===0 && r.records.at(-1)?.createDeviceHresult===0 && r.records.at(-1)?.createContextHresult===0 && r.records.at(-1)?.greenReadback===true;
if(probe==='d2d_factory8') {
  for(const name of ['clean7','host7','original7','warp7']) assert.ok(successful(results.find(r=>r.name===name)),name+' control failed');
  const clean8=results.find(r=>r.name==='clean8');
  if(clean8.records.at(-1)?.status!=='unsupported') {
    assert.ok(successful(clean8),'clean factory8 failed');
    assert.ok(successful(results.find(r=>r.name==='original8')),'unwrapped factory8 control failed');
    assert.ok(successful(results.find(r=>r.name==='warp8')),'WARP factory8 control failed');
    if(runtimeOverride) assert.ok(successful(results.find(r=>r.name==='host8')),'prototype factory8 must pass bitmap import and pixel readback');
  }
} else assert.equal(results[0].records.at(-1)?.status,'reproduced',JSON.stringify(results[0]));
