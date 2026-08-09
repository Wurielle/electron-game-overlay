import { createNativeOverlay, type NativeOverlay } from './native.js';
import { createOverlaySession, OverlaySession } from './overlay-session.js';

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

  /** Creates an overlay owner; transport startup remains session-lazy. */
  constructor() {
    this.nativeOverlay = createNativeOverlay();
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
