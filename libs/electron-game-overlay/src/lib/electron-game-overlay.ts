import { createNativeOverlay, type NativeOverlay } from './native.js';
import { createOverlaySession, OverlaySession } from './overlay-session.js';
import type { OverlayInputCapability } from './types.js';

/**
 * Application-level overlay options.
 * @example
 * ```ts
 * import { ElectronGameOverlay, type ElectronGameOverlayOptions } from 'electron-game-overlay';
 * const options: ElectronGameOverlayOptions = { allowPrereleaseBroker: true };
 * const overlay = new ElectronGameOverlay(options);
 * ```
 */
export interface ElectronGameOverlayOptions {
  /** @deprecated Retained as a no-op; each application now supplies its own engine. */
  allowPrereleaseBroker?: boolean;
  /**
   * Immutable host input requirements, checked before any target receives this
   * application's scene or interception request. Unknown support also rejects.
   */
  requiredInputCapabilities?: readonly OverlayInputCapability[];
}

/**
 * Top-level owner of the Electron overlay backend.
 *
 * An instance can own one live {@link OverlaySession} at a time. Close that
 * session before creating another, and dispose the owner when the application
 * no longer needs overlay support.
 */
export class ElectronGameOverlay {
  private readonly nativeOverlay: NativeOverlay;
  private activeSession: OverlaySession | undefined;
  private disposed = false;

  /**
   * Creates an overlay owner; transport startup remains session-lazy.
   * @param options - Application overlay options.
   * @example
   * ```ts
   * const overlay = new ElectronGameOverlay({ allowPrereleaseBroker: true });
   * ```
   */
  constructor(options: ElectronGameOverlayOptions = {}) {
    this.nativeOverlay = createNativeOverlay(
      options.allowPrereleaseBroker === true,
      { requiredInputCapabilities: options.requiredInputCapabilities },
    );
  }

  /** Creates a session without starting its transport until it is first used. */
  public createSession() {
    if (this.disposed) {
      throw new Error('this ElectronGameOverlay is disposed');
    }
    if (this.activeSession) {
      throw new Error(
        'this ElectronGameOverlay already has an active overlay session',
      );
    }

    const session = createOverlaySession(this.nativeOverlay);
    this.activeSession = session;
    session.onClose(() => {
      if (this.activeSession === session) {
        this.activeSession = undefined;
      }
    });
    return session;
  }

  /**
   * Permanently disposes this owner and closes its active session, if any.
   * Repeated calls have no effect.
   */
  public dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.activeSession?.close();
    this.activeSession = undefined;
  }
}
