export { ElectronGameOverlay } from './electron-game-overlay.js';
export { inspectOverlayConsumerExecutionContext, launchUnelevatedOverlayConsumer,
  type OverlayConsumerExecutionContext, type OverlayConsumerContextOptions,
  type OverlayConsumerRelaunchOptions, type OverlayConsumerRelaunchResult } from './overlay-consumer-context.js';
export {
  defaultOverlayAddonStorageRoot,
  registerOverlayAddonInstallation,
  unregisterOverlayAddonInstallation,
  type OverlayAddonInstallation,
  type OverlayAddonInstallationOptions,
  type OverlayAddonPreloadOptions,
  type OverlayAddonUninstallationOptions,
} from './overlay-addon-preload.js';
export { observeOverlayProcesses, type OverlayProcessObserverOptions, type OverlayProcessIdentity } from './process-observer.js';
export type { ElectronGameOverlayOptions } from './electron-game-overlay.js';
export { ElectronOverlayWindow } from './electron-overlay-window.js';
export { OverlaySession } from './overlay-session.js';
export {
  ReShadeOperationError,
  ReShadeOverlayLauncher,
  defaultReShadeRunsRootDirectory,
  defaultReShadeRuntimeDirectory,
  isReShadeOperationError,
  parseReShadeLaunchConfig,
  createReShadeLaunchConfig,
  clearOldReShadeRuntimeCache,
  inspectReShadeRuntimeStorage,
  pruneReShadeRuntimeStorage,
} from './reshade-launcher.js';
export type {
  ReShadeAttachResult,
  ReShadeAttachmentState,
  ReShadeDiagnostic,
  ReShadeDiagnosticCode,
  ReShadeDiagnosticEvidence,
  ReShadeDiagnosticStage,
  ReShadeLaunchConfig,
  ReShadeLaunchConfigOptions,
  ReShadeLaunchResult,
  ReShadeLauncherEvent,
  ReShadeLauncherEventHandler,
  ReShadePathTarget,
  ReShadeProcessTarget,
  ReShadeRetrySafety,
  ReShadeRuntimeMode,
  ReShadeRuntimeStartupCode,
  ReShadeTarget,
  ReShadeRuntimeStorageEntry,
  ReShadeRuntimeStorageReport,
} from './reshade-launcher.js';
export type {
  AttachElectronOverlayWindowOptions,
  CreateElectronOverlayWindowOptions,
  Disposable,
  ElectronOverlayWindowFollowTargetOptions,
  OverlayDiagnostic,
  OverlayDiagnosticCode,
  OverlayDiagnosticContextValue,
  OverlayDiagnosticSeverity,
  OverlayDiagnosticSource,
  OverlayGraphicsApi,
  OverlayGraphicsFps,
  OverlayInputCapability,
  OverlayInputCapabilitySupport,
  OverlaySessionEventHandler,
  OverlaySessionEventMap,
  OverlaySessionEventName,
  OverlayTargetDpi,
  OverlayTargetFollowArea,
  OverlayTargetInputCapabilities,
  OverlayTargetInputCapabilityRejection,
  OverlayTargetMonitor,
  OverlayTargetRect,
  OverlayTargetSize,
  OverlayTargetSurface,
  OverlayTargetSurfaceRemoved,
  Rect,
} from './types.js';

export { OverlayTargetWatcher, type OverlayEarlyTarget, type OverlayTargetPolicy, type OverlayManagedTarget, type OverlayTargetWatcherEvent, type OverlayTargetWatcherOptions } from './overlay-target-watcher.js';

export {createOverlayProcessPolicy, overlayProcessPolicyAllows, type OverlayProcessPolicy} from './process-policy.js';
