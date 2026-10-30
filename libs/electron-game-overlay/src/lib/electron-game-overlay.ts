import { createNativeOverlay, type NativeOverlay } from './native.js';
import { createOverlaySession, OverlaySession } from './overlay-session.js';

/**
 * Application-level broker startup policy. Existing compatible owners always win.
 * @example
 * ```ts
 * import { ElectronGameOverlay, type ElectronGameOverlayOptions } from 'electron-game-overlay';
 * const options: ElectronGameOverlayOptions = { allowPrereleaseBroker: true };
 * const overlay = new ElectronGameOverlay(options);
 * ```
 */
export interface ElectronGameOverlayOptions {
  /** Permit prerelease candidates during startup selection; false by default. */
  allowPrereleaseBroker?: boolean;
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
   * @param options - Explicit preview-broker opt-in; omitted for stable selection.
   * @example
   * ```ts
   * const overlay = new ElectronGameOverlay({ allowPrereleaseBroker: true });
   * ```
   */
  constructor(options: ElectronGameOverlayOptions = {}) {
    this.nativeOverlay = createNativeOverlay(
      options.allowPrereleaseBroker === true,
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
