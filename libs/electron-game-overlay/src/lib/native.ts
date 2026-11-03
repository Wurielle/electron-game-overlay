import { CooperativeOverlayTransport } from './cooperative-overlay-transport.js';
import type { NativeInputMessage } from './input-translation.js';
import type { Disposable, OverlayInputCapability } from './types.js';

export interface NativeRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeWindowCaption {
  left: number;
  right: number;
  top: number;
  height: number;
}

export interface NativeOverlayWindowDetails {
  name: string;
  transparent: boolean;
  rect: NativeRectangle;
  caption?: NativeWindowCaption;
  scaleFactorMicros?: number;
}

export interface NativeOverlayWindowGeometry {
  rect: NativeRectangle;
  caption?: NativeWindowCaption;
  scaleFactorMicros?: number;
  rasterChanged?: boolean;
}

export type NativeTargetAuthorizationDisposition =
  'injection-owner' | 'joined-existing' | 'participant';

export type NativeTargetConnection = Readonly<{
  pid: number;
  executablePath: string;
  /** The broker-owned rendezvous used by the runtime already in this target. */
  discoveryPath?: string;
}>;

export type NativeTargetAuthorization = Readonly<{
  release: Disposable;
  disposition: NativeTargetAuthorizationDisposition;
  /** Exact broker-pinned process creation FILETIME for an injection owner. */
  expectedCreationTime100ns?: string;
  target?: NativeTargetConnection;
}>;

/** Metadata for the exact runtime artifacts offered by one target lease. */
export type NativeRuntimeProviderMetadata = Readonly<{
  runtimeGeneration: number;
  targetTransportMin: number;
  targetTransportMax: number;
}>;

export interface NativeOverlay {
  /** @internal Private members require an exact OS incarnation before route publication. */
  readonly requiresProcessInstanceIdentity?: boolean;
  start(): void;
  whenReady(): Promise<unknown>;
  authorizeTarget?(
    pid: number,
    discoveryPath: string,
    expectedExecutablePath?: string,
    runtimeProvider?: NativeRuntimeProviderMetadata,
    signal?: AbortSignal,
    expectedCreationTime100ns?: string,
  ): Promise<Disposable | NativeTargetAuthorization>;
  /** @internal Legacy untargeted rendezvous for pre-creation name/path watchers. */
  authorizeGlobalTarget?(discoveryPath?: string): Promise<Disposable>;
  /** Application-local policy gate; does not establish process exit or injection permission. */
  setTargetSuppressed?(pid:number,suppressed:boolean):void;
  /** Local managed-attachment admission; never changes broker ownership. */
  setTargetAdmissionPolicy?(policy:(pid:number,path:string,creationTime100ns?:string)=>boolean):void;
  stop(): void;
  setDiagnosticCallback?(callback: (diagnostic: unknown) => void): void;
  setEventCallback(callback: (event: string, ...args: any[]) => void): void;
  setInputIntercept(intercept: boolean): void;
  setWindowCursor?(windowId: number, cursor: number): void;
  setWindowFocus?(windowId: number, focused: boolean): void;
  addWindow(windowId: number, details: NativeOverlayWindowDetails): void;
  closeWindow(windowId: number): void;
  sendWindowBounds(
    windowId: number,
    details: NativeOverlayWindowGeometry,
  ): void;
  sendFrameBuffer(
    windowId: number,
    buffer: Buffer,
    width: number,
    height: number,
  ): boolean | void;
  translateInputEvent(event: NativeInputMessage): any;
}

export function createNativeOverlay(
  _allowPrereleaseBroker = false,
  options: Readonly<{ requiredInputCapabilities?: readonly OverlayInputCapability[] }> = {},
): NativeOverlay {
  return new CooperativeOverlayTransport(options);
}
