export function parseVersion(
  value: unknown,
): { core: string[]; prerelease: string[] } | undefined {
  if (typeof value !== 'string' || value.length > 128) return;
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) return;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith('0')))
    return;
  return { core: match.slice(1, 4), prerelease };
}

/** Compares already validated semantic versions by precedence. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)!;
  const right = parseVersion(b)!;
  for (let index = 0; index < 3; index++) {
    const x = BigInt(left.core[index]);
    const y = BigInt(right.core[index]);
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length)
    return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const x = left.prerelease[index];
    const y = right.prerelease[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^[0-9]+$/.test(x);
    const yn = /^[0-9]+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
