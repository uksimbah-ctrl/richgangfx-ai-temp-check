import type { EngineId } from "./engines.ts";

export type BulkTrade = {
  id: string;
  market: string;
  engine: EngineId;
  contract: string;
  barrier: string;
  duration: number;
  stake: number;
  payout: number | null;
  profit: number | null;
  probability: number;
  openedAt: number;
  closedAt: number | null;
  contractId: string | null;
  proposalId: string | null;
  status: "pending" | "open" | "won" | "lost" | "rejected";
  note: string;
};

export type Calibration = {
  bucket: string;
  predicted: number;
  actual: number | null;
  trades: number;
  note: string;
};

/** Groups settled trades by the probability that was used. Fewer than 30 trades is not a learned edge. */
export function calibrate(rows: BulkTrade[]): Calibration[] {
  const buckets = [0.5, 0.6, 0.7, 0.8, 0.9];
  return buckets.map((floor, index) => {
    const ceiling = buckets[index + 1] ?? 1.01;
    const settled = rows.filter(
      (row) =>
        (row.status === "won" || row.status === "lost") &&
        row.probability >= floor &&
        row.probability < ceiling,
    );
    const wins = settled.filter((row) => row.status === "won").length;
    const enough = settled.length >= 30;
    return {
      bucket: `${Math.round(floor * 100)}–${Math.round((ceiling > 1 ? 1 : ceiling) * 100)}%`,
      predicted: (floor + Math.min(ceiling, 1)) / 2,
      actual: settled.length ? wins / settled.length : null,
      trades: settled.length,
      note: enough ? "Enough settled trades to compare. This is still not a promise of future profit." : "Not validated. Fewer than 30 settled trades in this bucket.",
    };
  });
}

export function summarize(rows: BulkTrade[]): {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  net: number;
  exposure: number;
  drawdown: number;
} {
  const settled = rows.filter((row) => row.status === "won" || row.status === "lost");
  const wins = settled.filter((row) => row.status === "won").length;
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const row of [...settled].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))) {
    equity += row.profit ?? 0;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  const open = rows.filter((row) => row.status === "open" || row.status === "pending");
  return {
    trades: settled.length,
    wins,
    losses: settled.length - wins,
    winRate: settled.length ? wins / settled.length : null,
    net: settled.reduce((sum, row) => sum + (row.profit ?? 0), 0),
    exposure: open.reduce((sum, row) => sum + row.stake, 0),
    drawdown,
  };
}

/** Scores the last fifth of the digit series. Historical Deriv payouts are not in this test. */
export function approximateBacktest(hits: number, trials: number): { rate: number | null; note: string } {
  if (trials < 20) return { rate: null, note: "Not enough held-out ticks. No backtest rate was invented." };
  return {
    rate: hits / trials,
    note: "Approximation only. Historical Deriv payouts were not available, so this is a digit hit rate, not a profit backtest.",
  };
}

export function readSettlement(contract: {
  is_sold?: number | boolean | string;
  status?: string;
  profit?: number | string;
  payout?: number | string;
  sell_price?: number | string;
  buy_price?: number | string;
}): { sold: boolean; profit: number | null; payout: number | null } {
  const sold =
    contract.is_sold === 1 ||
    contract.is_sold === true ||
    contract.is_sold === "1" ||
    contract.status === "sold" ||
    contract.status === "won" ||
    contract.status === "lost";
  let profit = finite(contract.profit);
  if (profit == null && sold) profit = spread(contract.sell_price, contract.buy_price);
  return { sold, profit, payout: finite(contract.payout) };
}

export function profitFromPrices(sell: number | string | undefined, buy: number | string | undefined): number | null {
  return spread(sell, buy);
}

function finite(value: number | string | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function spread(sell: number | string | undefined, buy: number | string | undefined): number | null {
  const sold = finite(sell);
  const paid = finite(buy);
  if (sold == null || paid == null) return null;
  return Math.round((sold - paid) * 100) / 100;
}
