import { describeDigitDesk } from "@/lib/desk/digit-diagnostics";
import { useDesk } from "@/lib/desk/store";
import { isUnresolved } from "@/lib/desk/execution";
import { Panel } from "@/components/terminal/bits";

export function DigitDiagnostics() {
  const feed = useDesk((s) => s.feed);
  const feedError = useDesk((s) => s.feedError);
  const focus = useDesk((s) => s.focus);
  const ticks = useDesk((s) => s.ticks);
  const quotes = useDesk((s) => s.quotes);
  const pip = useDesk((s) => s.pip);
  const tradeType = useDesk((s) => s.tradeType);
  const digitPick = useDesk((s) => s.digitPick);
  const profiles = useDesk((s) => s.profiles);
  const plans = useDesk((s) => s.plans);
  const mode = useDesk((s) => s.mode);
  const trading = useDesk((s) => s.trading);
  const emergency = useDesk((s) => s.emergency);
  const accounts = useDesk((s) => s.accounts);
  const accountId = useDesk((s) => s.accountId);
  const armDemo = useDesk((s) => s.armDemo);
  const armReal = useDesk((s) => s.armReal);
  const armedAccountId = useDesk((s) => s.armedAccountId);
  const proposalNote = useDesk((s) => s.proposalNote);
  const executionNote = useDesk((s) => s.executionNote);
  const buyHold = useDesk((s) => s.buyHold);
  const attempts = useDesk((s) => s.attempts);
  const opportunities = useDesk((s) => s.opportunities);
  const symbol = focus[0] ?? null;
  const series = symbol ? (ticks[symbol] ?? []) : [];
  const spot = symbol ? quotes[symbol] : undefined;
  const plan = tradeType ? plans.find((row) => row.type === tradeType && (!symbol || row.symbol === symbol)) : undefined;
  const opportunity = tradeType ? opportunities.find((row) => row.type === tradeType && (!symbol || row.symbol === symbol)) : undefined;
  const account = accounts.find((row) => row.account_id === accountId) ?? null;
  const started =
    account?.account_type === "real"
      ? armReal && armedAccountId === account.account_id
      : account?.account_type === "demo"
        ? armDemo
        : false;
  if (!started) {
    return (
      <Panel title="Order status">
        <p className="text-sm text-muted">Idle</p>
      </Panel>
    );
  }
  const card = describeDigitDesk({
    feed,
    feedError,
    symbol,
    quotes: series.map((point) => point.q),
    pip: symbol ? (pip[symbol] ?? spot?.pip_size ?? 2) : 2,
    lastQuote: spot?.quote ?? series.at(-1)?.q ?? null,
    lastEpoch: spot?.epoch ?? series.at(-1)?.t ?? null,
    tradeType,
    digitPick,
    profile: tradeType ? profiles[tradeType] : null,
    planStatus: plan?.status ?? null,
    planNote: plan?.note ?? null,
    mode,
    trading,
    emergency,
    accountType: account?.account_type ?? null,
    accountId,
    armDemo,
    armReal,
    armedAccountId,
    proposalNote,
    executionNote,
    buyHold,
    unresolved: attempts.filter((row) => row.accountId === accountId && isUnresolved(row.status)).length,
    opportunityReasons: opportunity?.reasons,
  });
  const idle: Record<string, string> = {
    "Proposal status": "No proposal has been requested.",
    "Purchase status": "No purchase is in progress.",
    "Execution error": "None.",
  };
  const shown = card.rows.filter((row) => {
    if (row.label === "Trading authorization") return !row.value.startsWith("Auto is armed");
    const quiet = idle[row.label];
    return quiet != null && row.value !== quiet;
  });
  if (shown.length === 0) return null;

  return (
    <Panel title="Order status">
      <div className="grid grid-cols-1 gap-2">
        {shown.map((row) => (
          <div key={row.label} className="min-w-0 rounded-md border border-line bg-bg px-2 py-2">
            <div className="text-xs tracking-wide text-muted uppercase">{row.label}</div>
            <div className="text-sm text-pretty break-words text-fg">{row.value}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
