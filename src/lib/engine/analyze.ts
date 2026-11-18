import { CONTRACT_BY_TYPE, type ContractMeta, type Family } from "./catalog.ts";
import { selectAutoBarrier, runDigitEngine } from "./digit-engines.ts";
import { readDirection } from "./indicators.ts";
import { defaultProfile, type StrategyProfile } from "./profiles.ts";
import { activeEntryModules, approvedEntry, type ModuleConfig } from "./modules.ts";
import {
  clamp,
  decimalPlaces,
  digitChiSquare,
  digitCounts,
  digitChoices,
  expectedValue,
  fairDigit,
  formatBarrier,
  lastDigit,
  normalCdf,
  sampleStd,
  terminalBetween,
  tickDeltas,
  touchProbability,
} from "./math.ts";

export type Offered = {
  contract_type: string;
  min_contract_duration?: string;
  max_contract_duration?: string;
  multiplier_range?: number[];
  growth_rate_range?: number[];
  growth_rate_barrier_offsets?: number[];
  barrier?: string;
  barrier_choices?: string[];
  last_digit_range?: number[];
};

export type PriceRequest = {
  contract_type: string;
  duration?: number;
  duration_unit?: "t" | "s" | "m" | "h" | "d";
  barrier?: string;
  barrier2?: string;
  multiplier?: number;
  growth_rate?: number;
  selected_tick?: number;
  limit_order?: { stop_loss?: number; take_profit?: number };
};

export type Plan = {
  symbol: string;
  type: string;
  name: string;
  family: Family;
  summary: string;
  status: "pricing" | "stand-aside" | "unavailable" | "warming";
  note: string;
  rationale: string[];
  pModel: number | null;
  pCons: number | null;
  /** Signed currency EV when the contract has no fixed payout (accumulators). */
  modelEv: number | null;
  request?: PriceRequest;
  diagnostics: { label: string; value: string }[];
  /** Modules that agreed with this plan. Empty when none are enabled. */
  modules?: string[];
};

export type BookInput = {
  symbol: string;
  quotes: number[];
  pipSize: number;
  offered: Offered[];
  minSample: number;
  phase: number;
  stake: number;
  /** Digit the user picked. A blank Over or Under barrier is not filled in unless Auto Barrier Selection is on and the barrier qualifies. */
  digit?: number | null;
  /** Prior strength and interval width for the digit posterior. */
  prior?: number;
  z?: number;
  profiles?: Record<string, StrategyProfile>;
  modules?: Record<string, ModuleConfig>;
};

export function analyzeBook(input: BookInput): Plan[] {
  const features = buildFeatures(input);
  const offeredTypes = new Set(input.offered.map((o) => o.contract_type));
  const hasFeed = input.offered.length > 0;
  return [...CONTRACT_BY_TYPE.values()].map((meta) => {
    if (hasFeed && !offeredTypes.has(meta.type)) {
      return base(input.symbol, meta, "unavailable", "Not listed on this symbol right now.", features);
    }
    const matches = input.offered.filter((row) => row.contract_type === meta.type);
    const offered = withShared(preferShorter(matches), matches);
    return applyProfile(planOne(meta, features, offered, input), input, offered);
  });
}

type Features = {
  symbol: string;
  quotes: number[];
  pip: number;
  places: number;
  last: number | null;
  digit: number | null;
  sigma: number;
  sample: number;
  chi: number;
  warmingDigits: boolean;
  warmingTrend: boolean;
  dir: ReturnType<typeof readDirection>;
  counts: number[];
};

function buildFeatures(input: BookInput): Features {
  const quotes = input.quotes;
  const deltas = tickDeltas(quotes);
  const sigma = sampleStd(deltas) ?? 0;
  const counts = digitCounts(quotes, input.pipSize);
  const chi = digitChiSquare(counts);
  const dir = readDirection(quotes);
  const last = quotes.length ? quotes[quotes.length - 1] : null;
  return {
    symbol: input.symbol,
    quotes,
    pip: input.pipSize,
    places: decimalPlaces(input.pipSize),
    last,
    digit: last == null ? null : lastDigit(last, input.pipSize),
    sigma,
    sample: quotes.length,
    chi,
    warmingDigits: quotes.length < input.minSample,
    warmingTrend: quotes.length < 80,
    dir,
    counts,
  };
}

function applyProfile(plan: Plan, input: BookInput, offered: Offered | undefined): Plan {
  const profile = input.profiles?.[plan.type] ?? defaultProfile(plan.type);
  if (!profile.enabled) return stand(plan, "Disabled in Strategy Control.");
  if (profile.status === "suspended") return stand(plan, profile.suspendReason || "Suspended in Strategy Control.");
  if (profile.status !== "active") return stand(plan, "Testing or observation. This strategy will not buy.");
  if (profile.markets.length > 0 && !profile.markets.includes(plan.symbol)) {
    return stand(plan, "This market is not selected for the strategy.");
  }
  if (!input.modules && plan.family === "digit" && input.quotes.length < Math.max(profile.minSample, profile.shortWindow)) {
    const need = Math.max(profile.minSample, profile.shortWindow);
    const row = stand(plan, `Digit sample ${input.quotes.length}/${need}.`);
    row.status = "warming";
    return row;
  }
  if (plan.request && plan.status === "pricing") {
    const dur = chooseDuration(offered, profile.duration, profile.durationUnit);
    plan.request.duration = dur.n;
    plan.request.duration_unit = dur.unit;
    if (
      (plan.type === "DIGITOVER" || plan.type === "DIGITUNDER" || plan.type === "DIGITMATCH" || plan.type === "DIGITDIFF" || plan.family === "touch" || plan.family === "turbo" || plan.family === "range") &&
      profile.barrier.trim() !== ""
    ) {
      plan.request.barrier = profile.barrier.trim();
    }
    const choices = digitChoices(plan.type);
    if (choices && input.digit != null && choices.includes(input.digit)) {
      plan.request.barrier = String(input.digit);
    }
    if (plan.family === "multiplier") {
      const range = offered?.multiplier_range?.filter((n) => n > 0) ?? [];
      const picked = closest(range, profile.multiplier) ?? plan.request.multiplier;
      if (picked != null) plan.request.multiplier = picked;
      plan.request.limit_order = {
        stop_loss: Math.max(0.35, profile.stopLoss),
        take_profit: Math.max(0.35, profile.takeProfit),
      };
    }
    if (plan.family === "accumulator") plan.request.growth_rate = profile.growthRate;
    if (!input.modules && (plan.family === "directional" || plan.family === "barrier" || plan.family === "asian" || plan.family === "reset")) {
      const dir = readDirection(input.quotes, {
        emaFast: profile.emaFast,
        emaSlow: profile.emaSlow,
        rsiPeriod: profile.rsiPeriod,
        rsiBuy: profile.rsiBuy,
        rsiSell: profile.rsiSell,
        minAdx: profile.minAdx,
      });
      const up = new Set(["CALL", "HIGHER", "CALLE", "ASIANU", "RESETCALL"]).has(plan.type);
      const go = up ? dir.fastUp : dir.fastDown;
      if (!go) {
        const why = up ? "The rise rule is not met yet." : "The fall rule is not met yet.";
        return stand(plan, profile.rsiBuy > 0 || profile.rsiSell < 100 || profile.minAdx > 0 ? `${why} Check the RSI and trend settings for this contract.` : why);
      }
      if (Math.abs(dir.score) < profile.minScore) {
        return stand(plan, "Signal score is under this strategy's minimum.");
      }
    }
  }
  if (input.modules && plan.family === "digit" && (plan.status === "pricing" || plan.status === "warming")) {
    if (activeEntryModules("digit", plan.type, input.modules).length === 0) {
      return applyContractEngine(plan, input, profile);
    }
  }
  if (input.modules) {
    const decision = approvedEntry(plan.family, plan.type, input.quotes, input.modules, input.pipSize, plan.request?.barrier ?? "", {
      minEffective: profile.minEffective,
      z: profile.intervalZ,
      persist: profile.walkForward,
      stake: input.stake,
      payout: null,
    });
    if (!decision.ok) {
      if (plan.status === "pricing" || plan.status === "warming") {
        const row = stand(plan, decision.reason);
        row.modules = decision.agreed;
        row.rationale = [...plan.rationale, ...decision.readings.map((row) => `${row.name}: ${row.reason}`)];
        return row;
      }
      return plan;
    }
    if (!plan.request) {
      const dur = chooseDuration(offered, profile.duration, profile.durationUnit);
      plan.request = { contract_type: plan.type, duration: dur.n, duration_unit: dur.unit };
      plan.status = "pricing";
    }
    plan.modules = decision.agreed;
    plan.note = decision.reason;
    plan.rationale = [...plan.rationale, ...decision.readings.map((row) => `${row.name}: ${row.reason} Score ${row.confidence.toFixed(2)} is not a win probability.`)];
  }
  return plan;
}

function stand(plan: Plan, note: string): Plan {
  return { ...plan, status: "stand-aside", note, request: undefined };
}

/** The six digit contracts judge themselves when no optional module is turned on for that contract. */
function applyContractEngine(plan: Plan, input: BookInput, profile: StrategyProfile): Plan {
  const need = Math.max(20, profile.minSample);
  if (input.quotes.length < need) {
    const row = stand(
      plan,
      `WAIT. ${plan.name} has ${input.quotes.length} ticks. Need ${need} before this contract can be judged. No probability was invented.`,
    );
    row.diagnostics = [...plan.diagnostics, { label: "Sample", value: `${input.quotes.length}/${need}` }];
    return row;
  }
  const report = runDigitEngine({
    contract: plan.type,
    quotes: input.quotes,
    pip: input.pipSize,
    barrier: plan.request?.barrier ?? "",
    minSample: need,
    minConfidence: 0.5,
    strategy: plan.name,
    lookback: Math.max(20, profile.shortWindow),
    minEffective: profile.minEffective,
    z: profile.intervalZ,
    persist: profile.walkForward,
    stake: input.stake,
    payout: null,
  });
  const diagnostics = [
    ...plan.diagnostics,
    { label: "Sample", value: String(report.sample) },
    { label: "Effective", value: String(Math.round(report.nEff)) },
    { label: "Interval", value: `${(report.lo * 100).toFixed(1)}% – ${(report.hi * 100).toFixed(1)}%` },
  ];
  if (report.status !== "yes") {
    const row = stand(plan, report.reason);
    row.diagnostics = diagnostics;
    row.pModel = report.estimated;
    row.pCons = report.lo;
    return row;
  }
  plan.status = "pricing";
  plan.note = report.reason;
  plan.pModel = report.estimated;
  plan.pCons = report.lo;
  plan.diagnostics = diagnostics;
  plan.rationale = [...plan.rationale, report.reason];
  return plan;
}

function closest(values: number[], target: number): number | null {
  if (values.length === 0 || !(target > 0)) return null;
  return [...values].sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0] ?? null;
}

function planOne(meta: ContractMeta, f: Features, offered: Offered | undefined, input: BookInput): Plan {
  if (meta.family === "digit") return planDigit(meta, f, input, offered);
  if (f.warmingTrend || f.last == null || !(f.sigma > 0)) {
    return base(input.symbol, meta, "warming", `Need 80 ticks with movement. Have ${f.sample}.`, f);
  }
  if (meta.family === "directional") return planRiseFall(meta, f, offered);
  if (meta.family === "barrier" || meta.family === "vanilla") return planBarrier(meta, f, offered);
  if (meta.family === "touch" || meta.family === "turbo") return planTouch(meta, f, offered);
  if (meta.family === "range") return planRange(meta, f, offered);
  if (meta.family === "asian" || meta.family === "reset") return planSoftTrend(meta, f, offered);
  if (meta.family === "ticks" || meta.family === "run") return planPath(meta, f, offered);
  if (meta.family === "multiplier") return planMultiplier(meta, f, offered, input.stake);
  if (meta.family === "accumulator") return planAccu(meta, f, offered, input.stake);
  if (meta.family === "lookback") return planLookback(meta, f, offered);
  return base(input.symbol, meta, "stand-aside", "No execution model for this contract.", f);
}

function planDigit(meta: ContractMeta, f: Features, input: BookInput, offered: Offered | undefined): Plan {
  const choices = digitChoices(meta.type);
  const listed = offered?.last_digit_range?.filter((n) => Number.isInteger(n));
  const allowed = choices == null ? null : listed?.length ? choices.filter((n) => listed.includes(n)) : choices;
  const profile = input.profiles?.[meta.type] ?? defaultProfile(meta.type);
  const prior = input.prior ?? 200;
  const z = input.z ?? 1.96;
  const digits = f.quotes.map((quote) => lastDigit(quote, input.pipSize)).slice(-profile.longWindow);
  let barrier = "";
  let autoNote = "";
  if (meta.type === "DIGITMATCH" || meta.type === "DIGITDIFF") {
    if (input.digit == null || !allowed?.includes(input.digit)) {
      return base(input.symbol, meta, "stand-aside", "Pick a digit from 0 to 9. Matches and Differs will not trade until you do.", f);
    }
    barrier = String(input.digit);
  } else if (allowed) {
    const picked = input.digit != null && allowed.includes(input.digit) ? input.digit : null;
    const savedNum = Number(profile.barrier);
    const saved = profile.barrier.trim() !== "" && Number.isInteger(savedNum) && allowed.includes(savedNum) ? savedNum : null;
    if (picked != null) barrier = String(picked);
    else if (saved != null) barrier = String(saved);
    else if (profile.autoBarrier) {
      const selection = selectAutoBarrier({
        digits,
        type: meta.type,
        allowed,
        prior,
        z: profile.intervalZ || z,
        train: profile.trainSize,
        validation: profile.validationSize,
        final: profile.finalSize,
        periods: profile.validationPeriods,
        minOos: profile.minOos,
      });
      if (!selection.supported || selection.barrier == null) {
        return base(input.symbol, meta, "stand-aside", selection.reason, f);
      }
      barrier = String(selection.barrier);
      autoNote = selection.reason;
    } else {
      return base(input.symbol, meta, "stand-aside", "SELECT A BARRIER. Auto barrier selection is off, so Over and Under will not invent a digit.", f);
    }
  }
  const fair = fairDigit(meta.type, barrier);
  if (fair == null || !(fair > 0) || !(fair < 1)) {
    return base(input.symbol, meta, "stand-aside", "That barrier has no tradable baseline, so no proposal was sent.", f);
  }
  const dur = chooseDuration(offered, 1, "t");
  const plan = base(input.symbol, meta, "pricing", autoNote || "Fast digit entry. The barrier is the one you selected. Expected value is not a gate.", f);
  plan.pModel = fair;
  plan.pCons = fair;
  plan.request = {
    contract_type: meta.type,
    duration: dur.n,
    duration_unit: dur.unit,
    ...(barrier ? { barrier } : {}),
  };
  plan.rationale = [
    barrier ? `Barrier ${barrier}.` : "Even or odd, no barrier.",
    autoNote ? "Auto barrier selection used training ticks only. Validation and the final period were not used to choose it, and a failed barrier was not replaced." : "The selected barrier is not rotated into another contract.",
    "Buys on the next quote. Expected value is not a gate.",
  ];
  return plan;
}

function planRiseFall(meta: ContractMeta, f: Features, offered: Offered | undefined): Plan {
  const up = meta.type === "CALL";
  const go = up ? f.dir.fastUp : f.dir.fastDown;
  if (!go) {
    return base(f.symbol, meta, "stand-aside", up ? "Rise waits for price above a rising EMA 9." : "Fall waits for price below a falling EMA 9.", f);
  }
  const { pModel, pCons } = trendProb(f.dir.score, up, 0.08);
  const dur = chooseDuration(offered, 5, "t");
  const plan = priced(f, meta, pModel, pCons, "Fast entry: EMA 9 leads EMA 21 and price is on that side.");
  plan.request = { contract_type: meta.type, duration: dur.n, duration_unit: dur.unit };
  return plan;
}

function planBarrier(meta: ContractMeta, f: Features, offered: Offered | undefined): Plan {
  const up = meta.type === "HIGHER" || meta.type === "CALLE" || meta.type === "VANILLALONGCALL";
  const go = up ? f.dir.fastUp : f.dir.fastDown;
  if (!go || f.last == null) {
    return base(f.symbol, meta, "stand-aside", "Barrier contract waits for the fast EMA.", f);
  }
  const steps = meta.family === "vanilla" ? 30 : 5;
  const unit = meta.family === "vanilla" ? "m" : "t";
  const dur = chooseDuration(offered, steps, unit);
  const stepCount = dur.unit === "t" ? dur.n : Math.max(10, dur.n * 20);
  const offset = Math.max(f.sigma * (meta.family === "vanilla" ? 1.2 : 2), tickSize(f.places));
  const z = offset / (f.sigma * Math.sqrt(stepCount));
  const pTerm = up ? 1 - normalCdf(z) : normalCdf(-z);
  const hair = clamp(pTerm * 0.8, 0.02, 0.85);
  const { pCons: shrunk } = trendProb(f.dir.score, up, 0.06);
  const pCons = Math.min(hair, shrunk);
  const equalTick = (meta.type === "CALLE" || meta.type === "PUTE") && dur.unit === "t";
  const computed = formatBarrier(up ? offset : -offset, f.places);
  const plan = priced(f, meta, pTerm, pCons, "Barrier set from tick sigma. Both the trend cap and the haircut must clear.");
  plan.request = {
    contract_type: meta.type,
    duration: dur.n,
    duration_unit: dur.unit,
  };
  if (!equalTick) {
    plan.request.barrier = meta.family === "vanilla" ? vanillaBarrier(offered, computed) : computed;
  }
  plan.diagnostics.push({ label: "Barrier", value: plan.request.barrier ?? "At spot" });
  return plan;
}

function planTouch(meta: ContractMeta, f: Features, offered: Offered | undefined): Plan {
  if (f.last == null) return base(f.symbol, meta, "warming", "No spot yet.", f);
  const dur = chooseDuration(offered, 5, "m");
  const steps = dur.unit === "t" ? dur.n : dur.unit === "s" ? Math.max(5, dur.n) : dur.n * 30;
  const distance = Math.max(f.sigma * Math.sqrt(steps) * 0.8, tickSize(f.places) * 4);
  const pTouch = touchProbability(distance, f.sigma, steps);
  const isTouch = meta.type === "ONETOUCH" || meta.type === "TURBOSLONG" || meta.type === "TURBOSSHORT";
  const up = meta.type !== "TURBOSSHORT";
  let pModel: number;
  let pCons: number;
  if (meta.type === "NOTOUCH") {
    pModel = 1 - pTouch;
    pCons = clamp(1 - Math.min(1, pTouch / 0.75), 0.02, 0.95);
  } else if (isTouch) {
    pModel = pTouch;
    pCons = clamp(pTouch * 0.75, 0.02, 0.9);
  } else {
    pModel = pTouch;
    pCons = clamp(pTouch * 0.75, 0.02, 0.9);
  }
  const plan = priced(f, meta, pModel, pCons, "Distance, volatility and time. Directional indicators are not used.");
  plan.request = {
    contract_type: meta.type,
    duration: dur.n,
    duration_unit: dur.unit,
    barrier: turboBarrier(meta.type, offered, f.places) ?? formatBarrier(up ? distance : -distance, f.places),
  };
  return plan;
}

function planRange(meta: ContractMeta, f: Features, offered: Offered | undefined): Plan {
  const dur = chooseDuration(offered, meta.type === "RANGE" || meta.type === "UPORDOWN" ? 5 : 10, "t");
  const steps = dur.unit === "t" ? dur.n : dur.n * 20;
  const half = 0.674 * f.sigma * Math.sqrt(Math.max(1, steps));
  const inside = terminalBetween(-half, half, f.sigma, steps);
  const outsideFamily = meta.type === "EXPIRYMISS" || meta.type === "EXPIRYMISSE" || meta.type === "UPORDOWN";
  const path = meta.type === "RANGE" || meta.type === "UPORDOWN";
  const pModel = outsideFamily ? 1 - inside : inside;
  const pCons = outsideFamily
    ? clamp(1 - Math.min(1, inside / 0.75), 0.02, 0.95)
    : clamp(inside * (path ? 0.65 : 0.8), 0.02, 0.9);
  const plan = priced(
    f,
    meta,
    pModel,
    pCons,
    path ? "Path band is discounted harder than an expiry band." : "Band is about a 50% terminal range before the haircut.",
  );
  plan.request = {
    contract_type: meta.type,
    duration: dur.n,
    duration_unit: dur.unit,
    barrier: formatBarrier(half, f.places),
    barrier2: formatBarrier(-half, f.places),
  };
  return plan;
}

function planSoftTrend(meta: ContractMeta, f: Features, offered: Offered | undefined): Plan {
  const up = meta.type === "ASIANU" || meta.type === "RESETCALL";
  const go = up ? f.dir.fastUp : f.dir.fastDown;
  if (!go) return base(f.symbol, meta, "stand-aside", "This contract waits for the fast EMA.", f);
  const scale = meta.family === "reset" ? 0.05 : 0.06;
  const { pModel, pCons } = trendProb(f.dir.score * 0.8, up, scale);
  const dur = chooseDuration(offered, meta.family === "asian" ? 5 : 5, "t");
  const plan = priced(f, meta, pModel, pCons, "Damped trend score. Still shrunk toward 50%.");
  plan.request = { contract_type: meta.type, duration: dur.n, duration_unit: dur.unit };
  return plan;
}

function planPath(meta: ContractMeta, f: Features, offered: Offered | undefined): Plan {
  const dur = chooseDuration(offered, 5, "t");
  const n = dur.n;
  const nullP = meta.family === "run" ? 0.85 * 0.5 ** n : 1 / n;
  const boot = meta.family === "run" ? null : bootstrapPath(f.quotes, n, meta.type);
  const pCons = boot == null ? nullP : Math.min(nullP, 0.75 * nullP + 0.25 * boot);
  const plan = priced(
    f,
    meta,
    nullP,
    pCons,
    meta.family === "run"
      ? "Successive-run probability starts at a discounted coin-flip and is never raised by the tape."
      : "Capped at the uniform null. The bootstrap can only make this smaller.",
  );
  plan.request = {
    contract_type: meta.type,
    duration: n,
    duration_unit: "t",
    ...(meta.family === "ticks" ? { selected_tick: 1 } : {}),
  };
  return plan;
}

function planMultiplier(meta: ContractMeta, f: Features, offered: Offered | undefined, stake: number): Plan {
  const up = meta.type === "MULTUP";
  if (!(up ? f.dir.fastUp : f.dir.fastDown)) {
    return base(f.symbol, meta, "stand-aside", "Multiplier waits for the fast EMA.", f);
  }
  const range = offered?.multiplier_range?.filter((n) => n > 0).sort((a, b) => a - b) ?? [];
  if (range.length === 0) {
    return base(f.symbol, meta, "unavailable", "This symbol did not list a multiplier.", f);
  }
  const multiplier = range[0];
  const exposure = stake * multiplier;
  const { pCons } = trendProb(f.dir.score, up, 0.05);
  // A multiplier that only returns stake on a stop equal to stake has no proven positive edge
  // from the trend score alone. Leave EV to the quote. pCons stays below the level that
  // would invent a payout.
  const plan = priced(
    f,
    meta,
    pCons,
    Math.min(pCons, 0.5),
    "Smallest multiplier, stop at the stake. Conservative probability is held at or under 50% so a missing payout cannot look like an edge.",
  );
  plan.request = {
    contract_type: meta.type,
    multiplier,
    limit_order: { stop_loss: Math.max(0.35, stake) },
  };
  plan.diagnostics.push({ label: "Exposure", value: exposure.toFixed(2) });
  plan.diagnostics.push({ label: "Multiplier", value: String(multiplier) });
  return plan;
}

function planAccu(meta: ContractMeta, f: Features, offered: Offered | undefined, stake: number): Plan {
  const growth = offered?.growth_rate_range?.[0] ?? 0.01;
  const frac = offered?.growth_rate_barrier_offsets?.[0] ?? 0.0006;
  const spot = f.last ?? 0;
  const distance = Math.max(spot * frac, tickSize(f.places));
  const pStep = f.sigma > 0 ? clamp(2 * normalCdf(distance / f.sigma) - 1, 0, 1) : 0;
  const horizon = 8;
  const pSurvive = clamp((pStep ** horizon) * 0.5, 0, 0.95);
  const gain = stake * ((1 + growth) ** horizon - 1);
  const ev = pSurvive * gain - (1 - pSurvive) * stake;
  const plan = base(
    f.symbol,
    meta,
    "pricing",
    ev > 0 ? "Growth model is positive after the survival haircut." : "Growth model is negative after the survival haircut.",
    f,
  );
  plan.pModel = pSurvive / 0.5;
  plan.pCons = pSurvive;
  plan.modelEv = ev;
  plan.request = { contract_type: meta.type, growth_rate: growth };
  plan.rationale = [
    `Growth ${(growth * 100).toFixed(1)}% , horizon ${horizon} ticks.`,
    `Conservative survival ${pct(pSurvive)}.`,
    `Model EV ${ev.toFixed(3)} before the live quote check.`,
  ];
  plan.diagnostics.push({ label: "Model EV", value: ev.toFixed(3) });
  return plan;
}

function planLookback(meta: ContractMeta, f: Features, offered: Offered | undefined): Plan {
  const plan = base(
    f.symbol,
    meta,
    offered ? "pricing" : "unavailable",
    "Priced only to read the contract. A buy still needs a fixed payout and positive conservative EV.",
    f,
  );
  if (!offered) return plan;
  plan.pModel = null;
  plan.pCons = null;
  plan.request = { contract_type: meta.type, duration: 5, duration_unit: "t" };
  return plan;
}

export function settleEv(
  plan: Plan,
  payout: number,
  stake: number,
): { ev: number | null; edge: number | null; reason: string } {
  if (!(payout > 0) || !(stake > 0)) {
    return { ev: null, edge: null, reason: "Quote has no fixed payout, so expected value cannot be signed off." };
  }
  if (plan.pCons == null) {
    return { ev: null, edge: null, reason: "No conservative probability for this contract." };
  }
  const ev = expectedValue(plan.pCons, payout, stake);
  return {
    ev,
    edge: ev / stake,
    reason: ev > 0 ? "Conservative expected value is positive." : "Conservative expected value is negative.",
  };
}

function trendProb(score: number, up: boolean, scale: number): { pModel: number; pCons: number } {
  const signed = up ? score : -score;
  const pModel = clamp(0.5 + scale * Math.max(0, signed), 0.5, 0.58);
  const pCons = 0.5 + 0.5 * (pModel - 0.5);
  return { pModel, pCons };
}

function withShared(preferred: Offered | undefined, rows: Offered[]): Offered | undefined {
  if (!preferred) return undefined;
  const choices = rows.flatMap((row) => row.barrier_choices ?? []);
  return {
    ...preferred,
    barrier_choices: preferred.barrier_choices?.length ? preferred.barrier_choices : choices,
    last_digit_range: preferred.last_digit_range ?? rows.find((row) => row.last_digit_range?.length)?.last_digit_range,
    multiplier_range: preferred.multiplier_range ?? rows.find((row) => row.multiplier_range?.length)?.multiplier_range,
    growth_rate_range: preferred.growth_rate_range ?? rows.find((row) => row.growth_rate_range?.length)?.growth_rate_range,
    barrier: preferred.barrier ?? rows.find((row) => row.barrier)?.barrier,
  };
}

function preferShorter(offers: Offered[]): Offered | undefined {
  if (offers.length === 0) return undefined;
  return [...offers].sort((a, b) => durationRank(a.min_contract_duration) - durationRank(b.min_contract_duration))[0];
}

function durationRank(raw?: string): number {
  const parsed = parseDur(raw);
  if (!parsed) return 9_000;
  const unit = { t: 0, s: 1, m: 2, h: 3, d: 4 }[parsed.unit];
  return unit * 1_000 + parsed.n;
}

function vanillaBarrier(offered: Offered | undefined, fallback: string): string {
  const choices = (offered?.barrier_choices ?? []).map(String).filter(Boolean);
  if (choices.length) return choices[Math.floor(choices.length / 2)];
  if (offered?.barrier) return String(offered.barrier);
  return fallback;
}

function turboBarrier(type: string, offered: Offered | undefined, places: number): string | null {
  if (type !== "TURBOSLONG" && type !== "TURBOSSHORT") return null;
  const raw = offered?.barrier_choices?.[0] ?? offered?.barrier;
  const mag = Math.abs(Number(String(raw ?? "").replace(/^\+/, "")));
  if (!(mag > 0)) return null;
  return formatBarrier(type === "TURBOSLONG" ? -mag : mag, Math.min(Math.max(places, 0), 2));
}

/** Turn a Deriv rejection into one corrected proposal. Returns null when nothing safe can change. */
export function adaptQuote(request: PriceRequest, message: string): PriceRequest | null {
  const accepts = /Accepts\s+([\d,\s]+)/i.exec(message);
  if (accepts) {
    const multiplier = Number(accepts[1].split(/[,\s]+/)[0]);
    if (multiplier > 0 && multiplier !== request.multiplier) return { ...request, multiplier };
  }
  const listed = message.split(/Barriers available are\s+/i)[1];
  if (listed) {
    const list = listed.match(/[+-]?\d+(?:\.\d+)?/g) ?? [];
    const neg = request.contract_type === "TURBOSLONG" || (request.barrier ?? "").startsWith("-");
    const pick = list.find((barrier) => (neg ? barrier.startsWith("-") : barrier.startsWith("+"))) ?? list[0];
    if (pick && pick !== request.barrier) return { ...request, barrier: pick };
  }
  const places = /more than\s+(\d+(?:\.\d+)?)\s+decimal/i.exec(message);
  if (places && request.barrier) {
    const n = Number(request.barrier);
    const p = Math.max(0, Math.floor(Number(places[1])));
    if (Number.isFinite(n)) {
      const barrier = `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(p)}`;
      if (barrier !== request.barrier) return { ...request, barrier };
    }
  }
  const digit = /range of\s+(\d+)\s+to\s+(\d+)/i.exec(message);
  if (digit && request.barrier) {
    const lo = Number(digit[1]);
    const hi = Number(digit[2]);
    const barrier = String(Math.min(hi, Math.max(lo, Math.round(Number(request.barrier)))));
    if (barrier !== request.barrier) return { ...request, barrier };
  }
  if (/high barrier must be higher/i.test(message) && request.barrier && request.barrier2) {
    return { ...request, barrier: request.barrier2, barrier2: request.barrier };
  }
  if (/invalid barrier|non atm barrier/i.test(message) && request.barrier) {
    const drop = ["CALLE", "PUTE", "RESETCALL", "RESETPUT", "RUNHIGH", "RUNLOW", "CALL", "PUT"].includes(request.contract_type);
    if (drop) {
      const next = { ...request };
      delete next.barrier;
      return next;
    }
  }
  if (/selected tick/i.test(message) && request.selected_tick == null) {
    return { ...request, selected_tick: 1 };
  }
  return null;
}

function chooseDuration(
  offered: Offered | undefined,
  preferN: number,
  preferU: "t" | "s" | "m" | "h" | "d",
): { n: number; unit: "t" | "s" | "m" | "h" | "d" } {
  const min = parseDur(offered?.min_contract_duration);
  const max = parseDur(offered?.max_contract_duration);
  if (min && max && min.unit === max.unit) {
    if (min.unit === preferU) {
      return { n: Math.min(max.n, Math.max(min.n, preferN)), unit: preferU };
    }
    return { n: min.n, unit: min.unit };
  }
  if (min && min.unit === preferU) {
    const cap = max && max.unit === preferU ? max.n : preferN;
    return { n: Math.min(cap, Math.max(min.n, preferN)), unit: preferU };
  }
  if (min) return min;
  return { n: preferN, unit: preferU };
}

function parseDur(raw?: string): { n: number; unit: "t" | "s" | "m" | "h" | "d" } | null {
  if (!raw) return null;
  const m = /^(\d+)([tsmhd])$/.exec(raw);
  if (!m) return null;
  return { n: Number(m[1]), unit: m[2] as "t" | "s" | "m" | "h" | "d" };
}

function bootstrapPath(quotes: number[], steps: number, type: string): number | null {
  const deltas = tickDeltas(quotes);
  if (deltas.length < 40 || steps < 2) return null;
  const sims = 160;
  let wins = 0;
  const start = quotes[quotes.length - 1];
  for (let s = 0; s < sims; s++) {
    const path = [start];
    for (let k = 0; k < steps; k++) {
      path.push(path[path.length - 1] + deltas[Math.floor(Math.random() * deltas.length)]);
    }
    const body = path.slice(1);
    if (type === "TICKHIGH" || type === "RUNHIGH") {
      const extreme = Math.max(...body);
      if (type === "TICKHIGH" ? body[0] === extreme : body.every((v, i) => i === 0 || v >= body[i - 1])) {
        wins += 1;
      }
    } else if (type === "TICKLOW" || type === "RUNLOW") {
      const extreme = Math.min(...body);
      if (type === "TICKLOW" ? body[0] === extreme : body.every((v, i) => i === 0 || v <= body[i - 1])) {
        wins += 1;
      }
    }
  }
  return wins / sims;
}

function tickSize(places: number): number {
  return 10 ** -places;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function base(symbol: string, meta: ContractMeta, status: Plan["status"], note: string, f: Features): Plan {
  return {
    symbol,
    type: meta.type,
    name: meta.name,
    family: meta.family,
    summary: meta.summary,
    status,
    note,
    rationale: [],
    pModel: null,
    pCons: null,
    modelEv: null,
    diagnostics: [
      { label: "Ticks", value: String(f.sample) },
      { label: "Sigma", value: f.sigma ? f.sigma.toFixed(f.places) : "—" },
      { label: "Score", value: f.dir.score.toFixed(2) },
    ],
  };
}

function priced(f: Features, meta: ContractMeta, pModel: number, pCons: number, note: string): Plan {
  const plan = base(f.symbol, meta, "pricing", note, f);
  plan.pModel = pModel;
  plan.pCons = pCons;
  plan.rationale = [
    `Model ${pct(pModel)}, conservative ${pct(pCons)}.`,
    `EMA/MACD/RSI/ADX score ${f.dir.score.toFixed(2)}.`,
    note,
  ];
  if (f.dir.rsi != null) plan.diagnostics.push({ label: "RSI", value: f.dir.rsi.toFixed(1) });
  if (f.dir.adx != null) plan.diagnostics.push({ label: "ADX", value: f.dir.adx.toFixed(1) });
  return plan;
}
