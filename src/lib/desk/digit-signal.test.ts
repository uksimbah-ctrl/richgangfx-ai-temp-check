import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBook } from "../engine/analyze.ts";
import { checkDigitProposal } from "../engine/contract-check.ts";
import { defaultModule, defaultModules } from "../engine/modules.ts";
import { defaultProfile } from "../engine/profiles.ts";
import { createAttempt, markUncertain, maySubmit, reconcileAttempt } from "./execution.ts";
import { contractSelected } from "./contract-scope.ts";
import { describeDigitDesk } from "./digit-diagnostics.ts";
import { claimProposal, decideQuotePurchase, fulfillQuote, purchaseStillAuthorized } from "./quote-exec.ts";
import { mergeTickHistory } from "./tick-history.ts";

function prices(digits: number[]): number[] {
  return digits.map((digit, index) => Number((100 + index * 0.1 + digit / 100).toFixed(2)));
}

function liveBook(type: string, digits: number[], digit: number | null, modules = defaultModules()) {
  return analyzeBook({
    symbol: "R_100",
    quotes: prices(digits),
    pipSize: 2,
    offered: [{ contract_type: type, min_contract_duration: "1t", max_contract_duration: "10t" }],
    minSample: 20,
    phase: 0,
    stake: 1,
    digit,
    modules,
    profiles: { [type]: defaultProfile(type) },
  }).find((row) => row.type === type);
}

const hot = Array.from({ length: 360 }, (_, index) => (index % 3 === 0 ? 7 : [0, 1, 2, 3, 4, 5, 6, 8, 9][index % 9]));
const absent = Array.from({ length: 420 }, (_, index) => [0, 1, 2, 3, 4, 5, 6, 8, 9][index % 9]);
const evenHeavy = Array.from({ length: 360 }, (_, index) => (index % 5 === 0 ? 1 : [0, 2, 4, 6, 8][index % 5]));
const oddHeavy = Array.from({ length: 360 }, (_, index) => (index % 5 === 0 ? 2 : [1, 3, 5, 7, 9][index % 5]));
const overHeavy = Array.from({ length: 360 }, (_, index) => (index % 6 === 0 ? 0 : [5, 6, 7, 8, 9][index % 5]));
const underHeavy = Array.from({ length: 360 }, (_, index) => (index % 6 === 0 ? 9 : [0, 1, 2, 3, 4][index % 5]));

test("each digit engine receives the sample and can qualify on its own series", () => {
  const cases = [
    { type: "DIGITMATCH", digits: hot, digit: 7 },
    { type: "DIGITDIFF", digits: absent, digit: 7 },
    { type: "DIGITOVER", digits: overHeavy, digit: 4 },
    { type: "DIGITUNDER", digits: underHeavy, digit: 5 },
    { type: "DIGITEVEN", digits: evenHeavy, digit: null },
    { type: "DIGITODD", digits: oddHeavy, digit: null },
  ];
  for (const row of cases) {
    const plan = liveBook(row.type, row.digits, row.digit);
    assert.equal(plan?.status, "pricing", `${row.type} ${plan?.note}`);
    assert.ok(plan?.request);
    assert.equal(plan?.request?.contract_type, row.type);
    assert.equal(plan?.diagnostics.find((item) => item.label === "Sample")?.value, String(row.digits.length));
    assert.match(plan?.note ?? "", /Qualified because the lower bound/);
    assert.doesNotMatch(plan?.note ?? "", /No approved strategy/);
    const proposal = checkDigitProposal({
      contractType: row.type,
      symbol: "R_100",
      barrier: plan?.request?.barrier,
      duration: plan?.request?.duration,
      durationUnit: plan?.request?.duration_unit,
      stake: 1,
      currency: "USD",
    });
    assert.equal(proposal.ok, true, row.type);
  }
});

test("a short or fair sample waits, and a streak or ensemble does not invent or cancel the contract engine", () => {
  const short = liveBook("DIGITMATCH", [1, 2, 3, 4, 5], 7);
  assert.equal(short?.status, "stand-aside");
  assert.equal(short?.request, undefined);
  assert.match(short?.note ?? "", /WAIT/);
  assert.match(short?.note ?? "", /5 ticks/);
  const fair = liveBook("DIGITEVEN", Array.from({ length: 240 }, (_, index) => index % 10), null);
  assert.notEqual(fair?.status, "pricing");
  assert.match(fair?.note ?? "", /Not qualified|UNPROVEN|WAIT/);
  assert.doesNotMatch(fair?.note ?? "", /No approved strategy/);
  const modules = defaultModules();
  modules.streakFade = { ...defaultModule("streakFade"), enabled: true };
  modules.ensemble = { ...defaultModule("ensemble"), enabled: true };
  modules.regime = { ...defaultModule("regime"), enabled: true };
  const still = liveBook("DIGITMATCH", hot, 7, modules);
  assert.equal(still?.status, "pricing");
  const strict = defaultModules();
  strict.statistical = { ...defaultModule("statistical"), enabled: true, minSample: 5000 };
  const held = liveBook("DIGITMATCH", hot, 7, strict);
  assert.equal(held?.status, "stand-aside");
  assert.match(held?.note ?? "", /5000/);
});

test("a qualified one-time proposal can buy only when auto is authorized", async () => {
  const plan = liveBook("DIGITMATCH", hot, 7);
  assert.ok(plan?.request);
  const seen = new Set<string>();
  const bought: string[] = [];
  const preview = await fulfillQuote({
    seen,
    quote: {
      source: "public",
      intent: "preview",
      streaming: false,
      proposalId: "preview-1",
      blockers: [],
      mode: "signal",
      alreadyPurchased: false,
    },
    buy: async (id) => {
      bought.push(id);
    },
  });
  assert.equal(preview.action, "skip");
  assert.equal(bought.length, 0);
  const closed = purchaseStillAuthorized({
    intent: "auto",
    capturedAccountId: "VRTC1",
    currentAccountId: "VRTC1",
    socketOpen: false,
    emergency: false,
    autoReady: true,
  });
  assert.equal(closed.ok, false);
  const disarmed = purchaseStillAuthorized({
    intent: "auto",
    capturedAccountId: "VRTC1",
    currentAccountId: "VRTC1",
    socketOpen: true,
    emergency: false,
    autoReady: false,
  });
  assert.equal(disarmed.ok, false);
  assert.match(disarmed.reason, /not authorized|Auto buy/);
  const decision = await fulfillQuote({
    seen,
    quote: {
      source: "trading",
      intent: "auto",
      streaming: false,
      proposalId: "once-1",
      blockers: [],
      mode: "auto",
      alreadyPurchased: false,
    },
    buy: async (id) => {
      bought.push(id);
    },
  });
  assert.equal(decision.action, "buy");
  assert.deepEqual(bought, ["once-1"]);
  const again = decideQuotePurchase({
    source: "trading",
    intent: "auto",
    streaming: false,
    proposalId: "once-1",
    blockers: [],
    mode: "auto",
    alreadyPurchased: true,
  });
  assert.equal(again.action, "skip");
  assert.equal(claimProposal(seen, "once-1"), false);
  const pending = markUncertain(
    createAttempt({
      id: "buy-1",
      accountId: "VRTC1",
      accountType: "demo",
      contractType: "DIGITMATCH",
      symbol: "R_100",
      stake: 1,
      strategy: "Matches",
      signalKey: "R_100|DIGITMATCH|7|1|t",
      at: 1_700_000_000_000,
    }),
    "The buy response was lost.",
  );
  const reconciled = reconcileAttempt({
    attempt: pending,
    portfolio: [],
    history: [{ contractId: "77", symbol: "R_100", contractType: "DIGITMATCH", buyPrice: 1, purchaseTime: 1_700_000_020 }],
    knownIds: [],
    now: pending.at + 30_000,
    historyComplete: true,
  });
  assert.equal(reconciled.retry, false);
  assert.equal(reconciled.attempt.status, "confirmed");
  assert.equal(reconciled.attempt.contractId, "77");
  assert.equal(maySubmit([pending], "VRTC1", pending.signalKey).ok, false);
});

test("history is kept, contracts stay separate, and the diagnostics panel says why", () => {
  const merged = mergeTickHistory(
    [{ q: 1.29, t: 30 }],
    [1.2, 1.21, 1.29],
    [10, 20, 30],
  );
  assert.deepEqual(merged, [
    { q: 1.2, t: 10 },
    { q: 1.21, t: 20 },
    { q: 1.29, t: 30 },
  ]);
  assert.equal(mergeTickHistory([{ q: 9, t: 1 }], [], []).length, 1);
  assert.equal(contractSelected("DIGITEVEN", "DIGITODD"), false);
  assert.equal(contractSelected("DIGITMATCH", "DIGITMATCH"), true);
  assert.equal(contractSelected(null, "DIGITEVEN"), false);
  const card = describeDigitDesk({
    feed: "live",
    symbol: "R_100",
    quotes: prices(hot),
    pip: 2,
    lastQuote: prices(hot).at(-1) ?? null,
    lastEpoch: 100,
    tradeType: "DIGITMATCH",
    digitPick: 7,
    profile: defaultProfile("DIGITMATCH"),
    mode: "auto",
    trading: "live",
    emergency: false,
    accountType: "demo",
    accountId: "VRTC1",
    armDemo: false,
    armReal: false,
    armedAccountId: null,
    executionNote: "Demo trading is not armed.",
  });
  assert.equal(card.decision, "BUY");
  assert.match(card.reason, /Qualified/);
  assert.equal(card.rows.find((row) => row.label === "Effective sample count")?.value !== "—", true);
  assert.match(card.rows.find((row) => row.label === "Trading authorization")?.value ?? "", /not armed/);
  assert.equal(card.rows.find((row) => row.label === "Execution error")?.value, "Demo trading is not armed.");
  const essay =
    "Statistical Probability. Predicted differ 1. Theoretical baseline 90.0%. Interval 89.8% to 93.4%. NO VERIFIED EDGE — INSUFFICIENT OUT-OF-SAMPLE EVIDENCE. Not qualified. The estimate being above the baseline is not enough when the lower bound still covers it.";
  const declined = describeDigitDesk({
    feed: "live",
    symbol: "R_100",
    quotes: prices(Array.from({ length: 240 }, (_, index) => index % 10)),
    pip: 2,
    lastQuote: 100.01,
    lastEpoch: 240,
    tradeType: "DIGITDIFF",
    digitPick: 1,
    profile: defaultProfile("DIGITDIFF"),
    planStatus: "stand-aside",
    planNote: essay,
    mode: "auto",
    trading: "live",
    emergency: false,
    accountType: "demo",
    accountId: "VRTC1",
    armDemo: true,
    armReal: false,
    armedAccountId: "VRTC1",
    executionNote: essay,
    opportunityReasons: [essay],
  });
  assert.equal(declined.decision, "NO SIGNAL");
  assert.equal(declined.rows.find((row) => row.label === "Execution error")?.value, "None.");
  const rejected = describeDigitDesk({
    feed: "live",
    symbol: "R_100",
    quotes: prices(hot),
    pip: 2,
    lastQuote: 1,
    lastEpoch: 1,
    tradeType: "DIGITMATCH",
    digitPick: 7,
    profile: defaultProfile("DIGITMATCH"),
    mode: "auto",
    trading: "live",
    emergency: false,
    accountType: "demo",
    accountId: "VRTC1",
    armDemo: true,
    armReal: false,
    armedAccountId: "VRTC1",
    executionNote: "The broker rejected the purchase.",
  });
  assert.equal(rejected.rows.find((row) => row.label === "Execution error")?.value, "The broker rejected the purchase.");
  const waiting = describeDigitDesk({
    feed: "live",
    symbol: "R_100",
    quotes: prices([0, 1, 2, 3]),
    pip: 2,
    lastQuote: 100.03,
    lastEpoch: 4,
    tradeType: "DIGITODD",
    digitPick: null,
    profile: defaultProfile("DIGITODD"),
    mode: "signal",
    trading: "off",
    emergency: false,
    accountType: null,
    accountId: null,
    armDemo: false,
    armReal: false,
    armedAccountId: null,
  });
  assert.equal(waiting.decision, "WAIT");
  assert.match(waiting.reason, /4 ticks/);
  assert.doesNotMatch(waiting.reason, /No approved strategy/);
  const blank = describeDigitDesk({
    feed: "live",
    symbol: "R_100",
    quotes: prices(hot),
    pip: 2,
    lastQuote: 1,
    lastEpoch: 1,
    tradeType: "DIGITOVER",
    digitPick: null,
    profile: defaultProfile("DIGITOVER"),
    mode: "auto",
    trading: "live",
    emergency: false,
    accountType: "real",
    accountId: "CR1",
    armDemo: false,
    armReal: false,
    armedAccountId: null,
  });
  assert.equal(blank.decision, "NO SIGNAL");
  assert.match(blank.reason, /SELECT A BARRIER/);
  assert.match(blank.rows.find((row) => row.label === "Trading authorization")?.value ?? "", /not armed|not started|START REAL/);
});
