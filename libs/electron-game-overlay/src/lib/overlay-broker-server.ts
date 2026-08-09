import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import type {
  NativeOverlayWindowDetails,
  NativeOverlayWindowGeometry,
} from './native.js';
import { parseOverlayDiagnostic } from './diagnostic.js';
import {
  BackpressurePacketQueue,
  clearOverlayTargetRecoveryClaimForExitedPid,
  OverlayLoopbackTransport,
  overlayTargetRecoveryClaimMayHaveBeenConsumed,
  readOverlayTargetRecoveryClaim,
  type OverlayTargetRecoveryClaim,
  type OverlayTargetRouteAuthorizationContext,
} from './overlay-loopback-transport.js';
import {
  BrokerPacketDecoder,
  OVERLAY_BROKER_CAPABILITIES,
  OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY,
  OVERLAY_BROKER_PROTOCOL_VERSION,
  OVERLAY_BROKER_TARGET_TRANSPORT_VERSION,
  defaultOverlayBrokerPipePath,
  encodeBrokerJsonPacket,
  getOverlayBrokerClientSupportedCapabilities,
  getOverlayBrokerTargetRuntimeProviderMetadata,
  negotiateOverlayBrokerProtocol,
  parseOverlayBrokerClientMessage,
  supportsOverlayBrokerTargetTransport,
  type OverlayBrokerClientHello,
  type OverlayBrokerError,
  type OverlayBrokerFrame,
  type OverlayBrokerInputIntercept,
  type OverlayBrokerServerMessage,
  type OverlayBrokerTargetAuthorize,
  type OverlayBrokerTargetAuthorized,
  type OverlayBrokerTargetIdentity,
  type OverlayBrokerTargetRelease,
  type OverlayBrokerWindowBounds,
  type OverlayBrokerWindowClose,
  type OverlayBrokerWindowUpsert,
} from './overlay-broker-protocol.js';
import type { Disposable } from './types.js';

const CLIENT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_SHUTDOWN_MS = 30_000;
const DEFAULT_RUNTIME_PROVIDER_ELECTION_WINDOW_MS = 50;
const DEFAULT_PROCESS_EXIT_POLL_INTERVAL_MS = 250;
const MAX_WINDOW_ORDER_VALUE = (1n << 128n) - 1n;

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

export interface OverlayBrokerTargetTransport {
  start(): void;
  whenReady(): Promise<unknown>;
  authorizeTarget(
    pid: number,
    discoveryPath: string,
    expectedExecutablePath?: string,
    routeContext?: OverlayTargetRouteAuthorizationContext,
  ): Promise<Disposable>;
  stop(): void;
  setDiagnosticCallback?(callback: (diagnostic: unknown) => void): void;
  setEventCallback(callback: (event: string, payload: unknown) => void): void;
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
  /** Updates only retained snapshot order after the runtime raises a window. */
  raiseWindowForSnapshot?(windowId: number): void;
}

export type OverlayBrokerTargetTransportFactory = (
  pid: number,
) => OverlayBrokerTargetTransport;

export type OverlayBrokerServerOptions = Readonly<{
  pipePath?: string;
  capabilities?: readonly string[];
  targetTransportFactory?: OverlayBrokerTargetTransportFactory;
  sessionIdFactory?: () => string;
  /** Set false for an embedded broker whose caller owns its lifetime. */
  idleShutdownMs?: number | false;
  /**
   * Time allowed for independently starting applications to advertise a
   * newer compatible runtime before target initialization begins.
   */
  runtimeProviderElectionWindowMs?: number;
  /** Injectable process probe used only after a granted owner disappears. */
  isProcessAlive?: (pid: number) => boolean;
  /** Poll cadence for fail-closed retirement of an unauthenticated grant. */
  processExitPollIntervalMs?: number;
  /** Injectable probe for a durable route claim left by another broker. */
  targetRecoveryClaimProbe?: (
    pid: number,
  ) => OverlayTargetRecoveryClaim | undefined;
  /** Clears durable route evidence only after definitive target exit. */
  clearTargetRecoveryClaim?: (pid: number) => void;
}>;

type TargetRecoveryClaimState =
  | Readonly<{
      kind: 'valid';
      claim: OverlayTargetRecoveryClaim;
      mayHaveBeenConsumed: boolean;
    }>
  | Readonly<{ kind: 'opaque' }>;

type RetainedFrame = Readonly<{
  width: number;
  height: number;
  pixels: Buffer;
}>;

type BrokerWindowState = {
  details: NativeOverlayWindowDetails;
  orderToken: string;
  latestFrame?: RetainedFrame;
};

type TargetMemberState = 'authorizing-owner' | 'joined' | 'owner' | 'waiting';

interface TargetMember {
  client: BrokerClientSession;
  requestId: string;
  discoveryPath: string;
  expectedExecutablePath?: string;
  arrivalOrder: number;
  runtimeGeneration: number;
  canProvideTargetTransport: boolean;
  leaseId?: string;
  recovering: boolean;
  routeEstablished: boolean;
  state: TargetMemberState;
  active: boolean;
}

interface BrokerWindowOwner {
  client: BrokerClientSession;
  localWindowId: number;
}

interface BrokerClientSession {
  id: string;
  socket: Socket;
  writer: BackpressurePacketQueue;
  decoder: BrokerPacketDecoder;
  handshakeTimer: ReturnType<typeof setTimeout>;
  hello?: OverlayBrokerClientHello;
  closed: boolean;
  inputIntercept: boolean;
  windows: Map<number, BrokerWindowState>;
  targets: Map<number, OverlayBrokerTargetHost>;
  send(message: OverlayBrokerServerMessage): void;
}

/**
 * One broker-side aggregate scene and one authenticated target transport for an
 * exact PID. Every application keeps its local BrowserWindow IDs; this host is
 * the only layer that allocates IDs visible inside the injected runtime.
 */
export class OverlayBrokerTargetHost {
  private readonly members = new Map<BrokerClientSession, TargetMember>();
  private readonly mappingsByClient = new Map<
    BrokerClientSession,
    Map<number, number>
  >();
  private readonly ownersByTargetWindowId = new Map<
    number,
    BrokerWindowOwner
  >();
  private readonly waiters: TargetMember[] = [];
  private readonly retainedTargetSurfaces = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  private readonly ready: Promise<unknown>;
  private owner: TargetMember | undefined;
  private authorizationRelease: Disposable | undefined;
  private authorizationPending = false;
  private frozenAuthorizationStarted = false;
  private recoveryTombstone = false;
  private recoveryTombstonePath: string | undefined;
  private recoveryTombstoneExpectedExecutablePath: string | undefined;
  private recoveryClaimState: TargetRecoveryClaimState | undefined;
  private recoveringPinnedRoute = false;
  private recoveryMustWaitForAuthentication = false;
  private activeDiscoveryPath: string | undefined;
  private targetIdentity: OverlayBrokerTargetIdentity | undefined;
  private retainedGraphicsFps: Readonly<Record<string, unknown>> | undefined;
  private retainedInputInterception:
    Readonly<Record<string, unknown>> | undefined;
  private nextTargetWindowId = 1;
  private everAuthenticated = false;
  private targetConnected = false;
  private terminalTargetExited = false;
  private disposed = false;
  private nextMemberArrivalOrder = 1;
  private electionWindowElapsed = false;
  private electionTimer: ReturnType<typeof setTimeout> | undefined;
  private frozenTargetExitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    public readonly pid: number,
    private readonly transport: OverlayBrokerTargetTransport,
    private readonly runtimeProviderElectionWindowMs: number,
    private readonly isProcessAlive: (pid: number) => boolean,
    private readonly processExitPollIntervalMs: number,
    initialRecoveryClaimState: TargetRecoveryClaimState | undefined,
    private readonly targetRecoveryClaimProbe: (
      pid: number,
    ) => OverlayTargetRecoveryClaim | undefined,
    private readonly clearTargetRecoveryClaim: (pid: number) => void,
    private readonly onMemberRejected: (
      host: OverlayBrokerTargetHost,
      client: BrokerClientSession,
    ) => void,
    private readonly onTerminal: (host: OverlayBrokerTargetHost) => void,
    private readonly onWindowRaised: (
      client: BrokerClientSession,
      localWindowId: number,
    ) => void,
  ) {
    transport.setEventCallback((event, payload) => {
      this.handleTargetEvent(event, payload);
    });
    transport.setDiagnosticCallback?.((diagnostic) => {
      this.broadcast({ type: 'broker.diagnostic', diagnostic });
    });
    try {
      transport.start();
      this.ready = transport.whenReady();
    } catch (error) {
      this.ready = Promise.reject(error);
    }
    void this.ready.catch(() => undefined);
    if (initialRecoveryClaimState) {
      this.installRecoveryClaimState(initialRecoveryClaimState);
      queueMicrotask(() => this.pollFrozenTargetExit());
    }
  }

  public get isEmpty(): boolean {
    return this.members.size === 0;
  }

  /** Granted or authenticated hosts pin rendezvous until authoritative exit. */
  public get canRetireWhenEmpty(): boolean {
    return (
      this.members.size === 0 &&
      !this.everAuthenticated &&
      !this.frozenAuthorizationStarted &&
      !this.recoveringPinnedRoute &&
      !this.recoveryTombstone
    );
  }

  public hasMember(client: BrokerClientSession): boolean {
    return this.members.has(client);
  }

  public addMember(
    client: BrokerClientSession,
    request: OverlayBrokerTargetAuthorize,
  ): void {
    if (this.disposed) {
      this.sendError(
        client,
        'target-unavailable',
        `Target PID ${this.pid} is no longer available.`,
        request,
      );
      this.onMemberRejected(this, client);
      return;
    }
    const member: TargetMember = {
      client,
      requestId: request.requestId,
      discoveryPath: request.discoveryPath,
      ...(request.expectedExecutablePath === undefined
        ? {}
        : { expectedExecutablePath: request.expectedExecutablePath }),
      arrivalOrder: this.nextMemberArrivalOrder,
      runtimeGeneration: 1,
      canProvideTargetTransport: false,
      ...(request.leaseId === undefined ? {} : { leaseId: request.leaseId }),
      recovering: request.recovery === true,
      routeEstablished: request.routeEstablished === true,
      state: 'waiting',
      active: true,
    };
    this.nextMemberArrivalOrder += 1;
    if (!client.hello) {
      this.sendError(
        client,
        'handshake-required',
        'The broker.hello handshake must complete before target authorization.',
        member,
      );
      member.active = false;
      this.onMemberRejected(this, client);
      return;
    }
    const runtimeProvider = getOverlayBrokerTargetRuntimeProviderMetadata(
      request,
      client.hello,
    );
    member.runtimeGeneration = runtimeProvider.runtimeGeneration;
    member.canProvideTargetTransport = supportsOverlayBrokerTargetTransport(
      runtimeProvider,
      OVERLAY_BROKER_TARGET_TRANSPORT_VERSION,
    );
    const recoveryRejection = this.recoveryClaimMemberRejection(member);
    if (recoveryRejection) {
      this.sendError(
        client,
        'target-authorization-failed',
        recoveryRejection,
        member,
      );
      member.active = false;
      this.onMemberRejected(this, client);
      return;
    }
    this.assumeMatchingRecoveryTombstone(member);
    if (
      this.targetIdentity &&
      !memberMatchesTargetExecutable(member, this.targetIdentity)
    ) {
      this.sendError(
        client,
        'target-authorization-failed',
        `Target PID ${this.pid} does not match the requested executable path.`,
        member,
      );
      member.active = false;
      this.onMemberRejected(this, client);
      return;
    }
    this.members.set(client, member);
    this.recomputeInputIntercept();

    if (
      this.everAuthenticated &&
      this.targetConnected &&
      this.activeDiscoveryPath
    ) {
      this.materializeClientWindows(client);
      member.state = 'joined';
      this.replayTargetSnapshot(client);
      this.sendAuthorized(member, 'joined-existing');
      return;
    }

    this.waiters.push(member);
    this.beginOwnerElection();
    this.promoteNextOwner();
  }

  public removeMember(client: BrokerClientSession): void {
    const member = this.members.get(client);
    if (!member) {
      return;
    }
    member.active = false;
    this.members.delete(client);
    const mapping = this.mappingsByClient.get(client);
    if (mapping) {
      for (const targetWindowId of mapping.values()) {
        this.ownersByTargetWindowId.delete(targetWindowId);
        this.safeTargetMutation(() =>
          this.transport.closeWindow(targetWindowId),
        );
      }
      mapping.clear();
      this.mappingsByClient.delete(client);
    }

    if (this.owner === member) {
      this.owner = undefined;
      if (this.frozenAuthorizationStarted && !this.everAuthenticated) {
        this.pollFrozenTargetExit();
      }
    }
    if (
      member.routeEstablished &&
      !this.everAuthenticated &&
      !this.frozenAuthorizationStarted
    ) {
      this.recoveryTombstone = true;
      this.recoveryTombstonePath = member.discoveryPath;
      this.recoveryTombstoneExpectedExecutablePath =
        member.expectedExecutablePath;
      this.owner = undefined;
      this.clearOwnerElectionTimer();
      this.pollFrozenTargetExit();
    }
    this.recomputeInputIntercept();
    if (!this.everAuthenticated) {
      this.assumeRecoveryFromWaitingMember();
      this.promoteNextOwner();
    }
  }

  public upsertWindow(
    client: BrokerClientSession,
    localWindowId: number,
    state: BrokerWindowState,
  ): void {
    const member = this.members.get(client);
    if (
      !this.mappingsByClient.has(client) &&
      (!member ||
        !member.active ||
        !this.targetIdentity ||
        !memberMatchesTargetExecutable(member, this.targetIdentity))
    ) {
      return;
    }
    this.ensureTargetWindowId(client, localWindowId);
    this.restoreAggregateWindowOrder();
  }

  public updateWindowBounds(
    client: BrokerClientSession,
    localWindowId: number,
    geometry: NativeOverlayWindowGeometry,
  ): void {
    const targetWindowId = this.mappingsByClient
      .get(client)
      ?.get(localWindowId);
    if (targetWindowId === undefined) {
      return;
    }
    this.safeTargetMutation(() =>
      this.transport.sendWindowBounds(
        targetWindowId,
        cloneWindowGeometry(geometry),
      ),
    );
  }

  public closeWindow(client: BrokerClientSession, localWindowId: number): void {
    const mapping = this.mappingsByClient.get(client);
    const targetWindowId = mapping?.get(localWindowId);
    if (targetWindowId === undefined) {
      return;
    }
    mapping?.delete(localWindowId);
    this.ownersByTargetWindowId.delete(targetWindowId);
    this.safeTargetMutation(() => this.transport.closeWindow(targetWindowId));
  }

  public sendFrame(
    client: BrokerClientSession,
    localWindowId: number,
    frame: RetainedFrame,
  ): void {
    const targetWindowId = this.mappingsByClient
      .get(client)
      ?.get(localWindowId);
    if (targetWindowId === undefined) {
      return;
    }
    this.safeTargetMutation(() => {
      this.transport.sendFrameBuffer(
        targetWindowId,
        frame.pixels,
        frame.width,
        frame.height,
      );
    });
  }

  public refreshInputIntercept(): void {
    this.recomputeInputIntercept();
  }

  public raiseWindowForSnapshot(
    client: BrokerClientSession,
    localWindowId: number,
  ): void {
    const targetWindowId = this.mappingsByClient
      .get(client)
      ?.get(localWindowId);
    if (targetWindowId !== undefined) {
      this.transport.raiseWindowForSnapshot?.(targetWindowId);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const member of this.members.values()) {
      member.active = false;
    }
    this.members.clear();
    this.waiters.length = 0;
    this.owner = undefined;
    this.mappingsByClient.clear();
    this.ownersByTargetWindowId.clear();
    this.retainedTargetSurfaces.clear();
    this.retainedGraphicsFps = undefined;
    this.retainedInputInterception = undefined;
    this.targetIdentity = undefined;
    this.targetConnected = false;
    this.clearOwnerElectionTimer();
    this.clearFrozenTargetExitTimer();
    this.releaseAuthorization();
    try {
      this.transport.stop();
    } catch {
      // Broker teardown must continue across target transport failures.
    }
  }

  private installRecoveryClaimState(state: TargetRecoveryClaimState): void {
    this.recoveryClaimState = state;
    this.recoveryTombstone = true;
    this.recoveringPinnedRoute = false;
    if (state.kind === 'valid') {
      this.recoveryTombstonePath = state.claim.discoveryPath;
      this.recoveryTombstoneExpectedExecutablePath =
        state.claim.expectedExecutablePath;
      this.recoveryMustWaitForAuthentication = state.mayHaveBeenConsumed;
    } else {
      this.recoveryTombstonePath = undefined;
      this.recoveryTombstoneExpectedExecutablePath = undefined;
      this.recoveryMustWaitForAuthentication = true;
    }
    this.owner = undefined;
    this.clearOwnerElectionTimer();
  }

  private probeRecoveryClaimState(): TargetRecoveryClaimState | undefined {
    try {
      const claim = this.targetRecoveryClaimProbe(this.pid);
      return claim
        ? Object.freeze({
            kind: 'valid' as const,
            claim,
            mayHaveBeenConsumed:
              overlayTargetRecoveryClaimMayHaveBeenConsumed(claim),
          })
        : undefined;
    } catch {
      return Object.freeze({ kind: 'opaque' as const });
    }
  }

  private recoveryClaimMemberRejection(
    member: TargetMember,
  ): string | undefined {
    const state = this.recoveryClaimState;
    if (!state || this.everAuthenticated) {
      return undefined;
    }
    if (state.kind === 'opaque') {
      return `Target PID ${this.pid} has an unreadable or incompatible durable recovery claim.`;
    }
    const claim = state.claim;
    if (
      member.expectedExecutablePath !== undefined &&
      claim.expectedExecutablePath !== undefined &&
      normalizeOptionalExecutablePathIdentity(member.expectedExecutablePath) !==
        normalizeOptionalExecutablePathIdentity(claim.expectedExecutablePath)
    ) {
      return `Target PID ${this.pid} recovery is pinned to another executable identity.`;
    }
    if (state.mayHaveBeenConsumed) {
      return undefined;
    }
    if (claim.leaseId === undefined) {
      return normalizeDiscoveryPathIdentity(member.discoveryPath) ===
        normalizeDiscoveryPathIdentity(claim.discoveryPath)
        ? undefined
        : `Target PID ${this.pid} has an incomplete legacy route claim for another path.`;
    }
    if (
      !member.recovering ||
      member.leaseId !== claim.leaseId ||
      normalizeDiscoveryPathIdentity(member.discoveryPath) !==
        normalizeDiscoveryPathIdentity(claim.discoveryPath)
    ) {
      return `Target PID ${this.pid} has an incomplete route claim owned by another lease.`;
    }
    return undefined;
  }

  private assumeMatchingRecoveryTombstone(member: TargetMember): void {
    if (!this.recoveryTombstone || !member.canProvideTargetTransport) {
      return;
    }
    const claimState = this.recoveryClaimState;
    if (claimState) {
      if (claimState.kind === 'opaque') {
        return;
      }
      if (this.recoveryClaimMemberRejection(member)) {
        return;
      }
      this.recoveryTombstone = false;
      this.recoveringPinnedRoute = true;
      this.recoveryMustWaitForAuthentication = claimState.mayHaveBeenConsumed;
      this.clearFrozenTargetExitTimer();
      this.pollFrozenTargetExit();
      return;
    }
    if (
      !member.routeEstablished ||
      (this.recoveryTombstonePath !== undefined &&
        normalizeDiscoveryPathIdentity(member.discoveryPath) !==
          normalizeDiscoveryPathIdentity(this.recoveryTombstonePath)) ||
      (member.expectedExecutablePath !== undefined &&
        this.recoveryTombstoneExpectedExecutablePath !== undefined &&
        normalizeOptionalExecutablePathIdentity(
          member.expectedExecutablePath,
        ) !==
          normalizeOptionalExecutablePathIdentity(
            this.recoveryTombstoneExpectedExecutablePath,
          ))
    ) {
      return;
    }
    this.recoveryTombstone = false;
    this.recoveryTombstonePath = undefined;
    this.recoveryTombstoneExpectedExecutablePath = undefined;
    this.recoveryClaimState = undefined;
    this.recoveringPinnedRoute = false;
    this.recoveryMustWaitForAuthentication = false;
    this.clearFrozenTargetExitTimer();
  }

  private assumeRecoveryFromWaitingMember(): void {
    if (!this.recoveryTombstone) {
      return;
    }
    for (const member of this.waiters) {
      if (
        member.active &&
        this.members.get(member.client) === member &&
        !this.recoveryClaimMemberRejection(member)
      ) {
        this.assumeMatchingRecoveryTombstone(member);
        if (!this.recoveryTombstone) {
          return;
        }
      }
    }
  }

  private beginOwnerElection(): void {
    if (
      this.disposed ||
      this.everAuthenticated ||
      this.electionWindowElapsed ||
      this.electionTimer ||
      this.frozenAuthorizationStarted ||
      this.recoveryTombstone ||
      this.owner
    ) {
      return;
    }
    if (this.runtimeProviderElectionWindowMs === 0) {
      this.electionWindowElapsed = true;
      return;
    }
    this.electionTimer = setTimeout(() => {
      this.electionTimer = undefined;
      if (this.disposed || this.everAuthenticated) {
        return;
      }
      this.electionWindowElapsed = true;
      this.promoteNextOwner();
    }, this.runtimeProviderElectionWindowMs);
    this.electionTimer.unref();
  }

  private clearOwnerElectionTimer(): void {
    if (!this.electionTimer) {
      return;
    }
    clearTimeout(this.electionTimer);
    this.electionTimer = undefined;
  }

  private clearFrozenTargetExitTimer(): void {
    if (!this.frozenTargetExitTimer) {
      return;
    }
    clearTimeout(this.frozenTargetExitTimer);
    this.frozenTargetExitTimer = undefined;
  }

  private pollFrozenTargetExit(): void {
    this.clearFrozenTargetExitTimer();
    if (
      this.disposed ||
      this.everAuthenticated ||
      (!this.frozenAuthorizationStarted &&
        !this.recoveryTombstone &&
        !this.recoveringPinnedRoute)
    ) {
      return;
    }
    let alive = true;
    try {
      alive = this.isProcessAlive(this.pid);
    } catch {
      // Failure to inspect a process is not proof that it exited.
    }
    if (!alive) {
      try {
        this.clearTargetRecoveryClaim(this.pid);
      } catch {
        // Cleanup failure cannot turn a confirmed exit back into liveness.
      }
      this.rejectWaitersForExitedFrozenTarget();
      queueMicrotask(() => this.onTerminal(this));
      return;
    }
    this.frozenTargetExitTimer = setTimeout(
      () => this.pollFrozenTargetExit(),
      this.processExitPollIntervalMs,
    );
    this.frozenTargetExitTimer.unref();
  }

  private rejectWaitersForExitedFrozenTarget(): void {
    const rejected = Array.from(this.members.values()).filter(
      (member) => member.active,
    );
    this.waiters.length = 0;
    for (const member of rejected) {
      member.active = false;
      this.members.delete(member.client);
      this.removeClientWindows(member.client);
      this.sendError(
        member.client,
        'target-exited',
        `Target PID ${this.pid} exited before its granted runtime authenticated.`,
        member,
      );
    }
    this.recomputeInputIntercept();
    for (const member of rejected) {
      this.onMemberRejected(this, member.client);
    }
  }

  private takeBestCompatibleWaiter(): TargetMember | undefined {
    let best: TargetMember | undefined;
    const retained: TargetMember[] = [];
    for (const member of this.waiters.splice(0)) {
      if (!member.active || this.members.get(member.client) !== member) {
        continue;
      }
      retained.push(member);
    }
    if (this.hasAmbiguousRecoveryRoutes(retained)) {
      this.waiters.push(...retained);
      this.recoveryTombstone = true;
      this.recoveryTombstonePath = undefined;
      this.recoveryTombstoneExpectedExecutablePath = undefined;
      this.clearOwnerElectionTimer();
      this.pollFrozenTargetExit();
      return undefined;
    }
    for (const member of retained) {
      if (
        member.canProvideTargetTransport &&
        (!best || this.memberOutranks(member, best))
      ) {
        best = member;
      }
    }
    for (const member of retained) {
      if (member !== best) {
        this.waiters.push(member);
      }
    }
    return best;
  }

  private hasAmbiguousRecoveryRoutes(
    members: readonly TargetMember[],
  ): boolean {
    if (this.recoveryClaimState?.kind === 'valid') {
      return false;
    }
    const compatibleRecoveries = members.filter(
      (member) => member.canProvideTargetTransport && member.recovering,
    );
    const established = compatibleRecoveries.filter(
      (member) => member.routeEstablished,
    );
    if (established.length < 2) {
      return false;
    }
    const firstPath = normalizeDiscoveryPathIdentity(
      established[0].discoveryPath,
    );
    return established.some(
      (member) =>
        normalizeDiscoveryPathIdentity(member.discoveryPath) !== firstPath,
    );
  }

  private memberOutranks(
    candidate: TargetMember,
    current: TargetMember,
  ): boolean {
    const claimedLeaseId =
      this.recoveryClaimState?.kind === 'valid'
        ? this.recoveryClaimState.claim.leaseId
        : undefined;
    if (claimedLeaseId !== undefined) {
      const candidateOwnsClaim = candidate.leaseId === claimedLeaseId;
      const currentOwnsClaim = current.leaseId === claimedLeaseId;
      if (candidateOwnsClaim !== currentOwnsClaim) {
        return candidateOwnsClaim;
      }
    }
    if (candidate.routeEstablished !== current.routeEstablished) {
      return candidate.routeEstablished;
    }
    if (candidate.runtimeGeneration !== current.runtimeGeneration) {
      return candidate.runtimeGeneration > current.runtimeGeneration;
    }
    if (
      candidate.leaseId !== undefined &&
      current.leaseId !== undefined &&
      candidate.leaseId !== current.leaseId
    ) {
      return candidate.leaseId.localeCompare(current.leaseId) < 0;
    }
    return candidate.arrivalOrder < current.arrivalOrder;
  }

  private rejectWaitersWithoutCompatibleProvider(): void {
    const rejected = this.waiters
      .splice(0)
      .filter(
        (member) => member.active && this.members.get(member.client) === member,
      );
    if (rejected.length === 0) {
      return;
    }
    for (const member of rejected) {
      member.active = false;
      this.members.delete(member.client);
      this.removeClientWindows(member.client);
      this.sendError(
        member.client,
        'target-authorization-failed',
        `No connected application can provide target transport v${OVERLAY_BROKER_TARGET_TRANSPORT_VERSION} for PID ${this.pid}.`,
        member,
      );
    }
    this.recomputeInputIntercept();
    for (const member of rejected) {
      this.onMemberRejected(this, member.client);
    }
  }

  private promoteNextOwner(): void {
    if (
      this.disposed ||
      this.everAuthenticated ||
      !this.electionWindowElapsed ||
      this.owner ||
      this.authorizationPending ||
      this.frozenAuthorizationStarted ||
      this.recoveryTombstone
    ) {
      return;
    }
    const candidate = this.takeBestCompatibleWaiter();
    if (!candidate) {
      if (this.recoveryTombstone) {
        return;
      }
      this.rejectWaitersWithoutCompatibleProvider();
      return;
    }
    candidate.state = 'authorizing-owner';
    this.owner = candidate;
    this.authorizationPending = true;
    void this.authorizeOwner(candidate);
  }

  private async authorizeOwner(candidate: TargetMember): Promise<void> {
    let release: Disposable | undefined;
    try {
      await this.ready;
      if (
        this.disposed ||
        !candidate.active ||
        this.owner !== candidate ||
        this.members.get(candidate.client) !== candidate
      ) {
        return;
      }
      // Publishing a target authorization route is the point of no return: an
      // injector may observe it before this asynchronous call settles.
      this.frozenAuthorizationStarted = true;
      const recoveryClaim =
        this.recoveryClaimState?.kind === 'valid'
          ? this.recoveryClaimState.claim
          : undefined;
      const authorizationDiscoveryPath =
        this.recoveringPinnedRoute && recoveryClaim
          ? recoveryClaim.discoveryPath
          : candidate.discoveryPath;
      const authorizationExpectedExecutablePath =
        this.recoveringPinnedRoute && recoveryClaim
          ? recoveryClaim.expectedExecutablePath
          : candidate.expectedExecutablePath;
      const resumedUnconsumedIntent =
        this.recoveringPinnedRoute &&
        this.recoveryClaimState?.kind === 'valid' &&
        !this.recoveryClaimState.mayHaveBeenConsumed;
      this.recoveryMustWaitForAuthentication =
        this.recoveringPinnedRoute &&
        this.recoveryClaimState?.kind === 'valid' &&
        this.recoveryClaimState.mayHaveBeenConsumed;
      this.activeDiscoveryPath = authorizationDiscoveryPath;
      this.pollFrozenTargetExit();
      release = await this.transport.authorizeTarget(
        this.pid,
        authorizationDiscoveryPath,
        authorizationExpectedExecutablePath,
        {
          ...(candidate.leaseId === undefined
            ? {}
            : { leaseId: candidate.leaseId }),
          ...(this.recoveryMustWaitForAuthentication
            ? { allowPublishedClaimTakeover: true }
            : {}),
        },
      );
      if (this.disposed || this.terminalTargetExited) {
        release();
        release = undefined;
        return;
      }
      this.authorizationRelease = release;
      release = undefined;
      const refreshedRecoveryClaimState = this.probeRecoveryClaimState();
      if (refreshedRecoveryClaimState) {
        this.recoveryClaimState = refreshedRecoveryClaimState;
      }
      if (this.everAuthenticated && this.targetConnected) {
        if (
          candidate.active &&
          this.members.get(candidate.client) === candidate
        ) {
          if (!this.rejectMismatchedMember(candidate)) {
            candidate.state = 'joined';
            this.sendAuthorized(candidate, 'joined-existing');
          }
        }
        if (this.owner === candidate) {
          this.owner = undefined;
        }
        return;
      }
      if (this.everAuthenticated && !this.targetConnected) {
        if (
          candidate.active &&
          this.members.get(candidate.client) === candidate
        ) {
          candidate.state = 'waiting';
          this.waiters.push(candidate);
        }
        if (this.owner === candidate) {
          this.owner = undefined;
        }
        return;
      }
      if (
        !candidate.active ||
        this.owner !== candidate ||
        this.members.get(candidate.client) !== candidate
      ) {
        this.pollFrozenTargetExit();
        return;
      }
      if (
        candidate.routeEstablished ||
        this.recoveryMustWaitForAuthentication
      ) {
        candidate.state = 'waiting';
        this.waiters.push(candidate);
        this.owner = undefined;
        return;
      }
      // Only the candidate that resumed a pre-consumable intent may receive
      // the original grant after the transport commits that intent on disk.
      if (this.recoveringPinnedRoute && !resumedUnconsumedIntent) {
        candidate.state = 'waiting';
        this.waiters.push(candidate);
        this.owner = undefined;
        return;
      }
      candidate.state = 'owner';
      this.sendAuthorized(candidate, 'injection-owner');
    } catch (error) {
      const routeRetained = this.authorizationRelease !== undefined;
      const durableRecoveryState =
        !this.everAuthenticated && !routeRetained
          ? this.probeRecoveryClaimState()
          : undefined;
      const establishedRecoveryFailure =
        durableRecoveryState === undefined &&
        candidate.routeEstablished &&
        !this.everAuthenticated &&
        !routeRetained;
      if (this.everAuthenticated && this.targetConnected) {
        if (
          candidate.active &&
          this.members.get(candidate.client) === candidate
        ) {
          if (!this.rejectMismatchedMember(candidate)) {
            candidate.state = 'joined';
            this.sendAuthorized(candidate, 'joined-existing');
          }
        }
      } else if (this.everAuthenticated && !this.targetConnected) {
        if (
          candidate.active &&
          this.members.get(candidate.client) === candidate
        ) {
          candidate.state = 'waiting';
          this.waiters.push(candidate);
        }
      } else if (durableRecoveryState) {
        this.frozenAuthorizationStarted = false;
        this.installRecoveryClaimState(durableRecoveryState);
        this.activeDiscoveryPath = undefined;
        this.clearFrozenTargetExitTimer();
        this.pollFrozenTargetExit();
      } else if (establishedRecoveryFailure) {
        this.frozenAuthorizationStarted = false;
        this.recoveryTombstone = true;
        this.recoveryTombstonePath = candidate.discoveryPath;
        this.recoveryTombstoneExpectedExecutablePath =
          candidate.expectedExecutablePath;
        this.activeDiscoveryPath = undefined;
        this.clearFrozenTargetExitTimer();
        this.pollFrozenTargetExit();
      } else if (!routeRetained) {
        this.frozenAuthorizationStarted = false;
        this.activeDiscoveryPath = undefined;
        this.clearFrozenTargetExitTimer();
      }
      if (
        !this.everAuthenticated &&
        !routeRetained &&
        candidate.active &&
        this.members.get(candidate.client) === candidate
      ) {
        this.sendError(
          candidate.client,
          'target-authorization-failed',
          `Unable to authorize target PID ${this.pid}: ${formatUnknownError(error)}`,
          candidate,
        );
        candidate.active = false;
        this.members.delete(candidate.client);
        this.removeClientWindows(candidate.client);
        this.recomputeInputIntercept();
        this.onMemberRejected(this, candidate.client);
      }
      if (this.owner === candidate) {
        this.owner = undefined;
      }
      if (
        !this.everAuthenticated &&
        !routeRetained &&
        this.members.size === 0
      ) {
        this.onMemberRejected(this, candidate.client);
      }
    } finally {
      release?.();
      this.authorizationPending = false;
      if (!candidate.active && this.owner === candidate) {
        this.owner = undefined;
      }
      if (!this.everAuthenticated && !this.frozenAuthorizationStarted) {
        this.assumeRecoveryFromWaitingMember();
        this.promoteNextOwner();
      }
    }
  }

  private sendAuthorized(
    member: TargetMember,
    disposition: OverlayBrokerTargetAuthorized['disposition'],
  ): void {
    const discoveryPath = this.activeDiscoveryPath ?? member.discoveryPath;
    member.client.send({
      type: 'broker.target.authorized',
      requestId: member.requestId,
      pid: this.pid,
      disposition,
      discoveryPath,
      ...(this.targetIdentity === undefined
        ? {}
        : {
            target: Object.freeze({
              ...this.targetIdentity,
              discoveryPath,
            }),
          }),
    });
  }

  private flushJoinedWaiters(): void {
    for (const member of this.waiters.splice(0)) {
      if (
        !member.active ||
        this.members.get(member.client) !== member ||
        member === this.owner
      ) {
        continue;
      }
      member.state = 'joined';
      this.sendAuthorized(member, 'joined-existing');
    }
  }

  private rejectMismatchedMembers(): void {
    for (const member of Array.from(this.members.values())) {
      if (this.rejectMismatchedMember(member) && this.owner === member) {
        this.owner = undefined;
      }
    }
    const retained = this.waiters
      .splice(0)
      .filter(
        (member) => member.active && this.members.get(member.client) === member,
      );
    this.waiters.push(...retained);
  }

  private rejectMismatchedMember(member: TargetMember): boolean {
    if (
      !this.targetIdentity ||
      memberMatchesTargetExecutable(member, this.targetIdentity)
    ) {
      return false;
    }
    this.sendError(
      member.client,
      'target-authorization-failed',
      `Target PID ${this.pid} does not match the requested executable path.`,
      member,
    );
    member.active = false;
    this.members.delete(member.client);
    this.removeClientWindows(member.client);
    this.recomputeInputIntercept();
    this.onMemberRejected(this, member.client);
    return true;
  }

  private materializeClientWindows(client: BrokerClientSession): void {
    for (const localWindowId of client.windows.keys()) {
      this.ensureTargetWindowId(client, localWindowId);
    }
    this.restoreAggregateWindowOrder();
  }

  private restoreAggregateWindowOrder(): void {
    const ordered = Array.from(this.ownersByTargetWindowId.entries())
      .map(([targetWindowId, owner]) => ({
        targetWindowId,
        owner,
        state: owner.client.windows.get(owner.localWindowId),
      }))
      .filter(
        (entry): entry is typeof entry & { state: BrokerWindowState } =>
          entry.state !== undefined,
      )
      .sort((left, right) =>
        left.state.orderToken.localeCompare(right.state.orderToken),
      );
    this.safeTargetMutation(() => {
      for (const { targetWindowId, state } of ordered) {
        this.transport.addWindow(
          targetWindowId,
          cloneWindowDetails(state.details),
        );
      }
      for (const { targetWindowId, state } of ordered) {
        if (state.latestFrame) {
          this.transport.sendFrameBuffer(
            targetWindowId,
            state.latestFrame.pixels,
            state.latestFrame.width,
            state.latestFrame.height,
          );
        }
      }
    });
  }

  private ensureTargetWindowId(
    client: BrokerClientSession,
    localWindowId: number,
  ): number {
    let mapping = this.mappingsByClient.get(client);
    if (!mapping) {
      mapping = new Map();
      this.mappingsByClient.set(client, mapping);
    }
    const existing = mapping.get(localWindowId);
    if (existing !== undefined) {
      return existing;
    }
    if (this.nextTargetWindowId > 0xffffffff) {
      throw new Error(
        `Target PID ${this.pid} exhausted its broker window identifier space.`,
      );
    }
    const targetWindowId = this.nextTargetWindowId;
    this.nextTargetWindowId += 1;
    mapping.set(localWindowId, targetWindowId);
    this.ownersByTargetWindowId.set(targetWindowId, {
      client,
      localWindowId,
    });
    return targetWindowId;
  }

  private removeClientWindows(client: BrokerClientSession): void {
    const mapping = this.mappingsByClient.get(client);
    if (!mapping) {
      return;
    }
    for (const targetWindowId of mapping.values()) {
      this.ownersByTargetWindowId.delete(targetWindowId);
      this.safeTargetMutation(() => this.transport.closeWindow(targetWindowId));
    }
    mapping.clear();
    this.mappingsByClient.delete(client);
  }

  private recomputeInputIntercept(): void {
    if (this.disposed) {
      return;
    }
    const intercept = Array.from(this.members.values()).some(
      (member) =>
        member.active &&
        member.client.inputIntercept &&
        this.targetIdentity !== undefined &&
        memberMatchesTargetExecutable(member, this.targetIdentity),
    );
    if (
      this.retainedInputInterception?.intercepting !== undefined &&
      this.retainedInputInterception.intercepting !== intercept
    ) {
      this.retainedInputInterception = undefined;
    }
    this.safeTargetMutation(() => this.transport.setInputIntercept(intercept));
  }

  private handleTargetEvent(event: string, payload: unknown): void {
    if (this.disposed || !isRecord(payload)) {
      return;
    }
    if (event === 'game.process') {
      if (payload.pid !== this.pid || typeof payload.path !== 'string') {
        return;
      }
      this.clearOwnerElectionTimer();
      this.clearFrozenTargetExitTimer();
      this.everAuthenticated = true;
      const discoveryPath = this.activeDiscoveryPath;
      if (!discoveryPath) {
        return;
      }
      this.targetIdentity = Object.freeze({
        pid: this.pid,
        executablePath: payload.path,
        discoveryPath,
      });
      this.targetConnected = true;
      this.rejectMismatchedMembers();
      for (const member of this.members.values()) {
        if (
          member.active &&
          !this.mappingsByClient.has(member.client) &&
          memberMatchesTargetExecutable(member, this.targetIdentity)
        ) {
          this.materializeClientWindows(member.client);
        }
      }
      this.recomputeInputIntercept();
      this.broadcast({ type: event, ...payload });
      this.flushJoinedWaiters();
      return;
    }
    if (event === 'game.process.transport-lost') {
      this.targetConnected = false;
      this.retainedInputInterception = undefined;
      this.broadcast({ type: event, ...payload });
      return;
    }
    if (event === 'game.process.disconnected') {
      this.clearOwnerElectionTimer();
      this.clearFrozenTargetExitTimer();
      this.targetConnected = false;
      this.terminalTargetExited = true;
      try {
        this.clearTargetRecoveryClaim(this.pid);
      } catch {
        // Definitive process exit remains terminal even if evidence cleanup fails.
      }
      const waitingMembers = this.waiters
        .splice(0)
        .filter(
          (member) =>
            member.active &&
            this.members.get(member.client) === member &&
            member !== this.owner,
        );
      if (
        this.owner?.active &&
        this.owner.state === 'authorizing-owner' &&
        this.members.get(this.owner.client) === this.owner
      ) {
        waitingMembers.push(this.owner);
      }
      const waitingClients = new Set(
        waitingMembers.map((member) => member.client),
      );
      for (const member of this.members.values()) {
        if (!waitingClients.has(member.client)) {
          member.client.send({ type: event, ...payload });
        }
      }
      for (const member of waitingMembers) {
        if (member.active && this.members.get(member.client) === member) {
          this.sendError(
            member.client,
            'target-exited',
            `Target PID ${this.pid} exited before its broker lease became ready.`,
            member,
          );
        }
      }
      queueMicrotask(() => this.onTerminal(this));
      return;
    }
    if (event === 'game.target.surface') {
      this.retainTargetSurface(payload);
      this.broadcast({ type: event, ...payload });
      return;
    }
    if (event === 'game.target.surface.removed') {
      this.removeRetainedTargetSurface(payload);
      this.broadcast({ type: event, ...payload });
      return;
    }
    if (event === 'game.graphics.fps') {
      this.retainedGraphicsFps = Object.freeze({ ...payload });
      this.broadcast({ type: event, ...payload });
      return;
    }
    if (event === 'game.input.intercept') {
      this.retainedInputInterception = Object.freeze({ ...payload });
      this.broadcast({ type: event, ...payload });
      return;
    }
    if (event === 'game.input') {
      const targetWindowId = payload.windowId;
      if (!isPositiveUint32(targetWindowId)) {
        return;
      }
      const owner = this.ownersByTargetWindowId.get(targetWindowId);
      if (!owner || !this.members.has(owner.client)) {
        return;
      }
      owner.client.send({
        type: event,
        ...payload,
        windowId: owner.localWindowId,
      });
      return;
    }
    if (event === 'game.window.focused') {
      const targetWindowId = payload.focusWindowId;
      if (!isUint32(targetWindowId)) {
        return;
      }
      if (targetWindowId === 0) {
        this.broadcast({ type: event, ...payload });
        return;
      }
      const owner = this.ownersByTargetWindowId.get(targetWindowId);
      if (!owner || !this.members.has(owner.client)) {
        return;
      }
      this.onWindowRaised(owner.client, owner.localWindowId);
      for (const member of this.members.values()) {
        member.client.send({
          type: event,
          ...payload,
          focusWindowId:
            member.client === owner.client ? owner.localWindowId : 0,
        });
      }
      return;
    }
    this.broadcast({ type: event as `game.${string}`, ...payload });
  }

  private replayTargetSnapshot(client: BrokerClientSession): void {
    if (!this.targetIdentity) {
      return;
    }
    client.send({
      type: 'game.process',
      pid: this.pid,
      path: this.targetIdentity.executablePath,
    });
    for (const surface of this.retainedTargetSurfaces.values()) {
      client.send({ type: 'game.target.surface', ...surface });
    }
    if (this.retainedGraphicsFps) {
      client.send({
        type: 'game.graphics.fps',
        ...this.retainedGraphicsFps,
      });
    }
    if (this.retainedInputInterception) {
      client.send({
        type: 'game.input.intercept',
        ...this.retainedInputInterception,
      });
    }
  }

  private retainTargetSurface(payload: Record<string, unknown>): void {
    const surfaceId = payload.surfaceId;
    const revision = payload.revision;
    if (
      typeof surfaceId !== 'string' ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision)
    ) {
      return;
    }
    const existing = this.retainedTargetSurfaces.get(surfaceId);
    if (
      existing &&
      typeof existing.revision === 'number' &&
      existing.revision > revision
    ) {
      return;
    }
    this.retainedTargetSurfaces.delete(surfaceId);
    this.retainedTargetSurfaces.set(surfaceId, Object.freeze({ ...payload }));
  }

  private removeRetainedTargetSurface(payload: Record<string, unknown>): void {
    const surfaceId = payload.surfaceId;
    const revision = payload.revision;
    if (
      typeof surfaceId !== 'string' ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision)
    ) {
      return;
    }
    const existing = this.retainedTargetSurfaces.get(surfaceId);
    if (
      existing &&
      typeof existing.revision === 'number' &&
      existing.revision <= revision
    ) {
      this.retainedTargetSurfaces.delete(surfaceId);
    }
  }

  private broadcast(message: OverlayBrokerServerMessage): void {
    for (const member of this.members.values()) {
      member.client.send(message);
    }
  }

  private releaseAuthorization(): void {
    const release = this.authorizationRelease;
    this.authorizationRelease = undefined;
    this.frozenAuthorizationStarted = false;
    this.recoveryTombstone = false;
    this.recoveryTombstonePath = undefined;
    this.recoveryTombstoneExpectedExecutablePath = undefined;
    this.recoveryClaimState = undefined;
    this.recoveringPinnedRoute = false;
    this.recoveryMustWaitForAuthentication = false;
    this.activeDiscoveryPath = undefined;
    this.clearFrozenTargetExitTimer();
    if (release) {
      try {
        release();
      } catch {
        // A failed release must not strand logical broker leases.
      }
    }
  }

  private safeTargetMutation(mutation: () => void): void {
    if (this.disposed) {
      return;
    }
    try {
      mutation();
    } catch {
      const diagnostic = parseOverlayDiagnostic({
        schemaVersion: 1,
        source: 'electron-overlay-transport',
        severity: 'warning',
        code: 'target-socket-error',
        pid: this.pid,
      });
      if (diagnostic) {
        this.broadcast({ type: 'broker.diagnostic', diagnostic });
      }
    }
  }

  private sendError(
    client: BrokerClientSession,
    code: OverlayBrokerError['code'],
    message: string,
    request: Pick<TargetMember, 'requestId'> & { pid?: number },
  ): void {
    client.send({
      type: 'broker.error',
      code,
      message,
      requestId: request.requestId,
      pid: request.pid ?? this.pid,
    });
  }
}

/** Standalone named-pipe broker server. */
export class OverlayBrokerServer {
  public readonly pipePath: string;
  public readonly capabilities: readonly string[];

  private readonly capabilitiesSet: ReadonlySet<string>;
  private readonly targetTransportFactory: OverlayBrokerTargetTransportFactory;
  private readonly sessionIdFactory: () => string;
  private readonly idleShutdownMs: number | false;
  private readonly runtimeProviderElectionWindowMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processExitPollIntervalMs: number;
  private readonly targetRecoveryClaimProbe: (
    pid: number,
  ) => OverlayTargetRecoveryClaim | undefined;
  private readonly clearTargetRecoveryClaim: (pid: number) => void;
  private readonly clients = new Set<BrokerClientSession>();
  private readonly targets = new Map<number, OverlayBrokerTargetHost>();
  private readonly windowOrderClaims = new Map<string, BrokerWindowOwner>();
  private nextWindowOrderValue = 1n;
  private server: Server | undefined;
  private ready: Promise<void> | undefined;
  private idleShutdownTimer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;

  constructor(options: OverlayBrokerServerOptions = {}) {
    this.pipePath = options.pipePath ?? defaultOverlayBrokerPipePath();
    this.capabilities = Object.freeze([
      ...(options.capabilities ?? OVERLAY_BROKER_CAPABILITIES),
    ]);
    this.capabilitiesSet = new Set(this.capabilities);
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
    this.idleShutdownMs =
      options.idleShutdownMs === undefined
        ? DEFAULT_IDLE_SHUTDOWN_MS
        : options.idleShutdownMs;
    this.runtimeProviderElectionWindowMs =
      options.runtimeProviderElectionWindowMs ??
      DEFAULT_RUNTIME_PROVIDER_ELECTION_WINDOW_MS;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.processExitPollIntervalMs =
      options.processExitPollIntervalMs ??
      DEFAULT_PROCESS_EXIT_POLL_INTERVAL_MS;
    this.targetRecoveryClaimProbe =
      options.targetRecoveryClaimProbe ?? readOverlayTargetRecoveryClaim;
    this.clearTargetRecoveryClaim =
      options.clearTargetRecoveryClaim ??
      clearOverlayTargetRecoveryClaimForExitedPid;
    if (
      this.idleShutdownMs !== false &&
      (!Number.isSafeInteger(this.idleShutdownMs) ||
        this.idleShutdownMs <= 0 ||
        this.idleShutdownMs > 10 * 60_000)
    ) {
      throw new RangeError(
        'idleShutdownMs must be false or an integer between 1 and 600000',
      );
    }
    if (
      !Number.isSafeInteger(this.runtimeProviderElectionWindowMs) ||
      this.runtimeProviderElectionWindowMs < 0 ||
      this.runtimeProviderElectionWindowMs > 10_000
    ) {
      throw new RangeError(
        'runtimeProviderElectionWindowMs must be an integer between 0 and 10000',
      );
    }
    if (
      !Number.isSafeInteger(this.processExitPollIntervalMs) ||
      this.processExitPollIntervalMs < 1 ||
      this.processExitPollIntervalMs > 60_000
    ) {
      throw new RangeError(
        'processExitPollIntervalMs must be an integer between 1 and 60000',
      );
    }
    const instanceId = randomUUID();
    this.targetTransportFactory =
      options.targetTransportFactory ??
      ((pid) =>
        new OverlayLoopbackTransport({
          discoveryPath: join(
            tmpdir(),
            'electron-game-overlay',
            'broker-v1',
            instanceId,
            `target-${pid}.host.json`,
          ),
        }));
  }

  public start(): Promise<void> {
    if (this.ready) {
      return this.ready;
    }
    this.stopping = false;
    const server = createServer((socket) => this.acceptClient(socket));
    this.server = server;
    this.ready = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        if (this.server === server) {
          this.server = undefined;
          this.ready = undefined;
        }
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        server.on('error', (error) => {
          if (!this.stopping) {
            for (const client of this.clients) {
              this.sendError(
                client,
                'target-unavailable',
                `The overlay broker listener failed: ${formatUnknownError(error)}`,
              );
            }
          }
        });
        this.scheduleIdleShutdownIfEligible();
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.pipePath);
    });
    void this.ready.catch(() => undefined);
    return this.ready;
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.clearIdleShutdown();
    const server = this.server;
    this.server = undefined;
    this.ready = undefined;
    for (const client of Array.from(this.clients)) {
      client.closed = true;
      clearTimeout(client.handshakeTimer);
      client.writer.clear();
      client.socket.destroy();
      this.cleanupClient(client);
    }
    for (const target of this.targets.values()) {
      target.dispose();
    }
    this.targets.clear();
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private acceptClient(socket: Socket): void {
    this.clearIdleShutdown();
    socket.setNoDelay(true);
    let client: BrokerClientSession;
    const writer = new BackpressurePacketQueue(socket, () => socket.destroy());
    const handshakeTimer = setTimeout(() => {
      if (!client.hello) {
        this.sendError(
          client,
          'handshake-required',
          'The overlay broker client handshake timed out.',
        );
        socket.destroy();
      }
    }, CLIENT_HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref();
    client = {
      id: this.sessionIdFactory(),
      socket,
      writer,
      decoder: new BrokerPacketDecoder(),
      handshakeTimer,
      closed: false,
      inputIntercept: false,
      windows: new Map(),
      targets: new Map(),
      send: (message) => {
        if (!client.closed && !socket.destroyed) {
          writer.sendControl(encodeBrokerJsonPacket(message));
        }
      },
    };
    this.clients.add(client);
    socket.on('data', (chunk: Buffer) => this.receiveClientData(client, chunk));
    socket.on('drain', () => writer.handleDrain());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (client.closed) {
        return;
      }
      client.closed = true;
      clearTimeout(client.handshakeTimer);
      writer.clear();
      this.cleanupClient(client);
    });
  }

  private receiveClientData(client: BrokerClientSession, chunk: Buffer): void {
    let packets;
    try {
      packets = client.decoder.push(chunk);
    } catch (error) {
      this.sendError(
        client,
        'invalid-message',
        `The overlay broker packet was rejected: ${formatUnknownError(error)}`,
      );
      client.socket.destroy();
      return;
    }
    for (const packet of packets) {
      if (packet.kind === 'frame') {
        this.handleFrame(client, packet.frame);
        continue;
      }
      const message = parseOverlayBrokerClientMessage(packet.value);
      if (!message) {
        this.sendError(
          client,
          'invalid-message',
          'The overlay broker JSON message was invalid or unsupported.',
        );
        client.socket.destroy();
        return;
      }
      if (message.type === 'broker.hello') {
        this.handleHello(client, message);
        continue;
      }
      if (!client.hello) {
        this.sendError(
          client,
          'handshake-required',
          'The broker.hello handshake must be the first client message.',
        );
        client.socket.destroy();
        return;
      }
      switch (message.type) {
        case 'broker.target.authorize':
          this.handleTargetAuthorize(client, message);
          break;
        case 'broker.target.release':
          this.handleTargetRelease(client, message);
          break;
        case 'broker.window.upsert':
          this.handleWindowUpsert(client, message);
          break;
        case 'broker.window.bounds':
          this.handleWindowBounds(client, message);
          break;
        case 'broker.window.close':
          this.handleWindowClose(client, message);
          break;
        case 'broker.input.intercept':
          this.handleInputIntercept(client, message);
          break;
      }
    }
  }

  private handleHello(
    client: BrokerClientSession,
    hello: OverlayBrokerClientHello,
  ): void {
    if (client.hello) {
      this.sendError(
        client,
        'invalid-message',
        'The overlay broker handshake was already completed.',
      );
      client.socket.destroy();
      return;
    }
    const negotiation = negotiateOverlayBrokerProtocol(
      hello,
      this.capabilitiesSet,
    );
    if (!negotiation.accepted) {
      this.sendError(client, negotiation.code, negotiation.message);
      setImmediate(() => client.socket.end());
      return;
    }
    clearTimeout(client.handshakeTimer);
    client.hello = hello;
    client.send({
      type: 'broker.welcome',
      protocolVersion: OVERLAY_BROKER_PROTOCOL_VERSION,
      capabilities: this.capabilities,
      sessionId: client.id,
      brokerPid: process.pid,
    });
  }

  private handleTargetAuthorize(
    client: BrokerClientSession,
    request: OverlayBrokerTargetAuthorize,
  ): void {
    if (client.targets.has(request.pid)) {
      this.sendError(
        client,
        'duplicate-target-lease',
        `This broker session already has a lease for target PID ${request.pid}.`,
        request.requestId,
        request.pid,
      );
      return;
    }
    let target = this.targets.get(request.pid);
    if (!target) {
      let transport: OverlayBrokerTargetTransport;
      try {
        let initialRecoveryClaimState: TargetRecoveryClaimState | undefined;
        try {
          const claim = this.targetRecoveryClaimProbe(request.pid);
          if (claim) {
            initialRecoveryClaimState = Object.freeze({
              kind: 'valid',
              claim,
              mayHaveBeenConsumed:
                overlayTargetRecoveryClaimMayHaveBeenConsumed(claim),
            });
          }
        } catch {
          initialRecoveryClaimState = Object.freeze({ kind: 'opaque' });
        }
        transport = this.targetTransportFactory(request.pid);
        target = new OverlayBrokerTargetHost(
          request.pid,
          transport,
          this.runtimeProviderElectionWindowMs,
          this.isProcessAlive,
          this.processExitPollIntervalMs,
          initialRecoveryClaimState,
          this.targetRecoveryClaimProbe,
          this.clearTargetRecoveryClaim,
          (host, rejectedClient) => {
            if (rejectedClient.targets.get(host.pid) === host) {
              rejectedClient.targets.delete(host.pid);
            }
            this.retireTargetIfEmpty(host);
          },
          (host) => this.retireTerminalTarget(host),
          (raisedClient, localWindowId) =>
            this.promoteWindowOrder(raisedClient, localWindowId),
        );
      } catch (error) {
        this.sendError(
          client,
          'target-unavailable',
          `Unable to create target PID ${request.pid}: ${formatUnknownError(error)}`,
          request.requestId,
          request.pid,
        );
        return;
      }
      this.targets.set(request.pid, target);
    }
    client.targets.set(request.pid, target);
    target.addMember(client, request);
  }

  private handleTargetRelease(
    client: BrokerClientSession,
    request: OverlayBrokerTargetRelease,
  ): void {
    const target = client.targets.get(request.pid);
    if (target) {
      client.targets.delete(request.pid);
      target.removeMember(client);
      this.retireTargetIfEmpty(target);
    }
    client.send({
      type: 'broker.target.released',
      requestId: request.requestId,
      pid: request.pid,
    });
  }

  private handleWindowUpsert(
    client: BrokerClientSession,
    message: OverlayBrokerWindowUpsert,
  ): void {
    let orderToken: string;
    try {
      orderToken = this.reserveWindowOrderToken(
        client,
        message.windowId,
        this.clientUsesGlobalWindowOrder(client)
          ? message.orderToken
          : undefined,
      );
    } catch (error) {
      this.sendError(
        client,
        'window-unavailable',
        `Unable to assign overlay window ${message.windowId} order: ${formatUnknownError(error)}`,
      );
      return;
    }
    const details: NativeOverlayWindowDetails = {
      name: message.name,
      transparent: message.transparent,
      rect: { ...message.rect },
      ...(message.caption ? { caption: { ...message.caption } } : {}),
      ...(message.scaleFactorMicros === undefined
        ? {}
        : { scaleFactorMicros: message.scaleFactorMicros }),
    };
    client.windows.delete(message.windowId);
    const state: BrokerWindowState = { details, orderToken };
    client.windows.set(message.windowId, state);
    this.sendWindowOrder(client, message.windowId, orderToken);
    for (const target of client.targets.values()) {
      target.upsertWindow(client, message.windowId, state);
    }
  }

  private handleWindowBounds(
    client: BrokerClientSession,
    message: OverlayBrokerWindowBounds,
  ): void {
    const state = client.windows.get(message.windowId);
    if (!state) {
      this.sendError(
        client,
        'window-unavailable',
        `Overlay window ${message.windowId} is not registered.`,
      );
      return;
    }
    state.details.rect = { ...message.rect };
    if (message.caption) {
      state.details.caption = { ...message.caption };
    }
    if (message.scaleFactorMicros !== undefined) {
      state.details.scaleFactorMicros = message.scaleFactorMicros;
    }
    if (message.rasterChanged) {
      state.latestFrame = undefined;
    }
    const geometry: NativeOverlayWindowGeometry = {
      rect: { ...message.rect },
      ...(message.caption ? { caption: { ...message.caption } } : {}),
      ...(message.scaleFactorMicros === undefined
        ? {}
        : { scaleFactorMicros: message.scaleFactorMicros }),
      ...(message.rasterChanged === undefined
        ? {}
        : { rasterChanged: message.rasterChanged }),
    };
    for (const target of client.targets.values()) {
      target.updateWindowBounds(client, message.windowId, geometry);
    }
  }

  private handleWindowClose(
    client: BrokerClientSession,
    message: OverlayBrokerWindowClose,
  ): void {
    const state = client.windows.get(message.windowId);
    if (!state) {
      return;
    }
    client.windows.delete(message.windowId);
    this.releaseWindowOrderToken(client, message.windowId, state.orderToken);
    for (const target of client.targets.values()) {
      target.closeWindow(client, message.windowId);
    }
  }

  private handleInputIntercept(
    client: BrokerClientSession,
    message: OverlayBrokerInputIntercept,
  ): void {
    client.inputIntercept = message.intercept;
    for (const target of client.targets.values()) {
      target.refreshInputIntercept();
    }
  }

  private handleFrame(
    client: BrokerClientSession,
    frame: OverlayBrokerFrame,
  ): void {
    if (!client.hello) {
      this.sendError(
        client,
        'handshake-required',
        'The broker.hello handshake must precede frame publication.',
      );
      client.socket.destroy();
      return;
    }
    const state = client.windows.get(frame.windowId);
    if (!state) {
      this.sendError(
        client,
        'unexpected-frame',
        `Overlay frame references unregistered window ${frame.windowId}.`,
      );
      return;
    }
    const retained: RetainedFrame = Object.freeze({
      width: frame.width,
      height: frame.height,
      pixels: Buffer.from(frame.pixels),
    });
    state.latestFrame = retained;
    for (const target of client.targets.values()) {
      target.sendFrame(client, frame.windowId, retained);
    }
  }

  private cleanupClient(client: BrokerClientSession): void {
    this.clients.delete(client);
    for (const target of Array.from(client.targets.values())) {
      client.targets.delete(target.pid);
      target.removeMember(client);
      this.retireTargetIfEmpty(target);
    }
    for (const [localWindowId, state] of client.windows) {
      this.releaseWindowOrderToken(client, localWindowId, state.orderToken);
    }
    client.windows.clear();
    this.scheduleIdleShutdownIfEligible();
  }

  private promoteWindowOrder(
    client: BrokerClientSession,
    localWindowId: number,
  ): void {
    const state = client.windows.get(localWindowId);
    if (!state) {
      return;
    }
    const orderToken = this.reserveWindowOrderToken(client, localWindowId);
    state.orderToken = orderToken;
    this.sendWindowOrder(client, localWindowId, orderToken);
    for (const target of client.targets.values()) {
      target.raiseWindowForSnapshot(client, localWindowId);
    }
  }

  private reserveWindowOrderToken(
    client: BrokerClientSession,
    localWindowId: number,
    requestedToken?: string,
  ): string {
    const existingToken = client.windows.get(localWindowId)?.orderToken;
    const requestedClaim =
      requestedToken === undefined
        ? undefined
        : this.windowOrderClaims.get(requestedToken);
    const canRestoreRequested =
      requestedToken !== undefined &&
      (requestedClaim === undefined ||
        (requestedClaim.client === client &&
          requestedClaim.localWindowId === localWindowId));
    const orderToken = canRestoreRequested
      ? requestedToken
      : this.allocateWindowOrderToken();
    if (existingToken && existingToken !== orderToken) {
      this.releaseWindowOrderToken(client, localWindowId, existingToken);
    }
    this.windowOrderClaims.set(orderToken, { client, localWindowId });
    const restoredValue = BigInt(`0x${orderToken}`);
    if (restoredValue >= this.nextWindowOrderValue) {
      this.nextWindowOrderValue = restoredValue + 1n;
    }
    return orderToken;
  }

  private allocateWindowOrderToken(): string {
    while (this.nextWindowOrderValue <= MAX_WINDOW_ORDER_VALUE) {
      const token = formatWindowOrderToken(this.nextWindowOrderValue);
      this.nextWindowOrderValue += 1n;
      if (!this.windowOrderClaims.has(token)) {
        return token;
      }
    }
    throw new Error('the 128-bit broker window order space is exhausted');
  }

  private releaseWindowOrderToken(
    client: BrokerClientSession,
    localWindowId: number,
    orderToken: string,
  ): void {
    const claim = this.windowOrderClaims.get(orderToken);
    if (claim?.client === client && claim.localWindowId === localWindowId) {
      this.windowOrderClaims.delete(orderToken);
    }
  }

  private sendWindowOrder(
    client: BrokerClientSession,
    windowId: number,
    orderToken: string,
  ): void {
    if (!this.clientUsesGlobalWindowOrder(client)) {
      return;
    }
    client.send({
      type: 'broker.window.order',
      windowId,
      orderToken,
    });
  }

  private clientUsesGlobalWindowOrder(client: BrokerClientSession): boolean {
    return (
      this.capabilitiesSet.has(OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY) &&
      (client.hello
        ? getOverlayBrokerClientSupportedCapabilities(client.hello).includes(
            OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY,
          )
        : false)
    );
  }

  private retireTargetIfEmpty(target: OverlayBrokerTargetHost): void {
    if (!target.canRetireWhenEmpty || this.targets.get(target.pid) !== target) {
      return;
    }
    this.targets.delete(target.pid);
    target.dispose();
    this.scheduleIdleShutdownIfEligible();
  }

  private retireTerminalTarget(target: OverlayBrokerTargetHost): void {
    if (this.targets.get(target.pid) !== target) {
      return;
    }
    this.targets.delete(target.pid);
    for (const client of this.clients) {
      if (client.targets.get(target.pid) === target) {
        client.targets.delete(target.pid);
      }
    }
    target.dispose();
    this.scheduleIdleShutdownIfEligible();
  }

  public get isRunning(): boolean {
    return this.server !== undefined;
  }

  private clearIdleShutdown(): void {
    if (this.idleShutdownTimer) {
      clearTimeout(this.idleShutdownTimer);
      this.idleShutdownTimer = undefined;
    }
  }

  private scheduleIdleShutdownIfEligible(): void {
    if (
      this.idleShutdownMs === false ||
      this.stopping ||
      !this.server ||
      this.clients.size !== 0 ||
      this.targets.size !== 0 ||
      this.idleShutdownTimer
    ) {
      return;
    }
    this.idleShutdownTimer = setTimeout(() => {
      this.idleShutdownTimer = undefined;
      if (
        !this.stopping &&
        this.server &&
        this.clients.size === 0 &&
        this.targets.size === 0
      ) {
        void this.stop();
      }
    }, this.idleShutdownMs);
  }

  private sendError(
    client: BrokerClientSession,
    code: OverlayBrokerError['code'],
    message: string,
    requestId?: string,
    pid?: number,
  ): void {
    client.send({
      type: 'broker.error',
      code,
      message,
      ...(requestId === undefined ? {} : { requestId }),
      ...(pid === undefined ? {} : { pid }),
    });
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

function formatWindowOrderToken(value: bigint): string {
  return value.toString(16).padStart(32, '0');
}

function cloneWindowGeometry(
  geometry: NativeOverlayWindowGeometry,
): NativeOverlayWindowGeometry {
  return {
    rect: { ...geometry.rect },
    ...(geometry.caption ? { caption: { ...geometry.caption } } : {}),
    ...(geometry.scaleFactorMicros === undefined
      ? {}
      : { scaleFactorMicros: geometry.scaleFactorMicros }),
    ...(geometry.rasterChanged === undefined
      ? {}
      : { rasterChanged: geometry.rasterChanged }),
  };
}

function memberMatchesTargetExecutable(
  member: TargetMember,
  target: OverlayBrokerTargetIdentity,
): boolean {
  return (
    member.expectedExecutablePath === undefined ||
    normalizeExecutablePathIdentity(member.expectedExecutablePath) ===
      normalizeExecutablePathIdentity(target.executablePath)
  );
}

function normalizeExecutablePathIdentity(value: string): string {
  let normalized = win32.normalize(value).toLowerCase();
  if (normalized.startsWith('\\\\?\\unc\\')) {
    normalized = `\\\\${normalized.slice('\\\\?\\unc\\'.length)}`;
  } else if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice('\\\\?\\'.length);
  }
  return normalized;
}

function normalizeDiscoveryPathIdentity(value: string): string {
  return normalizeExecutablePathIdentity(value);
}

function normalizeOptionalExecutablePathIdentity(
  value: string | undefined,
): string | undefined {
  return value === undefined
    ? undefined
    : normalizeExecutablePathIdentity(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUint32(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff
  );
}

function isPositiveUint32(value: unknown): value is number {
  return isUint32(value) && value > 0;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
