import { create } from "zustand";
import type { Offered, Plan } from "@/lib/engine/analyze";
import { CONTRACTS } from "@/lib/engine/catalog";
import { DEFAULT_RISK, type AccountKind, type RiskConfig, type TradeMode } from "@/lib/engine/risk";
import { defaultBook, type StrategyProfile } from "@/lib/engine/profiles";
import { defaultModules, type ModuleConfig, type ModuleId } from "@/lib/engine/modules";
import type { BuyAttempt, SettlementAudit } from "@/lib/desk/execution";
import type { Account, ActiveSymbol, Tick } from "@/lib/deriv/types";

export type QuotePoint = { q: number; t: number };

export type Opportunity = {
  id: string;
  symbol: string;
  type: string;
  name: string;
  family: string;
  at: number;
  stake: number;
  payout: number | null;
  ask: number | null;
  ev: number | null;
  edge: number | null;
  pCons: number | null;
  pModel: number | null;
  longcode: string;
  note: string;
  reasons: string[];
  tradable: boolean;
  request: Plan["request"];
  currency: string;
};

export type JournalTrade = {
  id: string;
  contractId: string;
  symbol: string;
  contractType: string;
  accountType: AccountKind;
  accountId: string;
  stake: number;
  payout: number | null;
  currency: string;
  openedAt: number;
  closedAt?: number;
  profit?: number;
  status: "open" | "won" | "lost" | "sold";
  probability: number | null;
  ev: number | null;
  note: string;
  /** Module ids that agreed when this trade was opened. */
  modules?: string[];
  transactionId?: string;
  /** Deriv settlement fields actually received. Missing profit is not stored as zero. */
  settlement?: SettlementAudit;
};

export type LogLine = { at: number; tone: "info" | "warn" | "bad" | "good"; text: string };

export type BatchLock = {
  key: string;
  label: string;
  size: number;
  ids: string[];
};

export type DeskView =
  | "overview"
  | "scanner"
  | "signals"
  | "auto"
  | "strategies"
  | "positions"
  | "history"
  | "analytics"
  | "backtest"
  | "risk"
  | "control"
  | "chart"
  | "alerts"
  | "help"
  | "settings"
  | "bulk";

type DeskState = {
  booted: boolean;
  feed: "connecting" | "live" | "down";
  feedError: string | null;
  symbols: ActiveSymbol[];
  quotes: Record<string, Tick>;
  ticks: Record<string, QuotePoint[]>;
  pip: Record<string, number>;
  offered: Record<string, Offered[]>;
  focus: string[];
  plans: Plan[];
  opportunities: Opportunity[];
  log: LogLine[];
  view: DeskView;
  mode: TradeMode;
  emergency: boolean;
  armDemo: boolean;
  armReal: boolean;
  /** Real arming applies only to this Deriv account id. */
  armedAccountId: string | null;
  /** Set when a buy result is unknown. Blocks a second buy until it clears. */
  buyHold: string | null;
  realPhrase: string;
  risk: RiskConfig;
  enabled: Record<string, boolean>;
  /** Contract type full auto is allowed to buy. Null means the bot will not trade. */
  tradeType: string | null;
  /** Barrier digit for Over, Under, Matches, and Differs. */
  digitPick: number | null;
  /** How many contracts may be open together. 1 waits for the current entry to finish. */
  batchSize: number;
  /** The signal a batch is filling or waiting to settle. Null when no batch is active. */
  batchLock: BatchLock | null;
  /** Purchase attempts for this browser. Unresolved attempts block a duplicate buy. */
  attempts: BuyAttempt[];
  /** Trades before this time do not count toward today's limits. */
  sessionResetAt: number;
  profiles: Record<string, StrategyProfile>;
  modules: Record<ModuleId, ModuleConfig>;
  auth: "off" | "checking" | "ready" | "error";
  authError: string | null;
  credential: "pat" | "oauth" | null;
  appId: string;
  clientId: string;
  remember: boolean;
  accounts: Account[];
  accountId: string | null;
  trading: "off" | "connecting" | "live";
  journal: JournalTrade[];
  /** Highest seen balance for each Deriv account id. Drawdown uses only that account's peak. */
  equityPeaks: Record<string, number>;
  equityPeak: number | null;
  /** Observation reasons keyed by account id, then module id. Not shared across accounts. */
  moduleNotes: Record<string, Record<string, string>>;
  /** Latest proposal step for the selected digit contract. Not saved. */
  proposalNote: string | null;
  /** Latest reason a qualified signal did not buy. Not saved. */
  executionNote: string | null;
  lastLossAt: number | null;
  phase: number;
  busy: string | null;
};

const enabled: Record<string, boolean> = {};
for (const c of CONTRACTS) enabled[c.type] = true;

export const useDesk = create<DeskState>(() => ({
  booted: false,
  feed: "connecting",
  feedError: null,
  symbols: [],
  quotes: {},
  ticks: {},
  pip: {},
  offered: {},
  focus: ["R_100", "R_50", "R_25", "1HZ100V", "1HZ50V", "1HZ10V"],
  plans: [],
  opportunities: [],
  log: [],
  view: "overview",
  mode: "signal",
  emergency: false,
  armDemo: false,
  armReal: false,
  armedAccountId: null,
  buyHold: null,
  realPhrase: "",
  risk: DEFAULT_RISK,
  enabled,
  tradeType: null,
  digitPick: null,
  batchSize: 1,
  batchLock: null,
  attempts: [],
  sessionResetAt: 0,
  profiles: defaultBook(),
  modules: defaultModules(),
  auth: "off",
  authError: null,
  credential: null,
  appId: "",
  clientId: "34VY5FfQU5tk1NKdzf1I9",
  remember: false,
  accounts: [],
  accountId: null,
  trading: "off",
  journal: [],
  equityPeaks: {},
  equityPeak: null,
  moduleNotes: {},
  proposalNote: null,
  executionNote: null,
  lastLossAt: null,
  phase: 0,
  busy: null,
}));

export function patch(partial: Partial<DeskState>) {
  useDesk.setState(partial);
}

export function log(tone: LogLine["tone"], text: string) {
  useDesk.setState((s) => ({
    log: [{ at: Date.now(), tone, text }, ...s.log].slice(0, 80),
  }));
}
