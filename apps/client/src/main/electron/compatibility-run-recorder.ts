import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  OverlayDiagnostic,
  OverlayGraphicsFps,
  OverlayTargetSurface,
  OverlayTargetSurfaceRemoved,
  ReShadeDiagnostic,
  ReShadeLauncherEvent,
} from 'electron-game-overlay';

const SCHEMA_VERSION = 1;
const MAX_EVENT_COUNT = 50_000;
const MAX_EVENT_BYTES = 10 * 1024 * 1024;
const MAX_RETAINED_COMPLETED_RUNS = 32;
const MAX_COMPLETED_RUN_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_COMPLETED_RUN_BYTES = 100 * 1024 * 1024;

export type CompatibilityRunMode =
  | 'steam-auto-attach'
  | 'automatic-target'
  | 'manual';

export type CompatibilityAutoAttachTarget = Readonly<{
  pid: number;
  processName: string;
  filepath: string;
  phase: 'attaching' | 'connected' | 'failed';
  error: string | null;
  diagnostic: ReShadeDiagnostic | null;
}>;

export type CompatibilityAutoAttachState = Readonly<{
  watcherStatus: 'starting' | 'running' | 'failed' | 'stopped';
  watcherError: string | null;
  targets: readonly CompatibilityAutoAttachTarget[];
}>;

export type CompatibilityAttachmentState = Readonly<{
  phase: 'idle' | 'attaching' | 'connected';
  processName: string | null;
  pid: number | null;
  error: string | null;
  diagnostic: ReShadeDiagnostic | null;
}>;

export type CompatibilityRunRecorderOptions = Readonly<{
  rootDirectory: string;
  mode: CompatibilityRunMode;
  appVersion?: string;
  electronVersion?: string;
  clientPid?: number;
  platform?: string;
  architecture?: string;
  now?: () => Date;
  runId?: string;
  onError?: (error: Error) => void;
}>;

export function resolveCompatibilityRunsRoot(
  configuredRoot: string | undefined,
  defaultRoot: string,
): string {
  const requestedRoot = configuredRoot?.trim() || defaultRoot;
  if (!path.isAbsolute(requestedRoot)) {
    throw new Error('compatibility evidence root must be absolute');
  }
  return path.resolve(requestedRoot);
}

type JsonObject = Record<string, unknown>;

type MutableFpsSummary = {
  samples: number;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
  latest: number | null;
  total: number;
};

type MutableTargetSummary = {
  targetId: string;
  pid: number;
  processName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  terminalState: 'active' | 'released';
  releaseReason: string | null;
  attachmentPhase: 'observed' | 'attaching' | 'connected' | 'failed';
  connectionCount: number;
  transportLossCount: number;
  failureCount: number;
  recoveredAfterFailure: boolean;
  surfaceObserved: boolean;
  sceneRendered: boolean;
  surfaceTransitions: number;
  graphicsApis: Set<string>;
  renderSizes: Set<string>;
  fullscreenStates: Set<boolean>;
  runtimeModes: Set<string>;
  diagnosticCounts: Map<string, number>;
  inputInterceptAcknowledged: number;
  inputReleaseAcknowledged: number;
  focusObservations: number;
  fps: MutableFpsSummary;
  latestSurface: JsonObject | null;
  transportConnected: boolean;
};

type RecorderMetadata = Readonly<{
  clientPid: number;
  mode: CompatibilityRunMode;
  appVersion: string | null;
  electronVersion: string | null;
  platform: string;
  architecture: string;
}>;

/**
 * Demo-only, privacy-bounded evidence for one Electron client invocation.
 * It intentionally records observations rather than declaring compatibility.
 */
export class CompatibilityRunRecorder {
  public readonly runId: string;
  public readonly eventsPath: string;
  public readonly summaryPath: string;

  private readonly now: () => Date;
  private readonly onError?: (error: Error) => void;
  private readonly metadata: RecorderMetadata;
  private readonly startedAt: string;
  private readonly startedAtMs: number;
  private readonly targets: MutableTargetSummary[] = [];
  private readonly activeTargets = new Map<number, MutableTargetSummary>();
  private readonly lastTargetsByPid = new Map<number, MutableTargetSummary>();
  private readonly autoAttachFingerprints = new Map<number, string>();
  private readonly surfaceReferences = new Map<string, string>();
  private readonly attemptReferences = new Map<string, string>();
  private readonly diagnosticCounts = new Map<string, number>();
  private eventSequence = 0;
  private writtenEventCount = 0;
  private writtenEventBytes = 0;
  private nextTargetNumber = 1;
  private nextSurfaceNumber = 1;
  private nextAttemptNumber = 1;
  private descriptor: number | null = null;
  private watcherStatus: string | null = null;
  private watcherFailed = false;
  private inputRequested: boolean | null = null;
  private inputEffective: boolean | null = null;
  private inputRequestChanges = 0;
  private inputEffectiveChanges = 0;
  private endedAt: string | null = null;
  private recorderClosedOrderly = false;
  private truncated = false;
  private closed = false;
  private failed = false;
  private errorReported = false;

  constructor(options: CompatibilityRunRecorderOptions) {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw new Error('compatibility evidence root must be absolute');
    }

    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
    const clientPid = options.clientPid ?? process.pid;
    const started = this.now();
    if (!Number.isFinite(started.getTime())) {
      throw new Error('compatibility recorder clock returned an invalid date');
    }
    this.startedAt = started.toISOString();
    this.startedAtMs = started.getTime();
    this.runId = options.runId ?? createRunId(started, clientPid);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(this.runId)) {
      throw new Error('compatibility run ID contains unsupported characters');
    }
    this.metadata = Object.freeze({
      clientPid,
      mode: options.mode,
      appVersion: boundedOptionalString(options.appVersion, 80),
      electronVersion: boundedOptionalString(options.electronVersion, 80),
      platform: boundedString(options.platform ?? process.platform, 40),
      architecture: boundedString(options.architecture ?? process.arch, 40),
    });

    mkdirSync(options.rootDirectory, { recursive: true });
    this.eventsPath = path.join(
      options.rootDirectory,
      `${this.runId}.events.jsonl`,
    );
    this.summaryPath = path.join(
      options.rootDirectory,
      `${this.runId}.summary.json`,
    );

    let eventsCreated = false;
    let summaryCreated = false;
    try {
      this.descriptor = openSync(this.eventsPath, 'wx');
      eventsCreated = true;
      const summaryDescriptor = openSync(this.summaryPath, 'wx');
      closeSync(summaryDescriptor);
      summaryCreated = true;
      this.writeEventOrThrow(
        'run.started',
        {
          clientPid: this.metadata.clientPid,
          mode: this.metadata.mode,
          appVersion: this.metadata.appVersion,
          electronVersion: this.metadata.electronVersion,
          platform: this.metadata.platform,
          architecture: this.metadata.architecture,
        },
        started,
      );
      writeFileSync(this.summaryPath, this.serializeSummary(), {
        encoding: 'utf8',
        flag: 'w',
      });
      pruneCompletedCompatibilityRuns(
        options.rootDirectory,
        this.runId,
        started.getTime(),
      );
    } catch (error) {
      if (this.descriptor !== null) {
        try {
          closeSync(this.descriptor);
        } catch {
          // The original initialization error remains authoritative.
        }
        this.descriptor = null;
      }
      if (eventsCreated) {
        rmSync(this.eventsPath, { force: true });
      }
      if (summaryCreated) {
        rmSync(this.summaryPath, { force: true });
      }
      throw toError(error);
    }
  }

  public recordLauncherEvent(event: ReShadeLauncherEvent): void {
    switch (event.type) {
      case 'runtime-staged':
        this.record('attachment.runtime-staged', {
          attemptId: this.attemptReferenceForDirectory(event.runDirectory),
        });
        return;
      case 'target-rendezvous-authorized': {
        const target = this.ensureTarget(
          event.pid,
          processNameFromTargetLabel(event.targetLabel),
          'launcher',
        );
        this.record(
          'attachment.rendezvous-authorized',
          {
            targetLabel: safeTargetLabel(event.targetLabel),
            attemptId: this.attemptReferenceForDirectory(
              path.dirname(event.discoveryPath),
            ),
          },
          target,
        );
        return;
      }
      case 'injector-started': {
        const pid = pidFromInvocationArguments(event.invocation.arguments);
        const target =
          pid === null
            ? null
            : this.ensureTarget(
                pid,
                processNameFromTargetLabel(event.invocation.targetLabel),
                'launcher',
              );
        this.record(
          'attachment.injector-started',
          {
            attemptId: this.attemptReferenceForDirectory(
              event.invocation.workingDirectory,
            ),
            targetLabel: safeTargetLabel(event.invocation.targetLabel),
            strategy: pid === null ? 'path' : 'exact-pid',
          },
          target,
        );
        return;
      }
      case 'injector-returned': {
        const target = this.ensureTarget(
          event.result.injectorTargetPid,
          event.result.processName,
          'launcher',
        );
        target.runtimeModes.add(event.result.runtimeMode);
        this.record(
          'attachment.injector-returned',
          {
            attemptId: this.attemptReferenceForDirectory(
              event.result.runDirectory,
            ),
            runtimeMode: event.result.runtimeMode,
          },
          target,
        );
        return;
      }
      case 'injector-failed': {
        const target = isValidPid(event.diagnostic.pid)
          ? (this.activeTargets.get(event.diagnostic.pid) ?? null)
          : null;
        if (target) {
          this.noteDiagnostic(target, event.diagnostic.code);
        }
        this.noteGlobalDiagnostic(event.diagnostic.code);
        this.record(
          'attachment.injector-failed',
          {
            ...sanitizeReShadeDiagnostic(event.diagnostic),
            attemptId: event.diagnostic.evidence
              ? this.attemptReferenceForDirectory(
                  event.diagnostic.evidence.runDirectory,
                )
              : null,
          },
          target,
          event.diagnostic.pid,
        );
        return;
      }
      case 'target-connected': {
        const processName =
          processNameFromPath(event.path) ??
          processNameFromTargetLabel(event.targetLabel);
        const target = this.ensureTarget(event.pid, processName, 'launcher');
        this.updateTargetProcessName(target, processName);
        this.noteTransportConnected(target);
        this.record(
          'target.transport-connected',
          { source: 'launcher' },
          target,
        );
        return;
      }
      case 'target-disconnected': {
        const target = this.targetForTerminalEvent(event.pid);
        this.record(
          'target.disconnected',
          { source: 'launcher' },
          target,
          event.pid,
        );
        this.releaseTarget(event.pid, 'launcher-disconnected');
      }
    }
  }

  public recordAutoAttachState(state: CompatibilityAutoAttachState): void {
    if (state.watcherStatus !== this.watcherStatus) {
      this.watcherStatus = state.watcherStatus;
      this.watcherFailed ||= state.watcherStatus === 'failed';
      this.record('watcher.status', {
        status: state.watcherStatus,
        errorPresent: state.watcherError !== null,
      });
    }

    const nextPids = new Set<number>();
    for (const snapshot of state.targets) {
      if (!isValidPid(snapshot.pid)) {
        continue;
      }
      nextPids.add(snapshot.pid);
      const fingerprint = JSON.stringify({
        processName: snapshot.processName,
        phase: snapshot.phase,
        diagnosticCode: snapshot.diagnostic?.code ?? null,
        errorPresent: snapshot.error !== null,
      });
      if (this.autoAttachFingerprints.get(snapshot.pid) === fingerprint) {
        continue;
      }
      this.autoAttachFingerprints.set(snapshot.pid, fingerprint);
      const target = this.ensureTarget(
        snapshot.pid,
        snapshot.processName || processNameFromPath(snapshot.filepath),
        'steam-watcher',
      );
      this.updateAttachmentPhase(target, snapshot.phase);
      this.record(
        'target.attachment-state',
        {
          phase: snapshot.phase,
          errorPresent: snapshot.error !== null,
          diagnostic:
            snapshot.diagnostic === null
              ? null
              : sanitizeReShadeDiagnostic(snapshot.diagnostic),
        },
        target,
      );
    }

    for (const pid of Array.from(this.autoAttachFingerprints.keys())) {
      if (nextPids.has(pid)) {
        continue;
      }
      this.autoAttachFingerprints.delete(pid);
      this.releaseTarget(pid, 'process-observer-released');
    }
  }

  public recordAttachmentState(
    state: CompatibilityAttachmentState,
    reason?: string,
  ): void {
    const targetPid = isValidPid(state.pid)
      ? state.pid
      : (reason === 'attach-failed' || reason === 'attach-indeterminate') &&
          isValidPid(state.diagnostic?.pid)
        ? state.diagnostic.pid
        : null;
    const target = isValidPid(targetPid)
      ? reason === 'target-disconnected'
        ? this.targetForTerminalEvent(targetPid)
        : this.ensureTarget(targetPid, state.processName, 'manual-attachment')
      : null;
    if (target) {
      if (reason === 'attach-failed' || reason === 'attach-indeterminate') {
        this.noteFailure(target);
        if (state.phase === 'attaching') {
          target.attachmentPhase = 'attaching';
        }
      } else if (state.phase === 'attaching' || state.phase === 'connected') {
        this.updateAttachmentPhase(target, state.phase);
      }
    }
    this.record(
      'attachment.state',
      {
        phase: state.phase,
        processName: safeProcessName(state.processName),
        reason: boundedOptionalString(reason, 80),
        errorPresent: state.error !== null,
        diagnostic:
          state.diagnostic === null
            ? null
            : sanitizeReShadeDiagnostic(state.diagnostic),
      },
      target,
      targetPid,
    );
    if (reason === 'target-disconnected' && isValidPid(state.pid)) {
      this.releaseTarget(state.pid, reason);
    }
  }

  public recordTargetSurface(surface: OverlayTargetSurface): void {
    if (!isValidPid(surface.pid)) {
      return;
    }
    const target = this.activeTargets.get(surface.pid) ?? null;
    if (target) {
      target.surfaceObserved = true;
      target.surfaceTransitions += 1;
      target.graphicsApis.add(surface.graphicsApi);
      target.renderSizes.add(
        `${surface.renderSize.width}x${surface.renderSize.height}`,
      );
      target.fullscreenStates.add(surface.fullscreen);
    }
    const surfaceReference = target
      ? this.surfaceReferenceFor(target, surface.surfaceId)
      : null;
    const snapshot = {
      surfaceId: surfaceReference,
      revision: surface.revision,
      graphicsApi: surface.graphicsApi,
      renderSize: surface.renderSize,
      clientSize: {
        width: surface.clientBounds.width,
        height: surface.clientBounds.height,
      },
      dpi: {
        x: surface.dpi.x,
        y: surface.dpi.y,
        scaleFactor: surface.dpi.scaleFactor,
      },
      focused: surface.focused,
      minimized: surface.minimized,
      visible: surface.visible,
      fullscreen: surface.fullscreen,
    };
    if (target) {
      target.latestSurface = snapshot;
    }
    this.record('target.surface', snapshot, target, surface.pid);
  }

  public recordTargetSurfaceRemoved(
    removed: OverlayTargetSurfaceRemoved,
  ): void {
    if (!isValidPid(removed.pid)) {
      return;
    }
    const target =
      this.activeTargets.get(removed.pid) ??
      this.lastTargetsByPid.get(removed.pid) ??
      null;
    const surfaceReference = target
      ? this.surfaceReferenceFor(target, removed.surfaceId)
      : null;
    this.record(
      'target.surface-removed',
      { surfaceId: surfaceReference, revision: removed.revision },
      target,
      removed.pid,
    );
  }

  public recordFps(payload: OverlayGraphicsFps): void {
    if (!isValidPid(payload.pid) || !Number.isFinite(payload.fps)) {
      return;
    }
    const target = this.activeTargets.get(payload.pid) ?? null;
    if (target) {
      const fps = target.fps;
      fps.samples += 1;
      fps.total += payload.fps;
      fps.minimum =
        fps.minimum === null ? payload.fps : Math.min(fps.minimum, payload.fps);
      fps.maximum =
        fps.maximum === null ? payload.fps : Math.max(fps.maximum, payload.fps);
      fps.mean = fps.total / fps.samples;
      fps.latest = payload.fps;
    }
    this.record('target.fps', { fps: payload.fps }, target, payload.pid);
  }

  public recordOverlayDiagnostic(diagnostic: OverlayDiagnostic): void {
    const target = isValidPid(diagnostic.pid)
      ? (this.activeTargets.get(diagnostic.pid) ?? null)
      : null;
    if (target) {
      this.noteDiagnostic(target, diagnostic.code);
      if (diagnostic.code === 'runtime-scene-rendering-started') {
        target.sceneRendered = true;
      }
    }
    this.noteGlobalDiagnostic(diagnostic.code);
    this.record(
      'overlay.diagnostic',
      {
        source: diagnostic.source,
        severity: diagnostic.severity,
        code: diagnostic.code,
        context: sanitizeOverlayDiagnosticContext(diagnostic.context),
      },
      target,
      diagnostic.pid,
    );
  }

  public recordNativeEvent(event: string, payload: unknown): void {
    if (!isRecord(payload) || !isValidPid(payload.pid)) {
      return;
    }
    const pid = payload.pid;
    if (event === 'game.process') {
      const target = this.ensureTarget(
        pid,
        typeof payload.path === 'string'
          ? processNameFromPath(payload.path)
          : null,
        'native-transport',
      );
      this.noteTransportConnected(target);
      this.record('target.transport-connected', { source: 'native' }, target);
      return;
    }
    if (event === 'game.process.transport-lost') {
      const target = this.targetForTerminalEvent(pid);
      if (target) {
        target.transportConnected = false;
        target.transportLossCount += 1;
      }
      this.record('target.transport-lost', {}, target, pid);
      return;
    }
    if (event === 'game.process.disconnected') {
      const target = this.targetForTerminalEvent(pid);
      if (target) {
        target.transportConnected = false;
      }
      this.record('target.disconnected', { source: 'native' }, target, pid);
      this.releaseTarget(pid, 'native-disconnected');
      return;
    }
    if (event === 'game.window.focused') {
      const target = this.activeTargets.get(pid);
      if (target) {
        target.focusObservations += 1;
      }
      this.record('target.window-focused', {}, target ?? null, pid);
    }
  }

  public recordInputAcknowledged(pid: number, intercepting: boolean): void {
    if (!isValidPid(pid)) {
      return;
    }
    const target = this.activeTargets.get(pid) ?? null;
    if (target) {
      if (intercepting) {
        target.inputInterceptAcknowledged += 1;
      } else {
        target.inputReleaseAcknowledged += 1;
      }
    }
    this.record('input.intercept-acknowledged', { intercepting }, target, pid);
  }

  public recordInputRequested(intercepting: boolean): void {
    if (this.inputRequested === intercepting) {
      return;
    }
    if (this.inputRequested !== null) {
      this.inputRequestChanges += 1;
    }
    this.inputRequested = intercepting;
    this.record('input.intercept-requested', { intercepting });
  }

  public recordInputEffective(intercepting: boolean): void {
    if (this.inputEffective === intercepting) {
      return;
    }
    if (this.inputEffective !== null) {
      this.inputEffectiveChanges += 1;
    }
    this.inputEffective = intercepting;
    this.record('input.intercept-effective', { intercepting });
  }

  public getSummary(): JsonObject {
    const targetSummaries = this.targets.map((target) => ({
      targetId: target.targetId,
      pid: target.pid,
      processName: target.processName,
      firstSeenAt: target.firstSeenAt,
      lastSeenAt: target.lastSeenAt,
      terminalState: target.terminalState,
      releaseReason: target.releaseReason,
      attachmentPhase: target.attachmentPhase,
      connectionCount: target.connectionCount,
      transportLossCount: target.transportLossCount,
      failureCount: target.failureCount,
      recoveredAfterFailure: target.recoveredAfterFailure,
      surfaceObserved: target.surfaceObserved,
      sceneRenderingObserved: target.sceneRendered,
      surfaceTransitions: target.surfaceTransitions,
      focusObservations: target.focusObservations,
      graphicsApis: Array.from(target.graphicsApis).sort(),
      renderSizes: Array.from(target.renderSizes).sort(),
      fullscreenStates: Array.from(target.fullscreenStates).sort(),
      runtimeModes: Array.from(target.runtimeModes).sort(),
      diagnosticCounts: sortedCountObject(target.diagnosticCounts),
      input: {
        interceptAcknowledgements: target.inputInterceptAcknowledged,
        releaseAcknowledgements: target.inputReleaseAcknowledged,
      },
      fps: {
        samples: target.fps.samples,
        minimum: target.fps.minimum,
        maximum: target.fps.maximum,
        mean: target.fps.mean,
        latest: target.fps.latest,
      },
      latestSurface: target.latestSurface,
    }));
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: this.runId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs:
        this.endedAt === null
          ? null
          : new Date(this.endedAt).getTime() - this.startedAtMs,
      recorderClosedOrderly: this.recorderClosedOrderly,
      observationalOnly: true,
      verdict: {
        automated: 'inconclusive',
        manual: 'not-recorded',
      },
      client: this.metadata,
      events: {
        recorded: this.writtenEventCount,
        truncated: this.truncated,
        diagnosticCounts: sortedCountObject(this.diagnosticCounts),
      },
      watcher: {
        finalStatus: this.watcherStatus,
        failed: this.watcherFailed,
      },
      input: {
        requested: this.inputRequested,
        effective: this.inputEffective,
        requestChanges: this.inputRequestChanges,
        effectiveChanges: this.inputEffectiveChanges,
      },
      totals: {
        targetLifetimes: targetSummaries.length,
        connected: this.targets.filter((target) => target.connectionCount > 0)
          .length,
        surfacesObserved: this.targets.filter(
          (target) => target.surfaceObserved,
        ).length,
        scenesRendered: this.targets.filter((target) => target.sceneRendered)
          .length,
        everFailed: this.targets.filter((target) => target.failureCount > 0)
          .length,
        recovered: this.targets.filter((target) => target.recoveredAfterFailure)
          .length,
        released: this.targets.filter(
          (target) => target.terminalState === 'released',
        ).length,
        incomplete: this.targets.filter(
          (target) => target.terminalState === 'active',
        ).length,
      },
      targets: targetSummaries,
    };
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.failed || this.descriptor === null) {
      return;
    }

    const ended = this.now();
    this.endedAt = Number.isFinite(ended.getTime())
      ? ended.toISOString()
      : new Date().toISOString();
    this.recorderClosedOrderly = true;
    this.recordInternal(
      'run.finished',
      { recorderClosedOrderly: true },
      ended,
      null,
      null,
      true,
    );
    if (this.failed || this.descriptor === null) {
      this.recorderClosedOrderly = false;
      return;
    }

    try {
      fsyncSync(this.descriptor);
      closeSync(this.descriptor);
      this.descriptor = null;
      this.writeSummaryAtomically();
    } catch (error) {
      this.recorderClosedOrderly = false;
      this.disable(toError(error));
    }
  }

  private record(
    type: string,
    data: JsonObject,
    target: MutableTargetSummary | null = null,
    pid?: number | null,
  ): void {
    if (this.closed || this.failed) {
      return;
    }
    this.recordInternal(type, data, this.now(), target, pid);
  }

  private recordInternal(
    type: string,
    data: JsonObject,
    at: Date,
    target: MutableTargetSummary | null = null,
    pid?: number | null,
    terminal = false,
  ): void {
    if (
      this.failed ||
      this.descriptor === null ||
      (this.truncated && !terminal)
    ) {
      return;
    }
    try {
      this.writeEventOrThrow(type, data, at, target, pid, terminal);
    } catch (error) {
      this.disable(toError(error));
    }
  }

  private writeEventOrThrow(
    type: string,
    data: JsonObject,
    at: Date,
    target: MutableTargetSummary | null = null,
    pid?: number | null,
    terminal = false,
  ): void {
    if (this.descriptor === null) {
      throw new Error('compatibility recorder event file is not open');
    }
    const atMs = at.getTime();
    const event = {
      schemaVersion: SCHEMA_VERSION,
      runId: this.runId,
      sequence: this.eventSequence + 1,
      timestamp: Number.isFinite(atMs)
        ? at.toISOString()
        : new Date().toISOString(),
      elapsedMs: Number.isFinite(atMs)
        ? Math.max(0, atMs - this.startedAtMs)
        : null,
      type,
      ...(target ? { targetId: target.targetId, pid: target.pid } : {}),
      ...(!target && isValidPid(pid) ? { pid } : {}),
      data,
    };
    let line = `${JSON.stringify(event)}\n`;
    let encodedLine = Buffer.from(line, 'utf8');
    const bytes = encodedLine.length;
    if (
      !terminal &&
      (this.writtenEventCount >= MAX_EVENT_COUNT ||
        this.writtenEventBytes + bytes > MAX_EVENT_BYTES)
    ) {
      const truncatedEvent = {
        schemaVersion: SCHEMA_VERSION,
        runId: this.runId,
        sequence: this.eventSequence + 1,
        timestamp: event.timestamp,
        elapsedMs: event.elapsedMs,
        type: 'recorder.truncated',
        data: {
          maximumEvents: MAX_EVENT_COUNT,
          maximumBytes: MAX_EVENT_BYTES,
        },
      };
      line = `${JSON.stringify(truncatedEvent)}\n`;
      encodedLine = Buffer.from(line, 'utf8');
      writeBufferCompletely(this.descriptor, encodedLine);
      this.eventSequence += 1;
      this.writtenEventCount += 1;
      this.writtenEventBytes += encodedLine.length;
      this.truncated = true;
      return;
    }
    writeBufferCompletely(this.descriptor, encodedLine);
    this.eventSequence += 1;
    this.writtenEventCount += 1;
    this.writtenEventBytes += bytes;
  }

  private ensureTarget(
    pid: number,
    processName: string | null,
    source: string,
  ): MutableTargetSummary {
    const existing = this.activeTargets.get(pid);
    if (existing) {
      existing.lastSeenAt = this.safeNowIso();
      this.updateTargetProcessName(existing, processName);
      return existing;
    }

    const at = this.safeNowIso();
    const target: MutableTargetSummary = {
      targetId: `target-${String(this.nextTargetNumber++).padStart(4, '0')}`,
      pid,
      processName: safeProcessName(processName),
      firstSeenAt: at,
      lastSeenAt: at,
      terminalState: 'active',
      releaseReason: null,
      attachmentPhase: 'observed',
      connectionCount: 0,
      transportLossCount: 0,
      failureCount: 0,
      recoveredAfterFailure: false,
      surfaceObserved: false,
      sceneRendered: false,
      surfaceTransitions: 0,
      graphicsApis: new Set(),
      renderSizes: new Set(),
      fullscreenStates: new Set(),
      runtimeModes: new Set(),
      diagnosticCounts: new Map(),
      inputInterceptAcknowledged: 0,
      inputReleaseAcknowledged: 0,
      focusObservations: 0,
      fps: {
        samples: 0,
        minimum: null,
        maximum: null,
        mean: null,
        latest: null,
        total: 0,
      },
      latestSurface: null,
      transportConnected: false,
    };
    this.targets.push(target);
    this.activeTargets.set(pid, target);
    this.lastTargetsByPid.set(pid, target);
    this.record(
      'target.detected',
      { source, processName: target.processName },
      target,
    );
    return target;
  }

  private updateTargetProcessName(
    target: MutableTargetSummary,
    processName: string | null,
  ): void {
    const safeName = safeProcessName(processName);
    if (safeName && !target.processName) {
      target.processName = safeName;
    }
  }

  private releaseTarget(pid: number, reason: string): void {
    const target = this.activeTargets.get(pid);
    if (!target) {
      return;
    }
    target.lastSeenAt = this.safeNowIso();
    target.terminalState = 'released';
    target.releaseReason = boundedString(reason, 80);
    target.transportConnected = false;
    this.record('target.released', { reason: target.releaseReason }, target);
    this.activeTargets.delete(pid);
    for (const key of Array.from(this.surfaceReferences.keys())) {
      if (key.startsWith(`${target.targetId}:`)) {
        this.surfaceReferences.delete(key);
      }
    }
  }

  private targetForTerminalEvent(pid: number): MutableTargetSummary | null {
    return (
      this.activeTargets.get(pid) ?? this.lastTargetsByPid.get(pid) ?? null
    );
  }

  private attemptReferenceForDirectory(directory: string): string {
    const key = path.resolve(directory).toLocaleLowerCase('en-US');
    const existing = this.attemptReferences.get(key);
    if (existing) {
      return existing;
    }
    const reference = `attempt-${String(this.nextAttemptNumber++).padStart(4, '0')}`;
    this.attemptReferences.set(key, reference);
    return reference;
  }

  private updateAttachmentPhase(
    target: MutableTargetSummary,
    phase: 'attaching' | 'connected' | 'failed',
  ): void {
    const previous = target.attachmentPhase;
    if (phase === 'failed' && previous !== 'failed') {
      this.noteFailure(target);
    }
    if (phase === 'connected') {
      this.noteTransportConnected(target);
    }
    target.attachmentPhase = phase;
  }

  private noteFailure(target: MutableTargetSummary): void {
    if (target.attachmentPhase !== 'failed') {
      target.failureCount += 1;
    }
    target.attachmentPhase = 'failed';
  }

  private noteTransportConnected(target: MutableTargetSummary): void {
    if (!target.transportConnected) {
      target.connectionCount += 1;
      target.transportConnected = true;
    }
    if (target.failureCount > 0) {
      target.recoveredAfterFailure = true;
    }
    target.attachmentPhase = 'connected';
  }

  private noteDiagnostic(target: MutableTargetSummary, code: string): void {
    target.diagnosticCounts.set(
      code,
      (target.diagnosticCounts.get(code) ?? 0) + 1,
    );
  }

  private noteGlobalDiagnostic(code: string): void {
    this.diagnosticCounts.set(code, (this.diagnosticCounts.get(code) ?? 0) + 1);
  }

  private surfaceReferenceFor(
    target: MutableTargetSummary,
    surfaceId: string,
  ): string {
    const key = `${target.targetId}:${surfaceId}`;
    const existing = this.surfaceReferences.get(key);
    if (existing) {
      return existing;
    }
    const reference = `surface-${String(this.nextSurfaceNumber++).padStart(4, '0')}`;
    this.surfaceReferences.set(key, reference);
    return reference;
  }

  private safeNowIso(): string {
    const value = this.now();
    return Number.isFinite(value.getTime())
      ? value.toISOString()
      : new Date().toISOString();
  }

  private serializeSummary(): string {
    return `${JSON.stringify(this.getSummary(), null, 2)}\n`;
  }

  private writeSummaryAtomically(): void {
    const temporaryPath = `${this.summaryPath}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(temporaryPath, this.serializeSummary(), {
        encoding: 'utf8',
        flag: 'wx',
      });
      renameSync(temporaryPath, this.summaryPath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private disable(error: Error): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    if (this.descriptor !== null) {
      try {
        closeSync(this.descriptor);
      } catch {
        // The first write/close error is the useful failure.
      }
      this.descriptor = null;
    }
    if (!this.errorReported) {
      this.errorReported = true;
      try {
        this.onError?.(error);
      } catch {
        // Evidence reporting must never affect the overlay lifecycle.
      }
    }
  }
}

function createRunId(started: Date, clientPid: number): string {
  const timestamp = started.toISOString().replace(/[-:]/g, '').replace('.', '');
  return `compatibility-${timestamp}-${clientPid}-${randomBytes(5).toString('hex')}`;
}

function sanitizeReShadeDiagnostic(diagnostic: ReShadeDiagnostic): JsonObject {
  return {
    code: diagnostic.code,
    stage: diagnostic.stage,
    retrySafety: diagnostic.retrySafety,
    windowsErrorCode: diagnostic.windowsErrorCode ?? null,
    runtimeStartupCode: diagnostic.runtimeStartupCode ?? null,
  };
}

function sanitizeOverlayDiagnosticContext(
  context: OverlayDiagnostic['context'],
): JsonObject | null {
  if (!context) {
    return null;
  }
  const sanitized: JsonObject = {};
  for (const [key, value] of Object.entries(context).slice(0, 32)) {
    if (
      !/^[A-Za-z0-9_.-]{1,80}$/.test(key) ||
      /(path|token|credential|secret|text|title|name|hwnd|monitor)/i.test(
        key,
      ) ||
      (typeof value === 'string' && /id$/i.test(key))
    ) {
      continue;
    }
    sanitized[key] =
      typeof value === 'string' ? boundedString(value, 240) : value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function pidFromInvocationArguments(
  arguments_: readonly string[],
): number | null {
  const pidFlagIndex = arguments_.indexOf('--pid');
  if (pidFlagIndex < 0) {
    return null;
  }
  const pid = Number(arguments_[pidFlagIndex + 1]);
  return isValidPid(pid) ? pid : null;
}

function safeTargetLabel(value: string): string | null {
  const processName = processNameFromTargetLabel(value);
  if (processName) {
    return processName;
  }
  return value.toLowerCase().startsWith('path-contains:')
    ? 'path-contains'
    : null;
}

function processNameFromTargetLabel(value: string): string | null {
  const processTarget = /^process:(.+\.exe)(?::pid:\d+)?$/i.exec(value);
  if (processTarget?.[1]) {
    return safeProcessName(processTarget[1]);
  }
  if (/^[^\\/:]+\.exe$/i.test(value)) {
    return safeProcessName(value);
  }
  return null;
}

function safeProcessName(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return boundedOptionalString(path.win32.basename(value.trim()), 260);
}

function processNameFromPath(value: string): string | null {
  return safeProcessName(value);
}

function boundedString(value: string, maximumLength: number): string {
  return value.slice(0, maximumLength);
}

function boundedOptionalString(
  value: string | null | undefined,
  maximumLength: number,
): string | null {
  return typeof value === 'string' && value.length > 0
    ? boundedString(value, maximumLength)
    : null;
}

function sortedCountObject(counts: Map<string, number>): JsonObject {
  return Object.fromEntries(
    Array.from(counts.entries()).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function pruneCompletedCompatibilityRuns(
  rootDirectory: string,
  currentRunId: string,
  nowMs: number,
): void {
  try {
    const suffix = '.summary.json';
    const candidates: Array<{
      runId: string;
      paths: string[];
      bytes: number;
      modifiedAtMs: number;
    }> = [];
    for (const entry of readdirSync(rootDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) {
        continue;
      }
      const runId = entry.name.slice(0, -suffix.length);
      if (runId === currentRunId || !runId.startsWith('compatibility-')) {
        continue;
      }
      const summaryPath = path.join(rootDirectory, entry.name);
      try {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
        if (
          !isRecord(summary) ||
          summary.schemaVersion !== SCHEMA_VERSION ||
          summary.runId !== runId ||
          summary.recorderClosedOrderly !== true
        ) {
          continue;
        }
        const paths: string[] = [];
        const eventsPath = path.join(rootDirectory, `${runId}.events.jsonl`);
        const summaryStat = lstatSync(summaryPath);
        if (!summaryStat.isFile()) {
          continue;
        }
        let bytes = summaryStat.size;
        let modifiedAtMs = summaryStat.mtimeMs;
        try {
          const eventsStat = lstatSync(eventsPath);
          if (eventsStat.isFile()) {
            paths.push(eventsPath);
            bytes += eventsStat.size;
            modifiedAtMs = Math.max(modifiedAtMs, eventsStat.mtimeMs);
          }
        } catch {
          // A completed summary remains independently reclaimable.
        }
        paths.push(summaryPath);
        candidates.push({ runId, paths, bytes, modifiedAtMs });
      } catch {
        // Malformed, locked, active, and unfamiliar evidence is preserved.
      }
    }

    candidates.sort(
      (left, right) =>
        right.modifiedAtMs - left.modifiedAtMs ||
        right.runId.localeCompare(left.runId),
    );
    let retainedCount = 0;
    let retainedBytes = 0;
    for (const candidate of candidates) {
      const ageMs = Math.max(0, nowMs - candidate.modifiedAtMs);
      const withinBounds =
        ageMs <= MAX_COMPLETED_RUN_AGE_MS &&
        retainedCount < MAX_RETAINED_COMPLETED_RUNS &&
        retainedBytes + candidate.bytes <= MAX_COMPLETED_RUN_BYTES;
      if (withinBounds) {
        retainedCount += 1;
        retainedBytes += candidate.bytes;
        continue;
      }
      for (const candidatePath of candidate.paths) {
        rmSync(candidatePath, { force: true });
      }
    }
  } catch {
    // Evidence retention is best effort and must never disable the overlay.
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isValidPid(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 0xffffffff
  );
}

function writeBufferCompletely(descriptor: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
    );
    if (written <= 0) {
      throw new Error(
        'compatibility recorder made no progress writing an event',
      );
    }
    offset += written;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
