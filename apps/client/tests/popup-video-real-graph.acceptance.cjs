// Explicit external-baseline runner: EGO_POPUP_SERVER_LIB selects an intact shipped lib graph.
// Real application + SDK + independent broker clients/private sockets; Electron/native boundary controlled.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const test = require('node:test');
if (process.env.EGO_POPUP_TRACE) fs.writeFileSync(process.env.EGO_POPUP_TRACE, JSON.stringify({status:'failed',stage:'setup',nativeExecuted:false}));
const ts = require('typescript');
const sdkLib = path.resolve(process.env.EGO_POPUP_CLIENT_LIB || 'libs/electron-game-overlay/dist/lib');
const serverLib = path.resolve(process.env.EGO_POPUP_SERVER_LIB || sdkLib);

const loadedHashes = new Map();
const waitFor = async (predicate) => {
  const until = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < until, 'private socket fixture deadline');
    await new Promise(r => setTimeout(r, 5));
  }
};
function appGraph(pipePath, clients, producer, sdkLib) {
  const { OverlayBrokerClient } = require(path.join(sdkLib, 'overlay-broker-client.js'));
  let nextId = 1;
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.id = nextId++; this.bounds = { x: 0, y: 0, ...options }; this.dead = false;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {}, send() {}, isDestroyed: () => this.dead,
        isOffscreen: () => true, invalidate() {}, sendInputEvent() {},
      });
    }
    getBounds() { const {x,y,width,height} = this.bounds; return {x,y,width,height}; }
    getContentBounds() { return this.getBounds(); }
    setBounds(bounds) { Object.assign(this.bounds, bounds); this.emit('resize'); }
    setContentBounds(bounds) { this.setBounds(bounds); }
    isDestroyed() { return this.dead; }
    loadURL() {} focusOnWebView() {} blurWebView() {}
    destroy() { this.dead = true; this.emit('closed'); }
    close() { this.destroy(); }
  }
  const display = { id: 1, scaleFactor: 1, bounds: {x:0,y:0,width:1920,height:1080}, workArea: {x:0,y:0,width:1920,height:1080} };
  const handlers = new Map();
  const ipcMain = new EventEmitter(); ipcMain.handle = (name, handler) => handlers.set(name, handler);
  const electron = { BrowserWindow: Window, ipcMain,
    screen: Object.assign(new EventEmitter(), {getDisplayMatching: () => display, getPrimaryDisplay: () => display, getAllDisplays: () => [display]}),
    globalShortcut: {register: () => true, unregister() {}},
  };
  class PrivateClient extends OverlayBrokerClient {
    constructor() { super({pipePath, spawnBroker() { throw new Error('unexpected bootstrap'); }}); clients.push(this); }
    addWindow(id, details) { producer.push({id, details: structuredClone(details)}); return super.addWindow(id, details); }
  }
  const cache = new Map();
  let sdk;
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = new Module(filename); cache.set(filename, mod); mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = specifier => {
      if (specifier === 'electron') return electron;
      if (specifier === 'electron-game-overlay') return sdk;
      if (filename === path.join(sdkLib, 'native.js') && specifier === './overlay-broker-client.js') return {OverlayBrokerClient: PrivateClient};
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(filename), specifier);
        for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.js`]) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return load(candidate);
        }
      }
      return createRequire(filename)(specifier);
    };
    const source = fs.readFileSync(filename, 'utf8');
    loadedHashes.set(filename, createHash('sha256').update(source).digest('hex'));
    mod._compile(filename.endsWith('.ts') ? ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText : source, filename);
    return mod.exports;
  }
  sdk = load(path.join(sdkLib, 'electron-game-overlay.js'));
  const { Application } = load(path.resolve('apps/client/src/main/electron/app-entry.ts'));
  const app = new Application(); app.setupIpc();
  const { authorizeOverlaySessionTarget } = load(path.join(sdkLib, 'overlay-session.js'));
  return {app, handlers, ipcMain, authorize: (...args) => authorizeOverlaySessionTarget(app.overlaySession, ...args)};
}

test('actual popup/video paths never replay unrelated placements', {timeout: 20000}, async t => {
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\ego-popup-${randomUUID()}` : `\0ego-popup-${randomUUID()}`;
  const calls = [], producer = [], clients = [], graphs = [], phases = [];
  let recoveryCharacterization = null;
  let frameCount = 0, focusCount = 0;
  const frames = [];
  const expectOrder = process.env.EGO_POPUP_EXPECT_ORDER === '1';
  let nativeEvent;
  const transport = {
    start() {}, stop() {}, whenReady: async () => {}, authorizeTarget: async () => () => {},
    setDiagnosticCallback() {}, setEventCallback(callback) { nativeEvent = callback; },
    setInputIntercept() {}, closeWindow(id) { calls.push({kind:'close',id}); }, sendFrameBuffer(id) { frames.push({id}); frameCount++; return true; },
    sendWindowBounds(id, geometry) { calls.push({kind:'bounds',id,geometry}); }, raiseWindowForSnapshot() {},
    addWindow(id, details) { calls.push({kind:'add',id,details:structuredClone(details),origin:new Error().stack.split('\n').slice(2,7)}); },
  };
  // Opt-in controlled native boundary: records the production coordinator's output only.
  // No placement simulation or copy of the coordinator/Loopback ordering algorithm.
  if (process.env.EGO_POPUP_CONTROLLED_WINDOW_ORDER === '1') transport.addWindowInOrder = (id, details, ids) => {
    transport.addWindow(id, details);
    calls.push({kind:'order', ids:[...ids]});
    return true;
  };
  let server, failure, completed = false, stage = 'setup';
  const argv = process.argv, config = global.CONFIG;
  t.after(async () => {
    const cleanupErrors = [];
    for (const {app} of graphs) try { app.dispose(); } catch(error) { cleanupErrors.push(error.message); }
    for (const client of clients) try { client.stop(); } catch(error) { cleanupErrors.push(error.message); }
    try { if (server) await server.stop(); } catch(error) { cleanupErrors.push(error.message); }
    process.argv = argv; global.CONFIG = config;
    const report = {status:completed && !cleanupErrors.length ? 'passed' : 'failed',stage,failure,cleanupErrors,nativeExecuted:false,serverLib,sdkLib,phases,producer,calls,recoveryCharacterization,loadedHashes:Object.fromEntries(loadedHashes),
      hashes:Object.fromEntries([path.join(serverLib,'overlay-broker-server.js'),path.join(sdkLib,'overlay-broker-client.js'),path.join(sdkLib,'overlay-session.js'),path.join(sdkLib,'electron-overlay-window.js')].filter(file=>fs.existsSync(file)).map(file => [file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))};
    if (process.env.EGO_POPUP_TRACE) fs.writeFileSync(process.env.EGO_POPUP_TRACE, JSON.stringify(report,null,2));
    assert.deepEqual(cleanupErrors, [], 'fixture cleanup must complete');
  });
  try {
  const { OverlayBrokerServer } = require(path.join(serverLib, 'overlay-broker-server.js'));
  server = new OverlayBrokerServer({pipePath,idleShutdownMs:false,runtimeProviderElectionWindowMs:0,
    isProcessAlive: () => true,targetRecoveryClaimProbe: () => undefined,clearTargetRecoveryClaim() {},targetTransportFactory: () => transport});
  process.argv = [...argv, '--demo-presentation']; global.CONFIG = {resolveRendererUrl: value => value};
  await server.start();
  for (let index = 0; index < 2; index++) {
    const graph = appGraph(pipePath, clients, producer, index === 1 ? path.resolve(process.env.EGO_POPUP_PEER_CLIENT_LIB || sdkLib) : sdkLib);
    graphs.push(graph); graph.app.syncDemoControlOverlay();
    for (const name of ['example-main-overlay', 'example-status-overlay']) graph.app.setExampleOverlayWindowVisible(name, true);
  }
  await Promise.all(clients.map(client => client.whenReady()));
  const pid = 43210, executable = 'C:\\Games\\Controlled.exe';
  await graphs[0].authorize(pid, path.resolve(process.env.TMPDIR || require('node:os').tmpdir(),'ego-popup-a.json'), executable);
  nativeEvent('game.process', {pid,path:executable});
  await graphs[1].authorize(pid, path.resolve(process.env.TMPDIR || require('node:os').tmpdir(),'ego-popup-b.json'), executable);
  await waitFor(() => new Set(calls.filter(call => call.kind === 'add').map(call => call.id)).size === 6);
  assert.equal(clients.length, 2, 'independent application clients');
  graphs[0].app.overlaySession.on('windowFocused', () => focusCount++);
  assert.equal(graphs[0].app.overlayWindows.get('demo-control-overlay').nativeId, graphs[1].app.overlayWindows.get('demo-control-overlay').nativeId, 'independent app-local numeric IDs deliberately collide');
  const violations = [];
  async function phase(name, action, changed = true, allowedName) {
    const before = calls.length, beforeProducer = producer.length;
    const existing = new Map();
    for (const call of calls) {
      if (call.kind === 'add') existing.set(call.id, call.details.name);
      else if (call.kind === 'close') existing.delete(call.id);
    }
    await action();
    if (changed) await waitFor(() => calls.length > before);
    // A real frame follows scene controls on the same socket; native boundary acknowledges it.
    const beforeFrame = frameCount;
    clients[0].sendFrameBuffer(1, Buffer.from([1,2,3,4]), 1, 1);
    await waitFor(() => frameCount > beforeFrame);
    const delta = calls.slice(before), produced = producer.slice(beforeProducer);
    const unrelated = delta.filter(call => call.kind === 'add' && existing.has(call.id) && existing.get(call.id) !== allowedName);
    phases.push({name,delta,produced,unrelated});
    if (unrelated.length) violations.push({phase:name,replayed:unrelated.map(call => ({id:call.id,name:call.details.name,rect:call.details.rect})),producer:produced.map(call=>call.details.name)});
  }
  await phase('fresh-popup', () => graphs[0].handlers.get('overlay:create-popup')());
  await phase('first-video', () => graphs[0].ipcMain.emit('showExampleVideoOverlay'), true, 'example-video-overlay');
  const video = graphs[0].app.overlayWindows.get('example-video-overlay');
  await phase('reuse-visible-video', () => graphs[0].ipcMain.emit('showExampleVideoOverlay'), false, 'example-video-overlay');
  assert.equal(graphs[0].app.overlayWindows.get('example-video-overlay'), video, 'reuse actual wrapper');
  await phase('hide-video', () => graphs[0].handlers.get('overlay:set-window-visible')({}, 'example-video-overlay', false), true, 'example-video-overlay');
  await phase('show-hidden-video', () => graphs[0].handlers.get('overlay:set-window-visible')({}, 'example-video-overlay', true), true, 'example-video-overlay');
  for (let repeat = 0; repeat < 2; repeat++) {
    await phase(`repeated-popup-${repeat}`, () => graphs[0].handlers.get('overlay:create-popup')());
    const focused = calls.find(call => call.kind === 'add').id;
    await phase(`focus-${repeat}`, async () => {
      const beforeFocus = focusCount;
      nativeEvent('game.window.focused', {pid,focusWindowId:focused});
      await waitFor(() => focusCount > beforeFocus);
    }, false, '__none__');
  }
  if (process.env.EGO_POPUP_RECONNECT === '1') {
    // Characterize the documented older-token restoration path, not a normal popup.
    // Break only this fixture's actual socket; retain genuine broker-issued tokens.
    const host = server.targets.get(pid);
    const snapshot = () => Array.from(host.ownersByTargetWindowId, ([id, owner]) => ({id, token:owner.client.windows.get(owner.localWindowId).orderToken})).sort((a,b)=>a.token.localeCompare(b.token));
    const beforeOrder = snapshot();
    const beforeSeed = frames.length;
    for (const client of clients) for (const id of client.windows.keys()) client.sendFrameBuffer(id, Buffer.from([1,2,3,4]), 1, 1);
    await waitFor(() => frames.length >= beforeSeed + beforeOrder.length);
    const before = calls.length, beforeProducer = producer.length, beforeFrames = frames.length;
    const original = clients[1].socket;
    original.destroy();
    await waitFor(() => clients[1].socket && clients[1].socket !== original && calls.slice(before).filter(call => call.kind === 'close').length === 3 && host.ownersByTargetWindowId.size === beforeOrder.length);
    // A real surviving-client frame is a socket processing barrier, excluded from recovery frames.
    clients[0].sendFrameBuffer(1, Buffer.from([1,2,3,4]), 1, 1);
    await waitFor(() => frames.length > beforeFrames && frames.at(-1).id === 1);
    const delta = calls.slice(before), removed = delta.filter(c=>c.kind==='close').map(c=>c.id);
    const survivors = beforeOrder.filter(entry=>!removed.includes(entry.id)).map(entry=>entry.id);
    recoveryCharacterization = {trigger:'real peer socket disconnect/reconnect with genuine retained older order tokens',boundary:'controlled native transport only; not Loopback/native placement proof',delta,produced:producer.slice(beforeProducer),frames:frames.slice(beforeFrames,-1),survivors,removed,beforeOrder,afterOrder:snapshot()};
    stage = 'assertions';
    assert.equal(recoveryCharacterization.produced.length, 0, 'recovery replay is not an application/OverlaySession re-registration');
    if (expectOrder) {
      assert.deepEqual(delta.filter(c=>c.kind==='add' && survivors.includes(c.id)), [], 'capable reconnect must not replay survivor metadata');
      assert.deepEqual(recoveryCharacterization.frames.filter(c=>survivors.includes(c.id)), [], 'capable reconnect must not replay survivor frames');
      assert.equal(delta.filter(c=>c.kind==='add').length, 3, 'only removed own windows re-register');
      assert.deepEqual(recoveryCharacterization.frames.map(c=>c.id).sort((a,b)=>a-b), delta.filter(c=>c.kind==='add').map(c=>c.id).sort((a,b)=>a-b), 'only recreated own windows receive their retained frames');
      assert.equal(delta.filter(c=>c.kind==='order').length, 3, 'each restored older token supplies complete order');
      const live = new Set(beforeOrder.map(entry=>entry.id));
      const finalOrder = snapshot().map(entry=>entry.id);
      for (const call of delta) {
        if (call.kind === 'close') live.delete(call.id);
        if (call.kind === 'add') live.add(call.id);
        if (call.kind === 'order') assert.deepEqual(call.ids, finalOrder.filter(id=>live.has(id)), 'every insertion carries exact complete bottom-to-top live order');
      }
      assert.deepEqual(delta.filter(c=>c.kind==='order').at(-1).ids, finalOrder, 'complete aggregate order follows genuine broker tokens');
      assert.deepEqual(snapshot().map(entry=>entry.token), beforeOrder.map(entry=>entry.token), 'genuine retained token order restored');
    } else {
      assert.equal(delta.filter(c=>c.kind==='add').length, process.env.EGO_POPUP_LEGACY_COORDINATOR === '1' ? 10 : 27, 'exact frozen-v1 reconnect metadata replay characterization');
      assert.ok(delta.some(call => call.kind === 'add' && call.id === 1), 'retained older-token restoration really replays the surviving app placement');
    }
  }
  stage = 'assertions';
  assert.deepEqual(violations, [], 'unrelated windows must not be re-registered with retained Electron geometry');
  completed = true;
  } catch(error) { failure = {code:error.code,message:error.message.split('\n')[0]}; throw error; }
});
