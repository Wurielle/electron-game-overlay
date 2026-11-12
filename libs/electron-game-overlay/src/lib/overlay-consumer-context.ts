import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { win32 as path } from 'node:path';
import { createReShadeLaunchConfig, type ReShadeLaunchConfig } from './reshade-launcher.js';
import { isValidProcessCreationTime100ns } from './overlay-process-identity.js';
import { sdkRuntimeCacheDirectory, type privateCacheVersion } from './runtime-payload-store.js';

/** Current caller token and availability of a verified same-user medium desktop parent. */
export type OverlayConsumerExecutionContext = Readonly<{
  ownerPid: number;
  creationTime100ns: string;
  executablePath: string;
  executableSha256: string;
  elevated: boolean;
  integrityRid: number;
  sessionId: number;
  overlaySupported: boolean;
  relaunchAvailable: boolean;
  relaunchRefusal: string | null;
}>;
/** Uses an already validated runtime configuration, or resolves the bundled native runtime. */
export type OverlayConsumerContextOptions = Readonly<{ config?: ReShadeLaunchConfig }>;
/** Own-executable replacement request. Arguments default to process.argv.slice(1), including a development app path. */
export type OverlayConsumerRelaunchOptions = OverlayConsumerContextOptions & Readonly<{
  context: OverlayConsumerExecutionContext;
  arguments?: readonly string[];
}>;
/** Confirms kernel process/image/token creation, not Electron app readiness or overlay authentication. */
export type OverlayConsumerRelaunchResult = Readonly<{
  status: 'launched' | 'already-unelevated';
  context: OverlayConsumerExecutionContext;
  replacement?: Readonly<{ pid: number; creationTime100ns: string }>;
}>;

const normalize = (value: string) => {
  const normalized=path.normalize(value), lower=normalized.toLowerCase();
  return (lower.startsWith('\\\\?\\unc\\')?'\\\\'+normalized.slice(8):lower.startsWith('\\\\?\\')?normalized.slice(4):normalized).toLowerCase();
};
const expectedKeys = ['schemaVersion','kind','ownerPid','creationTime100ns','executablePath','executableSha256','elevated','integrityRid','sessionId','overlaySupported','relaunchAvailable','relaunchRefusal','status','replacementPid','replacementCreationTime100ns'];
function validate(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native consumer context');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== expectedKeys.length || expectedKeys.some(key => !(key in result)) ||
      result.schemaVersion !== 1 || result.kind !== 'electron-game-overlay-consumer-context' || result.ownerPid !== process.pid ||
      !isValidProcessCreationTime100ns(result.creationTime100ns) || typeof result.executablePath !== 'string' ||
      normalize(result.executablePath) !== normalize(process.execPath) || typeof result.executableSha256 !== 'string' || !/^[A-F0-9]{64}$/u.test(result.executableSha256) ||
      typeof result.elevated !== 'boolean' || !Number.isSafeInteger(result.integrityRid) || Number(result.integrityRid)<0 || Number(result.integrityRid)>0xffffffff ||
      !Number.isSafeInteger(result.sessionId) || Number(result.sessionId)<0 || Number(result.sessionId)>0xffffffff ||
      typeof result.overlaySupported !== 'boolean' || result.overlaySupported !==
        (Number(result.sessionId)>0 && (result.elevated ? Number(result.integrityRid)===12288 : Number(result.integrityRid)<=8192)) ||
      typeof result.relaunchAvailable !== 'boolean' || !(result.relaunchRefusal===null || typeof result.relaunchRefusal==='string') ||
      result.relaunchAvailable !== (result.relaunchRefusal===null) || !['inspected','launched','already-unelevated'].includes(String(result.status))) {
    throw new Error('Native consumer context contradicted this caller or its token');
  }
  return result;
}
function snapshot(result: Record<string, unknown>): OverlayConsumerExecutionContext {
  const keys = ['ownerPid','creationTime100ns','executablePath','executableSha256','elevated','integrityRid','sessionId','overlaySupported','relaunchAvailable','relaunchRefusal'];
  return Object.freeze(Object.fromEntries(keys.map(key=>[key,result[key]]))) as OverlayConsumerExecutionContext;
}
async function invoke(config: ReShadeLaunchConfig | undefined, arguments_: readonly string[]): Promise<Record<string, unknown>> {
  const selected = config ?? createReShadeLaunchConfig();
  return new Promise((resolve,reject)=>{
    execFile(selected.addonManagerPath,[...arguments_],{encoding:'utf8',shell:false,windowsHide:true,timeout:30000,maxBuffer:65536},(error,stdout,stderr)=>{
      if(error){reject(new Error(`Native consumer context request failed: ${stdout.trim() || stderr.trim() || error.message}`));return;}
      try {
        if(stderr.trim())throw new Error('Unexpected consumer context stderr');
        const lines=stdout.trim().split(/\r?\n/u);if(lines.length!==1)throw new Error('Expected one native consumer context record');
        resolve(validate(JSON.parse(lines[0])));
      } catch(cause){reject(cause);}
    });
  });
}

/** @internal Reserve a new high-labelled private directory for this exact high caller. Never alters an existing directory. */
export async function createPrivateElevatedOverlayStage(config: ReShadeLaunchConfig, context: OverlayConsumerExecutionContext, root: string, prefix: string): Promise<string> {
  if (context.ownerPid!==process.pid || !context.elevated || context.integrityRid!==12288 || !isValidProcessCreationTime100ns(context.creationTime100ns) ||
      !path.isAbsolute(root) || !/^[a-zA-Z0-9._-]{1,128}$/u.test(prefix)) throw new Error('Invalid private elevated stage request');
  return new Promise((resolve,reject)=>execFile(config.addonManagerPath,
    ['--create-private-elevated-stage',String(process.pid),context.creationTime100ns,root,prefix],
    {encoding:'utf8',shell:false,windowsHide:true,timeout:30000,maxBuffer:65536},(error,stdout,stderr)=>{
      try {
        if(error || stderr.trim())throw new Error(`Native private elevated stage request failed: ${stdout.trim() || stderr.trim() || error?.message}`);
        const lines=stdout.trim().split(/\r?\n/u);if(lines.length!==1)throw new Error('Expected one private stage record');
        const result=JSON.parse(lines[0]);
        if(!result || typeof result!=='object' || Object.keys(result).sort().join(',')!=='creationTime100ns,directory,kind,ownerPid,schemaVersion' ||
            result.schemaVersion!==1 || result.kind!=='electron-game-overlay-private-elevated-stage' || result.ownerPid!==process.pid ||
            result.creationTime100ns!==context.creationTime100ns || typeof result.directory!=='string' ||
            normalize(path.dirname(result.directory))!==normalize(root) || !path.basename(result.directory).startsWith(prefix+'-') ||
            !/^[a-zA-Z0-9._-]+-[a-f0-9]{32}$/u.test(path.basename(result.directory))) throw new Error('Native private stage identity contradicted this caller or root');
        resolve(result.directory);
      }catch(cause){reject(cause);}
    }));
}

/** @internal Read-only native verification of all thirteen private high files and the two bounded medium data leaves. */
export async function verifyPrivateElevatedOverlayStage(config: ReShadeLaunchConfig, context: OverlayConsumerExecutionContext, directory: string, hashes: readonly string[]): Promise<void> {
  if (context.ownerPid!==process.pid || !context.elevated || context.integrityRid!==12288 || !isValidProcessCreationTime100ns(context.creationTime100ns) ||
      !path.isAbsolute(directory) || hashes.length!==13 || hashes.some(hash=>!/^[A-F0-9]{64}$/u.test(hash))) throw new Error('Invalid private elevated stage verification');
  return new Promise((resolve,reject)=>execFile(config.addonManagerPath,
    ['--verify-private-elevated-stage',String(process.pid),context.creationTime100ns,directory,...hashes],
    {encoding:'utf8',shell:false,windowsHide:true,timeout:30000,maxBuffer:65536},(error,stdout,stderr)=>{
      try {
        if(error || stderr.trim())throw new Error(`Native private elevated verification failed: ${stdout.trim() || stderr.trim() || error?.message}`);
        const lines=stdout.trim().split(/\r?\n/u);if(lines.length!==1)throw new Error('Expected one private verification record');
        const result=JSON.parse(lines[0]);
        if(!result || typeof result!=='object' || Object.keys(result).sort().join(',')!=='creationTime100ns,diagnosticsFiles,directory,kind,ownerPid,payloadFiles,schemaVersion' ||
            result.schemaVersion!==1 || result.kind!=='electron-game-overlay-private-elevated-stage-verified' || result.ownerPid!==process.pid ||
            result.creationTime100ns!==context.creationTime100ns || typeof result.directory!=='string' || normalize(result.directory)!==normalize(directory) ||
            result.payloadFiles!==13 || result.diagnosticsFiles!==2) throw new Error('Native private verification contradicted this caller or payload');
        resolve();
      }catch(cause){reject(cause);}
    }));
}

export function privateElevatedRunsRoot(runsRoot: string): string {
  return path.join(`${runsRoot}.elevated`, 'runs');
}

/** Holds the verified protected namespace and files from the bundled manager
 * through executable launch. Closing the input also drains the native lease. */
export async function holdPrivateElevatedCache(
  config: ReShadeLaunchConfig,
  context: OverlayConsumerExecutionContext,
  version?: Awaited<ReturnType<typeof privateCacheVersion>>,
) {
  if (context.ownerPid !== process.pid || !context.elevated || context.integrityRid !== 12288 ||
      !isValidProcessCreationTime100ns(context.creationTime100ns) || config.elevatedCacheBootstrap !== 1) {
    throw new Error('Protected runtime cache requires the actual supported high caller');
  }
  const runsRoot = config.runsRootDirectory;
  if (version) await mkdir(path.dirname(runsRoot), { recursive: true });
  const runsDirectory = privateElevatedRunsRoot(runsRoot);
  const store = sdkRuntimeCacheDirectory(runsDirectory);
  const directory = version ? path.join(store, version.key) : store;
  const args = [version ? '--hold-private-elevated-cache' : '--hold-private-elevated-cache-root',
    String(process.pid), context.creationTime100ns, runsRoot];
  if (version) args.push(version.key, version.marker, config.runtimeDirectory, ...version.hashes.values());
  const child = spawn(config.addonManagerPath, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => undefined);
  let stopped = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  child.once('close', () => { stopped = true; resolveClosed(); });
  const assertHeld = () => {
    if (stopped || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) {
      throw new Error('The protected runtime cache lease has closed');
    }
  };
  const release = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    try { await closed; } finally { clearTimeout(timer); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let reported = false;
      const timer = setTimeout(() => reject(new Error('Protected cache verification timed out')), 30000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('close', () => fail(new Error(`Protected cache verification exited: ${stdout.trim() || stderr.trim()}`)));
      child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr = (stderr + data).slice(-4096); });
      child.stdout.setEncoding('utf8').on('data', (data: string) => {
        if (reported) return;
        stdout += data;
        if (stdout.length > 8192) { fail(new Error('Protected cache verification exceeded its output bound')); return; }
        if (!stdout.includes('\n')) return;
        reported = true;
        try {
          const record = JSON.parse(stdout);
          if (!record || Object.keys(record).sort().join(',') !== 'creationTime100ns,directory,kind,ownerPid,runsDirectory,schemaVersion' ||
              record.schemaVersion !== 1 || record.kind !== 'electron-game-overlay-private-elevated-cache' ||
              record.ownerPid !== process.pid || record.creationTime100ns !== context.creationTime100ns ||
              typeof record.directory !== 'string' || normalize(record.directory) !== normalize(directory) ||
              typeof record.runsDirectory !== 'string' || normalize(record.runsDirectory) !== normalize(runsDirectory)) {
            throw new Error(`Protected cache verification was refused: ${stdout.trim()}`);
          }
          assertHeld();
          clearTimeout(timer);
          resolve();
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    return { directory, runsDirectory, assertHeld, release };
  } catch (error) {
    await release();
    throw error;
  }
}

/** Reads this calling process's real elevation/integrity and a same-user/session desktop relaunch capability. Never changes a token or starts an app. */
export async function inspectOverlayConsumerExecutionContext(options: OverlayConsumerContextOptions = {}): Promise<OverlayConsumerExecutionContext> {
  const result=await invoke(options.config,['--consumer-context',String(process.pid)]);
  if(result.status!=='inspected' || result.replacementPid!==0 || result.replacementCreationTime100ns!=='0')throw new Error('Unexpected launch during consumer context inspection');
  return snapshot(result);
}

/**
 * Creates only this consumer's own executable using a verified same-user/session
 * medium desktop parent and fresh user environment. It requests no UAC prompt,
 * never changes game privileges, and verifies the owned child's image/token
 * before resuming it. No existing user process thread is resumed or suspended.
 *
 * This explicit opt-in replacement API is separate from elevated overlay
 * support. It never changes a saved administrator preference. Before calling,
 * release the application's single-instance lock. On failure reacquire it;
 * on `launched` the host may quit the old elevated process. Keep app/session
 * startup in the replacement fresh; do not transfer elevated rendezvous tokens.
 * A successful result proves process creation, not application readiness.
 * A lost or invalid native response does not authorize a blind relaunch retry.
 */
export async function launchUnelevatedOverlayConsumer(options: OverlayConsumerRelaunchOptions): Promise<OverlayConsumerRelaunchResult> {
  const context=options.context;
  if(context.ownerPid!==process.pid || normalize(context.executablePath)!==normalize(process.execPath) ||
      !isValidProcessCreationTime100ns(context.creationTime100ns) || !/^[A-F0-9]{64}$/u.test(context.executableSha256)) throw new Error('Relaunch context does not identify this consumer');
  if((context.elevated || context.integrityRid>8192) && !context.relaunchAvailable)throw new Error(`Unelevated relaunch is unavailable: ${context.relaunchRefusal}`);
  const args=options.arguments ?? process.argv.slice(1);
  if(args.length>256 || args.some(arg=>typeof arg!=='string'||arg.includes('\0')) || args.reduce((length,arg)=>length+arg.length,0)>30000)throw new Error('Invalid consumer launch arguments');
  const result=await invoke(options.config,['--consumer-relaunch',String(process.pid),context.creationTime100ns,context.executableSha256,...args.flatMap(arg=>['--arg',arg])]);
  if(result.creationTime100ns!==context.creationTime100ns || result.executableSha256!==context.executableSha256 || result.status==='inspected')throw new Error('Consumer identity changed before relaunch');
  if(result.status==='already-unelevated'){
    if(result.elevated || Number(result.integrityRid)>8192 || result.replacementPid!==0 || result.replacementCreationTime100ns!=='0')throw new Error('Unexpected already-unelevated result');
    return Object.freeze({status:'already-unelevated',context:snapshot(result)});
  }
  if((!result.elevated && Number(result.integrityRid)<=8192) || !result.relaunchAvailable || !Number.isSafeInteger(result.replacementPid) || Number(result.replacementPid)<=0 || Number(result.replacementPid)>0xffffffff ||
      result.replacementPid===process.pid || !isValidProcessCreationTime100ns(result.replacementCreationTime100ns))throw new Error('Invalid verified replacement process');
  return Object.freeze({status:'launched',context:snapshot(result),replacement:Object.freeze({pid:Number(result.replacementPid),creationTime100ns:result.replacementCreationTime100ns as string})});
}
