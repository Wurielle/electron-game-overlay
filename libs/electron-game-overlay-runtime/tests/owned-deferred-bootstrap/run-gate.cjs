'use strict';
// Offscreen production gate with an immutable missed-adoption baseline.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),arch=process.argv[2]??'x64',requested=process.argv[3]??'all';assert.ok(['x64','x86'].includes(arch));
const work=path.join(root,'build/overlay-compatibility'),source=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src'),proto=path.join(work,'owned-deferred-d3d11-prototype');
const runtimeKind=process.argv[4]??'production';assert.ok(['production','prototype'].includes(runtimeKind));
const build=path.join(work,'owned-deferred-bootstrap-'+arch),runtimeName=arch==='x64'?'ReShade64.dll':'ReShade32.dll';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(exe,args,timeout=120000){const value=cp.spawnSync(exe,args,{windowsHide:true,encoding:'utf8',timeout,maxBuffer:4*1024*1024});assert.ifError(value.error);assert.equal(value.status,0,value.stdout+'\n'+value.stderr);return value;}
const configuration=run('cmake.exe',['-S',__dirname,'-B',build,'-A',arch==='x64'?'x64':'Win32','-DRESHAPE_SOURCE='+source]);
const compilation=run('cmake.exe',['--build',build,'--config','Release','--parallel','4']);fs.writeFileSync(path.join(work,'owned-deferred-bootstrap-'+arch+'-build.log'),configuration.stdout+compilation.stdout+compilation.stderr);
const binary=path.join(build,'Release'),reports=[];
const modes=['contended','contended-composition','serialized','dllmain','nested','foreign','unready','no-backend','queue-failure','revoked-ready','revoked-stage','notification-control'];
assert.ok(requested==='all'||requested==='baseline'||modes.includes(requested));
const baseline=path.join(root,'build/candidates/composition-auxiliary-lifetime-gen35/sdk-stage/dist/runtime/win32-x64/reshade',runtimeName);
for(const kind of requested==='all'?['baseline',runtimeKind]:[requested==='baseline'?'baseline':runtimeKind]){
 const input=kind==='baseline'?baseline:kind==='prototype'?path.join(proto,'bin',arch==='x64'?'x64':'Win32',runtimeName):path.join(root,'libs/electron-game-overlay-runtime/dist',arch==='x64'?'win32-x64':'win32-ia32',runtimeName);
 if(kind==='production'){const stamp=JSON.parse(fs.readFileSync(path.join(path.dirname(input),runtimeName.replace('.dll','.build.json')),'utf8').replace(/^\uFEFF/,''));assert.equal(stamp.ownedDeferredD3d11PatchSha256,'779D9D41768FE61BC5FF3DCF69E2EE11B360DC00B5B58C24E0B1F83552A2D9BB');}
 const stage=path.join(work,'owned-deferred-bootstrap-stage-'+arch+'-'+kind),owner=path.join(stage,'.fixture-owner.json');
 if(fs.existsSync(stage))assert.equal(JSON.parse(fs.readFileSync(owner)).kind,'owned-deferred-bootstrap');else{fs.mkdirSync(path.join(stage,'addons'),{recursive:true});fs.writeFileSync(owner,JSON.stringify({kind:'owned-deferred-bootstrap',arch}));}
 const runtime=path.join(stage,runtimeName);if(fs.existsSync(runtime)&&hash(runtime)!==hash(input))fs.unlinkSync(runtime);if(!fs.existsSync(runtime))fs.linkSync(input,runtime);assert.equal(hash(runtime),hash(input));
 const marker=path.join(stage,'electron-game-overlay-owned-runtime-v1.marker');
 for(const mode of kind==='baseline'?['contended','contended-composition']:requested==='all'?modes.filter(item=>kind!=='prototype'||item!=='notification-control'):[requested]){
  fs.writeFileSync(marker,'ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1\n');if(mode==='foreign')fs.unlinkSync(marker);
  fs.writeFileSync(path.join(stage,'.electron-game-overlay-run.json'),JSON.stringify({kind:'owned-deferred-bootstrap'}));
  fs.writeFileSync(path.join(stage,'ReShade.ini'),'[ADDON]\nAddonPath='+path.join(stage,'addons')+'\n[OVERLAY]\nTutorialProgress=4\nShowClock=0\nShowFPS=0\n[GENERAL]\nNoDebugInfo=1\nPerformanceMode=1\n');
  const result=cp.spawnSync(path.join(binary,'owned_deferred_bootstrap.exe'),[runtime,path.join(binary,'callback_counter.dll'),path.join(binary,'nested_loader.dll'),path.join(binary,mode==='dllmain'?'dllmain_loader.dll':'nested_loader.dll'),stage,mode,kind],{windowsHide:true,encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024});
  const prefix=path.join(work,'owned-deferred-bootstrap-'+arch+'-'+kind+'-'+mode);fs.writeFileSync(prefix+'.stdout.log',result.stdout??'');fs.writeFileSync(prefix+'.stderr.log',result.stderr??'');if(fs.existsSync(path.join(stage,'ReShade.log')))fs.copyFileSync(path.join(stage,'ReShade.log'),prefix+'.ReShade.log');
  assert.ifError(result.error);assert.equal(result.status,kind==='baseline'?3:0,kind+' '+mode+'\n'+result.stdout+'\n'+result.stderr);
  const record=JSON.parse(result.stdout.trim());reports.push({kind,mode,exitCode:result.status,runtimeSha256:hash(runtime),record});console.log(JSON.stringify({kind,mode,...record}));
 }
 assert.equal(hash(runtime),hash(input));
}
fs.writeFileSync(path.join(work,'owned-deferred-bootstrap-'+arch+'-'+runtimeKind+'-'+requested+'-report.json'),JSON.stringify({kind:'owned-deferred-bootstrap-native-assessment',architecture:arch,cases:reports,productionSourceMutated:false,productionPackage:false},null,2)+'\n');
