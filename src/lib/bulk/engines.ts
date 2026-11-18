import { runDigitEngine } from "../engine/digit-engines.ts";
import { lastDigit } from "../engine/math.ts";

export const ENGINE_IDS = ["over", "under", "matches", "differs", "even", "odd"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const ENGINE_CONTRACT: Record<EngineId, string> = {
  over: "DIGITOVER",
  under: "DIGITUNDER",
  matches: "DIGITMATCH",
  differs: "DIGITDIFF",
  even: "DIGITEVEN",
  odd: "DIGITODD",
};

export const ENGINE_LABEL: Record<EngineId, string> = {
  over: "Over",
  under: "Under",
  matches: "Matches",
  differs: "Differs",
  even: "Even",
  odd: "Odd",
};

export type Candidate = {
  engine: EngineId;
  contract: string;
  barrier: string;
  estimated: number;
  lo: number;
  hi: number;
  fair: number | null;
  sample: number;
  nEff: number;
  qualified: boolean;
  reason: string;
  streakNote: string;
};

const BARRIERS: Record<EngineId, string[]> = {
  over: ["0", "1", "2", "3", "4", "5", "6", "7", "8"],
  under: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
  matches: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  differs: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  even: [""],
  odd: [""],
};

/** Streak follow and fade stay hypotheses. They never qualify a trade by themselves. */
export function streakHypothesis(digits: number[]): string {
  if (digits.length < 3) return "Streak follow and fade need more digits. They are not used to qualify a trade.";
  const last = digits[digits.length - 1] ?? 0;
  let run = 1;
  for (let i = digits.length - 2; i >= 0; i -= 1) {
    if (digits[i] !== last) break;
    run += 1;
  }
  return `Digit ${last} has repeated ${run} time${run === 1 ? "" : "s"}. Follow and fade are hypotheses only. Neither one qualifies this trade.`;
}

export function digitsOf(quotes: number[], pip: number): number[] {
  return quotes.map((quote) => lastDigit(quote, pip)).filter((digit) => digit >= 0 && digit <= 9);
}

/**
 * One engine, one market. The best barrier is the qualified lower bound that clears its own baseline by the most.
 * A barrier that does not clear is not substituted.
 */
export function scanEngine(engine: EngineId, quotes: number[], pip: number, minSample: number): Candidate | null {
  const digits = digitsOf(quotes, pip);
  const note = streakHypothesis(digits);
  let best: Candidate | null = null;
  for (const barrier of BARRIERS[engine]) {
    const report = runDigitEngine({
      contract: ENGINE_CONTRACT[engine],
      quotes,
      pip,
      barrier,
      minSample,
      minConfidence: 0.5,
      strategy: ENGINE_LABEL[engine],
      lookback: 40,
      minEffective: 40,
      z: 1.96,
      persist: true,
      stake: null,
      payout: null,
    });
    const clears = report.fair != null && report.lo > report.fair && report.status === "yes";
    const row: Candidate = {
      engine,
      contract: ENGINE_CONTRACT[engine],
      barrier,
      estimated: report.estimated,
      lo: report.lo,
      hi: report.hi,
      fair: report.fair,
      sample: report.sample,
      nEff: report.nEff,
      qualified: clears,
      reason: clears ? report.reason : `${report.reason} Not qualified for bulk execution.`,
      streakNote: note,
    };
    if (!best) best = row;
    else if (row.qualified && !best.qualified) best = row;
    else if (row.qualified === best.qualified && row.lo - (row.fair ?? 0) > best.lo - (best.fair ?? 0)) best = row;
  }
  return best;
}

export function scanMarket(quotes: number[], pip: number, enabled: EngineId[], minSample: number): Candidate[] {
  return enabled
    .map((engine) => scanEngine(engine, quotes, pip, minSample))
    .filter((row): row is Candidate => row != null);
}
