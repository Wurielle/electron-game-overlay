import type {
  OverlayDiagnostic,
  OverlayDiagnosticCode,
  OverlayDiagnosticContextValue,
  OverlayDiagnosticSeverity,
  OverlayDiagnosticSource,
} from './types.js';

const MAX_DIAGNOSTIC_CONTEXT_ENTRIES = 8;

type DiagnosticDefinition = Readonly<{
  source: OverlayDiagnosticSource;
  severity: OverlayDiagnosticSeverity;
  message: string;
  pid: 'forbidden' | 'optional' | 'required';
  context:
    | 'none'
    | 'port'
    | 'error-code'
    | 'ego-error-code'
    | 'auth-scope'
    | 'packet-rejection';
}>;

const DIAGNOSTIC_DEFINITIONS = {
  'transport-ready': {
    source: 'electron-overlay-transport',
    severity: 'info',
    message: 'The overlay loopback transport is ready.',
    pid: 'forbidden',
    context: 'port',
  },
  'transport-listener-failed': {
    source: 'electron-overlay-transport',
    severity: 'error',
    message: 'The overlay loopback transport listener failed.',
    pid: 'forbidden',
    context: 'error-code',
  },
  'transport-discovery-failed': {
    source: 'electron-overlay-transport',
    severity: 'error',
    message: 'The overlay transport could not publish its discovery document.',
    pid: 'forbidden',
    context: 'error-code',
  },
  'target-authorized': {
    source: 'electron-overlay-transport',
    severity: 'info',
    message: 'The overlay transport prepared an exact-PID authorization.',
    pid: 'required',
    context: 'none',
  },
  'target-authorization-failed': {
    source: 'electron-overlay-transport',
    severity: 'error',
    message:
      'The overlay transport could not publish a target-specific authorization.',
    pid: 'required',
    context: 'error-code',
  },
  'target-authentication-rejected': {
    source: 'electron-overlay-transport',
    severity: 'warning',
    message: 'An overlay target presented an invalid transport credential.',
    pid: 'optional',
    context: 'auth-scope',
  },
  'target-authenticated': {
    source: 'electron-overlay-transport',
    severity: 'info',
    message: 'An injected overlay target authenticated successfully.',
    pid: 'required',
    context: 'none',
  },
  'target-packet-rejected': {
    source: 'electron-overlay-transport',
    severity: 'warning',
    message:
      'The overlay transport rejected a packet from an authenticated target.',
    pid: 'required',
    context: 'packet-rejection',
  },
  'target-socket-error': {
    source: 'electron-overlay-transport',
    severity: 'warning',
    message: 'An authenticated overlay target socket reported an error.',
    pid: 'required',
    context: 'error-code',
  },
  'target-process-inspection-failed': {
    source: 'electron-overlay-transport',
    severity: 'warning',
    message:
      'The overlay transport could not confirm whether a disconnected target exited.',
    pid: 'required',
    context: 'error-code',
  },
  'runtime-ready': {
    source: 'electron-game-overlay-runtime',
    severity: 'info',
    message: 'The injected overlay runtime initialized successfully.',
    pid: 'required',
    context: 'ego-error-code',
  },
  'runtime-swapchain-ready': {
    source: 'electron-game-overlay-runtime',
    severity: 'info',
    message: 'The injected overlay runtime initialized a render swap chain.',
    pid: 'required',
    context: 'ego-error-code',
  },
  'runtime-scene-query-failed': {
    source: 'electron-game-overlay-runtime',
    severity: 'error',
    message:
      'The injected overlay runtime could not query the transported scene.',
    pid: 'required',
    context: 'ego-error-code',
  },
  'runtime-scene-rendering-started': {
    source: 'electron-game-overlay-runtime',
    severity: 'info',
    message:
      'The injected overlay runtime started rendering transported Electron content.',
    pid: 'required',
    context: 'ego-error-code',
  },
  'runtime-frame-rejected': {
    source: 'electron-game-overlay-runtime',
    severity: 'warning',
    message:
      'The injected overlay runtime rejected a transported Electron frame.',
    pid: 'required',
    context: 'ego-error-code',
  },
  'runtime-frame-upload-failed': {
    source: 'electron-game-overlay-runtime',
    severity: 'error',
    message:
      'The injected overlay runtime could not upload a transported Electron frame.',
    pid: 'required',
    context: 'ego-error-code',
  },
  'runtime-input-router-reset': {
    source: 'electron-game-overlay-runtime',
    severity: 'warning',
    message: 'The injected overlay runtime reset its input router.',
    pid: 'required',
    context: 'ego-error-code',
  },
  'runtime-input-routing-failed': {
    source: 'electron-game-overlay-runtime',
    severity: 'error',
    message: 'The injected overlay runtime could not route overlay input.',
    pid: 'required',
    context: 'ego-error-code',
  },
} satisfies Record<OverlayDiagnosticCode, DiagnosticDefinition>;

const EGO_ERROR_CODES = new Set([-1, -2, -3, -4, -5, -6, -7]);
const RUNTIME_DIAGNOSTIC_PACKET_KEYS = new Set([
  'type',
  'schemaVersion',
  'source',
  'code',
  'context',
]);

const SAFE_ERROR_CODES = new Set([
  'EACCES',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
  'EAGAIN',
  'EBADF',
  'EBUSY',
  'ECANCELED',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EFAULT',
  'EHOSTUNREACH',
  'EINTR',
  'EINVAL',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENETDOWN',
  'ENETUNREACH',
  'ENFILE',
  'ENOBUFS',
  'ENODEV',
  'ENOENT',
  'ENOMEM',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'ENOTFOUND',
  'ENOTSUP',
  'EPERM',
  'EPIPE',
  'EPROTO',
  'EROFS',
  'ETIMEDOUT',
  'UNKNOWN',
]);

const PACKET_REJECTION_EVENT_BY_REASON = {
  'unsupported-packet-kind': undefined,
  'json-body-too-large': undefined,
  'packet-handler-failed': undefined,
  'receive-buffer-too-large': undefined,
  'malformed-json': undefined,
  'invalid-message-shape': undefined,
  'reserved-event': undefined,
  'invalid-target-surface': 'game.target.surface',
  'invalid-target-surface-removal': 'game.target.surface.removed',
  'invalid-graphics-fps': 'game.graphics.fps',
  'invalid-runtime-diagnostic': 'game.diagnostic',
} as const;

export type OverlayPacketRejectionReason =
  keyof typeof PACKET_REJECTION_EVENT_BY_REASON;

export function parseOverlayDiagnostic(
  value: unknown,
): OverlayDiagnostic | null {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return null;
  }

  const code = parseDiagnosticCode(value.code);
  if (!code) {
    return null;
  }
  const definition = DIAGNOSTIC_DEFINITIONS[code];

  // The code owns all human-readable output. Producers may omit these
  // redundant fields, but cannot override them with credentials, paths,
  // stacks, or arbitrary remote error text.
  if (
    value.source !== definition.source ||
    (value.severity !== undefined && value.severity !== definition.severity) ||
    (value.message !== undefined && value.message !== definition.message)
  ) {
    return null;
  }

  const pid = parseDiagnosticPid(value.pid, definition.pid);
  if (pid === null) {
    return null;
  }

  const context = parseDiagnosticContext(value.context, definition.context);
  if (context === null) {
    return null;
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    source: definition.source,
    severity: definition.severity,
    code,
    message: definition.message,
    ...(pid === undefined ? {} : { pid }),
    ...(context === undefined ? {} : { context }),
  });
}

export function parseOverlayRuntimeDiagnosticPacket(
  value: unknown,
  authoritativePid: number,
): OverlayDiagnostic | null {
  if (
    !isRecord(value) ||
    Array.isArray(value) ||
    value.type !== 'game.diagnostic' ||
    value.source !== 'electron-game-overlay-runtime' ||
    Object.keys(value).some((key) => !RUNTIME_DIAGNOSTIC_PACKET_KEYS.has(key))
  ) {
    return null;
  }

  return parseOverlayDiagnostic({
    ...value,
    pid: authoritativePid,
  });
}

export function normalizeOverlayDiagnosticErrorCode(
  value: unknown,
): string | number | undefined {
  if (typeof value === 'string' && SAFE_ERROR_CODES.has(value)) {
    return value;
  }
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= -0x80000000 &&
    value <= 0xffffffff
  ) {
    return value;
  }
  return undefined;
}

function parseDiagnosticCode(value: unknown): OverlayDiagnosticCode | null {
  return typeof value === 'string' &&
    Object.hasOwn(DIAGNOSTIC_DEFINITIONS, value)
    ? (value as OverlayDiagnosticCode)
    : null;
}

function parseDiagnosticPid(
  value: unknown,
  requirement: DiagnosticDefinition['pid'],
): number | undefined | null {
  if (value === undefined) {
    return requirement === 'required' ? null : undefined;
  }
  if (
    requirement === 'forbidden' ||
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > 0xffffffff
  ) {
    return null;
  }
  return value as number;
}

function parseDiagnosticContext(
  value: unknown,
  kind: DiagnosticDefinition['context'],
): Readonly<Record<string, OverlayDiagnosticContextValue>> | undefined | null {
  if (value === undefined) {
    return kind === 'port' ||
      kind === 'auth-scope' ||
      kind === 'packet-rejection'
      ? null
      : undefined;
  }

  const context = parseContextRecord(value);
  if (!context) {
    return null;
  }

  if (kind === 'none') {
    return Object.keys(context).length === 0 ? undefined : null;
  }
  if (kind === 'port') {
    if (
      !hasOnlyContextKeys(context, ['port']) ||
      !Number.isInteger(context.port) ||
      (context.port as number) <= 0 ||
      (context.port as number) > 0xffff
    ) {
      return null;
    }
    return Object.freeze({ port: context.port as number });
  }
  if (kind === 'error-code' || kind === 'ego-error-code') {
    if (!hasOnlyContextKeys(context, ['errorCode'])) {
      return null;
    }
    if (context.errorCode === undefined) {
      return kind === 'ego-error-code' ? null : undefined;
    }
    if (
      kind === 'ego-error-code' &&
      !EGO_ERROR_CODES.has(context.errorCode as number)
    ) {
      return null;
    }
    const errorCode = normalizeOverlayDiagnosticErrorCode(context.errorCode);
    return errorCode === undefined ? null : Object.freeze({ errorCode });
  }
  if (kind === 'auth-scope') {
    if (
      !hasOnlyContextKeys(context, ['scope']) ||
      (context.scope !== 'global' && context.scope !== 'targeted')
    ) {
      return null;
    }
    return Object.freeze({ scope: context.scope });
  }
  if (!hasOnlyContextKeys(context, ['reason', 'eventType'])) {
    return null;
  }

  const reason = context.reason;
  if (
    typeof reason !== 'string' ||
    !Object.hasOwn(PACKET_REJECTION_EVENT_BY_REASON, reason)
  ) {
    return null;
  }
  const expectedEvent =
    PACKET_REJECTION_EVENT_BY_REASON[reason as OverlayPacketRejectionReason];
  if (context.eventType !== expectedEvent) {
    return null;
  }
  return Object.freeze({
    reason,
    ...(expectedEvent === undefined ? {} : { eventType: expectedEvent }),
  });
}

function parseContextRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }
  return Object.keys(value).length <= MAX_DIAGNOSTIC_CONTEXT_ENTRIES
    ? value
    : null;
}

function hasOnlyContextKeys(
  context: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(context).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
