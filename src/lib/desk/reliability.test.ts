import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBook } from "../engine/analyze.ts";
import { approvedEntry, defaultModule, defaultModules, moduleGate, walkModule } from "../engine/modules.ts";
import { defaultProfile, entryBlock } from "../engine/profiles.ts";
import { DEFAULT_RISK, orderStake, tradeGate } from "../engine/risk.ts";
import {
  armAfterAccountChange,
  armFromStorage,
  armRealDecision,
  batchAccepts,
  buyRetryAllowed,
  canManageContract,
  drawdownPct,
  bumpPeak,
  keepJournalOwnership,
  realBuyAllowed,
  scopedExposure,
  scopedLossStreak,
  scopedOpenCount,
  scopedPnl,
  scopedWinRate,
  scopedWins,
  settlementStatus,
  unassignedCount,
  applyAccountObservation,
  type ScopedTrade,
} from "./account-scope.ts";

function trade(partial: Partial<ScopedTrade> & { accountId: string }): ScopedTrade {
  return {
    closedAt: partial.closedAt,
    profit: partial.profit,
    status: partial.status ?? "lost",
    accountId: partial.accountId,
  };
}

function evenPrices(count: number, startCents = 10000, step = 2): number[] {
  return Array.from({ length: count }, (_, i) => (startCents + i * step) / 100);
}

function continuationPrices(blocks = 30, falling = false): number[] {
  const digits: number[] = [];
  for (let i = 0; i < blocks; i++) digits.push(0, 2, 4, 6, 1);
  digits.push(0, 2, 4, 8);
  let cents = falling ? 90000 : 10000;
  return digits.map((digit) => {
    cents += falling ? -1 : 1;
    let next = Math.floor(cents / 10) * 10 + digit;
    if (falling) while (next >= cents) next -= 10;
    else while (next <= cents) next += 10;
    cents = next;
    return cents / 100;
  });
}

test("demo losses do not change real totals, and real losses do not change demo totals", () => {
  const now = Date.now();
  const journal = [
    trade({ accountId: "VRTC1", closedAt: now, profit: -5, status: "lost" }),
    trade({ accountId: "CR1", closedAt: now, profit: 2, status: "won" }),
    trade({ accountId: "CR1", closedAt: now - 1, profit: -1, status: "lost" }),
  ];
  assert.equal(scopedPnl(journal, 0, "CR1"), 1);
  assert.equal(scopedPnl(journal, 0, "VRTC1"), -5);
  assert.equal(scopedLossStreak(journal, 0, "CR1"), 0);
  assert.equal(scopedLossStreak(journal, 0, "VRTC1"), 1);
  assert.equal(scopedWinRate(journal, "CR1"), 0.5);
  assert.equal(scopedWinRate(journal, "VRTC1"), 0);
  const demoStake = orderStake({ ...DEFAULT_RISK, martingale: true, martingaleMultiplier: 2, martingaleSteps: 3 }, 100, scopedLossStreak(journal, 0, "VRTC1"));
  const realStake = orderStake({ ...DEFAULT_RISK, martingale: true, martingaleMultiplier: 2, martingaleSteps: 3 }, 100, scopedLossStreak(journal, 0, "CR1"));
  assert.equal(demoStake, 2);
  assert.equal(realStake, 1);
});

test("a missing settlement profit stays open", () => {
  assert.equal(settlementStatus(true, null), "open");
  assert.equal(settlementStatus(false, -1), "open");
  assert.equal(settlementStatus(true, -1), "lost");
  assert.equal(settlementStatus(true, 1), "won");
  assert.equal(settlementStatus(true, 0), "sold");
});

test("real arming is bound to one account, clears on a switch, and is never restored", () => {
  const armed = armRealDecision({ phrase: "START REAL", account: { account_id: "CR1", account_type: "real" } });
  assert.equal(armed.ok, true);
  assert.equal(armed.armedAccountId, "CR1");
  const wrongPhrase = armRealDecision({ phrase: "arm real", account: { account_id: "CR1", account_type: "real" } });
  assert.equal(wrongPhrase.ok, false);
  const demo = armRealDecision({ phrase: "START REAL", account: { account_id: "VRTC1", account_type: "demo" } });
  assert.equal(demo.ok, false);
  assert.match(demo.reason, /Demo arming does not authorize/);
  assert.deepEqual(armAfterAccountChange(), { armReal: false, armedAccountId: null });
  assert.deepEqual(armFromStorage(), { armReal: false, armedAccountId: null });
});

test("an uncertain buy is not released by an empty portfolio", () => {
  const now = 1_000_000;
  assert.equal(buyRetryAllowed("found", now, now), false);
  assert.equal(buyRetryAllowed("unknown", 0, now), false);
  assert.equal(buyRetryAllowed("absent", 0, now), false);
  assert.equal(buyRetryAllowed("rejected", now + 1, now), false);
  assert.equal(buyRetryAllowed("rejected", now, now), true);
});

test("a contract is managed only by the account that owns it", () => {
  assert.equal(canManageContract("CR1", "CR1"), true);
  assert.equal(canManageContract("CR1", "VRTC1"), false);
  assert.equal(canManageContract("CR1", null), false);
});

test("a batch stays on one signal until that batch has room", () => {
  const lock = { key: "R_100:DIGITEVEN", size: 3, ids: ["a"] };
  assert.equal(batchAccepts(lock, "R_100:DIGITEVEN", 0), true);
  assert.equal(batchAccepts(lock, "R_100:DIGITODD", 0), false);
  assert.equal(batchAccepts({ ...lock, ids: ["a", "b", "c"] }, "R_100:DIGITEVEN", 0), false);
  assert.equal(batchAccepts(null, "R_100:CALL", 0), true);
});

test("martingale stays off by default and a negative expected value does not block", () => {
  assert.equal(DEFAULT_RISK.martingale, false);
  assert.equal(orderStake(DEFAULT_RISK, 1000, 4), 1);
  assert.equal(orderStake({ ...DEFAULT_RISK, martingale: true, martingaleMultiplier: 2, martingaleSteps: 3, maxStake: 5 }, 1000, 4), 5);
  const block = entryBlock(defaultProfile("DIGITEVEN"), {
    ev: -0.04,
    payout: 1.95,
    stake: 1,
    openForStrategy: 0,
    tradesToday: 0,
    dailyPnl: 0,
    consecutiveLosses: 9,
    exposure: null,
  });
  assert.equal(block, null);
});

test("one approved yes is not cancelled by a no, a wait, or the ensemble", () => {
  const quotes = continuationPrices(30);
  const configs = defaultModules();
  configs.streakFollow = { ...defaultModule("streakFollow"), enabled: true, minSample: 80, lookback: 3, minConfidence: 0 };
  configs.streakFade = { ...defaultModule("streakFade"), enabled: true, minSample: 80, lookback: 3, minConfidence: 0 };
  configs.parity = { ...defaultModule("parity"), enabled: true, minSample: 80, lookback: 30, minConfidence: 0 };
  configs.statistical = { ...defaultModule("statistical"), enabled: true, minSample: 500, lookback: 30 };
  configs.ensemble = { ...defaultModule("ensemble"), enabled: true };
  const gate = approvedEntry("digit", "DIGITEVEN", quotes, configs, 2);
  assert.equal(gate.ok, true);
  assert.ok(gate.agreed.includes("parity"));
  assert.equal(gate.agreed.includes("streakFollow"), false);
  assert.equal(gate.agreed.includes("streakFade"), false);
  assert.match(gate.reason, /does not cancel|Ensemble note/);
  const legacy = moduleGate("digit", "DIGITEVEN", quotes, configs, 2);
  assert.equal(legacy.block, null);
  const onlyEnsemble = defaultModules();
  onlyEnsemble.ensemble.enabled = true;
  onlyEnsemble.regime.enabled = true;
  const advisory = approvedEntry("digit", "DIGITEVEN", quotes, onlyEnsemble, 2);
  assert.equal(advisory.ok, false);
  assert.match(advisory.reason, /No approved strategy/);
});

test("legacy score and sample filters do not block a valid approved signal", () => {
  const quotes = continuationPrices(30);
  const configs = defaultModules();
  configs.parity = { ...defaultModule("parity"), enabled: true, minSample: 80, lookback: 30, minConfidence: 0 };
  const profile = defaultProfile("DIGITEVEN");
  profile.minSample = 5000;
  profile.shortWindow = 5000;
  profile.minScore = 1;
  const plans = analyzeBook({
    symbol: "R_100",
    quotes,
    pipSize: 2,
    offered: [{ contract_type: "DIGITEVEN", min_contract_duration: "1t", max_contract_duration: "1t" }],
    minSample: 20,
    phase: 0,
    stake: 1,
    modules: configs,
    profiles: { DIGITEVEN: profile },
  });
  const even = plans.find((row) => row.type === "DIGITEVEN");
  assert.equal(even?.status, "pricing");
  assert.ok(even?.modules?.includes("parity"));
  assert.equal(even?.modules?.includes("streakFollow"), false);
  assert.doesNotMatch(even?.note ?? "", /Signal score|Digit sample|does not support/);
});

test("even and odd walk-forward scores the next digit while the price falls", () => {
  const quotes = continuationPrices(40, true);
  const cfg = { ...defaultModule("streakFollow"), enabled: true, minSample: 40, lookback: 3, minConfidence: 0 };
  const report = walkModule("streakFollow", quotes, cfg, 1, 2);
  assert.ok(quotes[quotes.length - 1] < quotes[0]);
  assert.ok(report.outTrials > 0);
  assert.ok((report.outSample ?? 0) > 0.5);
  const mixed: number[] = [];
  for (let i = 0; i < 28; i++) mixed.push(0, 2, 4, 6, 8, 1, 3, 0);
  let cents = 80000;
  const varied = mixed.map((digit) => {
    cents -= 1;
    let next = Math.floor(cents / 10) * 10 + digit;
    while (next >= cents) next -= 10;
    cents = next;
    return cents / 100;
  });
  const statistical = walkModule("statistical", varied, { ...defaultModule("statistical"), enabled: true, minSample: 40 }, 5, 2);
  assert.ok(statistical.outTrials > 0);
  assert.ok((statistical.outSample ?? 0) > 0.5);
});

function gate(partial: { dailyPnl: number; openTrades: number; equityPeak: number | null; balance: number; accountType?: "demo" | "real"; armReal?: boolean }) {
  return tradeGate({
    mode: "auto",
    intent: "auto",
    emergency: false,
    accountType: partial.accountType ?? "real",
    armDemo: partial.accountType === "demo",
    armReal: partial.armReal ?? true,
    ev: 0.01,
    stake: 1,
    openTrades: partial.openTrades,
    dailyPnl: partial.dailyPnl,
    consecutiveLosses: 0,
    balance: partial.balance,
    equityPeak: partial.equityPeak,
    lastLossAt: null,
    now: 1_000_000,
    risk: { ...DEFAULT_RISK, maxOpenTrades: 1, dailyLossLimit: 20, maxDrawdownPct: 10 },
  });
}

test("two real accounts, demo, and unknown rows stay separate", () => {
  const now = Date.now();
  const journal: ScopedTrade[] = [
    trade({ accountId: "CR1", closedAt: now, profit: -25, status: "lost" }),
    trade({ accountId: "CR2", closedAt: now, profit: 4, status: "won" }),
    trade({ accountId: "VRTC1", closedAt: now, profit: -9, status: "lost" }),
    { accountId: "", closedAt: now, profit: -100, status: "lost" },
    { accountId: "CR1", status: "open", stake: 1 },
    { accountId: "CR2", status: "open", stake: 2 },
    { accountId: "VRTC1", status: "open", stake: 3 },
  ];
  assert.equal(scopedPnl(journal, 0, "CR1"), -25);
  assert.equal(scopedPnl(journal, 0, "CR2"), 4);
  assert.equal(scopedPnl(journal, 0, "VRTC1"), -9);
  assert.equal(scopedPnl(journal, 0, null), 0);
  assert.equal(scopedPnl(journal, 0, ""), 0);
  assert.equal(scopedWinRate(journal, "CR1"), 0);
  assert.equal(scopedWinRate(journal, "CR2"), 1);
  assert.deepEqual(scopedWins(journal, "CR2"), { closed: 1, wins: 1, losses: 0 });
  assert.equal(unassignedCount(journal), 1);
  const kept = keepJournalOwnership([{ accountId: undefined, status: "lost" }]);
  assert.equal(kept[0]?.accountId, "");
  assert.notEqual(kept[0]?.accountId, "CR1");
  assert.equal(scopedOpenCount(journal, "CR1"), 1);
  assert.equal(scopedOpenCount(journal, "CR2"), 1);
  assert.equal(scopedOpenCount(journal, "VRTC1"), 1);
  assert.equal(scopedExposure(journal, "CR2"), 2);
  assert.equal(scopedExposure(journal, "CR1"), 1);
  const cr1 = gate({ dailyPnl: scopedPnl(journal, 0, "CR1"), openTrades: 0, equityPeak: 100, balance: 100 });
  const cr2 = gate({ dailyPnl: scopedPnl(journal, 0, "CR2"), openTrades: scopedOpenCount(journal, "CR2"), equityPeak: 100, balance: 100 });
  const cr2Clear = gate({ dailyPnl: scopedPnl(journal, 0, "CR2"), openTrades: 0, equityPeak: 100, balance: 100 });
  assert.equal(cr1.ok, false);
  assert.match(cr1.reasons.join(" "), /Daily loss/);
  assert.equal(cr2.ok, false);
  assert.match(cr2.reasons.join(" "), /Open-trade/);
  assert.equal(cr2Clear.ok, true);
});

test("drawdown follows each account's own peak", () => {
  let peaks = bumpPeak({}, "CR1", 100);
  peaks = bumpPeak(peaks, "CR1", 80);
  peaks = bumpPeak(peaks, "CR2", 50);
  assert.equal(peaks.CR1, 100);
  assert.equal(peaks.CR2, 50);
  assert.ok((drawdownPct(peaks.CR1, 80) ?? 0) >= 20);
  assert.equal(drawdownPct(peaks.CR2, 50), 0);
  assert.equal(gate({ dailyPnl: 0, openTrades: 0, equityPeak: peaks.CR1, balance: 80 }).ok, false);
  assert.equal(gate({ dailyPnl: 0, openTrades: 0, equityPeak: peaks.CR2, balance: 50 }).ok, true);
});

test("a win resets Martingale and another account's losses do not raise the stake", () => {
  const now = Date.now();
  const journal = [
    trade({ accountId: "CR1", closedAt: now, profit: 1, status: "won" }),
    trade({ accountId: "CR1", closedAt: now - 2, profit: -1, status: "lost" }),
    trade({ accountId: "VRTC1", closedAt: now, profit: -1, status: "lost" }),
    trade({ accountId: "VRTC1", closedAt: now - 1, profit: -1, status: "lost" }),
  ];
  const risk = { ...DEFAULT_RISK, martingale: true, martingaleMultiplier: 2, martingaleSteps: 3, maxStake: 5, fixedStake: 1 };
  assert.equal(orderStake(risk, 100, scopedLossStreak(journal, 0, "CR1")), 1);
  assert.equal(orderStake(risk, 100, scopedLossStreak(journal, 0, "VRTC1")), 4);
  assert.equal(orderStake({ ...DEFAULT_RISK, martingale: false }, 100, scopedLossStreak(journal, 0, "VRTC1")), 1);
  assert.equal(orderStake({ ...risk, maxStake: 3 }, 100, 4), 3);
  assert.equal(orderStake({ ...risk, martingaleSteps: 1 }, 100, 4), 2);
});

test("real authorization stays off until the exact account is armed", () => {
  assert.deepEqual(armFromStorage({ armReal: true, armedAccountId: "CR1" }), { armReal: false, armedAccountId: null });
  assert.equal(realBuyAllowed({ accountType: "real", accountId: "CR1", armReal: false, armedAccountId: null }).ok, false);
  assert.equal(realBuyAllowed({ accountType: "real", accountId: "CR2", armReal: true, armedAccountId: "CR1" }).ok, false);
  assert.equal(realBuyAllowed({ accountType: "real", accountId: "CR1", armReal: true, armedAccountId: "CR1" }).ok, true);
  assert.equal(realBuyAllowed({ accountType: "demo", accountId: "VRTC1", armReal: true, armedAccountId: "CR1" }).ok, true);
  assert.equal(canManageContract("CR1", "CR2"), false);
  assert.equal(canManageContract("", "CR1"), false);
  const modules = { fade: { status: "active", observeReason: null } };
  const observed = applyAccountObservation(modules, { fade: "Observation on this account." });
  assert.equal(observed.fade.status, "observation");
  assert.equal(modules.fade.status, "active");
  assert.equal(applyAccountObservation(modules, undefined).fade.status, "active");
});
