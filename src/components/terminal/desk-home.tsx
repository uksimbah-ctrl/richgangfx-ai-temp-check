import { accountPerformance } from "@/lib/desk/account-stats";
import { isUnresolved } from "@/lib/desk/execution";
import { systemHealth } from "@/lib/desk/health";
import { useDesk } from "@/lib/desk/store";
import { money, quoteText, signed } from "@/lib/format";
import { MODULE_IDS } from "@/lib/engine/modules";

export function DeskHome() {
  const journal = useDesk((s) => s.journal);
  const accounts = useDesk((s) => s.accounts);
  const accountId = useDesk((s) => s.accountId);
  const feed = useDesk((s) => s.feed);
  const trading = useDesk((s) => s.trading);
  const armDemo = useDesk((s) => s.armDemo);
  const armReal = useDesk((s) => s.armReal);
  const armedAccountId = useDesk((s) => s.armedAccountId);
  const emergency = useDesk((s) => s.emergency);
  const tradeType = useDesk((s) => s.tradeType);
  const modules = useDesk((s) => s.modules);
  const focus = useDesk((s) => s.focus);
  const ticks = useDesk((s) => s.ticks);
  const quotes = useDesk((s) => s.quotes);
  const risk = useDesk((s) => s.risk);
  const attempts = useDesk((s) => s.attempts);
  const buyHold = useDesk((s) => s.buyHold);
  const sessionResetAt = useDesk((s) => s.sessionResetAt);

  const account = accounts.find((row) => row.account_id === accountId) ?? null;
  const currency = account?.currency ?? "USD";
  const stats = accountPerformance(journal, accountId, Date.now(), sessionResetAt);
  const symbol = focus[0] ?? null;
  const series = symbol ? (ticks[symbol] ?? []) : [];
  const quote = symbol ? quotes[symbol] : undefined;
  const enabled = MODULE_IDS.filter((id) => modules[id]?.enabled && id !== "ensemble" && id !== "regime");
  const minSample = enabled.length ? Math.min(...enabled.map((id) => modules[id]?.minSample ?? risk.minSample)) : risk.minSample;
  const realArmed = Boolean(account?.account_type === "real" && armReal && armedAccountId === account.account_id);
  const unresolved = accountId ? attempts.filter((row) => row.accountId === accountId && isUnresolved(row.status)).length : 0;
  const problem = systemHealth({
    feed,
    trading: account ? trading : "off",
    hasAccount: Boolean(account),
    accountType: account?.account_type ?? null,
    armDemo,
    armReal,
    realArmedForAccount: realArmed,
    emergency,
    tradeType,
    strategiesOn: Math.max(enabled.length, tradeType ? 1 : 0),
    tickCount: series.length,
    minSample,
    openCount: stats.open,
    unresolved,
    buyHold,
  }).find((row) => !row.ok);
  const armed = !account
    ? "Not signed in"
    : account.account_type === "real"
      ? realArmed
        ? "Real started"
        : "Idle"
      : armDemo
        ? "Demo started"
        : "Idle";

  return (
    <section className={`rounded-md border p-3 ${account?.account_type === "real" ? "border-down bg-down/10" : "border-line bg-surface"}`}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-sm">{symbol ?? "No market"}</div>
          <div className="font-mono text-2xl tabular-nums text-gold">{quote ? quoteText(quote.quote, quote.pip_size) : "—"}</div>
        </div>
        <div className="text-right text-sm">
          <div className="font-medium">{account && Number.isFinite(account.balance) ? money(account.balance, currency) : "—"}</div>
          <div className={account?.account_type === "real" && !realArmed ? "text-down" : "text-muted"}>{armed}</div>
          <div className="text-muted">Today {stats.todayPnl == null ? "—" : signed(stats.todayPnl, currency)}</div>
        </div>
      </div>
      {problem ? <p className="mt-2 text-sm text-down">{problem.label}. {problem.detail}</p> : null}
      {unresolved > 0 ? <p className="mt-2 text-sm text-gold">{unresolved} purchase{unresolved === 1 ? " is" : "s are"} still unresolved.</p> : null}
      {buyHold ? <p className="mt-2 text-sm text-gold">{buyHold}</p> : null}
    </section>
  );
}
