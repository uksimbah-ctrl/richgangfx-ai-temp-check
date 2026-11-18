export type TickPoint = { q: number; t: number };

/**
 * Older Deriv history plus ticks already received.
 * A live tick with the same epoch replaces the historical copy. The result never grows past `limit`.
 */
export function mergeTickHistory(live: TickPoint[], prices: number[], times: number[], limit = 1500): TickPoint[] {
  const byTime = new Map<number, TickPoint>();
  const count = Math.min(prices.length, times.length);
  for (let i = 0; i < count; i++) {
    const q = prices[i];
    const t = times[i];
    if (q == null || t == null || !Number.isFinite(q) || !Number.isFinite(t)) continue;
    byTime.set(t, { q, t });
  }
  for (const point of live) {
    if (!Number.isFinite(point.q) || !Number.isFinite(point.t)) continue;
    byTime.set(point.t, point);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-limit);
}
