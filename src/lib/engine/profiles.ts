import { CONTRACTS, CONTRACT_BY_TYPE } from "./catalog.ts";

export type StrategyStatus = "active" | "testing" | "observation" | "suspended";
export type PresetName = "conservative" | "balanced" | "aggressive";
export type DurationUnit = "t" | "s" | "m";

export type StrategyProfile = {
  type: string;
  enabled: boolean;
  status: StrategyStatus;
  suspendReason: string | null;
  markets: string[];
  minScore: number;
  /** Currency. Never negative: a strategy cannot be told to accept a losing price. */
  minEv: number;
  minSample: number;
  window: number;
  duration: number;
  durationUnit: DurationUnit;
  barrier: string;
  stake: number;
  maxStake: number;
  maxOpen: number;
  cooldownSec: number;
  dailyTradeLimit: number;
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
  minPayout: number;
  maxExposure: number;
  shortWindow: number;
  mediumWindow: number;
  longWindow: number;
  /** Minimum effective sample after dependence. Not a win rate. */
  minEffective: number;
  /** Normal z for the equal-tail interval. A new contract uses 1.96 (about 95%). A saved value is not rewritten. */
  intervalZ: number;
  /** Training ticks used only to choose an auto barrier. Not a stake. */
  trainSize: number;
  /** Later ticks that accept or reject that one barrier. They do not choose another. */
  validationSize: number;
  /** Untouched ticks in each final period. */
  finalSize: number;
  /** How many separate final periods must be scored. Two is the minimum. */
  validationPeriods: number;
  /** Effective out-of-sample outcomes required before a result can be called supported. */
  minOos: number;
  /** When false, a held-out period does not have to clear the baseline. Sign disagreement still waits. */
  walkForward: boolean;
  /** The only implemented digit probability method. */
  method: "beta-binomial";
  /** Over and Under only. Off means a blank digit does not become a barrier. */
  autoBarrier: boolean;
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiBuy: number;
  rsiSell: number;
  minAdx: number;
  multiplier: number;
  stopLoss: number;
  takeProfit: number;
  growthRate: number;
  version: number;
};

const PRESET_FIELDS: Record<PresetName, Pick<StrategyProfile, "minScore" | "minSample">> = {
  conservative: { minScore: 0.35, minSample: 300 },
  balanced: { minScore: 0.1, minSample: 80 },
  aggressive: { minScore: 0, minSample: 30 },
};

export function defaultProfile(type: string): StrategyProfile {
  const family = CONTRACT_BY_TYPE.get(type)?.family;
  const digit = family === "digit";
  return {
    type,
    enabled: true,
    status: "active",
    suspendReason: null,
    markets: [],
    minScore: 0,
    minEv: 0,
    minSample: digit ? 20 : 30,
    window: digit ? 100 : 80,
    duration: digit ? 1 : family === "touch" || family === "turbo" ? 5 : 5,
    durationUnit: family === "touch" || family === "turbo" ? "m" : "t",
    barrier: "",
    stake: 1,
    maxStake: 5,
    maxOpen: 1,
    cooldownSec: 60,
    dailyTradeLimit: 20,
    maxDailyLoss: 20,
    maxConsecutiveLosses: 3,
    minPayout: 0,
    maxExposure: 25,
    shortWindow: 25,
    mediumWindow: 100,
    longWindow: 300,
    minEffective: 40,
    intervalZ: 1.96,
    trainSize: 80,
    validationSize: 40,
    finalSize: 40,
    validationPeriods: 3,
    minOos: 40,
    walkForward: digit,
    method: "beta-binomial",
    autoBarrier: false,
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    rsiBuy: 0,
    rsiSell: 100,
    minAdx: 0,
    multiplier: family === "multiplier" ? 10 : 0,
    stopLoss: 1,
    takeProfit: 2,
    growthRate: 0.01,
    version: 1,
  };
}

export const CONFIDENCE_LEVELS = [
  { z: 1.64, label: "90%" },
  { z: 1.96, label: "95% — default for a new contract" },
  { z: 2.58, label: "99%" },
] as const;

export function confidenceLabel(z: number): string {
  const nearest = CONFIDENCE_LEVELS.reduce((best, item) => (Math.abs(item.z - z) < Math.abs(best.z - z) ? item : best));
  return nearest.label;
}

export function defaultBook(): Record<string, StrategyProfile> {
  const book: Record<string, StrategyProfile> = {};
  for (const contract of CONTRACTS) book[contract.type] = defaultProfile(contract.type);
  return book;
}

/** Old saved books omit Auto Barrier Selection. A missing flag stays off. A saved confidence level is kept. */
export function mergeProfile(base: StrategyProfile, saved: Partial<StrategyProfile>): StrategyProfile {
  const autoBarrier = "autoBarrier" in saved ? saved.autoBarrier === true : base.autoBarrier === true;
  const intervalZ = typeof saved.intervalZ === "number" && Number.isFinite(saved.intervalZ) ? saved.intervalZ : base.intervalZ;
  return { ...base, ...saved, type: saved.type || base.type, autoBarrier, intervalZ, method: "beta-binomial" };
}

/** Signal filters only. Stake, loss limits, cooldown, and exposure stay as the user set them. */
export function applyPreset(profile: StrategyProfile, name: PresetName): StrategyProfile {
  return clampProfile({ ...profile, ...PRESET_FIELDS[name] });
}

export function profileFor(type: string, book?: Record<string, StrategyProfile>): StrategyProfile {
  return book?.[type] ?? defaultProfile(type);
}

/** The smaller of the strategy stake and the account-level stake. Enabling a strategy does not raise either cap. */
export function cappedStake(profile: StrategyProfile, globalStake: number, globalMax: number): number {
  return Math.min(profile.stake, globalStake, profile.maxStake, globalMax);
}

export function validateProfile(profile: StrategyProfile): string[] {
  const errors: string[] = [];
  if (!(profile.stake > 0)) errors.push("Stake must be above zero.");
  if (profile.stake > profile.maxStake) errors.push("Stake is above this strategy's maximum.");
  if (profile.duration < 1) errors.push("Duration must be at least 1.");
  if (profile.emaFast < 2 || profile.emaSlow <= profile.emaFast) errors.push("The slow EMA must be longer than the fast EMA.");
  if (profile.minSample < 1) errors.push("Sample size must be at least 1.");
  if (profile.shortWindow < 5 || profile.mediumWindow < profile.shortWindow || profile.longWindow < profile.mediumWindow) {
    errors.push("Digit windows must grow from short to long.");
  }
  if (CONTRACT_BY_TYPE.get(profile.type)?.family === "digit") {
    if (!Number.isFinite(profile.minEffective) || profile.minEffective < 10 || profile.minEffective > 2000) {
      errors.push("Minimum effective sample must be between 10 and 2000.");
    }
    if (!Number.isFinite(profile.intervalZ) || profile.intervalZ < 1 || profile.intervalZ > 2.58) {
      errors.push("Confidence interval level must be between 1 and 2.58.");
    }
    if (!Number.isFinite(profile.trainSize) || profile.trainSize < 40 || profile.trainSize > 5000) {
      errors.push("Training sample must be between 40 and 5000 ticks.");
    }
    if (!Number.isFinite(profile.validationSize) || profile.validationSize < 20 || profile.validationSize > 5000) {
      errors.push("Validation sample must be between 20 and 5000 ticks.");
    }
    if (!Number.isFinite(profile.finalSize) || profile.finalSize < 20 || profile.finalSize > 5000) {
      errors.push("Final out-of-sample sample must be between 20 and 5000 ticks.");
    }
    if (!Number.isInteger(profile.validationPeriods) || profile.validationPeriods < 2 || profile.validationPeriods > 12) {
      errors.push("Validation periods must be between 2 and 12.");
    }
    if (!Number.isFinite(profile.minOos) || profile.minOos < 40 || profile.minOos > 5000) {
      errors.push("Minimum out-of-sample evidence must be at least 40 effective outcomes.");
    }
    if (profile.method !== "beta-binomial") errors.push("Probability method must stay beta-binomial.");
    if (typeof profile.walkForward !== "boolean") errors.push("Walk-forward validation must be on or off.");
    if ((profile.type === "DIGITOVER" || profile.type === "DIGITUNDER") && typeof profile.autoBarrier !== "boolean") {
      errors.push("Auto barrier selection must be on or off.");
    }
  }
  if (profile.maxOpen < 1) errors.push("At least one open trade must be allowed.");
  if (profile.maxConsecutiveLosses < 1) errors.push("Consecutive-loss limit must be at least 1.");
  if (profile.cooldownSec < 0) errors.push("Cooldown cannot be negative.");
  if (profile.multiplier < 0) errors.push("Multiplier cannot be negative.");
  if (profile.growthRate <= 0 || profile.growthRate >= 0.05) errors.push("Growth rate must be between 0 and 5%.");
  return errors;
}

export function clampProfile(profile: StrategyProfile): StrategyProfile {
  return {
    ...profile,
    stake: Math.min(Math.max(0.35, profile.stake), profile.maxStake),
    minScore: Math.min(1, Math.max(0, profile.minScore)),
    duration: Math.max(1, Math.round(profile.duration)),
    minSample: Math.max(1, Math.round(profile.minSample)),
    minEffective: Math.min(2000, Math.max(10, Math.round(profile.minEffective || 40))),
    intervalZ: Math.min(2.58, Math.max(1, profile.intervalZ || 1.96)),
    trainSize: Math.min(5000, Math.max(40, Math.round(profile.trainSize || 80))),
    validationSize: Math.min(5000, Math.max(20, Math.round(profile.validationSize || 40))),
    finalSize: Math.min(5000, Math.max(20, Math.round(profile.finalSize || 40))),
    validationPeriods: Math.min(12, Math.max(2, Math.round(profile.validationPeriods || 3))),
    minOos: Math.min(5000, Math.max(40, Math.round(profile.minOos || 40))),
    method: "beta-binomial",
    autoBarrier: profile.autoBarrier === true,
  };
}

export function entryBlock(
  profile: StrategyProfile,
  input: {
    ev: number | null;
    payout: number | null;
    stake: number;
    openForStrategy: number;
    tradesToday: number;
    dailyPnl: number;
    consecutiveLosses: number;
    exposure: number | null;
    secondsSinceLoss?: number | null;
  },
): string | null {
  if (!profile.enabled) return "Strategy is disabled.";
  if (profile.status === "suspended") return profile.suspendReason || "Strategy is suspended.";
  if (profile.status !== "active") return "Strategy is in testing or observation, so it will not buy.";
  if (input.payout != null && input.stake > 0 && profile.minPayout > 0 && input.payout / input.stake < profile.minPayout) {
    return "Payout is under this strategy's minimum.";
  }
  if (input.openForStrategy >= profile.maxOpen) return "This strategy is at its open-trade limit.";
  if (input.tradesToday >= profile.dailyTradeLimit) return "This strategy hit its daily trade limit.";
  if (input.dailyPnl <= -Math.abs(profile.maxDailyLoss)) return "This strategy hit its daily loss limit.";
  if (input.secondsSinceLoss != null && input.secondsSinceLoss < profile.cooldownSec) {
    return "This strategy's cooldown is still running.";
  }
  if (input.exposure != null && input.exposure > profile.maxExposure) return "Exposure is above this strategy's cap.";
  return null;
}

/** A loss streak used to suspend the strategy. That block is no longer applied. */
export function releaseLossSuspension(profile: StrategyProfile): StrategyProfile {
  if (profile.status !== "suspended") return profile;
  if (!/consecutive-loss/i.test(profile.suspendReason ?? "")) return profile;
  return { ...profile, status: "active", suspendReason: null };
}

export function healthVerdict(
  profile: StrategyProfile,
  stats: { consecutiveLosses: number; dailyPnl: number },
): { status: "suspended"; reason: string } | null {
  if (profile.status === "suspended") return null;
  if (stats.dailyPnl <= -Math.abs(profile.maxDailyLoss)) {
    return { status: "suspended", reason: "Suspended: daily loss limit reached. Reactivate it yourself." };
  }
  return null;
}

export function fieldsFor(type: string): string[] {
  const family = CONTRACT_BY_TYPE.get(type)?.family;
  const common = [
    "enabled",
    "markets",
    "stake",
    "maxStake",
    "maxOpen",
    "cooldownSec",
    "dailyTradeLimit",
    "maxDailyLoss",
    "maxConsecutiveLosses",
    "minPayout",
    "duration",
    "durationUnit",
  ];
  if (family === "digit") {
    const fields = [...common, "minSample", "shortWindow", "mediumWindow", "longWindow", "minEffective", "intervalZ", "trainSize", "validationSize", "finalSize", "validationPeriods", "minOos", "method", "walkForward"];
    if (type === "DIGITOVER" || type === "DIGITUNDER") fields.push("autoBarrier");
    if (type === "DIGITOVER" || type === "DIGITUNDER" || type === "DIGITMATCH" || type === "DIGITDIFF") fields.push("barrier");
    return fields;
  }
  if (family === "directional" || family === "barrier" || family === "vanilla" || family === "asian" || family === "reset") {
    return [...common, "minScore", "minSample", "emaFast", "emaSlow", "rsiPeriod", "rsiBuy", "rsiSell", "minAdx"];
  }
  if (family === "touch" || family === "turbo" || family === "range") {
    return [...common, "minSample", "barrier"];
  }
  if (family === "multiplier") return [...common, "minScore", "multiplier", "stopLoss", "takeProfit", "maxExposure", "emaFast", "emaSlow"];
  if (family === "accumulator") return [...common, "growthRate", "maxExposure", "minSample"];
  if (family === "ticks" || family === "run") return [...common, "minSample", "window"];
  return [...common, "minSample", "window"];
}
