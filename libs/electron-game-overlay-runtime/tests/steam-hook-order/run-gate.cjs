'use strict';
// Owned DLL loader/factory model. Never loads Steam, creates an HWND or sends input.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),options={};
const args=process.argv.slice(2);
for(let i=0;i<args.length;i+=2){assert.ok(['--architecture','--runtime','--baseline-runtime'].includes(args[i]));assert.ok(args[i+1]);options[args[i]]=args[i+1];}
const architecture=options['--architecture']??'x64';assert.ok(['x64','x86'].includes(architecture));
const bits=architecture==='x64'?64:32,cache=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const sourceHash=sha(fs.readFileSync(path.join(cache,'source/hook_manager.cpp'),'utf8').replaceAll('\r\n','\n'));
assert.equal(sourceHash,'c62cd60c5afd66fafcf6f3e0659c88078685351cb20b9721742953c7d64516bb');
const runtime=path.resolve(options['--runtime']??path.join(root,'libs/electron-game-overlay-runtime/dist',architecture==='x64'?'win32-x64':'win32-ia32',`ReShade${bits}.dll`));
const baseline=path.resolve(options['--baseline-runtime']??path.join(root,'build/candidates/d3d11-identity-gen29/sdk-stage/dist/runtime/win32-x64/reshade',`ReShade${bits}.dll`));
assert.ok(fs.existsSync(baseline),'Supply a preserved generation-29 baseline runtime');
const base=path.join(root,'build/overlay-compatibility'),build=path.join(base,'steam-fixture-'+architecture);
function run(exe,args,timeout=120000){const r=cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout,maxBuffer:4*1024*1024});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r;}
run('cmake.exe',['--fresh','-S',__dirname,'-B',build,'-A',architecture==='x64'?'x64':'Win32','-DMINHOOK_SOURCE_DIR='+path.join(cache,'deps/minhook')]);
run('cmake.exe',['--build',build,'--config','Release','--parallel','4']);
const fixture=path.join(build,'Release/steam_hook_order.exe'),model=path.join(build,'Release',architecture==='x64'?'GameOverlayRenderer64.dll':'GameOverlayRenderer.dll');
const renamed=path.join(build,'Release/ego_owned_renderer_model.dll');fs.copyFileSync(model,renamed);
const cases=[
  ['baseline-key-present',baseline,model,'steam-first','match','present'],
  ['baseline-key-absent',baseline,model,'steam-first','mismatch','absent'],
  ['current-key-present',runtime,model,'steam-first','match','present'],
  ['current-key-absent',runtime,model,'steam-first','match','absent'],
  ['other-name-key-absent',runtime,renamed,'steam-first','mismatch','absent'],
  ['other-name-key-present',runtime,renamed,'steam-first','match','present'],
  ['later-renderer-existing-limitation',runtime,model,'reshade-first','mismatch','present'],
  ['no-renderer-no-key',runtime,'-','no-model','match','absent'],
];
const results=[];
for(const [name,dll,ownedModel,order,expectation,key] of cases){
  const directory=path.join(base,'steam-order-'+architecture+'-'+name),owner=path.join(directory,'.fixture-owner.json');
  if(fs.existsSync(directory))assert.equal(JSON.parse(fs.readFileSync(owner,'utf8')).kind,'ego-owned-steam-order-model');
  else{fs.mkdirSync(path.join(directory,'addons'),{recursive:true});fs.writeFileSync(owner,JSON.stringify({kind:'ego-owned-steam-order-model',architecture,name}));}
  fs.writeFileSync(path.join(directory,'ReShade.ini'),'[ADDON]\nAddonPath='+path.join(directory,'addons')+'\n');
  const r=run(fixture,[dll,ownedModel,directory,order,expectation,key],20000);
  fs.writeFileSync(path.join(directory,'stdout.log'),r.stdout);fs.writeFileSync(path.join(directory,'stderr.log'),r.stderr);
  const record=JSON.parse(r.stdout.trim());assert.equal(record.status,'passed');assert.equal(record.actualSteam,false);
  if(order==='no-model')assert.equal(record.noModelFactoryCreated,true);
  else{assert.equal(record.genericFactoryHookRegistration,expectation==='match');assert.equal(record.chainCalls,0);assert.equal(record.factoryCalls,1);}
  let loaderSnapshot=null;
  if(!name.startsWith('baseline-')){
    const snapshots=fs.readFileSync(path.join(directory,'ReShade.log'),'utf8').split(/\r?\n/).filter(s=>s.includes('EGO_COMPATIBILITY_SNAPSHOT_V1 ')).map(s=>JSON.parse(s.slice(s.indexOf('{'))));
    const loaders=snapshots.filter(s=>s.kind==='loader');assert.equal(loaders.length,1);loaderSnapshot=loaders[0];
    assert.equal(loaderSnapshot.runtimeGeneration,31);assert.equal(loaderSnapshot.enabled,true);assert.equal(loaderSnapshot.steamEnvironment,key==='present');
    const exactRenderer=order==='steam-first'&&ownedModel===model;assert.equal(loaderSnapshot.steamRenderer,exactRenderer);
    assert.equal(loaderSnapshot.strategy,key==='present'||exactRenderer?'load-library':'notification');
  }
  results.push({name,order,expectation,environmentKey:key,runtime:dll,runtimeSha256:sha(fs.readFileSync(dll)),record,loaderSnapshot});
}
const report={kind:'ego-owned-steam-loader-factory-hook-order-model',status:'passed',architecture,sourceSha256:sourceHash,fixtureSha256:sha(fs.readFileSync(fixture)),ownedModelSha256:sha(fs.readFileSync(model)),cases:results,actualSteam:false,graphics:false,input:false,runtimeCopiesCreated:0,
  scope:'Exact production host loader choice with an owned model of the documented foreign-vtable skip rule. Proves factory-hook registration for an already-loaded exact renderer name without the optional environment key; preserves environment-only and no-model controls. Does not establish actual Steam implementation, Present forwarding, rendered frames, all load orders, elevated injection or Overwatch acceptance. Later-renderer order remains an explicitly failing model control.'};
const output=path.join(base,'steam-hook-order-'+architecture+'-report.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:'passed',architecture,cases:results.length,output}));
