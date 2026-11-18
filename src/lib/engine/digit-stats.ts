import { lastDigit } from "./math.ts";
import { runDigitEngine } from "./digit-engines.ts";

/** Wilson score interval. This is a range for the sample, not a future win rate. */
export function wilsonInterval(hits: number, n: number, z = 1.64): { p: number; lo: number; hi: number } {
  if (!(n > 0) || !Number.isFinite(hits) || !Number.isFinite(z)) return { p: 0, lo: 0, hi: 1 };
  const p = Math.min(1, Math.max(0, hits / n));
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    p,
    lo: clamp01((center - margin) / den),
    hi: clamp01((center + margin) / den),
  };
}

/**
 * Consecutive ticks are not independent draws.
 * Bartlett adjustment through lag 5, using both positive and negative autocorrelation.
 * The adjusted count shrinks when dependence makes the mean less precise.
 * It is never raised above the raw count when negative autocorrelation would do that.
 * A one-sided run with no digit diversity counts as one effective observation.
 * If the contract indicator never changes but at least three last digits appear, the raw count is kept.
 * A zero-variance indicator has no correlation to estimate, and that count is not increased past the raw sample.
 * Overlapping blocks are not used. This does not remove all dependence.
 */
export const DEPENDENCE_LIMIT =
  "Dependence uses a Bartlett autocorrelation adjustment through lag 5. Positive correlation shrinks the effective sample. Negative correlation does not add observations, and the adjusted count never exceeds the raw count. Overlapping blocks are not counted as extra samples. A contract result that never changes is one observation unless the last digits themselves keep changing, in which case the raw count is kept and still not increased. This does not remove all dependence, and a shift in the distribution can still be misread as one series.";

const MAX_DEPENDENCE_LAG = 5;

export function effectiveSample(flags: boolean[], distinct = 0): { n: number; hits: number; nEff: number; rho: number } {
  const n = flags.length;
  const hits = flags.reduce((sum, flag) => sum + (flag ? 1 : 0), 0);
  if (n < 3) return { n, hits, nEff: Math.max(0, n), rho: 0 };
  const mean = hits / n;
  if (mean === 0 || mean === 1) {
    const moving = distinct >= 3;
    return { n, hits, nEff: moving ? n : 1, rho: moving ? 0 : 1 };
  }
  const rhos = autocorrelations(
    flags.map((flag) => (flag ? 1 : 0)),
    Math.min(MAX_DEPENDENCE_LAG, n - 2),
  );
  const rho = rhos[0] ?? 0;
  let inflation = 1;
  for (let lag = 1; lag <= rhos.length; lag += 1) {
    const value = rhos[lag - 1] ?? 0;
    inflation += 2 * (1 - lag / n) * value;
  }
  // A net negative factor would claim extra evidence. Cap it at the raw sample instead.
  const nEff = inflation <= 1 ? n : Math.min(n, Math.max(1, n / inflation));
  return { n, hits, nEff, rho };
}

function autocorrelations(values: number[], maxLag: number): number[] {
  const n = values.length;
  if (n < 3 || maxLag < 1) return [];
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  let den = 0;
  const centered = values.map((value) => {
    const delta = value - mean;
    den += delta * delta;
    return delta;
  });
  if (den === 0) return Array.from({ length: maxLag }, () => 1);
  const out: number[] = [];
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let num = 0;
    for (let index = lag; index < n; index += 1) num += centered[index] * centered[index - lag];
    out.push(Math.max(-0.99, Math.min(0.99, num / den)));
  }
  return out;
}

export function wilsonFromFlags(flags: boolean[], z = 1.64): { p: number; lo: number; hi: number; n: number; hits: number; nEff: number; rho: number } {
  const sample = effectiveSample(flags);
  const hitsEff = sample.n > 0 ? (sample.hits / sample.n) * sample.nEff : 0;
  const span = wilsonInterval(hitsEff, sample.nEff, z);
  return { ...span, n: sample.n, hits: sample.hits, nEff: sample.nEff, rho: sample.rho };
}

/** Extra clearance above the contract baseline when the user raises the score filter past 0.5. */
export function clearsBaseline(lo: number, fair: number, minConfidence: number): boolean {
  const extra = Number.isFinite(minConfidence) ? Math.max(0, minConfidence - 0.5) : 0;
  return lo > fair + extra * (1 - fair);
}

export function digitSettingsError(cfg: { minSample: number; lookback: number; minConfidence: number }): string | null {
  if (!Number.isFinite(cfg.minSample) || cfg.minSample < 20 || cfg.minSample > 5000) return "Minimum sample must be between 20 and 5000 ticks.";
  if (!Number.isFinite(cfg.lookback) || cfg.lookback < 1 || cfg.lookback > 200) return "Lookback is not a valid setting, so this strategy will not trade.";
  if (!Number.isFinite(cfg.minConfidence) || cfg.minConfidence < 0 || cfg.minConfidence > 1) return "Confidence threshold must be between 0 and 1.";
  return null;
}

export function requiredEpisodes(minSample: number): number {
  if (!Number.isFinite(minSample)) return 20;
  return Math.max(20, Math.min(40, Math.round(minSample / 4)));
}

/** One outcome per maximal run. Overlapping windows inside the same run are not extra samples. */
export function parityEpisodes(bits: number[], minStreak: number): { follow: number; fade: number; cases: number; continued: boolean[] } {
  const continued: boolean[] = [];
  const need = Math.max(2, Math.min(12, Math.round(minStreak) || 2));
  let i = 0;
  while (i < bits.length) {
    let j = i + 1;
    while (j < bits.length && bits[j] === bits[i]) j += 1;
    const run = j - i;
    if (run >= need) {
      const decision = i + need;
      if (decision < bits.length) continued.push(bits[decision] === bits[i]);
    }
    i = j;
  }
  const follow = continued.reduce((sum, flag) => sum + (flag ? 1 : 0), 0);
  return { follow, fade: continued.length - follow, cases: continued.length, continued };
}

export function currentParityStreak(bits: number[]): { side: 0 | 1; length: number } {
  if (bits.length === 0) return { side: 0, length: 0 };
  const side = (bits[bits.length - 1] === 0 ? 0 : 1) as 0 | 1;
  let length = 0;
  for (let i = bits.length - 1; i >= 0; i--) {
    if ((bits[i] === 0 ? 0 : 1) !== side) break;
    length += 1;
  }
  return { side, length };
}

export type DigitFrequencies = {
  digits: number[];
  counts: number[];
  sample: number;
  even: number;
  odd: number;
  last: number | null;
  streakSide: "Even" | "Odd" | "None";
  streak: number;
};

export function digitFrequencies(quotes: number[], pip: number): DigitFrequencies {
  const digits = quotes.map((quote) => lastDigit(quote, pip)).filter((digit) => digit >= 0 && digit <= 9);
  const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const digit of digits) counts[digit] += 1;
  const even = digits.reduce((sum, digit) => sum + (digit % 2 === 0 ? 1 : 0), 0);
  const bits = digits.map((digit) => digit % 2);
  const streak = currentParityStreak(bits);
  return {
    digits,
    counts,
    sample: digits.length,
    even,
    odd: digits.length - even,
    last: digits.length ? digits[digits.length - 1] : null,
    streakSide: digits.length === 0 ? "None" : streak.side === 0 ? "Even" : "Odd",
    streak: streak.length,
  };
}

export type ContractStudy = {
  contract: string;
  prediction: string;
  fair: number | null;
  hits: number;
  sample: number;
  nEff: number;
  p: number;
  observed: number;
  lo: number;
  hi: number;
  breakEven: number | null;
  expectedReturn: number | null;
  qualified: boolean;
  status: "yes" | "no" | "wait";
  reason: string;
};

export function studyContract(args: {
  contract: string;
  quotes: number[];
  pip: number;
  barrier: string;
  minSample: number;
  minConfidence: number;
  strategy: string;
  /** Recent window and non-overlapping digit windows. Not a second independent signal. */
  lookback?: number;
  minEffective?: number;
  z?: number;
  persist?: boolean;
  stake?: number | null;
  payout?: number | null;
}): ContractStudy {
  const freq = digitFrequencies(args.quotes, args.pip);
  const blank = (status: "yes" | "no" | "wait", reason: string, fair: number | null = null): ContractStudy => ({
    contract: args.contract,
    prediction: predictionLabel(args.contract, args.barrier),
    fair,
    hits: 0,
    sample: freq.sample,
    nEff: 0,
    p: 0,
    observed: 0,
    lo: 0,
    hi: 1,
    breakEven: null,
    expectedReturn: null,
    qualified: false,
    status,
    reason,
  });
  if (!Number.isFinite(args.minSample) || args.minSample < 20) {
    return blank("wait", "Minimum sample is not a valid setting, so this strategy waits.");
  }
  if (freq.sample < args.minSample) {
    return blank("wait", `WAIT. Need ${Math.round(args.minSample)} ticks. Have ${freq.sample}. No probability was invented.`);
  }
  const report = runDigitEngine(args);
  return {
    contract: report.contract,
    prediction: report.prediction,
    fair: report.fair,
    hits: report.hits,
    sample: report.sample,
    nEff: report.nEff,
    p: report.estimated,
    observed: report.observed,
    lo: report.lo,
    hi: report.hi,
    breakEven: report.breakEven,
    expectedReturn: report.expectedReturn,
    qualified: report.qualified,
    status: report.status,
    reason: report.reason,
  };
}

export function predictionLabel(contract: string, barrier: string): string {
  if (contract === "DIGITEVEN") return "Predicted Even";
  if (contract === "DIGITODD") return "Predicted Odd";
  if (contract === "DIGITOVER") return `Predicted over ${barrier || "?"}`;
  if (contract === "DIGITUNDER") return `Predicted under ${barrier || "?"}`;
  if (contract === "DIGITMATCH") return `Predicted match ${barrier || "?"}`;
  if (contract === "DIGITDIFF") return `Predicted differ ${barrier || "?"}`;
  return contract;
}

export function pct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
