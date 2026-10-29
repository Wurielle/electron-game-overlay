import type {
  NativeRuntimeProviderMetadata,
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
) => Promise<Disposable | OverlaySessionTargetAuthorization>;
type GlobalTargetAuthorizer = () => Promise<Disposable>;

/** @internal */
export const targetAuthorizers = new WeakMap<object, TargetAuthorizer>();
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
    ),
  );
}

/** @internal */
export async function authorizeOverlaySessionGlobalTarget(
  session: ReShadeAttachmentSession,
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
  return authorizeTarget();
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
      enriched.disposition === 'joined-existing'
        ? 'joined-existing'
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
