import type {
  NativeRuntimeProviderMetadata,
  NativeMemoryRoute,
  NativeMemoryTarget,
  NativeTargetAuthorization,
  NativeTargetAuthorizationDisposition,
  NativeTargetConnection,
} from './native.js';
import type {
  Disposable,
  OverlaySessionEventHandler,
  OverlaySessionEventName,
} from './types.js';

/** Pure-Node lifecycle surface consumed by the shared attachment engine. @internal */
export interface ReShadeAttachmentSession {
  whenReady(): Promise<unknown>;
  on<E extends OverlaySessionEventName>(
    event: E,
    handler: OverlaySessionEventHandler<E>,
  ): Disposable;
  onClose(handler: () => void): Disposable;
}

/** @internal */
export type OverlaySessionTargetAuthorization = Disposable &
  Readonly<{
    disposition: NativeTargetAuthorizationDisposition;
    expectedCreationTime100ns?: string;
    target?: NativeTargetConnection;
  }>;

type TargetAuthorizer = (
  pid: number,
  discoveryPath: string,
  expectedExecutablePath?: string,
  runtimeProvider?: NativeRuntimeProviderMetadata,
  signal?: AbortSignal,
  expectedCreationTime100ns?: string,
) => Promise<Disposable | OverlaySessionTargetAuthorization>;
type GlobalTargetAuthorizer = (discoveryPath?: string) => Promise<Disposable>;

/** @internal */
export const targetAuthorizers = new WeakMap<object, TargetAuthorizer>();
/** @internal File-free target authorization for the cache-backed native lane. */
export const memoryTargetAuthorizers = new WeakMap<object, (target: NativeMemoryTarget, signal: AbortSignal) => Promise<NativeMemoryRoute>>();
/** @internal Keeps host identity queries outside the Electron-free transport. */
export const targetIdentityRequirements = new WeakMap<object, boolean>();
/** @internal */
export function overlaySessionRequiresTargetIdentity(session: ReShadeAttachmentSession): boolean {
  return targetIdentityRequirements.get(session) === true;
}
/** @internal */
export const globalTargetAuthorizers = new WeakMap<
  object,
  GlobalTargetAuthorizer
>();

/** @internal */
export async function authorizeOverlaySessionTarget(
  session: ReShadeAttachmentSession,
  pid: number,
  discoveryPath: string,
  expectedExecutablePath?: string,
  runtimeProvider?: NativeRuntimeProviderMetadata,
  signal?: AbortSignal,
  expectedCreationTime100ns?: string,
): Promise<OverlaySessionTargetAuthorization> {
  const testHarness = session as unknown as {
    authorizeTarget?: TargetAuthorizer;
  };
  const authorizeTarget =
    targetAuthorizers.get(session) ??
    (typeof testHarness.authorizeTarget === 'function'
      ? testHarness.authorizeTarget.bind(session)
      : undefined);
  if (!authorizeTarget) {
    throw new TypeError('invalid OverlaySession instance');
  }
  return normalizeSessionTargetAuthorization(
    await authorizeTarget(
      pid,
      discoveryPath,
      expectedExecutablePath,
      runtimeProvider,
      signal,
      expectedCreationTime100ns,
    ),
  );
}

/** @internal */
export async function authorizeOverlaySessionGlobalTarget(
  session: ReShadeAttachmentSession,
  discoveryPath?: string,
): Promise<Disposable> {
  const testHarness = session as unknown as {
    authorizeGlobalTarget?: GlobalTargetAuthorizer;
  };
  const authorizeTarget =
    globalTargetAuthorizers.get(session) ??
    (typeof testHarness.authorizeGlobalTarget === 'function'
      ? testHarness.authorizeGlobalTarget.bind(session)
      : undefined);
  if (!authorizeTarget) {
    throw new TypeError('invalid OverlaySession instance');
  }
  return authorizeTarget(discoveryPath);
}

/** @internal */
export function createSessionTargetAuthorization(
  release: Disposable,
  disposition: NativeTargetAuthorizationDisposition,
  target?: NativeTargetConnection,
  expectedCreationTime100ns?: string,
): OverlaySessionTargetAuthorization {
  return Object.assign(release, {
    disposition,
    ...(expectedCreationTime100ns === undefined ? {} : { expectedCreationTime100ns }),
    ...(target === undefined ? {} : { target }),
  });
}

/** @internal */
export function normalizeSessionTargetAuthorization(
  authorization: Disposable | NativeTargetAuthorization,
): OverlaySessionTargetAuthorization {
  if (typeof authorization === 'function') {
    const enriched =
      authorization as Partial<OverlaySessionTargetAuthorization>;
    return createSessionTargetAuthorization(
      authorization,
      enriched.disposition === 'joined-existing' || enriched.disposition === 'participant'
        ? enriched.disposition
        : 'injection-owner',
      enriched.target,
      enriched.expectedCreationTime100ns,
    );
  }
  return createSessionTargetAuthorization(
    authorization.release,
    authorization.disposition,
    authorization.target,
    authorization.expectedCreationTime100ns,
  );
}


/** @internal Managed policy gate; never an ownership/exit claim. */
export const targetPolicyGates = new WeakMap<object,(pid:number,suppressed:boolean)=>void>();
/** @internal */
export function setOverlaySessionTargetSuppressed(session:object,pid:number,suppressed:boolean):void {
  targetPolicyGates.get(session)?.(pid,suppressed);
}

/** @internal */
export const targetAdmissionGates = new WeakMap<object,(policy:(pid:number,path:string,creationTime100ns?:string)=>boolean)=>void>();
/** @internal */
export function setOverlaySessionTargetAdmission(session:object,policy:(pid:number,path:string,creationTime100ns?:string)=>boolean):void {targetAdmissionGates.get(session)?.(policy);}
