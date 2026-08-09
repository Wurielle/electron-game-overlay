import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import * as path from 'node:path';
import {
  InputEventTranslator,
  type NativeInputMessage,
  type TranslatedInputEvent,
} from './input-translation.js';
import type {
  NativeOverlay,
  NativeOverlayWindowDetails,
  NativeOverlayWindowGeometry,
  NativeRuntimeProviderMetadata,
  NativeTargetAuthorization,
} from './native.js';
import {
  BrokerPacketDecoder,
  OVERLAY_BROKER_CAPABILITIES,
  OVERLAY_BROKER_PROTOCOL_VERSION,
  OVERLAY_BROKER_REQUIRED_CAPABILITIES,
  OVERLAY_BROKER_RUNTIME_GENERATION,
  OVERLAY_BROKER_TARGET_TRANSPORT_MAX,
  OVERLAY_BROKER_TARGET_TRANSPORT_MIN,
  defaultOverlayBrokerPipePath,
  encodeBrokerFramePacket,
  encodeBrokerJsonPacket,
  isOverlayBrokerWindowOrderToken,
  type OverlayBrokerError,
  type OverlayBrokerTargetAuthorized,
  type OverlayBrokerWelcome,
  type OverlayBrokerWindowOrder,
} from './overlay-broker-protocol.js';
import {
  BackpressurePacketQueue,
  OverlayLoopbackTransport,
} from './overlay-loopback-transport.js';
import type { OverlayDiagnostic, Disposable } from './types.js';

const SDK_VERSION = '0.0.1';
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MIN_RETRY_DELAY_MS = 25;
const MAX_RETRY_DELAY_MS = 500;
const MIN_BROKER_SPAWN_RETRY_MS = 1_000;
const MAX_BROKER_SPAWN_RETRY_MS = 5_000;
const MAX_PENDING_EVENTS = 128;
const MAX_PENDING_DIAGNOSTICS = 32;
const MIN_TARGET_REAUTHORIZATION_RETRY_MS = 50;
const MAX_TARGET_REAUTHORIZATION_RETRY_MS = 2_000;
const LEGACY_GLOBAL_LOCK_PIPE_SUFFIX = '-legacy-global-v1';

export interface OverlayBrokerClientOptions {
  pipePath?: string;
  sdkVersion?: string;
  requiredCapabilities?: readonly string[];
  supportedCapabilities?: readonly string[];
  /** @internal Test override for runtime-provider election. */
  runtimeGeneration?: number;
  /** @internal Inclusive test override for target-transport compatibility. */
  targetTransportMin?: number;
  /** @internal Inclusive test override for target-transport compatibility. */
  targetTransportMax?: number;
  connectTimeoutMs?: number;
  brokerEntryPath?: string;
  spawnBroker?: () => void;
}

type RetainedWindow = {
  details: NativeOverlayWindowDetails;
  latestFrame?: Buffer;
  orderToken?: string;
};

type PendingEvent = Readonly<{
  event: string;
  payload: Record<string, unknown>;
}>;

type TargetLease = {
  pid: number;
  leaseId: string;
  discoveryPath: string;
  expectedExecutablePath?: string;
  runtimeProvider: NativeRuntimeProviderMetadata;
  currentRequestId?: string;
  reauthorizationAttempt: number;
  reauthorizationTimer?: ReturnType<typeof setTimeout>;
  transportConnected: boolean;
  targetExecutablePath?: string;
  authorizationPreviouslySent: boolean;
  settled: boolean;
  released: boolean;
  resolve: (authorization: NativeTargetAuthorization) => void;
  reject: (error: Error) => void;
};

/**
 * App-side transport for the per-user overlay broker. It deliberately retains
 * only app-local IDs; target-global IDs never cross this boundary.
 */
export class OverlayBrokerClient implements NativeOverlay {
  private readonly pipePath: string;
  private readonly sdkVersion: string;
  private readonly requiredCapabilities: readonly string[];
  private readonly supportedCapabilities: readonly string[];
  private readonly runtimeGeneration: number;
  private readonly targetTransportMin: number;
  private readonly targetTransportMax: number;
  private readonly connectTimeoutMs: number;
  private readonly brokerEntryPath: string;
  private readonly spawnBrokerOverride: (() => void) | undefined;
  private readonly clientInstanceId = randomBytes(12).toString('hex');
  private readonly windows = new Map<number, RetainedWindow>();
  private readonly targetLeases = new Map<number, TargetLease>();
  private readonly leasesByRequestId = new Map<string, TargetLease>();
  private readonly inputTranslatorsByPid = new Map<
    number,
    InputEventTranslator
  >();
  private readonly pendingEvents: PendingEvent[] = [];
  private readonly pendingDiagnostics: OverlayDiagnostic[] = [];
  private socket: Socket | undefined;
  private writer: BackpressurePacketQueue | undefined;
  private decoder = new BrokerPacketDecoder();
  private callback: ((event: string, ...args: any[]) => void) | undefined;
  private diagnosticCallback:
    ((diagnostic: OverlayDiagnostic) => void) | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private readyPromise: Promise<unknown> | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private initialReady = false;
  private welcomed = false;
  private started = false;
  private fatal = false;
  private generation = 0;
  private requestSequence = 0;
  private retryAttempt = 0;
  private startupDeadline = 0;
  private brokerSpawnRetryAttempt = 0;
  private nextBrokerSpawnAttemptAt = 0;
  private inputIntercept: boolean | undefined;
  private legacyTransport: OverlayLoopbackTransport | undefined;
  private legacyReferences = 0;
  private legacyLockRelease: Disposable | undefined;

  constructor(options: OverlayBrokerClientOptions = {}) {
    this.pipePath =
      options.pipePath ??
      (process.env.ELECTRON_GAME_OVERLAY_BROKER_PIPE ||
        defaultOverlayBrokerPipePath());
    this.sdkVersion = options.sdkVersion ?? SDK_VERSION;
    this.requiredCapabilities = Object.freeze([
      ...(options.requiredCapabilities ?? OVERLAY_BROKER_REQUIRED_CAPABILITIES),
    ]);
    this.supportedCapabilities = Object.freeze([
      ...(options.supportedCapabilities ?? OVERLAY_BROKER_CAPABILITIES),
    ]);
    this.runtimeGeneration =
      options.runtimeGeneration ?? OVERLAY_BROKER_RUNTIME_GENERATION;
    this.targetTransportMin =
      options.targetTransportMin ?? OVERLAY_BROKER_TARGET_TRANSPORT_MIN;
    this.targetTransportMax =
      options.targetTransportMax ?? OVERLAY_BROKER_TARGET_TRANSPORT_MAX;
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.brokerEntryPath =
      options.brokerEntryPath ??
      path.join(__dirname, 'overlay-broker-entry.js');
    this.spawnBrokerOverride = options.spawnBroker;
    if (
      !Number.isSafeInteger(this.connectTimeoutMs) ||
      this.connectTimeoutMs <= 0 ||
      this.connectTimeoutMs > 120_000
    ) {
      throw new RangeError(
        'connectTimeoutMs must be an integer between 1 and 120000',
      );
    }
    assertPositiveUint32(this.runtimeGeneration, 'runtimeGeneration');
    assertPositiveUint32(this.targetTransportMin, 'targetTransportMin');
    assertPositiveUint32(this.targetTransportMax, 'targetTransportMax');
    if (this.targetTransportMin > this.targetTransportMax) {
      throw new RangeError(
        'targetTransportMin must be less than or equal to targetTransportMax',
      );
    }
  }

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.fatal = false;
    this.initialReady = false;
    this.welcomed = false;
    this.retryAttempt = 0;
    this.brokerSpawnRetryAttempt = 0;
    this.nextBrokerSpawnAttemptAt = 0;
    this.startupDeadline = Date.now() + this.connectTimeoutMs;
    const generation = ++this.generation;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
    this.scheduleConnection(generation, 0);
  }

  public whenReady(): Promise<unknown> {
    return (
      this.readyPromise ??
      Promise.reject(new Error('Overlay broker client has not been started'))
    );
  }

  public async authorizeTarget(
    pid: number,
    discoveryPath: string,
    expectedExecutablePath?: string,
    runtimeProvider?: NativeRuntimeProviderMetadata,
    signal?: AbortSignal,
  ): Promise<NativeTargetAuthorization> {
    assertPositiveUint32(pid, 'pid');
    if (typeof discoveryPath !== 'string' || !path.isAbsolute(discoveryPath)) {
      throw new TypeError('Overlay target discovery path must be absolute');
    }
    if (
      expectedExecutablePath !== undefined &&
      (typeof expectedExecutablePath !== 'string' ||
        !path.win32.isAbsolute(expectedExecutablePath) ||
        expectedExecutablePath.includes('\0'))
    ) {
      throw new TypeError(
        'Overlay expected executable path must be an absolute Windows path',
      );
    }
    if (!this.started || this.fatal) {
      throw new Error('Overlay broker client is not running');
    }
    signal?.throwIfAborted();
    if (this.targetLeases.has(pid)) {
      throw new Error(`Overlay target PID ${pid} already has an app lease`);
    }
    const selectedRuntimeProvider = Object.freeze(
      runtimeProvider === undefined
        ? {
            runtimeGeneration: this.runtimeGeneration,
            targetTransportMin: this.targetTransportMin,
            targetTransportMax: this.targetTransportMax,
          }
        : { ...runtimeProvider },
    );
    validateRuntimeProviderMetadata(selectedRuntimeProvider);

    let resolveAuthorization!: (
      authorization: NativeTargetAuthorization,
    ) => void;
    let rejectAuthorization!: (error: Error) => void;
    const authorization = new Promise<NativeTargetAuthorization>(
      (resolve, reject) => {
        resolveAuthorization = resolve;
        rejectAuthorization = reject;
      },
    );
    const lease: TargetLease = {
      pid,
      leaseId: randomBytes(16).toString('hex'),
      discoveryPath,
      ...(expectedExecutablePath === undefined
        ? {}
        : { expectedExecutablePath }),
      runtimeProvider: selectedRuntimeProvider,
      reauthorizationAttempt: 0,
      transportConnected: false,
      authorizationPreviouslySent: false,
      settled: false,
      released: false,
      resolve: resolveAuthorization,
      reject: rejectAuthorization,
    };
    this.targetLeases.set(pid, lease);
    let removeAbortListener: () => void = () => undefined;
    if (signal) {
      const cancel = () => {
        this.releaseTargetLease(lease, targetAuthorizationAbortError(signal));
      };
      signal.addEventListener('abort', cancel, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', cancel);
      if (signal.aborted) {
        cancel();
      }
    }
    authorization.then(removeAbortListener, removeAbortListener);
    try {
      await Promise.race([
        this.whenReady(),
        authorization.then(() => undefined),
      ]);
      if (!this.started || lease.released) {
        signal?.throwIfAborted();
        throw new Error('Overlay broker client stopped before authorization');
      }
      this.sendTargetAuthorization(lease);
      return await authorization;
    } catch (error) {
      if (this.targetLeases.get(pid) === lease && !lease.settled) {
        this.releaseTargetLease(
          lease,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      throw error;
    }
  }

  /**
   * Preserves pre-creation name/path watcher support. This lane is deliberately
   * exclusive; same-PID multi-app multiplexing requires an exact PID lease.
   */
  public async authorizeGlobalTarget(): Promise<Disposable> {
    if (!this.started || this.fatal) {
      throw new Error('Overlay broker client is not running');
    }
    await this.whenReady();
    if (!this.legacyTransport) {
      const releaseLock = await acquireLegacyGlobalRendezvousLock();
      const transport = new OverlayLoopbackTransport();
      try {
        transport.setEventCallback((event, payload) => {
          if (isRecord(payload)) {
            this.emitEvent(event, payload);
          }
        });
        transport.setDiagnosticCallback((diagnostic) => {
          this.deliverDiagnostic(diagnostic);
        });
        for (const [windowId, retained] of this.windows) {
          transport.addWindow(windowId, retained.details);
          if (retained.latestFrame) {
            const frame = decodeRetainedFrame(retained.latestFrame);
            transport.sendFrameBuffer(
              windowId,
              frame.pixels,
              frame.width,
              frame.height,
            );
          }
        }
        if (this.inputIntercept !== undefined) {
          transport.setInputIntercept(this.inputIntercept);
        }
        transport.start();
        await transport.whenReady();
      } catch (error) {
        transport.stop();
        releaseLock();
        throw error;
      }
      if (!this.started) {
        transport.stop();
        releaseLock();
        throw new Error(
          'Overlay broker client stopped before global authorization',
        );
      }
      this.legacyTransport = transport;
      this.legacyLockRelease = releaseLock;
    }
    ++this.legacyReferences;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.legacyReferences = Math.max(0, this.legacyReferences - 1);
      if (this.legacyReferences === 0) {
        this.stopLegacyTransport();
      }
    };
  }

  public stop(): void {
    if (!this.started && !this.readyPromise) {
      return;
    }
    this.started = false;
    this.fatal = false;
    ++this.generation;
    this.clearTimers();
    this.rejectReady?.(
      new Error('Overlay broker client stopped before startup completed'),
    );
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    this.readyPromise = undefined;
    this.initialReady = false;
    this.welcomed = false;
    this.writer?.clear();
    this.writer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.stopLegacyTransport();
    for (const lease of this.targetLeases.values()) {
      this.clearTargetReauthorizationRetry(lease);
      lease.released = true;
      if (!lease.settled) {
        lease.settled = true;
        lease.reject(
          new Error('Overlay broker client stopped before authorization'),
        );
      }
    }
    this.targetLeases.clear();
    this.leasesByRequestId.clear();
    this.windows.clear();
    this.inputTranslatorsByPid.clear();
    this.inputIntercept = undefined;
    this.pendingEvents.length = 0;
    this.pendingDiagnostics.length = 0;
    this.callback = undefined;
    this.diagnosticCallback = undefined;
    this.decoder = new BrokerPacketDecoder();
  }

  public setEventCallback(
    callback: (event: string, ...args: any[]) => void,
  ): void {
    this.callback = callback;
    while (this.pendingEvents.length !== 0) {
      const pending = this.pendingEvents.shift();
      if (pending) {
        callback(pending.event, pending.payload);
      }
    }
  }

  public setDiagnosticCallback(
    callback: (diagnostic: OverlayDiagnostic) => void,
  ): void {
    this.diagnosticCallback = callback;
    while (this.pendingDiagnostics.length !== 0) {
      const diagnostic = this.pendingDiagnostics.shift();
      if (diagnostic) {
        callback(diagnostic);
      }
    }
  }

  public setInputIntercept(intercept: boolean): void {
    this.inputIntercept = intercept;
    if (!intercept) {
      this.resetInputTranslators();
    }
    this.sendJson({ type: 'broker.input.intercept', intercept });
    this.legacyTransport?.setInputIntercept(intercept);
  }

  public addWindow(
    windowId: number,
    details: NativeOverlayWindowDetails,
  ): void {
    assertPositiveUint32(windowId, 'windowId');
    const message = {
      type: 'broker.window.upsert' as const,
      windowId,
      name: details.name,
      transparent: details.transparent,
      rect: { ...details.rect },
      ...(details.caption ? { caption: { ...details.caption } } : {}),
      ...(details.scaleFactorMicros === undefined
        ? {}
        : { scaleFactorMicros: details.scaleFactorMicros }),
    };
    const packet = encodeBrokerJsonPacket(message);
    this.windows.delete(windowId);
    this.windows.set(windowId, {
      details: cloneWindowDetails(details),
    });
    this.sendControlPacket(packet);
    this.legacyTransport?.addWindow(windowId, details);
  }

  public closeWindow(windowId: number): void {
    assertPositiveUint32(windowId, 'windowId');
    const packet = encodeBrokerJsonPacket({
      type: 'broker.window.close',
      windowId,
    });
    this.windows.delete(windowId);
    this.writer?.dropPendingFrames(windowId);
    this.sendControlPacket(packet);
    this.legacyTransport?.closeWindow(windowId);
  }

  public sendWindowBounds(
    windowId: number,
    details: NativeOverlayWindowGeometry,
  ): void {
    assertPositiveUint32(windowId, 'windowId');
    const message = {
      type: 'broker.window.bounds' as const,
      windowId,
      rect: { ...details.rect },
      ...(details.caption === undefined
        ? {}
        : { caption: { ...details.caption } }),
      ...(details.scaleFactorMicros === undefined
        ? {}
        : { scaleFactorMicros: details.scaleFactorMicros }),
      ...(details.rasterChanged === undefined
        ? {}
        : { rasterChanged: details.rasterChanged }),
    };
    const packet = encodeBrokerJsonPacket(message);
    const retained = this.windows.get(windowId);
    if (retained) {
      retained.details.rect = { ...details.rect };
      if (details.caption !== undefined) {
        retained.details.caption = { ...details.caption };
      }
      if (details.scaleFactorMicros !== undefined) {
        retained.details.scaleFactorMicros = details.scaleFactorMicros;
      }
      if (details.rasterChanged) {
        retained.latestFrame = undefined;
      }
    }
    if (details.rasterChanged) {
      this.writer?.dropPendingFrames(windowId);
    }
    this.sendControlPacket(packet);
    this.legacyTransport?.sendWindowBounds(windowId, details);
  }

  public sendFrameBuffer(
    windowId: number,
    buffer: Buffer,
    width: number,
    height: number,
  ): boolean {
    const retained = this.windows.get(windowId);
    if (!retained) {
      return false;
    }
    const packet = encodeBrokerFramePacket(windowId, width, height, buffer);
    retained.latestFrame = packet;
    if (this.welcomed) {
      this.writer?.sendFrame(windowId, packet);
    }
    this.legacyTransport?.sendFrameBuffer(windowId, buffer, width, height);
    return true;
  }

  public translateInputEvent(
    event: NativeInputMessage,
  ): TranslatedInputEvent | undefined {
    if (event.pid === undefined) {
      return undefined;
    }
    return (
      this.legacyTransport?.translateInputEvent(event) ??
      this.inputTranslatorsByPid.get(event.pid)?.translate(event)
    );
  }

  private scheduleConnection(generation: number, delayMs: number): void {
    if (
      !this.started ||
      this.fatal ||
      generation !== this.generation ||
      this.socket
    ) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(generation);
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private connect(generation: number): void {
    if (
      !this.started ||
      this.fatal ||
      generation !== this.generation ||
      this.socket
    ) {
      return;
    }
    const socket = createConnection(this.pipePath);
    this.socket = socket;
    let connected = false;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      if (
        !this.started ||
        generation !== this.generation ||
        this.socket !== socket
      ) {
        socket.destroy();
        return;
      }
      connected = true;
      this.retryAttempt = 0;
      this.brokerSpawnRetryAttempt = 0;
      this.nextBrokerSpawnAttemptAt = 0;
      this.decoder = new BrokerPacketDecoder();
      this.writer = new BackpressurePacketQueue(socket, () => socket.destroy());
      socket.on('drain', () => this.writer?.handleDrain());
      this.handshakeTimer = setTimeout(() => {
        if (this.socket === socket && !this.welcomed) {
          socket.destroy(
            new Error('Timed out negotiating with the overlay broker'),
          );
        }
      }, HANDSHAKE_TIMEOUT_MS);
      this.handshakeTimer.unref?.();
      this.writer.sendControl(
        encodeBrokerJsonPacket({
          type: 'broker.hello',
          protocolMin: OVERLAY_BROKER_PROTOCOL_VERSION,
          protocolMax: OVERLAY_BROKER_PROTOCOL_VERSION,
          requiredCapabilities: this.requiredCapabilities,
          supportedCapabilities: this.supportedCapabilities,
          clientPid: process.pid,
          sdkVersion: this.sdkVersion,
          runtimeGeneration: this.runtimeGeneration,
          targetTransportMin: this.targetTransportMin,
          targetTransportMax: this.targetTransportMax,
        }),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.socket === socket) {
        this.receiveData(chunk);
      }
    });
    socket.on('error', () => {
      // Close owns retry and startup failure reporting.
    });
    socket.on('close', () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.writer?.clear();
      this.writer = undefined;
      this.welcomed = false;
      this.clearHandshakeTimer();
      this.decoder = new BrokerPacketDecoder();
      for (const lease of this.targetLeases.values()) {
        this.clearTargetReauthorizationRetry(lease);
        if (lease.currentRequestId) {
          this.leasesByRequestId.delete(lease.currentRequestId);
          lease.currentRequestId = undefined;
        }
        this.emitBrokerTransportLost(lease);
      }
      this.resetInputTranslators();
      if (!this.started || this.fatal || generation !== this.generation) {
        return;
      }
      if (!connected) {
        this.trySpawnBroker();
      }
      if (!this.initialReady && Date.now() >= this.startupDeadline) {
        this.failFatal(
          new Error(
            `Unable to connect to the per-user overlay broker at ${this.pipePath}`,
          ),
        );
        return;
      }
      const retryDelay = Math.min(
        MIN_RETRY_DELAY_MS * 2 ** this.retryAttempt++,
        MAX_RETRY_DELAY_MS,
      );
      this.scheduleConnection(generation, retryDelay);
    });
  }

  private receiveData(chunk: Buffer): void {
    let packets;
    try {
      packets = this.decoder.push(chunk);
    } catch (error) {
      this.failFatal(asError(error, 'Invalid overlay broker packet'));
      return;
    }
    for (const packet of packets) {
      if (packet.kind !== 'json') {
        this.failFatal(
          new Error('The overlay broker sent an unexpected frame packet'),
        );
        return;
      }
      if (!this.receiveMessage(packet.value)) {
        this.failFatal(new Error('The overlay broker sent an invalid message'));
        return;
      }
    }
  }

  private receiveMessage(value: unknown): boolean {
    if (!isRecord(value) || typeof value.type !== 'string') {
      return false;
    }
    if (!this.welcomed) {
      if (value.type === 'broker.error') {
        const error = parseBrokerError(value);
        if (!error) {
          return false;
        }
        this.failFatal(new Error(`${error.code}: ${error.message}`));
        return true;
      }
      if (value.type !== 'broker.welcome') {
        return false;
      }
      const welcome = parseBrokerWelcome(value);
      if (!welcome) {
        return false;
      }
      this.acceptWelcome(welcome);
      return true;
    }

    if (value.type === 'broker.target.authorized') {
      const authorized = parseTargetAuthorized(value);
      if (!authorized) {
        return false;
      }
      this.acceptTargetAuthorization(authorized);
      return true;
    }
    if (value.type === 'broker.target.released') {
      return typeof value.requestId === 'string' && isPositiveUint32(value.pid);
    }
    if (value.type === 'broker.window.order') {
      const order = parseWindowOrder(value);
      if (!order) {
        return false;
      }
      const retained = this.windows.get(order.windowId);
      if (retained) {
        retained.orderToken = order.orderToken;
      }
      return true;
    }
    if (value.type === 'broker.error') {
      const error = parseBrokerError(value);
      if (!error) {
        return false;
      }
      this.handleBrokerError(error);
      return true;
    }
    if (value.type === 'broker.diagnostic') {
      if (!('diagnostic' in value)) {
        return false;
      }
      this.deliverDiagnostic(value.diagnostic);
      return true;
    }
    if (value.type.startsWith('game.')) {
      const { type, ...payload } = value;
      this.observeTargetLifecycle(type, payload);
      this.prepareInputState(type, payload);
      this.emitEvent(type, payload);
      return true;
    }
    return false;
  }

  private acceptWelcome(welcome: OverlayBrokerWelcome): void {
    const missingCapability = this.requiredCapabilities.find(
      (capability) => !welcome.capabilities.includes(capability),
    );
    if (
      welcome.protocolVersion !== OVERLAY_BROKER_PROTOCOL_VERSION ||
      missingCapability
    ) {
      this.failFatal(
        new Error(
          missingCapability
            ? `Overlay broker is missing required capability ${missingCapability}`
            : `Overlay broker selected unsupported protocol ${welcome.protocolVersion}`,
        ),
      );
      return;
    }
    this.clearHandshakeTimer();
    this.welcomed = true;
    for (const lease of this.targetLeases.values()) {
      this.clearTargetReauthorizationRetry(lease);
    }
    this.replayState();
    if (!this.initialReady) {
      this.initialReady = true;
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
    }
  }

  private replayState(): void {
    for (const [windowId, retained] of this.windows) {
      this.sendJson({
        type: 'broker.window.upsert',
        windowId,
        name: retained.details.name,
        transparent: retained.details.transparent,
        rect: { ...retained.details.rect },
        ...(retained.details.caption
          ? { caption: { ...retained.details.caption } }
          : {}),
        ...(retained.details.scaleFactorMicros === undefined
          ? {}
          : { scaleFactorMicros: retained.details.scaleFactorMicros }),
        ...(retained.orderToken === undefined
          ? {}
          : { orderToken: retained.orderToken }),
      });
      if (retained.latestFrame) {
        this.writer?.sendFrame(windowId, retained.latestFrame);
      }
    }
    if (this.inputIntercept !== undefined) {
      this.sendJson({
        type: 'broker.input.intercept',
        intercept: this.inputIntercept,
      });
    }
    for (const lease of this.targetLeases.values()) {
      if (!lease.released) {
        this.sendTargetAuthorization(lease);
      }
    }
  }

  private sendTargetAuthorization(lease: TargetLease): void {
    if (!this.welcomed || lease.released || lease.currentRequestId) {
      return;
    }
    const requestId = this.nextRequestId();
    const recovery = lease.authorizationPreviouslySent;
    lease.authorizationPreviouslySent = true;
    lease.currentRequestId = requestId;
    this.leasesByRequestId.set(requestId, lease);
    this.sendJson({
      type: 'broker.target.authorize',
      requestId,
      pid: lease.pid,
      discoveryPath: lease.discoveryPath,
      ...(lease.expectedExecutablePath === undefined
        ? {}
        : { expectedExecutablePath: lease.expectedExecutablePath }),
      runtimeGeneration: lease.runtimeProvider.runtimeGeneration,
      targetTransportMin: lease.runtimeProvider.targetTransportMin,
      targetTransportMax: lease.runtimeProvider.targetTransportMax,
      leaseId: lease.leaseId,
      recovery,
      routeEstablished:
        recovery &&
        (lease.settled ||
          lease.transportConnected ||
          lease.targetExecutablePath !== undefined),
    });
  }

  private acceptTargetAuthorization(
    message: OverlayBrokerTargetAuthorized,
  ): void {
    const lease = this.leasesByRequestId.get(message.requestId);
    if (!lease || lease.pid !== message.pid || lease.released) {
      return;
    }
    this.leasesByRequestId.delete(message.requestId);
    lease.currentRequestId = undefined;
    this.clearTargetReauthorizationRetry(lease);
    // Every member remembers the broker owner's pinned rendezvous. If the
    // broker process restarts while an app remains alive, that app can
    // republish the same route and let the already-mapped runtime reconnect.
    lease.discoveryPath = message.discoveryPath;
    if (lease.settled) {
      return;
    }
    lease.settled = true;
    lease.resolve(
      Object.freeze({
        release: this.createTargetRelease(lease),
        disposition: message.disposition,
        ...(message.target === undefined
          ? {}
          : {
              target: Object.freeze({
                pid: message.target.pid,
                executablePath: message.target.executablePath,
                discoveryPath: message.target.discoveryPath,
              }),
            }),
      }),
    );
  }

  private createTargetRelease(lease: TargetLease): Disposable {
    return () => this.releaseTargetLease(lease);
  }

  private releaseTargetLease(lease: TargetLease, pendingError?: Error): void {
    if (lease.released) {
      return;
    }
    lease.released = true;
    this.clearTargetReauthorizationRetry(lease);
    if (this.targetLeases.get(lease.pid) === lease) {
      this.targetLeases.delete(lease.pid);
    }
    if (lease.currentRequestId) {
      this.leasesByRequestId.delete(lease.currentRequestId);
      lease.currentRequestId = undefined;
    }
    if (this.welcomed) {
      this.sendJson({
        type: 'broker.target.release',
        requestId: this.nextRequestId(),
        pid: lease.pid,
      });
    }
    if (!lease.settled && pendingError) {
      lease.settled = true;
      lease.reject(pendingError);
    }
  }

  private handleBrokerError(error: OverlayBrokerError): void {
    const lease =
      (error.requestId === undefined
        ? undefined
        : this.leasesByRequestId.get(error.requestId)) ??
      (error.code === 'target-exited' && error.pid !== undefined
        ? this.targetLeases.get(error.pid)
        : undefined);
    if (lease) {
      if (error.requestId !== undefined) {
        this.leasesByRequestId.delete(error.requestId);
      }
      if (lease.currentRequestId) {
        this.leasesByRequestId.delete(lease.currentRequestId);
      }
      lease.currentRequestId = undefined;
      if (!lease.settled) {
        lease.settled = true;
        this.targetLeases.delete(lease.pid);
        lease.reject(new Error(`${error.code}: ${error.message}`));
      } else if (!lease.released) {
        if (error.code === 'duplicate-target-lease') {
          // The broker believes this session still owns a membership that the
          // client cannot correlate. Reconnect to get a clean session rather
          // than repeatedly issuing duplicate authorization requests.
          this.socket?.destroy();
        } else if (error.code === 'target-exited') {
          const targetPath =
            lease.targetExecutablePath ?? lease.expectedExecutablePath;
          lease.released = true;
          this.clearTargetReauthorizationRetry(lease);
          if (this.targetLeases.get(lease.pid) === lease) {
            this.targetLeases.delete(lease.pid);
          }
          const payload = Object.freeze({
            pid: lease.pid,
            ...(targetPath === undefined ? {} : { path: targetPath }),
          });
          this.prepareInputState('game.process.disconnected', payload);
          this.emitEvent('game.process.disconnected', payload);
        } else {
          this.scheduleTargetReauthorization(lease);
        }
      }
      return;
    }
    console.error(`Overlay broker ${error.code}: ${error.message}`);
  }

  private prepareInputState(
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const pid = payload.pid;
    if (!isPositiveUint32(pid)) {
      return;
    }
    if (event === 'game.process') {
      this.inputTranslatorsByPid.set(pid, new InputEventTranslator());
    } else if (event === 'game.process.disconnected') {
      this.inputTranslatorsByPid.get(pid)?.reset();
      this.inputTranslatorsByPid.delete(pid);
    } else if (
      (event === 'game.window.focused' && payload.focusWindowId === 0) ||
      (event === 'game.input.intercept' && payload.intercepting === false)
    ) {
      this.inputTranslatorsByPid.get(pid)?.reset();
    }
  }

  private observeTargetLifecycle(
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const pid = payload.pid;
    if (!isPositiveUint32(pid)) {
      return;
    }
    const lease = this.targetLeases.get(pid);
    if (!lease) {
      return;
    }
    if (event === 'game.process' && typeof payload.path === 'string') {
      lease.targetExecutablePath = payload.path;
      lease.transportConnected = true;
      return;
    }
    if (
      event === 'game.process.transport-lost' ||
      event === 'game.process.disconnected'
    ) {
      if (typeof payload.path === 'string') {
        lease.targetExecutablePath = payload.path;
      }
      lease.transportConnected = false;
      if (
        event === 'game.process.disconnected' &&
        lease.settled &&
        !lease.released
      ) {
        lease.released = true;
        this.clearTargetReauthorizationRetry(lease);
        if (this.targetLeases.get(pid) === lease) {
          this.targetLeases.delete(pid);
        }
        if (lease.currentRequestId) {
          this.leasesByRequestId.delete(lease.currentRequestId);
          lease.currentRequestId = undefined;
        }
      }
    }
  }

  private emitBrokerTransportLost(lease: TargetLease): void {
    const path = lease.targetExecutablePath;
    if (!lease.transportConnected || path === undefined) {
      return;
    }
    lease.transportConnected = false;
    this.emitEvent(
      'game.process.transport-lost',
      Object.freeze({ pid: lease.pid, path }),
    );
  }

  private scheduleTargetReauthorization(lease: TargetLease): void {
    if (
      lease.released ||
      !lease.settled ||
      !this.started ||
      !this.welcomed ||
      lease.currentRequestId ||
      lease.reauthorizationTimer
    ) {
      return;
    }
    const delay = Math.min(
      MIN_TARGET_REAUTHORIZATION_RETRY_MS *
        2 ** Math.min(lease.reauthorizationAttempt, 16),
      MAX_TARGET_REAUTHORIZATION_RETRY_MS,
    );
    lease.reauthorizationAttempt += 1;
    lease.reauthorizationTimer = setTimeout(() => {
      lease.reauthorizationTimer = undefined;
      if (
        lease.released ||
        !this.started ||
        !this.welcomed ||
        lease.currentRequestId ||
        this.targetLeases.get(lease.pid) !== lease
      ) {
        return;
      }
      this.sendTargetAuthorization(lease);
    }, delay);
    lease.reauthorizationTimer.unref?.();
  }

  private clearTargetReauthorizationRetry(lease: TargetLease): void {
    if (lease.reauthorizationTimer) {
      clearTimeout(lease.reauthorizationTimer);
      lease.reauthorizationTimer = undefined;
    }
    lease.reauthorizationAttempt = 0;
  }

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    if (this.callback) {
      this.callback(event, payload);
      return;
    }
    if (this.pendingEvents.length === MAX_PENDING_EVENTS) {
      this.pendingEvents.shift();
    }
    this.pendingEvents.push(Object.freeze({ event, payload }));
  }

  private deliverDiagnostic(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }
    const diagnostic = value as OverlayDiagnostic;
    if (this.diagnosticCallback) {
      this.diagnosticCallback(diagnostic);
      return;
    }
    if (this.pendingDiagnostics.length === MAX_PENDING_DIAGNOSTICS) {
      this.pendingDiagnostics.shift();
    }
    this.pendingDiagnostics.push(diagnostic);
  }

  private sendJson(value: unknown): void {
    if (!this.welcomed) {
      return;
    }
    this.sendControlPacket(encodeBrokerJsonPacket(value));
  }

  private sendControlPacket(packet: Buffer): void {
    if (this.welcomed) {
      this.writer?.sendControl(packet);
    }
  }

  private nextRequestId(): string {
    this.requestSequence = (this.requestSequence + 1) % Number.MAX_SAFE_INTEGER;
    return `${this.clientInstanceId}-${this.requestSequence}`;
  }

  private trySpawnBroker(): void {
    const now = Date.now();
    if (!this.started || now < this.nextBrokerSpawnAttemptAt) {
      return;
    }
    const retryDelay = Math.min(
      MIN_BROKER_SPAWN_RETRY_MS * 2 ** this.brokerSpawnRetryAttempt,
      MAX_BROKER_SPAWN_RETRY_MS,
    );
    if (retryDelay < MAX_BROKER_SPAWN_RETRY_MS) {
      this.brokerSpawnRetryAttempt += 1;
    }
    this.nextBrokerSpawnAttemptAt = now + retryDelay;
    try {
      if (this.spawnBrokerOverride) {
        this.spawnBrokerOverride();
        return;
      }
      if (!existsSync(this.brokerEntryPath)) {
        throw new Error(
          `Overlay broker entrypoint is missing: ${this.brokerEntryPath}`,
        );
      }
      const child = spawn(process.execPath, [this.brokerEntryPath], {
        detached: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_GAME_OVERLAY_BROKER_PIPE: this.pipePath,
        },
        stdio: 'ignore',
        windowsHide: true,
      });
      // A detached launch can still fail asynchronously. Connection retries
      // drive the next cooldown-bounded launch, while this listener prevents
      // an unhandled ChildProcess error from terminating the SDK process.
      child.once('error', () => undefined);
      child.unref();
    } catch (error) {
      if (Date.now() >= this.startupDeadline && !this.initialReady) {
        this.failFatal(asError(error, 'Unable to start overlay broker'));
      }
    }
  }

  private failFatal(error: Error): void {
    if (this.fatal) {
      return;
    }
    this.fatal = true;
    this.clearTimers();
    this.rejectReady?.(error);
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    for (const lease of this.targetLeases.values()) {
      this.clearTargetReauthorizationRetry(lease);
      if (!lease.settled) {
        lease.settled = true;
        lease.reject(error);
      }
    }
    this.socket?.destroy();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearHandshakeTimer();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private resetInputTranslators(): void {
    for (const translator of this.inputTranslatorsByPid.values()) {
      translator.reset();
    }
  }

  private stopLegacyTransport(): void {
    const transport = this.legacyTransport;
    const releaseLock = this.legacyLockRelease;
    this.legacyTransport = undefined;
    this.legacyLockRelease = undefined;
    this.legacyReferences = 0;
    transport?.stop();
    releaseLock?.();
  }
}

function cloneWindowDetails(
  details: NativeOverlayWindowDetails,
): NativeOverlayWindowDetails {
  return {
    name: details.name,
    transparent: details.transparent,
    rect: { ...details.rect },
    ...(details.caption ? { caption: { ...details.caption } } : {}),
    ...(details.scaleFactorMicros === undefined
      ? {}
      : { scaleFactorMicros: details.scaleFactorMicros }),
  };
}

function decodeRetainedFrame(packet: Buffer): Readonly<{
  width: number;
  height: number;
  pixels: Buffer;
}> {
  if (packet.byteLength < 17 || packet.readUInt8(4) !== 2) {
    throw new Error('Retained overlay broker frame is invalid');
  }
  return Object.freeze({
    width: packet.readUInt32LE(9),
    height: packet.readUInt32LE(13),
    pixels: packet.subarray(17),
  });
}

/** @internal Atomic, crash-releasing ownership for the fixed legacy endpoint. */
export async function acquireLegacyGlobalRendezvousLock(
  pipePath = `${defaultOverlayBrokerPipePath()}${LEGACY_GLOBAL_LOCK_PIPE_SUFFIX}`,
): Promise<Disposable> {
  if (typeof pipePath !== 'string' || pipePath.length === 0) {
    throw new TypeError(
      'Legacy overlay rendezvous lock path must be non-empty',
    );
  }
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(
        isErrnoCode(error, 'EADDRINUSE')
          ? new Error(
              'The legacy untargeted overlay rendezvous is already owned by another application; use an exact PID attachment for multi-application overlays',
            )
          : error,
      );
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipePath);
  });
  server.on('error', (error) => {
    console.warn(
      `Legacy overlay rendezvous ownership listener failed: ${String(error)}`,
    );
  });
  server.unref();

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    try {
      server.close();
    } catch (error) {
      if (!isErrnoCode(error, 'ERR_SERVER_NOT_RUNNING')) {
        console.warn(
          `Unable to release legacy overlay rendezvous ownership: ${String(error)}`,
        );
      }
    }
  };
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function parseBrokerWelcome(
  value: Record<string, unknown>,
): OverlayBrokerWelcome | null {
  if (
    value.type !== 'broker.welcome' ||
    value.protocolVersion !== OVERLAY_BROKER_PROTOCOL_VERSION ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((capability) => typeof capability === 'string') ||
    typeof value.sessionId !== 'string' ||
    !isPositiveUint32(value.brokerPid)
  ) {
    return null;
  }
  return value as OverlayBrokerWelcome;
}

function parseTargetAuthorized(
  value: Record<string, unknown>,
): OverlayBrokerTargetAuthorized | null {
  if (
    value.type !== 'broker.target.authorized' ||
    typeof value.requestId !== 'string' ||
    !isPositiveUint32(value.pid) ||
    (value.disposition !== 'injection-owner' &&
      value.disposition !== 'joined-existing') ||
    typeof value.discoveryPath !== 'string'
  ) {
    return null;
  }
  if (value.target !== undefined) {
    if (
      !isRecord(value.target) ||
      !isPositiveUint32(value.target.pid) ||
      typeof value.target.executablePath !== 'string' ||
      typeof value.target.discoveryPath !== 'string'
    ) {
      return null;
    }
  }
  return value as OverlayBrokerTargetAuthorized;
}

function parseBrokerError(
  value: Record<string, unknown>,
): OverlayBrokerError | null {
  if (
    value.type !== 'broker.error' ||
    typeof value.code !== 'string' ||
    typeof value.message !== 'string' ||
    (value.requestId !== undefined && typeof value.requestId !== 'string') ||
    (value.pid !== undefined && !isPositiveUint32(value.pid))
  ) {
    return null;
  }
  return value as OverlayBrokerError;
}

function parseWindowOrder(
  value: Record<string, unknown>,
): OverlayBrokerWindowOrder | null {
  if (
    value.type !== 'broker.window.order' ||
    !isPositiveUint32(value.windowId) ||
    !isOverlayBrokerWindowOrderToken(value.orderToken)
  ) {
    return null;
  }
  return value as OverlayBrokerWindowOrder;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveUint32(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 0xffff_ffff
  );
}

function assertPositiveUint32(value: number, name: string): void {
  if (!isPositiveUint32(value)) {
    throw new RangeError(`${name} must be a positive uint32 integer`);
  }
}

function validateRuntimeProviderMetadata(
  metadata: NativeRuntimeProviderMetadata,
): void {
  assertPositiveUint32(metadata.runtimeGeneration, 'runtimeGeneration');
  assertPositiveUint32(metadata.targetTransportMin, 'targetTransportMin');
  assertPositiveUint32(metadata.targetTransportMax, 'targetTransportMax');
  if (metadata.targetTransportMin > metadata.targetTransportMax) {
    throw new RangeError(
      'targetTransportMin must be less than or equal to targetTransportMax',
    );
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function targetAuthorizationAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Overlay target authorization was canceled');
}
