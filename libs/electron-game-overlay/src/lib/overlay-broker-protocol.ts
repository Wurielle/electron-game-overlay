import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { win32 } from 'node:path';

/**
 * The broker control protocol is intentionally frozen at v1. Compatible SDK
 * releases evolve through optional hello metadata and capabilities rather
 * than changing this value.
 */
export const OVERLAY_BROKER_PROTOCOL_VERSION = 1 as const;
/**
 * Frozen defaults for v1 clients that predate runtime-provider metadata.
 * These are protocol facts and must never track the current package values.
 */
export const OVERLAY_BROKER_LEGACY_RUNTIME_GENERATION = 1 as const;
export const OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MIN = 1 as const;
export const OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MAX = 1 as const;
/**
 * Monotonic generation of the runtime provider shipped by this SDK. Bump this
 * only with the matching staged-artifact manifests, never for package semver.
 */
export const OVERLAY_BROKER_RUNTIME_GENERATION = 1 as const;
/** Current target transport spoken by the broker and injected runtime. */
export const OVERLAY_BROKER_TARGET_TRANSPORT_VERSION = 1 as const;
/**
 * Inclusive target-transport range supported by this runtime provider. Every
 * backwards-compatible member of protocol family v1 must keep this minimum at
 * literal v1; a provider may add newer transports by raising only the maximum.
 */
export const OVERLAY_BROKER_TARGET_TRANSPORT_MIN = 1 as const;
/** Inclusive target-transport range supported by this runtime provider. */
export const OVERLAY_BROKER_TARGET_TRANSPORT_MAX = 1 as const;
export const OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY =
  'global-window-order-v1' as const;
/**
 * Frozen capability baseline every v1 SDK client needs for safe same-PID
 * sharing. Never remove or reinterpret an entry within protocol family v1.
 */
export const OVERLAY_BROKER_REQUIRED_CAPABILITIES = Object.freeze([
  OVERLAY_BROKER_GLOBAL_WINDOW_ORDER_CAPABILITY,
  'input-arbitration-v1',
  'scene-multiplex-v1',
  'target-lease-election-v1',
  'target-telemetry-v1',
  'target-transport-v1',
] as const);

/** All capabilities advertised by this broker implementation. */
export const OVERLAY_BROKER_CAPABILITIES = Object.freeze([
  ...OVERLAY_BROKER_REQUIRED_CAPABILITIES,
] as const);

export const MAX_BROKER_JSON_BODY_BYTES = 1024 * 1024;
export const MAX_BROKER_FRAME_BODY_BYTES = 256 * 1024 * 1024;

const PACKET_KIND_JSON = 1;
const PACKET_KIND_FRAME = 2;
const PACKET_PREFIX_BYTES = 5;
const FRAME_HEADER_BYTES = 12;
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_LENGTH = 96;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_LEASE_ID_LENGTH = 128;
const MAX_VERSION_LABEL_LENGTH = 128;
const WINDOW_ORDER_TOKEN_HEX_LENGTH = 32;

export type OverlayBrokerCapability =
  (typeof OVERLAY_BROKER_CAPABILITIES)[number];

export type OverlayBrokerRuntimeProviderMetadata = Readonly<{
  /** Higher compatible generations are preferred before injection begins. */
  runtimeGeneration: number;
  /** Inclusive lower bound of target transport versions this provider ships. */
  targetTransportMin: number;
  /** Inclusive upper bound of target transport versions this provider ships. */
  targetTransportMax: number;
}>;

export type OverlayBrokerClientHello = Readonly<{
  type: 'broker.hello';
  protocolMin: number;
  protocolMax: number;
  requiredCapabilities: readonly string[];
  /**
   * Capabilities the client understands but does not necessarily require.
   * Legacy hellos omit this; their required capabilities remain supported.
   */
  supportedCapabilities?: readonly string[];
  clientPid: number;
  sdkVersion: string;
  /** Optional v1 extension; legacy hellos use generation 1. */
  runtimeGeneration?: number;
  /** Optional v1 extension; legacy hellos use target transport 1. */
  targetTransportMin?: number;
  /** Optional v1 extension; legacy hellos use target transport 1. */
  targetTransportMax?: number;
}>;

export type OverlayBrokerWelcome = Readonly<{
  type: 'broker.welcome';
  protocolVersion: 1;
  capabilities: readonly string[];
  sessionId: string;
  brokerPid: number;
}>;

export type OverlayBrokerTargetAuthorize = Readonly<{
  type: 'broker.target.authorize';
  requestId: string;
  pid: number;
  discoveryPath: string;
  expectedExecutablePath?: string;
  /** Optional v1 extension describing this lease's actual staged artifacts. */
  runtimeGeneration?: number;
  targetTransportMin?: number;
  targetTransportMax?: number;
  /** Stable opaque identity retained when this logical lease reconnects. */
  leaseId?: string;
  /** True only when this lease has previously sent an authorization request. */
  recovery?: boolean;
  /** True when this lease previously observed a broker-selected route. */
  routeEstablished?: boolean;
}>;

export type OverlayBrokerTargetRelease = Readonly<{
  type: 'broker.target.release';
  requestId: string;
  pid: number;
}>;

export type OverlayBrokerTargetIdentity = Readonly<{
  pid: number;
  executablePath: string;
  discoveryPath: string;
}>;

export type OverlayBrokerTargetAuthorized = Readonly<{
  type: 'broker.target.authorized';
  requestId: string;
  pid: number;
  disposition: 'injection-owner' | 'joined-existing';
  /** The one underlying rendezvous selected for this target host. */
  discoveryPath: string;
  target?: OverlayBrokerTargetIdentity;
}>;

export type OverlayBrokerTargetReleased = Readonly<{
  type: 'broker.target.released';
  requestId: string;
  pid: number;
}>;

export type OverlayBrokerRectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type OverlayBrokerCaption = Readonly<{
  left: number;
  right: number;
  top: number;
  height: number;
}>;

export type OverlayBrokerWindowUpsert = Readonly<{
  type: 'broker.window.upsert';
  windowId: number;
  name: string;
  transparent: boolean;
  rect: OverlayBrokerRectangle;
  caption?: OverlayBrokerCaption;
  scaleFactorMicros?: number;
  /** Broker-issued aggregate z-order token retained across broker restarts. */
  orderToken?: string;
}>;

export type OverlayBrokerWindowOrder = Readonly<{
  type: 'broker.window.order';
  windowId: number;
  orderToken: string;
}>;

export type OverlayBrokerWindowBounds = Readonly<{
  type: 'broker.window.bounds';
  windowId: number;
  rect: OverlayBrokerRectangle;
  caption?: OverlayBrokerCaption;
  scaleFactorMicros?: number;
  rasterChanged?: boolean;
}>;

export type OverlayBrokerWindowClose = Readonly<{
  type: 'broker.window.close';
  windowId: number;
}>;

export type OverlayBrokerInputIntercept = Readonly<{
  type: 'broker.input.intercept';
  intercept: boolean;
}>;

export type OverlayBrokerClientMessage =
  | OverlayBrokerClientHello
  | OverlayBrokerTargetAuthorize
  | OverlayBrokerTargetRelease
  | OverlayBrokerWindowUpsert
  | OverlayBrokerWindowBounds
  | OverlayBrokerWindowClose
  | OverlayBrokerInputIntercept;

export type OverlayBrokerErrorCode =
  | 'capability-incompatible'
  | 'duplicate-target-lease'
  | 'handshake-required'
  | 'invalid-message'
  | 'protocol-incompatible'
  | 'target-authorization-failed'
  | 'target-exited'
  | 'target-unavailable'
  | 'unexpected-frame'
  | 'window-unavailable';

export type OverlayBrokerError = Readonly<{
  type: 'broker.error';
  code: OverlayBrokerErrorCode;
  message: string;
  requestId?: string;
  pid?: number;
}>;

export type OverlayBrokerDiagnostic = Readonly<{
  type: 'broker.diagnostic';
  diagnostic: unknown;
}>;

export type OverlayBrokerServerMessage =
  | OverlayBrokerWelcome
  | OverlayBrokerTargetAuthorized
  | OverlayBrokerTargetReleased
  | OverlayBrokerWindowOrder
  | OverlayBrokerError
  | OverlayBrokerDiagnostic
  | Readonly<{ type: `game.${string}`; [key: string]: unknown }>;

export type OverlayBrokerFrame = Readonly<{
  windowId: number;
  width: number;
  height: number;
  pixels: Buffer;
}>;

export type OverlayBrokerPacket =
  | Readonly<{ kind: 'json'; value: unknown }>
  | Readonly<{ kind: 'frame'; frame: OverlayBrokerFrame }>;

/**
 * A stable singleton pipe for the current Windows user and broker protocol
 * major. The short identity hash avoids exposing account or home-directory
 * text in the global named-pipe namespace.
 */
export function defaultOverlayBrokerPipePath(): string {
  let account: Readonly<{ username: string; homedir: string }>;
  try {
    account = userInfo({ encoding: 'utf8' });
  } catch (error) {
    throw new Error(
      'Unable to resolve the Windows account identity for the overlay broker',
      { cause: error },
    );
  }
  if (!account.username || !win32.isAbsolute(account.homedir)) {
    throw new Error(
      'The Windows account identity for the overlay broker is incomplete',
    );
  }
  // This derivation is part of the permanent v1 singleton contract. Unlike
  // USERDOMAIN, USERPROFILE, TEMP, and os.homedir(), os.userInfo() comes from
  // the process token and remains stable across independently launched apps.
  const identity = [account.username, win32.normalize(account.homedir)]
    .join('\0')
    .normalize('NFKC')
    .toLowerCase();
  const suffix = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, 24);
  return `\\\\.\\pipe\\electron-game-overlay-broker-v1-${suffix}`;
}

export function encodeBrokerJsonPacket(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.byteLength > MAX_BROKER_JSON_BODY_BYTES) {
    throw new RangeError(
      `Overlay broker JSON packet exceeds ${MAX_BROKER_JSON_BODY_BYTES} bytes`,
    );
  }
  return encodePacket(PACKET_KIND_JSON, body);
}

export function encodeBrokerFramePacket(
  windowId: number,
  width: number,
  height: number,
  pixels: Buffer,
): Buffer {
  assertPositiveUint32(windowId, 'windowId');
  assertPositiveUint32(width, 'width');
  assertPositiveUint32(height, 'height');
  const expectedBytes = width * height * 4;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    pixels.byteLength !== expectedBytes
  ) {
    throw new RangeError(
      `Expected ${expectedBytes} BGRA bytes for a ${width}x${height} broker frame, got ${pixels.byteLength}`,
    );
  }
  const bodyBytes = FRAME_HEADER_BYTES + pixels.byteLength;
  if (bodyBytes > MAX_BROKER_FRAME_BODY_BYTES) {
    throw new RangeError(
      `Overlay broker frame packet exceeds ${MAX_BROKER_FRAME_BODY_BYTES} bytes`,
    );
  }
  const body = Buffer.allocUnsafe(bodyBytes);
  body.writeUInt32LE(windowId, 0);
  body.writeUInt32LE(width, 4);
  body.writeUInt32LE(height, 8);
  pixels.copy(body, FRAME_HEADER_BYTES);
  return encodePacket(PACKET_KIND_FRAME, body);
}

export class BrokerPacketDecoder {
  private buffer = Buffer.alloc(0);

  public push(chunk: Buffer): readonly OverlayBrokerPacket[] {
    if (chunk.byteLength !== 0) {
      this.buffer =
        this.buffer.byteLength === 0
          ? Buffer.from(chunk)
          : Buffer.concat([this.buffer, chunk]);
    }
    const packets: OverlayBrokerPacket[] = [];
    while (this.buffer.byteLength >= PACKET_PREFIX_BYTES) {
      const bodyBytes = this.buffer.readUInt32LE(0);
      const kind = this.buffer.readUInt8(4);
      const maximum =
        kind === PACKET_KIND_JSON
          ? MAX_BROKER_JSON_BODY_BYTES
          : kind === PACKET_KIND_FRAME
            ? MAX_BROKER_FRAME_BODY_BYTES
            : undefined;
      if (maximum === undefined) {
        throw new Error(`Unknown overlay broker packet kind ${kind}`);
      }
      if (bodyBytes > maximum) {
        throw new RangeError(
          `Overlay broker packet kind ${kind} exceeds ${maximum} bytes`,
        );
      }
      const packetBytes = PACKET_PREFIX_BYTES + bodyBytes;
      if (this.buffer.byteLength < packetBytes) {
        break;
      }
      const body = this.buffer.subarray(PACKET_PREFIX_BYTES, packetBytes);
      this.buffer = this.buffer.subarray(packetBytes);
      if (kind === PACKET_KIND_JSON) {
        let value: unknown;
        try {
          value = JSON.parse(body.toString('utf8'));
        } catch {
          throw new Error('Overlay broker received malformed JSON');
        }
        packets.push(Object.freeze({ kind: 'json', value }));
      } else {
        packets.push(
          Object.freeze({ kind: 'frame', frame: decodeFrameBody(body) }),
        );
      }
    }
    return packets;
  }
}

export function parseOverlayBrokerClientMessage(
  value: unknown,
): OverlayBrokerClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  switch (value.type) {
    case 'broker.hello':
      return parseHello(value);
    case 'broker.target.authorize':
      return parseTargetAuthorize(value);
    case 'broker.target.release':
      return parseTargetRelease(value);
    case 'broker.window.upsert':
      return parseWindowUpsert(value);
    case 'broker.window.bounds':
      return parseWindowBounds(value);
    case 'broker.window.close':
      return parseWindowClose(value);
    case 'broker.input.intercept':
      return typeof value.intercept === 'boolean'
        ? Object.freeze({
            type: 'broker.input.intercept',
            intercept: value.intercept,
          })
        : null;
    default:
      return null;
  }
}

export function negotiateOverlayBrokerProtocol(
  hello: OverlayBrokerClientHello,
  capabilities: ReadonlySet<string> = new Set(OVERLAY_BROKER_CAPABILITIES),
):
  | Readonly<{ accepted: true; protocolVersion: 1 }>
  | Readonly<{
      accepted: false;
      code: 'protocol-incompatible' | 'capability-incompatible';
      message: string;
    }> {
  if (
    hello.protocolMin > OVERLAY_BROKER_PROTOCOL_VERSION ||
    hello.protocolMax < OVERLAY_BROKER_PROTOCOL_VERSION
  ) {
    return Object.freeze({
      accepted: false,
      code: 'protocol-incompatible',
      message: `The broker supports protocol ${OVERLAY_BROKER_PROTOCOL_VERSION}, outside the requested range ${hello.protocolMin}-${hello.protocolMax}.`,
    });
  }
  const missing = hello.requiredCapabilities.filter(
    (capability) => !capabilities.has(capability),
  );
  if (missing.length !== 0) {
    return Object.freeze({
      accepted: false,
      code: 'capability-incompatible',
      message: `The broker does not provide required capabilities: ${missing.join(', ')}.`,
    });
  }
  return Object.freeze({ accepted: true, protocolVersion: 1 });
}

/**
 * Returns every capability the client claims it can consume. Required
 * capabilities are always included so a legacy hello without the optional
 * supportedCapabilities extension retains its original meaning.
 */
export function getOverlayBrokerClientSupportedCapabilities(
  hello: OverlayBrokerClientHello,
): readonly string[] {
  const capabilities = [...hello.requiredCapabilities];
  const unique = new Set(capabilities);
  for (const capability of hello.supportedCapabilities ?? []) {
    if (!unique.has(capability)) {
      unique.add(capability);
      capabilities.push(capability);
    }
  }
  return Object.freeze(capabilities);
}

/** Resolves optional v1 runtime-provider metadata using legacy-safe defaults. */
export function getOverlayBrokerRuntimeProviderMetadata(
  hello: OverlayBrokerClientHello,
): OverlayBrokerRuntimeProviderMetadata {
  const runtimeGeneration =
    hello.runtimeGeneration ?? OVERLAY_BROKER_LEGACY_RUNTIME_GENERATION;
  const targetTransportMin =
    hello.targetTransportMin ?? OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MIN;
  const targetTransportMax =
    hello.targetTransportMax ?? OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MAX;
  if (
    !isPositiveUint32(runtimeGeneration) ||
    !isPositiveUint32(targetTransportMin) ||
    !isPositiveUint32(targetTransportMax) ||
    targetTransportMin > targetTransportMax
  ) {
    throw new RangeError(
      'Overlay broker runtime provider metadata must contain a positive uint32 generation and an ordered positive uint32 target-transport range',
    );
  }
  return Object.freeze({
    runtimeGeneration,
    targetTransportMin,
    targetTransportMax,
  });
}

/** True when an inclusive provider range can speak the requested transport. */
export function supportsOverlayBrokerTargetTransport(
  metadata: OverlayBrokerRuntimeProviderMetadata,
  targetTransportVersion: number,
): boolean {
  return (
    isPositiveUint32(targetTransportVersion) &&
    targetTransportVersion >= metadata.targetTransportMin &&
    targetTransportVersion <= metadata.targetTransportMax
  );
}

/**
 * Returns target-specific artifact metadata when present, otherwise the
 * handshake metadata used by legacy v1 clients.
 */
export function getOverlayBrokerTargetRuntimeProviderMetadata(
  request: OverlayBrokerTargetAuthorize,
  hello: OverlayBrokerClientHello,
): OverlayBrokerRuntimeProviderMetadata {
  if (
    request.runtimeGeneration !== undefined &&
    request.targetTransportMin !== undefined &&
    request.targetTransportMax !== undefined
  ) {
    return Object.freeze({
      runtimeGeneration: request.runtimeGeneration,
      targetTransportMin: request.targetTransportMin,
      targetTransportMax: request.targetTransportMax,
    });
  }
  return getOverlayBrokerRuntimeProviderMetadata(hello);
}

function encodePacket(kind: number, body: Buffer): Buffer {
  const packet = Buffer.allocUnsafe(PACKET_PREFIX_BYTES + body.byteLength);
  packet.writeUInt32LE(body.byteLength, 0);
  packet.writeUInt8(kind, 4);
  body.copy(packet, PACKET_PREFIX_BYTES);
  return packet;
}

function decodeFrameBody(body: Buffer): OverlayBrokerFrame {
  if (body.byteLength < FRAME_HEADER_BYTES) {
    throw new Error('Overlay broker frame metadata is truncated');
  }
  const windowId = body.readUInt32LE(0);
  const width = body.readUInt32LE(4);
  const height = body.readUInt32LE(8);
  assertPositiveUint32(windowId, 'windowId');
  assertPositiveUint32(width, 'width');
  assertPositiveUint32(height, 'height');
  const pixels = body.subarray(FRAME_HEADER_BYTES);
  const expectedBytes = width * height * 4;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    pixels.byteLength !== expectedBytes
  ) {
    throw new Error(
      `Overlay broker frame ${width}x${height} requires ${expectedBytes} BGRA bytes, received ${pixels.byteLength}`,
    );
  }
  return Object.freeze({ windowId, width, height, pixels });
}

function parseHello(
  value: Record<string, unknown>,
): OverlayBrokerClientHello | null {
  if (
    !isPositiveUint32(value.protocolMin) ||
    !isPositiveUint32(value.protocolMax) ||
    value.protocolMin > value.protocolMax ||
    !isPositiveUint32(value.clientPid) ||
    typeof value.sdkVersion !== 'string' ||
    value.sdkVersion.length === 0 ||
    value.sdkVersion.length > MAX_VERSION_LABEL_LENGTH ||
    (value.runtimeGeneration !== undefined &&
      !isPositiveUint32(value.runtimeGeneration)) ||
    (value.targetTransportMin !== undefined &&
      !isPositiveUint32(value.targetTransportMin)) ||
    (value.targetTransportMax !== undefined &&
      !isPositiveUint32(value.targetTransportMax))
  ) {
    return null;
  }
  const requiredCapabilities = parseCapabilities(value.requiredCapabilities);
  const supportedCapabilities =
    value.supportedCapabilities === undefined
      ? undefined
      : parseCapabilities(value.supportedCapabilities);
  if (!requiredCapabilities || supportedCapabilities === null) {
    return null;
  }
  const runtimeGeneration =
    (value.runtimeGeneration as number | undefined) ??
    OVERLAY_BROKER_LEGACY_RUNTIME_GENERATION;
  const targetTransportMin =
    (value.targetTransportMin as number | undefined) ??
    OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MIN;
  const targetTransportMax =
    (value.targetTransportMax as number | undefined) ??
    OVERLAY_BROKER_LEGACY_TARGET_TRANSPORT_MAX;
  if (targetTransportMin > targetTransportMax) {
    return null;
  }
  return Object.freeze({
    type: 'broker.hello',
    protocolMin: value.protocolMin,
    protocolMax: value.protocolMax,
    requiredCapabilities,
    ...(supportedCapabilities === undefined ? {} : { supportedCapabilities }),
    clientPid: value.clientPid,
    sdkVersion: value.sdkVersion,
    ...(value.runtimeGeneration === undefined ? {} : { runtimeGeneration }),
    ...(value.targetTransportMin === undefined ? {} : { targetTransportMin }),
    ...(value.targetTransportMax === undefined ? {} : { targetTransportMax }),
  });
}

function parseCapabilities(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    return null;
  }
  const capabilities: string[] = [];
  const unique = new Set<string>();
  for (const capability of value) {
    if (
      typeof capability !== 'string' ||
      capability.length === 0 ||
      capability.length > MAX_CAPABILITY_LENGTH ||
      !/^[a-z0-9][a-z0-9.-]*$/.test(capability) ||
      unique.has(capability)
    ) {
      return null;
    }
    unique.add(capability);
    capabilities.push(capability);
  }
  return Object.freeze(capabilities);
}

function parseTargetAuthorize(
  value: Record<string, unknown>,
): OverlayBrokerTargetAuthorize | null {
  const common = parseTargetRequest(value);
  if (!common || typeof value.discoveryPath !== 'string') {
    return null;
  }
  const providerFieldCount = [
    value.runtimeGeneration,
    value.targetTransportMin,
    value.targetTransportMax,
  ].filter((field) => field !== undefined).length;
  if (
    value.discoveryPath.length === 0 ||
    value.discoveryPath.includes('\0') ||
    (value.expectedExecutablePath !== undefined &&
      (typeof value.expectedExecutablePath !== 'string' ||
        value.expectedExecutablePath.length === 0 ||
        value.expectedExecutablePath.includes('\0'))) ||
    (providerFieldCount !== 0 && providerFieldCount !== 3) ||
    (providerFieldCount === 3 &&
      (!isPositiveUint32(value.runtimeGeneration) ||
        !isPositiveUint32(value.targetTransportMin) ||
        !isPositiveUint32(value.targetTransportMax) ||
        value.targetTransportMin > value.targetTransportMax)) ||
    (value.leaseId !== undefined && !isLeaseId(value.leaseId)) ||
    (value.recovery !== undefined && typeof value.recovery !== 'boolean') ||
    (value.recovery === true && value.leaseId === undefined) ||
    (value.routeEstablished !== undefined &&
      typeof value.routeEstablished !== 'boolean') ||
    (value.routeEstablished === true && value.recovery !== true)
  ) {
    return null;
  }
  return Object.freeze({
    type: 'broker.target.authorize',
    ...common,
    discoveryPath: value.discoveryPath,
    ...(value.expectedExecutablePath === undefined
      ? {}
      : { expectedExecutablePath: value.expectedExecutablePath as string }),
    ...(providerFieldCount === 0
      ? {}
      : {
          runtimeGeneration: value.runtimeGeneration as number,
          targetTransportMin: value.targetTransportMin as number,
          targetTransportMax: value.targetTransportMax as number,
        }),
    ...(value.leaseId === undefined
      ? {}
      : { leaseId: value.leaseId as string }),
    ...(value.recovery === undefined
      ? {}
      : { recovery: value.recovery as boolean }),
    ...(value.routeEstablished === undefined
      ? {}
      : { routeEstablished: value.routeEstablished as boolean }),
  });
}

function parseTargetRelease(
  value: Record<string, unknown>,
): OverlayBrokerTargetRelease | null {
  const common = parseTargetRequest(value);
  return common
    ? Object.freeze({ type: 'broker.target.release', ...common })
    : null;
}

function parseTargetRequest(
  value: Record<string, unknown>,
): Readonly<{ requestId: string; pid: number }> | null {
  return isRequestId(value.requestId) && isPositiveUint32(value.pid)
    ? Object.freeze({ requestId: value.requestId, pid: value.pid })
    : null;
}

function parseWindowUpsert(
  value: Record<string, unknown>,
): OverlayBrokerWindowUpsert | null {
  const common = parseWindowGeometry(value);
  if (
    !common ||
    typeof value.name !== 'string' ||
    value.name.length > 1024 ||
    typeof value.transparent !== 'boolean' ||
    (value.orderToken !== undefined &&
      !isOverlayBrokerWindowOrderToken(value.orderToken))
  ) {
    return null;
  }
  return Object.freeze({
    type: 'broker.window.upsert',
    ...common,
    name: value.name,
    transparent: value.transparent,
    ...(value.orderToken === undefined
      ? {}
      : { orderToken: value.orderToken as string }),
  });
}

export function isOverlayBrokerWindowOrderToken(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    value.length === WINDOW_ORDER_TOKEN_HEX_LENGTH &&
    /^[0-9a-f]+$/.test(value) &&
    value !== '0'.repeat(WINDOW_ORDER_TOKEN_HEX_LENGTH)
  );
}

function parseWindowBounds(
  value: Record<string, unknown>,
): OverlayBrokerWindowBounds | null {
  const common = parseWindowGeometry(value);
  if (
    !common ||
    (value.rasterChanged !== undefined &&
      typeof value.rasterChanged !== 'boolean')
  ) {
    return null;
  }
  return Object.freeze({
    type: 'broker.window.bounds',
    ...common,
    ...(value.rasterChanged === undefined
      ? {}
      : { rasterChanged: value.rasterChanged as boolean }),
  });
}

function parseWindowClose(
  value: Record<string, unknown>,
): OverlayBrokerWindowClose | null {
  return isPositiveUint32(value.windowId)
    ? Object.freeze({
        type: 'broker.window.close',
        windowId: value.windowId,
      })
    : null;
}

function parseWindowGeometry(value: Record<string, unknown>): Readonly<{
  windowId: number;
  rect: OverlayBrokerRectangle;
  caption?: OverlayBrokerCaption;
  scaleFactorMicros?: number;
}> | null {
  if (!isPositiveUint32(value.windowId)) {
    return null;
  }
  const rect = parseRectangle(value.rect);
  if (!rect) {
    return null;
  }
  const caption =
    value.caption === undefined ? undefined : parseCaption(value.caption);
  if (value.caption !== undefined && !caption) {
    return null;
  }
  if (
    value.scaleFactorMicros !== undefined &&
    !isPositiveUint32(value.scaleFactorMicros)
  ) {
    return null;
  }
  return Object.freeze({
    windowId: value.windowId,
    rect,
    ...(caption ? { caption } : {}),
    ...(value.scaleFactorMicros === undefined
      ? {}
      : { scaleFactorMicros: value.scaleFactorMicros as number }),
  });
}

function parseRectangle(value: unknown): OverlayBrokerRectangle | null {
  if (
    !isRecord(value) ||
    !isSignedInt32(value.x) ||
    !isSignedInt32(value.y) ||
    !isPositiveUint32(value.width) ||
    !isPositiveUint32(value.height) ||
    value.width > 0x7fffffff ||
    value.height > 0x7fffffff
  ) {
    return null;
  }
  return Object.freeze({
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  });
}

function parseCaption(value: unknown): OverlayBrokerCaption | null {
  if (
    !isRecord(value) ||
    !isSignedInt32(value.left) ||
    !isSignedInt32(value.right) ||
    !isSignedInt32(value.top) ||
    !isSignedInt32(value.height)
  ) {
    return null;
  }
  return Object.freeze({
    left: value.left,
    right: value.right,
    top: value.top,
    height: value.height,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveUint32(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 0xffffffff
  );
}

function isSignedInt32(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= -0x80000000 &&
    value <= 0x7fffffff
  );
}

function isRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    !value.includes('\0')
  );
}

function isLeaseId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LEASE_ID_LENGTH &&
    !value.includes('\0')
  );
}

function assertPositiveUint32(value: number, name: string): void {
  if (!isPositiveUint32(value)) {
    throw new RangeError(`${name} must be a positive unsigned 32-bit integer`);
  }
}
