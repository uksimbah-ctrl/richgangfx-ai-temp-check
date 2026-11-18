import { contractName } from "../engine/catalog.ts";
import { runDigitEngine } from "../engine/digit-engines.ts";
import { digitChoices, lastDigit } from "../engine/math.ts";
import { confidenceLabel, defaultProfile, type StrategyProfile } from "../engine/profiles.ts";
import { autoExecutionReady } from "./quote-exec.ts";
import type { TradeMode } from "../engine/risk.ts";

export type DigitDecision = "BUY" | "WAIT" | "NO SIGNAL";

export type DigitDiagnostic = {
  decision: DigitDecision;
  reason: string;
  rows: { label: string; value: string }[];
};

export type DigitDeskSnapshot = {
  feed: "connecting" | "live" | "down";
  feedError?: string | null;
  symbol: string | null;
  quotes: number[];
  pip: number;
  lastQuote: number | null;
  lastEpoch: number | null;
  tradeType: string | null;
  digitPick: number | null;
  profile?: StrategyProfile | null;
  planStatus?: string | null;
  planNote?: string | null;
  mode: TradeMode;
  trading: "off" | "connecting" | "live";
  emergency: boolean;
  accountType: "demo" | "real" | null;
  accountId: string | null;
  armDemo: boolean;
  armReal: boolean;
  armedAccountId: string | null;
  proposalNote?: string | null;
  executionNote?: string | null;
  buyHold?: string | null;
  unresolved?: number;
  opportunityReasons?: string[];
};

export function describeDigitDesk(input: DigitDeskSnapshot): DigitDiagnostic {
  const profile = input.profile ?? (input.tradeType ? defaultProfile(input.tradeType) : null);
  const name = input.tradeType ? contractName(input.tradeType) : "None selected";
  const choices = input.tradeType ? digitChoices(input.tradeType) : null;
  const barrier = barrierFor(input.tradeType, input.digitPick, choices);
  const last = input.quotes.length ? lastDigit(input.quotes[input.quotes.length - 1] ?? 0, input.pip) : null;
  const feed = input.feed === "live" ? "Live" : input.feed === "connecting" ? "Connecting" : `Down${input.feedError ? `: ${input.feedError}` : ""}`;
  const authorization = authorizationText(input);
  const proposal = input.proposalNote?.trim() || "No proposal has been requested.";
  const purchase = purchaseText(input);
  const execution = executionText(input.executionNote, input.opportunityReasons);
  const base = (decision: DigitDecision, reason: string, extra?: { sample?: string; effective?: string; confidence?: string; interval?: string; strategy?: string }) => ({
    decision,
    reason,
    rows: [
      { label: "Live tick connection", value: feed },
      { label: "Last received tick", value: input.lastQuote == null ? "None yet" : `${input.lastQuote}${input.lastEpoch == null ? "" : ` at ${input.lastEpoch}`}` },
      { label: "Current last digit", value: last == null ? "—" : String(last) },
      { label: "Historical sample count", value: extra?.sample ?? String(input.quotes.length) },
      { label: "Effective sample count", value: extra?.effective ?? "—" },
      { label: "Selected contract", value: name },
      { label: "Selected digit or barrier", value: choices == null ? "None. Even and Odd do not use a barrier." : barrier || "Not selected" },
      { label: "Strategy status", value: extra?.strategy ?? strategyStatus(profile) },
      { label: "Confidence and interval", value: extra?.confidence ?? "—" },
      { label: "Signal decision", value: decision },
      { label: "Proposal status", value: proposal },
      { label: "Trading authorization", value: authorization },
      { label: "Purchase status", value: purchase },
      { label: "Execution error", value: execution },
    ],
  });

  if (input.feed !== "live" && input.quotes.length === 0) {
    return base("NO SIGNAL", input.feedError || "The public tick feed is not live, so no digit has been received.");
  }
  if (!input.tradeType || !profile) {
    return base("NO SIGNAL", "No digit contract is selected. Pick Matches, Differs, Over, Under, Even, or Odd. Nothing is sent until you do.");
  }
  if (!profile.enabled || profile.status !== "active") {
    const why = !profile.enabled ? "This contract is disabled in Strategy Control." : profile.suspendReason || "This contract is not active, so it will not signal.";
    return base("NO SIGNAL", why, { strategy: why });
  }
  if (choices && !barrier) {
    const why = input.tradeType === "DIGITMATCH" || input.tradeType === "DIGITDIFF"
      ? "Pick a digit from 0 to 9. Matches and Differs will not trade until you do."
      : profile.autoBarrier
        ? "Auto barrier selection is on, but no barrier has qualified yet. A miss is not replaced."
        : "SELECT A BARRIER. Auto barrier selection is off, so Over and Under will not invent a digit.";
    return base("NO SIGNAL", why);
  }
  if (input.planNote && /switched off/i.test(input.planNote)) {
    return base("NO SIGNAL", input.planNote);
  }
  const need = Math.max(20, profile.minSample);
  if (input.quotes.length < need) {
    return base(
      "WAIT",
      `WAIT. ${name} has ${input.quotes.length} ticks. Need ${need} before this contract can be judged. No probability was invented.`,
      { sample: `${input.quotes.length}/${need}`, strategy: "Waiting for ticks" },
    );
  }
  const report = runDigitEngine({
    contract: input.tradeType,
    quotes: input.quotes,
    pip: input.pip,
    barrier,
    minSample: need,
    minConfidence: 0.5,
    strategy: name,
    lookback: Math.max(20, profile.shortWindow),
    minEffective: profile.minEffective,
    z: profile.intervalZ,
    persist: profile.walkForward,
    stake: profile.stake,
    payout: null,
  });
  const confidence = `${confidenceLabel(profile.intervalZ)} (z ${profile.intervalZ.toFixed(2)}). Estimate ${(report.estimated * 100).toFixed(1)}%. Interval ${(report.lo * 100).toFixed(1)}% to ${(report.hi * 100).toFixed(1)}%.`;
  const stats = {
    sample: String(report.sample),
    effective: String(Math.round(report.nEff)),
    confidence,
    strategy: report.status === "yes" ? "Qualified" : report.status === "wait" ? "WAIT" : "Not qualified",
  };
  if (input.planStatus === "stand-aside" && input.planNote && input.planNote !== report.reason && !/qualified because the lower bound/i.test(input.planNote)) {
    const decision: DigitDecision = /WAIT/i.test(input.planNote) ? "WAIT" : "NO SIGNAL";
    return base(decision, input.planNote, stats);
  }
  if (report.status === "wait") return base("WAIT", report.reason, stats);
  if (report.status !== "yes") return base("NO SIGNAL", report.reason, stats);
  return base("BUY", report.reason, stats);
}

function barrierFor(type: string | null, digit: number | null, choices: number[] | null): string {
  if (!type || choices == null) return "";
  if (digit == null || !choices.includes(digit)) return "";
  return String(digit);
}

function strategyStatus(profile: StrategyProfile | null): string {
  if (!profile) return "No contract selected";
  if (!profile.enabled) return "Disabled";
  if (profile.status !== "active") return profile.status;
  return "Active";
}

function authorizationText(input: DigitDeskSnapshot): string {
  const ready = autoExecutionReady({
    tradeType: input.tradeType,
    mode: input.mode,
    emergency: input.emergency,
    trading: input.trading,
    accountType: input.accountType,
    accountId: input.accountId,
    armDemo: input.armDemo,
    armReal: input.armReal,
    armedAccountId: input.armedAccountId,
  });
  if (ready) return "Auto is armed on the connected account. A qualified one-time proposal can be purchased.";
  if (!input.accountId) return "No trading account is connected.";
  if (input.trading !== "live") return "The trading socket is not open.";
  if (input.emergency) return "Emergency stop is on. New purchases are blocked.";
  if (!input.tradeType) return "No contract is selected, so auto cannot buy.";
  if (input.mode === "scanner") return "Scanner does not buy.";
  if (input.mode === "signal") return "Signals mode can request a price. It cannot purchase.";
  if (input.mode === "semi") return "Semi-auto waits for your approval. A preview quote is not a purchase.";
  if (input.accountType === "demo" && !input.armDemo) return "Demo trading is not armed.";
  if (input.accountType === "real") return "Real trading is not started for this account. START REAL is required, and it is never turned on by itself.";
  return "Auto buy is not authorized.";
}

function purchaseText(input: DigitDeskSnapshot): string {
  if (input.buyHold) return input.buyHold;
  if ((input.unresolved ?? 0) > 0) return `${input.unresolved} purchase is still unresolved. Another buy for that signal stays blocked.`;
  return "No purchase is in progress.";
}

/** A failed qualification is a signal decision, not a failed order. */
function executionText(note: string | null | undefined, reasons: string[] | undefined): string {
  const own = note?.trim() ?? "";
  if (own && !isQualificationNote(own)) return own;
  const other = (reasons ?? []).find((row) => row.trim() && !isQualificationNote(row));
  return other?.trim() || "None.";
}

function isQualificationNote(text: string): boolean {
  return /Theoretical baseline|NO VERIFIED EDGE|Not qualified|Qualified because|not a guaranteed win rate|No probability was invented|no qualified signal|held-out lower bound|UNPROVEN/i.test(text);
}
