import { DerivSocket } from "../deriv/socket.ts";
import { PUBLIC_WS } from "../deriv/types.ts";
import { lastDigit } from "../engine/math.ts";
import { bulkAccountForget, bulkAccountLive, bulkAccountRequest, bulkAccountStream } from "../desk/session.ts";
import { useDesk } from "../desk/store.ts";
import { ENGINE_IDS, scanMarket, type EngineId } from "./engines.ts";
import { type BulkTrade, profitFromPrices, readSettlement } from "./learn.ts";
import { payoutEv, qualifyOpportunity } from "./qualify.ts";
import { bulkRiskBlock } from "./risk.ts";
import { bulkLog, hydrateBulk, patchBulk, persistBulk, useBulk } from "./store.ts";
import { openLike } from "./guards.ts";

const sock = new DerivSocket();
const seenProposals = new Set<string>();
let loop: ReturnType<typeof setInterval> | null = null;
let feedGen = 0;
let buying = false;
let booted = false;
const watchedContracts = new Set<string>();

export { duplicateKey, openLike } from "./guards.ts";

export function bootBulk() {
  if (booted) return;
  booted = true;
  hydrateBulk();
  for (const row of useBulk.getState().trades) {
    if (row.status === "open" && row.contractId) void followContract(row.contractId, row.id);
  }
  void connectFeed();
  if (!loop) loop = setInterval(() => void cycle(), 3000);
}

async function connectFeed() {
  const gen = ++feedGen;
  patchBulk({ feed: "connecting", feedError: null });
  try {
    await sock.connect(PUBLIC_WS);
    if (gen !== feedGen) return;
    patchBulk({ feed: "live", feedError: null });
    bulkLog("good", "Bulk scanner connected. It does not use the main desk's tick list.");
    await discoverMarkets();
    await syncMarkets();
    await sock.untilClosed();
    if (gen !== feedGen) return;
    patchBulk({ feed: "down", feedError: "Bulk market feed disconnected." });
    bulkLog("bad", "Bulk market feed disconnected. New entries stay off until it returns.");
  } catch (err) {
    if (gen !== feedGen) return;
    const text = err instanceof Error ? err.message : "Bulk market feed failed.";
    patchBulk({ feed: "down", feedError: text });
    bulkLog("bad", text);
  }
  setTimeout(() => {
    if (gen === feedGen) void connectFeed();
  }, 4000);
}

export async function discoverMarkets() {
  if (!sock.connected) return;
  const msg = await sock.request({ active_symbols: "brief" });
  const rows = (msg.active_symbols ?? [])
    .filter((row) => row.market === "synthetic_index" && row.underlying_symbol)
    .map((row) => ({ symbol: row.underlying_symbol, name: row.underlying_symbol_name || row.underlying_symbol }));
  if (rows.length === 0) return;
  patchBulk({ discovered: rows });
  persistBulk();
}

export async function syncMarkets() {
  const symbols = useBulk.getState().enabledMarkets;
  for (const symbol of symbols) {
    if (!sock.connected) return;
    try {
      const history = await sock.request({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 500,
        end: "latest",
        start: 1,
        style: "ticks",
      });
      const prices = (history.history?.prices ?? []).map(Number).filter((n) => Number.isFinite(n));
      const pip = Number(history.pip_size);
      useBulk.setState((s) => ({
        quotes: { ...s.quotes, [symbol]: prices.slice(-500) },
        pip: Number.isFinite(pip) ? { ...s.pip, [symbol]: pip } : s.pip,
      }));
      void sock
        .stream({ ticks: symbol, subscribe: 1 }, (msg) => {
          const tick = msg.tick;
          if (!tick || tick.symbol !== symbol) return;
          const quote = Number(tick.quote);
          if (!Number.isFinite(quote)) return;
          const size = Number.isFinite(tick.pip_size) ? tick.pip_size : useBulk.getState().pip[symbol] ?? 2;
          useBulk.setState((s) => {
            const prev = s.quotes[symbol] ?? [];
            return {
              quotes: { ...s.quotes, [symbol]: [...prev, quote].slice(-500) },
              pip: { ...s.pip, [symbol]: size },
              latest: { ...s.latest, [symbol]: { quote, digit: lastDigit(quote, size), epoch: tick.epoch } },
            };
          });
        })
        .catch((err: unknown) => {
          bulkLog("bad", err instanceof Error ? err.message : `Could not stream ${symbol}.`);
        });
    } catch (err) {
      bulkLog("bad", err instanceof Error ? err.message : `${symbol} history failed.`);
    }
  }
}

export function setBulkRunning(on: boolean) {
  const account = currentAccount();
  if (on && account?.account_type === "real" && !useBulk.getState().realStarted) {
    patchBulk({ note: "Type START REAL in this tab before real-money auto trading." });
    return;
  }
  if (on && !account) {
    patchBulk({ note: "Connect an account on the main desk first. This tab does not store a token." });
    return;
  }
  patchBulk({ running: on, stopped: on ? false : useBulk.getState().stopped, note: on ? "Auto trading is on for this tab only." : "Auto trading paused. Open contracts are still watched." });
  bulkLog("info", on ? "Bulk auto trading started." : "Bulk auto trading paused.");
}

export function stopAllBulk() {
  patchBulk({ running: false, stopped: true, note: "Stop All. No new bulk order will be sent." });
  bulkLog("bad", "Bulk Stop All. New entries are blocked.");
}

export function resumeBulk() {
  patchBulk({ stopped: false, note: "Stop cleared. Auto trading stays off until you start it." });
}

function currentAccount() {
  const desk = useDesk.getState();
  return desk.accounts.find((row) => row.account_id === desk.accountId) ?? null;
}

function enabledEngines(): EngineId[] {
  const engines = useBulk.getState().engines;
  return ENGINE_IDS.filter((id) => engines[id]);
}

async function cycle() {
  const state = useBulk.getState();
  const engines = enabledEngines();
  const rows = state.enabledMarkets.flatMap((market) => {
    const quotes = state.quotes[market] ?? [];
    const pip = state.pip[market] ?? 2;
    return scanMarket(quotes, pip, engines, state.risk.minSample).map((row) => ({
      ...row,
      market,
      ev: null as number | null,
      payout: null as number | null,
    }));
  });
  patchBulk({ opportunities: rows.filter((row) => row.qualified).slice(0, 24).concat(rows.filter((row) => !row.qualified).slice(0, 12)) });
  await watchOpen();
  if (!state.running || state.stopped || buying) return;
  const ranked = rows.filter((row) => row.qualified).sort((a, b) => b.lo - a.lo);
  const next = ranked.find((row) => !openLike(useBulk.getState().trades, row.market, row.contract, row.barrier));
  if (!next) return;
  await proposeAndBuy(next.market, next.contract, next.barrier, next.lo, next.engine, next.estimated);
}

async function proposeAndBuy(market: string, contract: string, barrier: string, lo: number, engine: EngineId, estimated: number) {
  const state = useBulk.getState();
  const account = currentAccount();
  if (!account || !bulkAccountLive()) {
    patchBulk({ note: "The account socket is not open, so no proposal was sent." });
    return;
  }
  if (account.account_type === "real" && !state.realStarted) return;
  const open = state.trades.filter((row) => row.status === "open" || row.status === "pending");
  const today = startOfDay();
  const settledToday = state.trades.filter((row) => (row.closedAt ?? 0) >= today && (row.status === "won" || row.status === "lost"));
  const dailyPnl = settledToday.reduce((sum, row) => sum + (row.profit ?? 0), 0);
  let losses = 0;
  let since: number | null = null;
  for (const row of [...settledToday].reverse()) {
    if (row.status === "lost") {
      losses += 1;
      if (since == null && row.closedAt) since = (Date.now() - row.closedAt) / 1000;
    } else break;
  }
  const stake = Math.min(state.risk.stake, state.risk.maxStake);
  const block = bulkRiskBlock({
    risk: state.risk,
    stake,
    open: open.length,
    exposure: open.reduce((sum, row) => sum + row.stake, 0),
    dailyPnl,
    consecutiveLosses: losses,
    secondsSinceLoss: since,
    running: state.running,
    stopped: state.stopped,
    connected: true,
  });
  if (block) {
    patchBulk({ note: block });
    return;
  }
  buying = true;
  const id = `bulk-${Date.now().toString(36)}`;
  try {
    const proposal = await bulkAccountRequest({
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: contract,
      currency: account.currency || "USD",
      duration: state.risk.duration,
      duration_unit: "t",
      underlying_symbol: market,
      ...(barrier ? { barrier } : {}),
    });
    const quote = proposal.proposal;
    const proposalId = quote?.id ?? "";
    const payout = Number(quote?.payout);
    const ask = Number(quote?.ask_price);
    const fresh = qualifyOpportunity({
      candidate: {
        engine,
        contract,
        barrier,
        estimated,
        lo,
        hi: 1,
        fair: null,
        sample: 0,
        nEff: 0,
        qualified: true,
        reason: "",
        streakNote: "",
      },
      payout: Number.isFinite(payout) ? payout : null,
      stake: Number.isFinite(ask) && ask > 0 ? ask : stake,
      minEv: state.risk.minEv,
      minPayoutMultiple: state.risk.minPayoutMultiple,
      maxAgeMs: 5000,
      quotedAt: Date.now(),
      now: Date.now(),
    });
    if (!fresh.ok || !proposalId) {
      patchBulk({ note: fresh.reason });
      return;
    }
    if (seenProposals.has(proposalId)) {
      patchBulk({ note: "That proposal was already used." });
      return;
    }
    seenProposals.add(proposalId);
    const price = Number.isFinite(ask) && ask > 0 ? ask : stake;
    const again = bulkRiskBlock({
      risk: useBulk.getState().risk,
      stake: price,
      open: useBulk.getState().trades.filter((row) => row.status === "open" || row.status === "pending").length,
      exposure: useBulk.getState().trades.filter((row) => row.status === "open" || row.status === "pending").reduce((sum, row) => sum + row.stake, 0),
      dailyPnl,
      consecutiveLosses: losses,
      secondsSinceLoss: since,
      running: useBulk.getState().running,
      stopped: useBulk.getState().stopped,
      connected: bulkAccountLive(),
    });
    if (again) {
      patchBulk({ note: again });
      return;
    }
    const pending: BulkTrade = {
      id,
      market,
      engine,
      contract,
      barrier,
      duration: state.risk.duration,
      stake: price,
      payout: payout,
      profit: null,
      probability: lo,
      openedAt: Date.now(),
      closedAt: null,
      contractId: null,
      proposalId,
      status: "pending",
      note: "Purchase sent. It is not a fill until Deriv returns a contract id.",
    };
    useBulk.setState((s) => ({ trades: [pending, ...s.trades].slice(0, 400) }));
    const bought = await bulkAccountRequest({ buy: proposalId, price });
    const contractId = String(bought.buy?.contract_id ?? "");
    if (!contractId) {
      rejectTrade(id, "Deriv did not confirm a contract id. It was not marked successful.");
      return;
    }
    useBulk.setState((s) => ({
      trades: s.trades.map((row) => (row.id === id ? { ...row, status: "open", contractId, note: "Open. Waiting for settlement." } : row)),
      note: `Bought ${contract} on ${market}. Contract ${contractId}.`,
    }));
    bulkLog("good", `Bought ${contract} on ${market}. Contract ${contractId}.`);
    persistBulk();
    void followContract(contractId, id);
  } catch (err) {
    rejectTrade(id, err instanceof Error ? err.message : "Purchase failed.");
  } finally {
    buying = false;
  }
}

function rejectTrade(id: string, note: string) {
  useBulk.setState((s) => ({
    trades: s.trades.map((row) => (row.id === id ? { ...row, status: "rejected", closedAt: Date.now(), note } : row)),
    note,
  }));
  bulkLog("bad", note);
  persistBulk();
}

async function followContract(contractId: string, tradeId: string) {
  if (!contractId || watchedContracts.has(contractId) || !bulkAccountLive()) return;
  watchedContracts.add(contractId);
  try {
    await bulkAccountStream({ proposal_open_contract: 1, contract_id: numericId(contractId), subscribe: 1 }, (msg) => {
      const contract = msg.proposal_open_contract;
      if (!contract) return;
      if (closeIfSettled(tradeId, contract)) {
        bulkAccountForget(msg.subscription?.id);
        watchedContracts.delete(contractId);
      }
    });
  } catch (err) {
    watchedContracts.delete(contractId);
    bulkLog("bad", err instanceof Error ? err.message : `Could not watch contract ${contractId}.`);
  }
}

function closeIfSettled(
  tradeId: string,
  contract: { is_sold?: number | boolean | string; status?: string; profit?: number | string; payout?: number | string; sell_price?: number | string; buy_price?: number | string },
): boolean {
  const result = readSettlement(contract);
  if (!result.sold || result.profit == null) return false;
  closeTrade(tradeId, result.profit, result.payout);
  return true;
}

function closeTrade(tradeId: string, profit: number, payout: number | null) {
  const current = useBulk.getState().trades.find((row) => row.id === tradeId);
  if (!current || (current.status !== "open" && current.status !== "pending")) return;
  const won = profit > 0;
  useBulk.setState((s) => ({
    trades: s.trades.map((item) =>
      item.id === tradeId
        ? {
            ...item,
            status: won ? "won" : "lost",
            profit,
            payout: payout ?? item.payout,
            closedAt: Date.now(),
            note: won ? `Won ${profit.toFixed(2)}.` : `Lost ${profit.toFixed(2)}.`,
          }
        : item,
    ),
    note: won ? `Settled a win of ${profit.toFixed(2)}.` : `Settled a loss of ${profit.toFixed(2)}.`,
  }));
  bulkLog(won ? "good" : "bad", won ? `Bulk trade won ${profit.toFixed(2)}.` : `Bulk trade lost ${profit.toFixed(2)}.`);
  persistBulk();
}

function numericId(id: string): number | string {
  return /^\d+$/.test(id) ? Number(id) : id;
}

async function watchOpen() {
  const open = useBulk.getState().trades.filter((row) => row.status === "open" && row.contractId);
  if (open.length === 0 || !bulkAccountLive()) return;
  for (const row of open) {
    if (row.contractId && !watchedContracts.has(row.contractId)) void followContract(row.contractId, row.id);
  }
  for (const row of open.slice(0, 8)) {
    if (!row.contractId) continue;
    try {
      const msg = await bulkAccountRequest({ proposal_open_contract: 1, contract_id: numericId(row.contractId) });
      if (msg.proposal_open_contract && closeIfSettled(row.id, msg.proposal_open_contract)) continue;
    } catch {
      /* The profit table below is the fallback. */
    }
  }
  const still = useBulk.getState().trades.filter((row) => row.status === "open" && row.contractId);
  if (still.length === 0) return;
  try {
    const msg = await bulkAccountRequest({ profit_table: 1, description: 1, limit: 50, offset: 0, sort: "DESC" });
    const table = msg.profit_table?.transactions ?? [];
    for (const trade of still) {
      const hit = table.find((row) => String(row.contract_id ?? "") === String(trade.contractId));
      if (!hit?.sell_time) continue;
      const profit = profitFromPrices(hit.sell_price, hit.buy_price);
      if (profit == null) continue;
      closeTrade(trade.id, profit, Number(hit.payout) || trade.payout);
    }
  } catch {
    /* A missed check leaves the contract open until the next pass. */
  }
}

function startOfDay(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function describeEv(probability: number, payout: number, stake: number): number | null {
  return payoutEv(probability, payout, stake);
}
