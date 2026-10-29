/** @internal Authoritative OS evidence from one retained process handle. */
export type OverlayBrokerProcessIdentity = Readonly<{
  pid: number;
  executablePath: string;
  creationTime100ns?: string;
}>;

/** @internal Accept exact positive uint64 FILETIME strings without normalization. */
export function isValidProcessCreationTime100ns(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}
