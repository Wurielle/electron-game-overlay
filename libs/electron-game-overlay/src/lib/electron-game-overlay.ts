import { createNativeOverlay, type NativeOverlay } from './native.js';
import { createOverlaySession, OverlaySession } from './overlay-session.js';
import type { OverlayInputCapability } from './types.js';
import { normalizeRequiredInputCapabilities } from './input-capabilities.js';

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
  private nativeOverlay: NativeOverlay;
  private readonly backendOptions: Readonly<ElectronGameOverlayOptions>;
  private hasCreatedSession = false;
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
    this.backendOptions = Object.freeze({
      allowPrereleaseBroker: options.allowPrereleaseBroker === true,
      requiredInputCapabilities: normalizeRequiredInputCapabilities(options.requiredInputCapabilities),
    });
    this.nativeOverlay = this.createBackend();
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

    // A closed session may have published a durable route into a live target.
    // Preserve that consumed route and give the next session its own namespace.
    if (this.hasCreatedSession) this.nativeOverlay = this.createBackend();
    const session = createOverlaySession(this.nativeOverlay);
    this.hasCreatedSession = true;
    this.activeSession = session;
    session.onClose(() => {
      if (this.activeSession === session) {
        this.activeSession = undefined;
      }
    });
    return session;
  }

  private createBackend(): NativeOverlay {
    return createNativeOverlay(this.backendOptions.allowPrereleaseBroker === true, {
      requiredInputCapabilities: this.backendOptions.requiredInputCapabilities,
    });
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
