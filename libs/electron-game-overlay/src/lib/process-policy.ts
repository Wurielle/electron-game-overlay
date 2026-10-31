import { isValidProcessCreationTime100ns } from './overlay-process-identity.js';
import { win32 } from 'node:path';

/**
 * Native process-image policy. Patterns use full Windows paths, / separators,
 * ASCII-insensitive literals, * and ? within one component, and ** as a whole
 * component. Deny always wins. Braces, classes, extglobs and negation are rejected.
 */
export type OverlayProcessPolicy = Readonly<{
  allow: readonly string[];
  deny?: readonly string[];
}>;

/** Validates and freezes the exact serializable policy used before native mutation. */
export function createOverlayProcessPolicy(
  policy: OverlayProcessPolicy,
): OverlayProcessPolicy {
  if (
    !policy ||
    !Array.isArray(policy.allow) ||
    !Array.isArray(policy.deny ?? [])
  )
    throw new TypeError('Process policy needs allow and optional deny arrays');
  const normalize = (value: unknown): string => {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 4096 ||
      /[\u0000-\u001f\u007f\[\]{}]/.test(value)
    )
      throw new TypeError('Unsupported process policy pattern');
    if (
      /[?*+@!]\(/.test(value) ||
      Buffer.from(value, 'utf8').toString('utf8') !== value
    )
      throw new TypeError('Unsupported process policy pattern');
    const pattern = value
      .replace(/\\/g, '/')
      .replace(/[A-Z]/g, (c) => c.toLowerCase());
    const components = pattern.split('/');
    if (
      !(
        pattern.startsWith('**/') ||
        /^[a-z]:\//.test(pattern) ||
        pattern.startsWith('//')
      ) ||
      components.length > 128 ||
      components.some(
        (c) => c === '.' || c === '..' || (c.includes('**') && c !== '**'),
      )
    )
      throw new TypeError(
        'Policy patterns require a full path or **/ prefix and whole-component **',
      );
    return pattern;
  };
  const allow = [...new Set(policy.allow.map(normalize))].sort();
  const deny = [...new Set((policy.deny ?? []).map(normalize))].sort();
  if (allow.length === 0 || allow.length + deny.length > 256)
    throw new RangeError('Process policy requires 1..256 patterns');
  if (
    Buffer.byteLength(
      [
        'EGO_PROCESS_POLICY_V1',
        ...allow.map((p) => 'A\t' + p),
        ...deny.map((p) => 'D\t' + p),
        '',
      ].join('\n'),
    ) > 65536
  )
    throw new RangeError('Process policy exceeds 64 KiB');
  return Object.freeze({
    allow: Object.freeze(allow),
    deny: Object.freeze(deny),
  });
}

/** Evaluates the same bounded policy grammar used by the native injector. */
export function overlayProcessPolicyAllows(
  policy: OverlayProcessPolicy,
  executablePath: string,
): boolean {
  policy = createOverlayProcessPolicy(policy);
  if (
    !win32.isAbsolute(executablePath) ||
    Buffer.from(executablePath, 'utf8').toString('utf8') !== executablePath
  )
    return false;
  const path = executablePath
    .replace(/\\/g, '/')
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .split('/');
  if (path.length > 512) return false;
  const matches = (pattern: string) => {
    const parts = pattern.split('/'),
      memo = new Map<string, boolean>();
    const visit = (i: number, j: number): boolean => {
      const k = i + ':' + j,
        old = memo.get(k);
      if (old !== undefined) return old;
      let result: boolean;
      if (i === parts.length) result = j === path.length;
      else if (parts[i] === '**')
        result = visit(i + 1, j) || (j < path.length && visit(i, j + 1));
      else
        result =
          j < path.length &&
          componentMatches(parts[i], path[j]) &&
          visit(i + 1, j + 1);
      memo.set(k, result);
      return result;
    };
    return visit(0, 0);
  };
  return !policy.deny?.some(matches) && policy.allow.some(matches);
}

/** @internal Exact UTF-8 document for a private owned run; never an executable. */
export function serializeOverlayProcessPolicy(
  policy: OverlayProcessPolicy,
  resume?: Readonly<{
    creationCutoff100ns?: string;
    excludedInstances?: readonly Readonly<{
      pid: number;
      creationTime100ns: string;
    }>[];
  }>,
): string {
  const p = createOverlayProcessPolicy(policy);
  if (
    resume?.creationCutoff100ns !== undefined &&
    !isValidProcessCreationTime100ns(resume.creationCutoff100ns)
  )
    throw new TypeError('Invalid original policy creation cutoff');
  const instances = resume?.excludedInstances ?? [];
  if (
    instances.length > 4096 ||
    new Set(instances.map((i) => i.pid)).size !== instances.length ||
    instances.some(
      (i) =>
        !Number.isInteger(i.pid) ||
        i.pid <= 0 ||
        i.pid > 0xffffffff ||
        !isValidProcessCreationTime100ns(i.creationTime100ns),
    )
  )
    throw new TypeError('Invalid excluded process incarnation');
  const document = [
    'EGO_PROCESS_POLICY_V1',
    ...(resume?.creationCutoff100ns
      ? ['B\t' + resume.creationCutoff100ns]
      : []),
    ...instances.map((i) => 'X\t' + i.pid + '\t' + i.creationTime100ns),
    ...p.allow.map((v) => 'A\t' + v),
    ...(p.deny ?? []).map((v) => 'D\t' + v),
    '',
  ].join('\n');
  if (Buffer.byteLength(document) > 262144)
    throw new RangeError('Process policy control document exceeds 256 KiB');
  return document;
}
function componentMatches(pattern: string, value: string): boolean {
  let i = 0,
    j = 0,
    star = -1,
    retry = 0;
  while (j < value.length) {
    if (i < pattern.length && (pattern[i] === '?' || pattern[i] === value[j])) {
      i++;
      j++;
    } else if (pattern[i] === '*') {
      star = i++;
      retry = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++retry;
    } else return false;
  }
  while (pattern[i] === '*') i++;
  return i === pattern.length;
}
