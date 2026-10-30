const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = path.resolve(__dirname, '../scripts/run-popup-video-regression.cjs');

test('demo fixture popup entropy is unique and local even when outer randomness collides', () => {
  const compileDemoFactory = require('./helpers/compile-demo-factory.cjs');
  const vm = require('node:vm');
  const ts = require('typescript');
  const filename = path.resolve(__dirname,'../src/main/utils/utils.ts');
  const source = ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const outerMath = Object.create(Math); outerMath.random = () => 0;
  const module = {exports:{}};
  vm.runInNewContext(compileDemoFactory(source,filename), {module,exports:module.exports,require,Math:outerMath});
  const names = Array.from({length:20}, () => module.exports.getRandomInt(1,10000));
  assert.equal(new Set(names).size,20,'fixture popup suffixes must not collide');
  assert.deepEqual(names,Array.from({length:20},(_,i)=>i+1));
  assert.equal(outerMath.random(),0,'fixture must not mutate global Math');
  assert.equal(compileDemoFactory(source,'overlay-session.js'),source,'SDK entropy must remain untouched');
});

test('fixture endpoints use an abstract Linux socket and the canonical Windows pipe namespace', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'popup-video-real-graph.acceptance.cjs'), 'utf8');
  const match = source.match(/^\s*const pipePath = (.+);$/m);
  assert.ok(match, 'actual fixture endpoint expression is present');
  const endpoint = new Function('process', 'randomUUID', `return (${match[1]});`);
  const slash = String.fromCharCode(92);
  assert.equal(endpoint({platform:'linux'}, () => 'controlled'), String.fromCharCode(0) + 'ego-popup-controlled');
  assert.equal(endpoint({platform:'win32'}, () => 'controlled'), slash.repeat(2) + '.' + slash + 'pipe' + slash + 'ego-popup-controlled');
});

test('real private children fail closed on arbitrary exit, missing trace, stale success and timeout; scratch is removed', async () => {
  const { runMatrix } = require(runner);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-child-test-'));
  try {
    const lib = path.join(root,'controlled-lib'); fs.mkdirSync(lib);
    for (const name of ['electron-game-overlay','overlay-broker-server','overlay-broker-client','overlay-session','electron-overlay-window']) fs.writeFileSync(path.join(lib,`${name}.js`),'// controlled orchestration input, not SDK evidence');
    for (const [name,source] of [
      ['arbitrary', 'process.exit(2)'],
      ['missing', 'process.exit(0)'],
      ['stale', 'require("node:fs").writeFileSync(process.env.EGO_POPUP_TRACE, JSON.stringify({status:"passed"}));'],
      ['timeout', 'setInterval(()=>{},1000)'],
    ]) {
      const fixture = path.join(root,`${name}.cjs`); fs.writeFileSync(fixture,source);
      const output = path.join(root,`${name}.json`);
      const report = await runMatrix({currentLib:lib,previousLib:lib,output,fixture,timeoutMs:150});
      assert.equal(report.status,'failed',name);
      assert.equal(report.cases.length,8,name);
      assert.ok(report.cases.every(c=>c.status==='failed'),name);
      assert.ok(report.scratch && !fs.existsSync(report.scratch),'owned scratch removed');
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

for (const failure of ['cleanup', 'final-save']) test(`runner-owned ${failure} failure after a controlled green matrix fails report and CLI`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-runner-failure-'));
  try {
    // Controlled orchestration only: these inputs and traces do not execute an SDK or native code.
    const libs = ['current', 'previous'].map(role => {
      const lib = path.join(root, role); fs.mkdirSync(lib);
      for (const name of ['electron-game-overlay','overlay-broker-server','overlay-broker-client','overlay-session','electron-overlay-window']) fs.writeFileSync(path.join(lib, `${name}.js`), '// controlled orchestration input, not SDK evidence');
      return lib;
    });
    const fixture = path.join(root, 'controlled-trace.cjs');
    fs.writeFileSync(fixture, `
      const previous = require('node:path').basename(process.env.EGO_POPUP_SERVER_LIB) === 'previous';
      const names = ['fresh-popup','first-video','reuse-visible-video','hide-video','show-hidden-video','repeated-popup-0','focus-0','repeated-popup-1','focus-1'];
      const message = 'unrelated windows must not be re-registered with retained Electron geometry';
      const trace = {nativeExecuted:false,stage:'assertions',status:previous?'failed':'passed',
        failure:previous?{code:'ERR_ASSERTION',message}:undefined,
        phases:names.map((name,i)=>({name,produced:[],unrelated:Array.from({length:previous?[6,7,0,0,7,8,0,9,0][i]:0},()=>({kind:'add',details:{name:'controlled-peer'}}))}))};
      require('node:fs').writeFileSync(process.env.EGO_POPUP_TRACE, JSON.stringify(trace));
      if(previous) {console.error(message);process.exitCode=1;}
    `);
    const output = path.join(root, 'report.json');
    const preload = path.join(root, 'controlled-boundaries.cjs');
    fs.writeFileSync(preload, `
      const fs = require('node:fs'), cp = require('node:child_process');
      const spawn = cp.spawn, rm = fs.rmSync, write = fs.writeFileSync;
      cp.spawn = (exe,args,options) => spawn(exe,[${JSON.stringify(fixture)},...args.slice(1)],options);
      let injected = false;
      const inject = () => {injected=true;throw Error('controlled runner-owned ${failure} failure');};
      fs.rmSync = (target,options) => {
        if (${JSON.stringify(failure)} === 'cleanup' && !injected && String(target).includes('ego-popup-matrix-')) {
          const report = JSON.parse(fs.readFileSync(${JSON.stringify(output)}));
          if(report.cases.length !== 8 || report.cases.some(c=>c.status==='failed')) throw Error('controlled matrix setup incomplete');
          inject();
        }
        return rm(target,options);
      };
      fs.writeFileSync = (target,data,...rest) => {
        if (${JSON.stringify(failure)} === 'final-save' && !injected && target === ${JSON.stringify(output)} && JSON.parse(data).status === 'passed') inject();
        return write(target,data,...rest);
      };
    `);
    const env = {...process.env, TMPDIR:root, TMP:root, TEMP:root}; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--require', preload, runner, '--output', output, '--current-lib', libs[0], '--previous-lib', libs[1]], {env, encoding:'utf8', timeout:10000});
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const report = JSON.parse(fs.readFileSync(output));
    assert.deepEqual(report.summary, {currentPass:4,legacyKnownFailingCharacterizations:4,reconnectSeparate:0});
    assert.equal(report.nativeExecuted, false);
    assert.equal(report.error, `controlled runner-owned ${failure} failure`);
    assert.equal(report.status, 'failed', 'runner-owned failure must revoke the otherwise green verdict');
    assert.equal(result.status, 1, 'CLI must not report success');
  } finally { fs.rmSync(root, {recursive:true,force:true}); }
});

test('legacy RED requires exact assertion, complete counts and producer absence', () => {
  const { classify } = require(runner);
  const names = ['fresh-popup','first-video','reuse-visible-video','hide-video','show-hidden-video','repeated-popup-0','focus-0','repeated-popup-1','focus-1'];
  const message = 'unrelated windows must not be re-registered with retained Electron geometry';
  const trace = { nativeExecuted: false, stage: 'assertions', status: 'failed', failure: {code:'ERR_ASSERTION', message}, phases: names.map((name,i) => ({name, produced:[], unrelated:Array.from({length:[6,7,0,0,7,8,0,9,0][i]}, () => ({kind:'add', details:{name:'controlled-stale-peer'}}))})) };
  assert.equal(classify('previous', {code:1, log:message}, trace), 'legacy-known-failing-characterization');
  for (const [result, modified] of [
    [{code:2,log:message}, trace], [{code:1,log:'setup failure'}, trace], [{code:1,log:message}, undefined],
    [{code:0,log:message}, trace], [{code:1,log:message}, {...trace,stage:'setup'}],
    [{code:1,log:message}, {...trace,cleanupErrors:['controlled cleanup failure']}],
    [{code:1,log:message}, {...trace, phases:trace.phases.slice(1)}],
    [{code:1,log:message}, {...trace, phases:trace.phases.map(p=>({...p,produced:[{details:{name:'controlled-stale-peer'}}]}))}],
  ]) assert.throws(() => classify('previous', result, modified));
});

test('actual fixture persists setup failure even when the selected server cannot load', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'popup-setup-test-'));
  try {
    const trace = path.join(root,'trace.json'); fs.writeFileSync(trace,'{"status":"passed"}');
    const env = {...process.env,EGO_POPUP_TRACE:trace,EGO_POPUP_SERVER_LIB:path.join(root,'missing-lib')}; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath,[path.resolve(__dirname,'popup-video-real-graph.acceptance.cjs')],{env,encoding:'utf8',timeout:5000});
    assert.equal(result.status,1);
    const report = JSON.parse(fs.readFileSync(trace));
    assert.equal(report.status,'failed'); assert.equal(report.stage,'setup');
    assert.equal(report.failure.code,'MODULE_NOT_FOUND'); assert.deepEqual(report.cleanupErrors,[]);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('optional controlled-native CLI mode is explicit and isolated from all eight original cases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-order-cli-'));
  try {
    // Controlled orchestration input only; no fabricated SDK/native acceptance.
    const lib = path.join(root, 'lib'); fs.mkdirSync(lib);
    for (const name of ['electron-game-overlay','overlay-broker-server','overlay-broker-client','overlay-session','electron-overlay-window']) fs.writeFileSync(path.join(lib, `${name}.js`), '// orchestration only');
    const audit = path.join(root, 'audit.jsonl'), preload = path.join(root, 'preload.cjs'), fixture = path.join(root, 'fixture.cjs');
    fs.writeFileSync(fixture, `require('node:fs').appendFileSync(${JSON.stringify(audit)}, JSON.stringify({order:process.env.EGO_POPUP_CONTROLLED_WINDOW_ORDER,reconnect:process.env.EGO_POPUP_RECONNECT,expect:process.env.EGO_POPUP_EXPECT_ORDER,legacy:process.env.EGO_POPUP_LEGACY_COORDINATOR})+'\\n');process.exitCode=2;`);
    fs.writeFileSync(preload, `const cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=(exe,args,options)=>spawn(exe,[${JSON.stringify(fixture)}],options);`);
    const env = {...process.env,TMPDIR:root,TMP:root,TEMP:root}; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--require',preload,runner,'--current-lib',lib,'--previous-lib',lib,'--output',path.join(root,'report.json'),'--controlled-native-window-order'], {env,encoding:'utf8',timeout:10000});
    assert.equal(result.status,1, 'arbitrary child exit must remain failure');
    const rows = fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length,16);
    assert.ok(rows.slice(0,8).every(r=>r.order==='0' && r.reconnect==='0' && r.expect==='0'));
    assert.ok(rows.slice(8,12).every(r=>r.order==='1' && r.reconnect==='1' && r.expect==='1' && r.legacy==='0'));
    assert.ok(rows.slice(12).every(r=>r.order==='1' && r.reconnect==='1' && r.expect==='0' && r.legacy==='1'));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('invalid setup replaces stale success before validation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-gate-test-'));
  try {
    const output = path.join(root, 'report.json');
    fs.writeFileSync(output, '{"status":"passed"}');
    const result = spawnSync(process.execPath, [runner, '--output', output], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(output)).status, 'failed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
