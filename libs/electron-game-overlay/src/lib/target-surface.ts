import type {
  ElectronOverlayWindowFollowTargetOptions,
  OverlayGraphicsApi,
  OverlayGraphicsFps,
  OverlayTargetRect,
  OverlayTargetSize,
  OverlayTargetSurface,
  OverlayTargetSurfaceRemoved,
  Rect,
} from './types.js';

const GRAPHICS_APIS = new Set<OverlayGraphicsApi>([
  'd3d9',
  'd3d10',
  'd3d11',
  'd3d12',
  'opengl',
  'vulkan',
  'unknown',
]);
const HEX_IDENTIFIER_PATTERN = /^0x[1-9a-f][0-9a-f]{0,15}$/;
const MIN_I32 = -0x8000_0000;
const MAX_I32 = 0x7fff_ffff;

type JsonRecord = Record<string, unknown>;

export function parseOverlayTargetSurface(
  value: unknown,
): OverlayTargetSurface | null {
  if (!isRecord(value)) {
    return null;
  }

  const pid = parsePid(value.pid);
  const surfaceId = parseHexIdentifier(value.surfaceId);
  const hwnd = parseHexIdentifier(value.hwnd);
  const revision = parseRevision(value.revision);
  const graphicsApi = parseGraphicsApi(value.graphicsApi);
  const renderSize = parseSize(value.renderSize, true);
  const clientBounds = parseRect(value.clientBounds);
  const clientScreenBounds = parseRect(value.clientScreenBounds);
  const windowScreenBounds = parseRect(value.windowScreenBounds);
  const dpi = parseDpi(value.dpi);
  const monitor = parseMonitor(value.monitor);

  if (
    pid === null ||
    surfaceId === null ||
    hwnd === null ||
    revision === null ||
    graphicsApi === null ||
    renderSize === null ||
    clientBounds === null ||
    clientScreenBounds === null ||
    windowScreenBounds === null ||
    dpi === null ||
    monitor === null ||
    typeof value.focused !== 'boolean' ||
    typeof value.minimized !== 'boolean' ||
    typeof value.visible !== 'boolean' ||
    typeof value.fullscreen !== 'boolean'
  ) {
    return null;
  }

  return Object.freeze({
    pid,
    surfaceId,
    hwnd,
    revision,
    graphicsApi,
    renderSize,
    clientBounds,
    clientScreenBounds,
    windowScreenBounds,
    dpi,
    monitor,
    focused: value.focused,
    minimized: value.minimized,
    visible: value.visible,
    fullscreen: value.fullscreen,
  });
}

export function parseOverlayTargetSurfaceRemoved(
  value: unknown,
): OverlayTargetSurfaceRemoved | null {
  if (!isRecord(value)) {
    return null;
  }
  const pid = parsePid(value.pid);
  const surfaceId = parseHexIdentifier(value.surfaceId);
  const revision = parseRevision(value.revision);
  if (pid === null || surfaceId === null || revision === null) {
    return null;
  }
  return Object.freeze({ pid, surfaceId, revision });
}

export function parseOverlayGraphicsFps(
  value: unknown,
): OverlayGraphicsFps | null {
  if (!isRecord(value)) {
    return null;
  }
  const pid = parsePid(value.pid);
  if (
    pid === null ||
    typeof value.fps !== 'number' ||
    !Number.isFinite(value.fps) ||
    value.fps < 0
  ) {
    return null;
  }
  return Object.freeze({ pid, fps: value.fps });
}

export function isValidTargetSurfaceId(value: unknown): value is string {
  return parseHexIdentifier(value) !== null;
}

export function targetSurfaceKey(pid: number, surfaceId: string): string {
  return `${pid}:${surfaceId}`;
}

export function normalizeTargetFollowOptions(
  options: ElectronOverlayWindowFollowTargetOptions = {},
): ElectronOverlayWindowFollowTargetOptions {
  if (options.pid !== undefined && parsePid(options.pid) === null) {
    throw new RangeError('pid must be an unsigned non-zero 32-bit integer');
  }
  if (
    options.surfaceId !== undefined &&
    !isValidTargetSurfaceId(options.surfaceId)
  ) {
    throw new TypeError(
      'surfaceId must be a canonical lowercase non-zero 64-bit hexadecimal identifier',
    );
  }
  if (
    options.area !== undefined &&
    options.area !== 'render' &&
    options.area !== 'client'
  ) {
    throw new TypeError("area must be either 'render' or 'client'");
  }
  return Object.freeze({
    ...(options.pid !== undefined ? { pid: options.pid } : {}),
    ...(options.surfaceId !== undefined
      ? { surfaceId: options.surfaceId }
      : {}),
    area: options.area ?? 'render',
  });
}

/** Selects the most recently changed matching surface. */
export function selectTargetSurface(
  surfacesInChangeOrder: readonly OverlayTargetSurface[],
  options: ElectronOverlayWindowFollowTargetOptions,
): OverlayTargetSurface | null {
  for (let index = surfacesInChangeOrder.length - 1; index >= 0; index -= 1) {
    const surface = surfacesInChangeOrder[index];
    if (
      surface &&
      (options.pid === undefined || surface.pid === options.pid) &&
      (options.surfaceId === undefined ||
        surface.surfaceId === options.surfaceId)
    ) {
      return surface;
    }
  }
  return null;
}

/** Returns target screen placement with the requested compositor-local size. */
export function getTargetFollowPhysicalBounds(
  surface: OverlayTargetSurface,
  area: 'render' | 'client',
): Rect {
  const size: OverlayTargetSize =
    area === 'client'
      ? {
          width: surface.clientBounds.width,
          height: surface.clientBounds.height,
        }
      : surface.renderSize;
  return {
    x: surface.clientScreenBounds.x,
    y: surface.clientScreenBounds.y,
    width: size.width,
    height: size.height,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePid(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 0xffff_ffff
    ? value
    : null;
}

function parseRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function parseHexIdentifier(value: unknown): string | null {
  return typeof value === 'string' && HEX_IDENTIFIER_PATTERN.test(value)
    ? value
    : null;
}

function parseGraphicsApi(value: unknown): OverlayGraphicsApi | null {
  return typeof value === 'string' &&
    GRAPHICS_APIS.has(value as OverlayGraphicsApi)
    ? (value as OverlayGraphicsApi)
    : null;
}

function parseSize(
  value: unknown,
  positive: boolean,
): OverlayTargetSize | null {
  if (!isRecord(value)) {
    return null;
  }
  const minimum = positive ? 1 : 0;
  if (
    !isSafeIntegerInRange(value.width, minimum) ||
    !isSafeIntegerInRange(value.height, minimum)
  ) {
    return null;
  }
  return Object.freeze({ width: value.width, height: value.height });
}

function parseRect(value: unknown): OverlayTargetRect | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isSafeIntegerBetween(value.x, MIN_I32, MAX_I32) ||
    !isSafeIntegerBetween(value.y, MIN_I32, MAX_I32) ||
    !isSafeIntegerInRange(value.width, 1) ||
    !isSafeIntegerInRange(value.height, 1)
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

function parseDpi(value: unknown) {
  if (
    !isRecord(value) ||
    !isSafeIntegerInRange(value.x, 1) ||
    !isSafeIntegerInRange(value.y, 1)
  ) {
    return null;
  }
  const scaleFactor = value.x / 96;
  return Object.freeze({
    x: value.x,
    y: value.y,
    scaleFactor:
      Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1,
  });
}

function parseMonitor(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const id = parseHexIdentifier(value.id);
  const bounds = parseRect(value.bounds);
  const workArea = parseRect(value.workArea);
  if (id === null || bounds === null || workArea === null) {
    return null;
  }
  return Object.freeze({ id, bounds, workArea });
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isSafeIntegerInRange(
  value: unknown,
  minimum: number,
): value is number {
  return isSafeInteger(value) && value >= minimum && value <= 0xffff_ffff;
}

function isSafeIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return isSafeInteger(value) && value >= minimum && value <= maximum;
}
