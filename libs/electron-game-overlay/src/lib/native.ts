import { OverlayLoopbackTransport } from './overlay-loopback-transport.js';
import type { NativeInputMessage } from './input-translation.js';
import type { Disposable } from './types.js';

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

export interface NativeOverlay {
  start(): void;
  whenReady(): Promise<unknown>;
  authorizeTarget?(
    pid: number,
    discoveryPath: string,
    expectedExecutablePath?: string,
  ): Promise<Disposable>;
  stop(): void;
  setDiagnosticCallback?(callback: (diagnostic: unknown) => void): void;
  setEventCallback(callback: (event: string, ...args: any[]) => void): void;
  setInputIntercept(intercept: boolean): void;
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

export function createNativeOverlay(): NativeOverlay {
  return new OverlayLoopbackTransport();
}
