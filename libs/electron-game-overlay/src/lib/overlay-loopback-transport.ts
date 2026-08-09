import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import {
  InputEventTranslator,
  parseNativeInputMessage,
  type NativeInputMessage,
  type TranslatedInputEvent,
} from './input-translation.js';
import {
  normalizeOverlayDiagnosticErrorCode,
  parseOverlayDiagnostic,
  parseOverlayRuntimeDiagnosticPacket,
  type OverlayPacketRejectionReason,
} from './diagnostic.js';
import type {
  NativeOverlay,
  NativeRuntimeProviderMetadata,
  NativeOverlayWindowDetails,
  NativeOverlayWindowGeometry,
} from './native.js';
import {
  parseOverlayGraphicsFps,
  parseOverlayTargetSurface,
  parseOverlayTargetSurfaceRemoved,
} from './target-surface.js';
import type {
  OverlayDiagnostic,
  OverlayDiagnosticCode,
  OverlayDiagnosticContextValue,
} from './types.js';

export const OVERLAY_TRANSPORT_PROTOCOL_VERSION = 1;
export const OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME =
  'electron-overlay-transport-v1.json';
export const OVERLAY_TRANSPORT_TARGET_DISCOVERY_FILE_PREFIX =
  'electron-overlay-transport-v1.pid-';
export const OVERLAY_TRANSPORT_TARGET_ROUTE_FILE_NAME =
  'electron-overlay-transport-v1.targeted';
export const OVERLAY_TRANSPORT_TARGET_RECOVERY_CLAIM_FILE_PREFIX =
  'electron-overlay-transport-v1.pid-';
export const OVERLAY_TRANSPORT_TARGET_RECOVERY_CLAIM_FILE_SUFFIX =
  '.recovery.json';
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
export const MAX_FRAME_BODY_BYTES = 256 * 1024 * 1024;

const PACKET_KIND_JSON = 1;
const PACKET_KIND_FRAME = 2;
const PACKET_PREFIX_BYTES = 5;
const FRAME_HEADER_BYTES = 12;
const LOOPBACK_HOST = '127.0.0.1';
const DISCOVERY_DIRECTORY_NAME = 'electron-game-overlay';
const DEFAULT_PROCESS_EXIT_POLL_INTERVAL_MS = 250;
const MIN_PROCESS_EXIT_POLL_INTERVAL_MS = 1;
const MAX_PROCESS_EXIT_POLL_INTERVAL_MS = 60_000;
const MAX_TOKEN_ALLOCATION_ATTEMPTS = 16;
const MAX_PENDING_DIAGNOSTICS = 32;
const MAX_DIAGNOSTICS_PER_CODE = 8;
const DIAGNOSTIC_RATE_WINDOW_MS = 60_000;

type DiscoveryEndpointReservation = Readonly<{
  key: string;
  token: symbol;
}>;

const discoveryEndpointReservations = new Map<string, symbol>();

export interface OverlayDiscoveryRecord {
  version: 1;
  pid: number;
  port: number;
  token: string;
  targetPid?: number;
}

export type OverlayTargetRecoveryClaim = Readonly<{
  schemaVersion: 1;
  targetPid: number;
  discoveryPath: string;
  staticDiscoveryPath: string;
  expectedExecutablePath?: string;
  leaseId?: string;
  phase: 'intent' | 'publishing' | 'published';
  record: OverlayDiscoveryRecord;
  /** The last committed endpoint while a replacement endpoint is published. */
  previousRecord?: OverlayDiscoveryRecord;
}>;

/** @internal Broker-only context for durable target-route ownership. */
export type OverlayTargetRouteAuthorizationContext = Readonly<{
  leaseId?: string;
  /** A committed route can be serviced by another compatible provider. */
  allowPublishedClaimTakeover?: boolean;
}>;

export type OverlayTargetAuthorizationPublicationPhase =
  | 'recovery-claim-published'
  | 'recovery-claim-armed'
  | 'static-discovery-published'
  | 'route-intent-published'
  | 'run-discovery-published'
  | 'recovery-claim-committed';

export interface OverlayLoopbackTransportOptions {
  discoveryPath?: string;
  tokenFactory?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  processExitPollIntervalMs?: number;
  /** @internal Deterministic fault barrier used by publication-order tests. */
  targetAuthorizationPublicationHook?: (
    phase: OverlayTargetAuthorizationPublicationPhase,
    claim: OverlayTargetRecoveryClaim,
  ) => void | Promise<void>;
  /** @internal Fault injection immediately before a claim replacement. */
  targetRecoveryClaimWriteHook?: (
    claim: OverlayTargetRecoveryClaim,
  ) => void | Promise<void>;
}

interface JsonObject {
  [key: string]: unknown;
}

interface WindowMessage extends JsonObject {
  type: 'window';
  windowId: number;
  name: string;
  transparent: boolean;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  caption?: {
    left: number;
    right: number;
    top: number;
    height: number;
  };
  scaleFactorMicros?: number;
}

interface PendingEvent {
  event: string;
  payload: JsonObject;
}

interface PacketSink {
  write(packet: Uint8Array): boolean;
}

interface QueuedPacket {
  packet: Buffer;
  frameWindowId?: number;
}

/**
 * Serializes socket writes while preserving control ordering. A frame can only
 * replace a still-unsent frame for the same window within the current
 * control-free queue segment, so every control packet acts as a barrier.
 */
export class BackpressurePacketQueue {
  private blocked = false;
  private readonly pending: QueuedPacket[] = [];

  constructor(
    private readonly sink: PacketSink,
    private readonly onWriteError: (error: unknown) => void = () => undefined,
  ) {}

  public sendControl(packet: Buffer): void {
    this.send({ packet });
  }

  public sendFrame(windowId: number, packet: Buffer): void {
    this.send({ packet, frameWindowId: windowId });
  }

  public dropPendingFrames(windowId: number): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index]?.frameWindowId === windowId) {
        this.pending.splice(index, 1);
      }
    }
  }

  public handleDrain(): void {
    this.blocked = false;
    this.flush();
  }

  public clear(): void {
    this.blocked = false;
    this.pending.length = 0;
  }

  private send(entry: QueuedPacket): void {
    if (!this.blocked && this.pending.length === 0) {
      const accepted = this.write(entry.packet);
      if (accepted !== undefined) {
        this.blocked = !accepted;
      }
      return;
    }

    if (entry.frameWindowId !== undefined) {
      for (let index = this.pending.length - 1; index >= 0; index -= 1) {
        const candidate = this.pending[index];
        if (candidate?.frameWindowId === undefined) {
          break;
        }
        if (candidate.frameWindowId === entry.frameWindowId) {
          this.pending[index] = entry;
          return;
        }
      }
    }
    this.pending.push(entry);
  }

  private flush(): void {
    while (!this.blocked && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (entry) {
        const accepted = this.write(entry.packet);
        if (accepted === undefined) {
          return;
        }
        this.blocked = !accepted;
      }
    }
  }

  private write(packet: Uint8Array): boolean | undefined {
    try {
      return this.sink.write(packet);
    } catch (error) {
      this.clear();
      this.onWriteError(error);
      return undefined;
    }
  }
}

interface ClientState {
  socket: Socket;
  writer: BackpressurePacketQueue;
  receiveBuffer: Buffer;
  authenticated: boolean;
  pid?: number;
  path?: string;
  targetAuthorization?: TargetAuthorization;
  inputTranslator?: InputEventTranslator;
  diagnosticRates: Map<OverlayDiagnosticCode, DiagnosticRateState>;
  packetRejectionDiagnosed?: boolean;
  socketErrorDiagnosed?: boolean;
}

interface ProcessExitWatch {
  pid: number;
  path: string;
  timer?: ReturnType<typeof setTimeout>;
  inspectionFailureDiagnosed?: boolean;
}

interface TargetAuthorization {
  pid: number;
  expectedExecutablePath?: string;
  discoveryPath: string;
  discoveryPathKey: string;
  staticDiscoveryPath: string;
  staticDiscoveryEndpointReservation: DiscoveryEndpointReservation;
  routeIntentPath: string;
  record: OverlayDiscoveryRecord;
  recoveryClaim: OverlayTargetRecoveryClaim;
  references: number;
  generation: number;
}

interface DiagnosticRateState {
  windowStartedAt: number;
  count: number;
}

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

export function defaultOverlayDiscoveryPath(): string {
  return join(
    tmpdir(),
    DISCOVERY_DIRECTORY_NAME,
    OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME,
  );
}

export function defaultOverlayTargetDiscoveryPath(pid: number): string {
  assertProcessPid(pid);
  return join(
    tmpdir(),
    DISCOVERY_DIRECTORY_NAME,
    `${OVERLAY_TRANSPORT_TARGET_DISCOVERY_FILE_PREFIX}${pid}.json`,
  );
}

export function defaultOverlayTargetRecoveryClaimPath(pid: number): string {
  assertProcessPid(pid);
  return join(
    userInfo().homedir,
    `.${DISCOVERY_DIRECTORY_NAME}`,
    'broker-v1',
    `${OVERLAY_TRANSPORT_TARGET_RECOVERY_CLAIM_FILE_PREFIX}${pid}${OVERLAY_TRANSPORT_TARGET_RECOVERY_CLAIM_FILE_SUFFIX}`,
  );
}

/**
 * Reads the durable write-ahead route claim for an exact PID. Missing claims
 * return undefined; malformed or unreadable claims fail closed by throwing.
 */
export function readOverlayTargetRecoveryClaim(
  pid: number,
): OverlayTargetRecoveryClaim | undefined {
  assertProcessPid(pid);
  const claimPath = defaultOverlayTargetRecoveryClaimPath(pid);
  let contents: string;
  try {
    contents = readFileSync(claimPath, 'utf8');
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) {
      return undefined;
    }
    throw new Error(
      `Unable to read overlay target recovery claim ${claimPath}: ${formatUnknownError(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Overlay target recovery claim ${claimPath} is malformed: ${formatUnknownError(error)}`,
    );
  }
  const claim = parseOverlayTargetRecoveryClaim(value, pid);
  if (!claim) {
    throw new Error(
      `Overlay target recovery claim ${claimPath} has an invalid schema`,
    );
  }
  return claim;
}

/**
 * Returns true once a route may have been consumed. A committed claim is
 * irreversible; during publication an exact atomic credential is sufficient
 * proof even if the broker died before committing the final phase.
 */
export function overlayTargetRecoveryClaimMayHaveBeenConsumed(
  claim: OverlayTargetRecoveryClaim,
): boolean {
  if (claim.phase === 'publishing' || claim.phase === 'published') {
    return true;
  }
  const records = [claim.record, claim.previousRecord].filter(
    (record): record is OverlayDiscoveryRecord => record !== undefined,
  );
  return (
    discoveryPathMatchesAnyRecord(claim.discoveryPath, records) ||
    discoveryPathMatchesAnyRecord(claim.staticDiscoveryPath, records)
  );
}

/** Removes exact route evidence only after the caller proved target exit. */
export function clearOverlayTargetRecoveryClaimForExitedPid(pid: number): void {
  assertProcessPid(pid);
  let claim: OverlayTargetRecoveryClaim | undefined;
  try {
    claim = readOverlayTargetRecoveryClaim(pid);
  } catch {
    // A malformed deterministic claim must not outlive a definitively dead PID.
    try {
      unlinkSync(defaultOverlayTargetRecoveryClaimPath(pid));
    } catch {
      // The malformed claim may already have disappeared.
    }
    removeAnyTargetBoundDiscoveryForExitedPid(
      defaultOverlayTargetDiscoveryPath(pid),
      pid,
    );
    return;
  }
  if (!claim) {
    removeAnyTargetBoundDiscoveryForExitedPid(
      defaultOverlayTargetDiscoveryPath(pid),
      pid,
    );
    return;
  }
  const records = [claim.record, claim.previousRecord].filter(
    (record): record is OverlayDiscoveryRecord => record !== undefined,
  );
  for (const record of records) {
    removeDiscoveryRecordIfOwnedSync(claim.discoveryPath, record);
    removeDiscoveryRecordIfOwnedSync(
      join(
        dirname(claim.discoveryPath),
        OVERLAY_TRANSPORT_TARGET_ROUTE_FILE_NAME,
      ),
      record,
    );
    removeDiscoveryRecordIfOwnedSync(claim.staticDiscoveryPath, record);
  }
  removeAnyTargetBoundDiscoveryForExitedPid(claim.discoveryPath, pid);
  removeAnyTargetBoundDiscoveryForExitedPid(
    join(
      dirname(claim.discoveryPath),
      OVERLAY_TRANSPORT_TARGET_ROUTE_FILE_NAME,
    ),
    pid,
  );
  removeAnyTargetBoundDiscoveryForExitedPid(claim.staticDiscoveryPath, pid);
  removeOverlayTargetRecoveryClaimIfOwned(pid, claim);
}

/** Removes the sidecar only when it still exactly matches the observed claim. */
export function removeOverlayTargetRecoveryClaimIfOwned(
  pid: number,
  claim: OverlayTargetRecoveryClaim,
): void {
  assertProcessPid(pid);
  if (claim.targetPid !== pid) {
    return;
  }
  try {
    const claimPath = defaultOverlayTargetRecoveryClaimPath(pid);
    const current = parseOverlayTargetRecoveryClaim(
      JSON.parse(readFileSync(claimPath, 'utf8')),
      pid,
    );
    if (current && recoveryClaimsEqual(current, claim)) {
      unlinkSync(claimPath);
    }
  } catch {
    // The claim may already be gone or atomically replaced by a new owner.
  }
}

export function encodeJsonTransportPacket(value: JsonObject): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.byteLength > MAX_JSON_BODY_BYTES) {
    throw new RangeError(
      `Overlay JSON packet exceeds ${MAX_JSON_BODY_BYTES} bytes`,
    );
  }

  const packet = Buffer.allocUnsafe(PACKET_PREFIX_BYTES + body.byteLength);
  packet.writeUInt32LE(body.byteLength, 0);
  packet.writeUInt8(PACKET_KIND_JSON, 4);
  body.copy(packet, PACKET_PREFIX_BYTES);
  return packet;
}

export function encodeFrameTransportPacket(
  windowId: number,
  width: number,
  height: number,
  pixels: Buffer,
): Buffer {
  assertUnsigned32(windowId, 'windowId');
  assertPositiveUnsigned32(width, 'width');
  assertPositiveUnsigned32(height, 'height');

  const pixelBytes = width * height * 4;
  if (!Number.isSafeInteger(pixelBytes) || pixels.byteLength !== pixelBytes) {
    throw new RangeError(
      `Expected ${pixelBytes} BGRA bytes for a ${width}x${height} frame, got ${pixels.byteLength}`,
    );
  }

  const bodyBytes = FRAME_HEADER_BYTES + pixelBytes;
  if (bodyBytes > MAX_FRAME_BODY_BYTES) {
    throw new RangeError(
      `Overlay frame packet exceeds ${MAX_FRAME_BODY_BYTES} bytes`,
    );
  }

  const packet = Buffer.allocUnsafe(PACKET_PREFIX_BYTES + bodyBytes);
  packet.writeUInt32LE(bodyBytes, 0);
  packet.writeUInt8(PACKET_KIND_FRAME, 4);
  packet.writeUInt32LE(windowId, 5);
  packet.writeUInt32LE(width, 9);
  packet.writeUInt32LE(height, 13);
  pixels.copy(packet, PACKET_PREFIX_BYTES + FRAME_HEADER_BYTES);
  return packet;
}

function assertUnsigned32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function assertPositiveUnsigned32(value: number, name: string): void {
  assertUnsigned32(value, name);
  if (value === 0) {
    throw new RangeError(`${name} must be greater than zero`);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOverlayTargetDiscoveryRecord(
  value: unknown,
  targetPid: number,
): OverlayDiscoveryRecord | undefined {
  if (
    !isJsonObject(value) ||
    value.version !== OVERLAY_TRANSPORT_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    (value.pid as number) > 0x7fff_ffff ||
    !Number.isSafeInteger(value.port) ||
    (value.port as number) <= 0 ||
    (value.port as number) > 65_535 ||
    typeof value.token !== 'string' ||
    !isValidToken(value.token) ||
    value.targetPid !== targetPid
  ) {
    return undefined;
  }
  return Object.freeze({
    version: 1,
    pid: value.pid as number,
    port: value.port as number,
    token: value.token,
    targetPid,
  });
}

function parseOverlayTargetRecoveryClaim(
  value: unknown,
  targetPid: number,
): OverlayTargetRecoveryClaim | undefined {
  if (
    !isJsonObject(value) ||
    value.schemaVersion !== 1 ||
    value.targetPid !== targetPid ||
    typeof value.discoveryPath !== 'string' ||
    value.discoveryPath.includes('\0') ||
    !isAbsolute(value.discoveryPath) ||
    basename(resolve(value.discoveryPath)).toLowerCase() !==
      OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME.toLowerCase() ||
    typeof value.staticDiscoveryPath !== 'string' ||
    value.staticDiscoveryPath.includes('\0') ||
    !isAbsolute(value.staticDiscoveryPath) ||
    basename(resolve(value.staticDiscoveryPath)).toLowerCase() !==
      `${OVERLAY_TRANSPORT_TARGET_DISCOVERY_FILE_PREFIX}${targetPid}.json`.toLowerCase() ||
    (value.expectedExecutablePath !== undefined &&
      (typeof value.expectedExecutablePath !== 'string' ||
        value.expectedExecutablePath.includes('\0') ||
        !win32.isAbsolute(value.expectedExecutablePath))) ||
    (value.leaseId !== undefined && !isValidRecoveryLeaseId(value.leaseId)) ||
    (value.phase !== 'intent' &&
      value.phase !== 'publishing' &&
      value.phase !== 'published')
  ) {
    return undefined;
  }
  const record = parseOverlayTargetDiscoveryRecord(value.record, targetPid);
  const previousRecord =
    value.previousRecord === undefined
      ? undefined
      : parseOverlayTargetDiscoveryRecord(value.previousRecord, targetPid);
  if (
    !record ||
    (value.previousRecord !== undefined && !previousRecord) ||
    (value.phase === 'published' && value.previousRecord !== undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: 1,
    targetPid,
    discoveryPath: resolve(value.discoveryPath),
    staticDiscoveryPath: resolve(value.staticDiscoveryPath),
    ...(value.expectedExecutablePath === undefined
      ? {}
      : { expectedExecutablePath: value.expectedExecutablePath }),
    ...(value.leaseId === undefined ? {} : { leaseId: value.leaseId }),
    phase: value.phase,
    record,
    ...(previousRecord === undefined ? {} : { previousRecord }),
  });
}

function isValidRecoveryLeaseId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !value.includes('\0')
  );
}

function recoveryClaimsEqual(
  left: OverlayTargetRecoveryClaim,
  right: OverlayTargetRecoveryClaim,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.targetPid === right.targetPid &&
    normalizeExecutablePathIdentity(left.discoveryPath) ===
      normalizeExecutablePathIdentity(right.discoveryPath) &&
    normalizeExecutablePathIdentity(left.staticDiscoveryPath) ===
      normalizeExecutablePathIdentity(right.staticDiscoveryPath) &&
    normalizeOptionalExecutablePathIdentity(left.expectedExecutablePath) ===
      normalizeOptionalExecutablePathIdentity(right.expectedExecutablePath) &&
    left.leaseId === right.leaseId &&
    left.phase === right.phase &&
    isOwnedDiscoveryRecord(left.record, right.record) &&
    ((left.previousRecord === undefined &&
      right.previousRecord === undefined) ||
      (left.previousRecord !== undefined &&
        right.previousRecord !== undefined &&
        isOwnedDiscoveryRecord(left.previousRecord, right.previousRecord)))
  );
}

function discoveryPathMatchesAnyRecord(
  discoveryPath: string,
  records: readonly OverlayDiscoveryRecord[],
): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    return records.some((record) => isOwnedDiscoveryRecord(value, record));
  } catch {
    return false;
  }
}

function removeDiscoveryRecordIfOwnedSync(
  discoveryPath: string,
  record: OverlayDiscoveryRecord,
): void {
  try {
    const value: unknown = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    if (isOwnedDiscoveryRecord(value, record)) {
      unlinkSync(discoveryPath);
    }
  } catch {
    // The route may already be absent or replaced by another exact record.
  }
}

function removeAnyTargetBoundDiscoveryForExitedPid(
  discoveryPath: string,
  pid: number,
): void {
  try {
    const value: unknown = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    if (parseOverlayTargetDiscoveryRecord(value, pid)) {
      unlinkSync(discoveryPath);
    }
  } catch {
    // The deterministic route may already be absent or malformed.
  }
}

function isOwnedDiscoveryRecord(
  value: unknown,
  record: OverlayDiscoveryRecord,
): boolean {
  return (
    isJsonObject(value) &&
    value.version === record.version &&
    value.pid === record.pid &&
    value.port === record.port &&
    value.token === record.token &&
    value.targetPid === record.targetPid
  );
}

function errorCodeContext(
  error: unknown,
): Readonly<Record<string, OverlayDiagnosticContextValue>> | undefined {
  if (!isJsonObject(error)) {
    return undefined;
  }
  const errorCode = normalizeOverlayDiagnosticErrorCode(error.code);
  return errorCode === undefined ? undefined : { errorCode };
}

function isValidToken(token: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(token);
}

function assertProcessPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    throw new RangeError(
      'Overlay target PID must be a positive uint32 integer',
    );
  }
}

function tokensEqual(actual: string, expected: string): boolean {
  if (!isValidToken(actual) || !isValidToken(expected)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(actual, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}

function cloneWindowMetadata(message: WindowMessage): JsonObject {
  return {
    windowId: message.windowId,
    name: message.name,
    transparent: message.transparent,
    rect: { ...message.rect },
    ...(message.caption ? { caption: { ...message.caption } } : {}),
    ...(message.scaleFactorMicros !== undefined
      ? { scaleFactorMicros: message.scaleFactorMicros }
      : {}),
  };
}

export class OverlayLoopbackTransport implements NativeOverlay {
  private readonly discoveryPath: string;
  private readonly tokenFactory: () => string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processExitPollIntervalMs: number;
  private readonly targetAuthorizationPublicationHook:
    | OverlayLoopbackTransportOptions['targetAuthorizationPublicationHook']
    | undefined;
  private readonly targetRecoveryClaimWriteHook:
    OverlayLoopbackTransportOptions['targetRecoveryClaimWriteHook'] | undefined;
  private readonly issuedTokens = new Set<string>();
  private readonly targetAuthorizationsByPid = new Map<
    number,
    TargetAuthorization
  >();
  private readonly targetAuthorizationsByDiscoveryPath = new Map<
    string,
    TargetAuthorization
  >();
  private readonly pendingTargetAuthorizationsByPid = new Map<
    number,
    Promise<TargetAuthorization>
  >();
  private readonly clients = new Set<ClientState>();
  private readonly activeClientsByPid = new Map<number, ClientState>();
  private readonly processExitWatchesByPid = new Map<
    number,
    ProcessExitWatch
  >();
  private readonly windows = new Map<number, WindowMessage>();
  private readonly latestFrames = new Map<number, Buffer>();
  private readonly inputTranslatorsByPid = new Map<
    number,
    InputEventTranslator
  >();
  private readonly fallbackInputTranslator = new InputEventTranslator();
  private readonly pendingEvents: PendingEvent[] = [];
  private readonly pendingDiagnostics: OverlayDiagnostic[] = [];
  private readonly diagnosticRates = new Map<
    OverlayDiagnosticCode,
    DiagnosticRateState
  >();
  private server: Server | undefined;
  private callback: ((event: string, ...args: any[]) => void) | undefined;
  private diagnosticCallback:
    ((diagnostic: OverlayDiagnostic) => void) | undefined;
  private inputIntercept: boolean | undefined;
  private token: string | undefined;
  private discoveryRecord: OverlayDiscoveryRecord | undefined;
  private readyPromise: Promise<OverlayDiscoveryRecord> | undefined;
  private rejectReady: ((reason: Error) => void) | undefined;
  private discoveryEndpointReservation:
    DiscoveryEndpointReservation | undefined;
  private generation = 0;

  constructor(options: OverlayLoopbackTransportOptions = {}) {
    this.discoveryPath = options.discoveryPath ?? defaultOverlayDiscoveryPath();
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString('hex'));
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.processExitPollIntervalMs =
      options.processExitPollIntervalMs ??
      DEFAULT_PROCESS_EXIT_POLL_INTERVAL_MS;
    this.targetAuthorizationPublicationHook =
      options.targetAuthorizationPublicationHook;
    this.targetRecoveryClaimWriteHook = options.targetRecoveryClaimWriteHook;
    if (
      !Number.isSafeInteger(this.processExitPollIntervalMs) ||
      this.processExitPollIntervalMs < MIN_PROCESS_EXIT_POLL_INTERVAL_MS ||
      this.processExitPollIntervalMs > MAX_PROCESS_EXIT_POLL_INTERVAL_MS
    ) {
      throw new RangeError(
        `processExitPollIntervalMs must be an integer between ${MIN_PROCESS_EXIT_POLL_INTERVAL_MS} and ${MAX_PROCESS_EXIT_POLL_INTERVAL_MS}`,
      );
    }
  }

  public start(): void {
    if (this.server || this.readyPromise) {
      return;
    }

    const endpointReservation = this.reserveDiscoveryEndpoint();
    let token: string | undefined;
    try {
      this.diagnosticRates.clear();
      const allocatedToken = this.allocateToken();
      token = allocatedToken;

      const generation = ++this.generation;
      const server = createServer((socket) => this.acceptClient(socket));
      this.server = server;
      this.token = allocatedToken;
      let resolveReady!: (record: OverlayDiscoveryRecord) => void;
      let rejectReady!: (reason: Error) => void;
      const readyPromise = new Promise<OverlayDiscoveryRecord>(
        (resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        },
      );
      this.readyPromise = readyPromise;
      this.rejectReady = rejectReady;

      const handleStartupError = (error: Error) => {
        if (
          this.generation !== generation ||
          this.server !== server ||
          this.readyPromise !== readyPromise
        ) {
          return;
        }
        this.publishDiagnostic({
          code: 'transport-listener-failed',
          context: errorCodeContext(error),
        });
        server.off('error', handleStartupError);
        try {
          server.close();
        } catch {
          // A listener startup error can close the server before this callback.
        }
        this.server = undefined;
        this.token = undefined;
        this.readyPromise = undefined;
        this.rejectReady = undefined;
        this.issuedTokens.delete(allocatedToken.toLowerCase());
        this.releaseDiscoveryEndpoint(endpointReservation);
        rejectReady(error);
      };

      server.once('error', handleStartupError);
      try {
        server.listen(0, LOOPBACK_HOST, () => {
          server.off('error', handleStartupError);
          server.on('error', (error) => {
            if (this.generation === generation && this.server === server) {
              this.publishDiagnostic({
                code: 'transport-listener-failed',
                context: errorCodeContext(error),
              });
              this.stop();
            }
          });
          server.unref();
          void this.finishStart(
            server,
            allocatedToken,
            generation,
            resolveReady,
            rejectReady,
          );
        });
      } catch (error) {
        handleStartupError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      void readyPromise.catch(() => undefined);
    } catch (error) {
      if (this.server || this.readyPromise) {
        this.stop();
      } else {
        if (token !== undefined) {
          this.issuedTokens.delete(token.toLowerCase());
        }
        this.releaseDiscoveryEndpoint(endpointReservation);
      }
      throw error;
    }
  }

  public whenReady(): Promise<OverlayDiscoveryRecord> {
    if (!this.readyPromise) {
      return Promise.reject(
        new Error('Overlay transport has not been started'),
      );
    }
    return this.readyPromise;
  }

  public async authorizeTarget(
    pid: number,
    discoveryPath: string,
    expectedExecutablePath?: string,
    runtimeProviderOrRouteContext?:
      NativeRuntimeProviderMetadata | OverlayTargetRouteAuthorizationContext,
  ): Promise<() => void> {
    assertProcessPid(pid);
    if (typeof discoveryPath !== 'string' || !isAbsolute(discoveryPath)) {
      throw new TypeError('Overlay target discovery path must be absolute');
    }
    if (
      expectedExecutablePath !== undefined &&
      (!win32.isAbsolute(expectedExecutablePath) ||
        expectedExecutablePath.includes('\0'))
    ) {
      throw new TypeError(
        'Overlay expected target executable path must be an absolute Windows path',
      );
    }
    const normalizedExpectedExecutablePath =
      expectedExecutablePath === undefined
        ? undefined
        : normalizeExecutablePathIdentity(expectedExecutablePath);
    const routeContext =
      isJsonObject(runtimeProviderOrRouteContext) &&
      ('leaseId' in runtimeProviderOrRouteContext ||
        'allowPublishedClaimTakeover' in runtimeProviderOrRouteContext)
        ? (runtimeProviderOrRouteContext as OverlayTargetRouteAuthorizationContext)
        : undefined;
    if (
      routeContext?.leaseId !== undefined &&
      !isValidRecoveryLeaseId(routeContext.leaseId)
    ) {
      throw new TypeError('Overlay target route lease ID is invalid');
    }
    const resolvedDiscoveryPath = resolve(discoveryPath);
    if (
      basename(resolvedDiscoveryPath).toLowerCase() !==
      OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME.toLowerCase()
    ) {
      throw new Error(
        `Overlay target discovery path must end with ${OVERLAY_TRANSPORT_DISCOVERY_FILE_NAME}`,
      );
    }
    const discoveryPathKey = resolvedDiscoveryPath.toLowerCase();
    if (discoveryPathKey === resolve(this.discoveryPath).toLowerCase()) {
      throw new Error(
        'Overlay target discovery path must not replace global discovery',
      );
    }
    const readyRecord = await this.whenReady();
    const generation = this.generation;
    if (
      !this.server ||
      this.discoveryRecord !== readyRecord ||
      generation === 0
    ) {
      throw new Error('Overlay transport stopped before target authorization');
    }

    const pathAuthorization =
      this.targetAuthorizationsByDiscoveryPath.get(discoveryPathKey);
    if (pathAuthorization && pathAuthorization.pid !== pid) {
      throw new Error(
        `Overlay target discovery path is already authorized for PID ${pathAuthorization.pid}`,
      );
    }

    let authorization: TargetAuthorization;
    let pending = this.pendingTargetAuthorizationsByPid.get(pid);
    if (pending) {
      authorization = await pending;
    } else {
      const existing = this.targetAuthorizationsByPid.get(pid);
      if (existing) {
        authorization = existing;
      } else {
        pending = this.createTargetAuthorization(
          pid,
          resolvedDiscoveryPath,
          discoveryPathKey,
          normalizedExpectedExecutablePath,
          routeContext,
          readyRecord,
          generation,
        );
        this.pendingTargetAuthorizationsByPid.set(pid, pending);
        const clearPending = () => {
          if (this.pendingTargetAuthorizationsByPid.get(pid) === pending) {
            this.pendingTargetAuthorizationsByPid.delete(pid);
          }
        };
        pending.then(clearPending, clearPending);
        authorization = await pending;
      }
    }
    if (
      resolve(authorization.discoveryPath).toLowerCase() !==
      resolvedDiscoveryPath.toLowerCase()
    ) {
      throw new Error(
        `Overlay target PID ${pid} is already authorized through another discovery path`,
      );
    }
    if (
      authorization.expectedExecutablePath !== normalizedExpectedExecutablePath
    ) {
      throw new Error(
        `Overlay target PID ${pid} is already authorized for another executable path`,
      );
    }
    if (
      authorization.generation !== this.generation ||
      this.targetAuthorizationsByPid.get(pid) !== authorization
    ) {
      throw new Error('Overlay transport stopped before target authorization');
    }

    ++authorization.references;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.releaseTargetAuthorization(authorization);
    };
  }

  public stop(): void {
    const priorRecord = this.discoveryRecord;
    const priorTargetAuthorizations = Array.from(
      this.targetAuthorizationsByPid.values(),
    );
    ++this.generation;
    this.rejectReady?.(new Error('Overlay transport stopped before startup'));
    this.rejectReady = undefined;
    this.readyPromise = undefined;
    this.discoveryRecord = undefined;
    this.token = undefined;
    this.targetAuthorizationsByPid.clear();
    this.targetAuthorizationsByDiscoveryPath.clear();
    this.pendingTargetAuthorizationsByPid.clear();
    this.issuedTokens.clear();

    const server = this.server;
    this.server = undefined;
    if (server) {
      try {
        server.close();
      } catch {
        // A start immediately followed by stop can close before listen begins.
      }
    }

    this.clearProcessExitWatches();

    for (const client of this.clients) {
      client.authenticated = false;
      client.inputTranslator?.reset();
      client.writer.clear();
      client.socket.destroy();
    }
    this.clients.clear();
    this.activeClientsByPid.clear();
    this.inputTranslatorsByPid.clear();
    this.windows.clear();
    this.latestFrames.clear();
    this.inputIntercept = undefined;
    this.pendingEvents.length = 0;
    this.pendingDiagnostics.length = 0;
    this.callback = undefined;
    this.diagnosticCallback = undefined;
    this.diagnosticRates.clear();
    this.fallbackInputTranslator.reset();
    this.releaseDiscoveryEndpoint();

    if (priorRecord) {
      this.removeDiscoveryIfOwnedSync(this.discoveryPath, priorRecord);
    }
    for (const authorization of priorTargetAuthorizations) {
      this.releaseDiscoveryEndpoint(
        authorization.staticDiscoveryEndpointReservation,
      );
    }
  }

  public setEventCallback(
    callback: (event: string, ...args: any[]) => void,
  ): void {
    this.callback = callback;
    while (this.pendingEvents.length > 0) {
      const event = this.pendingEvents.shift();
      if (event) {
        callback(event.event, event.payload);
      }
    }
  }

  public setDiagnosticCallback(
    callback: (diagnostic: OverlayDiagnostic) => void,
  ): void {
    this.diagnosticCallback = callback;
    while (this.pendingDiagnostics.length > 0) {
      const diagnostic = this.pendingDiagnostics.shift();
      if (diagnostic) {
        this.deliverDiagnostic(diagnostic);
      }
    }
  }

  public setInputIntercept(intercept: boolean): void {
    this.inputIntercept = intercept;
    if (!intercept) {
      this.resetInputTranslators();
    }
    this.broadcastControl({
      type: 'command.input.intercept',
      intercept,
    });
  }

  public addWindow(
    windowId: number,
    details: NativeOverlayWindowDetails,
  ): void {
    assertPositiveUnsigned32(windowId, 'windowId');
    if (details.scaleFactorMicros !== undefined) {
      assertPositiveUnsigned32(details.scaleFactorMicros, 'scaleFactorMicros');
    }
    const message: WindowMessage = {
      type: 'window',
      windowId,
      name: details.name,
      transparent: details.transparent,
      rect: { ...details.rect },
      ...(details.caption ? { caption: { ...details.caption } } : {}),
      ...(details.scaleFactorMicros !== undefined
        ? { scaleFactorMicros: details.scaleFactorMicros }
        : {}),
    };
    const packet = encodeJsonTransportPacket(message);
    this.windows.delete(windowId);
    this.windows.set(windowId, message);
    this.latestFrames.delete(windowId);
    this.broadcastWindowBarrierPacket(windowId, packet);
  }

  public closeWindow(windowId: number): void {
    assertPositiveUnsigned32(windowId, 'windowId');
    const packet = encodeJsonTransportPacket({
      type: 'window.close',
      windowId,
    });
    this.windows.delete(windowId);
    this.latestFrames.delete(windowId);
    this.broadcastWindowBarrierPacket(windowId, packet);
  }

  /**
   * Moves an existing window to the end of the retained snapshot without
   * emitting a second window command. The broker uses this when the target
   * reports a focus/raise so reconnects preserve the aggregate scene order.
   */
  public raiseWindowForSnapshot(windowId: number): void {
    assertPositiveUnsigned32(windowId, 'windowId');
    const window = this.windows.get(windowId);
    if (!window) {
      return;
    }
    this.windows.delete(windowId);
    this.windows.set(windowId, window);
    const frame = this.latestFrames.get(windowId);
    if (frame) {
      this.latestFrames.delete(windowId);
      this.latestFrames.set(windowId, frame);
    }
  }

  public sendWindowBounds(
    windowId: number,
    details: NativeOverlayWindowGeometry,
  ): void {
    assertPositiveUnsigned32(windowId, 'windowId');
    if (details.scaleFactorMicros !== undefined) {
      assertPositiveUnsigned32(details.scaleFactorMicros, 'scaleFactorMicros');
    }
    const message: JsonObject = {
      type: 'window.bounds',
      windowId,
      rect: { ...details.rect },
      ...(details.caption !== undefined
        ? { caption: { ...details.caption } }
        : {}),
      ...(details.scaleFactorMicros !== undefined
        ? { scaleFactorMicros: details.scaleFactorMicros }
        : {}),
      ...(details.rasterChanged !== undefined
        ? { rasterChanged: details.rasterChanged }
        : {}),
    };
    const packet = encodeJsonTransportPacket(message);

    const window = this.windows.get(windowId);
    if (window) {
      window.rect = { ...details.rect };
      if (details.caption !== undefined) {
        window.caption = { ...details.caption };
      }
      if (details.scaleFactorMicros !== undefined) {
        window.scaleFactorMicros = details.scaleFactorMicros;
      }
    }

    if (details.rasterChanged) {
      this.latestFrames.delete(windowId);
      this.broadcastWindowBarrierPacket(windowId, packet);
    } else {
      this.broadcastControlPacket(packet);
    }
  }

  public sendFrameBuffer(
    windowId: number,
    buffer: Buffer,
    width: number,
    height: number,
  ): boolean {
    if (!this.windows.has(windowId)) {
      return false;
    }
    const packet = encodeFrameTransportPacket(windowId, width, height, buffer);
    this.latestFrames.set(windowId, packet);
    for (const client of this.clients) {
      if (client.authenticated) {
        client.writer.sendFrame(windowId, packet);
      }
    }
    return true;
  }

  public translateInputEvent(
    event: NativeInputMessage,
  ): TranslatedInputEvent | undefined {
    if (event.pid !== undefined) {
      return this.inputTranslatorsByPid.get(event.pid)?.translate(event);
    }
    return this.fallbackInputTranslator.translate(event);
  }

  private allocateToken(): string {
    for (let attempt = 0; attempt < MAX_TOKEN_ALLOCATION_ATTEMPTS; ++attempt) {
      const token = this.tokenFactory();
      if (!isValidToken(token)) {
        throw new Error(
          'Overlay transport token must be exactly 32 bytes of hex',
        );
      }
      const normalizedToken = token.toLowerCase();
      if (this.issuedTokens.has(normalizedToken)) {
        continue;
      }
      this.issuedTokens.add(normalizedToken);
      return token;
    }
    throw new Error('Overlay transport could not allocate a unique token');
  }

  private reserveDiscoveryEndpoint(): DiscoveryEndpointReservation {
    const reservation = this.reserveDiscoveryPath(
      this.discoveryPath,
      'Overlay transport discovery endpoint is already active',
    );
    this.discoveryEndpointReservation = reservation;
    return reservation;
  }

  private reserveTargetDiscoveryEndpoint(
    discoveryPath: string,
  ): DiscoveryEndpointReservation {
    return this.reserveDiscoveryPath(
      discoveryPath,
      'Overlay target discovery endpoint is already active',
    );
  }

  private reserveDiscoveryPath(
    discoveryPath: string,
    activeMessage: string,
  ): DiscoveryEndpointReservation {
    const key = resolve(discoveryPath).toLowerCase();
    if (discoveryEndpointReservations.has(key)) {
      throw new Error(`${activeMessage}: ${discoveryPath}`);
    }

    const reservation = Object.freeze({ key, token: Symbol(key) });
    discoveryEndpointReservations.set(key, reservation.token);
    return reservation;
  }

  private releaseDiscoveryEndpoint(
    reservation = this.discoveryEndpointReservation,
  ): void {
    if (!reservation) {
      return;
    }
    if (
      discoveryEndpointReservations.get(reservation.key) === reservation.token
    ) {
      discoveryEndpointReservations.delete(reservation.key);
    }
    if (this.discoveryEndpointReservation === reservation) {
      this.discoveryEndpointReservation = undefined;
    }
  }

  private async createTargetAuthorization(
    pid: number,
    discoveryPath: string,
    discoveryPathKey: string,
    expectedExecutablePath: string | undefined,
    routeContext: OverlayTargetRouteAuthorizationContext | undefined,
    readyRecord: OverlayDiscoveryRecord,
    generation: number,
  ): Promise<TargetAuthorization> {
    const pathAuthorization =
      this.targetAuthorizationsByDiscoveryPath.get(discoveryPathKey);
    if (pathAuthorization && pathAuthorization.pid !== pid) {
      throw new Error(
        `Overlay target discovery path is already authorized for PID ${pathAuthorization.pid}`,
      );
    }
    const priorClaim = readOverlayTargetRecoveryClaim(pid);
    const staticDiscoveryPath =
      priorClaim?.staticDiscoveryPath ?? defaultOverlayTargetDiscoveryPath(pid);
    const staticDiscoveryEndpointReservation =
      this.reserveTargetDiscoveryEndpoint(staticDiscoveryPath);
    let authorization: TargetAuthorization | undefined;
    let rollbackPriorIntentClaim: OverlayTargetRecoveryClaim | undefined;
    let rollbackPublishedIntentClaim: OverlayTargetRecoveryClaim | undefined;

    try {
      const priorMayHaveBeenConsumed =
        priorClaim !== undefined &&
        overlayTargetRecoveryClaimMayHaveBeenConsumed(priorClaim);
      if (priorClaim) {
        if (
          normalizeExecutablePathIdentity(priorClaim.discoveryPath) !==
            normalizeExecutablePathIdentity(discoveryPath) ||
          normalizeOptionalExecutablePathIdentity(
            priorClaim.expectedExecutablePath,
          ) !== normalizeOptionalExecutablePathIdentity(expectedExecutablePath)
        ) {
          throw new Error(
            `Overlay target PID ${pid} has a durable claim for another route`,
          );
        }
        const matchingLease = priorClaim.leaseId === routeContext?.leaseId;
        if (
          !matchingLease &&
          !(
            priorMayHaveBeenConsumed &&
            routeContext?.allowPublishedClaimTakeover === true
          )
        ) {
          throw new Error(
            `Overlay target PID ${pid} recovery requires the claimed lease`,
          );
        }
        if (priorClaim.phase === 'intent' && !priorMayHaveBeenConsumed) {
          rollbackPriorIntentClaim = priorClaim;
        }
      }
      const token = this.allocateToken();
      const record: OverlayDiscoveryRecord = {
        ...readyRecord,
        token,
        targetPid: pid,
      };
      const previousRecord = priorClaim
        ? selectPublishedRecoveryRecord(priorClaim)
        : undefined;
      let publishingClaim: OverlayTargetRecoveryClaim = Object.freeze({
        schemaVersion: 1,
        targetPid: pid,
        discoveryPath,
        staticDiscoveryPath,
        ...(expectedExecutablePath === undefined
          ? {}
          : { expectedExecutablePath }),
        ...(priorClaim?.leaseId !== undefined
          ? { leaseId: priorClaim.leaseId }
          : routeContext?.leaseId === undefined
            ? {}
            : { leaseId: routeContext.leaseId }),
        phase: priorMayHaveBeenConsumed ? 'publishing' : 'intent',
        record,
        ...(previousRecord === undefined ? {} : { previousRecord }),
      });
      authorization = {
        pid,
        ...(expectedExecutablePath === undefined
          ? {}
          : { expectedExecutablePath }),
        discoveryPath,
        discoveryPathKey,
        staticDiscoveryPath,
        staticDiscoveryEndpointReservation,
        routeIntentPath: join(
          dirname(discoveryPath),
          OVERLAY_TRANSPORT_TARGET_ROUTE_FILE_NAME,
        ),
        record,
        recoveryClaim: publishingClaim,
        references: 0,
        generation,
      };
      this.targetAuthorizationsByPid.set(pid, authorization);
      this.targetAuthorizationsByDiscoveryPath.set(
        discoveryPathKey,
        authorization,
      );

      await this.publishTargetRecoveryClaim(publishingClaim);
      if (publishingClaim.phase === 'intent') {
        rollbackPublishedIntentClaim = publishingClaim;
      }
      await this.runTargetAuthorizationPublicationHook(
        'recovery-claim-published',
        publishingClaim,
      );
      this.assertTargetAuthorizationActive(generation, readyRecord);

      if (publishingClaim.phase === 'intent') {
        const armedClaim: OverlayTargetRecoveryClaim = Object.freeze({
          ...publishingClaim,
          phase: 'publishing',
        });
        await this.publishTargetRecoveryClaim(armedClaim);
        rollbackPriorIntentClaim = undefined;
        rollbackPublishedIntentClaim = undefined;
        publishingClaim = armedClaim;
        authorization.recoveryClaim = armedClaim;
        await this.runTargetAuthorizationPublicationHook(
          'recovery-claim-armed',
          publishingClaim,
        );
        this.assertTargetAuthorizationActive(generation, readyRecord);
      }

      await this.publishDiscovery(staticDiscoveryPath, record);
      await this.runTargetAuthorizationPublicationHook(
        'static-discovery-published',
        publishingClaim,
      );
      this.assertTargetAuthorizationActive(generation, readyRecord);

      await this.publishDiscovery(authorization.routeIntentPath, record);
      await this.runTargetAuthorizationPublicationHook(
        'route-intent-published',
        publishingClaim,
      );
      this.assertTargetAuthorizationActive(generation, readyRecord);

      await this.publishDiscovery(discoveryPath, record);
      await this.runTargetAuthorizationPublicationHook(
        'run-discovery-published',
        publishingClaim,
      );
      this.assertTargetAuthorizationActive(generation, readyRecord);

      const committedClaim: OverlayTargetRecoveryClaim = Object.freeze({
        schemaVersion: 1,
        targetPid: pid,
        discoveryPath,
        staticDiscoveryPath,
        ...(expectedExecutablePath === undefined
          ? {}
          : { expectedExecutablePath }),
        ...(publishingClaim.leaseId === undefined
          ? {}
          : { leaseId: publishingClaim.leaseId }),
        phase: 'published',
        record,
      });
      await this.publishTargetRecoveryClaim(committedClaim);
      authorization.recoveryClaim = committedClaim;
      await this.runTargetAuthorizationPublicationHook(
        'recovery-claim-committed',
        committedClaim,
      );
      this.assertTargetAuthorizationActive(generation, readyRecord);
      const existingClient = this.activeClientsByPid.get(pid);
      if (
        existingClient &&
        existingClient.targetAuthorization !== authorization
      ) {
        existingClient.authenticated = false;
        existingClient.inputTranslator?.reset();
        this.activeClientsByPid.delete(pid);
        if (
          this.inputTranslatorsByPid.get(pid) === existingClient.inputTranslator
        ) {
          this.inputTranslatorsByPid.delete(pid);
        }
        existingClient.socket.destroy();
      }
      this.publishDiagnostic({
        code: 'target-authorized',
        pid,
      });
      return authorization;
    } catch (error) {
      const authenticatedClient = this.activeClientsByPid.get(pid);
      if (
        authorization &&
        authenticatedClient?.authenticated &&
        authenticatedClient.targetAuthorization === authorization
      ) {
        this.publishDiagnostic({
          code: 'target-authorized',
          pid,
        });
        return authorization;
      }
      if (rollbackPublishedIntentClaim) {
        removeOverlayTargetRecoveryClaimIfOwned(
          pid,
          rollbackPublishedIntentClaim,
        );
      }
      if (rollbackPriorIntentClaim) {
        removeOverlayTargetRecoveryClaimIfOwned(pid, rollbackPriorIntentClaim);
      }
      if (generation === this.generation) {
        this.publishDiagnostic({
          code: 'target-authorization-failed',
          pid,
          context: errorCodeContext(error),
        });
      }
      if (authorization) {
        if (this.targetAuthorizationsByPid.get(pid) === authorization) {
          this.targetAuthorizationsByPid.delete(pid);
        }
        if (
          this.targetAuthorizationsByDiscoveryPath.get(discoveryPathKey) ===
          authorization
        ) {
          this.targetAuthorizationsByDiscoveryPath.delete(discoveryPathKey);
        }
      }
      this.releaseDiscoveryEndpoint(staticDiscoveryEndpointReservation);
      throw error;
    }
  }

  private releaseTargetAuthorization(authorization: TargetAuthorization): void {
    if (
      this.targetAuthorizationsByPid.get(authorization.pid) !== authorization
    ) {
      return;
    }
    if (authorization.references > 0) {
      --authorization.references;
    }
    if (authorization.references !== 0) {
      return;
    }

    this.targetAuthorizationsByPid.delete(authorization.pid);
    if (
      this.targetAuthorizationsByDiscoveryPath.get(
        authorization.discoveryPathKey,
      ) === authorization
    ) {
      this.targetAuthorizationsByDiscoveryPath.delete(
        authorization.discoveryPathKey,
      );
    }
    this.releaseDiscoveryEndpoint(
      authorization.staticDiscoveryEndpointReservation,
    );
    const activeClient = this.activeClientsByPid.get(authorization.pid);
    if (activeClient?.targetAuthorization === authorization) {
      activeClient.socket.destroy();
    }
  }

  private async finishStart(
    server: Server,
    token: string,
    generation: number,
    resolve: (record: OverlayDiscoveryRecord) => void,
    reject: (reason: Error) => void,
  ): Promise<void> {
    if (this.generation !== generation || this.server !== server) {
      return;
    }

    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('Overlay transport did not receive a TCP port'));
      this.stop();
      return;
    }

    const record: OverlayDiscoveryRecord = {
      version: OVERLAY_TRANSPORT_PROTOCOL_VERSION,
      pid: process.pid,
      port: address.port,
      token,
    };

    try {
      await this.publishDiscovery(this.discoveryPath, record);
      if (this.generation !== generation || this.server !== server) {
        await this.removeDiscoveryIfOwned(this.discoveryPath, record);
        return;
      }
      this.discoveryRecord = record;
      this.rejectReady = undefined;
      resolve(record);
      this.publishDiagnostic({
        code: 'transport-ready',
        context: { port: record.port },
      });
    } catch (error) {
      if (this.generation === generation) {
        this.publishDiagnostic({
          code: 'transport-discovery-failed',
          context: errorCodeContext(error),
        });
      }
      reject(error instanceof Error ? error : new Error(String(error)));
      if (this.generation === generation) {
        this.stop();
      }
    }
  }

  private async publishDiscovery(
    discoveryPath: string,
    record: OverlayDiscoveryRecord,
  ): Promise<void> {
    await mkdir(dirname(discoveryPath), { recursive: true });
    const temporaryPath = `${discoveryPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(record), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, discoveryPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async publishTargetRecoveryClaim(
    claim: OverlayTargetRecoveryClaim,
  ): Promise<void> {
    await this.targetRecoveryClaimWriteHook?.(claim);
    const claimPath = defaultOverlayTargetRecoveryClaimPath(claim.targetPid);
    await mkdir(dirname(claimPath), { recursive: true });
    const temporaryPath = `${claimPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(claim), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, claimPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async runTargetAuthorizationPublicationHook(
    phase: OverlayTargetAuthorizationPublicationPhase,
    claim: OverlayTargetRecoveryClaim,
  ): Promise<void> {
    await this.targetAuthorizationPublicationHook?.(phase, claim);
  }

  private assertTargetAuthorizationActive(
    generation: number,
    readyRecord: OverlayDiscoveryRecord,
  ): void {
    if (
      generation !== this.generation ||
      this.discoveryRecord !== readyRecord ||
      !this.server
    ) {
      throw new Error('Overlay transport stopped before target authorization');
    }
  }

  private async removeDiscoveryIfOwned(
    discoveryPath: string,
    record: OverlayDiscoveryRecord,
  ): Promise<void> {
    try {
      const contents = await readFile(discoveryPath, 'utf8');
      const current: unknown = JSON.parse(contents);
      if (isOwnedDiscoveryRecord(current, record)) {
        await unlink(discoveryPath);
      }
    } catch {
      // The discovery file may already have been removed or replaced.
    }
  }

  private removeDiscoveryIfOwnedSync(
    discoveryPath: string,
    record: OverlayDiscoveryRecord,
  ): void {
    try {
      const contents = readFileSync(discoveryPath, 'utf8');
      const current: unknown = JSON.parse(contents);
      if (isOwnedDiscoveryRecord(current, record)) {
        unlinkSync(discoveryPath);
      }
    } catch {
      // The discovery file may already have been removed or replaced.
    }
  }

  private acceptClient(socket: Socket): void {
    socket.setNoDelay(true);
    let client: ClientState;
    client = {
      socket,
      writer: new BackpressurePacketQueue(socket, (error) => {
        this.handleClientSocketError(client, error);
      }),
      receiveBuffer: Buffer.alloc(0),
      authenticated: false,
      diagnosticRates: new Map(),
    };
    this.clients.add(client);
    socket.on('data', (chunk: Buffer) => this.receiveClientData(client, chunk));
    socket.on('drain', () => client.writer.handleDrain());
    socket.on('error', (error) => {
      this.handleClientSocketError(client, error);
    });
    socket.on('close', () => {
      const isAuthoritativeClient =
        client.authenticated &&
        client.pid !== undefined &&
        this.activeClientsByPid.get(client.pid) === client;
      client.inputTranslator?.reset();
      if (
        client.pid !== undefined &&
        this.inputTranslatorsByPid.get(client.pid) === client.inputTranslator
      ) {
        this.inputTranslatorsByPid.delete(client.pid);
      }
      if (isAuthoritativeClient && client.pid !== undefined) {
        this.activeClientsByPid.delete(client.pid);
      }
      client.writer.clear();
      client.diagnosticRates.clear();
      this.clients.delete(client);
      if (isAuthoritativeClient && client.pid !== undefined) {
        const targetPath = client.path ?? '';
        const exitWatch = this.registerProcessExitWatch(client.pid, targetPath);
        this.emitLifecycleEvent('game.process.transport-lost', {
          pid: client.pid,
          path: targetPath,
        });
        this.pollProcessExit(exitWatch);
      }
    });
  }

  private receiveClientData(client: ClientState, chunk: Buffer): void {
    client.receiveBuffer = Buffer.concat([client.receiveBuffer, chunk]);
    while (client.receiveBuffer.byteLength >= PACKET_PREFIX_BYTES) {
      const bodyBytes = client.receiveBuffer.readUInt32LE(0);
      const kind = client.receiveBuffer.readUInt8(4);
      if (kind !== PACKET_KIND_JSON || bodyBytes > MAX_JSON_BODY_BYTES) {
        this.rejectAuthenticatedPacket(
          client,
          kind !== PACKET_KIND_JSON
            ? 'unsupported-packet-kind'
            : 'json-body-too-large',
        );
        client.socket.destroy();
        return;
      }

      const packetBytes = PACKET_PREFIX_BYTES + bodyBytes;
      if (client.receiveBuffer.byteLength < packetBytes) {
        return;
      }

      const body = client.receiveBuffer.subarray(
        PACKET_PREFIX_BYTES,
        packetBytes,
      );
      client.receiveBuffer = client.receiveBuffer.subarray(packetBytes);
      let accepted = false;
      try {
        accepted = this.receiveJsonMessage(client, body);
      } catch {
        accepted = this.rejectAuthenticatedPacket(
          client,
          'packet-handler-failed',
        );
      }
      if (!accepted) {
        client.socket.destroy();
        return;
      }
    }

    if (
      client.receiveBuffer.byteLength >
      MAX_JSON_BODY_BYTES + PACKET_PREFIX_BYTES
    ) {
      this.rejectAuthenticatedPacket(client, 'receive-buffer-too-large');
      client.socket.destroy();
    }
  }

  private receiveJsonMessage(client: ClientState, body: Buffer): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return this.rejectAuthenticatedPacket(client, 'malformed-json');
    }
    if (!isJsonObject(parsed) || typeof parsed.type !== 'string') {
      return this.rejectAuthenticatedPacket(client, 'invalid-message-shape');
    }

    if (!client.authenticated) {
      return this.authenticateClient(client, parsed);
    }
    if (
      !parsed.type.startsWith('game.') ||
      parsed.type === 'game.process' ||
      parsed.type === 'game.process.disconnected' ||
      parsed.type === 'game.process.transport-lost'
    ) {
      return this.rejectAuthenticatedPacket(client, 'reserved-event');
    }

    const eventName = parsed.type;
    const authoritativePayload: JsonObject = { ...parsed, pid: client.pid };
    delete authoritativePayload.type;
    if (eventName === 'game.target.surface') {
      const surface = parseOverlayTargetSurface(authoritativePayload);
      if (!surface) {
        return this.rejectAuthenticatedPacket(
          client,
          'invalid-target-surface',
          eventName,
        );
      }
      this.emitEvent(eventName, { ...surface });
      return true;
    }
    if (eventName === 'game.target.surface.removed') {
      const removed = parseOverlayTargetSurfaceRemoved(authoritativePayload);
      if (!removed) {
        return this.rejectAuthenticatedPacket(
          client,
          'invalid-target-surface-removal',
          eventName,
        );
      }
      this.emitEvent(eventName, { ...removed });
      return true;
    }
    if (eventName === 'game.graphics.fps') {
      const fps = parseOverlayGraphicsFps(authoritativePayload);
      if (!fps) {
        return this.rejectAuthenticatedPacket(
          client,
          'invalid-graphics-fps',
          eventName,
        );
      }
      this.emitEvent(eventName, { ...fps });
      return true;
    }
    if (eventName === 'game.diagnostic') {
      const diagnostic =
        client.pid === undefined
          ? null
          : parseOverlayRuntimeDiagnosticPacket(parsed, client.pid);
      if (!diagnostic) {
        return this.rejectAuthenticatedPacket(
          client,
          'invalid-runtime-diagnostic',
          eventName,
        );
      }
      if (this.takeDiagnosticRate(client.diagnosticRates, diagnostic.code)) {
        this.queueDiagnostic(diagnostic);
      }
      return true;
    }
    if (eventName === 'game.input') {
      const input =
        client.pid === undefined
          ? null
          : parseNativeInputMessage(parsed, client.pid);
      if (!input) {
        return this.rejectAuthenticatedPacket(
          client,
          'invalid-game-input',
          eventName,
        );
      }
      this.emitEvent(eventName, { ...input });
      return true;
    }
    if (
      (eventName === 'game.window.focused' && parsed.focusWindowId === 0) ||
      (eventName === 'game.input.intercept' && parsed.intercepting === false)
    ) {
      client.inputTranslator?.reset();
    }
    const payload: JsonObject = authoritativePayload;
    this.emitEvent(eventName, payload);
    return true;
  }

  private authenticateClient(client: ClientState, hello: JsonObject): boolean {
    if (
      hello.type !== 'game.process' ||
      hello.protocolVersion !== OVERLAY_TRANSPORT_PROTOCOL_VERSION ||
      typeof hello.token !== 'string' ||
      typeof hello.pid !== 'number' ||
      !Number.isInteger(hello.pid) ||
      hello.pid <= 0 ||
      hello.pid > 0xffffffff ||
      typeof hello.path !== 'string'
    ) {
      return false;
    }
    const targetAuthorization = this.targetAuthorizationsByPid.get(hello.pid);
    const tokenMatches = targetAuthorization
      ? tokensEqual(hello.token, targetAuthorization.record.token)
      : this.token !== undefined && tokensEqual(hello.token, this.token);
    if (!tokenMatches) {
      this.publishDiagnostic({
        code: 'target-authentication-rejected',
        ...(targetAuthorization ? { pid: targetAuthorization.pid } : {}),
        context: {
          scope: targetAuthorization ? 'targeted' : 'global',
        },
      });
      return false;
    }
    if (
      targetAuthorization?.expectedExecutablePath !== undefined &&
      normalizeExecutablePathIdentity(hello.path) !==
        targetAuthorization.expectedExecutablePath
    ) {
      this.publishDiagnostic({
        code: 'target-authentication-rejected',
        pid: targetAuthorization.pid,
        context: {
          scope: 'targeted',
        },
      });
      return false;
    }

    const existing = this.activeClientsByPid.get(hello.pid);
    if (existing && existing !== client) {
      // A payload can reconnect before the old socket's close callback runs.
      // Retire it first so that callback cannot publish a false disconnect for
      // the newly authoritative socket with the same PID.
      existing.authenticated = false;
      existing.inputTranslator?.reset();
      existing.socket.destroy();
    }

    const inputTranslator = new InputEventTranslator();
    this.cancelProcessExitWatch(hello.pid);
    client.authenticated = true;
    client.pid = hello.pid;
    client.path = hello.path;
    client.targetAuthorization = targetAuthorization;
    client.inputTranslator = inputTranslator;
    this.activeClientsByPid.set(hello.pid, client);
    this.inputTranslatorsByPid.set(hello.pid, inputTranslator);
    this.sendAuthenticatedSnapshot(client);
    this.emitEvent('game.process', {
      pid: hello.pid,
      path: hello.path,
    });
    this.publishDiagnostic({
      code: 'target-authenticated',
      pid: hello.pid,
    });
    return true;
  }

  private sendAuthenticatedSnapshot(client: ClientState): void {
    client.writer.sendControl(
      encodeJsonTransportPacket({
        type: 'overlay.init',
        windows: Array.from(this.windows.values(), cloneWindowMetadata),
      }),
    );
    for (const [windowId, frame] of this.latestFrames) {
      client.writer.sendFrame(windowId, frame);
    }
    if (this.inputIntercept !== undefined) {
      client.writer.sendControl(
        encodeJsonTransportPacket({
          type: 'command.input.intercept',
          intercept: this.inputIntercept,
        }),
      );
    }
  }

  private emitEvent(event: string, payload: JsonObject): void {
    if (this.callback) {
      this.callback(event, payload);
    } else {
      this.pendingEvents.push({ event, payload });
    }
  }

  private publishDiagnostic(diagnostic: {
    code: OverlayDiagnosticCode;
    pid?: number;
    context?: Readonly<Record<string, OverlayDiagnosticContextValue>>;
  }): void {
    const canonical = parseOverlayDiagnostic({
      schemaVersion: 1,
      source: 'electron-overlay-transport',
      ...diagnostic,
    });
    if (!canonical) {
      return;
    }
    if (!this.takeDiagnosticRate(this.diagnosticRates, canonical.code)) {
      return;
    }
    this.queueDiagnostic(canonical);
  }

  private takeDiagnosticRate(
    rates: Map<OverlayDiagnosticCode, DiagnosticRateState>,
    code: OverlayDiagnosticCode,
  ): boolean {
    const now = Date.now();
    let rate = rates.get(code);
    if (
      !rate ||
      now - rate.windowStartedAt >= DIAGNOSTIC_RATE_WINDOW_MS ||
      now < rate.windowStartedAt
    ) {
      rate = { windowStartedAt: now, count: 0 };
      rates.set(code, rate);
    }
    if (rate.count >= MAX_DIAGNOSTICS_PER_CODE) {
      return false;
    }
    rate.count += 1;
    return true;
  }

  private queueDiagnostic(diagnostic: OverlayDiagnostic): void {
    if (this.diagnosticCallback) {
      this.deliverDiagnostic(diagnostic);
      return;
    }
    if (this.pendingDiagnostics.length >= MAX_PENDING_DIAGNOSTICS) {
      this.pendingDiagnostics.shift();
    }
    this.pendingDiagnostics.push(diagnostic);
  }

  private deliverDiagnostic(diagnostic: OverlayDiagnostic): void {
    try {
      this.diagnosticCallback?.(diagnostic);
    } catch {
      // Diagnostic consumers cannot interrupt transport or target lifecycle.
    }
  }

  private rejectAuthenticatedPacket(
    client: ClientState,
    reason: OverlayPacketRejectionReason,
    eventType?: string,
  ): false {
    if (
      client.authenticated &&
      client.pid !== undefined &&
      !client.packetRejectionDiagnosed
    ) {
      client.packetRejectionDiagnosed = true;
      this.publishDiagnostic({
        code: 'target-packet-rejected',
        pid: client.pid,
        context: {
          reason,
          ...(eventType === undefined ? {} : { eventType }),
        },
      });
    }
    return false;
  }

  private emitLifecycleEvent(event: string, payload: JsonObject): void {
    try {
      this.emitEvent(event, payload);
    } catch {
      // Lifecycle observation must continue even if a consumer callback fails.
    }
  }

  private registerProcessExitWatch(
    pid: number,
    targetPath: string,
  ): ProcessExitWatch {
    this.cancelProcessExitWatch(pid);
    const watch: ProcessExitWatch = { pid, path: targetPath };
    this.processExitWatchesByPid.set(pid, watch);
    return watch;
  }

  private pollProcessExit(watch: ProcessExitWatch): void {
    if (this.processExitWatchesByPid.get(watch.pid) !== watch) {
      return;
    }

    let alive = true;
    try {
      alive = this.isProcessAlive(watch.pid);
    } catch (error) {
      // Failure to inspect a process is not proof that it exited.
      alive = true;
      if (!watch.inspectionFailureDiagnosed) {
        watch.inspectionFailureDiagnosed = true;
        this.publishDiagnostic({
          code: 'target-process-inspection-failed',
          pid: watch.pid,
          context: errorCodeContext(error),
        });
      }
    }
    if (!alive) {
      this.processExitWatchesByPid.delete(watch.pid);
      clearOverlayTargetRecoveryClaimForExitedPid(watch.pid);
      this.emitLifecycleEvent('game.process.disconnected', {
        pid: watch.pid,
        path: watch.path,
      });
      return;
    }

    watch.timer = setTimeout(
      () => this.pollProcessExit(watch),
      this.processExitPollIntervalMs,
    );
    watch.timer.unref();
  }

  private cancelProcessExitWatch(pid: number): void {
    const watch = this.processExitWatchesByPid.get(pid);
    if (!watch) {
      return;
    }
    this.processExitWatchesByPid.delete(pid);
    if (watch.timer) {
      clearTimeout(watch.timer);
      watch.timer = undefined;
    }
  }

  private clearProcessExitWatches(): void {
    for (const pid of this.processExitWatchesByPid.keys()) {
      this.cancelProcessExitWatch(pid);
    }
  }

  private resetInputTranslators(): void {
    this.fallbackInputTranslator.reset();
    for (const translator of this.inputTranslatorsByPid.values()) {
      translator.reset();
    }
  }

  private broadcastControl(message: JsonObject): void {
    this.broadcastControlPacket(encodeJsonTransportPacket(message));
  }

  private broadcastControlPacket(packet: Buffer): void {
    for (const client of this.clients) {
      if (client.authenticated) {
        client.writer.sendControl(packet);
      }
    }
  }

  private broadcastWindowBarrierPacket(windowId: number, packet: Buffer): void {
    for (const client of this.clients) {
      if (client.authenticated) {
        client.writer.dropPendingFrames(windowId);
        client.writer.sendControl(packet);
      }
    }
  }

  private handleClientSocketError(client: ClientState, error: unknown): void {
    if (
      client.authenticated &&
      client.pid !== undefined &&
      !client.socketErrorDiagnosed
    ) {
      client.socketErrorDiagnosed = true;
      this.publishDiagnostic({
        code: 'target-socket-error',
        pid: client.pid,
        context: errorCodeContext(error),
      });
    }
    client.socket.destroy();
  }
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

function normalizeOptionalExecutablePathIdentity(
  value: string | undefined,
): string | undefined {
  return value === undefined
    ? undefined
    : normalizeExecutablePathIdentity(value);
}

function selectPublishedRecoveryRecord(
  claim: OverlayTargetRecoveryClaim,
): OverlayDiscoveryRecord | undefined {
  const records = [claim.record, claim.previousRecord].filter(
    (record): record is OverlayDiscoveryRecord => record !== undefined,
  );
  for (const record of records) {
    if (
      discoveryPathMatchesAnyRecord(claim.discoveryPath, [record]) ||
      discoveryPathMatchesAnyRecord(claim.staticDiscoveryPath, [record]) ||
      discoveryPathMatchesAnyRecord(
        join(
          dirname(claim.discoveryPath),
          OVERLAY_TRANSPORT_TARGET_ROUTE_FILE_NAME,
        ),
        [record],
      )
    ) {
      return record;
    }
  }
  if (claim.phase === 'publishing') {
    return claim.previousRecord ?? claim.record;
  }
  return claim.phase === 'published' ? claim.record : undefined;
}

function isErrnoException(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
