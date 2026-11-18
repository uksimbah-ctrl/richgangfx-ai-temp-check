import { useEffect, useState, type ReactNode } from "react";
import { ENGINE_IDS, ENGINE_LABEL, digitsOf, type EngineId } from "@/lib/bulk/engines";
import { approximateBacktest, calibrate, summarize } from "@/lib/bulk/learn";
import { bootBulk, resumeBulk, setBulkRunning, stopAllBulk, syncMarkets } from "@/lib/bulk/runner";
import { patchBulk, persistBulk, useBulk } from "@/lib/bulk/store";
import { useDesk } from "@/lib/desk/store";
import { money, pct } from "@/lib/format";

const SECTIONS = [
  ["overview", "Overview"],
  ["scanner", "Scanner"],
  ["engines", "Engines"],
  ["signals", "Signals"],
  ["execution", "Execution"],
  ["open", "Open"],
  ["history", "History"],
  ["analytics", "Analytics"],
  ["risk", "Risk"],
  ["learning", "Learning"],
  ["settings", "Settings"],
] as const;

type Section = (typeof SECTIONS)[number][0];

export function BulkTrader() {
  const [section, setSection] = useState<Section>("overview");
  const bulk = useBulk();
  const account = useDesk((s) => s.accounts.find((row) => row.account_id === s.accountId) ?? null);
  const trading = useDesk((s) => s.trading);
  useEffect(() => {
    bootBulk();
  }, []);
  const stats = summarize(bulk.trades);
  const open = bulk.trades.filter((row) => row.status === "open" || row.status === "pending");

  return (
    <div className="grid min-w-0 max-w-full gap-3 overflow-x-hidden">
      <section className="min-w-0 rounded-md border border-gold/40 bg-surface p-3">
        <div>
          <h2 className="text-sm font-medium">AI Bulk Trader</h2>
          <p className="mt-1 text-sm text-pretty text-muted">Separate from the main desk. It uses the connected account and does not change that desk's strategies.</p>
          <p className={`mt-2 font-mono text-xs break-all ${account?.account_type === "real" ? "text-down" : "text-gold"}`}>
            {account ? `${account.account_type === "real" ? "Real" : "Demo"} ${account.account_id}` : "No account"}
            {trading === "live" ? " · socket live" : " · socket down"}
          </p>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={`min-h-11 rounded-md px-1 text-xs ${section === id ? "bg-gold text-gold-ink" : "border border-line"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      {bulk.note ? <p className="text-sm text-pretty break-words text-gold">{bulk.note}</p> : null}
      {section === "overview" ? (
        <Card title="Overview">
          <Grid>
            <Fact label="Balance" value={account && Number.isFinite(account.balance) ? money(account.balance, account.currency) : "—"} />
            <Fact label="Mode" value={account?.account_type === "real" ? "Real" : account ? "Demo" : "Not connected"} />
            <Fact label="Scanner" value={bulk.feed} />
            <Fact label="Markets" value={String(bulk.enabledMarkets.length)} />
            <Fact label="Engines" value={String(ENGINE_IDS.filter((id) => bulk.engines[id]).length)} />
            <Fact label="Open" value={String(open.length)} />
            <Fact label="Exposure" value={money(stats.exposure, account?.currency ?? "USD")} />
            <Fact label="Today net" value={money(stats.net, account?.currency ?? "USD")} />
            <Fact label="Win rate" value={stats.winRate == null ? "—" : pct(stats.winRate)} />
            <Fact label="Auto" value={bulk.stopped ? "Stopped" : bulk.running ? "Running" : "Idle"} />
          </Grid>
          <Controls real={account?.account_type === "real"} />
        </Card>
      ) : null}
      {section === "scanner" ? (
        <Card title="Live scanner">
          <p className="text-sm text-muted">Each market keeps its own ticks. Symbols come from Deriv's active symbol list when the scanner is connected. Known volatility indices stay available if that list has not arrived.</p>
          <ul className="mt-3 grid gap-2">
            {bulk.discovered.map((row) => {
              const on = bulk.enabledMarkets.includes(row.symbol);
              const latest = bulk.latest[row.symbol];
              return (
                <li key={row.symbol} className="grid min-w-0 gap-2 rounded-md border border-line px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm break-words">{row.name}</div>
                    <div className="font-mono text-xs break-all text-muted">
                      {row.symbol} · {on ? "On" : "Off"} · digit {latest?.digit ?? "—"} · {bulk.quotes[row.symbol]?.length ?? 0} ticks
                    </div>
                  </div>
                  <button
                    type="button"
                    className="min-h-11 w-full rounded-md border border-line px-3 text-sm"
                    onClick={() => {
                      const enabledMarkets = on ? bulk.enabledMarkets.filter((symbol) => symbol !== row.symbol) : [...bulk.enabledMarkets, row.symbol];
                      patchBulk({ enabledMarkets });
                      persistBulk();
                      void syncMarkets();
                    }}
                  >
                    {on ? "Disable" : "Enable"}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
      {section === "engines" ? (
        <Card title="Strategy engines">
          <p className="text-sm text-muted">Each engine scores only its contract. A streak is recorded as a hypothesis and cannot qualify a trade on its own.</p>
          <div className="mt-3 grid gap-2">
            {ENGINE_IDS.map((id) => (
              <EngineRow key={id} id={id} on={bulk.engines[id]} />
            ))}
          </div>
        </Card>
      ) : null}
      {section === "signals" ? (
        <Card title="Signal qualification">
          <p className="text-sm text-muted">A row is qualified only when the lower bound clears the baseline. Expected value is filled after a live proposal, using net profit, not the full payout.</p>
          <Rows
            rows={bulk.opportunities.slice(0, 16).map((row) => ({
              key: `${row.market}-${row.contract}-${row.barrier}`,
              text: `${row.market} ${ENGINE_LABEL[row.engine]} ${row.barrier || ""}`.trim(),
              detail: `${row.qualified ? "Qualified" : "Not qualified"} · estimate ${pct(row.estimated)} · interval ${pct(row.lo)}–${pct(row.hi)} · ${row.streakNote}`,
            }))}
            empty="No scan yet. Enable a market and wait for ticks."
          />
        </Card>
      ) : null}
      {section === "execution" || section === "open" ? (
        <Card title={section === "open" ? "Open trades" : "Execution"}>
          <Rows
            rows={(section === "open" ? open : bulk.trades.slice(0, 12)).map((row) => ({
              key: row.id,
              text: `${row.market} ${row.contract} ${row.barrier} · ${row.status}`,
              detail: `${row.contractId ? `Contract ${row.contractId}. ` : ""}${row.note} Stake ${row.stake}. EV basis ${pct(row.probability)}.`,
            }))}
            empty="No bulk orders yet."
          />
        </Card>
      ) : null}
      {section === "history" ? (
        <Card title="Trade history">
          <Rows
            rows={bulk.trades.filter((row) => row.status !== "pending").slice(0, 30).map((row) => ({
              key: row.id,
              text: `${row.market} ${row.contract} ${row.status}`,
              detail: row.profit == null ? row.note : `${row.note} Profit ${row.profit.toFixed(2)}.`,
            }))}
            empty="No settled or rejected bulk trades yet."
          />
        </Card>
      ) : null}
      {section === "analytics" ? (
        <Card title="Performance">
          <Grid>
            <Fact label="Settled" value={String(stats.trades)} />
            <Fact label="Wins" value={String(stats.wins)} />
            <Fact label="Losses" value={String(stats.losses)} />
            <Fact label="Drawdown" value={stats.drawdown.toFixed(2)} />
          </Grid>
          <p className="mt-3 text-sm text-muted">These figures are this tab's own records. They are not the main desk journal.</p>
        </Card>
      ) : null}
      {section === "risk" ? <RiskForm /> : null}
      {section === "learning" ? <Learning /> : null}
      {section === "settings" ? <RiskForm /> : null}
    </div>
  );
}

function Controls({ real }: { real?: boolean }) {
  const phrase = useBulk((s) => s.realPhrase);
  const started = useBulk((s) => s.realStarted);
  const running = useBulk((s) => s.running);
  return (
    <div className="mt-3 grid gap-2">
      {real ? (
        <label className="text-sm">
          Type START REAL
          <input
            value={phrase}
            onChange={(event) => patchBulk({ realPhrase: event.target.value })}
            placeholder="START REAL"
            className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3"
          />
        </label>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="col-span-2 min-h-11 rounded-md bg-gold px-2 text-sm font-medium text-gold-ink" onClick={() => { if (real && phrase.trim() === "START REAL") patchBulk({ realStarted: true }); setBulkRunning(true); }}>
          {running ? "Running" : "Start Auto Trading"}
        </button>
        <button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm" onClick={() => setBulkRunning(false)}>
          Pause
        </button>
        <button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm" onClick={() => resumeBulk()}>
          Resume
        </button>
        <button type="button" className="min-h-11 rounded-md border border-down px-3 text-sm text-down" onClick={() => stopAllBulk()}>
          Stop All
        </button>
      </div>
      {real && !started ? <p className="text-sm text-down">Real auto trading stays off until START REAL is typed and Start is pressed. It does not turn itself on.</p> : null}
    </div>
  );
}

function EngineRow({ id, on }: { id: EngineId; on: boolean }) {
  return (
    <label className="flex min-h-11 items-center justify-between rounded-md border border-line px-3 text-sm">
      {ENGINE_LABEL[id]}
      <input
        type="checkbox"
        checked={on}
        onChange={(event) => {
          const engines = { ...useBulk.getState().engines, [id]: event.target.checked };
          patchBulk({ engines });
          persistBulk();
        }}
      />
    </label>
  );
}

function RiskForm() {
  const risk = useBulk((s) => s.risk);
  function set(key: keyof typeof risk, value: number) {
    patchBulk({ risk: { ...useBulk.getState().risk, [key]: value } });
    persistBulk();
  }
  const fields: Array<[keyof typeof risk, string]> = [
    ["stake", "Fixed stake"],
    ["maxStake", "Maximum stake"],
    ["duration", "Tick duration"],
    ["maxOpen", "Maximum open trades"],
    ["maxExposure", "Maximum exposure"],
    ["dailyLoss", "Maximum daily loss"],
    ["dailyProfit", "Daily profit target"],
    ["maxConsecutiveLosses", "Consecutive losses"],
    ["cooldownSec", "Cooldown seconds"],
    ["minPayoutMultiple", "Minimum payout multiple"],
    ["minEv", "Minimum expected value"],
    ["minSample", "Minimum ticks"],
  ];
  return (
    <Card title="Bulk risk and settings">
      <p className="text-sm text-muted">These limits belong to this tab. They do not change the Risk tab on the main desk. Stake does not increase after a loss.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {fields.map(([key, label]) => (
          <label key={key} className="text-sm">
            {label}
            <input
              type="number"
              value={risk[key]}
              onChange={(event) => set(key, Number(event.target.value))}
              className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3"
            />
          </label>
        ))}
      </div>
    </Card>
  );
}

function Learning() {
  const trades = useBulk((s) => s.trades);
  const market = useBulk((s) => s.enabledMarkets[0] ?? "");
  const quotes = useBulk((s) => (market ? s.quotes[market] ?? [] : []));
  const pip = useBulk((s) => (market ? s.pip[market] ?? 2 : 2));
  const digits = digitsOf(quotes, pip);
  const hold = digits.slice(Math.floor(digits.length * 0.8));
  const hits = hold.filter((digit) => digit % 2 === 0).length;
  const sample = approximateBacktest(hits, hold.length);
  const rows = calibrate(trades);
  return (
    <Card title="Learning and backtest">
      <p className="text-sm text-muted">{sample.note}</p>
      <ul className="mt-3 grid gap-2">
        {rows.map((row) => (
          <li key={row.bucket} className="rounded-md border border-line px-3 py-2 text-sm">
            <div className="font-mono">{row.bucket}</div>
            <p className="text-muted">Predicted {pct(row.predicted)}. Actual {row.actual == null ? "—" : pct(row.actual)}. Trades {row.trades}. {row.note}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 max-w-full rounded-md border border-line bg-surface p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line px-2 py-2">
      <div className="text-xs tracking-wide text-muted uppercase">{label}</div>
      <div className="mt-1 font-mono text-sm break-all">{value}</div>
    </div>
  );
}

function Rows({ rows, empty }: { rows: { key: string; text: string; detail: string }[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="grid gap-2">
      {rows.map((row) => (
        <li key={row.key} className="rounded-md border border-line px-3 py-2">
          <div className="text-sm break-words">{row.text}</div>
          <p className="text-sm text-pretty break-words text-muted">{row.detail}</p>
        </li>
      ))}
    </ul>
  );
}
