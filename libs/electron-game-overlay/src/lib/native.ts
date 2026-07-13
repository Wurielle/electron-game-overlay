import { OverlayLoopbackTransport } from './overlay-loopback-transport.js';
import type { NativeInputMessage } from './input-translation.js';

export interface NativeHotkey {
  name: string;
  keyCode: number;
  modifiers?: {
    alt?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
  };
  passthrough?: boolean;
}

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
  resizable: boolean;
  maxWidth: number;
  maxHeight: number;
  minWidth: number;
  minHeight: number;
  rect: NativeRectangle;
  nativeHandle: number;
  dragBorderWidth?: number;
  caption?: NativeWindowCaption;
  scaleFactorMicros?: number;
}

export interface NativeOverlayWindowGeometry {
  rect: NativeRectangle;
  maxWidth?: number;
  maxHeight?: number;
  minWidth?: number;
  minHeight?: number;
  dragBorderWidth?: number;
  caption?: NativeWindowCaption;
  scaleFactorMicros?: number;
  rasterChanged?: boolean;
}

export interface NativeWindow {
  windowId: number;
  processId: number;
  threadId?: number;
  title?: string;
}

export type NativeOverlayCommand =
  | { command: 'cursor'; cursor: string }
  | {
      command: 'fps';
      showfps: boolean;
      position: 'TopLeft' | 'TopRight' | 'BottomLeft' | 'BottomRight';
    }
  | { command: 'input.intercept'; intercept: boolean };

export interface NativeOverlay {
  start(): void;
  whenReady(): Promise<unknown>;
  stop(): void;
  setEventCallback(callback: (event: string, ...args: any[]) => void): void;
  setHotkeys(hotkeys: NativeHotkey[]): void;
  sendCommand(command: NativeOverlayCommand): void;
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
  ): void;
  translateInputEvent(event: NativeInputMessage): any;
}

const PROCESS_INJECTION_UNAVAILABLE_MESSAGE =
  'Process discovery and DLL injection are unavailable in the overlay transport. Configure and invoke a backend-specific launcher for the target.';

export function createProcessInjectionUnavailableError(): Error {
  return new Error(PROCESS_INJECTION_UNAVAILABLE_MESSAGE);
}

let singleton: NativeOverlay | undefined;

export function loadNativeOverlay(): NativeOverlay {
  singleton ??= new OverlayLoopbackTransport();
  return singleton;
}
