import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { adx, atr, barsFromTicks, bollinger, emaLast, macdHist, rsi } from "@/lib/engine/indicators";
import { contractName } from "@/lib/engine/catalog";
import { clock, signed } from "@/lib/format";
import { setView } from "@/lib/desk/session";
import { useDesk } from "@/lib/desk/store";

export function MarketChart() {
  const focus = useDesk((s) => s.focus);
  const ticks = useDesk((s) => s.ticks);
  const quotes = useDesk((s) => s.quotes);
  const journal = useDesk((s) => s.journal);
  const [symbol, setSymbol] = useState(focus[0] ?? "R_100");
  const chosen = focus.includes(symbol) ? symbol : focus[0] ?? symbol;
  const series = ticks[chosen] ?? [];
  const quotesOnly = series.map((point) => point.q);
  const bars = barsFromTicks(quotesOnly, 5);
  const emaFast = emaLast(quotesOnly, 9);
  const emaSlow = emaLast(quotesOnly, 21);
  const rsiValue = rsi(quotesOnly, 14);
  const macd = macdHist(quotesOnly);
  const bands = bollinger(quotesOnly, 20, 2);
  const atrValue = atr(bars, 14);
  const adxValue = adx(bars, 14);
  const last = quotes[chosen];
  const high = quotesOnly.length ? Math.max(...quotesOnly.slice(-80)) : null;
  const low = quotesOnly.length ? Math.min(...quotesOnly.slice(-80)) : null;
  const path = useMemo(() => spark(quotesOnly.slice(-80)), [series.length, chosen]);
  const entries = journal.filter((row) => row.symbol === chosen).slice(0, 6);

  return (
    <div className="grid gap-3">
      <section className="rounded-md border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Chart</h2>
          <select
            value={chosen}
            onChange={(event) => setSymbol(event.target.value)}
            className="min-h-11 rounded-md border border-line bg-bg px-3 text-sm"
          >
            {focus.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-sm text-muted">
          {last ? <span className="font-mono text-blue">{last.quote}</span> : "Waiting for ticks."} Candles are grouped from live ticks, not a separate candle feed.
        </p>
        <svg viewBox="0 0 320 140" className="mt-3 h-52 w-full text-blue" role="img" aria-label={`${chosen} price`}>
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Read label="EMA 9" value={fmt(emaFast)} />
          <Read label="EMA 21" value={fmt(emaSlow)} />
          <Read label="RSI 14" value={fmt(rsiValue)} />
          <Read label="MACD hist" value={fmt(macd)} />
          <Read label="Bollinger" value={bands ? `${bands.lower.toFixed(2)} – ${bands.upper.toFixed(2)}` : "—"} />
          <Read label="ADX" value={fmt(adxValue)} />
          <Read label="ATR" value={fmt(atrValue)} />
          <Read label="Range" value={high != null && low != null ? `${low.toFixed(2)} – ${high.toFixed(2)}` : "—"} />
        </div>
      </section>
      <section className="rounded-md border border-line bg-surface p-3">
        <h2 className="text-sm font-medium">Entries on this market</h2>
        {entries.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No desk trades on {chosen} yet. Markers appear after this desk buys.</p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {entries.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {contractName(row.contractType)} · {clock(row.openedAt)}
                </span>
                <span className={row.profit != null && row.profit < 0 ? "font-mono text-down" : "font-mono text-up"}>
                  {row.status === "open" ? "Open" : signed(row.profit, row.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function Notifications() {
  const log = useDesk((s) => s.log);
  return (
    <section className="rounded-md border border-line bg-surface p-3">
      <h2 className="text-sm font-medium">Notifications</h2>
      <p className="mt-1 text-sm text-muted">Live desk messages. Nothing here is invented.</p>
      {log.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No messages yet.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {log.slice(0, 40).map((row) => (
            <li key={`${row.at}-${row.text}`} className="rounded-md border border-line px-3 py-2">
              <div className="font-mono text-xs text-muted">{clock(row.at)}</div>
              <p className={`text-sm ${row.tone === "bad" || row.tone === "warn" ? "text-down" : row.tone === "good" ? "text-up" : "text-fg"}`}>
                {row.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HelpDesk() {
  return (
    <div className="grid gap-3">
      <section className="rounded-md border border-line bg-surface p-3">
        <h2 className="text-sm font-medium">Help</h2>
        <ol className="mt-3 grid gap-2 text-sm text-muted">
          <li>1. Sign in on Account. Demo and real stay separate.</li>
          <li>2. On Live Trading, pick one contract. Press Start before any order.</li>
          <li>3. Leave entries at 1, or choose a batch. A batch stays on that signal until it settles.</li>
          <li>4. Real orders need the words START REAL. The desk does not start itself. Stop blocks new entries.</li>
        </ol>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => setView("auto")} className="min-h-11 rounded-md bg-gold px-3 text-sm font-medium text-gold-ink">
            Open live trading
          </button>
          <Link to="/guide" className="inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm">
            Full tutorial
          </Link>
        </div>
      </section>
    </div>
  );
}

function Read({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line px-2 py-2">
      <div className="text-xs tracking-wide text-muted uppercase">{label}</div>
      <div className="mt-1 font-mono text-fg">{value}</div>
    </div>
  );
}

function fmt(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(2);
}

function spark(values: number[]): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 320;
      const y = 128 - ((value - min) / span) * 108 - 8;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}
