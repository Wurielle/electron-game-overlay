'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),architecture=process.argv[2]??'x64';assert.ok(['x64','x86'].includes(architecture));
const source=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src/source/ego_owned_late_d3d11/owned_late_d3d11.inl');
const text=fs.readFileSync(source,'utf8').replaceAll('\r\n','\n'),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
assert.equal(sha(text),'e9d57c1e5501df5474ebf9af9a9f1059489bd60ab4c4633cf6c4586dbf498d67');
function extract(signature){const start=text.indexOf(signature);assert.ok(start>=0);let end=text.indexOf('{',start),depth=0;for(;end<text.length;end++){if(text[end]==='{')depth++;else if(text[end]==='}'&&--depth===0)break;}assert.equal(depth,0);return text.slice(start,end+1)+'\n';}
const body=['template <typename Native>\n    HRESULT present(', 'HRESULT STDMETHODCALLTYPE raw_present(', 'HRESULT STDMETHODCALLTYPE raw_present1('].map(extract).join('\n');
const base=path.join(root,'build/overlay-compatibility/present-forwarding'),build=path.join(base,architecture),header=path.join(base,'production-present.hpp');fs.mkdirSync(base,{recursive:true});fs.writeFileSync(header,body);
function run(exe,args){const r=cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r.stdout;}
run('cmake.exe',['-S',__dirname,'-B',build,'-A',architecture==='x64'?'x64':'Win32','-DGENERATED_PRESENT_SOURCE='+header]);run('cmake.exe',['--build',build,'--config','Release','--parallel','4']);
const report=JSON.parse(run(path.join(build,'Release/present_forwarding_contract.exe'),[]).trim());assert.equal(report.status,'passed');assert.equal(report.cases,19);
report.architecture=architecture;report.sourceSha256=sha(text);report.extractedFunctionsSha256=sha(body);report.scope='Exact production Present template and raw Present/Present1 shim bodies with controlled runtime/state and downstream callback seams. Proves forwarding, not actual Steam trampoline identity or rendered frames.';
fs.writeFileSync(path.join(base,architecture+'-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
