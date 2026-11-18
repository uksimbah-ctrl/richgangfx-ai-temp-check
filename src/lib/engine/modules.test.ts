import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBook } from "./analyze.ts";
import { applyStrategyChoice, approvedEntry, bestStrategies, defaultModule, defaultModules, observeModule, readModule, walkModule } from "./modules.ts";
import { defaultProfile } from "./profiles.ts";

test("a contract selects its own strategies", () => {
  const differs = bestStrategies("DIGITDIFF");
  assert.ok(differs.includes("statistical"));
  assert.ok(differs.includes("selectedDigit"));
  assert.equal(differs.includes("parity"), false);
  assert.equal(differs.includes("barrierProb"), false);
  assert.equal(differs.includes("ensemble"), false);
  const even = bestStrategies("DIGITEVEN");
  assert.ok(even.includes("parity"));
  assert.equal(even.includes("selectedDigit"), false);
  const over = bestStrategies("DIGITOVER");
  assert.ok(over.includes("barrierProb"));
  const call = bestStrategies("CALL");
  assert.ok(call.includes("pullback"));
  assert.equal(call.includes("parity"), false);
  const chosen = applyStrategyChoice(defaultModules(), "DIGITDIFF");
  assert.equal(chosen.selectedDigit.enabled, true);
  assert.equal(chosen.parity.enabled, false);
  assert.equal(chosen.streakFollow.enabled, false);
  const cleared = applyStrategyChoice(chosen, null);
  assert.equal(cleared.selectedDigit.enabled, false);
});

test("disabled modules cannot open a trade", () => {
  const quotes: number[] = [];
  for (let i = 0; i < 240; i++) quotes.push(500 + i * 0.05);
  const offered = [{ contract_type: "CALL", min_contract_duration: "1t", max_contract_duration: "10t" }];
  const plain = analyzeBook({ symbol: "R_100", quotes, pipSize: 2, offered, minSample: 20, phase: 0, stake: 1 });
  const withModules = analyzeBook({
    symbol: "R_100",
    quotes,
    pipSize: 2,
    offered,
    minSample: 20,
    phase: 0,
    stake: 1,
    modules: defaultModules(),
  });
  assert.equal(plain.find((row) => row.type === "CALL")?.status, "pricing");
  assert.equal(withModules.find((row) => row.type === "CALL")?.status, "stand-aside");
  assert.match(withModules.find((row) => row.type === "CALL")?.note ?? "", /approved strategy/);
});

test("one module's settings do not change another module", () => {
  const modules = defaultModules();
  modules.pullback = { ...modules.pullback, enabled: true, lookback: 12, minSample: 40 };
  modules.breakout = { ...modules.breakout, enabled: true, lookback: 40, minSample: 40 };
  assert.equal(modules.pullback.lookback, 12);
  assert.equal(modules.breakout.lookback, 40);
  const over = defaultProfile("DIGITOVER");
  over.stake = 1.4;
  assert.equal(defaultProfile("DIGITUNDER").stake, 1);
  assert.equal(over.stake, 1.4);
});

test("one approved signal is not cancelled by another strategy or the ensemble", () => {
  const quotes: number[] = [];
  for (let i = 0; i < 80; i++) quotes.push(100 + i);
  const configs = defaultModules();
  configs.pullback.enabled = true;
  configs.pullback.minSample = 30;
  configs.pullback.minConfidence = 0;
  configs.reversion.enabled = true;
  configs.reversion.minSample = 30;
  configs.reversion.minConfidence = 0;
  configs.ensemble.enabled = true;
  const gate = approvedEntry("directional", "CALL", quotes, configs);
  const pull = readModule("pullback", quotes, configs.pullback);
  if (pull.bias === "up") {
    assert.equal(gate.ok, true);
    assert.ok(gate.agreed.includes("pullback"));
  }
  const plans = analyzeBook({
    symbol: "R_100",
    quotes,
    pipSize: 2,
    offered: [{ contract_type: "CALL", min_contract_duration: "5t", max_contract_duration: "10t" }],
    minSample: 20,
    phase: 0,
    stake: 1,
    modules: configs,
  });
  const call = plans.find((row) => row.type === "CALL");
  assert.notEqual(call?.pModel, pull.confidence);
});

test("even and odd walk-forward uses the next digit, not the price direction", () => {
  const digits: number[] = [];
  for (let i = 0; i < 40; i++) digits.push(0, 2, 4, 6, 1);
  digits.push(0, 2, 4, 8);
  let cents = 90000;
  const quotes = digits.map((digit) => {
    cents -= 1;
    let next = Math.floor(cents / 10) * 10 + digit;
    while (next >= cents) next -= 10;
    cents = next;
    return cents / 100;
  });
  const cfg = { ...defaultModule("streakFollow"), enabled: true, minSample: 40, lookback: 3, minConfidence: 0 };
  const report = walkModule("streakFollow", quotes, cfg, 1, 2);
  assert.ok(quotes[quotes.length - 1] < quotes[0]);
  assert.ok(report.outTrials > 0);
  assert.ok((report.outSample ?? 0) > 0.5);
});

test("a long even run does not fade just because it is long", () => {
  const quotes = Array.from({ length: 160 }, (_, i) => 100 + i * 0.02);
  const cfg = { ...defaultModule("streakFade"), enabled: true, minSample: 40, lookback: 3 };
  const reading = readModule("streakFade", quotes, cfg, 2);
  assert.equal(reading.bias, "none");
  assert.match(reading.reason, /not a signal|too small|does not clear/i);
});
test("observation keeps the module and explains why", () => {
  const module = { ...defaultModule("momentum"), enabled: true, maxLoss: 5 };
  const next = observeModule(module, [-1, -1, -1, -1, -1, -1, -1, -1]);
  assert.equal(next.id, "momentum");
  assert.equal(next.enabled, true);
  assert.equal(next.status, "observation");
  assert.match(next.observeReason ?? "", /not deleted/);
});
