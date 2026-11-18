import type { Candidate } from "./engines.ts";

/** EV = P(win) × net profit − P(loss) × stake. Net profit is payout minus stake, not the full payout. */
export function payoutEv(probability: number, payout: number, stake: number): number | null {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  if (!(payout > 0) || !(stake > 0)) return null;
  const net = payout - stake;
  return probability * net - (1 - probability) * stake;
}

export type QualifyInput = {
  candidate: Candidate;
  payout: number | null;
  stake: number;
  minEv: number;
  minPayoutMultiple: number;
  maxAgeMs: number;
  quotedAt: number;
  now: number;
};

export function qualifyOpportunity(input: QualifyInput): { ok: boolean; ev: number | null; reason: string } {
  const { candidate } = input;
  if (!candidate.qualified) return { ok: false, ev: null, reason: "The lower bound does not clear the baseline." };
  if (input.now - input.quotedAt > input.maxAgeMs) return { ok: false, ev: null, reason: "The proposal is stale. A new quote is required." };
  if (input.payout == null || !(input.payout > 0)) return { ok: false, ev: null, reason: "No live payout was returned." };
  if (!(input.stake > 0)) return { ok: false, ev: null, reason: "Stake is not set." };
  if (input.payout / input.stake < input.minPayoutMultiple) {
    return { ok: false, ev: null, reason: "Payout is under the minimum multiple." };
  }
  const ev = payoutEv(candidate.estimated, input.payout, input.stake);
  if (ev == null) return { ok: false, ev: null, reason: "Expected value could not be calculated." };
  if (ev > input.minEv) return { ok: true, ev, reason: "Qualified on the live payout. This is not a guaranteed win." };
  const breakEven = input.stake / input.payout;
  const houseGap = breakEven - candidate.estimated;
  if (candidate.qualified && houseGap <= 0.04) {
    return { ok: true, ev, reason: "The quote is a little under the estimate. The lower bound still cleared the baseline." };
  }
  return { ok: false, ev, reason: "The quote pays less than this signal is worth." };
}

export function rankByEv<T extends { ev: number | null; qualified: boolean }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    return (b.ev ?? -Infinity) - (a.ev ?? -Infinity);
  });
}
