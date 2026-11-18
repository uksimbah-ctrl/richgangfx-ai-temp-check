import assert from "node:assert/strict";
import test from "node:test";
import { scanEngine, streakHypothesis } from "./engines.ts";
import { approximateBacktest, calibrate, readSettlement } from "./learn.ts";
import { payoutEv, qualifyOpportunity } from "./qualify.ts";
import { bulkRiskBlock, DEFAULT_BULK_RISK } from "./risk.ts";
import { duplicateKey, openLike } from "./guards.ts";
import type { BulkTrade } from "./learn.ts";

function evenQuotes(count: number): number[] {
  return Array.from({ length: count }, (_, index) => Number((100 + index * 0.1 + (index % 2 === 0 ? 0.02 : 0.04)).toFixed(2)));
}

test("even and differs engines stay separate, and a streak does not qualify", () => {
  const even = scanEngine("even", evenQuotes(220), 2, 80);
  const differs = scanEngine("differs", evenQuotes(220), 2, 80);
  assert.equal(even?.contract, "DIGITEVEN");
  assert.equal(differs?.contract, "DIGITDIFF");
  assert.notEqual(even?.barrier, differs?.barrier);
  assert.match(streakHypothesis([7, 7, 7, 7]), /hypotheses only/);
  assert.match(streakHypothesis([7, 7, 7, 7]), /cannot qualify|not used to qualify|Neither one qualifies/);
});

test("expected value uses net profit and rejects a stale or negative quote", () => {
  assert.ok(Math.abs((payoutEv(0.6, 1.9, 1) ?? 0) - (0.6 * 0.9 - 0.4)) < 1e-9);
  const candidate = {
    engine: "differs" as const,
    contract: "DIGITDIFF",
    barrier: "1",
    estimated: 0.92,
    lo: 0.9,
    hi: 0.94,
    fair: 0.9,
    sample: 200,
    nEff: 180,
    qualified: true,
    reason: "",
    streakNote: "",
  };
  const bad = qualifyOpportunity({
    candidate,
    payout: 1.05,
    stake: 1,
    minEv: 0,
    minPayoutMultiple: 0,
    maxAgeMs: 1000,
    quotedAt: 1,
    now: 5000,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /stale/);
  const negative = qualifyOpportunity({
    candidate: { ...candidate, estimated: 0.5, lo: 0.5 },
    payout: 1.05,
    stake: 1,
    minEv: 0,
    minPayoutMultiple: 0,
    maxAgeMs: 5000,
    quotedAt: 10,
    now: 10,
  });
  assert.equal(negative.ok, false);
  const digitQuote = qualifyOpportunity({
    candidate,
    payout: 1.08,
    stake: 1,
    minEv: 0,
    minPayoutMultiple: 0,
    maxAgeMs: 5000,
    quotedAt: 10,
    now: 10,
  });
  assert.equal(digitQuote.ok, true);
});

test("risk stops new entries and does not raise the stake", () => {
  const blocked = bulkRiskBlock({
    risk: DEFAULT_BULK_RISK,
    stake: 1,
    open: 0,
    exposure: 0,
    dailyPnl: -20,
    consecutiveLosses: 0,
    secondsSinceLoss: null,
    running: true,
    stopped: false,
    connected: true,
  });
  assert.match(blocked ?? "", /Daily loss/);
  assert.equal(DEFAULT_BULK_RISK.stake, 1);
  const stopped = bulkRiskBlock({
    risk: DEFAULT_BULK_RISK,
    stake: 1,
    open: 0,
    exposure: 0,
    dailyPnl: 0,
    consecutiveLosses: 0,
    secondsSinceLoss: null,
    running: true,
    stopped: true,
    connected: true,
  });
  assert.match(stopped ?? "", /Stop All/);
});

test("the same market, contract, and barrier cannot be opened twice", () => {
  const trade = {
    id: "1",
    market: "R_100",
    engine: "even",
    contract: "DIGITEVEN",
    barrier: "",
    duration: 1,
    stake: 1,
    payout: null,
    profit: null,
    probability: 0.6,
    openedAt: 1,
    closedAt: null,
    contractId: "9",
    proposalId: "p",
    status: "open",
    note: "",
  } satisfies BulkTrade;
  assert.equal(openLike([trade], "R_100", "DIGITEVEN", ""), true);
  assert.equal(openLike([trade], "R_50", "DIGITEVEN", ""), false);
  assert.equal(duplicateKey("R_100", "DIGITEVEN", ""), "R_100:DIGITEVEN:");
});

test("a sold contract with a profit leaves the waiting state", () => {
  const settled = readSettlement({ is_sold: 1, profit: "0.95", payout: "1.95" });
  assert.equal(settled.sold, true);
  assert.equal(settled.profit, 0.95);
  const fromPrices = readSettlement({ status: "sold", sell_price: 0, buy_price: 1 });
  assert.equal(fromPrices.sold, true);
  assert.equal(fromPrices.profit, -1);
  const open = readSettlement({ is_sold: 0, profit: "" });
  assert.equal(open.sold, false);
  assert.equal(open.profit, null);
});

test("learning does not call a small sample a validated edge, and the backtest is labeled", () => {
  const rows = calibrate([]);
  assert.ok(rows.every((row) => /Not validated/.test(row.note)));
  const backtest = approximateBacktest(10, 10);
  assert.equal(backtest.rate, null);
  assert.match(backtest.note, /not available|invented/);
});
