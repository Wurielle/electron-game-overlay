import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import type { NativeRuntimeProviderMetadata } from './native.js';
import type {
  OverlayBrokerServerMessage,
  OverlayBrokerTargetAuthorize,
  OverlayBrokerTargetAuthorized,
} from './overlay-broker-protocol.js';
import {
  isValidProcessCreationTime100ns,
  type OverlayBrokerProcessIdentity,
} from './overlay-process-identity.js';
import {
  targetAuthorizers,
  type ReShadeAttachmentSession,
} from './overlay-session-authorization.js';
import {
  attachReShadeOverlay,
  parseReShadeLaunchConfig,
  ReShadeOverlayLauncher,
} from './reshade-launcher.js';
import type {
  Disposable,
  OverlaySessionEventHandler,
  OverlaySessionEventName,
} from './types.js';

/** A broker-local provider; it owns no application windows or listener lease. */
export interface OverlayBrokerNativeTargetProvider {
  readonly metadata: NativeRuntimeProviderMetadata;
  readonly leaseId: string;
  readonly executablePath?: string;
  onAttachmentError(handler: (error: unknown) => void): Disposable;
  prepare(): Promise<string>;
  receive(message: OverlayBrokerServerMessage): void;
  dispose(): void;
}

/** A validated cached implementation offered synchronously to every new cohort. */
export interface OverlayBrokerNativeRuntimeProvider {
  /** Broker-owned OS evidence, independent of the elected target runtime. */
  queryProcessIdentity?(
    pid: number,
  ): Promise<OverlayBrokerProcessIdentity | undefined>;
  createTarget(
    request: OverlayBrokerTargetAuthorize,
  ): OverlayBrokerNativeTargetProvider | undefined;
  dispose(): void;
}

/** Standalone service paths and bounded diagnostic observer. @internal */
export interface StandaloneOverlayNativeProviderOptions {
  executablePath?: string;
  runsRootDirectory?: string;
  onDiagnostic?: (diagnostic: unknown) => void;
}

/** @internal Read-only OS identity query through the already validated native manager. */
export async function resolveOverlayBrokerProcessIdentity(
  pid: number,
  addonManagerPath: string,
): Promise<OverlayBrokerProcessIdentity> {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0xffffffff) {
    throw new RangeError('Target PID must be a positive uint32');
  }
  if (typeof addonManagerPath !== 'string' || !isAbsolute(addonManagerPath)) {
    throw new Error('A validated absolute native manager path is required');
  }
  let output: string;
  try {
    output = await new Promise<string>((resolve, reject) => {
      execFile(
        addonManagerPath,
        ['--query-process-image', String(pid)],
        {
          shell: false,
          windowsHide: true,
          cwd: dirname(addonManagerPath),
          timeout: 2000,
          maxBuffer: 128 * 1024,
          encoding: 'utf8',
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  } catch (error) {
    throw new Error(
      `Unable to query OS executable identity for PID ${pid}; validated native probe failed`,
      { cause: error },
    );
  }
  let record: unknown;
  try {
    if (/[\r\n]/.test(output.replace(/\r?\n$/, '')))
      throw new Error('Expected one JSON line');
    record = JSON.parse(output);
  } catch (error) {
    throw new Error(`OS executable identity unavailable for PID ${pid}`, {
      cause: error,
    });
  }
  if (
    typeof record !== 'object' ||
    record === null ||
    !('schemaVersion' in record) ||
    record.schemaVersion !== 1 ||
    !('kind' in record) ||
    record.kind !== 'electron-game-overlay-process-image' ||
    !('pid' in record) ||
    record.pid !== pid ||
    !('executablePath' in record) ||
    typeof record.executablePath !== 'string'
  ) {
    throw new Error(`OS executable identity unavailable for PID ${pid}`);
  }
  const executablePath = record.executablePath;
  if (
    !win32.isAbsolute(executablePath) ||
    !/^([a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(executablePath) ||
    executablePath.length > 32767 ||
    /[\x00-\x1f]/.test(executablePath)
  ) {
    throw new Error(`OS executable identity unavailable for PID ${pid}`);
  }
  if (
    'creationTime100ns' in record &&
    !isValidProcessCreationTime100ns(record.creationTime100ns)
  ) {
    throw new Error(`OS executable identity unavailable for PID ${pid}`);
  }
  return {
    pid,
    executablePath,
    ...('creationTime100ns' in record
      ? { creationTime100ns: record.creationTime100ns as string }
      : {}),
  };
}

/** @internal Compatibility image-only view of the same bounded OS query. */
export async function resolveOverlayBrokerProcessImage(
  pid: number,
  addonManagerPath: string,
): Promise<string> {
  return (await resolveOverlayBrokerProcessIdentity(pid, addonManagerPath))
    .executablePath;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * Validates both cached architectures and prepares the first run before the
 * listener opens. Unsupported platforms have no provider; corrupt Windows
 * bundles produce a diagnostic and retain ordinary live-provider fallback.
 * @internal
 */
export async function prepareStandaloneOverlayNativeProvider(
  options: StandaloneOverlayNativeProviderOptions = {},
): Promise<OverlayBrokerNativeRuntimeProvider | undefined> {
  if (process.platform !== 'win32' || process.arch !== 'x64') return undefined;
  const report = (diagnostic: unknown) => {
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      /* Observers cannot change ownership. */
    }
  };
  let config;
  let providerIdentity: string;
  let spare: ReShadeOverlayLauncher | undefined;
  try {
    config = parseReShadeLaunchConfig(['--reshade-overlay'], {
      bundledRuntimeDirectory: join(
        dirname(options.executablePath ?? process.execPath),
        'runtime',
        'win32-x64',
        'reshade',
      ),
      runsRootDirectory: options.runsRootDirectory,
    })!;
    spare = new ReShadeOverlayLauncher(config);
    await spare.prepare();
    providerIdentity = createHash('sha256')
      .update(readFileSync(config.packageBuildStampPath))
      .update(readFileSync(config.x86PackageBuildStampPath))
      .digest('hex');
  } catch (error) {
    spare?.dispose();
    report({
      code: 'cached-native-runtime-unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  const validatedConfig = config;
  const targets = new Set<OverlayBrokerNativeTargetProvider>();
  // The elected cached target already sampled this identity. Reuse that sample
  // once for initial broker publication; later recovery probes must query afresh.
  const preparedIdentities = new Map<number, Promise<OverlayBrokerProcessIdentity>>();
  let disposed = false;
  return {
    queryProcessIdentity(pid) {
      const prepared = preparedIdentities.get(pid);
      if (prepared) {
        preparedIdentities.delete(pid);
        return prepared;
      }
      return resolveOverlayBrokerProcessIdentity(
        pid,
        validatedConfig.addonManagerPath,
      );
    },
    createTarget(request) {
      if (
        disposed ||
        !Number.isInteger(request.pid) ||
        request.pid < 1 ||
        request.pid > 0xffffffff
      )
        return undefined;
      let executablePath: string | undefined;
      let preparedIdentity: Promise<OverlayBrokerProcessIdentity> | undefined;
      const launcher = spare ?? new ReShadeOverlayLauncher(validatedConfig);
      spare = undefined;
      const ready = deferred<string>();
      const authorization = deferred<OverlayBrokerTargetAuthorized>();
      const events = new Map<string, Set<(payload: never) => void>>();
      const closeHandlers = new Set<() => void>();
      const attachmentErrorHandlers = new Set<(error: unknown) => void>();
      let grantedInjection = false;
      let started = false;
      let closed = false;
      const emit = (name: string, payload: unknown) => {
        for (const handler of events.get(name) ?? []) handler(payload as never);
      };
      const session: ReShadeAttachmentSession = {
        whenReady: () => Promise.resolve(),
        on<E extends OverlaySessionEventName>(
          event: E,
          handler: OverlaySessionEventHandler<E>,
        ): Disposable {
          let handlers = events.get(event);
          if (!handlers) events.set(event, (handlers = new Set()));
          const callback = handler as (payload: never) => void;
          handlers.add(callback);
          return () => {
            handlers.delete(callback);
          };
        },
        onClose(handler) {
          closeHandlers.add(handler);
          return () => {
            closeHandlers.delete(handler);
          };
        },
      };
      targetAuthorizers.set(
        session,
        async (_pid, discoveryPath, _path, metadata) => {
          if (
            JSON.stringify(metadata) !==
            JSON.stringify(validatedConfig.runtimeProvider)
          ) {
            throw new Error(
              'Cached runtime metadata changed after cohort registration',
            );
          }
          ready.resolve(discoveryPath);
          const granted = await authorization.promise;
          if (
            granted.disposition === 'injection-owner' &&
            granted.discoveryPath !== discoveryPath
          ) {
            // A resumed intent keeps its original pinned route. The fresh run
            // consumes exactly that route's credentials, not a new ownership path.
            await copyFile(granted.discoveryPath, discoveryPath);
          }
          return Object.assign(() => undefined, {
            disposition: granted.disposition,
            ...(granted.target ? { target: granted.target } : {}),
          });
        },
      );
      const target: OverlayBrokerNativeTargetProvider = {
        metadata: validatedConfig.runtimeProvider,
        leaseId: `cached-${createHash('sha256').update(providerIdentity).update(String(request.pid)).digest('hex')}`,
        get executablePath() {
          return executablePath;
        },
        onAttachmentError(handler) {
          attachmentErrorHandlers.add(handler);
          return () => {
            attachmentErrorHandlers.delete(handler);
          };
        },
        prepare() {
          if (!started && !closed) {
            started = true;
            void (async () => {
              const identity = resolveOverlayBrokerProcessIdentity(
                request.pid,
                validatedConfig.addonManagerPath,
              );
              preparedIdentity = identity;
              preparedIdentities.set(request.pid, identity);
              executablePath = (await identity).executablePath;
              if (closed) return;
              await attachReShadeOverlay(launcher, session, {
                pid: request.pid,
                processName: win32.basename(executablePath),
                executablePath,
              });
            })().catch((error) => {
              ready.reject(error);
              if (!closed && grantedInjection) {
                for (const handler of attachmentErrorHandlers) handler(error);
              }
              report(error);
            });
          }
          return ready.promise;
        },
        receive(message) {
          if (closed) return;
          if (message.type === 'broker.target.authorized') {
            grantedInjection = message.disposition === 'injection-owner';
            authorization.resolve(message);
          } else if (message.type === 'broker.error') {
            authorization.reject(new Error(message.message));
            ready.reject(new Error(message.message));
          } else if (message.type === 'game.process') {
            emit('targetConnected', {
              pid: message.pid,
              executablePath: message.path,
            });
          } else if (message.type === 'game.process.transport-lost') {
            emit('targetTransportLost', { pid: message.pid });
          } else if (message.type === 'game.process.disconnected') {
            launcher.confirmTargetExited(request.pid);
            emit('targetDisconnected', {
              pid: message.pid,
              executablePath: message.path,
            });
          }
        },
        dispose() {
          if (closed) return;
          closed = true;
          if (preparedIdentities.get(request.pid) === preparedIdentity)
            preparedIdentities.delete(request.pid);
          const error = new Error('Cached native provider session closed');
          ready.reject(error);
          authorization.reject(error);
          for (const handler of closeHandlers) handler();
          launcher.dispose();
          events.clear();
          closeHandlers.clear();
          attachmentErrorHandlers.clear();
          targetAuthorizers.delete(session);
          targets.delete(target);
        },
      };
      targets.add(target);
      return target;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      spare?.dispose();
      spare = undefined;
      for (const target of [...targets]) target.dispose();
    },
  };
}
