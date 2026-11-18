import { explainDigits } from "@/lib/engine/modules";
import { useDesk } from "@/lib/desk/store";

export function DigitInsight() {
  const focus = useDesk((s) => s.focus);
  const ticks = useDesk((s) => s.ticks);
  const quotes = useDesk((s) => s.quotes);
  const pip = useDesk((s) => s.pip);
  const tradeType = useDesk((s) => s.tradeType);
  const digitPick = useDesk((s) => s.digitPick);
  const modules = useDesk((s) => s.modules);
  const profiles = useDesk((s) => s.profiles);
  const opportunities = useDesk((s) => s.opportunities);
  const plans = useDesk((s) => s.plans);
  const symbol = focus[0] ?? null;
  const prices = symbol ? (ticks[symbol] ?? []).map((point) => point.q) : [];
  const places = symbol ? (pip[symbol] ?? quotes[symbol]?.pip_size ?? 2) : 2;
  const activePlan = plans.find((row) => row.type === tradeType && row.request?.barrier);
  const barrier = digitPick == null ? (activePlan?.request?.barrier ?? "") : String(digitPick);
  const profile = tradeType ? profiles[tradeType] : undefined;
  const quote = opportunities.find((row) => row.type === tradeType && (!symbol || row.symbol === symbol));
  const card = explainDigits(prices, places, tradeType, barrier, modules, {
    minEffective: profile?.minEffective,
    z: profile?.intervalZ,
    persist: profile?.walkForward,
    minSample: profile?.minSample,
    lookback: profile?.shortWindow,
    stake: quote?.stake ?? profile?.stake ?? null,
    payout: quote?.payout ?? null,
    ask: quote?.ask ?? null,
  });
  const signal = plans.some((row) => row.type === tradeType && row.status === "pricing");
  const qualified = signal || card.status === "Qualified";
  const status = qualified ? "Signal" : card.status === "Not qualified" ? "No signal" : "Waiting";
  const line = qualified ? "Ready to price. Not a verified edge." : status === "No signal" ? "No signal. The estimate does not clear the baseline." : "Waiting for the latest ticks to agree.";

  return (
    <section className="mt-3 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <Fact label="Status" value={status} />
        <Fact label="Baseline" value={card.fair} />
        <Fact label="Estimate" value={card.estimate} />
        <Fact label="Interval" value={card.interval} />
      </div>
      <p className="mt-2 text-sm text-muted">{line}</p>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-bg px-2 py-2">
      <div className="text-xs tracking-wide text-muted uppercase">{label}</div>
      <div className="truncate font-mono text-sm text-fg">{value}</div>
    </div>
  );
}
