'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once, EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { spawn } = childProcess;
const originalExecFile = childProcess.execFile;
childProcess.execFile = (file, args, options, callback) => originalExecFile(file, args, options, (error, stdout, stderr) => {
  if (/inject(?:32)?\.exe$/i.test(file)) console.log('native result', error?.code, stdout, stderr);
  callback(error, stdout, stderr);
});
const { createInterface } = require('node:readline');
const test = require('node:test');
const sdk = '../../../electron-game-overlay/dist/lib/';
const { ReShadeOverlayLauncher, createReShadeLaunchConfig, clearOldReShadeRuntimeCache } = require(sdk+'reshade-launcher.js');
const { inspectOverlayConsumerExecutionContext, privateElevatedRunsRoot } = require(sdk+'overlay-consumer-context.js');
const { CooperativeOverlayTransport } = require(sdk+'cooperative-overlay-transport.js');
const { memoryTargetAuthorizers } = require(sdk+'overlay-session-authorization.js');
const { clearOlderSdkRuntimePayloads, sdkRuntimeCacheDirectory } = require(sdk+'runtime-payload-store.js');
const { registerOverlayAddonInstallation, unregisterOverlayAddonInstallation } = require(sdk+'overlay-addon-preload.js');

test('managed watcher uses one cache, paints an owned D3D11 window, and leases it through target exit', {timeout: 40000}, async () => {
  const fixtureRoot=await fs.realpath(process.env.EGO_CACHE_FIXTURE_ROOT);
  const bundledRuntimeDirectory=await fs.realpath(process.env.EGO_CACHE_FIXTURE_RUNTIME);
  const host=await fs.realpath(process.env.EGO_CACHE_FIXTURE_HOST);
  const logging=process.env.EGO_CACHE_FIXTURE_LOGGING === '1';
  const headless=process.env.EGO_CACHE_FIXTURE_HEADLESS === '1';
  const root=await fs.mkdtemp(path.join(fixtureRoot,'proof-'));
  const runs=path.join(root,'runs');
  const packageRoot=process.env.EGO_CACHE_FIXTURE_PRELOAD_PACKAGE;
  const addonPreload=packageRoot ? {applicationId:'com.nhs.izabela',addonDirectory:path.join(root,'registered-addons')} : undefined;
  const registration=addonPreload ? await registerOverlayAddonInstallation({...addonPreload,packageRoot}) : undefined;
  const offline=addonPreload ? await registerOverlayAddonInstallation({...addonPreload,applicationId:'com.nhs.izabela.offline-fixture',packageRoot}) : undefined;
  const retired=addonPreload ? await registerOverlayAddonInstallation({...addonPreload,applicationId:'com.nhs.izabela.retired-fixture',packageRoot}) : undefined;
  if (retired) await unregisterOverlayAddonInstallation({...addonPreload,applicationId:retired.applicationId,registrationId:retired.registrationId});
  const registrationPath=entry=>process.env.EGO_CACHE_FIXTURE_ARCH === 'Win32' ? entry.x86AddonPath : entry.addonPath;
  const transport=new CooperativeOverlayTransport({directory:path.join(root,'unused-discovery'),publishGlobalDiscovery:false});
  const config=createReShadeLaunchConfig({bundledRuntimeDirectory,runsRootDirectory:runs,logging,addonPreload});
  assert.equal(config.injectorCacheBootstrap,1);
  const context=await inspectOverlayConsumerExecutionContext({config});
  if (process.env.EGO_CACHE_FIXTURE_REQUIRE_ELEVATED === '1') assert.equal(context.elevated,true,'Requires an already high caller');
  if (context.elevated) assert.equal(config.elevatedCacheBootstrap,1);
  if (addonPreload) {
    assert.equal(config.cachePreloadBootstrap,1);
    assert.equal(context.elevated,false,'The registered preload fixture requires a medium caller');
  }
  const logsRoot=context.elevated ? privateElevatedRunsRoot(runs) : runs;
  const launcher=new ReShadeOverlayLauncher(config);
  const events=new EventEmitter();
  const session={
    whenReady:()=>transport.whenReady(),
    on:(name,handler)=>{events.on(name,handler);return()=>events.off(name,handler);},
    onClose:(handler)=>{events.on('close',handler);return()=>events.off('close',handler);},
  };
  memoryTargetAuthorizers.set(session,(identity)=>transport.authorizeMemoryTarget(identity));
  transport.setEventCallback((type,payload)=>{
    if(type==='game.process') events.emit('targetConnected',{pid:payload.pid,executablePath:payload.path});
    if(type==='game.process.disconnected') events.emit('targetDisconnected',{pid:payload.pid,executablePath:payload.path});
  });
  transport.start();
  transport.addWindow(1,{name:'Cache proof',transparent:false,rect:{x:10,y:10,width:110,height:110}});
  const red=Buffer.alloc(110*110*4);
  for(let at=0;at<red.length;at+=4) {red[at]=40;red[at+1]=40;red[at+2]=198;red[at+3]=255;}
  transport.sendFrameBuffer(1,red,110,110);
  const targetDirectory=path.join(root,'target');
  await fs.mkdir(targetDirectory);
  const target=path.join(targetDirectory,'cache-graphics-host.exe');
  await fs.copyFile(host,target);
  const armed=once(events,'armed',{signal:AbortSignal.timeout(10000)});
  armed.catch(()=>{});
  launcher.onEvent(event=>{
    if(event.type==='injector-watcher-ready') events.emit('armed',event);
  });
  const normalizedTargetDirectory=targetDirectory.replaceAll('\\','/');
  const selector=process.env.EGO_CACHE_FIXTURE_SELECTION === 'image'
    ? {processName:path.basename(target),executablePath:target}
    : {pathContains:normalizedTargetDirectory};
  const nonexistent=async p=>assert.rejects(fs.stat(p),{code:'ENOENT'});
  let child, exit;
  try {
    await launcher.prepare();
    await nonexistent(runs);
    if (context.elevated) await nonexistent(logsRoot);
    const pending=launcher.attach(session,{...selector,processPolicy:{allow:[normalizedTargetDirectory+'/**']}});
    pending.catch(()=>{});
    const [ready]=await Promise.race([armed,pending.then(()=>{throw new Error('attached before target creation');})]);
    if (registration) assert.ok(ready.invocation.arguments.includes(path.basename(registration.addonPath)));
    if (logging) assert.equal((await fs.readdir(logsRoot)).length,1);
    else await nonexistent(logsRoot);
    const store=sdkRuntimeCacheDirectory(logsRoot);
    assert.deepEqual(await clearOlderSdkRuntimePayloads(logsRoot,'99.0.0'),[]);
    const versionEntries=await fs.readdir(store);
    assert.equal(versionEntries.length,1);
    const cache=path.join(store,versionEntries[0]);
    const files=await fs.readdir(cache);
    assert.equal(files.length,14);
    child=spawn(target,headless ? ['--headless',...(offline&&retired&&registration ? [path.basename(registrationPath(offline)),path.basename(registrationPath(retired)),path.basename(registrationPath(registration))] : [])] : [],
      {windowsHide:headless,stdio:['ignore','pipe','pipe']});
    exit=once(child,'exit');
    const lines=createInterface({input:child.stdout});
    const observation=new Promise((resolve,reject)=>{
      const expected=headless ? (offline ? /^registered-and-offline-preloads$/ : /^ready$/) : /^pixel:/;
      lines.on('line',line=>{console.log('target',line);if(expected.test(line))resolve(line);});
      exit.then(([code])=>reject(new Error('target exited before the requested observation: '+code)));
    });
    observation.catch(()=>{});
    const result=await pending;
    assert.equal(result.pid,child.pid);
    assert.equal(result.runtimeCacheDirectory,cache);
    if (registration && result.addonModulePath) {
      assert.equal(path.basename(result.addonModulePath).toLowerCase(),path.basename(registrationPath(registration)).toLowerCase());
      assert.equal(await fs.realpath(result.addonModulePath),await fs.realpath(registrationPath(registration)));
    }
    if (logging) {
      assert.equal(path.dirname(result.runDirectory),logsRoot);
      assert.deepEqual((await fs.readdir(result.runDirectory)).sort(),
        ['ReShade.log','inject.stderr.log','inject.stdout.log']);
      assert.ok((await fs.stat(result.reshadeLogPath)).size>0);
    } else {
      assert.equal(result.runDirectory,undefined);
      assert.equal(launcher.runDirectory,null);
    }
    const observed=await Promise.race([observation,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('target observation timeout')),10000);timer.unref();})]);
    if (!logging) await nonexistent(logsRoot);
    if (context.elevated) await nonexistent(runs);
    await nonexistent(path.join(root,'unused-discovery'));
    assert.deepEqual(await fs.readdir(cache),files);
    await launcher.disposeAsync();
    transport.stop();
    assert.deepEqual(await clearOlderSdkRuntimePayloads(logsRoot,'99.0.0'),[]);
    child.kill();
    await exit;
    if (!context.elevated) assert.deepEqual(await clearOldReShadeRuntimeCache({runsRootDirectory:runs}),[]);
    const removed=await clearOlderSdkRuntimePayloads(logsRoot,'99.0.0');
    assert.equal(removed.length,1);
    assert.deepEqual(await fs.readdir(store),[]);
    console.log(JSON.stringify({observed,cacheVersion:removed[0],nativeWatcher:ready.invocation.executable,liveLeaseSurvivedProducerShutdown:true,logging,elevated:context.elevated,headless,applicationId:addonPreload?.applicationId}));
  } finally {
    await launcher.disposeAsync();
    transport.stop();
    if(child && child.exitCode===null && child.signalCode===null) child.kill();
    await exit;
    assert.equal(path.dirname(await fs.realpath(root)),fixtureRoot);
    await fs.rm(root,{recursive:true,force:true,maxRetries:3});
  }
});
