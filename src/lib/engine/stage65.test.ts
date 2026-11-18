import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBook } from "./analyze.ts";
import { decideQuotePurchase, purchaseStillAuthorized } from "../desk/quote-exec.ts";
import { effectiveSample } from "./digit-stats.ts";
import {
  backtestDigitEngine,
  betaPosterior,
  digitQuoteBreakdown,
  evidencePlan,
  NO_VERIFIED_OOS,
  rankDigitBacktests,
  selectAutoBarrier,
} from "./digit-engines.ts";
import { adjustedZ, digitWins, fairDigit } from "./math.ts";
import { CONFIDENCE_LEVELS, defaultProfile, fieldsFor, validateProfile } from "./profiles.ts";
import { DEFAULT_RISK, tradeGate } from "./risk.ts";

const CONTRACTS = ["DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"] as const;

function prices(digits: number[]): number[] {
  return digits.map((digit, index) => Number((100 + index * 0.1 + digit / 100).toFixed(2)));
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomDigits(count: number, seed: number): number[] {
  const next = lcg(seed);
  return Array.from({ length: count }, () => Math.floor(next() * 10));
}

function stickyDigits(count: number, seed: number): number[] {
  const next = lcg(seed);
  const digits = [Math.floor(next() * 10)];
  for (let index = 1; index < count; index += 1) {
    digits.push(next() < 0.85 ? digits[index - 1] : Math.floor(next() * 10));
  }
  return digits;
}

/** Digit 7 on 9 of every 20 ticks, spaced apart so one streak is not counted many times. The rate is the same in every period. */
function injectedMatch(count: number): number[] {
  const slots = new Set([0, 2, 4, 6, 8, 10, 12, 14, 16]);
  return Array.from({ length: count }, (_, index) => {
    if (slots.has(index % 20)) return 7;
    const other = (index * 3 + 1) % 9;
    return other >= 7 ? other + 1 : other;
  });
}

function plan() {
  return evidencePlan({});
}

test("training chooses the barrier and later ticks cannot change that choice", () => {
  const size = plan();
  const total = size.train + size.validation + size.final * size.periods;
  const flat = Array.from({ length: total }, (_, index) => index % 10);
  const planted = flat.slice();
  for (let index = size.train; index < planted.length; index += 1) planted[index] = 9;
  const first = selectAutoBarrier({
    digits: flat,
    type: "DIGITOVER",
    allowed: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    prior: 20,
    z: 1.96,
    ...size,
  });
  const leaked = selectAutoBarrier({
    digits: planted,
    type: "DIGITOVER",
    allowed: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    prior: 20,
    z: 1.96,
    ...size,
  });
  assert.equal(leaked.barrier, first.barrier);
  assert.equal(leaked.supported, false);
  assert.match(leaked.reason, /No other barrier was substituted|did not qualify/);
  assert.match(leaked.reason, /Training/);
  assert.match(leaked.reason, /Validation/);
  assert.ok(leaked.trainEnd <= leaked.validationStart);
  assert.ok(leaked.validationEnd <= leaked.finalStart);
  assert.match(leaked.reason, new RegExp(NO_VERIFIED_OOS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("an injected match survives untouched data, and fair scans do not", () => {
  const hot = injectedMatch(420);
  const found = selectAutoBarrier({
    digits: hot,
    type: "DIGITMATCH",
    allowed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    prior: 20,
    z: 1.96,
    ...plan(),
  });
  assert.equal(found.barrier, 7);
  assert.equal(found.validated, true);
  assert.equal(found.supported, true);
  assert.match(found.reason, /not proof of future profitability/);
  const row = backtestDigitEngine({
    prices: prices(hot),
    pip: 2,
    contract: "DIGITMATCH",
    barrier: "7",
    stake: 1,
    payout: 8,
    minSample: 40,
    comparisons: 1,
    z: 1.96,
  });
  assert.equal(row.verdict, "supported");
  assert.ok((row.oosTrials ?? 0) >= 40);
  assert.ok((row.oosEv ?? 0) > 0);

  const scanned = [];
  for (let seed = 1; seed <= 6; seed += 1) {
    const fair = randomDigits(420, seed);
    for (const contract of CONTRACTS) {
      const choices = contract === "DIGITOVER" ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : contract === "DIGITUNDER" ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : contract === "DIGITMATCH" || contract === "DIGITDIFF" ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] : [Number.NaN];
      const barriers = contract === "DIGITEVEN" || contract === "DIGITODD" ? [""] : choices.map(String);
      for (const barrier of barriers) {
        scanned.push(
          backtestDigitEngine({
            prices: prices(fair),
            pip: 2,
            contract,
            barrier,
            stake: 1,
            payout: contract === "DIGITMATCH" ? 8 : contract === "DIGITDIFF" ? 1.05 : 1.9,
            minSample: 40,
            comparisons: barriers.length,
            z: 1.96,
          }),
        );
      }
    }
  }
  assert.equal(scanned.filter((row) => row.verdict === "supported").length, 0);
  assert.equal(rankDigitBacktests(scanned.filter((_, index) => index < 30)).best, null);
});

test("effective sample shrinks dependence and does not invent observations", () => {
  const positive = effectiveSample(Array.from({ length: 80 }, (_, index) => index < 40));
  assert.ok(positive.rho > 0);
  assert.ok(positive.nEff < positive.n);
  assert.ok(positive.nEff >= 1);
  const negative = effectiveSample(Array.from({ length: 80 }, (_, index) => index % 2 === 0));
  assert.ok(negative.rho <= 0);
  assert.ok(negative.nEff <= negative.n);
  const streak = effectiveSample(Array.from({ length: 200 }, () => true));
  assert.equal(streak.nEff, 1);
  const full = betaPosterior(40, 80, 10, 10, 1.96);
  const shrunk = betaPosterior((40 / 80) * positive.nEff, positive.nEff, 10, 10, 1.96);
  assert.ok(shrunk.lo <= shrunk.mean && shrunk.mean <= shrunk.hi);
  assert.ok(shrunk.hi - shrunk.lo > full.hi - full.lo);
  const fractional = betaPosterior(10.5, 20, 2, 18, 1.96);
  assert.ok(fractional.lo <= fractional.mean && fractional.mean <= fractional.hi);
  assert.ok(fractional.mean > 0 && fractional.mean < 1);
  assert.ok(adjustedZ(1.96, 9) > adjustedZ(1.96, 1));
});

test("sticky and shifting digits are not called an edge, and each contract keeps its settings", () => {
  const sticky = backtestDigitEngine({
    prices: prices(stickyDigits(420, 7)),
    pip: 2,
    contract: "DIGITMATCH",
    barrier: "4",
    stake: 1,
    payout: 9,
    comparisons: 10,
    z: 1.96,
  });
  assert.notEqual(sticky.verdict, "supported");
  const shift = Array.from({ length: 420 }, (_, index) => (index < 210 ? index % 2 : (index % 2) + 1));
  for (const contract of CONTRACTS) {
    const barrier = contract === "DIGITOVER" ? "4" : contract === "DIGITUNDER" ? "5" : contract === "DIGITEVEN" || contract === "DIGITODD" ? "" : "7";
    const row = backtestDigitEngine({
      prices: prices(shift),
      pip: 2,
      contract,
      barrier,
      stake: 1,
      payout: 1.5,
      comparisons: 1,
      z: 1.96,
    });
    assert.equal(row.verdict, "unproven");
    assert.match(row.note, /NO VERIFIED EDGE — INSUFFICIENT OUT-OF-SAMPLE EVIDENCE/);
    assert.equal(digitWins(contract, barrier || "0", 7), contract === "DIGITMATCH" || contract === "DIGITOVER" || contract === "DIGITODD" ? true : contract === "DIGITDIFF" || contract === "DIGITUNDER" || contract === "DIGITEVEN" ? false : false);
  }
  const over = defaultProfile("DIGITOVER");
  const under = defaultProfile("DIGITUNDER");
  assert.equal(over.stake, under.stake);
  assert.equal(over.trainSize, 80);
  assert.equal(over.validationSize, 40);
  assert.equal(over.finalSize, 40);
  assert.equal(over.validationPeriods, 3);
  assert.equal(over.minOos, 40);
  assert.equal(over.intervalZ, 1.96);
  assert.equal(validateProfile(over).length, 0);
  assert.ok(fieldsFor("DIGITMATCH").includes("trainSize"));
  assert.ok(fieldsFor("DIGITEVEN").includes("minOos"));
  assert.equal(fieldsFor("CALL").includes("trainSize"), false);
  assert.equal(CONFIDENCE_LEVELS.map((item) => item.z).join(","), "1.64,1.96,2.58");
  over.stake = 2;
  assert.equal(defaultProfile("DIGITUNDER").stake, 1);
});

test("payout math and execution gates stay where stage 6.2 left them", () => {
  const row = digitQuoteBreakdown({ ask: 1, payout: 1.05, probability: 0.95, contract: "DIGITDIFF" });
  assert.ok(Math.abs((row.netProfit ?? 0) - 0.05) < 1e-9);
  assert.equal(row.loss, 1);
  assert.ok((row.expectedReturn ?? 0) < 0);
  assert.equal(fairDigit("DIGITDIFF", "3"), 0.9);
  const missing = digitQuoteBreakdown({ ask: null, payout: null, probability: 0.9, contract: "DIGITDIFF" });
  assert.equal(missing.expectedReturn, null);
  assert.match(missing.text, /Neither was invented/);
  const manual = decideQuotePurchase({
    source: "public",
    intent: "preview",
    streaming: false,
    proposalId: "p",
    blockers: [],
    mode: "scanner",
    alreadyPurchased: false,
  });
  assert.equal(manual.action, "skip");
  const blocked = purchaseStillAuthorized({
    intent: "auto",
    capturedAccountId: "CR1",
    currentAccountId: "CR2",
    socketOpen: true,
    emergency: false,
    autoReady: true,
  });
  assert.equal(blocked.ok, false);
  const gate = tradeGate({
    mode: "auto",
    intent: "auto",
    emergency: false,
    accountType: "demo",
    armDemo: true,
    armReal: false,
    ev: -0.4,
    stake: 1,
    openTrades: 0,
    dailyPnl: 0,
    consecutiveLosses: 4,
    balance: 100,
    equityPeak: 100,
    lastLossAt: null,
    now: 1_000_000,
    risk: { ...DEFAULT_RISK, cooldownSec: 0 },
  });
  assert.equal(gate.ok, true);
  assert.equal(DEFAULT_RISK.martingale, false);
  const manualOver = analyzeBook({
    symbol: "R_100",
    quotes: prices(Array.from({ length: 40 }, (_, index) => index % 10)),
    pipSize: 2,
    offered: [{ contract_type: "DIGITOVER", min_contract_duration: "1t", max_contract_duration: "10t" }],
    minSample: 20,
    phase: 0,
    stake: 1,
    digit: 4,
  }).find((item) => item.type === "DIGITOVER");
  assert.equal(manualOver?.request?.barrier, "4");
});
