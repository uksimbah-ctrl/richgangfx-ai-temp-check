import { CONTRACT_BY_TYPE, FAMILY_LABEL, type Family } from "./catalog.ts";
import { NO_VERIFIED_EDGE, NO_VERIFIED_OOS } from "./digit-engines.ts";
import { adx, atr, barsFromTicks, bollinger, emaLast, macdHist, rsi } from "./indicators.ts";
import { digitCounts, digitChiSquare, digitWins, expectedValue, fairDigit, impliedProbability, lastDigit, sampleStd, tickDeltas } from "./math.ts";
import {
  clearsBaseline,
  currentParityStreak,
  digitFrequencies,
  digitSettingsError,
  parityEpisodes,
  pct,
  requiredEpisodes,
  studyContract,
  wilsonInterval,
} from "./digit-stats.ts";

export const MODULE_IDS = [
  "pullback",
  "breakout",
  "reversion",
  "expansion",
  "momentum",
  "regime",
  "statistical",
  "selectedDigit",
  "rolling",
  "barrierProb",
  "parity",
  "walkForward",
  "streakFade",
  "streakFollow",
  "ensemble",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];
export type ModuleStatus = "active" | "observation" | "testing";
export type ModuleBias = "up" | "down" | "flat" | "none";

export type ModuleConfig = {
  id: ModuleId;
  enabled: boolean;
  status: ModuleStatus;
  observeReason: string | null;
  participate: boolean;
  /** Setup strength from 0 to 1. This is not a probability of winning. */
  minConfidence: number;
  minSample: number;
  lookback: number;
  emaFast: number;
  emaSlow: number;
  maxLoss: number;
  version: number;
};

export type ModuleReading = {
  id: ModuleId;
  name: string;
  bias: ModuleBias;
  confidence: number;
  sample: number;
  reason: string;
  conditions: string;
};

export const MODULE_NAMES: Record<ModuleId, string> = {
  pullback: "Trend Pullback",
  breakout: "Breakout and Retest",
  reversion: "Mean Reversion",
  expansion: "Volatility Expansion",
  momentum: "Momentum Confirmation",
  regime: "Market Regime",
  statistical: "Statistical Probability",
  selectedDigit: "Selected Digit Analysis",
  rolling: "Rolling Distribution Analysis",
  barrierProb: "Barrier Probability Analysis",
  parity: "Parity Probability Analysis",
  walkForward: "Walk-Forward Validated Strategy",
  streakFade: "Even/Odd Streak Fade",
  streakFollow: "Even/Odd Streak Follow",
  ensemble: "Multi-Strategy Advisory",
};

export const STRATEGY_GROUPS: Array<{ title: string; role: string; ids: ModuleId[] }> = [
  {
    title: "Directional strategies",
    role: "Each one can open a trade on its own when its rule qualifies.",
    ids: ["pullback", "breakout", "reversion", "expansion", "momentum"],
  },
  {
    title: "Digit strategies",
    role: "Each engine scores only the contracts it understands. A long streak is not a signal, and correlated digit checks are not separate confirmation.",
    ids: ["statistical", "selectedDigit", "rolling", "barrierProb", "parity", "walkForward"],
  },
  {
    title: "Retired digit rules",
    role: "Streak fade and follow stay listed so older notes still resolve. They cannot open a trade. A long run does not mean the next digit flips or continues.",
    ids: ["streakFade", "streakFollow"],
  },
  {
    title: "Market analysis",
    role: "Market Regime describes the market. The advisory ensemble cannot force or veto a valid signal.",
    ids: ["regime", "ensemble"],
  },
];

const NAMES = MODULE_NAMES;

const FAMILIES: Record<ModuleId, Family[]> = {
  pullback: ["directional", "barrier", "asian", "reset", "vanilla"],
  breakout: ["directional", "barrier", "asian", "reset"],
  reversion: ["directional", "barrier", "range"],
  expansion: ["touch", "turbo", "multiplier"],
  momentum: ["directional", "barrier", "asian", "reset", "multiplier"],
  regime: ["directional", "barrier", "range", "touch", "asian", "reset", "turbo"],
  statistical: ["digit"],
  selectedDigit: ["digit"],
  rolling: ["digit"],
  barrierProb: ["digit"],
  parity: ["digit"],
  walkForward: ["digit"],
  streakFade: ["digit"],
  streakFollow: ["digit"],
  ensemble: ["digit", "directional", "barrier", "touch", "range", "asian", "reset", "turbo", "multiplier", "vanilla"],
};

export function defaultModule(id: ModuleId): ModuleConfig {
  return {
    id,
    enabled: false,
    status: "active",
    observeReason: null,
    participate: id !== "ensemble",
    minConfidence: 0.5,
    minSample: isProbEngine(id) || id === "streakFade" || id === "streakFollow" ? 80 : 40,
    lookback: id === "streakFade" || id === "streakFollow" ? 3 : isProbEngine(id) ? 40 : 30,
    emaFast: 9,
    emaSlow: 21,
    maxLoss: 20,
    version: 1,
  };
}

export function defaultModules(): Record<ModuleId, ModuleConfig> {
  const book = {} as Record<ModuleId, ModuleConfig>;
  for (const id of MODULE_IDS) book[id] = defaultModule(id);
  return book;
}

export function readModule(id: ModuleId, quotes: number[], cfg: ModuleConfig, pip = 2): ModuleReading {
  const base = {
    id,
    name: NAMES[id],
    sample: quotes.length,
    confidence: 0,
    bias: "none" as ModuleBias,
    conditions: "",
  };
  if (quotes.length < cfg.minSample) {
    return { ...base, reason: `Need ${cfg.minSample} ticks. Have ${quotes.length}.`, conditions: "Sample too small." };
  }
  if (id === "pullback") return pullback(quotes, cfg, base);
  if (id === "breakout") return breakout(quotes, cfg, base);
  if (id === "reversion") return reversion(quotes, base);
  if (id === "expansion") return expansion(quotes, base);
  if (id === "momentum") return momentum(quotes, cfg, base);
  if (id === "regime") return regime(quotes, cfg, base);
  if (id === "statistical") return statistical(quotes, cfg, pip, base);
  if (isProbEngine(id)) return statistical(quotes, cfg, pip, base);
  if (id === "streakFade") return streakSide("fade", quotes, cfg, pip, base);
  if (id === "streakFollow") return streakSide("follow", quotes, cfg, pip, base);
  return { ...base, bias: "flat", reason: "Ensemble compares the other modules. It does not make its own market call.", conditions: "Confirmation rule." };
}

export function moduleGate(
  family: Family,
  contractType: string,
  quotes: number[],
  configs: Record<string, ModuleConfig> | undefined,
  pip = 2,
): { block: string | null; readings: ModuleReading[]; agreed: string[] } {
  const decision = approvedEntry(family, contractType, quotes, configs, pip);
  return { block: decision.ok ? null : decision.reason, readings: decision.readings, agreed: decision.agreed };
}

const CORRELATED: Partial<Record<ModuleId, string>> = {
  pullback: "trend",
  momentum: "trend",
  breakout: "trend",
  statistical: "digit-frequency",
  selectedDigit: "digit-frequency",
  rolling: "digit-frequency",
  barrierProb: "digit-frequency",
  parity: "digit-frequency",
  walkForward: "digit-frequency",
  streakFade: "parity-streak",
  streakFollow: "parity-streak",
};

export type DigitGateOptions = {
  minEffective?: number;
  z?: number;
  /** False turns off the held-out clearance check. Omitted keeps it on. */
  persist?: boolean;
  stake?: number | null;
  payout?: number | null;
  minSample?: number;
  lookback?: number;
};

/** Modules that are allowed to open this contract. Ensemble and regime never count. */
export function activeEntryModules(
  family: Family,
  contractType: string,
  configs: Record<string, ModuleConfig> | undefined,
): ModuleId[] {
  if (!configs) return [];
  return MODULE_IDS.filter((id) => {
    if (id === "ensemble" || id === "regime") return false;
    const cfg = configs[id];
    return Boolean(cfg?.enabled && cfg.status === "active" && supportsContract(id, family, contractType));
  });
}

/** Only the whitelist may open a trade. Legacy contract rules are not an entry. */
export function approvedEntry(
  family: Family,
  contractType: string,
  quotes: number[],
  configs: Record<string, ModuleConfig> | undefined,
  pip = 2,
  barrier = "",
  options?: DigitGateOptions,
): { ok: boolean; reason: string; readings: ModuleReading[]; agreed: string[] } {
  if (!configs) return { ok: false, reason: "No approved strategy is loaded.", readings: [], agreed: [] };
  const enabled = activeEntryModules(family, contractType, configs);
  if (enabled.length === 0) {
    const selectedDigit = contractType === "DIGITMATCH" || contractType === "DIGITDIFF";
    return {
      ok: false,
      reason: selectedDigit
        ? "Matches and Differs use Statistical Probability or Selected Digit Analysis on the digit you picked. A streak does not trade this contract."
        : "No approved strategy is turned on for this contract.",
      readings: [],
      agreed: [],
    };
  }
  const readings: ModuleReading[] = [];
  const agreed: ModuleId[] = [];
  const notes: string[] = [];
  for (const id of enabled) {
    const cfg = configs[id];
    const verdict = judge(id, contractType, quotes, cfg, pip, barrier, options);
    readings.push(verdict.reading);
    if (verdict.fit === "yes") agreed.push(id);
    else notes.push(verdict.reading.reason);
  }
  if (agreed.length === 0) {
    return { ok: false, reason: notes[0] ?? "No approved strategy has evidence for this contract.", readings, agreed };
  }
  const names = agreed.map((id) => NAMES[id]).join(", ");
  let reason = `${names} support this contract. A score is not a win probability.`;
  if (notes.length > 0) reason += " Another strategy waiting or declining does not cancel this signal.";
  const ensemble = configs.ensemble;
  if (ensemble?.enabled && ensemble.status === "active") {
    const regimeCfg = configs.regime;
    if (regimeCfg?.enabled && regimeCfg.status === "active" && FAMILIES.regime.includes(family)) {
      const regimeRead = readModule("regime", quotes, regimeCfg, pip);
      readings.push(regimeRead);
      if (regimeRead.bias === "flat" && family !== "digit") {
        reason += " Ensemble note: the regime check sees a range. It does not block this signal.";
      }
    }
    const groups = new Set(agreed.map((id) => CORRELATED[id] ?? id));
    if (agreed.length >= 2 && groups.size < agreed.length) {
      reason += " Ensemble note: those checks are the same kind of evidence, so they are not separate confirmation.";
    } else {
      reason += " Ensemble note: this is a comparison, not an order to trade.";
    }
  }
  return { ok: true, reason, readings, agreed };
}

/** Entry strategies that can authorize this contract. Advisory and retired rules are left off. */
export function bestStrategies(contractType: string): ModuleId[] {
  const family = CONTRACT_BY_TYPE.get(contractType)?.family;
  if (!family) return [];
  return MODULE_IDS.filter((id) => id !== "ensemble" && id !== "regime" && supportsContract(id, family, contractType));
}

/** Turn on only the strategies for the selected contract. */
export function applyStrategyChoice(
  modules: Record<string, ModuleConfig>,
  contractType: string | null,
): Record<ModuleId, ModuleConfig> {
  const chosen = new Set(contractType ? bestStrategies(contractType) : []);
  const next = { ...modules } as Record<ModuleId, ModuleConfig>;
  for (const id of MODULE_IDS) {
    const row = next[id] ?? defaultModule(id);
    next[id] = { ...row, enabled: chosen.has(id) };
  }
  return next;
}

function supportsContract(id: ModuleId, family: Family, contractType: string): boolean {
  if (id === "streakFade" || id === "streakFollow") return false;
  if (id === "selectedDigit") return contractType === "DIGITMATCH" || contractType === "DIGITDIFF";
  if (id === "barrierProb") return contractType === "DIGITOVER" || contractType === "DIGITUNDER";
  if (id === "parity") return contractType === "DIGITEVEN" || contractType === "DIGITODD";
  if (id === "statistical" || id === "rolling" || id === "walkForward") return family === "digit";
  if (!FAMILIES[id].includes(family)) return false;
  return true;
}

function isProbEngine(id: ModuleId): boolean {
  return id === "statistical" || id === "selectedDigit" || id === "rolling" || id === "barrierProb" || id === "parity" || id === "walkForward";
}

/** Same rule the entry engine uses. Display only; it does not authorize a trade. */
export function moduleSupports(id: ModuleId, family: Family, contractType: string): boolean {
  return supportsContract(id, family, contractType);
}

export function moduleScope(id: ModuleId): string {
  if (id === "regime") return "Descriptive only. It does not open a trade.";
  if (id === "streakFade" || id === "streakFollow") return "Retired. A streak does not open a trade.";
  if (id === "selectedDigit") return "Matches and Differs, on the digit you picked. The barrier is not rotated.";
  if (id === "rolling") return "All six digit contracts. Rolling windows are one distribution, not extra confirmation.";
  if (id === "barrierProb") return "Over and Under. A digit equal to the barrier is a loss.";
  if (id === "parity") return "Even and Odd, scored separately against 50%.";
  if (id === "walkForward") return "Digit contracts. A signal also has to survive a held-out period.";
  if (id === "statistical") return "Digit contracts. Matches and Differs use the digit you picked.";
  if (id === "ensemble") return "Advisory only. It cannot force or veto a valid signal.";
  return FAMILIES[id].map((family) => FAMILY_LABEL[family]).join(", ");
}

/** Poor tagged results move a module to observation. The module is not removed. */
export function observeModule(config: ModuleConfig, profits: number[]): ModuleConfig {
  if (config.status !== "active" || profits.length < 8) return config;
  const net = profits.reduce((sum, n) => sum + n, 0);
  if (net > -Math.abs(config.maxLoss)) return config;
  return {
    ...config,
    status: "observation",
    observeReason: `Observation: tagged trades are down ${net.toFixed(2)}. The module was not deleted.`,
  };
}

export function walkModule(
  id: ModuleId,
  quotes: number[],
  cfg: ModuleConfig,
  steps = 5,
  pip = 2,
  target?: { type?: string; barrier?: string },
): { inSample: number | null; outSample: number | null; outTrials: number } {
  if (quotes.length < cfg.minSample + steps + 10) return { inSample: null, outSample: null, outTrials: 0 };
  const split = Math.floor(quotes.length * 0.7);
  return {
    inSample: sliceHit(id, quotes, cfg, cfg.minSample, split, steps, pip, target),
    outSample: sliceHit(id, quotes, cfg, split, quotes.length, steps, pip, target),
    outTrials: countTrials(id, quotes, cfg, split, quotes.length, steps, pip, target),
  };
}

function fits(side: "up" | "down" | "either", id: ModuleId, reading: ModuleReading): "yes" | "no" | "skip" {
  if (id === "statistical") return reading.sample >= 1 && reading.bias !== "none" ? "skip" : reading.reason.startsWith("Need") ? "no" : "skip";
  if (id === "expansion") return reading.bias === "flat" ? "yes" : "no";
  if (id === "regime") return "skip";
  if (side === "either") return reading.bias === "none" ? "no" : "skip";
  if (reading.bias === "none") return "no";
  if (reading.bias === "flat") return "skip";
  return reading.bias === side ? "yes" : "no";
}

function contractSide(type: string): "up" | "down" | "either" {
  const down = new Set(["PUT", "LOWER", "PUTE", "ASIAND", "RESETPUT", "MULTDOWN", "VANILLALONGPUT", "LBFLOATPUT", "TURBOSSHORT", "RUNLOW"]);
  const up = new Set(["CALL", "HIGHER", "CALLE", "ASIANU", "RESETCALL", "MULTUP", "VANILLALONGCALL", "LBFLOATCALL", "TURBOSLONG", "RUNHIGH"]);
  if (down.has(type)) return "down";
  if (up.has(type)) return "up";
  return "either";
}

function pullback(quotes: number[], cfg: ModuleConfig, base: Omit<ModuleReading, "reason">): ModuleReading {
  const fast = emaLast(quotes, cfg.emaFast);
  const slow = emaLast(quotes, cfg.emaSlow);
  const last = quotes[quotes.length - 1];
  const bars = barsFromTicks(quotes, 5);
  const width = atr(bars, 8);
  if (fast == null || slow == null || width == null || !(width > 0)) {
    return { ...base, reason: "Not enough movement to judge a pullback.", conditions: "EMA and ATR" };
  }
  const up = fast > slow && last >= slow && Math.abs(last - fast) <= width;
  const down = fast < slow && last <= slow && Math.abs(last - fast) <= width;
  const bias: ModuleBias = up ? "up" : down ? "down" : "none";
  return {
    ...base,
    bias,
    confidence: bias === "none" ? 0.15 : 0.6,
    reason: bias === "none" ? "No pullback into the fast average." : `Pullback ${bias} toward EMA ${cfg.emaFast} while EMA ${cfg.emaSlow} still leads.`,
    conditions: `EMA ${cfg.emaFast}/${cfg.emaSlow}, ATR band`,
  };
}

function breakout(quotes: number[], cfg: ModuleConfig, base: Omit<ModuleReading, "reason">): ModuleReading {
  const span = quotes.slice(-Math.max(10, cfg.lookback));
  if (span.length < 10) return { ...base, reason: "Breakout window is not full.", conditions: `Lookback ${cfg.lookback}` };
  const prior = span.slice(0, -3);
  const hi = Math.max(...prior);
  const lo = Math.min(...prior);
  const last = span[span.length - 1];
  const pad = Math.max((hi - lo) * 0.25, 0);
  const up = span[span.length - 3] > hi && last >= hi && last <= hi + pad;
  const down = span[span.length - 3] < lo && last <= lo && last >= lo - pad;
  const bias: ModuleBias = up ? "up" : down ? "down" : "none";
  return {
    ...base,
    bias,
    confidence: bias === "none" ? 0.1 : 0.58,
    reason: bias === "none" ? "No breakout retest in the lookback window." : `Retest of a ${bias} break of the prior ${prior.length}-tick range.`,
    conditions: `Lookback ${cfg.lookback}`,
  };
}

function reversion(quotes: number[], base: Omit<ModuleReading, "reason">): ModuleReading {
  const bands = bollinger(quotes, 20, 2);
  const last = quotes[quotes.length - 1];
  if (!bands) return { ...base, reason: "Bollinger window is not full.", conditions: "20-tick band" };
  const up = last < bands.lower;
  const down = last > bands.upper;
  const bias: ModuleBias = up ? "up" : down ? "down" : "none";
  const width = bands.upper - bands.lower;
  const stretch = width > 0 ? Math.min(1, Math.abs(last - bands.mid) / width) : 0;
  return {
    ...base,
    bias,
    confidence: bias === "none" ? 0.1 : Math.min(0.7, 0.4 + stretch / 2),
    reason: bias === "none" ? "Price is inside the band." : `Price is outside the band, so the module leans ${bias}. Stretch is not a win probability.`,
    conditions: "Bollinger 20, 2 standard deviations",
  };
}

function expansion(quotes: number[], base: Omit<ModuleReading, "reason">): ModuleReading {
  const deltas = tickDeltas(quotes);
  const recent = sampleStd(deltas.slice(-20));
  const older = sampleStd(deltas.slice(-80, -20));
  if (recent == null || older == null || !(older > 0)) {
    return { ...base, reason: "Not enough ticks to compare volatility.", conditions: "20 vs 60 ticks" };
  }
  const expanded = recent > older * 1.3;
  return {
    ...base,
    bias: expanded ? "flat" : "none",
    confidence: expanded ? Math.min(0.75, recent / older / 2) : 0.2,
    reason: expanded ? "Short-window volatility is above the prior window." : "Volatility is not expanding.",
    conditions: "Recent standard deviation versus the prior window",
  };
}

function momentum(quotes: number[], cfg: ModuleConfig, base: Omit<ModuleReading, "reason">): ModuleReading {
  const macd = macdHist(quotes);
  const rsiValue = rsi(quotes, 14);
  if (macd == null || rsiValue == null) return { ...base, reason: "MACD or RSI is not ready.", conditions: "MACD and RSI 14" };
  const up = macd > 0 && rsiValue >= cfg.emaFast + 45;
  const down = macd < 0 && rsiValue <= 55 - Math.min(10, cfg.emaFast);
  const bias: ModuleBias = up ? "up" : down ? "down" : "none";
  return {
    ...base,
    bias,
    confidence: bias === "none" ? 0.15 : 0.62,
    reason: bias === "none" ? "MACD and RSI do not agree." : `MACD and RSI both lean ${bias}.`,
    conditions: "MACD histogram and RSI 14",
  };
}

function regime(quotes: number[], cfg: ModuleConfig, base: Omit<ModuleReading, "reason">): ModuleReading {
  const fast = emaLast(quotes, cfg.emaFast);
  const slow = emaLast(quotes, cfg.emaSlow);
  const bars = barsFromTicks(quotes, 5);
  const width = atr(bars, 8);
  const trend = adx(bars, 8);
  if (fast == null || slow == null || width == null || !(width > 0)) {
    return { ...base, reason: "Regime inputs are not ready.", conditions: "EMA separation and ATR" };
  }
  const separated = Math.abs(fast - slow) > width;
  const bias: ModuleBias = !separated ? "flat" : fast > slow ? "up" : "down";
  return {
    ...base,
    bias,
    confidence: trend == null ? 0.4 : Math.min(0.8, trend / 50),
    reason: bias === "flat" ? "Averages are compressed. Treat this as a range." : `Trend regime to the ${bias}.`,
    conditions: trend == null ? "EMA versus ATR" : `ADX ${trend.toFixed(1)}, EMA versus ATR`,
  };
}

function statistical(quotes: number[], cfg: ModuleConfig, pip: number, base: Omit<ModuleReading, "reason">): ModuleReading {
  const freq = digitFrequencies(quotes, pip);
  const counts = digitCounts(quotes.slice(-Math.max(10, cfg.lookback * 4)), pip);
  const chi = digitChiSquare(counts);
  const adequate = freq.sample >= cfg.minSample;
  const evenRate = freq.sample ? freq.even / freq.sample : 0;
  const oddRate = freq.sample ? freq.odd / freq.sample : 0;
  return {
    ...base,
    sample: freq.sample,
    bias: "none",
    confidence: 0,
    reason: adequate
      ? `Digit frequency on ${freq.sample} ticks. Even ${pct(evenRate)}, odd ${pct(oddRate)}. Chi-square ${chi.toFixed(1)} is a uniformity note, not a win probability. A contract is judged against its own baseline, not a universal 50%.`
      : `Need ${cfg.minSample} ticks before the digit check. Have ${freq.sample}.`,
    conditions: "Last-digit counts. The trade check uses the selected contract.",
  };
}

function sliceHit(
  id: ModuleId,
  quotes: number[],
  cfg: ModuleConfig,
  from: number,
  to: number,
  steps: number,
  pip = 2,
  target?: { type?: string; barrier?: string },
): number | null {
  const n = countTrials(id, quotes, cfg, from, to, steps, pip, target);
  if (n === 0) return null;
  let wins = 0;
  eachTrial(id, quotes, cfg, from, to, steps, pip, target, (bias, now, future) => {
    if (forwardHit(id, bias, now, future, pip, target)) wins += 1;
  });
  return wins / n;
}

function countTrials(
  id: ModuleId,
  quotes: number[],
  cfg: ModuleConfig,
  from: number,
  to: number,
  steps: number,
  pip = 2,
  target?: { type?: string; barrier?: string },
): number {
  let n = 0;
  eachTrial(id, quotes, cfg, from, to, steps, pip, target, () => {
    n += 1;
  });
  return n;
}

function eachTrial(
  id: ModuleId,
  quotes: number[],
  cfg: ModuleConfig,
  from: number,
  to: number,
  steps: number,
  pip: number,
  target: { type?: string; barrier?: string } | undefined,
  visit: (bias: "up" | "down", now: number, future: number) => void,
) {
  if (id === "streakFade" || id === "streakFollow") {
    for (let i = Math.max(from, cfg.minSample - 1); i < to - 1; i++) {
      if (!streakDecision(quotes, i, cfg, pip)) continue;
      const past = quotes.slice(0, i + 1);
      const bias = signalBias(id, past, cfg, pip, target);
      const future = quotes[i + 1];
      if (bias == null || future == null) continue;
      visit(bias, quotes[i], future);
    }
    return;
  }
  const horizon = digitModule(id) ? 1 : steps;
  for (let i = Math.max(from, cfg.minSample); i < to - horizon; i += steps) {
    const past = quotes.slice(0, i + 1);
    const bias = signalBias(id, past, cfg, pip, target);
    const future = quotes[i + horizon];
    if (bias == null || future == null) continue;
    visit(bias, quotes[i], future);
  }
}

/** The first tick of a long-enough run. Later ticks inside that same run are not extra samples. */
function streakDecision(quotes: number[], index: number, cfg: ModuleConfig, pip: number): boolean {
  const freq = digitFrequencies(quotes.slice(0, index + 1), pip);
  const bits = freq.digits.map((digit) => digit % 2);
  const minStreak = Math.max(2, Math.min(8, Math.round(cfg.lookback) || 3));
  return currentParityStreak(bits).length === minStreak;
}

function digitModule(id: ModuleId): boolean {
  return isProbEngine(id) || id === "streakFade" || id === "streakFollow";
}

/** Digit modules use the future last digit. Directional modules keep price direction. */
export function forwardHit(
  id: ModuleId,
  bias: "up" | "down",
  now: number,
  future: number,
  pip: number,
  target?: { type?: string; barrier?: string },
): boolean {
  if (isProbEngine(id) && target?.type?.startsWith("DIGIT")) {
    return digitWins(target.type, target.barrier ?? "", lastDigit(future, pip));
  }
  if (digitModule(id)) {
    const even = lastDigit(future, pip) % 2 === 0;
    return bias === "up" ? even : !even;
  }
  const direction = future > now ? "up" : "down";
  return bias === direction;
}

function barrierContract(type: string): boolean {
  return type === "DIGITOVER" || type === "DIGITUNDER" || type === "DIGITMATCH" || type === "DIGITDIFF";
}

/** Prediction at `index` using only quotes through that tick. Later quotes are ignored. */
export function predictionAt(
  id: ModuleId,
  quotes: number[],
  index: number,
  cfg: ModuleConfig,
  pip = 2,
  target?: { type?: string; barrier?: string },
): "up" | "down" | null {
  if (!Number.isInteger(index) || index < 0 || index >= quotes.length) return null;
  return signalBias(id, quotes.slice(0, index + 1), cfg, pip, target);
}

/** Up means Even for parity strategies. Directional strategies keep up and down as price direction. */
function signalBias(
  id: ModuleId,
  quotes: number[],
  cfg: ModuleConfig,
  pip: number,
  target?: { type?: string; barrier?: string },
): "up" | "down" | null {
  if (isProbEngine(id)) {
    const named = target?.type?.startsWith("DIGIT") ? target.type : "";
    if (named) {
      const fit = statisticalFit(id, named, quotes, cfg, pip, target?.barrier ?? "");
      if (fit.fit !== "yes") return null;
      return named === "DIGITODD" ? "down" : "up";
    }
    if (id === "barrierProb" || id === "selectedDigit") return null;
    if (statisticalFit(id, "DIGITEVEN", quotes, cfg, pip, "").fit === "yes") return "up";
    if (statisticalFit(id, "DIGITODD", quotes, cfg, pip, "").fit === "yes") return "down";
    return null;
  }
  const reading = readModule(id, quotes, cfg, pip);
  if (reading.bias === "up" || reading.bias === "down") return reading.bias;
  return null;
}

function judge(
  id: ModuleId,
  contractType: string,
  quotes: number[],
  cfg: ModuleConfig,
  pip: number,
  barrier: string,
  options?: DigitGateOptions,
): { fit: "yes" | "no" | "wait"; reading: ModuleReading } {
  if (isProbEngine(id)) return statisticalFit(id, contractType, quotes, cfg, pip, barrier, options);
  const invalid = digitModule(id) ? digitSettingsError(cfg) : null;
  if (invalid) {
    const reading = readModule(id, quotes, cfg, pip);
    return { fit: "wait", reading: { ...reading, bias: "none", confidence: 0, reason: `WAIT. ${invalid}` } };
  }
  const reading = readModule(id, quotes, cfg, pip);
  if (quotes.length < cfg.minSample) return { fit: "wait", reading };
  if (id === "streakFade" || id === "streakFollow") {
    if (reading.reason.startsWith("WAIT.")) return { fit: "wait", reading };
    if (reading.bias === "none") return { fit: "no", reading };
    const even = contractType === "DIGITEVEN";
    return { fit: (even && reading.bias === "up") || (!even && reading.bias === "down") ? "yes" : "no", reading };
  }
  if (id === "expansion") return { fit: reading.bias === "flat" && reading.confidence >= cfg.minConfidence ? "yes" : "no", reading };
  if (reading.bias === "none" || reading.bias === "flat") return { fit: "no", reading };
  if (reading.confidence < cfg.minConfidence) return { fit: "no", reading };
  const side = contractSide(contractType);
  if (side === "either") return { fit: "no", reading };
  return { fit: reading.bias === side ? "yes" : "no", reading };
}

function statisticalFit(
  id: ModuleId,
  contractType: string,
  quotes: number[],
  cfg: ModuleConfig,
  pip: number,
  barrier: string,
  options?: DigitGateOptions,
): { fit: "yes" | "no" | "wait"; reading: ModuleReading } {
  const base = {
    id,
    name: NAMES[id],
    sample: quotes.length,
    confidence: 0,
    bias: "none" as ModuleBias,
    conditions: "Beta-Binomial posterior and the wider of the Wilson and Beta bounds",
  };
  const invalid = digitSettingsError(cfg);
  if (invalid) return { fit: "wait", reading: { ...base, reason: `WAIT. ${invalid}` } };
  const parity = contractType === "DIGITEVEN" || contractType === "DIGITODD";
  const studied = parity || barrierContract(contractType);
  if (!studied || !supportsContract(id, "digit", contractType)) {
    return { fit: "no", reading: { ...base, reason: `${NAMES[id]} does not trade this contract.` } };
  }
  const study = studyContract({
    contract: contractType,
    quotes,
    pip,
    barrier,
    minSample: cfg.minSample,
    minConfidence: cfg.minConfidence,
    strategy: NAMES[id],
    lookback: cfg.lookback,
    minEffective: options?.minEffective,
    z: options?.z,
    persist: id === "walkForward" ? true : options?.persist,
    stake: options?.stake,
    payout: options?.payout,
  });
  const bias: ModuleBias = study.status !== "yes" ? "none" : contractType === "DIGITEVEN" ? "up" : contractType === "DIGITODD" ? "down" : "flat";
  return {
    fit: study.status,
    reading: {
      ...base,
      sample: study.sample,
      bias,
      confidence: study.status === "yes" ? study.lo : 0,
      reason: study.reason,
    },
  };
}

function streakSide(
  mode: "fade" | "follow",
  quotes: number[],
  cfg: ModuleConfig,
  pip: number,
  base: Omit<ModuleReading, "reason">,
): ModuleReading {
  const name = mode === "fade" ? NAMES.streakFade : NAMES.streakFollow;
  const invalid = digitSettingsError(cfg);
  if (invalid) return { ...base, bias: "none", confidence: 0, reason: `WAIT. ${invalid}` };
  const freq = digitFrequencies(quotes, pip);
  const bits = freq.digits.map((digit) => digit % 2);
  const minStreak = Math.max(2, Math.min(8, Math.round(cfg.lookback) || 3));
  const need = requiredEpisodes(cfg.minSample);
  if (bits.length < cfg.minSample) {
    return { ...base, sample: bits.length, reason: `WAIT. Need ${cfg.minSample} ticks. Have ${bits.length}. A long streak is not a signal.` };
  }
  const now = currentParityStreak(bits);
  const episodes = parityEpisodes(bits, minStreak);
  const label = now.side === 0 ? "Even" : "Odd";
  if (now.length < minStreak) {
    return {
      ...base,
      sample: episodes.cases,
      reason: `WAIT. The current ${label} run is ${now.length}. ${name} waits for ${minStreak}. A long run by itself is not a signal.`,
    };
  }
  if (episodes.cases < need) {
    return {
      ...base,
      sample: episodes.cases,
      reason: `WAIT. Only ${episodes.cases} independent runs of ${minStreak} or more. Need ${need}. Overlapping windows inside one streak are not counted. The current ${label} run of ${now.length} is not a signal.`,
    };
  }
  const hits = mode === "fade" ? episodes.fade : episodes.follow;
  const span = wilsonInterval(hits, episodes.cases);
  const predicted = mode === "fade" ? (now.side === 0 ? "Odd" : "Even") : label;
  const fair = 0.5;
  const qualified = clearsBaseline(span.lo, fair, cfg.minConfidence);
  const shared = `${name}. Predicted ${predicted}. Current ${label} streak ${now.length}. ${hits} of ${episodes.cases} independent runs. Estimated ${pct(span.p)}. Interval ${pct(span.lo)} to ${pct(span.hi)}. Baseline ${pct(fair)}.`;
  if (!qualified) {
    return {
      ...base,
      sample: episodes.cases,
      confidence: 0,
      reason: `${shared} Not qualified. The lower bound does not clear 50%. Streak length is not used by itself. This is not a guaranteed win rate.`,
    };
  }
  return {
    ...base,
    sample: episodes.cases,
    bias: predicted === "Even" ? "up" : "down",
    confidence: span.lo,
    reason: `${shared} Qualified because the lower bound is above 50% on separate runs. That bound is not a promise about the next tick.`,
    conditions: `Non-overlapping ${mode} after ${minStreak}+`,
  };
}

function contractEngineCard(
  quotes: number[],
  pip: number,
  contractType: string,
  barrier: string,
  options: (DigitGateOptions & { ask?: number | null }) | undefined,
  idle: {
    sample: number;
    last: number | null;
    counts: number[];
    even: number;
    odd: number;
    streak: string;
    contract: string;
    fair: string;
    active: string;
    status: string;
    reason: string;
    estimate: string;
    observed: string;
    interval: string;
    hits: string;
    effective: string;
    breakEven: string;
    expectedReturn: string;
    ask: string;
    payout: string;
    netProfit: string;
    loss: string;
    ratio: string;
  },
  money: { ask: string; payout: string },
) {
  const minSample = Math.max(20, options?.minSample ?? 20);
  const study = studyContract({
    contract: contractType,
    quotes,
    pip,
    barrier,
    minSample,
    minConfidence: 0.5,
    strategy: contractType,
    lookback: Math.max(20, options?.lookback ?? 40),
    minEffective: options?.minEffective,
    z: options?.z,
    persist: options?.persist,
    stake: options?.stake,
    payout: options?.payout,
  });
  const ready = study.sample >= minSample && study.nEff > 0;
  const priced = moneyText({
    stake: options?.stake,
    payout: options?.payout,
    ask: options?.ask,
    probability: ready ? study.p : null,
    breakEven: study.breakEven,
    expectedReturn: ready ? study.expectedReturn : null,
  });
  const status = study.status === "yes" ? "Qualified" : study.status === "wait" ? "WAIT" : "Not qualified";
  return {
    ...idle,
    active: "Contract engine",
    status,
    reason: markEvidence(study.reason),
    estimate: ready ? pct(study.p) : "—",
    observed: ready ? pct(study.observed) : "—",
    interval: ready ? `${pct(study.lo)} – ${pct(study.hi)}` : "—",
    hits: ready ? `${study.hits}/${study.sample}` : "—",
    effective: ready ? String(Math.round(study.nEff)) : "—",
    breakEven: priced.breakEven,
    expectedReturn: priced.expectedReturn,
    netProfit: priced.netProfit,
    loss: priced.loss,
    ratio: priced.ratio,
    ask: money.ask,
    payout: money.payout,
  };
}

export function explainDigits(
  quotes: number[],
  pip: number,
  contractType: string | null,
  barrier: string,
  configs: Record<string, ModuleConfig> | undefined,
  options?: DigitGateOptions & { ask?: number | null },
): {
  sample: number;
  last: number | null;
  counts: number[];
  even: number;
  odd: number;
  streak: string;
  contract: string;
  fair: string;
  active: string;
  status: string;
  reason: string;
  estimate: string;
  observed: string;
  interval: string;
  hits: string;
  effective: string;
  breakEven: string;
  expectedReturn: string;
  ask: string;
  payout: string;
  netProfit: string;
  loss: string;
  ratio: string;
} {
  const freq = digitFrequencies(quotes, pip);
  const contract = contractType || "None selected";
  const fair = contractType ? fairText(contractType, barrier) : "—";
  const money = moneyText(options);
  const idle = {
    sample: freq.sample,
    last: freq.last,
    counts: freq.counts,
    even: freq.even,
    odd: freq.odd,
    streak: freq.sample ? `${freq.streakSide} ${freq.streak}` : "—",
    contract,
    fair,
    active: "None on",
    status: "WAIT",
    reason: markEvidence("No digit strategy is turned on. Nothing here is a win rate."),
    estimate: "—",
    observed: "—",
    interval: "—",
    hits: "—",
    effective: "—",
    ...money,
  };
  if (!configs || !contractType) return idle;
  const order = ["statistical", "selectedDigit", "rolling", "barrierProb", "parity", "walkForward"] as const;
  const enabled = order.filter((id) => configs[id]?.enabled && configs[id]?.status === "active" && supportsContract(id, "digit", contractType));
  if (enabled.length === 0) return contractEngineCard(quotes, pip, contractType, barrier, options, idle, money);
  const parts: string[] = [];
  let chosen: {
    name: string;
    status: string;
    reason: string;
    estimate: string;
    observed: string;
    interval: string;
    hits: string;
    effective: string;
    breakEven: string;
    expectedReturn: string;
    netProfit: string;
    loss: string;
    ratio: string;
  } | null = null;
  for (const id of enabled) {
    const verdict = judge(id, contractType, quotes, configs[id], pip, barrier, options);
    const study = studyContract({
      contract: contractType,
      quotes,
      pip,
      barrier,
      minSample: configs[id].minSample,
      minConfidence: configs[id].minConfidence,
      strategy: NAMES[id],
      lookback: configs[id].lookback,
      minEffective: options?.minEffective,
      z: options?.z,
      persist: id === "walkForward" ? true : options?.persist,
      stake: options?.stake,
      payout: options?.payout,
    });
    const status = verdict.fit === "yes" ? "Qualified" : verdict.fit === "wait" ? "WAIT" : "Not qualified";
    parts.push(`${NAMES[id]}: ${status}`);
    const ready = study.sample >= configs[id].minSample && study.nEff > 0;
    const priced = moneyText({
      stake: options?.stake,
      payout: options?.payout,
      ask: options?.ask,
      probability: ready ? study.p : null,
      breakEven: study.breakEven,
      expectedReturn: ready ? study.expectedReturn : null,
    });
    const row = {
      name: NAMES[id],
      status,
      reason: verdict.reading.reason,
      estimate: ready ? pct(study.p) : "—",
      observed: ready ? pct(study.observed) : "—",
      interval: ready ? `${pct(study.lo)} – ${pct(study.hi)}` : "—",
      hits: ready ? `${study.hits}/${study.sample}` : "—",
      effective: ready ? String(Math.round(study.nEff)) : "—",
      breakEven: priced.breakEven,
      expectedReturn: priced.expectedReturn,
      netProfit: priced.netProfit,
      loss: priced.loss,
      ratio: priced.ratio,
    };
    if (verdict.fit === "yes" && (!chosen || chosen.status !== "Qualified")) chosen = row;
    else if (!chosen) chosen = row;
  }
  const shown = chosen ?? {
    status: idle.status,
    reason: idle.reason,
    estimate: idle.estimate,
    observed: idle.observed,
    interval: idle.interval,
    hits: idle.hits,
    effective: idle.effective,
    breakEven: money.breakEven,
    expectedReturn: money.expectedReturn,
    netProfit: money.netProfit,
    loss: money.loss,
    ratio: money.ratio,
  };
  return {
    ...idle,
    active: parts.join(" · "),
    status: shown.status,
    reason: markEvidence(shown.reason),
    estimate: shown.estimate,
    observed: shown.observed,
    interval: shown.interval,
    hits: shown.hits,
    effective: shown.effective,
    breakEven: shown.breakEven,
    expectedReturn: shown.expectedReturn,
    netProfit: shown.netProfit,
    loss: shown.loss,
    ratio: shown.ratio,
    ask: money.ask,
    payout: money.payout,
  };
}

function moneyText(options?: { stake?: number | null; payout?: number | null; ask?: number | null; probability?: number | null; breakEven?: number | null; expectedReturn?: number | null }): {
  breakEven: string;
  expectedReturn: string;
  ask: string;
  payout: string;
  netProfit: string;
  loss: string;
  ratio: string;
} {
  const stake = options?.stake != null && options.stake > 0 ? options.stake : null;
  const ask = options?.ask != null && options.ask > 0 ? options.ask : null;
  const payout = options?.payout != null && options.payout > 0 ? options.payout : null;
  const risk = ask ?? stake;
  const net = risk != null && payout != null ? payout - risk : null;
  const ratio = risk != null && payout != null ? payout / risk : null;
  const breakEven = options?.breakEven ?? (risk != null && payout != null ? impliedProbability(payout, risk) : null);
  const expected =
    options?.expectedReturn ??
    (risk != null && payout != null && options?.probability != null ? expectedValue(options.probability, payout, risk) : null);
  return {
    breakEven: breakEven == null ? "—" : pct(breakEven),
    expectedReturn: expected == null ? "—" : expected.toFixed(3),
    ask: ask == null ? "—" : ask.toFixed(2),
    payout: payout == null ? "—" : payout.toFixed(2),
    netProfit: net == null ? "—" : net.toFixed(2),
    loss: risk == null ? "—" : risk.toFixed(2),
    ratio: ratio == null ? "—" : ratio.toFixed(3),
  };
}

function markEvidence(reason: string): string {
  if (reason.includes(NO_VERIFIED_OOS) || reason.includes(NO_VERIFIED_EDGE) || reason.includes("Qualified because") || reason.includes("Qualified for an entry")) return reason;
  return `${reason} ${NO_VERIFIED_EDGE}`;
}

function fairText(contract: string, barrier: string): string {
  const fair = fairDigit(contract, barrier);
  return fair == null ? "—" : pct(fair);
}
