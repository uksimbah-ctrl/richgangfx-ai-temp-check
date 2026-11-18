import assert from "node:assert/strict";
import test from "node:test";
import { backtestDigitEngine, baselinePrior, betaPosterior, rankDigitBacktests, runDigitEngine, PRIOR_STRENGTH } from "./digit-engines.ts";
import { digitWins, fairDigit, lastDigit } from "./math.ts";
import { defaultProfile, fieldsFor, validateProfile } from "./profiles.ts";
import { approvedEntry, defaultModule, moduleSupports, predictionAt } from "./modules.ts";

function prices(digits: number[], falling = false): number[] {
  return digits.map((digit, index) => Number(((falling ? 800 - index * 0.1 : 100 + index * 0.1) + digit / 100).toFixed(2)));
}

test("each digit contract keeps its own baseline and an equal barrier is a loss", () => {
  assert.equal(PRIOR_STRENGTH, 20);
  assert.deepEqual(baselinePrior(0.1), { alpha: 2, beta: 18, note: baselinePrior(0.1).note });
  assert.match(baselinePrior(0.5).note, /Beta\(10, 10\)/);
  assert.match(baselinePrior(0.9).note, /not an edge/);
  const posterior = betaPosterior(0, 0, 2, 18, 1.64);
  assert.ok(Math.abs(posterior.mean - 0.1) < 1e-9);
  for (let digit = 0; digit <= 9; digit++) {
    assert.equal(fairDigit("DIGITMATCH", String(digit)), 0.1);
    assert.equal(fairDigit("DIGITDIFF", String(digit)), 0.9);
    assert.equal(digitWins("DIGITMATCH", String(digit), digit), true);
    assert.equal(digitWins("DIGITDIFF", String(digit), digit), false);
    assert.equal(lastDigit(100 + digit / 100, 2), digit);
  }
  for (let barrier = 0; barrier <= 8; barrier++) {
    assert.equal(fairDigit("DIGITOVER", String(barrier)), (9 - barrier) / 10);
    assert.equal(digitWins("DIGITOVER", String(barrier), barrier), false);
    assert.equal(digitWins("DIGITOVER", String(barrier), barrier + 1), true);
  }
  assert.equal(fairDigit("DIGITOVER", "9"), 0);
  for (let barrier = 1; barrier <= 9; barrier++) {
    assert.equal(fairDigit("DIGITUNDER", String(barrier)), barrier / 10);
    assert.equal(digitWins("DIGITUNDER", String(barrier), barrier), false);
    assert.equal(digitWins("DIGITUNDER", String(barrier), barrier - 1), true);
  }
  assert.equal(fairDigit("DIGITUNDER", "0"), 0);
  assert.equal(fairDigit("DIGITEVEN", ""), 0.5);
  assert.equal(fairDigit("DIGITODD", ""), 0.5);
});

test("invalid and impossible barriers do not become a buy, and even is not the reverse of odd", () => {
  const mixed = Array.from({ length: 240 }, (_, index) => index % 10);
  const quotes = prices(mixed);
  for (const barrier of ["", "10", "-1", "4.5"]) {
    const match = runDigitEngine({ contract: "DIGITMATCH", quotes, pip: 2, barrier, minSample: 80, minConfidence: 0.5, strategy: "Matches", persist: false });
    assert.equal(match.status, "no");
    assert.equal(match.qualified, false);
  }
  const overNine = runDigitEngine({ contract: "DIGITOVER", quotes, pip: 2, barrier: "9", minSample: 80, minConfidence: 0.5, strategy: "Over", persist: false });
  assert.equal(overNine.status, "no");
  assert.match(overNine.reason, /no tradable baseline/);
  const underZero = runDigitEngine({ contract: "DIGITUNDER", quotes, pip: 2, barrier: "0", minSample: 80, minConfidence: 0.5, strategy: "Under", persist: false });
  assert.equal(underZero.status, "no");
  const evens = [0, 2, 4, 6, 8];
  const evenHeavy = Array.from({ length: 300 }, (_, index) => (index % 5 === 0 ? 1 : evens[index % 5]));
  const even = runDigitEngine({ contract: "DIGITEVEN", quotes: prices(evenHeavy), pip: 2, barrier: "", minSample: 80, minConfidence: 0, strategy: "Even", persist: false });
  const odd = runDigitEngine({ contract: "DIGITODD", quotes: prices(evenHeavy), pip: 2, barrier: "", minSample: 80, minConfidence: 0, strategy: "Odd", persist: false });
  assert.equal(even.status, "yes");
  assert.notEqual(odd.status, "yes");
  assert.ok(even.estimated > 0.5);
  assert.ok(odd.estimated < 0.5);
  assert.notEqual(even.hits, odd.hits);
});

test("a negative quote is shown and a missing payout is not invented", () => {
  const hot = Array.from({ length: 300 }, (_, index) => (index % 3 === 0 ? 4 : [0, 1, 2, 3, 5, 6, 7, 8, 9][index % 9]));
  const rich = runDigitEngine({
    contract: "DIGITMATCH",
    quotes: prices(hot),
    pip: 2,
    barrier: "4",
    minSample: 80,
    minConfidence: 0.5,
    strategy: "Matches",
    persist: false,
    stake: 1,
    payout: 1.2,
  });
  assert.equal(rich.breakEven, 1 / 1.2);
  assert.ok((rich.expectedReturn ?? 0) < 0);
  assert.match(rich.reason, /negative/);
  assert.match(rich.reason, /not a hidden block/);
  const differs = runDigitEngine({
    contract: "DIGITDIFF",
    quotes: prices(Array.from({ length: 400 }, (_, index) => [0, 1, 2, 3, 4, 5, 6, 8, 9][index % 9])),
    pip: 2,
    barrier: "7",
    minSample: 80,
    minConfidence: 0,
    strategy: "Differs",
    persist: false,
    stake: 1,
    payout: 1,
  });
  assert.match(differs.reason, /single loss/);
  assert.equal(differs.breakEven, 1);
  if (differs.expectedReturn != null) assert.ok(differs.expectedReturn < 0);
  const blank = backtestDigitEngine({ prices: prices(hot), pip: 2, contract: "DIGITMATCH", barrier: "4", stake: 1, payout: null, minSample: 80 });
  assert.equal(blank.verdict, "unproven");
  assert.equal(blank.oosEv, null);
});

test("backtests do not read the future, do not rank a flat digit by win rate, and keep each barrier separate", () => {
  const cycle = Array.from({ length: 600 }, (_, index) => index % 10);
  const base = prices(cycle);
  const changed = base.slice();
  changed[changed.length - 1] = changed[changed.length - 1] + 0.5;
  const early = predictionAt("selectedDigit", base, 400, { ...defaultModule("selectedDigit"), minSample: 80, lookback: 40, minConfidence: 0.5 }, 2, {
    type: "DIGITMATCH",
    barrier: "7",
  });
  const again = predictionAt("selectedDigit", changed, 400, { ...defaultModule("selectedDigit"), minSample: 80, lookback: 40, minConfidence: 0.5 }, 2, {
    type: "DIGITMATCH",
    barrier: "7",
  });
  assert.equal(again, early);
  const rows = [];
  for (let digit = 0; digit <= 9; digit++) {
    rows.push(backtestDigitEngine({ prices: base, pip: 2, contract: "DIGITMATCH", barrier: String(digit), stake: 1, payout: 8, minSample: 80, lookback: 40, engine: "DIGITMATCH" }));
    rows.push(backtestDigitEngine({ prices: base, pip: 2, contract: "DIGITDIFF", barrier: String(digit), stake: 1, payout: 1.05, minSample: 80, lookback: 40, engine: "DIGITDIFF" }));
  }
  for (let barrier = 0; barrier <= 8; barrier++) {
    rows.push(backtestDigitEngine({ prices: base, pip: 2, contract: "DIGITOVER", barrier: String(barrier), stake: 1, payout: 1.9, minSample: 80, lookback: 40, engine: "DIGITOVER" }));
  }
  for (let barrier = 1; barrier <= 9; barrier++) {
    rows.push(backtestDigitEngine({ prices: base, pip: 2, contract: "DIGITUNDER", barrier: String(barrier), stake: 1, payout: 1.9, minSample: 80, lookback: 40, engine: "DIGITUNDER" }));
  }
  rows.push(backtestDigitEngine({ prices: base, pip: 2, contract: "DIGITEVEN", barrier: "", stake: 1, payout: 1.9, minSample: 80, lookback: 40, engine: "DIGITEVEN" }));
  rows.push(backtestDigitEngine({ prices: base, pip: 2, contract: "DIGITODD", barrier: "", stake: 1, payout: 1.9, minSample: 80, lookback: 40, engine: "DIGITODD" }));
  assert.ok(rows.length >= 40);
  assert.ok(rows.every((row) => row.verdict !== "supported"));
  const impossible = backtestDigitEngine({ prices: base, pip: 2, contract: "DIGITOVER", barrier: "9", stake: 1, payout: 10, minSample: 80 });
  assert.equal(impossible.verdict, "unproven");
  assert.equal(impossible.oosEv, null);
  const ranked = rankDigitBacktests(rows);
  assert.equal(ranked.best, null);
  assert.match(ranked.note, /Unproven|unproven/);
  const gate = approvedEntry("digit", "DIGITMATCH", base, { selectedDigit: { ...defaultModule("selectedDigit"), enabled: true, minSample: 80 } }, 2, "3");
  assert.equal(gate.ok, false);
  assert.equal(moduleSupports("walkForward", "digit", "DIGITODD"), true);
  assert.equal(moduleSupports("rolling", "digit", "DIGITUNDER"), true);
});

test("digit settings are saved per contract and do not rewrite another contract", () => {
  const match = defaultProfile("DIGITMATCH");
  const differ = defaultProfile("DIGITDIFF");
  const even = defaultProfile("DIGITEVEN");
  assert.equal(match.stake, 1);
  assert.equal(match.minSample, 20);
  assert.equal(match.minEffective, 40);
  assert.equal(match.intervalZ, 1.96);
  assert.equal(match.walkForward, true);
  assert.equal(match.method, "beta-binomial");
  assert.equal(match.duration, 1);
  assert.equal(match.durationUnit, "t");
  assert.equal(validateProfile(match).length, 0);
  assert.ok(fieldsFor("DIGITMATCH").includes("walkForward"));
  assert.ok(fieldsFor("DIGITOVER").includes("barrier"));
  assert.equal(fieldsFor("DIGITEVEN").includes("barrier"), false);
  match.stake = 2.5;
  match.walkForward = false;
  assert.equal(defaultProfile("DIGITDIFF").stake, 1);
  assert.equal(differ.walkForward, true);
  assert.equal(even.stake, 1);
  assert.notEqual(match.stake, differ.stake);
});
