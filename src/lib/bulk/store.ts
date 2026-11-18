import { create } from "zustand";
import { ENGINE_IDS, type Candidate, type EngineId } from "./engines.ts";
import { type BulkTrade } from "./learn.ts";
import { DEFAULT_BULK_RISK, type BulkRisk } from "./risk.ts";

export const BULK_KEY = "richgangfx.bulk.v1";

export const KNOWN_SYNTHETICS = [
  { symbol: "R_10", name: "Volatility 10 Index" },
  { symbol: "R_25", name: "Volatility 25 Index" },
  { symbol: "R_50", name: "Volatility 50 Index" },
  { symbol: "R_75", name: "Volatility 75 Index" },
  { symbol: "R_100", name: "Volatility 100 Index" },
  { symbol: "1HZ10V", name: "Volatility 10 (1s) Index" },
  { symbol: "1HZ25V", name: "Volatility 25 (1s) Index" },
  { symbol: "1HZ50V", name: "Volatility 50 (1s) Index" },
  { symbol: "1HZ75V", name: "Volatility 75 (1s) Index" },
  { symbol: "1HZ100V", name: "Volatility 100 (1s) Index" },
];

export type BulkOpportunity = Candidate & {
  market: string;
  ev: number | null;
  payout: number | null;
};

export type BulkLog = { at: number; text: string; tone: "info" | "good" | "bad" };

type BulkState = {
  running: boolean;
  stopped: boolean;
  realPhrase: string;
  realStarted: boolean;
  enabledMarkets: string[];
  engines: Record<EngineId, boolean>;
  risk: BulkRisk;
  quotes: Record<string, number[]>;
  pip: Record<string, number>;
  latest: Record<string, { quote: number; digit: number | null; epoch: number }>;
  feed: "off" | "connecting" | "live" | "down";
  feedError: string | null;
  discovered: { symbol: string; name: string }[];
  opportunities: BulkOpportunity[];
  trades: BulkTrade[];
  log: BulkLog[];
  note: string | null;
};

const enginesOn = Object.fromEntries(ENGINE_IDS.map((id) => [id, true])) as Record<EngineId, boolean>;

export const useBulk = create<BulkState>(() => ({
  running: false,
  stopped: false,
  realPhrase: "",
  realStarted: false,
  enabledMarkets: ["R_100"],
  engines: enginesOn,
  risk: DEFAULT_BULK_RISK,
  quotes: {},
  pip: {},
  latest: {},
  feed: "off",
  feedError: null,
  discovered: KNOWN_SYNTHETICS,
  opportunities: [],
  trades: [],
  log: [],
  note: null,
}));

export function patchBulk(partial: Partial<BulkState>) {
  useBulk.setState(partial);
}

export function bulkLog(tone: BulkLog["tone"], text: string) {
  useBulk.setState((s) => ({ log: [{ at: Date.now(), text, tone }, ...s.log].slice(0, 80) }));
}

export function persistBulk() {
  const s = useBulk.getState();
  const body = {
    enabledMarkets: s.enabledMarkets,
    engines: s.engines,
    risk: s.risk,
    trades: s.trades.slice(0, 400),
    discovered: s.discovered,
  };
  try {
    localStorage.setItem(BULK_KEY, JSON.stringify(body));
  } catch {
    bulkLog("bad", "Bulk Trader settings could not be saved on this device.");
  }
}

export function hydrateBulk() {
  try {
    const raw = localStorage.getItem(BULK_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<BulkState>;
    useBulk.setState((s) => ({
      enabledMarkets: Array.isArray(saved.enabledMarkets) && saved.enabledMarkets.length ? saved.enabledMarkets : s.enabledMarkets,
      engines: saved.engines ? { ...s.engines, ...saved.engines } : s.engines,
      risk: saved.risk ? { ...s.risk, ...saved.risk } : s.risk,
      trades: Array.isArray(saved.trades) ? saved.trades : s.trades,
      discovered: Array.isArray(saved.discovered) && saved.discovered.length ? saved.discovered : s.discovered,
      running: false,
      stopped: false,
      realStarted: false,
    }));
  } catch {
    bulkLog("bad", "Saved Bulk Trader settings could not be read. Defaults are in use.");
  }
}
