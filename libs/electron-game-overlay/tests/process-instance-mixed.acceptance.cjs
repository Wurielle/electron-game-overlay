'use strict';

// Opt-in only (outside *.test.cjs): node this-file.cjs /absolute/old/dist [...]
// No native process lookup, injection, process launch or signal is performed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const currentDist = path.resolve(__dirname, '../dist');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const file = 'lib/overlay-loopback-transport.js';
const fingerprint = (root) => sha(fs.readFileSync(path.join(root, file)));

if (!process.env.EGO_INSTANCE_MIXED_WORKER) {
  const roots = process.argv.slice(2);
  if (!roots.length && process.env.EGO_INSTANCE_MIXED_OLD_DIST)
    roots.push(process.env.EGO_INSTANCE_MIXED_OLD_DIST);
  const outputPath = process.env.EGO_INSTANCE_MIXED_EVIDENCE || path.resolve(__dirname, '../../../../exploration-evidence/process-instance-mixed-acceptance.json');
  const evidence = {
    success: false, platform: process.platform, node: process.version,
    currentDist, invocation: [process.execPath, __filename, ...roots], runs: [],
    boundaries: {
      real: ['independent full relative compiled CommonJS graphs', 'durable private claims and atomic publication', 'old reader and old coordinator transport rewrite', 'new recovery with known and absent creation identity'],
      controlled: ['private os.userInfo homedir and tmpdir', 'isProcessAlive returns true for fixture PID'],
      excluded: ['native/Windows execution', 'DLL injection or injection count', 'OS process query', 'broker client wire compatibility (covered separately by broker-mixed-package.acceptance.cjs)'],
    },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const save = () => fs.writeFileSync(outputPath, JSON.stringify(evidence, null, 2) + '\n');
  save();
  assert.ok(roots.length, 'Explicit absolute old compiled SDK root required');
  roots.forEach((root) => {
    assert.ok(path.isAbsolute(root), 'Old SDK root must be absolute');
    assert.notEqual(fs.realpathSync(root), fs.realpathSync(currentDist));
    assert.notEqual(fingerprint(root), fingerprint(currentDist), 'Genuine distinct old implementation required');
  });
  for (const oldDist of roots) {
    const before = { old: fingerprint(oldDist), current: fingerprint(currentDist) };
    const run = (mutation) => {
      const args = ['--test', '--test-reporter=tap', __filename];
      const env = { ...process.env, EGO_INSTANCE_MIXED_WORKER: '1', EGO_INSTANCE_MIXED_OLD_DIST: oldDist, EGO_INSTANCE_MIXED_MUTATION: mutation ? '1' : '' };
      delete env.NODE_TEST_CONTEXT;
      const privateParent = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ego-instance-mix-worker-'));
      env.EGO_INSTANCE_MIXED_FIXTURE_PARENT = privateParent;
      try {
        const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
        const output = (r.stdout || '') + (r.stderr || '');
        return { command: [process.execPath, ...args], env: { EGO_INSTANCE_MIXED_OLD_DIST: oldDist, EGO_INSTANCE_MIXED_MUTATION: env.EGO_INSTANCE_MIXED_MUTATION }, exitCode: r.status, signal: r.signal, error: r.error?.message, output,
          graphs: JSON.parse(output.match(/GRAPHS (.*)/)?.[1] || 'null') };
      } finally {
        fs.rmSync(privateParent, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
      }
    };
    const baseline = run(false);
    const mutation = run(true);
    const verification = run(false);
    const after = { old: fingerprint(oldDist), current: fingerprint(currentDist) };
    const mutationDetected = mutation.exitCode === 1 && /MUTATION_APPLIED legacy-backfill/.test(mutation.output) && /legacy identity must remain unknown/.test(mutation.output) && /ERR_ASSERTION/.test(mutation.output);
    const unchanged = JSON.stringify(before) === JSON.stringify(after) && baseline.graphs !== null && JSON.stringify(baseline.graphs) === JSON.stringify(verification.graphs);
    const passed = [baseline, verification].every((r) => r.exitCode === 0 && /# pass 2\b/.test(r.output) && /# fail 0\b/.test(r.output));
    evidence.runs.push({ oldDist, before, after, unchanged, mutationDetected, baseline, mutation, verification, success: passed && unchanged && mutationDetected });
    save();
    console.log(baseline.output);
    console.log(`# ${oldDist}: mutationDetected=${mutationDetected}; unchanged=${unchanged}; cleanRerun=${verification.exitCode}`);
  }
  evidence.success = evidence.runs.every((r) => r.success);
  save();
  console.log(`# evidence: ${outputPath}`);
  process.exitCode = evidence.success ? 0 : 1;
} else {
  const oldDist = process.env.EGO_INSTANCE_MIXED_OLD_DIST;
  assert.ok(oldDist && path.isAbsolute(oldDist));
  const bounded = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), 3000); })]);
    } finally { clearTimeout(timer); }
  };
  function graph(root, privateRoot, mutate) {
    root = fs.realpathSync(root);
    const cache = new Map();
    const hashes = {};
    const privateOs = { ...os, tmpdir: () => privateRoot, userInfo: () => ({ ...os.userInfo(), homedir: privateRoot }) };
    function load(filename) {
      if (cache.has(filename)) return cache.get(filename).exports;
      assert.ok(filename.startsWith(root + path.sep));
      assert.equal(path.extname(filename), '.js');
      let source = fs.readFileSync(filename, 'utf8');
      hashes[path.relative(root, filename)] = sha(source);
      if (mutate && filename === path.join(root, file)) {
        const needle = 'priorClaim ? priorClaim.creationTime100ns : routeContext?.creationTime100ns';
        assert.equal(source.split(needle).length, 3, 'Exactly two no-backfill expressions must be mutated');
        source = source.replaceAll(needle, 'priorClaim?.creationTime100ns ?? routeContext?.creationTime100ns');
        console.log('# MUTATION_APPLIED legacy-backfill');
      }
      const m = new Module(filename, module);
      m.filename = filename;
      m.paths = Module._nodeModulePaths(path.dirname(filename));
      cache.set(filename, m);
      m.require = (id) => {
        assert.ok(id !== 'electron' && !id.endsWith('.node'), 'Native execution forbidden');
        if (id === 'node:os' || id === 'os') return privateOs;
        const resolved = Module._resolveFilename(id, m);
        return resolved.startsWith(root + path.sep) ? load(resolved) : require(resolved);
      };
      m._compile(source, filename);
      m.loaded = true;
      return m.exports;
    }
    return { api: load(path.join(root, file)), hashes };
  }
  for (const scenario of ['published takeover', 'exact intent resume']) {
    test(`new -> genuine old rewrite -> new: ${scenario}`, { timeout: 12000 }, async (t) => {
      // Cleanup registered before resources; fresh deadline, never an already-aborted signal.
      const transports = [];
      const releases = [];
      const pending = [];
      let root;
      t.after(async () => {
        let failure;
        try {
          for (const cleanup of [...transports.map((transport) => () => transport.stop()), ...releases]) {
            try { cleanup(); } catch (error) { failure ||= error; }
          }
          try { await bounded(Promise.allSettled(pending), 'owned authorization settlement'); }
          catch (error) { failure ||= error; }
        } finally {
          if (root) {
            try {
              await bounded(fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }), 'owned root removal');
              assert.equal(fs.existsSync(root), false, 'Owned private root removed');
            } catch (error) { failure ||= error; }
          }
        }
        if (failure) throw failure;
      });
      root = fs.mkdtempSync(path.join(process.env.EGO_INSTANCE_MIXED_FIXTURE_PARENT || process.env.TMPDIR || os.tmpdir(), 'ego-instance-mix-'));
      const current = graph(currentDist, root, process.env.EGO_INSTANCE_MIXED_MUTATION === '1');
      const old = graph(oldDist, root, false);
      assert.notEqual(current.api.OverlayLoopbackTransport, old.api.OverlayLoopbackTransport);
      const strip = (s) => s.replace(/const SDK_VERSION\s*=\s*[^;]+;/g, '').replace(/^\/\/# sourceMappingURL=.*$/gm, '');
      assert.notEqual(sha(strip(fs.readFileSync(path.join(currentDist, file), 'utf8'))), sha(strip(fs.readFileSync(path.join(oldDist, file), 'utf8'))));
      const pid = 0xffffc101;
      const discovery = path.join(root, 'run/electron-overlay-transport-v1.json');
      const lease = 'mixed-pinned-lease';
      const A = '9007199254740993';
      const B = '9007199254740995';
      const claimPath = current.api.defaultOverlayTargetRecoveryClaimPath(pid);
      assert.ok(claimPath.startsWith(root + path.sep), 'Private claims required');
      assert.equal(old.api.defaultOverlayTargetRecoveryClaimPath(pid), claimPath);
      const raw = () => JSON.parse(fs.readFileSync(claimPath, 'utf8'));
      const pinned = (claim) => ({ discoveryPath: claim.discoveryPath, staticDiscoveryPath: claim.staticDiscoveryPath, leaseId: claim.leaseId, targetPid: claim.targetPid });
      const start = async (sdk, hook) => {
        const tr = new sdk.api.OverlayLoopbackTransport({ discoveryPath: path.join(root, `global-${transports.length}.json`), isProcessAlive: () => true, targetAuthorizationPublicationHook: hook });
        transports.push(tr);
        tr.start();
        await bounded(tr.whenReady(), 'real transport listen');
        return tr;
      };
      const first = await start(current, (_phase, claim) => assert.equal(claim.creationTime100ns, A));
      await bounded(first.authorizeTarget(pid, discovery, undefined, { leaseId: lease, creationTime100ns: A }), 'Known A publication');
      const known = current.api.readOverlayTargetRecoveryClaim(pid);
      assert.equal(known.creationTime100ns, A);
      assert.equal(raw().creationTime100ns, A);
      const oldRead = old.api.readOverlayTargetRecoveryClaim(pid);
      assert.ok(oldRead, 'Old reader accepts extra creation field');
      assert.equal('creationTime100ns' in oldRead, false, 'Genuine old reader ignores new field');
      assert.deepEqual(pinned(oldRead), pinned(known));
      first.stop();
      const oldPhases = [];
      const older = await start(old, (phase, claim) => oldPhases.push({ phase, claim: structuredClone(claim) }));
      await bounded(older.authorizeTarget(pid, discovery, undefined, { leaseId: 'different-takeover-request', allowPublishedClaimTakeover: true }), 'real old coordinator rewrite');
      assert.equal('creationTime100ns' in raw(), false, 'Old coordinator actually drops unknown field');
      assert.deepEqual(pinned(raw()), pinned(known));
      assert.ok(oldPhases.length >= 5);
      assert.ok(oldPhases.every(({ claim }) => !('creationTime100ns' in claim)));
      assert.notEqual(raw().record.token, known.record.token, 'Rewrite must rotate credentials, not preserve whole claim bytes');
      assert.equal(current.api.overlayTargetRecoveryClaimMayHaveBeenConsumed(current.api.readOverlayTargetRecoveryClaim(pid)), true);
      older.stop();
      if (scenario === 'exact intent resume') {
        // Hold a genuine old transaction after durable intent publication and before arming.
        // This distinct PID never reaches a possibly-consumed phase before current resumes it.
        const intentPid = pid + 1;
        let markPublished;
        let releaseIntent;
        const published = new Promise((resolve) => { markPublished = resolve; });
        const held = new Promise((resolve) => { releaseIntent = resolve; });
        releases.push(releaseIntent);
        const intentOld = await start(old, (phase, claim) => {
          if (phase === 'recovery-claim-published') {
            assert.equal(claim.phase, 'intent');
            markPublished();
            return held;
          }
        });
        const abandoned = intentOld.authorizeTarget(intentPid, path.join(root, 'intent/electron-overlay-transport-v1.json'), undefined, { leaseId: lease });
        pending.push(abandoned);
        void abandoned.catch(() => {});
        await bounded(published, 'old durable intent before arming');
        assert.equal(old.api.overlayTargetRecoveryClaimMayHaveBeenConsumed(old.api.readOverlayTargetRecoveryClaim(intentPid)), false);
        intentOld.stop();
        const resume = await start(current);
        await bounded(resume.authorizeTarget(intentPid, path.join(root, 'intent/electron-overlay-transport-v1.json'), undefined, { leaseId: lease, creationTime100ns: B }), 'legacy exact intent resume');
        assert.equal('creationTime100ns' in current.api.readOverlayTargetRecoveryClaim(intentPid), false, 'legacy identity must remain unknown: exact intent');
        assert.equal(current.api.readOverlayTargetRecoveryClaim(intentPid).leaseId, lease);
        releaseIntent();
        await assert.rejects(bounded(abandoned, 'stopped old transaction settlement'), /stopped|superseded|active/i);
        assert.equal(current.api.readOverlayTargetRecoveryClaim(intentPid).phase, 'published', 'Old rollback cannot erase replacement');
      }
      const modernPhases = [];
      const modern = await start(current, (phase, claim) => modernPhases.push({ phase, claim: structuredClone(claim) }));
      await bounded(modern.authorizeTarget(pid, discovery, undefined, { leaseId: lease, creationTime100ns: B }), 'new recovery after identity loss');
      const recovered = current.api.readOverlayTargetRecoveryClaim(pid);
      assert.equal('creationTime100ns' in recovered, false, 'legacy identity must remain unknown: no B backfill');
      assert.equal('creationTime100ns' in raw(), false);
      assert.ok(modernPhases.every(({ claim }) => !('creationTime100ns' in claim)));
      assert.deepEqual(pinned(recovered), pinned(known));
      assert.equal(current.api.overlayTargetRecoveryClaimMayHaveBeenConsumed(recovered), true);
      console.log(`# GRAPHS ${JSON.stringify({ old: old.hashes, current: current.hashes })}`);
    });
  }
}
