import { adaptQuote, analyzeBook, settleEv, type Plan } from "@/lib/engine/analyze";
import { backtestDigit, backtestRise, type BacktestReport } from "@/lib/engine/backtest";
import { backtestCategories, backtestDigitEngine, digitQuoteBreakdown, NO_VERIFIED_OOS, rankDigitBacktests } from "@/lib/engine/digit-engines";
import { digitChoices, fairDigit } from "@/lib/engine/math";
import { CONTRACT_BY_TYPE, contractName } from "@/lib/engine/catalog";
import { checkDigitProposal, restoreDigitPick } from "@/lib/engine/contract-check";
import { orderStake, researchProfile, tradeGate, type TradeMode } from "@/lib/engine/risk";
import { defaultProfile, entryBlock, healthVerdict, releaseLossSuspension, type StrategyProfile } from "@/lib/engine/profiles";
import { applyStrategyChoice, observeModule, MODULE_IDS, MODULE_NAMES } from "@/lib/engine/modules";
import { contractSelected } from "@/lib/desk/contract-scope";
import { mergeTickHistory } from "@/lib/desk/tick-history";
import { mergeBooks, readLocalBook, writeLocalBook } from "@/lib/strategy/local";
import { fetchAccounts, fetchTradingUrl, type CredentialKind } from "@/lib/deriv/rest";
import { DerivSocket } from "@/lib/deriv/socket";
import { PUBLIC_WS, type Account, type ActiveSymbol, type DerivMsg, type OpenContract, type Tick } from "@/lib/deriv/types";
import { exchangeOAuthCode } from "@/lib/oauth.functions";
import {
  log,
  patch,
  useDesk,
  type DeskView,
  type JournalTrade,
  type Opportunity,
  type BatchLock,
} from "@/lib/desk/store";
import {
  addOpenContract,
  applySettlement,
  assembleHistory,
  batchWouldExceed,
  blockingAttempt,
  classifyBuyError,
  confirmAttempt,
  createAttempt,
  isUnresolved,
  markFailed,
  markReconciling,
  markSettled,
  markUncertain,
  reconcileAttempt,
  restoreAttempts,
  slotsUsed,
  subscriptionList,
  type BuyAttempt,
  type ContractEvidence,
  type HistoryPage,
} from "./execution.ts";
import { flashText, setSettingsFlash } from "./settings-flash.ts";
import {
  autoExecutionReady,
  buildProposalPayload,
  fulfillQuote,
  purchaseStillAuthorized,
  type ExecutionIntent,
  type QuoteSource,
} from "./quote-exec.ts";
import {
  applyAccountObservation,
  armAfterAccountChange,
  armFromStorage,
  armRealDecision,
  batchAccepts,
  bumpPeak,
  canManageContract,
  forAccount,
  keepJournalOwnership,
  realBuyAllowed,
  scopedLossStreak,
  scopedOpenCount,
  scopedPnl,
  scopedWinRate,
  settlementStatus,
} from "./account-scope";

const SETTINGS_KEY = "richgangfx.desk.v1";
const TOKEN_KEY = "richgangfx.token";
const PKCE_KEY = "rg.pkce";

const publicSock = new DerivSocket();
const tradeSock = new DerivSocket();

export function bulkAccountLive(): boolean {
  return tradeSock.connected;
}

/** One authorized account socket. The bulk trader sends its own proposals and buys on it. Desk plans are not changed. */
export function bulkAccountRequest(payload: Record<string, unknown>, timeoutMs = 12000): Promise<DerivMsg> {
  return tradeSock.request(payload, timeoutMs);
}

export function bulkAccountStream(payload: Record<string, unknown>, onUpdate: (msg: DerivMsg) => void): Promise<DerivMsg> {
  return tradeSock.stream(payload, onUpdate);
}

export function bulkAccountForget(id: string | undefined) {
  tradeSock.forget(id);
}

let secret = "";
let kind: CredentialKind | null = null;
let stopped = false;
let pumping = false;
let focusGen = 0;
let tradeGen = 0;
const muted = new Map<string, number>();
const inFlight = new Set<string>();
const watched = new Set<string>();
/** Proposal ids already sent to buy. A repeated response must not buy again. */
const purchasedIds = new Set<string>();
let attemptSeq = 1;

export function selectedAccount(): Account | null {
  const s = useDesk.getState();
  return s.accounts.find((a) => a.account_id === s.accountId) ?? null;
}

export function realizedToday(journal: JournalTrade[], now = Date.now(), accountId?: string | null): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const t0 = Math.max(start.getTime(), useDesk.getState().sessionResetAt ?? 0);
  return scopedPnl(journal, t0, accountId);
}

export function lossStreak(journal: JournalTrade[], accountId?: string | null): number {
  const t0 = useDesk.getState().sessionResetAt ?? 0;
  return scopedLossStreak(journal, t0, accountId);
}

export function winRate(journal: JournalTrade[], accountId?: string | null): number | null {
  return scopedWinRate(journal, accountId);
}

export { settlementStatus };

function latestLossAt(journal: JournalTrade[], accountId?: string | null): number | null {
  const t0 = useDesk.getState().sessionResetAt ?? 0;
  const times = forAccount(journal, accountId)
    .filter((row) => row.closedAt != null && row.closedAt >= t0 && (row.profit ?? 0) < 0)
    .map((row) => row.closedAt ?? 0);
  return times.length ? Math.max(...times) : null;
}

let consumers = 0;
let analysisTimer: ReturnType<typeof setInterval> | null = null;
let jobsTimer: ReturnType<typeof setInterval> | null = null;
let accountsTimer: ReturnType<typeof setInterval> | null = null;

export function startDesk(): () => void {
  consumers += 1;
  if (consumers === 1) {
    stopped = false;
    hydrate();
    void loadProfiles();
    void loadModules();
    void runFeed();
    analysisTimer = setInterval(() => {
      if (!stopped) refreshPlans();
    }, 2500);
    jobsTimer = setInterval(() => {
      if (!stopped) void pump();
    }, 1700);
    accountsTimer = setInterval(() => {
      if (stopped || !secret) return;
      void refreshAccounts(false);
      const s = useDesk.getState();
      if (
        s.accountId &&
        s.auth === "ready" &&
        s.trading !== "connecting" &&
        (s.trading !== "live" || !tradeSock.connected)
      ) {
        void openTrading(s.accountId);
      }
    }, 20000);
    void resumeCredential();
    void maybeOAuthReturn();
  }
  return () => {
    consumers -= 1;
    if (consumers > 0) return;
    stopped = true;
    if (analysisTimer) clearInterval(analysisTimer);
    if (jobsTimer) clearInterval(jobsTimer);
    if (accountsTimer) clearInterval(accountsTimer);
    analysisTimer = null;
    jobsTimer = null;
    accountsTimer = null;
    focusGen += 1;
    publicSock.close();
    tradeSock.close();
  };
}

export function setView(view: DeskView) {
  patch({ view });
}

export function setMode(mode: TradeMode) {
  patch({ mode });
  persist();
  log("info", `Mode set to ${mode}.`);
}

export function resetLimits() {
  muted.clear();
  const now = Date.now();
  const state = useDesk.getState();
  const profiles = { ...state.profiles };
  const changed: StrategyProfile[] = [];
  for (const [type, profile] of Object.entries(profiles)) {
    if (profile.status === "active" && !profile.suspendReason) continue;
    const next = { ...profile, status: "active" as const, suspendReason: null };
    profiles[type] = next;
    changed.push(next);
  }
  const modules = { ...state.modules };
  for (const id of Object.keys(modules) as Array<keyof typeof modules>) {
    const row = modules[id];
    if (!row || (row.status === "active" && !row.observeReason)) continue;
    modules[id] = { ...row, status: "active", observeReason: null };
  }
  useDesk.setState({ sessionResetAt: now, lastLossAt: null, emergency: false, profiles, modules });
  if (!persist()) {
    log("bad", "Save failed. The limit reset was not stored on this device.");
    return;
  }
  log("info", "Limits reset on this device. Real money stays off until you arm it.");
  if (changed.length === 0) return;
  void import("@/lib/strategy/control.functions").then(({ saveStrategyProfile }) => {
    for (const profile of changed) {
      void saveStrategyProfile({ data: { profile, action: "reactivate" } }).catch(() => undefined);
    }
  });
}

let buysInFlight = 0;

function sameContract(selected: string | null, type: string): boolean {
  return contractSelected(selected, type);
}

function signalKey(plan: Plan): string {
  const request = plan.request;
  return [plan.symbol, plan.type, request?.barrier ?? "", request?.duration ?? "", request?.duration_unit ?? ""].join("|");
}

function signalLabel(plan: Plan): string {
  const barrier = plan.request?.barrier ? ` ${plan.request.barrier}` : "";
  return `${plan.name}${barrier} on ${plan.symbol}`;
}

function batchStillOpen(lock: BatchLock, journal: JournalTrade[]): boolean {
  return lock.ids.some((id) => journal.some((row) => row.contractId === id && row.status === "open"));
}

function releaseSettledBatch() {
  const state = useDesk.getState();
  const lock = state.batchLock;
  if (!lock) return;
  if (lock.ids.length >= lock.size && !batchStillOpen(lock, state.journal)) {
    patch({ batchLock: null });
    log("info", `${lock.label} settled. The next signal can start.`);
  }
}

function entryCap(size: number | undefined): number {
  const value = Math.round(Number(size));
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(5, value);
}

export function setBatchSize(size: number) {
  const batchSize = entryCap(size);
  patch({ batchSize });
  persist();
  log("info", batchSize === 1 ? "One entry at a time. The next order waits until the open contract finishes." : `Batch of ${batchSize}. Each batch stays on one signal until those contracts settle.`);
}

export function setEmergency(on: boolean) {
  patch({ emergency: on });
  log(on ? "bad" : "info", on ? "Emergency stop. New trades are blocked." : "Emergency stop cleared.");
}

export function setArmDemo(on: boolean) {
  patch({ armDemo: on });
  persist();
  log("info", on ? "Desk started." : "Desk stopped.");
}

export function setArmReal(on: boolean) {
  const state = useDesk.getState();
  if (!on) {
    const off = armAfterAccountChange();
    patch({ armReal: off.armReal, armedAccountId: off.armedAccountId, realPhrase: "" });
    log("info", "Real-money trading stopped.");
    return;
  }
  const decision = armRealDecision({
    phrase: state.realPhrase,
    account: state.accounts.find((row) => row.account_id === state.accountId) ?? null,
  });
  if (!decision.ok || !decision.armedAccountId) {
    log("warn", decision.reason);
    return;
  }
  patch({ armReal: true, armedAccountId: decision.armedAccountId, realPhrase: state.realPhrase.trim() });
  log("warn", `Real-money trading started for ${decision.armedAccountId}.`);
}

export function setRealPhrase(realPhrase: string) {
  patch({ realPhrase });
}

export function updateRisk(partial: Partial<ReturnType<typeof useDesk.getState>["risk"]>): boolean {
  const previous = useDesk.getState().risk;
  useDesk.setState((s) => ({ risk: { ...s.risk, ...partial } }));
  if (!persist()) {
    useDesk.setState({ risk: previous });
    setSettingsFlash({ tone: "failed", text: flashText("failed") });
    log("bad", "Save failed. Risk changes were not saved.");
    return false;
  }
  setSettingsFlash({ tone: "saved", text: flashText("saved") });
  return true;
}

export function toggleStrategy(type: string) {
  useDesk.setState((s) => ({ enabled: { ...s.enabled, [type]: !s.enabled[type] } }));
  persist();
}

export function setTradeType(type: string | null) {
  if (type != null && !CONTRACT_BY_TYPE.has(type)) return;
  const name = type ? contractName(type) : null;
  const chosen = type ? applyStrategyChoice(useDesk.getState().modules, type) : applyStrategyChoice(useDesk.getState().modules, null);
  const names = type
    ? MODULE_IDS.filter((id) => chosen[id]?.enabled)
        .map((id) => MODULE_NAMES[id])
        .join(", ")
    : "";
  useDesk.setState((s) => ({
    tradeType: type,
    enabled: type ? { ...s.enabled, [type]: true } : s.enabled,
    modules: chosen,
  }));
  persist();
  log("info", name ? `Bot will trade ${name} only. Using ${names}.` : "Bot contract cleared. Full auto will not buy until you pick one.");
}

export function setDigitPick(digit: number | null) {
  if (digit != null && (!Number.isInteger(digit) || digit < 0 || digit > 9)) return;
  patch({ digitPick: digit });
  persist();
}

export async function pinSymbol(symbol: string) {
  const focus = useDesk.getState().focus.includes(symbol)
    ? useDesk.getState().focus.filter((s) => s !== symbol)
    : [...useDesk.getState().focus, symbol].slice(-8);
  const next = focus.length ? focus : useDesk.getState().focus;
  patch({ focus: next });
  persist();
  await subscribeFocus();
  await loadContracts(next);
}

export async function connectPat(token: string, appId: string) {
  const clean = token.trim();
  if (clean.length < 8) {
    patch({ authError: "Paste a Deriv personal access token." });
    return;
  }
  if (!appId.trim()) {
    patch({ authError: "PAT login needs the Deriv App ID for that token." });
    return;
  }
  secret = clean;
  kind = "pat";
  patch({ auth: "checking", authError: null, credential: "pat", appId: appId.trim() });
  try {
    await adoptAccounts();
  } catch (err) {
    failAuth(err);
  }
}

export function disconnect() {
  tradeGen += 1;
  secret = "";
  kind = null;
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  tradeSock.close();
  const off = armAfterAccountChange();
  patch({
    auth: "off",
    authError: null,
    credential: null,
    accounts: [],
    accountId: null,
    trading: "off",
    armDemo: false,
    armReal: off.armReal,
    armedAccountId: off.armedAccountId,
    buyHold: null,
    equityPeak: null,
  });
  persist();
  log("info", "Account disconnected. The token was cleared from this browser.");
}

export async function switchAccount(accountId: string) {
  const previous = useDesk.getState().accountId;
  const off = armAfterAccountChange();
  const peaks = useDesk.getState().equityPeaks;
  const pending = useDesk.getState().attempts.find((row) => row.accountId === accountId && isUnresolved(row.status));
  patch({
    accountId,
    equityPeak: peaks[accountId] ?? null,
    armReal: off.armReal,
    armedAccountId: off.armedAccountId,
    realPhrase: "",
    batchLock: previous === accountId ? useDesk.getState().batchLock : null,
    buyHold: pending?.note ?? null,
  });
  if (previous && previous !== accountId) {
    log("warn", "Account changed. Real-money trading is off until you type START REAL for this account.");
  }
  persist();
  await openTrading(accountId);
}

export const DERIV_CLIENT_ID = "34VY5FfQU5tk1NKdzf1I9";
export const DERIV_REDIRECT_URI = "https://richgangfx.grok.me/callback";

export async function beginOAuth(clientId: string, prompt?: "registration") {
  const id = clientId.trim();
  if (!id) {
    patch({ authError: "Enter the OAuth client id from your Deriv app." });
    return;
  }
  const verifier = random(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(digest);
  const state = random(32);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, clientId: id }));
  patch({ clientId: id });
  persist();
  const url = new URL("https://auth.deriv.com/oauth2/auth");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", DERIV_REDIRECT_URI);
  url.searchParams.set("scope", "trade");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (prompt) url.searchParams.set("prompt", prompt);
  window.location.assign(url.toString());
}

export async function approve(id: string) {
  const opp = useDesk.getState().opportunities.find((row) => row.id === id);
  if (!opp?.request) return;
  if (useDesk.getState().mode !== "semi") {
    log("warn", "Switch to semi-auto before approving a trade.");
    return;
  }
  await execute(planFromOpp(opp), "approve");
}

export async function flatten() {
  if (!tradeSock.connected) {
    log("warn", "Trading socket is not live, so open contracts cannot be sold from here.");
    return;
  }
  const accountId = useDesk.getState().accountId;
  const open = useDesk.getState().journal.filter((row) => row.status === "open" && canManageContract(row.accountId, accountId));
  if (open.length === 0) {
    log("info", "No open contracts tracked by this desk.");
    return;
  }
  for (const row of open) {
    try {
      await tradeSock.request({ sell: contractField(row.contractId), price: 0 });
      log("info", `Sell sent for ${row.contractId}.`);
    } catch (err) {
      log("bad", err instanceof Error ? err.message : "Sell failed.");
    }
  }
}

export async function runBacktest(symbol: string, type: string): Promise<BacktestReport> {
  const history = await publicSock.request({
    ticks_history: symbol,
    adjust_start_time: 1,
    count: 1000,
    end: "latest",
    start: 1,
    style: "ticks",
  });
  const prices = history.history?.prices ?? [];
  if (prices.length < 30) throw new Error("Not enough historical ticks came back.");
  const pip = useDesk.getState().pip[symbol] ?? history.pip_size ?? 2;
  const state = useDesk.getState();
  const profile = state.profiles[type] ?? defaultProfile(type);
  const stake = orderStake(state.risk, null, 0) ?? state.risk.fixedStake;
  if (type.startsWith("DIGIT")) {
    const choices = digitChoices(type);
    const picked = state.digitPick;
    let barriers: string[] = [];
    if (!choices) barriers = [""];
    else if (picked != null && choices.includes(picked)) barriers = [String(picked)];
    else if (type === "DIGITMATCH" || type === "DIGITDIFF") {
      return {
        trials: 0,
        wins: 0,
        hitRate: null,
        referenceRate: fairDigit(type, "0"),
        breakevenPayout: null,
        perTradeEv: null,
        note: `Pick a digit from 0 to 9. Matches and Differs were not backtested on a rotated digit. No expected return was invented. ${NO_VERIFIED_OOS}`,
        lines: [
          "A. Synthetic probability test was not run without a selected digit.",
          "B. Historical tick simulation was not scored.",
          "C. SIMULATED USING CURRENT PAYOUT was not run. No payout was invented.",
          "D. Historical Deriv proposal performance is not available. None was invented.",
          "E. Demo execution records were not used.",
          "F. Verified live execution records were not used.",
        ],
      };
    } else if (!profile.autoBarrier) {
      return {
        trials: 0,
        wins: 0,
        hitRate: null,
        referenceRate: fairDigit(type, "0"),
        breakevenPayout: null,
        perTradeEv: null,
        note: `SELECT A BARRIER. Auto barrier selection is off, so this backtest did not invent an Over or Under digit. ${NO_VERIFIED_OOS}`,
        lines: [
          "A. Synthetic probability test was not run without a barrier.",
          "B. Historical tick simulation was not scored.",
          "C. SIMULATED USING CURRENT PAYOUT was not run.",
          "D. Historical Deriv proposal performance is not available. None was invented.",
          "E. Demo execution records were not used.",
          "F. Verified live execution records were not used.",
        ],
      };
    } else barriers = choices.map(String);
    const rows = [];
    for (const barrier of barriers) {
      let payout: number | null = null;
      try {
        const quote = await publicSock.request({
          proposal: 1,
          amount: stake,
          basis: "stake",
          contract_type: type,
          currency: selectedAccount()?.currency ?? "USD",
          duration: 1,
          duration_unit: "t",
          underlying_symbol: symbol,
          ...(barrier ? { barrier } : {}),
        });
        payout = num(quote.proposal?.payout);
      } catch {
        payout = null;
      }
      rows.push(
        backtestDigitEngine({
          prices,
          pip,
          contract: type,
          barrier,
          stake,
          payout,
          minSample: Math.max(20, profile.minSample),
          minConfidence: 0.5,
          lookback: Math.max(20, profile.shortWindow),
          engine: type,
          train: profile.trainSize,
          validation: profile.validationSize,
          final: profile.finalSize,
          periods: profile.validationPeriods,
          minOos: profile.minOos,
          comparisons: Math.max(1, barriers.length),
          z: profile.intervalZ,
        }),
      );
    }
    const ranked = rankDigitBacktests(rows);
    const focus = rows.find((row) => row.barrier === barriers[0]) ?? rows[0];
    const naive = backtestDigit({
      prices,
      pipSize: pip,
      type,
      barrier: focus?.barrier ?? "",
      payout: focus?.payout ?? null,
      stake,
    });
    return {
      ...naive,
      perTradeEv: focus?.oosEv ?? null,
      note: `SIMULATED USING CURRENT PAYOUT. ${naive.note} Engine ${focus?.verdict ?? "unproven"} on barrier ${focus?.barrier || "none"}. ${ranked.note}`,
      lines: [...(focus ? backtestCategories(focus, prices.length) : []), ...rows.map((row) => `${row.contract} ${row.barrier || "parity"}: ${row.verdict}. Checked ${row.checked}. Qualified ${row.decisions}. Out-of-sample ${row.oosHits}/${row.oosTrials}.`)],
    };
  }
  let payout: number | null = null;
  try {
    const quote = await publicSock.request({
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: type,
      currency: selectedAccount()?.currency ?? "USD",
      duration: 5,
      duration_unit: "t",
      underlying_symbol: symbol,
    });
    payout = num(quote.proposal?.payout);
  } catch {
    payout = null;
  }
  const side = type === "PUT" || type === "LOWER" || type === "PUTE" ? "down" : "up";
  return backtestRise({ prices, steps: 5, side, payout, stake });
}

let feedGen = 0;

async function runFeed() {
  const gen = ++feedGen;
  let delay = 800;
  while (!stopped && gen === feedGen) {
    try {
      patch({ feed: "connecting", feedError: null });
      await publicSock.connect(PUBLIC_WS);
      if (stopped || gen !== feedGen) return;
      patch({ feed: "live", feedError: null });
      log("good", "Public market feed is live.");
      delay = 800;
      await loadSymbols();
      if (stopped || gen !== feedGen) return;
      await subscribeFocus();
      await loadContracts(useDesk.getState().focus);
      await publicSock.untilClosed();
      if (stopped || gen !== feedGen) return;
      patch({ feed: "down", feedError: "Market feed disconnected." });
    } catch (err) {
      if (stopped || gen !== feedGen) return;
      const text = err instanceof Error ? err.message : "Market feed failed.";
      patch({ feed: "down", feedError: text });
      log("warn", text);
    }
    await sleep(delay);
    delay = Math.min(12000, delay * 2);
  }
}

async function loadSymbols() {
  const msg = await publicSock.request({ active_symbols: "brief" });
  const symbols = msg.active_symbols ?? [];
  const saved = useDesk.getState().focus;
  const focus = saved.length ? saved.filter((s) => symbols.some((row) => row.underlying_symbol === s)) : [];
  patch({
    symbols,
    focus: focus.length ? focus : pickFocus(symbols),
  });
  persist();
}

function pickFocus(symbols: ActiveSymbol[]): string[] {
  const open = symbols.filter((s) => s.exchange_is_open && !s.is_trading_suspended);
  const ranked = [...open].sort((a, b) => (b.trade_count ?? 0) - (a.trade_count ?? 0));
  const synth = ranked.filter((s) => s.market === "synthetic_index");
  const pool = synth.length >= 4 ? synth : ranked;
  return pool.slice(0, 6).map((s) => s.underlying_symbol);
}

async function subscribeFocus() {
  const gen = ++focusGen;
  const symbols = useDesk.getState().focus;
  for (const symbol of symbols) {
    if (gen !== focusGen || stopped) return;
    try {
      void publicSock
        .stream({ ticks: symbol, subscribe: 1 }, (msg) => {
          if (msg.tick) ingest(msg.tick);
        })
        .catch((err: unknown) => {
          log("warn", err instanceof Error ? err.message : `Could not stream ${symbol}.`);
        });
    } catch (err) {
      log("warn", err instanceof Error ? err.message : `Could not stream ${symbol}.`);
    }
  }
  for (const symbol of symbols) {
    if (gen !== focusGen || stopped) return;
    await seedHistory(symbol, gen);
  }
}

async function seedHistory(symbol: string, gen: number) {
  if (gen !== focusGen || stopped || !publicSock.connected) return;
  try {
    const history = await publicSock.request({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: 1000,
      end: "latest",
      start: 1,
      style: "ticks",
    });
    if (gen !== focusGen || stopped) return;
    const prices = (history.history?.prices ?? []).map((value) => Number(value)).filter((value) => Number.isFinite(value));
    const times = (history.history?.times ?? []).map((value) => Number(value));
    if (prices.length === 0 || times.length === 0) {
      log("warn", `${symbol} did not return historical ticks, so the digit sample only grows from new ticks.`);
      return;
    }
    const pip = num(history.pip_size);
    useDesk.setState((s) => ({
      ticks: { ...s.ticks, [symbol]: mergeTickHistory(s.ticks[symbol] ?? [], prices, times) },
      pip: pip != null ? { ...s.pip, [symbol]: pip } : s.pip,
    }));
    log("info", `${symbol} loaded ${prices.length} historical ticks for the digit engines.`);
    refreshPlans();
  } catch (err) {
    if (gen !== focusGen || stopped) return;
    log("warn", err instanceof Error ? err.message : `${symbol} history could not be loaded.`);
  }
}

function ingest(tick: Tick) {
  const quote = num(tick.quote);
  if (quote == null || !tick.symbol) return;
  const pip = num(tick.pip_size) ?? 2;
  const point = { ...tick, quote, pip_size: pip };
  useDesk.setState((s) => {
    const prev = s.ticks[tick.symbol] ?? [];
    const next = prev.length >= 1500 ? prev.slice(-1100) : prev.slice();
    next.push({ q: quote, t: tick.epoch });
    return {
      quotes: { ...s.quotes, [tick.symbol]: point },
      ticks: { ...s.ticks, [tick.symbol]: next },
      pip: { ...s.pip, [tick.symbol]: pip },
    };
  });
}

async function loadContracts(symbols: string[]) {
  for (const symbol of symbols) {
    if (stopped || !publicSock.connected) return;
    try {
      const msg = await publicSock.request({ contracts_for: symbol });
      const offered = (msg.contracts_for?.available ?? [])
        .filter((row) => row.contract_type)
        .map((row) => ({
          contract_type: row.contract_type as string,
          min_contract_duration: row.min_contract_duration,
          max_contract_duration: row.max_contract_duration,
          multiplier_range: row.multiplier_range,
          growth_rate_range: row.growth_rate_range,
          growth_rate_barrier_offsets: row.growth_rate_barrier_offsets,
          barrier: row.barrier,
          barrier_choices: row.barrier_choices?.map(String),
          last_digit_range: row.last_digit_range,
        }));
      useDesk.setState((s) => ({ offered: { ...s.offered, [symbol]: offered } }));
    } catch (err) {
      log("warn", err instanceof Error ? err.message : `No contract list for ${symbol}.`);
    }
    await sleep(250);
  }
  refreshPlans();
}

function reviewModules() {
  const state = useDesk.getState();
  const accountId = state.accountId;
  if (!accountId) return;
  const prev = state.moduleNotes[accountId] ?? {};
  const next = { ...prev };
  let changed = false;
  for (const id of MODULE_IDS) {
    const current = state.modules[id];
    if (!current || current.status !== "active") {
      if (next[id]) {
        delete next[id];
        changed = true;
      }
      continue;
    }
    const profits = forAccount(state.journal, accountId)
      .filter((row) => row.modules?.includes(id) && row.status !== "open" && row.profit != null)
      .map((row) => row.profit ?? 0);
    const judged = observeModule({ ...current, observeReason: null }, profits);
    const note = judged.status === "observation" ? judged.observeReason ?? "Observation on this account. The module was not deleted." : null;
    if ((next[id] ?? null) !== note) {
      if (note) next[id] = note;
      else delete next[id];
      changed = true;
    }
  }
  if (!changed) return;
  useDesk.setState((s) => ({ moduleNotes: { ...s.moduleNotes, [accountId]: next } }));
}

async function loadModules() {
  try {
    const { loadStrategyModules } = await import("@/lib/strategy/modules.functions");
    const loaded = await loadStrategyModules();
    if (!loaded.modules) return;
    useDesk.setState((s) => ({ modules: applyStrategyChoice({ ...s.modules, ...loaded.modules }, s.tradeType) }));
  } catch {
    log("warn", "Extra strategy modules could not be loaded. Existing contract settings were left as they are.");
  }
}

async function loadProfiles() {
  const local = readLocalBook();
  if (local) useDesk.setState((s) => ({ profiles: clearLossSuspensions(mergeBooks(s.profiles, local)) }));
  try {
    const { loadStrategyDesk } = await import("@/lib/strategy/control.functions");
    const loaded = await loadStrategyDesk();
    useDesk.setState((s) => {
      const profiles = clearLossSuspensions(mergeBooks(s.profiles, loaded.profiles));
      writeLocalBook(profiles);
      return { profiles };
    });
  } catch {
    log("warn", "Strategy settings could not be loaded from the database. The desk is using the last copy saved on this device.");
  }
}

function clearLossSuspensions(book: Record<string, StrategyProfile>): Record<string, StrategyProfile> {
  const next: Record<string, StrategyProfile> = {};
  for (const [type, profile] of Object.entries(book)) next[type] = releaseLossSuspension(profile);
  return next;
}

function refreshPlans() {
  const cleared = clearLossSuspensions(useDesk.getState().profiles);
  if (JSON.stringify(cleared) !== JSON.stringify(useDesk.getState().profiles)) patch({ profiles: cleared });
  const s = useDesk.getState();
  if (s.feed !== "live") return;
  const account = s.accounts.find((a) => a.account_id === s.accountId) ?? null;
  const stake = orderStake(s.risk, account?.balance ?? null, lossStreak(s.journal, s.accountId)) ?? s.risk.fixedStake;
  const plans: Plan[] = [];
  for (const symbol of s.focus) {
    const offered = s.offered[symbol] ?? [];
    if (offered.length === 0) continue;
    const quotes = (s.ticks[symbol] ?? []).map((point) => point.q);
    const profile = researchProfile(s.risk.researchMode ?? "balanced");
    const rows = analyzeBook({
      symbol,
      quotes,
      pipSize: s.pip[symbol] ?? s.quotes[symbol]?.pip_size ?? 2,
      offered,
      minSample: s.risk.minSample,
      phase: s.phase,
      stake,
      digit: s.digitPick,
      prior: profile.prior,
      z: profile.z,
      profiles: s.profiles,
      modules: applyAccountObservation(s.modules, s.accountId ? s.moduleNotes[s.accountId] : undefined),
    });
    for (const row of rows) {
      if (s.enabled[row.type] === false) {
        row.status = "stand-aside";
        row.note = "Switched off.";
        row.request = undefined;
      }
      plans.push(row);
    }
  }
  reviewModules();
  patch({ plans });
}

function noteDesk(partial: { proposalNote?: string | null; executionNote?: string | null }) {
  const state = useDesk.getState();
  const next: { proposalNote?: string | null; executionNote?: string | null } = {};
  if (partial.proposalNote !== undefined && partial.proposalNote !== state.proposalNote) next.proposalNote = partial.proposalNote;
  if (partial.executionNote !== undefined && partial.executionNote !== state.executionNote) next.executionNote = partial.executionNote;
  if (next.proposalNote !== undefined || next.executionNote !== undefined) patch(next);
}

async function pump() {
  if (pumping || useDesk.getState().feed !== "live") return;
  if (useDesk.getState().mode === "scanner") {
    noteDesk({ executionNote: "Scanner does not request a proposal." });
    return;
  }
  const room = useDesk.getState();
  releaseSettledBatch();
  const locked = useDesk.getState().batchLock;
  if (room.mode === "auto") {
    const open = scopedOpenCount(room.journal, room.accountId);
    const capNow = entryCap(room.batchSize);
    if (open + buysInFlight >= capNow) {
      noteDesk({ executionNote: capNow === 1 ? "One contract is already open. The next entry waits until it finishes." : `Batch is full. ${open} contracts are open.` });
      return;
    }
    if (locked && locked.ids.length >= locked.size) {
      noteDesk({ executionNote: `This batch is only ${locked.label}. It waits for that signal to settle.` });
      return;
    }
  }
  const now = Date.now();
  const plans = useDesk.getState().plans.filter((plan) => {
    if (plan.status !== "pricing" || !plan.request) return false;
    const selected = useDesk.getState().tradeType;
    if (!selected || !sameContract(selected, plan.type)) return false;
    const key = `${plan.symbol}:${plan.type}`;
    if (inFlight.has(key)) return false;
    const until = muted.get(key) ?? 0;
    return until < now;
  });
  const sameSignal = locked && locked.ids.length < locked.size ? plans.filter((plan) => signalKey(plan) === locked.key) : plans;
  if (locked && locked.ids.length < locked.size && sameSignal.length === 0) {
    if (!batchStillOpen(locked, useDesk.getState().journal)) {
      patch({ batchLock: null });
      log("info", `${locked.label} ended before the batch filled. No other signal was added.`);
    }
    noteDesk({ executionNote: `${locked.label} is still the open batch. No other contract is added.` });
    return;
  }
  const ranked = [...sameSignal].sort((a, b) => (b.pCons ?? -1) - (a.pCons ?? -1));
  const plan = ranked[0];
  if (!plan) {
    const selected = useDesk.getState().tradeType;
    const held = selected ? useDesk.getState().plans.some((row) => sameContract(selected, row.type) && inFlight.has(`${row.symbol}:${row.type}`)) : false;
    noteDesk({
      executionNote: !selected
        ? "No contract is selected, so no proposal is sent."
        : held
          ? "A proposal for this contract is already in flight."
          : null,
    });
    return;
  }
  noteDesk({ proposalNote: `Sending a one-time proposal for ${plan.name}.`, executionNote: null });
  pumping = true;
  patch({ phase: useDesk.getState().phase + 1 });
  try {
    await pricePlan(plan);
  } finally {
    pumping = false;
  }
}

function strategyStake(state: ReturnType<typeof useDesk.getState>, balance: number | null): number {
  return orderStake(state.risk, balance, lossStreak(state.journal, state.accountId)) ?? 0;
}

function strategyReasonFor(plan: Plan, ev: number | null, payout: number | null, stake: number): string | null {
  const state = useDesk.getState();
  const profile: StrategyProfile = releaseLossSuspension(state.profiles[plan.type] ?? defaultProfile(plan.type));
  if (profile !== (state.profiles[plan.type] ?? defaultProfile(plan.type)) && profile.status === "active") {
    useDesk.setState((s) => ({ profiles: { ...s.profiles, [plan.type]: profile } }));
  }
  const account = state.accounts.find((row) => row.account_id === state.accountId) ?? null;
  const mine = forAccount(state.journal, account?.account_id).filter((row) => row.contractType === plan.type);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = Math.max(start.getTime(), state.sessionResetAt ?? 0);
  const openForStrategy = mine.filter((row) => row.status === "open").length;
  const openAll = scopedOpenCount(state.journal, account?.account_id);
  const cap = entryCap(state.batchSize);
  if (openAll >= cap) {
    return cap === 1 ? "One contract is already open. The next entry waits until it finishes." : `Batch is full. ${openAll} contracts are open.`;
  }
  if (cap > 1 && state.batchLock && state.batchLock.key !== signalKey(plan)) {
    return `This batch is only ${state.batchLock.label}. It waits for that signal to settle.`;
  }
  const tradesToday = mine.filter((row) => row.openedAt >= t0).length;
  const dailyPnl = mine.filter((row) => (row.closedAt ?? 0) >= t0).reduce((sum, row) => sum + (row.profit ?? 0), 0);
  let consecutiveLosses = 0;
  let secondsSinceLoss: number | null = null;
  for (const row of [...mine].reverse()) {
    if (row.status === "open" || (row.closedAt ?? 0) < t0) continue;
    if (row.status === "lost" || (row.profit ?? 0) < 0) {
      consecutiveLosses += 1;
      if (secondsSinceLoss == null && row.closedAt) secondsSinceLoss = (Date.now() - row.closedAt) / 1000;
    } else break;
  }
  const exposure = plan.request?.multiplier ? stake * plan.request.multiplier : null;
  const desk = state.risk;
  const gated: StrategyProfile = {
    ...profile,
    maxOpen: cap,
    cooldownSec: desk.cooldownSec,
    maxDailyLoss: desk.dailyLossLimit,
    maxExposure: desk.maxMultiplierExposure,
    dailyTradeLimit: Number.MAX_SAFE_INTEGER,
  };
  const verdict = healthVerdict(gated, { consecutiveLosses, dailyPnl });
  if (verdict) return verdict.reason;
  return entryBlock(gated, { ev, payout, stake, openForStrategy, tradesToday, dailyPnl, consecutiveLosses, exposure, secondsSinceLoss });
}

async function pricePlan(plan: Plan, depth = 0) {
  const key = `${plan.symbol}:${plan.type}`;
  inFlight.add(key);
  const state = useDesk.getState();
  const account = state.accounts.find((a) => a.account_id === state.accountId) ?? null;
  const currency = account?.currency ?? "USD";
  const stake = strategyStake(state, account?.balance ?? null);
  const checked = checkDigitProposal({
    contractType: plan.type,
    symbol: plan.symbol,
    barrier: plan.request?.barrier,
    duration: plan.request?.duration,
    durationUnit: plan.request?.duration_unit,
    stake,
    currency: account?.currency ?? "USD",
  });
  if (!checked.ok) {
    noteDesk({ proposalNote: checked.reason, executionNote: checked.reason });
    pushOpp({
      plan,
      stake,
      currency: account?.currency ?? "USD",
      payout: null,
      ask: null,
      ev: null,
      edge: null,
      note: checked.reason,
      reasons: [checked.reason],
      tradable: false,
    });
    log("warn", checked.reason);
    inFlight.delete(key);
    return;
  }
  if (plan.request && (plan.type === "DIGITEVEN" || plan.type === "DIGITODD" || checked.barrier)) {
    const next = { ...plan.request, duration: checked.duration, duration_unit: checked.durationUnit };
    if (checked.barrier) next.barrier = checked.barrier;
    else delete next.barrier;
    plan.request = next;
  }
  const ready = autoExecutionReady({
    tradeType: state.tradeType,
    mode: state.mode,
    emergency: state.emergency,
    trading: state.trading,
    accountType: account?.account_type ?? null,
    accountId: account?.account_id ?? null,
    armDemo: state.armDemo,
    armReal: state.armReal,
    armedAccountId: state.armedAccountId,
  });
  const onTrade = ready && tradeSock.connected;
  const sock = onTrade ? tradeSock : publicSock;
  const source: QuoteSource = onTrade ? "trading" : "public";
  const intent: ExecutionIntent = onTrade ? "auto" : "preview";
  const payload = buildProposalPayload(plan.request, plan.symbol, stake, currency, onTrade);
  const delivery = {
    streaming: payload.subscribe === 1,
    source,
    intent,
    accountId: account?.account_id ?? "",
  };
  try {
    if (payload.subscribe === 1) {
      let handled = false;
      const first = await sock.stream(payload, (msg) => {
        if (handled || !msg.proposal) return;
        handled = true;
        void onQuote(plan, msg, stake, currency, delivery).finally(() => sock.forget(msg.subscription?.id));
      });
      if (!handled && first.proposal) {
        await onQuote(plan, first, stake, currency, delivery);
        sock.forget(first.subscription?.id);
      }
    } else {
      const msg = await sock.request(payload);
      await onQuote(plan, msg, stake, currency, delivery);
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : "Quote failed.";
    const next = depth < 2 && plan.request ? adaptQuote(plan.request, text) : null;
    if (next) {
      plan.request = next;
      inFlight.delete(key);
      await pricePlan(plan, depth + 1);
      return;
    }
    muted.set(key, Date.now() + 45_000);
    noteDesk({ proposalNote: text, executionNote: text });
    pushOpp({
      plan,
      stake,
      currency,
      payout: null,
      ask: null,
      ev: null,
      edge: null,
      note: text,
      reasons: [text],
      tradable: false,
    });
  } finally {
    inFlight.delete(key);
  }
}

function stillAuthorized(capturedAccountId: string, intent: "auto" | "approve"): boolean {
  const state = useDesk.getState();
  const account = state.accounts.find((row) => row.account_id === state.accountId) ?? null;
  const autoReady = autoExecutionReady({
    tradeType: state.tradeType,
    mode: state.mode,
    emergency: state.emergency,
    trading: state.trading,
    accountType: account?.account_type ?? null,
    accountId: account?.account_id ?? null,
    armDemo: state.armDemo,
    armReal: state.armReal,
    armedAccountId: state.armedAccountId,
  });
  const allowed = purchaseStillAuthorized({
    intent,
    capturedAccountId,
    currentAccountId: state.accountId,
    socketOpen: tradeSock.connected,
    emergency: state.emergency,
    autoReady,
  });
  if (!allowed.ok) {
    noteDesk({ executionNote: allowed.reason });
    log("warn", allowed.reason);
  }
  return allowed.ok;
}

async function onQuote(
  plan: Plan,
  msg: DerivMsg,
  stake: number,
  currency: string,
  delivery: { streaming: boolean; source: QuoteSource; intent: ExecutionIntent; accountId: string },
) {
  const proposal = msg.proposal;
  const ask = num(proposal?.ask_price) ?? stake;
  const payout = num(proposal?.payout);
  let ev: number | null = null;
  let edge: number | null = null;
  let note = plan.note;
  if ((plan.family === "accumulator" || plan.family === "multiplier" || plan.family === "lookback") && !(payout != null && payout > 0)) {
    ev = plan.modelEv;
    edge = ev != null && ask > 0 ? ev / ask : null;
    note = plan.modelEv == null ? "No fixed payout on this quote, so it cannot be bought automatically." : plan.note;
  } else {
    const settled = settleEv(plan, payout ?? 0, ask);
    ev = settled.ev;
    edge = settled.edge;
    note = plan.note;
  }
  if (plan.family === "digit") {
    const money = digitQuoteBreakdown({ ask, payout, probability: plan.pCons, contract: plan.type });
    note = `${note} ${money.text}`;
  }
  const minStake = num(proposal?.validation_params?.stake?.min);
  const reasons: string[] = [];
  if (minStake != null && stake + 1e-9 < minStake) reasons.push(`Minimum stake is ${minStake}.`);
  const strategyReason = strategyReasonFor(plan, ev, payout, stake);
  if (strategyReason) reasons.push(strategyReason);
  const tradable = reasons.length === 0;
  pushOpp({
    plan,
    stake: ask,
    currency,
    payout,
    ask,
    ev,
    edge,
    note: proposal?.longcode || note,
    reasons,
    tradable,
  });
  const proposalId = proposal?.id?.trim() ?? "";
  const decision = await fulfillQuote({
    seen: purchasedIds,
    quote: {
      source: delivery.source,
      intent: delivery.intent,
      streaming: delivery.streaming,
      proposalId,
      blockers: reasons,
      mode: useDesk.getState().mode,
      alreadyPurchased: proposalId ? purchasedIds.has(proposalId) : false,
    },
    buy: async (id, buyIntent) => {
      if (!stillAuthorized(delivery.accountId, buyIntent)) return;
      await sendBuy(id, ask, plan, stake, currency, ev, buyIntent);
    },
  });
  if (decision.action === "skip") {
    noteDesk({
      proposalNote: proposalId ? `Proposal ${proposalId} was received and not purchased.` : "The proposal was received and not purchased.",
      executionNote: decision.reason,
    });
  } else {
    noteDesk({ proposalNote: `Proposal ${decision.proposalId} was accepted for purchase.` });
  }
  if (delivery.streaming && useDesk.getState().mode !== "auto") tradeSock.forget(msg.subscription?.id);
}

async function execute(plan: Plan, intent: "approve" | "auto") {
  if (!plan.request) return;
  if (!tradeSock.connected) {
    log("warn", "Connect a demo or real account before sending an order.");
    return;
  }
  const state = useDesk.getState();
  const account = state.accounts.find((a) => a.account_id === state.accountId) ?? null;
  if (!account) return;
  const stake = orderStake(state.risk, account.balance, lossStreak(state.journal, state.accountId)) ?? state.risk.fixedStake;
  const payload = buildProposalPayload(plan.request, plan.symbol, stake, account.currency, true);
  const streaming = payload.subscribe === 1;
  const take = async (msg: DerivMsg) => {
    const proposalId = msg.proposal?.id?.trim() ?? "";
    if (!proposalId) return;
    const ask = num(msg.proposal?.ask_price) ?? stake;
    const payout = num(msg.proposal?.payout);
    const settled = payout != null && payout > 0 ? settleEv(plan, payout, ask) : { ev: plan.modelEv, edge: null, reason: plan.note };
    await fulfillQuote({
      seen: purchasedIds,
      quote: {
        source: "trading",
        intent,
        streaming,
        proposalId,
        blockers: [],
        mode: useDesk.getState().mode,
        alreadyPurchased: purchasedIds.has(proposalId),
      },
      buy: async (id, buyIntent) => {
        if (!stillAuthorized(account.account_id, buyIntent)) return;
        await sendBuy(id, ask, plan, stake, account.currency, settled.ev, buyIntent);
      },
    });
  };
  if (!streaming) {
    const msg = await tradeSock.request(payload);
    await take(msg);
    return;
  }
  let handled = false;
  const msg = await tradeSock.stream(payload, (update) => {
    if (handled || !update.proposal?.id) return;
    handled = true;
    void take(update).finally(() => tradeSock.forget(update.subscription?.id));
  });
  if (!handled && msg.proposal?.id) {
    await take(msg);
    tradeSock.forget(msg.subscription?.id);
  }
}

async function sendBuy(
  proposalId: string,
  price: number,
  plan: Plan,
  stake: number,
  currency: string,
  ev: number | null,
  intent: "approve" | "auto",
) {
  const state = useDesk.getState();
  if (intent === "auto") {
    if (!state.tradeType) {
      const why = "Choose the contract the bot trades. Full auto will not buy until one is selected.";
      noteDesk({ executionNote: why });
      log("warn", why);
      return;
    }
    if (plan.type !== state.tradeType) {
      noteDesk({ executionNote: `${plan.name} is not the selected contract, so it was not purchased.` });
      return;
    }
  }
  const openNow = scopedOpenCount(state.journal, state.accountId);
  const capNow = entryCap(state.batchSize);
  const lock = state.batchLock;
  const key = signalKey(plan);
  if (slotsUsed(openNow, state.attempts, state.accountId) + buysInFlight >= capNow) {
    noteDesk({ executionNote: capNow === 1 ? "One contract is already open. The next entry waits until it finishes." : `Batch is full. ${openNow} contracts are open.` });
    return;
  }
  if (!batchAccepts(capNow > 1 ? lock : null, key, buysInFlight)) {
    noteDesk({ executionNote: "This batch does not accept another contract yet." });
    return;
  }
  if (batchWouldExceed(lock, key, state.attempts, state.accountId, capNow)) {
    noteDesk({ executionNote: "This purchase would put the batch over its size, so it was not sent." });
    return;
  }
  buysInFlight += 1;
  const flight = `${plan.symbol}:${plan.type}`;
  let account = state.accounts.find((a) => a.account_id === state.accountId) ?? null;
  let pending: BuyAttempt | null = null;
  try {
    const blocked = strategyReasonFor(plan, ev, null, price);
    if (blocked) {
      noteDesk({ executionNote: blocked });
      log("warn", `${plan.name} on ${plan.symbol} blocked. ${blocked}`);
      return;
    }
    const accountNow = state.accounts.find((a) => a.account_id === state.accountId) ?? null;
    account = accountNow;
    if (account?.account_type === "real") {
      const allowed = realBuyAllowed({
        accountType: "real",
        accountId: account.account_id,
        armReal: state.armReal,
        armedAccountId: state.armedAccountId,
      });
      if (!allowed.ok) {
        noteDesk({ executionNote: allowed.reason });
        log("warn", allowed.reason);
        return;
      }
    }
    const exposure = plan.request?.multiplier ? price * plan.request.multiplier : null;
    const gate = tradeGate({
      mode: state.mode,
      intent,
      emergency: state.emergency,
      accountType: account?.account_type ?? null,
      armDemo: state.armDemo,
      armReal: state.armReal,
      ev,
      stake: price,
      openTrades: openNow,
      dailyPnl: realizedToday(state.journal, Date.now(), account?.account_id),
      consecutiveLosses: lossStreak(state.journal, account?.account_id),
      balance: account?.balance ?? null,
      equityPeak: state.equityPeak,
      lastLossAt: latestLossAt(state.journal, account?.account_id),
      now: Date.now(),
      risk: { ...state.risk, maxOpenTrades: entryCap(state.batchSize) },
      exposure,
    });
    if (!gate.ok) {
      const why = gate.reasons[0] ?? "The risk gate blocked this purchase.";
      noteDesk({ executionNote: why });
      log("warn", `${plan.name} on ${plan.symbol} blocked. ${why}`);
      return;
    }
    if (!account || inFlight.has(`buy:${flight}`)) return;
    const blocking = blockingAttempt(useDesk.getState().attempts, account.account_id, key);
    if (blocking) {
      const checked = await reconcileStoredAttempt(blocking);
      if (checked.contractId && checked.status === "confirmed") {
        acceptReconciled(checked.contractId, plan, price, currency, ev, account, flight, checked.transactionId);
        return;
      }
      if (checked.status !== "failed") {
        noteDesk({ executionNote: checked.note });
        log("warn", checked.note);
        patch({ buyHold: checked.note });
        return;
      }
    }
    pending = createAttempt({
      id: `buy-${Date.now().toString(36)}-${attemptSeq++}`,
      accountId: account.account_id,
      accountType: account.account_type,
      contractType: plan.type,
      symbol: plan.symbol,
      stake: price,
      strategy: plan.name,
      signalKey: key,
      at: Date.now(),
    });
    saveAttempt(pending);
    log("info", `Purchase attempt ${pending.id} for ${plan.name} on ${plan.symbol}. Stake ${price} ${currency}.`);
    inFlight.add(`buy:${flight}`);
    const attemptId = pending.id;
    const msg = await tradeSock.request(
      { buy: proposalId, price },
      12000,
      (late) => {
        applyLateBuy(attemptId, late);
      },
      { attemptId, accountId: account.account_id },
    );
    const contractId = String(msg.buy?.contract_id ?? "");
    const transactionId = msg.buy?.transaction_id != null ? String(msg.buy.transaction_id) : undefined;
    if (!contractId) {
      pending = markUncertain(pending, "The buy response did not include a contract id. It will be checked before another purchase.");
      saveAttempt(pending);
      noteDesk({ executionNote: pending.note, proposalNote: `Purchase ${pending.id} is unresolved.` });
      log("warn", `Uncertain purchase ${pending.id}. ${pending.note}`);
      const checked = await reconcileStoredAttempt(pending);
      if (checked.contractId && checked.status === "confirmed") {
        acceptReconciled(checked.contractId, plan, price, currency, ev, account, flight, checked.transactionId);
      }
      return;
    }
    pending = confirmAttempt(pending, contractId, transactionId);
    saveAttempt(pending);
    tradeSock.releasePurchase(pending.id);
    const added = commitOpen(contractId, plan, price, currency, ev, account, transactionId, num(msg.buy?.payout));
    const after = num(msg.buy?.balance_after);
    if (after != null) applyBalance(account.account_id, after, currency);
    patch({ buyHold: null });
    noteDesk({ proposalNote: `Purchase confirmed. Contract ${contractId}.`, executionNote: null });
    log("good", added ? `Confirmed purchase ${pending.id}. Contract ${contractId}.` : `Confirmed purchase ${pending.id} was already recorded. It was not added again.`);
    const started = useDesk.getState().batchLock;
    if (started && started.ids.length === 1 && started.ids[0] === contractId) {
      log("info", `Batch locked to ${started.label}. Later signals wait until it settles.`);
    }
    void watchContract(contractId, flight);
    void refreshAccounts(false);
  } catch (err) {
    const text = err instanceof Error ? err.message : "Buy failed.";
    const live = pending ? useDesk.getState().attempts.find((row) => row.id === pending?.id) : undefined;
    if (live && (live.status === "confirmed" || live.status === "settled" || live.contractId)) {
      if (account && live.contractId) acceptReconciled(live.contractId, plan, price, currency, ev, account, flight, live.transactionId);
      return;
    }
    if (live?.status === "failed") {
      patch({ buyHold: null });
      return;
    }
    if (account && pending && classifyBuyError(text) === "uncertain") {
      pending = markUncertain(live ?? pending, "The buy response was lost. Checking this account before another purchase.");
      saveAttempt(pending);
      log("warn", `Uncertain purchase ${pending.id}. ${pending.note}`);
      const checked = await reconcileStoredAttempt(pending);
      if (checked.contractId && (checked.status === "confirmed" || checked.status === "settled")) {
        acceptReconciled(checked.contractId, plan, price, currency, ev, account, flight, checked.transactionId);
      } else if (checked.status === "failed") {
        log("warn", `Rejected purchase ${checked.id}. ${checked.note}`);
        patch({ buyHold: null });
      } else {
        patch({ buyHold: checked.note });
      }
    } else if (pending) {
      pending = markFailed(pending, text);
      saveAttempt(pending);
      tradeSock.releasePurchase(pending.id);
      log("bad", `Rejected purchase ${pending.id}. ${text}`);
      patch({ buyHold: null });
    } else {
      log("bad", text);
    }
  } finally {
    buysInFlight = Math.max(0, buysInFlight - 1);
    inFlight.delete(`buy:${flight}`);
  }
}

async function watchContract(contractId: string, _flight: string) {
  const owner = useDesk.getState().journal.find((row) => row.contractId === contractId)?.accountId;
  if (!owner || !canManageContract(owner, useDesk.getState().accountId)) {
    log("warn", "That contract belongs to another account, so this connection will not manage it.");
    return;
  }
  const watchKey = `${owner}:${contractId}`;
  if (watched.has(watchKey)) return;
  if (!tradeSock.connected) return;
  watched.add(watchKey);
  try {
    await tradeSock.stream(
      { proposal_open_contract: 1, contract_id: contractField(contractId), subscribe: 1 },
      (msg) => {
        if (!canManageContract(owner, useDesk.getState().accountId)) {
          tradeSock.forget(msg.subscription?.id);
          return;
        }
        const contract = msg.proposal_open_contract;
        if (!contract) return;
        if (recordContractUpdate(contractId, owner, contract) === "closed") {
          tradeSock.forget(msg.subscription?.id);
          watched.delete(watchKey);
        }
      },
    );
  } catch (err) {
    watched.delete(watchKey);
    log("warn", err instanceof Error ? err.message : `Recovery failed for contract ${contractId}.`);
  }
}

function contractSold(contract: OpenContract): boolean {
  return (
    contract.is_sold === 1 ||
    contract.is_sold === true ||
    contract.status === "sold" ||
    contract.status === "won" ||
    contract.status === "lost"
  );
}

function recordContractUpdate(contractId: string, owner: string, contract: OpenContract): "open" | "pending" | "closed" {
  const profit = num(contract.profit);
  const payout = num(contract.payout);
  const sold = contractSold(contract);
  let changed = false;
  useDesk.setState((s) => ({
    journal: s.journal.map((row) => {
      if (row.contractId !== contractId || row.accountId !== owner) return row;
      const next = applySettlement(row, {
        sold,
        profit,
        payout,
        closedAt: Date.now(),
        audit: {
          profit,
          payout,
          contractStatus: typeof contract.status === "string" ? contract.status : undefined,
          isSold: sold,
        },
      });
      if (next.status !== row.status || next.profit !== row.profit || next.note !== row.note) changed = true;
      return next;
    }),
    attempts: s.attempts.map((row) =>
      row.contractId === contractId && (row.status === "confirmed" || row.status === "settled") && sold && profit != null
        ? markSettled(row)
        : row,
    ),
  }));
  const status = settlementStatus(sold, profit);
  if (status === "won" || status === "lost" || status === "sold") {
    if (changed && profit != null && profit < 0) patch({ lastLossAt: Date.now() });
    if (changed) {
      persist();
      log(status === "won" ? "good" : "warn", `Final settlement ${contractId}: ${status} at ${profit}.`);
      releaseSettledBatch();
      void refreshAccounts(false);
    }
    return "closed";
  }
  if (sold) {
    if (changed) {
      persist();
      log("warn", `Settlement pending for ${contractId}. Profit was missing, so it was not marked lost.`);
    }
    return "pending";
  }
  return "open";
}

function pushOpp(input: {
  plan: Plan;
  stake: number;
  currency: string;
  payout: number | null;
  ask: number | null;
  ev: number | null;
  edge: number | null;
  note: string;
  reasons: string[];
  tradable: boolean;
}) {
  const id = `${input.plan.symbol}:${input.plan.type}:${input.plan.request?.barrier ?? ""}:${input.plan.request?.selected_tick ?? ""}`;
  const row: Opportunity = {
    id,
    symbol: input.plan.symbol,
    type: input.plan.type,
    name: input.plan.name,
    family: input.plan.family,
    at: Date.now(),
    stake: input.stake,
    payout: input.payout,
    ask: input.ask,
    ev: input.ev,
    edge: input.edge,
    pCons: input.plan.pCons,
    pModel: input.plan.pModel,
    longcode: input.note,
    note: input.plan.note,
    reasons: input.reasons,
    tradable: input.tradable,
    request: input.plan.request,
    currency: input.currency,
  };
  useDesk.setState((s) => {
    const rest = s.opportunities.filter((item) => item.id !== id);
    return { opportunities: [row, ...rest].slice(0, 40) };
  });
}

function planFromOpp(opp: Opportunity): Plan {
  return {
    symbol: opp.symbol,
    type: opp.type,
    name: opp.name,
    family: opp.family as Plan["family"],
    summary: "",
    status: "pricing",
    note: opp.note,
    rationale: [],
    pModel: opp.pModel,
    pCons: opp.pCons,
    modelEv: opp.family === "accumulator" ? opp.ev : null,
    request: opp.request,
    diagnostics: [],
  };
}

async function adoptAccounts() {
  if (!secret || !kind) return;
  const accounts = await fetchAccounts(secret, kind, useDesk.getState().appId);
  const current = useDesk.getState().accountId;
  const still = accounts.some((a) => a.account_id === current);
  const accountId =
    (still ? current : null) ??
    accounts.find((a) => a.account_type === "demo")?.account_id ??
    accounts[0]?.account_id ??
    null;
  useDesk.setState((s) => {
    const merged = mergeAccounts(accounts, s.accounts);
    const picked = merged.find((a) => a.account_id === accountId) ?? null;
    const equityPeaks =
      picked && Number.isFinite(picked.balance) ? bumpPeak(s.equityPeaks, picked.account_id, picked.balance) : s.equityPeaks;
    const switched = Boolean(current && current !== accountId);
    const off = switched ? armAfterAccountChange() : null;
    return {
      auth: "ready",
      authError: null,
      accounts: merged,
      accountId,
      equityPeaks,
      equityPeak: accountId ? (equityPeaks[accountId] ?? null) : null,
      ...(off ? { armReal: off.armReal, armedAccountId: off.armedAccountId, realPhrase: "", buyHold: null } : {}),
    };
  });
  rememberSecret();
  persist();
  if (accountId) await openTrading(accountId);
}

async function refreshAccounts(announce: boolean) {
  if (!secret || !kind) return;
  try {
    const accounts = await fetchAccounts(secret, kind, useDesk.getState().appId);
    const chosen = accounts.find((a) => a.account_id === useDesk.getState().accountId) ?? null;
    useDesk.setState((s) => {
      const merged = mergeAccounts(accounts, s.accounts);
      const picked = merged.find((a) => a.account_id === s.accountId) ?? chosen;
      const equityPeaks =
        picked && Number.isFinite(picked.balance) ? bumpPeak(s.equityPeaks, picked.account_id, picked.balance) : s.equityPeaks;
      return {
        accounts: merged,
        equityPeaks,
        equityPeak: s.accountId ? (equityPeaks[s.accountId] ?? null) : s.equityPeak,
      };
    });
    if (announce) log("info", "Balance refreshed from Deriv.");
  } catch (err) {
    log("warn", err instanceof Error ? err.message : "Balance refresh failed.");
  }
}

async function openTrading(accountId: string) {
  if (!secret || !kind) return;
  const gen = ++tradeGen;
  patch({ trading: "connecting" });
  tradeSock.close();
  if (gen !== tradeGen || !secret) return;
  try {
    const url = await fetchTradingUrl(secret, kind, useDesk.getState().appId, accountId);
    if (gen !== tradeGen || !secret) return;
    await tradeSock.connect(url);
    if (gen !== tradeGen || !secret) return;
    patch({ trading: "live" });
    log("good", `Trading socket live for ${accountId}.`);
    log("info", `Recovery in progress for ${accountId}. Open contracts stay tracked. Unresolved purchases are checked before another buy.`);
    watchBalance(accountId);
    watched.clear();
    await recoverAccount(accountId);
    void tradeSock.untilClosed().then(() => {
      if (gen !== tradeGen || !secret) return;
      watched.clear();
      patch({ trading: "off" });
      log("warn", "Trading connection dropped. Reconnecting.");
      window.setTimeout(() => {
        if (gen !== tradeGen || !secret) return;
        log("info", `Reconnection attempt for ${accountId}.`);
        void openTrading(accountId);
      }, 1500);
    });
  } catch (err) {
    if (gen !== tradeGen) return;
    patch({ trading: "off" });
    log("bad", err instanceof Error ? err.message : "Trading socket failed.");
  }
}

function mergeAccounts(incoming: Account[], previous: Account[]): Account[] {
  return incoming.map((row) => {
    if (Number.isFinite(row.balance)) return row;
    const prev = previous.find((item) => item.account_id === row.account_id);
    return prev && Number.isFinite(prev.balance) ? { ...row, balance: prev.balance } : row;
  });
}

function applyBalance(accountId: string, balance: number, currency?: string) {
  if (!Number.isFinite(balance)) return;
  useDesk.setState((s) => {
    const equityPeaks = bumpPeak(s.equityPeaks, accountId, balance);
    return {
      accounts: s.accounts.map((row) =>
        row.account_id === accountId
          ? { ...row, balance, currency: currency && currency !== "undefined" ? currency : row.currency }
          : row,
      ),
      equityPeaks,
      equityPeak: s.accountId === accountId ? (equityPeaks[accountId] ?? null) : s.equityPeak,
    };
  });
}

function watchBalance(accountId: string) {
  void tradeSock
    .stream({ balance: 1, subscribe: 1 }, (msg) => {
      const balance = num(msg.balance?.balance);
      if (balance == null) return;
      applyBalance(accountId, balance, msg.balance?.currency);
    })
    .catch((err: unknown) => {
      log("warn", err instanceof Error ? err.message : "Balance stream failed.");
    });
}

async function resumeCredential() {
  const sessionTok = sessionStorage.getItem(TOKEN_KEY);
  const savedTok = localStorage.getItem(TOKEN_KEY);
  const raw = sessionTok || savedTok;
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { token?: string; kind?: CredentialKind };
    if (!parsed.token || !parsed.kind) return;
    secret = parsed.token;
    kind = parsed.kind;
    patch({ auth: "checking", credential: parsed.kind });
    await adoptAccounts();
  } catch (err) {
    failAuth(err);
  }
}

async function maybeOAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get("error_description") || params.get("error");
  const code = params.get("code");
  const state = params.get("state");
  if (!oauthError && !code) return;
  stripAuthQuery();
  if (oauthError) {
    patch({ auth: "error", authError: oauthError });
    log("bad", oauthError);
    return;
  }
  if (!code || !state) return;
  const raw = sessionStorage.getItem(PKCE_KEY);
  if (!raw) {
    patch({ auth: "error", authError: "OAuth session expired before the redirect returned." });
    return;
  }
  const saved = JSON.parse(raw) as { verifier?: string; state?: string; clientId?: string };
  sessionStorage.removeItem(PKCE_KEY);
  if (!saved.verifier || !saved.clientId || saved.state !== state) {
    patch({ auth: "error", authError: "OAuth state did not match. Start the connection again." });
    return;
  }
  patch({ auth: "checking", clientId: saved.clientId, credential: "oauth" });
  const result = await exchangeOAuthCode({
    data: {
      code,
      verifier: saved.verifier,
      clientId: saved.clientId,
      redirectUri: redirectUri(),
    },
  });
  if (!result.ok) {
    patch({ auth: "error", authError: result.error });
    return;
  }
  secret = result.accessToken;
  kind = "oauth";
  try {
    await adoptAccounts();
  } catch (err) {
    failAuth(err);
  }
}

function failAuth(err: unknown) {
  secret = "";
  kind = null;
  sessionStorage.removeItem(TOKEN_KEY);
  const text = err instanceof Error ? err.message : "Account connection failed.";
  patch({ auth: "error", authError: text, trading: "off", accounts: [] });
  log("bad", text);
}

function rememberSecret() {
  const payload = JSON.stringify({ token: secret, kind });
  sessionStorage.setItem(TOKEN_KEY, payload);
  if (useDesk.getState().remember) localStorage.setItem(TOKEN_KEY, payload);
  else localStorage.removeItem(TOKEN_KEY);
}

function persist(): boolean {
  try {
    const s = useDesk.getState();
    const body = {
      risk: s.risk,
      journal: s.journal,
      mode: s.mode,
      enabled: s.enabled,
      tradeType: s.tradeType,
      digitPick: s.digitPick,
      focus: s.focus,
      appId: s.appId,
      clientId: s.clientId,
      remember: s.remember,
      accountId: s.accountId,
      lastLossAt: s.lastLossAt,
      sessionResetAt: s.sessionResetAt,
      batchSize: s.batchSize,
      batchLock: s.batchLock,
      equityPeaks: s.equityPeaks,
      moduleNotes: s.moduleNotes,
      attempts: s.attempts,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(body));
    return true;
  } catch {
    return false;
  }
}

function hydrate() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      patch({ booted: true });
      return;
    }
    const saved = JSON.parse(raw) as Partial<{
      risk: DeskRisk;
      journal: JournalTrade[];
      mode: TradeMode;
      enabled: Record<string, boolean>;
      tradeType: string | null;
      digitPick: number | null;
      focus: string[];
      appId: string;
      clientId: string;
      remember: boolean;
      accountId: string;
      armDemo: boolean;
      lastLossAt: number | null;
      sessionResetAt: number;
      batchSize: number;
      batchLock: BatchLock | null;
      equityPeaks: Record<string, number>;
      moduleNotes: Record<string, Record<string, string>>;
      attempts: BuyAttempt[];
      armReal?: boolean;
      armedAccountId?: string | null;
    }>;
    const peaks = saved.equityPeaks && typeof saved.equityPeaks === "object" ? saved.equityPeaks : {};
    const notes = saved.moduleNotes && typeof saved.moduleNotes === "object" ? saved.moduleNotes : {};
    const attempts = restoreAttempts(saved.attempts);
    useDesk.setState((s) => {
      const accountId = saved.accountId ?? s.accountId;
      const pending = attempts.find((row) => row.accountId === accountId && isUnresolved(row.status));
      return {
      booted: true,
      risk: saved.risk ? { ...s.risk, ...saved.risk } : s.risk,
      journal: Array.isArray(saved.journal) ? keepJournalOwnership(saved.journal) : s.journal,
      mode: saved.mode ?? s.mode,
      enabled: saved.enabled ? { ...s.enabled, ...saved.enabled } : s.enabled,
      tradeType: saved.tradeType && CONTRACT_BY_TYPE.has(saved.tradeType) ? saved.tradeType : null,
      digitPick: restoreDigitPick(saved.digitPick),
      focus: saved.focus?.length ? saved.focus : s.focus,
      appId: saved.appId ?? s.appId,
      clientId: saved.clientId?.trim() ? saved.clientId : s.clientId,
      remember: saved.remember ?? s.remember,
      accountId,
      armDemo: false,
      ...armFromStorage(saved),
      buyHold: pending?.note ?? null,
      equityPeaks: peaks,
      equityPeak: accountId ? (peaks[accountId] ?? null) : null,
      moduleNotes: notes,
      attempts,
      lastLossAt: saved.lastLossAt ?? null,
      sessionResetAt: saved.sessionResetAt ?? 0,
      batchSize: entryCap(saved.batchSize ?? 1),
      batchLock: saved.batchLock && saved.batchLock.key && Array.isArray(saved.batchLock.ids) ? saved.batchLock : null,
    };
    });
  } catch {
    patch({ booted: true });
  }
}

type DeskRisk = ReturnType<typeof useDesk.getState>["risk"];

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function evidenceRow(row: Record<string, unknown>): ContractEvidence | null {
  const contractId = String(row.contract_id ?? "");
  if (!contractId) return null;
  const price = num(row.buy_price);
  const purchase = num(row.purchase_time) ?? num(row.date_start);
  return {
    contractId,
    symbol: String(row.symbol ?? row.underlying_symbol ?? ""),
    contractType: String(row.contract_type ?? ""),
    buyPrice: price,
    purchaseTime: purchase,
    transactionId: row.transaction_id != null ? String(row.transaction_id) : null,
  };
}

async function readEvidence(attempt: BuyAttempt): Promise<{ portfolio: ContractEvidence[] | null; history: ContractEvidence[] | null; historyComplete: boolean }> {
  let portfolio: ContractEvidence[] | null = null;
  try {
    const msg = await tradeSock.request({ portfolio: 1 });
    const book = msg.portfolio as { contracts?: Array<Record<string, unknown>> } | undefined;
    portfolio = (book?.contracts ?? []).map(evidenceRow).filter((row): row is ContractEvidence => row != null);
  } catch {
    portfolio = null;
  }
  const fromSec = Math.max(0, Math.floor((attempt.at - 15_000) / 1000));
  const limit = 50;
  const pages: HistoryPage[] = [];
  try {
    for (let page = 0; page < 3; page++) {
      const msg = await tradeSock.request({
        profit_table: 1,
        description: 1,
        limit,
        offset: page * limit,
        sort: "DESC",
        date_from: String(fromSec),
      });
      const table = msg.profit_table?.transactions ?? [];
      const rows = table.map((row) => evidenceRow(row as unknown as Record<string, unknown>)).filter((row): row is ContractEvidence => row != null);
      pages.push({ rows, received: table.length, limit });
      if (table.length < limit) break;
    }
  } catch {
    const partial = assembleHistory(pages.length ? pages : null);
    return { portfolio, history: partial.rows, historyComplete: false };
  }
  const history = assembleHistory(pages);
  return { portfolio, history: history.rows, historyComplete: history.complete };
}

async function reconcileStoredAttempt(attempt: BuyAttempt): Promise<BuyAttempt> {
  const current = useDesk.getState().attempts.find((row) => row.id === attempt.id) ?? attempt;
  if (current.status === "confirmed" || current.status === "settled" || current.status === "failed" || current.contractId) return current;
  if (!canManageContract(current.accountId, useDesk.getState().accountId)) {
    log("warn", `Purchase ${current.id} belongs to another account, so this connection did not check it.`);
    return current;
  }
  const checking = markReconciling(current);
  saveAttempt(checking);
  log("info", `Reconciliation attempt ${current.id} on ${current.accountId}.`);
  const evidence = await readEvidence(current);
  const during = useDesk.getState().attempts.find((row) => row.id === attempt.id);
  if (during && (during.status === "confirmed" || during.status === "settled" || during.status === "failed" || during.contractId)) return during;
  const state = useDesk.getState();
  const known = [
    ...state.journal.filter((row) => row.accountId === current.accountId).map((row) => row.contractId),
    ...state.attempts.filter((row) => row.id !== current.id && row.contractId).map((row) => row.contractId as string),
  ];
  const result = reconcileAttempt({
    attempt: during ?? checking,
    portfolio: evidence.portfolio,
    history: evidence.history,
    knownIds: known,
    historyComplete: evidence.historyComplete,
  });
  const again = useDesk.getState().attempts.find((row) => row.id === attempt.id);
  if (again && (again.status === "confirmed" || again.status === "settled" || again.status === "failed" || again.contractId)) return again;
  saveAttempt(result.attempt);
  if (result.attempt.status === "confirmed" || result.attempt.status === "failed") tradeSock.releasePurchase(result.attempt.id);
  if (result.attempt.status === "confirmed") log("info", `Reconciliation found contract ${result.attempt.contractId} for ${attempt.id}.`);
  else if (result.attempt.status === "failed") log("warn", `Reconciliation found no contract for ${attempt.id}.`);
  else log("warn", `Reconciliation for ${attempt.id} is still unresolved.`);
  return result.attempt;
}

function applyLateBuy(attemptId: string, msg: DerivMsg) {
  const attempt = useDesk.getState().attempts.find((row) => row.id === attemptId);
  if (!attempt || (!isUnresolved(attempt.status) && !attempt.contractId)) return;
  if (attempt.status === "confirmed" || attempt.status === "settled") return;
  const errorText = msg.error?.message?.trim();
  if (errorText) {
    if (classifyBuyError(errorText) === "rejected") {
      const failed = markFailed(attempt, errorText);
      saveAttempt(failed);
      tradeSock.releasePurchase(attempt.id);
      if (useDesk.getState().accountId === attempt.accountId) patch({ buyHold: null });
      log("bad", `Rejected purchase ${failed.id}. ${errorText}`);
    }
    return;
  }
  const contractId = String(msg.buy?.contract_id ?? "");
  if (!contractId) return;
  const transactionId = msg.buy?.transaction_id != null ? String(msg.buy.transaction_id) : undefined;
  const confirmed = confirmAttempt(attempt, contractId, transactionId);
  saveAttempt(confirmed);
  tradeSock.releasePurchase(attempt.id);
  const account = useDesk.getState().accounts.find((row) => row.account_id === attempt.accountId) ?? null;
  if (!account) {
    log("warn", `A late response confirmed purchase ${attemptId} as contract ${contractId}. That account is not loaded, so it was not bought again.`);
    return;
  }
  const selected = useDesk.getState().accountId === account.account_id;
  const added = commitOpen(
    contractId,
    planFromAttempt(confirmed),
    confirmed.stake,
    account.currency,
    null,
    account,
    transactionId,
    num(msg.buy?.payout),
    selected,
    confirmed.at || Date.now(),
  );
  if (selected) {
    patch({ buyHold: null });
    void watchContract(contractId, `${confirmed.symbol}:${confirmed.contractType}`);
  }
  log("info", added ? `Late purchase response accepted contract ${contractId} for ${attemptId}. It was not sent again.` : `Late purchase response matched contract ${contractId}, which was already recorded.`);
}

async function recoverAccount(accountId: string) {
  const state = useDesk.getState();
  for (const ref of tradeSock.purchaseRefs()) {
    if (ref.accountId !== accountId) continue;
    if (state.attempts.some((row) => row.id === ref.attemptId)) continue;
    log("warn", `Purchase ${ref.attemptId} on ${ref.accountId} is still unresolved after reconnect. It will not be sent again.`);
  }
  const pending = state.attempts.filter(
    (row) =>
      row.accountId === accountId &&
      (isUnresolved(row.status) ||
        (row.status === "confirmed" && Boolean(row.contractId) && !state.journal.some((item) => item.contractId === row.contractId))),
  );
  for (const attempt of pending) {
    try {
      const checked = isUnresolved(attempt.status) ? await reconcileStoredAttempt(attempt) : attempt;
      if (!checked.contractId || (checked.status !== "confirmed" && checked.status !== "settled")) continue;
      const live = useDesk.getState();
      if (live.journal.some((row) => row.contractId === checked.contractId)) continue;
      const account = live.accounts.find((row) => row.account_id === accountId) ?? null;
      if (!account || account.account_id !== checked.accountId) {
        log("warn", `Recovery found contract ${checked.contractId} for ${checked.id}, but this connection is not that account.`);
        continue;
      }
      const added = commitOpen(
        checked.contractId,
        planFromAttempt(checked),
        checked.stake,
        account.currency,
        null,
        account,
        checked.transactionId,
        null,
        false,
        checked.at || Date.now(),
      );
      log(
        "info",
        added
          ? `Recovered contract ${checked.contractId} for purchase ${checked.id}.`
          : `Contract ${checked.contractId} was already recorded.`,
      );
    } catch (err) {
      log("warn", err instanceof Error ? err.message : `Recovery failed for purchase ${attempt.id}.`);
    }
  }
  const latest = useDesk.getState();
  if (latest.accountId === accountId) {
    const still = latest.attempts.find((row) => row.accountId === accountId && isUnresolved(row.status));
    patch({ buyHold: still?.note ?? null });
  }
  const open = useDesk.getState().journal.filter((row) => row.status === "open" && row.accountId === accountId);
  const ids = subscriptionList(open, accountId);
  for (const contractId of ids) {
    const snap = await readContractOnce(contractId);
    const outcome = snap && canManageContract(accountId, useDesk.getState().accountId) ? recordContractUpdate(contractId, accountId, snap) : "unknown";
    if (outcome === "closed") continue;
    const row = useDesk.getState().journal.find((item) => item.contractId === contractId && item.accountId === accountId);
    if (!row || row.status !== "open") continue;
    log("info", `Contract subscription restored for ${contractId}.`);
    void watchContract(contractId, `${row.symbol}:${row.contractType}`);
  }
}

async function readContractOnce(contractId: string): Promise<OpenContract | null> {
  try {
    const msg = await tradeSock.request({ proposal_open_contract: 1, contract_id: contractField(contractId) });
    return msg.proposal_open_contract ?? null;
  } catch (err) {
    log("warn", err instanceof Error ? err.message : `Recovery failed for contract ${contractId}.`);
    return null;
  }
}

function planFromAttempt(attempt: BuyAttempt): Plan {
  const meta = CONTRACT_BY_TYPE.get(attempt.contractType);
  return {
    symbol: attempt.symbol,
    type: attempt.contractType,
    name: attempt.strategy || meta?.name || attempt.contractType,
    family: meta?.family ?? "digit",
    summary: "",
    status: "pricing",
    note: "Recovered after the buy response was lost.",
    rationale: [],
    pModel: null,
    pCons: null,
    modelEv: null,
    diagnostics: [],
  };
}

function saveAttempt(attempt: BuyAttempt) {
  useDesk.setState((s) => {
    const rest = s.attempts.filter((row) => row.id !== attempt.id);
    return { attempts: [attempt, ...rest].slice(0, 40), buyHold: isUnresolved(attempt.status) ? attempt.note : null };
  });
  persist();
}

function acceptReconciled(
  contractId: string,
  plan: Plan,
  price: number,
  currency: string,
  ev: number | null,
  account: Account,
  flight: string,
  transactionId?: string,
) {
  const added = commitOpen(contractId, plan, price, currency, ev, account, transactionId, null);
  patch({ buyHold: null });
  log("info", added ? `The original buy was already accepted as ${contractId}. It was not sent again.` : `Contract ${contractId} was already in the journal. It was not added again.`);
  void watchContract(contractId, flight);
}

function commitOpen(
  contractId: string,
  plan: Plan,
  price: number,
  currency: string,
  ev: number | null,
  account: Account,
  transactionId?: string,
  payout: number | null = null,
  lockBatch = true,
  openedAt = Date.now(),
): boolean {
  const row: JournalTrade = {
    id: contractId,
    contractId,
    symbol: plan.symbol,
    contractType: plan.type,
    accountType: account.account_type,
    accountId: account.account_id,
    stake: price,
    payout,
    currency,
    openedAt,
    status: "open",
    probability: plan.pCons,
    ev,
    note: plan.note,
    modules: plan.modules,
    transactionId,
  };
  let added = false;
  useDesk.setState((s) => {
    const next = addOpenContract(s.journal, row);
    added = next.added;
    if (!added) return {};
    if (!lockBatch) return { journal: next.journal };
    const cap = entryCap(s.batchSize);
    const key = signalKey(plan);
    let batchLock = s.batchLock;
    if (cap > 1 && (!batchLock || batchLock.key === key) && (batchLock?.ids.length ?? 0) < cap) {
      batchLock = batchLock ? { ...batchLock, ids: [...batchLock.ids, contractId] } : { key, label: signalLabel(plan), size: cap, ids: [contractId] };
    }
    return { journal: next.journal, batchLock };
  });
  persist();
  return added;
}

function contractField(id: string): number | string {
  return /^\d+$/.test(id) ? Number(id) : id;
}

function redirectUri(): string {
  return DERIV_REDIRECT_URI;
}

function stripAuthQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

function random(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function setRemember(remember: boolean) {
  patch({ remember });
  if (!remember) localStorage.removeItem(TOKEN_KEY);
  else if (secret && kind) rememberSecret();
  persist();
}

export function setAppId(appId: string) {
  patch({ appId });
  persist();
}

export function setClientId(clientId: string) {
  patch({ clientId });
  persist();
}
