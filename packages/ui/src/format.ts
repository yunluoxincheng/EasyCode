/** token 数 → 徽标文本：1000000 → 1M，200000 → 200K，512 → 512（向下取整避免夸大） */
export function fmtCtx(n: number | undefined | null): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) {
    const m = Math.floor(n / 100_000) / 10;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
