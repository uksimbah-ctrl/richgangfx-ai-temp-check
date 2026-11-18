import type { BulkTrade } from "./learn.ts";

export function duplicateKey(market: string, contract: string, barrier: string): string {
  return `${market}:${contract}:${barrier}`;
}

export function openLike(trades: BulkTrade[], market: string, contract: string, barrier: string): boolean {
  const key = duplicateKey(market, contract, barrier);
  return trades.some((row) => (row.status === "open" || row.status === "pending") && duplicateKey(row.market, row.contract, row.barrier) === key);
}
