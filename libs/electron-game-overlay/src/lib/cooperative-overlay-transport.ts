import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  OverlayLoopbackTransport,
  OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME,
  type OverlayLoopbackTransportOptions,
  type OverlayTargetRouteAuthorizationContext,
} from './overlay-loopback-transport.js';
import type { NativeRuntimeProviderMetadata } from './native.js';

/** @internal App-owned data-plane settings, independent of host injection. */
export interface CooperativeOverlayTransportOptions extends Omit<
  OverlayLoopbackTransportOptions,
  'discoveryPath' | 'privateTargetRouteDirectory'
> {
  /** An existing participant may reopen its own retained route namespace. */
  directory?: string;
}

/**
 * @internal One application's private native-addon transport. All scene, frame,
 * input, cursor, focus and telemetry behavior is the ordinary target transport;
 * only its discovery and route-claim namespace is private to this participant.
 * Authorization here is not authority to initialize a second ReShade runtime.
 */
export class CooperativeOverlayTransport extends OverlayLoopbackTransport {
  public readonly requiresProcessInstanceIdentity = true;
  public readonly directory: string;

  constructor(options: CooperativeOverlayTransportOptions = {}) {
    const directory =
      options.directory ??
      join(
        tmpdir(),
        'electron-game-overlay',
        'participants',
        `${process.pid}-${randomBytes(16).toString('hex')}`,
      );
    if (!isAbsolute(directory) || directory.includes('\0')) {
      throw new TypeError(
        'Cooperative participant directory must be absolute without NUL characters',
      );
    }
    const resolvedDirectory = resolve(directory);
    const { directory: _directory, ...transportOptions } = options;
    super({
      ...transportOptions,
      discoveryPath: join(
        resolvedDirectory,
        'global',
        OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME,
      ),
      privateTargetRouteDirectory: join(resolvedDirectory, 'targets'),
    });
    this.directory = resolvedDirectory;
  }

  public override async authorizeTarget(
    pid: number,
    discoveryPath: string,
    expectedExecutablePath?: string,
    runtimeProviderOrRouteContext?:
      NativeRuntimeProviderMetadata | OverlayTargetRouteAuthorizationContext,
    signal?: AbortSignal,
    expectedCreationTime100ns?: string,
  ): Promise<
    (() => void) & {
      disposition: 'participant';
      expectedCreationTime100ns?: string;
    }
  > {
    signal?.throwIfAborted();
    const pinnedCreationTime =
      expectedCreationTime100ns ??
      (runtimeProviderOrRouteContext !== undefined &&
      'creationTime100ns' in runtimeProviderOrRouteContext
        ? runtimeProviderOrRouteContext.creationTime100ns
        : undefined);
    const context =
      pinnedCreationTime === undefined
        ? runtimeProviderOrRouteContext
        : {
            ...runtimeProviderOrRouteContext,
            creationTime100ns: pinnedCreationTime,
          };
    const release = await super.authorizeTarget(
      pid,
      discoveryPath,
      expectedExecutablePath,
      context,
    );
    if (signal?.aborted) {
      release();
      signal.throwIfAborted();
    }
    return Object.assign(release, {
      disposition: 'participant' as const,
      ...(pinnedCreationTime === undefined
        ? {}
        : { expectedCreationTime100ns: pinnedCreationTime }),
    });
  }
}
