import type {
  OverlayInputCapability,
  OverlayInputCapabilitySupport,
  OverlayTargetInputCapabilities,
} from './types.js';

const capabilityNames = ['copied-wm-input', 'copied-raw-input-buffer'] as const;
const supports = new Set<OverlayInputCapabilitySupport>(['supported', 'unsupported', 'unknown']);

/** @internal Snapshot caller requirements before any transport work starts. */
export function normalizeRequiredInputCapabilities(value: unknown): readonly OverlayInputCapability[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some(capability => !capabilityNames.includes(capability))) {
    throw new TypeError('requiredInputCapabilities must contain only copied-wm-input or copied-raw-input-buffer');
  }
  return Object.freeze([...new Set(value as OverlayInputCapability[])]);
}

/** @internal Optional capability metadata never changes the frozen v1 handshake. */
export function parseTransportCapabilities(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 64 || value.some(token =>
    typeof token !== 'string' || token.length === 0 || token.length > 128 || token.includes('\0'))) {
    return undefined;
  }
  return Object.freeze([...new Set(value as string[])]);
}

/** @internal Absence of the optional baseline cannot establish non-support. */
export function inputCapabilitiesFromTokens(tokens?: readonly string[]): OverlayTargetInputCapabilities {
  const baseline = tokens?.includes('input-capabilities-v1') === true;
  const support = (token: string): OverlayInputCapabilitySupport =>
    !baseline ? 'unknown' : tokens!.includes(token) ? 'supported' : 'unsupported';
  return Object.freeze({
    copiedWmInput: support('copied-wm-input-v1'),
    copiedRawInputBuffer: support('copied-raw-input-buffer-v1'),
  });
}

/** @internal Validates snapshots crossing the native/session boundary. */
export function parseInputCapabilities(value: unknown): OverlayTargetInputCapabilities | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 ||
      !supports.has(record.copiedWmInput as OverlayInputCapabilitySupport) ||
      !supports.has(record.copiedRawInputBuffer as OverlayInputCapabilitySupport)) return null;
  return Object.freeze({
    copiedWmInput: record.copiedWmInput as OverlayInputCapabilitySupport,
    copiedRawInputBuffer: record.copiedRawInputBuffer as OverlayInputCapabilitySupport,
  });
}

/** @internal */
export function inputCapabilitySupport(
  capabilities: OverlayTargetInputCapabilities,
  capability: OverlayInputCapability,
): OverlayInputCapabilitySupport {
  return capability === 'copied-wm-input' ? capabilities.copiedWmInput : capabilities.copiedRawInputBuffer;
}
