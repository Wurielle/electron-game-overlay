import { createNativeOverlay, type NativeOverlay } from './native.js';
import { OverlaySession } from './overlay-session.js';

export class ElectronGameOverlay {
  private readonly nativeOverlay: NativeOverlay;
  private activeSession: OverlaySession | undefined;
  private disposed = false;

  constructor() {
    this.nativeOverlay = createNativeOverlay();
  }

  public createSession() {
    if (this.disposed) {
      throw new Error('this ElectronGameOverlay is disposed');
    }
    if (this.activeSession) {
      throw new Error(
        'this ElectronGameOverlay already has an active overlay session',
      );
    }

    const session = new OverlaySession(this.nativeOverlay);
    this.activeSession = session;
    session.onClose(() => {
      if (this.activeSession === session) {
        this.activeSession = undefined;
      }
    });
    return session;
  }

  public dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.activeSession?.close();
    this.activeSession = undefined;
  }
}
