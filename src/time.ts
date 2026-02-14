export function nanoToMilli(nano: string): number {
  return Number(BigInt(nano) / 1_000_000n);
}
