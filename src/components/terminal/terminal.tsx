import { useEffect, useState } from "react";
import {
  Bell,
  Bot,
  Briefcase,
  CandlestickChart,
  CircleHelp,
  FlaskConical,
  LayoutDashboard,
  LineChart,
  Menu,
  Radar,
  ScrollText,
  Settings,
  Shield,
  SlidersHorizontal,
  Crosshair,
  Layers,
  OctagonX,
  Boxes,
} from "lucide-react";
import { money } from "@/lib/format";
import { contractName } from "@/lib/engine/catalog";
import { MODULE_NAMES } from "@/lib/engine/modules";
import { orderStake } from "@/lib/engine/risk";
import { maskAccountId, scopedOpenCount, unassignedCount } from "@/lib/desk/account-scope";
import { executionText, isUnresolved } from "@/lib/desk/execution";
import {
  lossStreak,
  realizedToday,
  setEmergency,
  setView,
  startDesk,
  winRate,
} from "@/lib/desk/session";
import { useDesk, type DeskView } from "@/lib/desk/store";
import { DeskViews } from "@/components/terminal/views";
import { SettingsBanner } from "@/components/terminal/settings-banner";

const NAV: { id: DeskView; label: string; icon: typeof Radar; mobile?: boolean }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, mobile: true },
  { id: "scanner", label: "Scanner", icon: Radar, mobile: true },
  { id: "signals", label: "Signals", icon: Crosshair },
  { id: "auto", label: "Trade", icon: Bot, mobile: true },
  { id: "chart", label: "Chart", icon: CandlestickChart, mobile: true },
  { id: "control", label: "Strategies", icon: SlidersHorizontal },
  { id: "strategies", label: "Strategy list", icon: Layers },
  { id: "positions", label: "Open trades", icon: Briefcase },
  { id: "history", label: "History", icon: ScrollText },
  { id: "analytics", label: "Analytics", icon: LineChart },
  { id: "backtest", label: "Backtest", icon: FlaskConical },
  { id: "risk", label: "Risk", icon: Shield },
  { id: "alerts", label: "Alerts", icon: Bell },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "help", label: "Help", icon: CircleHelp },
  { id: "bulk", label: "AI Bulk Trader", icon: Boxes },
];

export function Terminal() {
  const view = useDesk((s) => s.view);
  const feed = useDesk((s) => s.feed);
  const emergency = useDesk((s) => s.emergency);
  const mode = useDesk((s) => s.mode);
  const tradeType = useDesk((s) => s.tradeType);
  const accounts = useDesk((s) => s.accounts);
  const accountId = useDesk((s) => s.accountId);
  const journal = useDesk((s) => s.journal);
  const trading = useDesk((s) => s.trading);
  const attempts = useDesk((s) => s.attempts);
  const buyHold = useDesk((s) => s.buyHold);
  const armDemo = useDesk((s) => s.armDemo);
  const armReal = useDesk((s) => s.armReal);
  const armedAccountId = useDesk((s) => s.armedAccountId);
  const modules = useDesk((s) => s.modules);
  const focus = useDesk((s) => s.focus);
  const risk = useDesk((s) => s.risk);
  const log = useDesk((s) => s.log);
  const [more, setMore] = useState(false);
  const account = accounts.find((row) => row.account_id === accountId) ?? null;

  useEffect(() => startDesk(), []);

  const balance = account ? money(account.balance, account.currency) : "—";
  const today = accountId ? realizedToday(journal, Date.now(), accountId) : null;
  const scopedClosed = Boolean(accountId) && journal.some((row) => row.closedAt && row.accountId === accountId);
  const todayTone = !scopedClosed || today == null ? "text-muted" : today > 0 ? "text-up" : today < 0 ? "text-down" : "text-fg";
  const activeStrategies = Object.entries(modules)
    .filter(([, cfg]) => cfg.enabled)
    .map(([id]) => MODULE_NAMES[id as keyof typeof MODULE_NAMES] ?? id);
  const openCount = scopedOpenCount(journal, accountId);
  const stakeNow = accountId ? orderStake(risk, account?.balance ?? null, lossStreak(journal, accountId)) : null;
  const streak = accountId ? lossStreak(journal, accountId) : 0;
  const rate = accountId ? winRate(journal, accountId) : null;
  const unknown = unassignedCount(journal);
  const realArmed = Boolean(account?.account_type === "real" && armReal && armedAccountId === account.account_id);
  const blocked = log.find((row) => row.tone === "warn" || row.tone === "bad");
  const authLabel = !account
    ? "Not signed in"
    : account.account_type === "real"
      ? realArmed
        ? "Real started"
        : "Idle"
      : armDemo
        ? "Demo started"
        : "Idle";
  const mine = accountId ? attempts.filter((row) => row.accountId === accountId) : [];
  const openTrade = accountId ? (journal.find((row) => row.accountId === accountId && row.status === "open") ?? null) : null;
  const latestAttempt =
    mine.find((row) => isUnresolved(row.status)) ??
    mine.find((row) => row.contractId != null && row.contractId === openTrade?.contractId) ??
    mine[0] ??
    null;
  const linked = latestAttempt?.contractId
    ? (journal.find((row) => row.contractId === latestAttempt.contractId && row.accountId === accountId) ?? null)
    : null;
  const shown = openTrade ?? linked;
  const pendingSettlement = Boolean(shown && shown.status === "open" && shown.settlement?.isSold && shown.profit == null);
  const execution = executionText({
    connected: Boolean(account),
    trading: account ? trading : "off",
    attempt: openTrade && latestAttempt && !isUnresolved(latestAttempt.status) && latestAttempt.contractId !== openTrade.contractId ? null : latestAttempt,
    journalStatus: shown?.status ?? null,
    profit: shown?.profit ?? null,
    pendingSettlement,
  });
  const executionTone = /interrupted|uncertain|Lost|not accepted/i.test(execution) ? "text-down" : execution === "Won." ? "text-up" : "text-fg";
  const unresolved = Boolean(latestAttempt && isUnresolved(latestAttempt.status));
  const detailSource = unresolved ? latestAttempt : openTrade ?? latestAttempt;
  const detailId = detailSource?.contractId ?? "";
  const detailType = detailSource?.contractType ?? "";
  const detailStake = detailSource?.stake;

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-line bg-navy/90 px-3 py-2 backdrop-blur-md">
        <div className="mr-1 flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-sm bg-gold font-mono text-xs font-semibold text-gold-ink">
            RG
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-wide">RICHGANGFX</div>
            <div className="font-mono text-xs text-gold">AI</div>
          </div>
        </div>
        <Status
          label={feed === "live" ? "Feed live" : feed === "connecting" ? "Feed connecting" : "Feed down"}
          tone={feed === "live" ? "up" : feed === "down" ? "down" : "gold"}
        />
        <Status
          label={
            account
              ? `${account.account_type === "real" ? "Real" : "Demo"} ${maskAccountId(account.account_id)}`
              : "No account"
          }
          tone={account?.account_type === "real" ? "down" : account ? "gold" : "muted"}
        />
        {account && trading === "live" ? <Status label="Orders live" tone="up" /> : null}
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setView("alerts")}
            className="grid size-11 place-items-center rounded-md border border-line text-muted"
            aria-label="Notifications"
          >
            <Bell className="size-4" />
          </button>
          <div className="text-right">
            <div className="text-xs text-muted uppercase">Balance</div>
            <div className="font-mono text-sm tabular-nums text-gold">{balance}</div>
          </div>
          <div className="hidden text-right sm:block">
            <div className="text-xs text-muted uppercase">Today</div>
            <div className={`font-mono text-sm tabular-nums ${todayTone}`}>
              {scopedClosed && today != null ? money(today, account?.currency ?? "USD") : "—"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEmergency(!emergency)}
            className={`inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-semibold ${
              emergency ? "bg-down text-gold-ink" : "border border-down text-down"
            }`}
          >
            <OctagonX className="size-4" />
            {emergency ? "Resume" : "Stop"}
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-navy/40 p-2 md:flex">
          {NAV.map((item) => (
            <NavButton key={item.id} item={item} active={view === item.id} />
          ))}
          <div className="mt-auto px-2 py-2 font-mono text-xs text-muted">
            Mode {mode}
            <div>Bot {tradeType ? contractName(tradeType) : "none"}</div>
            <div>Streak {accountId ? streak : "—"}</div>
            <div>Win {accountId ? (rate == null ? "Unavailable" : `${(rate * 100).toFixed(0)}%`) : "—"}</div>
          </div>
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto p-3 pb-24 md:pb-4">
          <section className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Fact
              label="Account"
              value={account ? (account.account_type === "real" ? "Real" : "Demo") : "Not signed in"}
              tone={account?.account_type === "real" ? "down" : account ? "gold" : undefined}
            />
            <Fact label="Account ID" value={account ? maskAccountId(account.account_id) : "—"} />
            <Fact label="Authorization" value={authLabel} tone={account?.account_type === "real" && !realArmed ? "down" : account?.account_type === "demo" ? "gold" : undefined} />
            <Fact label="Contract" value={tradeType ? contractName(tradeType) : "None selected"} />
            <Fact label="Market" value={focus[0] ?? "—"} />
            <Fact label="Stake" value={stakeNow == null ? "—" : money(stakeNow, account?.currency ?? "USD")} />
            <Fact label="Martingale" value={risk.martingale ? `On ×${risk.martingaleMultiplier}` : "Off"} />
            <Fact label="Open" value={accountId ? String(openCount) : "—"} />
            <Fact label="Today" value={scopedClosed && today != null ? money(today, account?.currency ?? "USD") : "—"} />
            <Fact label="Win rate" value={accountId ? (rate == null ? "Unavailable" : `${(rate * 100).toFixed(0)}%`) : "—"} />
            <Fact label="Streak" value={accountId ? String(streak) : "—"} />
            <Fact label="Strategies" value={activeStrategies.length ? activeStrategies.join(", ") : "None on"} />
          </section>
          {account?.account_type === "real" && !realArmed ? (
            <p className="mb-3 rounded-md border border-down bg-down/15 px-3 py-2 text-sm text-down">
              Real trading is DISARMED for {maskAccountId(account.account_id)}. No real-money order will be sent.
            </p>
          ) : null}
          {account?.account_type === "demo" ? (
            <p className="mb-3 rounded-md border border-gold/40 px-3 py-2 text-sm text-gold">Demo account. This balance is not real money.</p>
          ) : null}
          {unknown > 0 ? (
            <p className="mb-3 text-sm text-muted">
              {unknown} older {unknown === 1 ? "trade has" : "trades have"} no account id. They stay in history and are not used for this account's profit, streak, stake, or limits.
            </p>
          ) : null}
          {account ? (
            <p className="mb-3 break-words text-sm">
              <span className={executionTone}>{execution}</span>
              <span className="text-muted">
                {detailId ? ` Contract ${detailId}.` : ""}
                {` ${account.account_type === "real" ? "Real" : "Demo"} ${maskAccountId(account.account_id)}.`}
                {detailType ? ` ${contractName(detailType)}.` : ""}
                {detailStake != null ? ` Stake ${money(detailStake, shown?.currency || account.currency)}.` : ""}
              </span>
              {unresolved && buyHold ? <span className="text-down"> {buyHold}</span> : null}
            </p>
          ) : null}
          {blocked ? <p className="mb-3 text-sm text-muted">{blocked.text}</p> : null}
          <SettingsBanner />
          <DeskViews />
        </main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-navy/95 backdrop-blur-md md:hidden">
        {NAV.filter((item) => item.mobile).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setView(item.id);
              setMore(false);
            }}
            className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-xs ${
              view === item.id ? "text-gold" : "text-muted"
            }`}
          >
            <item.icon className="size-4" />
            {item.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setMore((v) => !v)}
          className="flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-xs text-muted"
        >
          <Menu className="size-4" />
          More
        </button>
      </nav>
      {more ? (
        <div className="fixed inset-x-0 bottom-14 z-20 border-t border-line bg-surface p-2 md:hidden">
          {NAV.filter((item) => !item.mobile).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setView(item.id);
                setMore(false);
              }}
              className="flex min-h-11 w-full items-center gap-2 px-2 text-left text-sm"
            >
              <item.icon className="size-4 text-gold" />
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "down" | "gold" | "up" }) {
  const color = tone === "down" ? "text-down" : tone === "gold" ? "text-gold" : tone === "up" ? "text-up" : "text-fg";
  return (
    <div className="min-w-0 rounded-md border border-line bg-surface px-2 py-2">
      <div className="text-xs tracking-wide text-muted uppercase">{label}</div>
      <div className={`truncate font-mono text-sm ${color}`}>{value}</div>
    </div>
  );
}

function NavButton({
  item,
  active,
}: {
  item: (typeof NAV)[number];
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => setView(item.id)}
      className={`flex min-h-11 items-center gap-2 rounded-md px-2 text-left text-sm ${
        active ? "bg-raised text-gold" : "text-fg"
      }`}
    >
      <item.icon className="size-4" />
      {item.label}
    </button>
  );
}

function Status({ label, tone }: { label: string; tone: "up" | "down" | "gold" | "muted" }) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "gold" ? "text-gold" : "text-muted";
  return <span className={`font-mono text-xs ${color}`}>{label}</span>;
}
