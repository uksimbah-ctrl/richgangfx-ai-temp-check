import { money, pct, signed } from "@/lib/format";
import { maskAccountId, scopedPnl, scopedWins, scopedOpenCount, scopedLossStreak } from "@/lib/desk/account-scope";
import { realizedToday, winRate } from "@/lib/desk/session";
import { useDesk } from "@/lib/desk/store";

export function AccountBoard() {
  const journal = useDesk((s) => s.journal);
  const accounts = useDesk((s) => s.accounts);
  const accountId = useDesk((s) => s.accountId);
  const feed = useDesk((s) => s.feed);
  const trading = useDesk((s) => s.trading);
  const armDemo = useDesk((s) => s.armDemo);
  const armReal = useDesk((s) => s.armReal);
  const armedAccountId = useDesk((s) => s.armedAccountId);
  const account = accounts.find((row) => row.account_id === accountId) ?? null;
  const currency = account?.currency ?? "USD";
  const settled = scopedWins(journal, accountId);
  const open = scopedOpenCount(journal, accountId);
  const total = settled.closed > 0 ? scopedPnl(journal, 0, accountId) : null;
  const todayRaw = accountId ? realizedToday(journal, Date.now(), accountId) : null;
  const todayCount = accountId
    ? journal.filter((row) => {
        if (row.accountId !== accountId || row.closedAt == null || row.profit == null) return false;
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        return row.closedAt >= start.getTime();
      }).length
    : 0;
  const today = todayCount > 0 ? todayRaw : null;
  const rate = accountId ? winRate(journal, accountId) : null;
  const streak = accountId ? scopedLossStreak(journal, useDesk.getState().sessionResetAt ?? 0, accountId) : null;
  const realArmed = Boolean(account?.account_type === "real" && armReal && armedAccountId === account.account_id);
  const auth = !account ? "Not signed in" : account.account_type === "real" ? (realArmed ? "Real started" : "Idle") : armDemo ? "Demo started" : "Idle";
  const connection = !account ? "No account" : trading === "live" ? "Trading connected" : trading === "connecting" ? "Trading reconnecting" : "Trading disconnected";
  const feedLabel = feed === "live" ? "Market live" : feed === "connecting" ? "Market reconnecting" : "Market down";

  return (
    <section className="grid gap-3">
      <div>
        <h2 className="text-sm font-medium">Live account</h2>
        <p className="mt-1 text-sm text-muted">This is the Deriv account selected now. It is not mixed with another account.</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Fact label="Account" value={account ? (account.account_type === "real" ? "Real" : "Demo") : "Not signed in"} tone={account?.account_type === "real" ? "down" : "gold"} />
          <Fact label="Account ID" value={account ? maskAccountId(account.account_id) : "—"} />
          <Fact label="Currency" value={account?.currency ?? "—"} />
          <Fact label="Balance" value={account ? money(account.balance, currency) : "—"} tone="gold" />
          <Fact label="Market feed" value={feedLabel} tone={feed === "live" ? "up" : "down"} />
          <Fact label="Connection" value={connection} tone={trading === "live" ? "up" : "down"} />
          <Fact label="Authorization" value={auth} tone={account?.account_type === "real" && !realArmed ? "down" : "gold"} />
        </div>
      </div>
      <div>
        <h2 className="text-sm font-medium">This account's results</h2>
        <p className="mt-1 text-sm text-muted">Closed trades for this account id only. Blank means none yet, not a profit of zero.</p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Fact label="Today" value={today == null ? "—" : signed(today, currency)} tone={today == null ? "muted" : today > 0 ? "up" : today < 0 ? "down" : "fg"} />
          <Fact label="Total P/L" value={total == null ? "—" : signed(total, currency)} tone={total == null ? "muted" : total > 0 ? "up" : total < 0 ? "down" : "fg"} />
          <Fact label="Trades" value={accountId ? String(settled.closed) : "—"} />
          <Fact label="Wins" value={accountId ? String(settled.wins) : "—"} tone={settled.wins ? "up" : "muted"} />
          <Fact label="Losses" value={accountId ? String(settled.losses) : "—"} tone={settled.losses ? "down" : "muted"} />
          <Fact label="Win rate" value={!accountId ? "—" : rate == null ? "Unavailable" : pct(rate)} />
          <Fact label="Loss streak" value={streak == null ? "—" : String(streak)} />
          <Fact label="Open" value={accountId ? String(open) : "—"} />
          <Fact label="Settled" value={accountId ? String(settled.closed) : "—"} />
        </div>
      </div>
    </section>
  );
}

function Fact({ label, value, tone = "fg" }: { label: string; value: string; tone?: "fg" | "gold" | "up" | "down" | "muted" }) {
  const color = tone === "gold" ? "text-gold" : tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "muted" ? "text-muted" : "text-fg";
  return (
    <div className="min-w-0 rounded-md border border-line bg-surface px-2 py-2">
      <div className="text-xs tracking-wide text-muted uppercase">{label}</div>
      <div className={`truncate font-mono text-sm ${color}`}>{value}</div>
    </div>
  );
}
