import { useEffect, useMemo, useState } from "react";
import { CONTRACTS, CONTRACT_BY_TYPE } from "@/lib/engine/catalog";
import { optimizeDigit, optimizeEma, type OptRow } from "@/lib/engine/optimize";
import {
  applyPreset,
  CONFIDENCE_LEVELS,
  defaultProfile,
  fieldsFor,
  validateProfile,
  type PresetName,
  type StrategyProfile,
} from "@/lib/engine/profiles";
import { loadStrategyDesk, saveStrategyProfile } from "@/lib/strategy/control.functions";
import { writeLocalBook } from "@/lib/strategy/local";
import { useDesk } from "@/lib/desk/store";
import { pct } from "@/lib/format";
import { ModulesPanel } from "@/components/terminal/modules-panel";

const GROUPS: Array<[string, string[]]> = [
  ["Digits", ["DIGITOVER", "DIGITUNDER", "DIGITDIFF", "DIGITMATCH", "DIGITEVEN", "DIGITODD"]],
  ["Directional", ["CALL", "PUT", "HIGHER", "LOWER", "CALLE", "PUTE"]],
  ["Barrier", ["ONETOUCH", "NOTOUCH", "EXPIRYRANGE", "EXPIRYMISS", "RANGE", "UPORDOWN", "EXPIRYRANGEE", "EXPIRYMISSE", "TURBOSLONG", "TURBOSSHORT"]],
  ["Other", ["RESETCALL", "RESETPUT", "ASIANU", "ASIAND", "TICKHIGH", "TICKLOW", "VANILLALONGCALL", "VANILLALONGPUT", "LBFLOATCALL", "LBFLOATPUT", "LBHIGHLOW", "MULTUP", "MULTDOWN", "ACCU", "RUNHIGH", "RUNLOW"]],
];

const LABELS: Record<string, string> = {
  enabled: "Enabled",
  markets: "Markets",
  stake: "Stake",
  maxStake: "Maximum stake",
  maxOpen: "Maximum open trades",
  cooldownSec: "Cooldown seconds",
  dailyTradeLimit: "Daily trade limit",
  maxDailyLoss: "Maximum daily loss",
  maxConsecutiveLosses: "Maximum consecutive losses",
  minEv: "Minimum expected value",
  minPayout: "Minimum payout multiple",
  duration: "Duration",
  durationUnit: "Duration unit",
  barrier: "Barrier",
  minSample: "Minimum sample",
  shortWindow: "Short window",
  mediumWindow: "Medium window",
  longWindow: "Long window",
  minEffective: "Minimum effective sample",
  intervalZ: "Confidence interval",
  trainSize: "Training sample",
  validationSize: "Validation sample",
  finalSize: "Final out-of-sample sample",
  validationPeriods: "Validation periods",
  minOos: "Minimum out-of-sample evidence",
  method: "Probability method",
  walkForward: "Walk-forward validation",
  autoBarrier: "Auto barrier selection",
  minScore: "Minimum signal score",
  emaFast: "Fast EMA",
  emaSlow: "Slow EMA",
  rsiPeriod: "RSI period",
  rsiBuy: "RSI buy level",
  rsiSell: "RSI sell level",
  minAdx: "Minimum ADX",
  multiplier: "Multiplier",
  stopLoss: "Stop loss",
  takeProfit: "Take profit",
  maxExposure: "Maximum exposure",
  growthRate: "Growth rate",
  window: "Analysis window",
};

export function StrategyCenter() {
  const profiles = useDesk((s) => s.profiles);
  const journal = useDesk((s) => s.journal);
  const accountId = useDesk((s) => s.accountId);
  const focus = useDesk((s) => s.focus);
  const ticks = useDesk((s) => s.ticks);
  const [type, setType] = useState("CALL");
  const [draft, setDraft] = useState<StrategyProfile>(profiles.CALL ?? defaultProfile("CALL"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<Array<{ id: number; contract_type: string; version: number; action: string; created_at: string }>>([]);
  const [rows, setRows] = useState<OptRow[]>([]);
  const [compare, setCompare] = useState("PUT");

  useEffect(() => {
    setDraft(profiles[type] ?? defaultProfile(type));
    setError(null);
    setRows([]);
  }, [type, profiles]);

  useEffect(() => {
    void loadStrategyDesk()
      .then((loaded) => {
        useDesk.setState((s) => ({ profiles: { ...s.profiles, ...loaded.profiles } }));
        setAudit(loaded.audit);
      })
      .catch(() => setError("Could not read saved strategies."));
  }, []);

  const known = useMemo(() => new Set(CONTRACTS.map((row) => row.type)), []);
  const active = CONTRACTS.filter((row) => profiles[row.type]?.enabled && profiles[row.type]?.status === "active").length;
  const disabled = CONTRACTS.filter((row) => profiles[row.type]?.enabled === false).length;
  const testing = CONTRACTS.filter((row) => profiles[row.type]?.status === "testing").length;
  const suspended = CONTRACTS.filter((row) => profiles[row.type]?.status === "suspended").length;
  const live = performanceOf(journal, type, accountId);

  function patch<K extends keyof StrategyProfile>(key: K, value: StrategyProfile[K]) {
    setDraft((row) => ({ ...row, [key]: value }));
  }

  async function persist(profile: StrategyProfile, action: "save" | "reset" | "reactivate" | "suspend" | "import") {
    const errors = validateProfile(profile);
    if (errors.length) {
      setError(errors[0] ?? "Invalid settings.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await saveStrategyProfile({ data: { profile, action } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    useDesk.setState((s) => {
      const profiles = { ...s.profiles, [result.profile.type]: result.profile };
      writeLocalBook(profiles);
      return { profiles };
    });
    setDraft(result.profile);
    const loaded = await loadStrategyDesk();
    setAudit(loaded.audit);
  }

  function runOptimizer() {
    const symbol = draft.markets[0] || focus[0];
    const prices = (ticks[symbol] ?? []).map((point) => point.q);
    if (prices.length < 80) {
      setError("Need about 80 ticks on the selected market before a walk-forward test.");
      setRows([]);
      return;
    }
    const family = CONTRACT_BY_TYPE.get(type)?.family;
    if (family === "digit") {
      const barriers = type === "DIGITEVEN" || type === "DIGITODD" ? [""] : ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
      setRows(optimizeDigit(prices, 2, type, barriers));
    } else {
      setRows(optimizeEma(prices, draft.duration));
    }
    setError(null);
  }

  function applyReviewed(row: OptRow) {
    const ema = /EMA (\d+)\/(\d+)/.exec(row.label);
    if (ema) {
      setDraft((current) => ({ ...current, emaFast: Number(ema[1]), emaSlow: Number(ema[2]) }));
      setError("Copied into the draft. Review it, then save. Nothing was applied to live trading.");
      return;
    }
    const barrier = row.label.split(" ").at(-1);
    if (barrier && barrier !== "barrier") {
      setDraft((current) => ({ ...current, barrier: barrier === "no" ? "" : barrier }));
      setError("Copied into the draft. Review it, then save. Nothing was applied to live trading.");
    }
  }

  function exportSettings() {
    const blob = new Blob([JSON.stringify(profiles, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "richgangfx-strategies.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importSettings(file: File) {
    const text = await file.text();
    const parsed = JSON.parse(text) as Record<string, StrategyProfile>;
    for (const [key, profile] of Object.entries(parsed)) {
      if (!known.has(key)) continue;
      await persist({ ...defaultProfile(key), ...profile, type: key }, "import");
    }
  }

  const fields = fieldsFor(type).filter((field) => !["stake", "maxStake", "maxOpen", "cooldownSec", "dailyTradeLimit", "maxDailyLoss", "maxConsecutiveLosses", "maxExposure"].includes(field));
  const other = profiles[compare] ?? defaultProfile(compare);

  return (
    <div className="grid gap-3">
      <ModulesPanel />
      <section className="rounded-md border border-line bg-surface p-3">
        <h2 className="text-sm font-medium text-fg">Strategy Control Center</h2>
        <p className="mt-1 text-sm text-pretty text-muted">
          Each contract keeps its own signal settings. Stake, open trades, loss limit, cooldown, and exposure come from the Risk tab. Enabling a strategy does not arm demo or real trading.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Strategies" value={String(CONTRACTS.length)} />
          <Stat label="Active" value={String(active)} />
          <Stat label="Disabled" value={String(disabled)} />
          <Stat label="Testing" value={String(testing)} />
          <Stat label="Suspended" value={String(suspended)} />
          <Stat label="Live trades" value={String(live.trades)} />
        </div>
      </section>

      <section className="rounded-md border border-blue/40 bg-surface p-3">
        <label className="text-xs tracking-wide text-blue uppercase">Contract</label>
        <select
          value={type}
          onChange={(event) => setType(event.target.value)}
          className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm"
        >
          {GROUPS.map(([label, types]) => (
            <optgroup key={label} label={label}>
              {types.filter((item) => known.has(item)).map((item) => (
                <option key={item} value={item}>
                  {CONTRACT_BY_TYPE.get(item)?.name ?? item}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div className="mt-3 flex flex-wrap gap-2">
          {(["conservative", "balanced", "aggressive"] as PresetName[]).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setDraft(applyPreset(draft, name))}
              className="min-h-11 rounded-md border border-line px-3 text-sm capitalize"
            >
              {name}
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {fields.map((field) => (
            <Field
              key={field}
              label={LABELS[field] ?? field}
              field={field}
              draft={draft}
              markets={focus}
              onChange={patch}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void persist(draft, "save")} className="min-h-11 rounded-md bg-gold px-3 text-sm font-medium text-gold-ink">
            Save
          </button>
          <button type="button" disabled={busy} onClick={() => void persist(defaultProfile(type), "reset")} className="min-h-11 rounded-md border border-line px-3 text-sm">
            Reset
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void persist({ ...draft, status: "active", suspendReason: null }, "reactivate")}
            className="min-h-11 rounded-md border border-blue px-3 text-sm text-blue"
          >
            Reactivate
          </button>
          <button type="button" onClick={exportSettings} className="min-h-11 rounded-md border border-line px-3 text-sm">
            Export
          </button>
          <label className="min-h-11 cursor-pointer rounded-md border border-line px-3 py-2 text-sm">
            Import
            <input
              type="file"
              accept="application/json"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importSettings(file);
              }}
            />
          </label>
        </div>
        {error ? <p className="mt-3 text-sm text-pretty text-gold">{error}</p> : null}
        <p className="mt-3 text-sm text-muted">
          Status {draft.status}. Version {draft.version}. {draft.suspendReason ?? "Not suspended."}
        </p>
      </section>

      <section className="grid gap-3">
        <Perf title="Selected account" stats={live} />
      </section>

      <section className="rounded-md border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Walk-forward test</h2>
          <button type="button" onClick={runOptimizer} className="min-h-11 rounded-md border border-blue px-3 text-sm text-blue">
            Test parameters
          </button>
        </div>
        <p className="mt-1 text-sm text-muted">In-sample and out-of-sample are shown separately. Saving is a separate step.</p>
        <ul className="mt-3 grid gap-2">
          {rows.map((row) => (
            <li key={row.label} className="rounded-md border border-line px-3 py-2 text-sm">
              <div className="font-medium">{row.label}</div>
              <p className="mt-1 font-mono text-xs text-muted">
                In {pct(row.inSampleHit)} · Out {pct(row.outSampleHit)} · Out trials {row.outTrials}
                {row.fair != null ? ` · Fair ${pct(row.fair)}` : ""}
              </p>
              <button type="button" onClick={() => applyReviewed(row)} className="mt-2 min-h-11 text-sm text-gold">
                Copy to draft
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-md border border-line bg-surface p-3">
        <h2 className="text-sm font-medium">Compare</h2>
        <select value={compare} onChange={(event) => setCompare(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm">
          {CONTRACTS.map((row) => (
            <option key={row.type} value={row.type}>
              {row.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setDraft({ ...other, type, version: draft.version, status: draft.status, suspendReason: draft.suspendReason })}
          className="mt-3 min-h-11 rounded-md border border-line px-3 text-sm"
        >
          Copy onto this draft
        </button>
        <ul className="mt-3 grid gap-1 text-sm">
          {fields
            .filter((field) => JSON.stringify(draft[field as keyof StrategyProfile]) !== JSON.stringify(other[field as keyof StrategyProfile]))
            .map((field) => (
              <li key={field} className="font-mono text-xs text-muted">
                {LABELS[field]}: {String(draft[field as keyof StrategyProfile])} vs {String(other[field as keyof StrategyProfile])}
              </li>
            ))}
        </ul>
      </section>

      <section className="rounded-md border border-line bg-surface p-3">
        <h2 className="text-sm font-medium">Change history</h2>
        <ul className="mt-2 grid gap-1">
          {audit.filter((row) => row.contract_type === type).length === 0 ? <li className="text-sm text-muted">No saved changes for this contract yet.</li> : null}
          {audit
            .filter((row) => row.contract_type === type)
            .map((row) => (
              <li key={row.id} className="font-mono text-xs text-muted">
                v{row.version} {row.action} {row.created_at}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <div className="text-xs tracking-wide text-muted uppercase">{label}</div>
      <div className="mt-1 font-mono text-lg text-gold">{value}</div>
    </div>
  );
}

function Perf({ title, stats }: { title: string; stats: PerfStats }) {
  return (
    <section className="rounded-md border border-line bg-surface p-3">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-2 font-mono text-xs text-muted">
        Trades {stats.trades} · Wins {stats.wins} · Losses {stats.losses} · Win rate {stats.trades ? pct(stats.wins / stats.trades) : "—"}
      </p>
      <p className="mt-1 font-mono text-xs text-muted">
        Net {stats.trades ? stats.net.toFixed(2) : "—"} · Profit factor {stats.profitFactor == null ? "—" : stats.profitFactor.toFixed(2)} · Drawdown {stats.drawdown.toFixed(2)}
      </p>
      <p className="mt-1 font-mono text-xs text-muted">
        Average payout {stats.avgPayout == null ? "—" : stats.avgPayout.toFixed(2)} · Last {stats.last ?? "—"}
      </p>
    </section>
  );
}

type PerfStats = {
  trades: number;
  wins: number;
  losses: number;
  net: number;
  profitFactor: number | null;
  drawdown: number;
  avgPayout: number | null;
  last: string | null;
};

function performanceOf(
  journal: { contractType: string; accountId?: string; accountType: string; status: string; profit?: number; payout: number | null; closedAt?: number }[],
  type: string,
  accountId: string | null,
) {
  return summarize(journal, type, accountId);
}

function summarize(
  journal: { contractType: string; accountId?: string; accountType: string; status: string; profit?: number; payout: number | null; closedAt?: number }[],
  type: string,
  accountId: string | null,
): PerfStats {
  const rows = journal.filter((row) => row.contractType === type && accountId && row.accountId === accountId && row.status !== "open");
  let net = 0;
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let peak = 0;
  let drawdown = 0;
  let payoutSum = 0;
  let payoutN = 0;
  for (const row of rows) {
    const profit = row.profit ?? 0;
    net += profit;
    if (profit > 0) {
      wins += 1;
      grossWin += profit;
    } else if (profit < 0) {
      losses += 1;
      grossLoss += -profit;
    }
    peak = Math.max(peak, net);
    drawdown = Math.max(drawdown, peak - net);
    if (row.payout != null) {
      payoutSum += row.payout;
      payoutN += 1;
    }
  }
  const last = rows.at(-1);
  return {
    trades: rows.length,
    wins,
    losses,
    net,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    drawdown,
    avgPayout: payoutN ? payoutSum / payoutN : null,
    last: last?.closedAt ? new Date(last.closedAt).toLocaleString() : null,
  };
}

function Field({
  label,
  field,
  draft,
  markets,
  onChange,
}: {
  label: string;
  field: string;
  draft: StrategyProfile;
  markets: string[];
  onChange: <K extends keyof StrategyProfile>(key: K, value: StrategyProfile[K]) => void;
}) {
  if (field === "enabled") {
    return (
      <label className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-line px-3 text-sm">
        {label}
        <input type="checkbox" checked={draft.enabled} onChange={(event) => onChange("enabled", event.target.checked)} />
      </label>
    );
  }
  if (field === "markets") {
    return (
      <div>
        <div className="text-xs tracking-wide text-muted uppercase">{label}</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {markets.map((symbol) => {
            const on = draft.markets.includes(symbol);
            return (
              <button
                key={symbol}
                type="button"
                onClick={() =>
                  onChange(
                    "markets",
                    on ? draft.markets.filter((item) => item !== symbol) : [...draft.markets, symbol],
                  )
                }
                className={`min-h-11 rounded-md border px-3 font-mono text-xs ${on ? "border-gold text-gold" : "border-line text-muted"}`}
              >
                {symbol}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  if (field === "durationUnit") {
    return (
      <label className="block text-xs tracking-wide text-muted uppercase">
        {label}
        <select
          value={draft.durationUnit}
          onChange={(event) => onChange("durationUnit", event.target.value as StrategyProfile["durationUnit"])}
          className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg"
        >
          <option value="t">Ticks</option>
          <option value="s">Seconds</option>
          <option value="m">Minutes</option>
        </select>
      </label>
    );
  }
  if (field === "walkForward" || field === "autoBarrier") {
    const on = field === "walkForward" ? draft.walkForward : draft.autoBarrier;
    return (
      <label className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-line px-3 text-sm">
        {label}
        <input type="checkbox" checked={on} onChange={(event) => onChange(field, event.target.checked)} />
      </label>
    );
  }
  if (field === "intervalZ") {
    const current = CONFIDENCE_LEVELS.reduce((best, item) => (Math.abs(item.z - draft.intervalZ) < Math.abs(best.z - draft.intervalZ) ? item : best));
    return (
      <label className="block text-xs tracking-wide text-muted uppercase">
        {label}
        <select
          value={String(current.z)}
          onChange={(event) => onChange("intervalZ", Number(event.target.value))}
          className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg"
        >
          {CONFIDENCE_LEVELS.map((item) => (
            <option key={item.z} value={item.z}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field === "method") {
    return (
      <label className="block text-xs tracking-wide text-muted uppercase">
        {label}
        <select
          value={draft.method}
          onChange={() => onChange("method", "beta-binomial")}
          className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg"
        >
          <option value="beta-binomial">Beta-Binomial with Wilson bound</option>
        </select>
      </label>
    );
  }
  const value = draft[field as keyof StrategyProfile];
  return (
    <label className="block text-xs tracking-wide text-muted uppercase">
      {label}
      <input
        value={typeof value === "number" || typeof value === "string" ? value : ""}
        onChange={(event) => {
          const numeric = typeof value === "number";
          onChange(field as keyof StrategyProfile, (numeric ? Number(event.target.value) : event.target.value) as never);
        }}
        inputMode={typeof value === "number" ? "decimal" : "text"}
        className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg"
      />
    </label>
  );
}
