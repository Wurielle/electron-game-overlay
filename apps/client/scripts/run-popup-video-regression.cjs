const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const assertionMessage = 'unrelated windows must not be re-registered with retained Electron geometry';
const phaseNames = ['fresh-popup','first-video','reuse-visible-video','hide-video','show-hidden-video','repeated-popup-0','focus-0','repeated-popup-1','focus-1'];
function classify(coordinator, result, trace) {
  assert.ok(trace && trace.nativeExecuted === false && trace.stage === 'assertions', 'complete assertion trace required');
  assert.ok(!trace.cleanupErrors?.length, 'cleanup failure is not behavioral RED');
  assert.deepEqual(trace.phases.map(p => p.name), phaseNames);
  const counts = trace.phases.map(p => p.unrelated.length);
  if (coordinator === 'current') {
    assert.equal(result.code, 0); assert.equal(trace.status, 'passed');
    assert.deepEqual(counts, Array(9).fill(0));
    return 'current-pass';
  }
  assert.equal(result.code, 1);
  assert.equal(trace.status, 'failed');
  assert.equal(trace.failure?.code, 'ERR_ASSERTION');
  assert.equal(trace.failure?.message, assertionMessage);
  assert.ok(result.log.includes(assertionMessage));
  assert.deepEqual(counts, [6,7,0,0,7,8,0,9,0]);
  for (const phase of trace.phases) for (const call of phase.unrelated) {
    assert.equal(call.kind, 'add');
    assert.equal(typeof call.details.name, 'string');
    assert.ok(!phase.produced.some(producer => producer.details.name === call.details.name), 'stale peer replay absent from producer');
  }
  return 'legacy-known-failing-characterization';
}

async function runMatrix(options = {}) {
  const output = path.resolve(options.output || 'test-results/popup-video-matrix/report.json');
  const report = { status: 'failed', stage: 'setup', nativeExecuted: false, platform: process.platform, cases: [] };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
  save();
  try {
    if (!options.currentLib || !options.previousLib) throw Error('Explicit complete current and previous SDK lib inputs required');
    const { spawn } = require('node:child_process');
    const { createHash, randomUUID } = require('node:crypto');
    const libs = {current:path.resolve(options.currentLib), previous:path.resolve(options.previousLib)};
    report.inputs = {};
    for (const [role,lib] of Object.entries(libs)) {
      report.inputs[role] = {lib, hashes:{}};
      for (const name of ['electron-game-overlay','overlay-broker-server','overlay-broker-client','overlay-session','electron-overlay-window']) {
        const file = path.join(lib,`${name}.js`);
        report.inputs[role].hashes[name] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
    }
    report.servers = {};
    for (const role of ['current','previous']) {
      const lib = path.resolve((role === 'current' ? options.currentServerLib : options.previousServerLib) || libs[role]);
      report.servers[role] = {lib,sha256:createHash('sha256').update(fs.readFileSync(path.join(lib,'overlay-broker-server.js'))).digest('hex')};
    }
    report.stage = 'matrix';
    const evidence = path.join(path.dirname(output),`cases-${randomUUID()}`);
    fs.mkdirSync(evidence); report.evidence = evidence;
    const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(),'ego-popup-matrix-'));
    report.scratch = scratch;
    const fixture = options.fixture || path.resolve(__dirname,'../tests/popup-video-real-graph.acceptance.cjs');
    async function execute(coordinator, sdkA, sdkB, reconnect = false, controlledOrder = false) {
      const label = `${coordinator}-${sdkA}-${sdkB}${reconnect ? '-reconnect' : ''}${controlledOrder ? '-controlled-order' : ''}`;
      const tracePath = path.join(scratch,`${label}.json`);
      const item = {coordinator,sdkA,sdkB,status:'failed',label};
      (reconnect ? (report.reconnect ||= []) : report.cases).push(item); save();
      try {
        const env = {...process.env, EGO_POPUP_CLIENT_LIB:libs[sdkA], EGO_POPUP_PEER_CLIENT_LIB:libs[sdkB],
          EGO_POPUP_SERVER_LIB: coordinator === 'current' ? path.resolve(options.currentServerLib || libs.current) : path.resolve(options.previousServerLib || libs.previous),
          EGO_POPUP_LEGACY_COORDINATOR:coordinator === 'previous' ? '1' : '0',
          EGO_POPUP_CONTROLLED_WINDOW_ORDER:controlledOrder ? '1' : '0', EGO_POPUP_EXPECT_ORDER:controlledOrder && coordinator === 'current' ? '1' : '0',
          EGO_POPUP_TRACE:tracePath, EGO_POPUP_RECONNECT:reconnect ? '1' : '0', TMPDIR:scratch,TMP:scratch,TEMP:scratch};
        delete env.NODE_TEST_CONTEXT;
        const result = await new Promise(resolve => {
          let child, log = '', timedOut = false, spawnError;
          // Direct node:test execution avoids a test-runner grandchild on timeout.
          try { child = spawn(process.execPath,[fixture],{cwd:path.resolve(__dirname,'../../..'),env,stdio:['ignore','pipe','pipe']}); }
          catch(error) { resolve({code:null,log:String(error)}); return; }
          const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); },options.timeoutMs || 30000);
          const collect = data => { if (log.length < 2000000) log += data.toString(); };
          child.stdout.on('data',collect); child.stderr.on('data',collect);
          child.on('error',error => { spawnError = error.message; });
          child.on('close',(code,signal) => {clearTimeout(timer);resolve({code,signal,log,timedOut,spawnError});});
        });
        item.result = {...result,log:undefined};
        item.log = path.join(evidence,`${label}.log`); fs.writeFileSync(item.log,result.log);
        assert.ok(!result.timedOut && !result.spawnError && !result.signal,'child must exit normally within deadline');
        const trace = JSON.parse(fs.readFileSync(tracePath));
        item.trace = path.join(evidence,`${label}.json`); fs.copyFileSync(tracePath,item.trace);
        item.status = classify(coordinator,result,trace);
        item.unrelatedCounts = trace.phases.map(p=>p.unrelated.length);
        if (reconnect) {
          const recovery = trace.recoveryCharacterization;
          assert.equal(recovery.produced.length,0);
          if (controlledOrder && coordinator === 'current') {
            assert.equal(recovery.delta.filter(c=>c.kind==='add').length,3);
            assert.deepEqual(recovery.delta.filter(c=>c.kind==='add' && recovery.survivors.includes(c.id)),[]);
            assert.deepEqual(recovery.frames.filter(c=>recovery.survivors.includes(c.id)),[]);
            assert.deepEqual(recovery.delta.filter(c=>c.kind==='order').at(-1).ids,recovery.afterOrder.map(c=>c.id));
            item.status = 'controlled-native-order-reconnect-pass';
          } else {
            assert.equal(recovery.delta.filter(c=>c.kind==='add').length,coordinator === 'previous' ? 10 : 27);
            assert.ok(recovery.delta.some(c=>c.kind==='add' && c.id===1));
            item.status = coordinator === 'previous' ? 'legacy-known-failing-reconnect-characterization' : 'known-placement-limitation-characterization';
          }
        }
      } catch(error) {item.status='failed';item.error=error.message;} finally {save();}
    }
    try {
      for (const coordinator of ['current','previous']) for (const sdkA of ['current','previous']) for (const sdkB of ['current','previous']) await execute(coordinator,sdkA,sdkB);
      if (options.reconnect) await execute('current','current','previous',true);
      if (options.controlledWindowOrder) for (const coordinator of ['current','previous']) for (const sdkA of ['current','previous']) for (const sdkB of ['current','previous']) await execute(coordinator,sdkA,sdkB,true,true);
      report.summary = {currentPass:report.cases.filter(c=>c.status==='current-pass').length,
        legacyKnownFailingCharacterizations:report.cases.filter(c=>c.status==='legacy-known-failing-characterization').length,
        reconnectSeparate:report.reconnect?.length || 0};
      if (report.summary.currentPass === 4 && report.summary.legacyKnownFailingCharacterizations === 4 && !report.reconnect?.some(c=>c.status==='failed')) report.status='passed';
    } finally {fs.rmSync(scratch,{recursive:true,force:true});save();}
    return report;
  } catch (error) { report.status = 'failed'; report.error = error.message; save(); return report; }
}
module.exports = { runMatrix, classify };
if (require.main === module) {
  const args = process.argv.slice(2);
  const value = key => args[args.indexOf(key) + 1];
  runMatrix({ output: args.includes('--output') ? value('--output') : undefined,
    currentLib: args.includes('--current-lib') ? value('--current-lib') : undefined,
    previousLib: args.includes('--previous-lib') ? value('--previous-lib') : undefined,
    currentServerLib: args.includes('--current-server-lib') ? value('--current-server-lib') : undefined,
    previousServerLib: args.includes('--previous-server-lib') ? value('--previous-server-lib') : undefined,
    controlledWindowOrder: args.includes('--controlled-native-window-order'),
    reconnect: args.includes('--reconnect') }).then(report => { process.exitCode = report.status === 'passed' ? 0 : 1; });
}
