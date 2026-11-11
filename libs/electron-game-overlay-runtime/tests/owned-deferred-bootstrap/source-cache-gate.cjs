'use strict';
// Source text and isolated synthetic Git/CMake-P only; no runtime or graphics execute.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),runtime=path.join(root,'libs/electron-game-overlay-runtime'),cache=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src');
const base=path.join(root,'build/overlay-compatibility/deferred-d3d11-source-cache-fixture'),source=path.join(base,'source'),binary=path.join(base,'binary');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex').toUpperCase(),read=p=>fs.readFileSync(p,'utf8').replaceAll('\r\n','\n');
const cmake=read(path.join(runtime,'CMakeLists.txt')),tail=read(path.join(runtime,'cmake/owned-deferred-d3d11.cmake'));
const descriptors=[...tail.matchAll(/"([^"|]+)\|([A-Z0-9]+)\|([A-F0-9]{64})"/g)].map(([,name,before,after])=>({name,before,after}));assert.equal(descriptors.length,4);
const producer=read(path.join(runtime,'scripts/build-reshade-runtime.ps1')),table=producer.match(/\$ExpectedPatchedContentSha256 = \[ordered\]@\{([\s\S]*?)\n\}/)[1];
const pins=[...table.matchAll(/"([^"]+)" = "([0-9A-F]{64})"/g)].map(([,name,digest])=>({name,digest}));assert.equal(pins.length,26);
const {transition,frozenInputs}=require('../frozen-source-inputs.cjs');
const destinations=transition(runtime,'present-destinations');for(const p of pins){const d=destinations.files.get(p.name);if(d)p.digest=d.before;}
const post=frozenInputs({pins,cache,scratch:path.join(base,'gen36-inputs'),transitions:[]});
function run(exe,args,cwd,ok=true){const r=cp.spawnSync(exe,args,{cwd,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});assert.ifError(r.error);if(ok)assert.equal(r.status,0,r.stdout+'\n'+r.stderr);else assert.notEqual(r.status,0);return r;}
const git=(args,cwd=source)=>run('git',['-c','core.autocrlf=false','-c','core.eol=lf',...args],cwd);
const owner=path.join(base,'.fixture-owner.json');
if(fs.existsSync(base))assert.equal(JSON.parse(read(owner)).kind,'ego-deferred-d3d11-source-cache-fixture');
else{fs.mkdirSync(source,{recursive:true});fs.mkdirSync(binary);fs.writeFileSync(owner,JSON.stringify({kind:'ego-deferred-d3d11-source-cache-fixture'}));
 git(['init','--quiet']);git(['config','core.autocrlf','false']);
 for(const {name} of pins){const r=cp.spawnSync('git',['-c','safe.directory='+cache,'-C',cache,'show','HEAD:'+name],{windowsHide:true,maxBuffer:4*1024*1024});if(r.status!==0)continue;const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,r.stdout);}
 git(['add','--all']);git(['-c','user.name=Owned source fixture','-c','user.email=fixture@invalid','commit','--quiet','-m','test: frozen pristine source text fixture']);
}
const fixtureCommit=git(['rev-parse','HEAD']).stdout.trim();
const helpers=cmake.match(/# BEGIN EGO_SOURCE_CACHE_MIGRATION_HELPERS\n([\s\S]*?)# END EGO_SOURCE_CACHE_MIGRATION_HELPERS/)[1];
const extract=name=>cmake.match(new RegExp('^function\\('+name+'[^\\n]*\\)\\n[\\s\\S]*?^endfunction\\(\\)','m'))[0];
const gitExe=run('where.exe',['git'],root).stdout.trim().split(/\r?\n/)[0],q=s=>'[==['+s.replaceAll('\\','/')+']==]';
function apply(direction,expect=true,sourceRoot=runtime){const script=path.join(base,'guard.cmake');fs.writeFileSync(script,[
 'cmake_minimum_required(VERSION 3.24)',`set(CMAKE_CURRENT_SOURCE_DIR ${q(sourceRoot)})`,`set(CMAKE_CURRENT_BINARY_DIR ${q(binary)})`,`set(GIT_EXECUTABLE ${q(gitExe)})`,`set(RESHAPE_PINNED_COMMIT "${fixtureCommit}")`,
 extract('verify_reshade_pinned_commit'),extract('verify_reshade_patched_source'),helpers,tail,`ego_owned_deferred_d3d11_tail(${q(source)} ${direction})`,
].join('\n'));return run('cmake.exe',['-P',script],base,expect);}
function writeState(state){for(const {name} of pins){const file=path.join(source,name);if(state.has(name)){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,state.get(name));}else if(fs.existsSync(file))fs.unlinkSync(file);}}
function state(){return new Map(pins.filter(({name})=>fs.existsSync(path.join(source,name))).map(({name})=>[name,fs.readFileSync(path.join(source,name))]));}
function equal(a,b){assert.deepEqual([...a].map(([p,b])=>[p,sha(b)]).sort(),[...b].map(([p,b])=>[p,sha(b)]).sort());}
let cases=0;writeState(post);apply('REVERSE');const before=state();
for(const d of descriptors)assert.equal(before.has(d.name)?sha(before.get(d.name)):'ABSENT',d.before,d.name);
apply('FORWARD');equal(state(),post);++cases;
for(let published=0;published<descriptors.length;published++){
 const mixed=new Map(before);for(const d of descriptors.slice(0,published))mixed.set(d.name,post.get(d.name));writeState(mixed);
 apply('FORWARD');equal(state(),post);apply('FORWARD');equal(state(),post);apply('REVERSE');equal(state(),before);++cases;
}
writeState(post);fs.appendFileSync(path.join(source,descriptors[0].name),'\n// unknown owned probe\n');let frozen=state();apply('FORWARD',false);equal(state(),frozen);++cases;
writeState(post);const extra=path.join(source,'unknown-owned-probe.txt');fs.writeFileSync(extra,'preserve');frozen=state();apply('REVERSE',false);equal(state(),frozen);assert.equal(read(extra),'preserve');fs.unlinkSync(extra);++cases;
const shadow=path.join(base,'altered-runtime');fs.mkdirSync(path.join(shadow,'patches'),{recursive:true});fs.writeFileSync(path.join(shadow,'patches/reshade-owned-deferred-d3d11.patch'),read(path.join(runtime,'patches/reshade-owned-deferred-d3d11.patch'))+'\n# changed owned patch probe\n');frozen=state();apply('FORWARD',false,shadow);equal(state(),frozen);++cases;
writeState(post);
const report={kind:'ego-owned-deferred-d3d11-source-cache-native-text-gate',status:'passed',cases,sourceFiles:26,syntheticGitFixture:true,sourceSha256:sha(tail).toLowerCase(),scope:'Actual production CMake helpers over exact26-file text vector in one reusable isolated synthetic Git repository. Checks reverse/replay, all four partial publication boundaries, idempotence, unknown edits, extra files and altered patch rejection without mutation. No compiler, runtime, graphics, injection or game acceptance.'};
const output=path.join(root,'build/overlay-compatibility/deferred-d3d11-source-cache-report.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,output}));
