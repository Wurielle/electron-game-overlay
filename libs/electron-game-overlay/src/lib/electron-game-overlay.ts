import {
  createProcessInjectionUnavailableError,
  loadNativeOverlay,
  type NativeOverlay,
  type NativeWindow,
} from './native.js';
import { OverlaySession } from './overlay-session.js';

export class ElectronGameOverlay {
  private readonly nativeOverlay: NativeOverlay;
  private readonly sessions = new Set<OverlaySession>();

  constructor() {
    this.nativeOverlay = loadNativeOverlay();
  }

  public createSession() {
    const session = new OverlaySession(this.nativeOverlay);
    session.onClose(() => {
      this.sessions.delete(session);
    });
    this.sessions.add(session);
    return session;
  }

  /** @deprecated Injected-runtime discovery and launch are application-owned. */
  public findWindows(includeMinimized = false): NativeWindow[] {
    void includeMinimized;
    throw createProcessInjectionUnavailableError();
  }

  public dispose() {
    for (const session of Array.from(this.sessions)) {
      session.close();
    }
    this.sessions.clear();
  }
}
