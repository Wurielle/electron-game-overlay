import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  InputEventTranslator,
  type NativeInputMessage,
  type TranslatedInputEvent,
} from './input-translation.js';
import type {
  NativeHotkey,
  NativeOverlay,
  NativeOverlayCommand,
  NativeOverlayWindowDetails,
  NativeOverlayWindowGeometry,
} from './native.js';

export const HUDHOOK_TRANSPORT_PROTOCOL_VERSION = 1;
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
export const MAX_FRAME_BODY_BYTES = 256 * 1024 * 1024;

const PACKET_KIND_JSON = 1;
const PACKET_KIND_FRAME = 2;
const PACKET_PREFIX_BYTES = 5;
const FRAME_HEADER_BYTES = 12;
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PROCESS_EXIT_POLL_INTERVAL_MS = 250;
const MIN_PROCESS_EXIT_POLL_INTERVAL_MS = 1;
const MAX_PROCESS_EXIT_POLL_INTERVAL_MS = 60_000;

export interface HudhookDiscoveryRecord {
  version: 1;
  pid: number;
  port: number;
  token: string;
}

export interface HudhookLoopbackTransportOptions {
  discoveryPath?: string;
  tokenFactory?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  processExitPollIntervalMs?: number;
}

interface JsonObject {
  [key: string]: unknown;
}

interface WindowMessage extends JsonObject {
  type: 'window';
  windowId: number;
  nativeHandle: number;
  name: string;
  transparent: boolean;
  resizable: boolean;
  maxWidth: number;
  maxHeight: number;
  minWidth: number;
  minHeight: number;
  dragBorderWidth: number;
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

  constructor(private readonly sink: PacketSink) {}

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
      this.blocked = !this.sink.write(entry.packet);
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
        this.blocked = !this.sink.write(entry.packet);
      }
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
  inputTranslator?: InputEventTranslator;
}

interface ProcessExitWatch {
  pid: number;
  path: string;
  timer?: ReturnType<typeof setTimeout>;
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

export function defaultHudhookDiscoveryPath(): string {
  return join(tmpdir(), 'electron-game-overlay', 'hudhook-transport-v1.json');
}

export function encodeJsonTransportPacket(value: JsonObject): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.byteLength > MAX_JSON_BODY_BYTES) {
    throw new RangeError(
      `Hudhook JSON packet exceeds ${MAX_JSON_BODY_BYTES} bytes`,
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
      `Hudhook frame packet exceeds ${MAX_FRAME_BODY_BYTES} bytes`,
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

function isValidToken(token: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(token);
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

function cloneWindowMessage(message: WindowMessage): WindowMessage {
  return {
    ...message,
    rect: { ...message.rect },
    ...(message.caption ? { caption: { ...message.caption } } : {}),
  };
}

function serializeHotkey(hotkey: NativeHotkey): JsonObject {
  return {
    name: hotkey.name,
    keyCode: hotkey.keyCode,
    ctrl: hotkey.modifiers?.ctrl ?? false,
    shift: hotkey.modifiers?.shift ?? false,
    alt: hotkey.modifiers?.alt ?? false,
    passthrough: hotkey.passthrough ?? false,
  };
}

function fpsPositionNumber(
  position: 'TopLeft' | 'TopRight' | 'BottomLeft' | 'BottomRight',
): number {
  switch (position) {
    case 'TopLeft':
      return 1;
    case 'TopRight':
      return 2;
    case 'BottomLeft':
      return 3;
    case 'BottomRight':
      return 4;
  }
}

export class HudhookLoopbackTransport implements NativeOverlay {
  private readonly discoveryPath: string;
  private readonly tokenFactory: () => string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processExitPollIntervalMs: number;
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
  private server: Server | undefined;
  private callback: ((event: string, ...args: any[]) => void) | undefined;
  private hotkeys: NativeHotkey[] = [];
  private showFps = false;
  private fpsPosition = 1;
  private latestCursor: string | undefined;
  private inputIntercept: boolean | undefined;
  private token: string | undefined;
  private discoveryRecord: HudhookDiscoveryRecord | undefined;
  private readyPromise: Promise<HudhookDiscoveryRecord> | undefined;
  private rejectReady: ((reason: Error) => void) | undefined;
  private generation = 0;

  constructor(options: HudhookLoopbackTransportOptions = {}) {
    this.discoveryPath = options.discoveryPath ?? defaultHudhookDiscoveryPath();
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString('hex'));
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.processExitPollIntervalMs =
      options.processExitPollIntervalMs ??
      DEFAULT_PROCESS_EXIT_POLL_INTERVAL_MS;
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

    const token = this.tokenFactory();
    if (!isValidToken(token)) {
      throw new Error(
        'Hudhook transport token must be exactly 32 bytes of hex',
      );
    }

    const generation = ++this.generation;
    const server = createServer((socket) => this.acceptClient(socket));
    this.server = server;
    this.token = token;
    this.readyPromise = new Promise<HudhookDiscoveryRecord>(
      (resolve, reject) => {
        this.rejectReady = reject;
        const handleStartupError = (error: Error) => {
          if (this.generation !== generation) {
            return;
          }
          this.server = undefined;
          this.token = undefined;
          this.readyPromise = undefined;
          this.rejectReady = undefined;
          reject(error);
        };

        server.once('error', handleStartupError);
        server.listen(0, LOOPBACK_HOST, () => {
          server.off('error', handleStartupError);
          server.on('error', () => {
            if (this.generation === generation && this.server === server) {
              this.stop();
            }
          });
          server.unref();
          void this.finishStart(server, token, generation, resolve, reject);
        });
      },
    );
    void this.readyPromise.catch(() => undefined);
  }

  public whenReady(): Promise<HudhookDiscoveryRecord> {
    if (!this.readyPromise) {
      return Promise.reject(
        new Error('Hudhook transport has not been started'),
      );
    }
    return this.readyPromise;
  }

  public stop(): void {
    const priorRecord = this.discoveryRecord;
    ++this.generation;
    this.rejectReady?.(new Error('Hudhook transport stopped before startup'));
    this.rejectReady = undefined;
    this.readyPromise = undefined;
    this.discoveryRecord = undefined;
    this.token = undefined;

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
    this.hotkeys = [];
    this.showFps = false;
    this.fpsPosition = 1;
    this.latestCursor = undefined;
    this.inputIntercept = undefined;
    this.pendingEvents.length = 0;
    this.callback = undefined;
    this.fallbackInputTranslator.reset();

    if (priorRecord) {
      this.removeDiscoveryIfOwnedSync(priorRecord);
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

  public setHotkeys(hotkeys: NativeHotkey[]): void {
    this.hotkeys = hotkeys.map((hotkey) => ({
      ...hotkey,
      ...(hotkey.modifiers ? { modifiers: { ...hotkey.modifiers } } : {}),
    }));
    this.broadcastControl({
      type: 'overlay.hotkey',
      hotkeys: this.hotkeys.map(serializeHotkey),
    });
  }

  public sendCommand(command: NativeOverlayCommand): void {
    switch (command.command) {
      case 'cursor':
        this.latestCursor = command.cursor;
        this.broadcastControl({
          type: 'command.cursor',
          cursor: command.cursor,
        });
        break;
      case 'fps':
        this.showFps = command.showfps;
        this.fpsPosition = fpsPositionNumber(command.position);
        this.broadcastControl({
          type: 'command.fps',
          showfps: command.showfps,
          position: this.fpsPosition,
        });
        break;
      case 'input.intercept':
        this.inputIntercept = command.intercept;
        if (!command.intercept) {
          this.resetInputTranslators();
        }
        this.broadcastControl({
          type: 'command.input.intercept',
          intercept: command.intercept,
        });
        break;
    }
  }

  public addWindow(
    windowId: number,
    details: NativeOverlayWindowDetails,
  ): void {
    assertUnsigned32(windowId, 'windowId');
    const message: WindowMessage = {
      type: 'window',
      windowId,
      nativeHandle: details.nativeHandle,
      name: details.name,
      transparent: details.transparent,
      resizable: details.resizable,
      maxWidth: details.maxWidth,
      maxHeight: details.maxHeight,
      minWidth: details.minWidth,
      minHeight: details.minHeight,
      dragBorderWidth: details.dragBorderWidth ?? 0,
      rect: { ...details.rect },
      ...(details.caption ? { caption: { ...details.caption } } : {}),
      ...(details.scaleFactorMicros !== undefined
        ? { scaleFactorMicros: details.scaleFactorMicros }
        : {}),
    };
    this.windows.delete(windowId);
    this.windows.set(windowId, message);
    this.latestFrames.delete(windowId);
    this.broadcastWindowBarrier(windowId, message);
  }

  public closeWindow(windowId: number): void {
    assertUnsigned32(windowId, 'windowId');
    this.windows.delete(windowId);
    this.latestFrames.delete(windowId);
    this.broadcastWindowBarrier(windowId, {
      type: 'window.close',
      windowId,
    });
  }

  public sendWindowBounds(
    windowId: number,
    details: NativeOverlayWindowGeometry,
  ): void {
    assertUnsigned32(windowId, 'windowId');
    const window = this.windows.get(windowId);
    if (window) {
      window.rect = { ...details.rect };
      if (details.maxWidth !== undefined) {
        window.maxWidth = details.maxWidth;
      }
      if (details.maxHeight !== undefined) {
        window.maxHeight = details.maxHeight;
      }
      if (details.minWidth !== undefined) {
        window.minWidth = details.minWidth;
      }
      if (details.minHeight !== undefined) {
        window.minHeight = details.minHeight;
      }
      if (details.dragBorderWidth !== undefined) {
        window.dragBorderWidth = details.dragBorderWidth;
      }
      if (details.caption !== undefined) {
        window.caption = { ...details.caption };
      }
      if (details.scaleFactorMicros !== undefined) {
        window.scaleFactorMicros = details.scaleFactorMicros;
      }
    }

    const message: JsonObject = {
      type: 'window.bounds',
      windowId,
      rect: { ...details.rect },
      ...(details.maxWidth !== undefined ? { maxWidth: details.maxWidth } : {}),
      ...(details.maxHeight !== undefined
        ? { maxHeight: details.maxHeight }
        : {}),
      ...(details.minWidth !== undefined ? { minWidth: details.minWidth } : {}),
      ...(details.minHeight !== undefined
        ? { minHeight: details.minHeight }
        : {}),
      ...(details.dragBorderWidth !== undefined
        ? { dragBorderWidth: details.dragBorderWidth }
        : {}),
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

    if (details.rasterChanged) {
      this.latestFrames.delete(windowId);
      this.broadcastWindowBarrier(windowId, message);
    } else {
      this.broadcastControl(message);
    }
  }

  public sendFrameBuffer(
    windowId: number,
    buffer: Buffer,
    width: number,
    height: number,
  ): void {
    if (!this.windows.has(windowId)) {
      return;
    }
    const packet = encodeFrameTransportPacket(windowId, width, height, buffer);
    this.latestFrames.set(windowId, packet);
    for (const client of this.clients) {
      if (client.authenticated) {
        client.writer.sendFrame(windowId, packet);
      }
    }
  }

  public translateInputEvent(
    event: NativeInputMessage,
  ): TranslatedInputEvent | undefined {
    if (event.pid !== undefined) {
      return this.inputTranslatorsByPid.get(event.pid)?.translate(event);
    }
    return this.fallbackInputTranslator.translate(event);
  }

  private async finishStart(
    server: Server,
    token: string,
    generation: number,
    resolve: (record: HudhookDiscoveryRecord) => void,
    reject: (reason: Error) => void,
  ): Promise<void> {
    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('Hudhook transport did not receive a TCP port'));
      this.stop();
      return;
    }

    const record: HudhookDiscoveryRecord = {
      version: HUDHOOK_TRANSPORT_PROTOCOL_VERSION,
      pid: process.pid,
      port: address.port,
      token,
    };

    try {
      await this.publishDiscovery(record);
      if (this.generation !== generation || this.server !== server) {
        await this.removeDiscoveryIfOwned(record);
        return;
      }
      this.discoveryRecord = record;
      this.rejectReady = undefined;
      resolve(record);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      if (this.generation === generation) {
        this.stop();
      }
    }
  }

  private async publishDiscovery(
    record: HudhookDiscoveryRecord,
  ): Promise<void> {
    await mkdir(dirname(this.discoveryPath), { recursive: true });
    const temporaryPath = `${this.discoveryPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(record), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, this.discoveryPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async removeDiscoveryIfOwned(
    record: HudhookDiscoveryRecord,
  ): Promise<void> {
    try {
      const contents = await readFile(this.discoveryPath, 'utf8');
      const current: unknown = JSON.parse(contents);
      if (
        isJsonObject(current) &&
        current.pid === record.pid &&
        current.port === record.port &&
        current.token === record.token
      ) {
        await unlink(this.discoveryPath);
      }
    } catch {
      // The discovery file may already have been removed or replaced.
    }
  }

  private removeDiscoveryIfOwnedSync(record: HudhookDiscoveryRecord): void {
    try {
      const contents = readFileSync(this.discoveryPath, 'utf8');
      const current: unknown = JSON.parse(contents);
      if (
        isJsonObject(current) &&
        current.pid === record.pid &&
        current.port === record.port &&
        current.token === record.token
      ) {
        unlinkSync(this.discoveryPath);
      }
    } catch {
      // The discovery file may already have been removed or replaced.
    }
  }

  private acceptClient(socket: Socket): void {
    socket.setNoDelay(true);
    const client: ClientState = {
      socket,
      writer: new BackpressurePacketQueue(socket),
      receiveBuffer: Buffer.alloc(0),
      authenticated: false,
    };
    this.clients.add(client);
    socket.on('data', (chunk: Buffer) => this.receiveClientData(client, chunk));
    socket.on('drain', () => client.writer.handleDrain());
    socket.on('error', () => socket.destroy());
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
        accepted = false;
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
      client.socket.destroy();
    }
  }

  private receiveJsonMessage(client: ClientState, body: Buffer): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return false;
    }
    if (!isJsonObject(parsed) || typeof parsed.type !== 'string') {
      return false;
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
      return false;
    }

    const eventName = parsed.type;
    if (
      (eventName === 'game.window.focused' && parsed.focusWindowId === 0) ||
      (eventName === 'game.input.intercept' && parsed.intercepting === false)
    ) {
      client.inputTranslator?.reset();
    }
    const payload: JsonObject = { ...parsed, pid: client.pid };
    delete payload.type;
    this.emitEvent(eventName, payload);
    return true;
  }

  private authenticateClient(client: ClientState, hello: JsonObject): boolean {
    if (
      hello.type !== 'game.process' ||
      hello.protocolVersion !== HUDHOOK_TRANSPORT_PROTOCOL_VERSION ||
      typeof hello.token !== 'string' ||
      !this.token ||
      !tokensEqual(hello.token, this.token) ||
      typeof hello.pid !== 'number' ||
      !Number.isInteger(hello.pid) ||
      hello.pid <= 0 ||
      hello.pid > 0xffffffff ||
      typeof hello.path !== 'string'
    ) {
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
    client.inputTranslator = inputTranslator;
    this.activeClientsByPid.set(hello.pid, client);
    this.inputTranslatorsByPid.set(hello.pid, inputTranslator);
    this.sendAuthenticatedSnapshot(client);
    this.emitEvent('game.process', {
      pid: hello.pid,
      path: hello.path,
    });
    return true;
  }

  private sendAuthenticatedSnapshot(client: ClientState): void {
    client.writer.sendControl(
      encodeJsonTransportPacket({
        type: 'overlay.init',
        processEnabled: true,
        hotkeys: this.hotkeys.map(serializeHotkey),
        windows: Array.from(this.windows.values(), cloneWindowMessage),
        showfps: this.showFps,
        fpsPosition: this.fpsPosition,
        dragMode: 1,
      }),
    );
    for (const [windowId, frame] of this.latestFrames) {
      client.writer.sendFrame(windowId, frame);
    }
    if (this.latestCursor !== undefined) {
      client.writer.sendControl(
        encodeJsonTransportPacket({
          type: 'command.cursor',
          cursor: this.latestCursor,
        }),
      );
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
    } catch {
      // Failure to inspect a process is not proof that it exited.
      alive = true;
    }
    if (!alive) {
      this.processExitWatchesByPid.delete(watch.pid);
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
    const packet = encodeJsonTransportPacket(message);
    for (const client of this.clients) {
      if (client.authenticated) {
        client.writer.sendControl(packet);
      }
    }
  }

  private broadcastWindowBarrier(windowId: number, message: JsonObject): void {
    const packet = encodeJsonTransportPacket(message);
    for (const client of this.clients) {
      if (client.authenticated) {
        client.writer.dropPendingFrames(windowId);
        client.writer.sendControl(packet);
      }
    }
  }
}
