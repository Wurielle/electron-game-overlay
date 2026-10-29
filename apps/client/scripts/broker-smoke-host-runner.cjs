'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const MATRIX = ['x64:d3d9','x64:d3d10','x64:d3d11','x64:d3d12','x86:d3d9','x86:d3d10'];
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
function validate(options) {
  if (!['singleApp','twoAppSameTarget'].includes(options.mode) || !MATRIX.includes(`${options.architecture}:${options.backend}`)) throw Error('invalid-options');
  const manifest = JSON.parse(fs.readFileSync(options.hostManifest,'utf8').replace(/^\uFEFF/,''));
  if (manifest.schemaVersion !== 1 || !/^[a-fA-F0-9]{40}$/.test(manifest.sourceRevision) || !Array.isArray(manifest.hosts) || manifest.hosts.length !== 6) throw Error('invalid-prebuilt');
  const manifestRoot=fs.realpathSync(path.dirname(path.resolve(options.hostManifest)));
  const seen = new Set();
  for (const host of manifest.hosts) {
    const cell = `${host.architecture}:${host.backend}`;
    if (!MATRIX.includes(cell) || seen.has(cell) || !/^[a-f0-9]{64}$/.test(host.sha256) || typeof host.path !== 'string' || path.isAbsolute(host.path) || host.path.split(/[\\/]/).includes('..') || !Number.isSafeInteger(host.size) || host.size<=0 || host.peMachine !== (host.architecture === 'x64'?0x8664:0x14c)) throw Error('invalid-prebuilt');
    const resolved=fs.realpathSync(path.resolve(manifestRoot,host.path));
    const relative=path.relative(manifestRoot,resolved);
    if(relative.startsWith('..') || path.isAbsolute(relative))throw Error('invalid-prebuilt');
    host.path=resolved;host.sourceRevision=manifest.sourceRevision;
    seen.add(cell);
    const image = fs.readFileSync(host.path);
    if(image.length !== host.size)throw Error('invalid-prebuilt');
    const offset = image.length >= 64 ? image.readUInt32LE(60) : -1;
    if (image.toString('ascii',0,2) !== 'MZ' || offset < 64 || offset + 6 > image.length || image.toString('ascii',offset,offset+4) !== 'PE\0\0' || image.readUInt16LE(offset+4) !== (host.architecture === 'x64' ? 0x8664:0x14c) || hash(image) !== host.sha256) throw Error('invalid-prebuilt');
  }
  const apps = [options.appA,...(options.mode === 'twoAppSameTarget' ? [options.appB]:[])].map((exe) => {
    if (typeof exe !== 'string' || !path.isAbsolute(exe) || !fs.statSync(exe).isFile()) throw Error('invalid-app');
    exe=fs.realpathSync(exe);
    const dir=fs.realpathSync(path.dirname(exe)), sdk=path.join(dir,'resources/app/node_modules/electron-game-overlay');
    const revision=JSON.parse(fs.readFileSync(path.join(dir,'SDK-REVISION.json'),'utf8').replace(/^\uFEFF/,''));
    if (!/^[a-f0-9]{40}$/.test(revision.sdkSourceRevision) || !/^[a-f0-9]{64}$/.test(revision.sdkImplementationSha256) || !['current','previous'].includes(revision.role) || typeof revision.packageVersion !== 'string' || !revision.packageVersion || (revision.role === 'previous' && !/^[0-9]+$/.test(revision.sdkArtifactId))) throw Error('invalid-app');
    if (JSON.parse(fs.readFileSync(path.join(sdk,'package.json'))).version !== revision.packageVersion || hash(fs.readFileSync(path.join(sdk,'dist/lib/overlay-broker-native-provider.js'))) !== revision.sdkImplementationSha256 || !fs.statSync(path.join(dir,'resources/node/node.exe')).isFile()) throw Error('invalid-app');
    return {exe,root:dir,revision};
  });
  const roots=apps.map(app=>process.platform==='win32'?app.root.toLowerCase():app.root);
  if(new Set(roots).size!==apps.length)throw Error('invalid-app');
  return {apps,host:manifest.hosts.find((h)=>h.architecture === options.architecture && h.backend === options.backend)};
}
// Reject links in every existing ancestor before creating any destination.
function safeOutput(root, create=false) {
  const absolute=path.resolve(root), parsed=path.parse(absolute);
  let current=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    let stat;
    try{stat=fs.lstatSync(current);}catch(error){
      if(error.code!=='ENOENT' || !create)throw Error('unsafe-output');
      fs.mkdirSync(current);stat=fs.lstatSync(current);
    }
    if(stat.isSymbolicLink() || !stat.isDirectory())throw Error('unsafe-output');
  }
  if(fs.realpathSync(absolute)!==absolute)throw Error('unsafe-output');
  const destination=path.join(absolute,'report.json');
  try{const stat=fs.lstatSync(destination);if(stat.isSymbolicLink() || !stat.isFile())throw Error('unsafe-output');}
  catch(error){if(error.code!=='ENOENT')throw Error('unsafe-output');}
  return absolute;
}
// The injected boundary is for controlled non-native child tests only; it is not a CLI option.
async function run(options, boundary) {
  options={...options,mode:options.mode || (options.appB?'twoAppSameTarget':'singleApp')};
  const outputRoot=safeOutput(options.outputRoot,true);
  const reportPath=path.join(outputRoot,'report.json');
  const report={schema:1,status:'failed',reason:'setup',platform:process.platform,nativeExecuted:false,manualObservationPending:false,stages:[],events:[],cleanupErrors:[]};
  const save=()=>{
    safeOutput(outputRoot);
    const temporary=path.join(outputRoot,`.report-${crypto.randomBytes(16).toString('hex')}.tmp`);
    let fd;
    try{
      fd=fs.openSync(temporary,'wx',0o600);
      fs.writeFileSync(fd,JSON.stringify(report,null,2)+'\n');fs.closeSync(fd);fd=undefined;
      safeOutput(outputRoot);
      fs.renameSync(temporary,reportPath);
    }finally{
      if(fd!==undefined)fs.closeSync(fd);
      // Never traverse a changed output ancestor during temporary cleanup.
      safeOutput(outputRoot);fs.rmSync(temporary,{force:true});
    }
  };
  save();
  let inputs;
  try { inputs=validate(options); } catch(error) { report.reason=['invalid-options','invalid-app'].includes(error.message)?error.message:'invalid-prebuilt'; save(); return report; }
  const controlled = boundary?.controlledNonNative === true && typeof boundary.spawn === 'function';
  if (!controlled && process.platform !== 'win32') {
    report.reason='unsupported-native-platform'; save(); return report;
  }
  const launch=controlled ? boundary.spawn : spawn;
  const owned=[];
  let active=true;
  let startupDeadline=Infinity;
  const alive=(c)=>c.exitCode === null && c.signalCode === null;
  const delay=()=>new Promise(resolve=>setTimeout(resolve,5));
  const bounded=(value,fallback)=>Number.isInteger(value) && value>0 && value<=120000 ? value:fallback;
  const check=()=>{
    if(options.signal?.aborted) throw Error('cancelled');
    if(Date.now()>=startupDeadline)throw Error('deadline');
    if(owned.some(o=>o.error || !alive(o.child))) throw Error('child-failed');
  };
  const wait=async(predicate,ms)=>{
    const deadline=Date.now()+ms;
    while(!predicate()) { check();if(Date.now()>=Math.min(deadline,startupDeadline))throw Error('deadline');await delay(); }
    check();
  };
  const start=(exe,args,role)=>{
    check();
    const child=launch(exe,args,{cwd:path.dirname(exe),shell:false,windowsHide:false,stdio:['ignore','pipe','pipe']});
    const item={child,role,spawned:false,session:false,returned:false,connected:false,error:false};owned.push(item);
    child.once('error',()=>{item.error=true;});
    child.once('spawn',()=>{
      if(!active)return;
      item.spawned=true;
      report.ownedChildren.push({role,pid:child.pid,executablePath:exe});
    });
    let pending='';
    child.stdout?.on('data',(chunk)=>{
      if(!active)return;
      pending=(pending+chunk.toString()).slice(-16384);
      let newline;
      while((newline=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,newline).replace(/\r$/,'');pending=pending.slice(newline+1);
        const marker=/^(RESHADE_CLIENT_OVERLAY_SESSION_READY|RESHADE_CLIENT_INJECTOR_RETURNED)(?: |$)/.exec(line)?.[1];
        if(marker){if(marker.endsWith('_SESSION_READY'))item.session=true;else item.returned=true;}
        const connected=/^RESHADE_CLIENT_TARGET_CONNECTED pid=([0-9]+)$/.exec(line);
        if(connected && Number(connected[1])===report.host?.pid)item.connected=true;
        if((marker || (connected && item.connected)) && report.events.length<64)report.events.push({role,marker:marker || 'RESHADE_CLIENT_TARGET_CONNECTED'});
      }
    });
    child.stderr?.resume();
    return item;
  };
  report.ownedChildren=[];
  report.architecture=options.architecture;report.backend=options.backend;report.mode=options.mode;
  report.apps=inputs.apps.map(({revision:r})=>({sdkSourceRevision:r.sdkSourceRevision,sdkImplementationSha256:r.sdkImplementationSha256,packageVersion:r.packageVersion,role:r.role,...(r.sdkArtifactId?{sdkArtifactId:r.sdkArtifactId}:{})}));
  report.controlledNonNative=controlled;
  report.fixtureLimitation='Requires prepared warm app fixtures: entire pre-graphics startup is bounded to 55s; production bootstrap defaults unchanged.';
  try {
    check();
    report.privateRoot=fs.mkdtempSync(path.join(outputRoot,'owned-'));
    const target=path.join(report.privateRoot,'host');fs.mkdirSync(target);
    const hostPath=path.join(target,`ego-owned-${crypto.randomBytes(16).toString('hex')}.exe`);
    fs.copyFileSync(inputs.host.path,hostPath,fs.constants.COPYFILE_EXCL);
    if(hash(fs.readFileSync(hostPath))!==inputs.host.sha256)throw Error('invalid-prebuilt');
    for(const marker of ['reshade-input-gate.enabled','electron-game-overlay-startup-barrier.enabled'])fs.writeFileSync(path.join(target,marker),'',{flag:'wx'});
    report.host={sha256:inputs.host.sha256,sourceRevision:inputs.host.sourceRevision,executablePath:hostPath};
    report.stages.push('staged');
    // Start the verified unique private image before authorizing either app.
    startupDeadline=Date.now()+Math.min(bounded(options.prepareMs,55000),55000);
    const host=start(hostPath,[],'host');
    await wait(()=>host.spawned,55000);
    if(!Number.isSafeInteger(host.child.pid) || host.child.pid<=0)throw Error('child-failed');
    report.host.pid=host.child.pid;
    report.nativeExecuted=!controlled;
    report.stages.push('owned-host-spawned');
    const apps=[];
    for(const [index,app] of inputs.apps.entries()){
      const profile=path.join(report.privateRoot,`profile-${index}`);fs.mkdirSync(profile);
      apps.push(start(app.exe,['--reshade-overlay',`--reshade-auto-target-process=${path.basename(hostPath)}`,`--reshade-expected-target-pid=${host.child.pid}`,'--start-overlay-session',`--user-data-dir=${profile}`],index===0?'appA':'appB'));
    }
    // A joining provider can wait for graphics authentication. Do not require
    // both injector returns while graphics is held behind the file barrier.
    await wait(()=>apps.every(a=>a.spawned && a.session),55000);
    report.stages.push('sessions-ready');
    await wait(()=>apps.some(a=>a.returned),55000);
    check();
    if(Date.now()>=startupDeadline)throw Error('deadline');
    fs.unlinkSync(path.join(target,'electron-game-overlay-startup-barrier.enabled'));
    report.stages.push('startup-barrier-released');
    startupDeadline=Infinity;
    report.status='manual-observation-pending';report.manualObservationPending=true;report.reason='interactive-acceptance-required';
    report.stages.push('interactive-session');save();
    // Readiness logs are not GUI/injection acceptance. Retain the session until
    // this exact owned host closes or the operator cancels. App A may close for
    // the survivor-B test; its exit must not tear down the remaining session.
    while(alive(host.child) && !options.signal?.aborted){
      if(host.error)throw Error('child-failed');
      await delay();
    }
    report.runtimeConnectedApps=apps.filter(a=>a.connected).length;
    report.reason=options.signal?.aborted?'operator-cancelled':'owned-host-closed';
  }catch(error){report.status='failed';report.reason=['cancelled','child-failed','deadline','invalid-prebuilt'].includes(error.message)?error.message:'controller-failed';}
  finally{
    active=false;
    for(const {child} of [...owned].sort((a,b)=>(a.role==='host')-(b.role==='host'))){
      try{
        if(alive(child))child.kill('SIGTERM');
        let deadline=Date.now()+bounded(options.cleanupMs,2000);
        while(alive(child)&&Date.now()<deadline)await delay();
        if(alive(child)){child.kill('SIGKILL');deadline=Date.now()+bounded(options.cleanupMs,2000);while(alive(child)&&Date.now()<deadline)await delay();}
        if(alive(child))report.cleanupErrors.push('owned-child-exit-timeout');
      }catch{report.cleanupErrors.push('owned-child-cleanup-failed');}
    }
    if(report.privateRoot && !report.cleanupErrors.length){try{fs.rmSync(report.privateRoot,{recursive:true,force:true});}catch{report.cleanupErrors.push('private-root-cleanup-failed');}}
    if(report.cleanupErrors.length){report.status='failed';report.manualObservationPending=false;}
    report.stages.push('cleanup-complete');save();
  }
  return report;
}
module.exports={run};
// Invoke with the complete app's resources/node/node.exe; no PATH tools are used.
// --app-a EXE [--app-b EXE] --host-manifest JSON --architecture x64|x86
// --backend d3d9|d3d10|d3d11|d3d12 --output-root DIR.
// Optional --mode singleApp|twoAppSameTarget otherwise follows app-b presence.
// Manifest: schemaVersion:1, informational sourceRevision, exactly six hosts
// with manifest-relative path, architecture, backend, sha256, size, peMachine.
if(require.main === module){
  const argv=process.argv.slice(2),options={};
  const keys={'--app-a':'appA','--app-b':'appB','--host-manifest':'hostManifest','--architecture':'architecture','--backend':'backend','--mode':'mode','--output-root':'outputRoot'};
  // Discover the evidence destination before rejecting any other argument.
  const at=argv.indexOf('--output-root');
  if(at<0 || !argv[at+1] || argv[at+1].startsWith('--')){console.error('output-root-required');process.exitCode=1;}
  else{
    options.outputRoot=argv[at+1];let valid=true;
    for(let i=0;i<argv.length;i+=2){const key=keys[argv[i]];if(!key || !argv[i+1] || argv[i+1].startsWith('--') || (Object.hasOwn(options,key)&&key!=='outputRoot')){valid=false;break;}options[key]=argv[i+1];}
    if(!valid)options.mode='invalid';
    const abort=new AbortController();const cancel=()=>abort.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);options.signal=abort.signal;
    run(options).then(r=>{console.log(JSON.stringify({status:r.status,reason:r.reason,nativeExecuted:r.nativeExecuted}));process.exitCode=r.status==='failed'?1:0;},()=>{console.error('report-write-failed');process.exitCode=1;}).finally(()=>{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);});
  }
}
