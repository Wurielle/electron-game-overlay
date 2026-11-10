'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process'),path=require('node:path');
const query=require('../dist/lib/overlay-native-process-query.js').overlayProcessIncarnationExited;
const identity={pid:4242,creationTime100ns:'134388042909573233'},manager=path.resolve(__dirname,'unused-manager.exe');
const error31={schemaVersion:1,kind:'electron-game-overlay-reshade-addon-manager-result',operation:'query-process-image',status:'error',code:'process-query-failed',message:'Unable to query the process executable path.',windowsError:31};
const record={schemaVersion:1,kind:'electron-game-overlay-process-incarnation',pid:identity.pid,requestedCreationTime100ns:identity.creationTime100ns,creationTime100ns:identity.creationTime100ns,state:'exited'};
test('error 31 recovery requires a separate exact native incarnation proof',async t=>{
 const original=cp.execFile;t.after(()=>{cp.execFile=original;});
 const cases=[
  ['signaled exact child',record,true],['same live child',{...record,state:'alive'},false],
  ['absent',{...record,state:'absent',creationTime100ns:'0'},true],['reused',{...record,state:'reused',creationTime100ns:'134388042909573234'},true],
  ['contradictory reused',{...record,state:'reused'},false],['wrong exited birth',{...record,creationTime100ns:'134388042909573234'},false],
  ['contradictory absent',{...record,state:'absent'},false],['wrong PID',{...record,pid:4243},false],
  ['wrong requested birth',{...record,requestedCreationTime100ns:'134388042909573234'},false],['extra field',{...record,extra:1},false],
  ['unsupported version',{...record,schemaVersion:2},false],['noncanonical actual birth',{...record,state:'reused',creationTime100ns:'01'},false],
  ['missing state',Object.fromEntries(Object.entries(record).filter(([k])=>k!=='state')),false],['unknown state',{...record,state:'unknown'},false],
 ];
 for(const [label,answer,expected]of cases){let calls=0;cp.execFile=(exe,args,options,done)=>{assert.equal(exe,manager);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.timeout,2000);assert.equal(options.maxBuffer,16384);++calls;
   if(calls===1){assert.deepEqual(args,['--query-process-image','4242']);queueMicrotask(()=>done({code:5},JSON.stringify(error31),''));}
   else{assert.deepEqual(args,['--query-process-incarnation','4242',identity.creationTime100ns]);queueMicrotask(()=>done(null,JSON.stringify(answer),''));}
  };assert.equal(await query(identity,manager),expected,label);assert.equal(calls,2,label);}
 for(const [label,error,stdout,stderr]of [['unsupported old manager',{code:2},'{}',''],['denied',{code:5},JSON.stringify(record),''],['stderr',null,JSON.stringify(record),'denied'],['two records',null,JSON.stringify(record)+'\n'+JSON.stringify(record),''],['malformed',null,'{','']]){
  let calls=0;cp.execFile=(exe,args,options,done)=>queueMicrotask(()=>++calls===1?done({code:5},JSON.stringify(error31),''):done(error,stdout,stderr));
  assert.equal(await query(identity,manager),false,label);assert.equal(calls,2);
 }
 for(const altered of [{...error31,windowsError:5},{...error31,message:'other'},{...error31,extra:true},{...error31,operation:'other'}]){
  let calls=0;cp.execFile=(exe,args,options,done)=>{++calls;queueMicrotask(()=>done({code:5},JSON.stringify(altered),''));};
  assert.equal(await query(identity,manager),false);assert.equal(calls,1,'unrecognized failure must not launch new query');
 }
});
