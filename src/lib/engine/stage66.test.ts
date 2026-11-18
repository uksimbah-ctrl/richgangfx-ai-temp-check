import assert from "node:assert/strict";
import test from "node:test";
import { decideQuotePurchase } from "../desk/quote-exec.ts";
import { DEPENDENCE_LIMIT, effectiveSample, wilsonInterval } from "./digit-stats.ts";
import {
  digitQuoteBreakdown,
  evidenceHeadline,
  evidencePlan,
  heldOutInterval,
  NO_VERIFIED_EDGE,
  NO_VERIFIED_OOS,
  RESEARCH_Z,
  runDigitEngine,
  selectAutoBarrier,
} from "./digit-engines.ts";
import { adjustedZ, digitWins, fairDigit } from "./math.ts";
import { confidenceLabel, defaultProfile, mergeProfile } from "./profiles.ts";
import { DEFAULT_RISK } from "./risk.ts";

const CONTRACTS = ["DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"] as const;

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function digitsFrom(count: number, seed: number, kind: string): number[] {
  const next = lcg(seed);
  if (kind === "uniform") return Array.from({ length: count }, () => Math.floor(next() * 10));
  if (kind === "sticky") {
    const out = [Math.floor(next() * 10)];
    for (let index = 1; index < count; index += 1) out.push(next() < 0.85 ? out[index - 1] : Math.floor(next() * 10));
    return out;
  }
  if (kind === "alternating") return Array.from({ length: count }, (_, index) => (index % 2 === 0 ? 0 : 1));
  if (kind === "runs") {
    const out: number[] = [];
    let digit = Math.floor(next() * 10);
    while (out.length < count) {
      const length = 8 + Math.floor(next() * 16);
      for (let index = 0; index < length && out.length < count; index += 1) out.push(digit);
      digit = Math.floor(next() * 10);
    }
    return out;
  }
  if (kind === "shift") return Array.from({ length: count }, (_, index) => (index < count / 2 ? index % 2 : (index % 2) + 1));
  return Array.from({ length: count }, (_, index) => (index < count / 2 ? Math.floor(next() * 5) : 5 + Math.floor(next() * 5)));
}

function allowedFor(contract: string): number[] {
  if (contract === "DIGITOVER") return [0, 1, 2, 3, 4, 5, 6, 7, 8];
  if (contract === "DIGITUNDER") return [1, 2, 3, 4, 5, 6, 7, 8, 9];
  if (contract === "DIGITMATCH" || contract === "DIGITDIFF") return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  return [0];
}

function prices(digits: number[]): number[] {
  return digits.map((digit, index) => Number((100 + index * 0.1 + digit / 100).toFixed(2)));
}

test("held-out intervals use the effective sample and do not treat a streak as independent proof", () => {
  const stuck = Array.from({ length: 160 }, () => true);
  const held = heldOutInterval(stuck, 40, RESEARCH_Z, 1);
  const raw = wilsonInterval(held.hits, held.trials, RESEARCH_Z);
  assert.ok(held.trials >= 40);
  assert.equal(held.nEff, 1);
  assert.ok(held.nEff < held.trials);
  assert.equal(held.sufficient, false);
  assert.equal(held.lo, 0);
  assert.ok(raw.lo > 0.8);
  const moving = heldOutInterval(stuck, 40, RESEARCH_Z, 5);
  assert.equal(moving.nEff, moving.trials);
  assert.ok(moving.nEff <= moving.trials);
  assert.equal(moving.sufficient, true);
  const clump = effectiveSample(Array.from({ length: 120 }, (_, index) => Math.floor(index / 8) % 2 === 0));
  assert.ok(clump.rho > 0);
  assert.ok(clump.nEff < clump.n * 0.5);
  assert.ok(clump.nEff >= 1);
  const alternating = effectiveSample(Array.from({ length: 80 }, (_, index) => index % 2 === 0));
  assert.ok(alternating.rho <= 0);
  assert.equal(alternating.nEff, alternating.n);
  const seasonal = effectiveSample(Array.from({ length: 120 }, (_, index) => index % 5 === 0));
  assert.ok(seasonal.rho <= 0);
  assert.equal(seasonal.nEff, seasonal.n);
  assert.match(DEPENDENCE_LIMIT, /does not remove all dependence/);
  assert.match(DEPENDENCE_LIMIT, /never exceeds the raw count/);
});

test("one favourable final period is not support, and final ticks do not choose the barrier", () => {
  const size = evidencePlan({});
  const injected = (count: number) =>
    Array.from({ length: count }, (_, index) => (index % 2 === 0 ? 7 : (index % 10 === 7 ? 8 : index % 10)));
  const trainVal = injected(size.train + size.validation);
  const fair = Array.from({ length: size.final }, (_, index) => index % 10);
  const hot = Array.from({ length: size.final }, () => 7);
  const planted = [...trainVal, ...fair, ...fair, ...hot];
  const untouched = [...trainVal, ...fair, ...fair, ...fair];
  const args = {
    type: "DIGITMATCH" as const,
    allowed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    prior: 20,
    z: RESEARCH_Z,
    ...size,
  };
  const found = selectAutoBarrier({ digits: planted, ...args });
  const masked = selectAutoBarrier({ digits: untouched, ...args });
  assert.equal(found.barrier, masked.barrier);
  assert.equal(found.supported, false);
  assert.match(found.reason, /was not replaced|did not qualify|No other barrier was substituted/);
  assert.match(found.reason, new RegExp(NO_VERIFIED_OOS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(found.validationEnd <= found.finalStart);
});

test("a searched barrier uses a stricter interval than one pre-specified contract", () => {
  const size = evidencePlan({});
  const digits = Array.from({ length: size.train + size.validation + size.final * size.periods }, (_, index) => (index % 5 === 0 ? 7 : (index + 3) % 10));
  const narrow = selectAutoBarrier({
    digits,
    type: "DIGITMATCH",
    allowed: [7],
    prior: 20,
    z: RESEARCH_Z,
    ...size,
  });
  const wide = selectAutoBarrier({
    digits,
    type: "DIGITMATCH",
    allowed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    prior: 20,
    z: RESEARCH_Z,
    ...size,
  });
  assert.ok(adjustedZ(RESEARCH_Z, 10) > adjustedZ(RESEARCH_Z, 1));
  assert.match(narrow.reason, /pre-specified/);
  assert.match(wide.reason, /stricter/);
  assert.match(wide.reason, /10 barriers/);
  assert.ok(wide.reason.includes(adjustedZ(RESEARCH_Z, 10).toFixed(2)));
});

test("fair, sticky, alternating, repeating, and shifting series do not routinely produce a supported edge", () => {
  const size = evidencePlan({});
  const total = size.train + size.validation + size.final * size.periods;
  const kinds = ["uniform", "sticky", "runs", "shift", "nonstationary"];
  const seeds = Array.from({ length: 20 }, (_, index) => index + 1);
  let simulations = 0;
  let discoveries = 0;
  for (const kind of kinds) {
    for (const seed of seeds) {
      const digits = digitsFrom(total, seed + kind.length * 100, kind);
      for (const contract of CONTRACTS) {
        const found = selectAutoBarrier({
          digits,
          type: contract,
          allowed: allowedFor(contract),
          prior: 20,
          z: RESEARCH_Z,
          ...size,
        });
        simulations += 1;
        if (found.supported) discoveries += 1;
      }
    }
  }
  const span = wilsonInterval(discoveries, simulations, RESEARCH_Z);
  assert.equal(
    discoveries,
    0,
    `${discoveries} supported results in ${simulations} null simulations. Wilson 95% interval ${(span.lo * 100).toFixed(2)}% to ${(span.hi * 100).toFixed(2)}%.`,
  );
  assert.ok(span.hi < 0.02);
  assert.ok(simulations >= 600);
  const alternating = Array.from({ length: total }, (_, index) => (index % 2 === 0 ? 0 : 1));
  const matched = selectAutoBarrier({
    digits: alternating,
    type: "DIGITMATCH",
    allowed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    prior: 20,
    z: RESEARCH_Z,
    ...size,
  });
  const even = selectAutoBarrier({
    digits: alternating,
    type: "DIGITEVEN",
    allowed: [0],
    prior: 20,
    z: RESEARCH_Z,
    ...size,
  });
  assert.equal(matched.barrier, 0);
  assert.equal(matched.supported, true);
  assert.equal(even.supported, false);
  assert.match(matched.reason, /not proof of future profitability/);
});

test("the displayed confidence, a saved contract, and the six payout baselines stay where they were set", () => {
  const fresh = defaultProfile("DIGITOVER");
  assert.equal(fresh.intervalZ, RESEARCH_Z);
  assert.equal(confidenceLabel(fresh.intervalZ), "95% — default for a new contract");
  assert.equal(fresh.stake, 1);
  assert.equal(fresh.duration, 1);
  assert.equal(fresh.autoBarrier, false);
  const kept = mergeProfile(fresh, { intervalZ: 1.64, stake: 2, barrier: "4", duration: 5 });
  assert.equal(kept.intervalZ, 1.64);
  assert.equal(kept.stake, 2);
  assert.equal(kept.barrier, "4");
  assert.equal(kept.duration, 5);
  assert.equal(defaultProfile("DIGITOVER").stake, 1);
  assert.equal(defaultProfile("DIGITOVER").intervalZ, 1.96);
  const report = runDigitEngine({
    contract: "DIGITEVEN",
    quotes: prices(Array.from({ length: 240 }, (_, index) => (index % 5 === 0 ? 1 : [0, 2, 4, 6, 8][index % 5]))),
    pip: 2,
    barrier: "",
    minSample: 40,
    minConfidence: 0,
    strategy: "Even",
    persist: false,
  });
  assert.match(report.reason, /95% — default for a new contract/);
  assert.match(report.reason, /z 1\.96/);
  assert.match(report.reason, /Held-out raw/);
  assert.match(report.reason, /Held-out effective/);
  for (const contract of CONTRACTS) {
    const barrier = contract === "DIGITOVER" ? "4" : contract === "DIGITUNDER" ? "5" : contract === "DIGITEVEN" || contract === "DIGITODD" ? "" : "7";
    assert.equal(typeof fairDigit(contract, barrier), "number");
    assert.equal(typeof digitWins(contract, barrier || "0", 7), "boolean");
  }
  const quote = digitQuoteBreakdown({ ask: 1, payout: 1.05, probability: 0.95, contract: "DIGITDIFF" });
  assert.equal(quote.loss, 1);
  assert.ok((quote.expectedReturn ?? 0) < 0);
  const skipped = decideQuotePurchase({
    source: "public",
    intent: "preview",
    streaming: false,
    proposalId: "p",
    blockers: [],
    mode: "scanner",
    alreadyPurchased: false,
  });
  assert.equal(skipped.action, "skip");
  assert.equal(DEFAULT_RISK.martingale, false);
});

test("a mild differs lean can enter, and a fair sample or a reversed holdout cannot", () => {
  const others = [0, 2, 3, 4, 5, 6, 7, 8, 9];
  const mild = Array.from({ length: 1045 }, (_, index) => (index % 12 === 0 ? 1 : others[index % others.length]));
  const lean = runDigitEngine({
    contract: "DIGITDIFF",
    quotes: prices(mild),
    pip: 2,
    barrier: "1",
    minSample: 40,
    minConfidence: 0.5,
    strategy: "Statistical Probability",
    persist: true,
    z: 1.96,
  });
  assert.equal(lean.fair, 0.9);
  assert.equal(lean.status, "yes");
  assert.match(lean.prior, /contract prior mean is 90\.0%/);
  assert.match(lean.reason, /Qualified for an entry/);
  assert.match(lean.reason, /not a verified edge/);
  assert.equal(lean.reason.includes(NO_VERIFIED_EDGE), false);
  assert.match(evidenceHeadline(lean.reason), /Signal/);

  const fair = runDigitEngine({
    contract: "DIGITDIFF",
    quotes: prices(Array.from({ length: 1045 }, (_, index) => index % 10)),
    pip: 2,
    barrier: "1",
    minSample: 40,
    minConfidence: 0.5,
    strategy: "Statistical Probability",
    persist: true,
    z: 1.96,
  });
  assert.notEqual(fair.status, "yes");

  const flipped = [
    ...Array.from({ length: 700 }, (_, index) => (index % 50 === 0 ? 1 : others[index % others.length])),
    ...Array.from({ length: 300 }, (_, index) => (index % 5 === 0 ? 1 : others[index % others.length])),
  ];
  const reversed = runDigitEngine({
    contract: "DIGITDIFF",
    quotes: prices(flipped),
    pip: 2,
    barrier: "1",
    minSample: 40,
    minConfidence: 0.5,
    strategy: "Statistical Probability",
    persist: true,
    z: 1.96,
  });
  assert.equal(reversed.status, "wait");
  assert.match(reversed.reason, /do not agree|did not keep the same side/);
});
