'use strict';
// Reconstruct historical text inputs only in caller-owned scratch. Never reverse
// a live source cache or write the SDK repository's Git index/object store.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const read=p=>fs.readFileSync(p,'utf8').replaceAll('\r\n','\n'),sha=b=>crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
function transition(runtime,name){const tail=read(path.join(runtime,'cmake',name+'.cmake'));return {patch:path.join(runtime,'patches','reshade-'+name+'.patch'),files:new Map([...tail.matchAll(/"([^"|]+)\|([A-Z0-9]+)\|([A-F0-9]{64})"/g)].map(([,file,before,after])=>[file,{before,after}]))};}
function frozenInputs({pins,cache,scratch,transitions}){
 fs.mkdirSync(scratch,{recursive:true});
 return new Map(pins.map(({name,digest})=>{
  let bytes=Buffer.from(read(path.join(cache,name)));
  for(const successor of transitions){if(sha(bytes)===digest)break;const change=successor.files.get(name);if(!change||sha(bytes)!==change.after)continue;assert.notEqual(change.before,'ABSENT');
   const file=path.join(scratch,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
   const env={...process.env,GIT_CEILING_DIRECTORIES:path.dirname(scratch)};delete env.GIT_DIR;delete env.GIT_WORK_TREE;delete env.GIT_INDEX_FILE;
   const result=cp.spawnSync('git',['-c','core.autocrlf=false','apply','--reverse','--include='+name,successor.patch],{cwd:scratch,env,encoding:'utf8',windowsHide:true});assert.ifError(result.error);assert.equal(result.status,0,result.stderr);bytes=fs.readFileSync(file);assert.equal(sha(bytes),change.before,name);
  }
  assert.equal(sha(bytes),digest,name);return [name,bytes];
 }));
}
module.exports={transition,frozenInputs};
