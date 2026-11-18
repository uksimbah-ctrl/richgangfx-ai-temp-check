import { useEffect, useMemo, useRef, useState } from "react";
import { CONTRACT_BY_TYPE } from "@/lib/engine/catalog";
import { strategyRecord } from "@/lib/desk/account-stats";
import { flashText, setSettingsFlash } from "@/lib/desk/settings-flash";
import { useDesk } from "@/lib/desk/store";
import {
  defaultModule,
  MODULE_NAMES,
  STRATEGY_GROUPS,
  moduleScope,
  moduleSupports,
  readModule,
  walkModule,
  type ModuleConfig,
  type ModuleId,
} from "@/lib/engine/modules";
import { pct } from "@/lib/format";
import { saveStrategyModule } from "@/lib/strategy/modules.functions";

const NAMES = MODULE_NAMES;

export function ModulesPanel() {
  const modules = useDesk((s) => s.modules);
  const booted = useDesk((s) => s.booted);
  const focus = useDesk((s) => s.focus);
  const ticks = useDesk((s) => s.ticks);
  const journal = useDesk((s) => s.journal);
  const accountId = useDesk((s) => s.accountId);
  const moduleNotes = useDesk((s) => s.moduleNotes);
  const tradeType = useDesk((s) => s.tradeType);
  const digitPick = useDesk((s) => s.digitPick);
  const pip = useDesk((s) => s.pip);
  const plans = useDesk((s) => s.plans);
  const [walk, setWalk] = useState<Record<string, string>>({});
  const persisted = useRef<Record<ModuleId, ModuleConfig> | null>(null);
  const symbol = focus[0];
  const quotes = (ticks[symbol] ?? []).map((point) => point.q);
  const quoteKey = quotes.length ? `${quotes.length}:${quotes[quotes.length - 1]}` : "0";
  const family = tradeType ? CONTRACT_BY_TYPE.get(tradeType)?.family : undefined;

  useEffect(() => {
    if (booted && !persisted.current) persisted.current = structuredClone(useDesk.getState().modules);
  }, [booted]);

  const readings = useMemo(() => {
    const next = {} as Partial<Record<ModuleId, ReturnType<typeof readModule>>>;
    for (const group of STRATEGY_GROUPS) {
      for (const id of group.ids) {
        if (id === "ensemble") continue;
        next[id] = readModule(id, quotes, modules[id] ?? defaultModule(id));
      }
    }
    return next;
    // quoteKey stands in for the tick series so a same-length same-last-price update does not recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, modules, symbol]);

  function update(id: ModuleId, patch: Partial<ModuleConfig>) {
    useDesk.setState((s) => ({ modules: { ...s.modules, [id]: { ...s.modules[id], ...patch } } }));
  }

  async function save(id: ModuleId) {
    setSettingsFlash({ tone: "saving", text: `Saving ${NAMES[id]}…` });
    const result = await saveStrategyModule({ data: { module: useDesk.getState().modules[id] } });
    if (!result.ok) {
      const previous = persisted.current?.[id];
      if (previous) useDesk.setState((s) => ({ modules: { ...s.modules, [id]: previous } }));
      setSettingsFlash({ tone: "failed", text: flashText("failed", `${NAMES[id]}. ${result.error}`) });
      return;
    }
    persisted.current = { ...(persisted.current ?? useDesk.getState().modules), [id]: result.module };
    useDesk.setState((s) => ({ modules: { ...s.modules, [id]: result.module } }));
    setSettingsFlash({
      tone: "saved",
      text: `Saved ${NAMES[id]}. Other strategies, risk limits, and accounts were not changed.`,
    });
  }

  return (
    <section className="rounded-md border border-blue/40 bg-surface p-3">
      <h2 className="text-sm font-medium text-fg">Strategy center</h2>
      <p className="mt-1 text-sm text-pretty text-muted">
        Picking a contract turns on the strategies that can trade it. You do not choose them. Market Regime only describes the market. The Ensemble cannot force or cancel a valid signal.
      </p>
      <div className="mt-3 grid gap-4">
        {STRATEGY_GROUPS.map((group) => (
          <div key={group.title}>
            <h3 className="text-sm font-medium">{group.title}</h3>
            <p className="mt-1 text-sm text-muted">{group.role}</p>
            <div className="mt-2 grid gap-3">
              {group.ids.map((id) => {
                const cfg = modules[id] ?? defaultModule(id);
                const retired = id === "streakFade" || id === "streakFollow";
                const reading = readings[id] ?? null;
                const record = strategyRecord(journal, accountId, id);
                const note = accountId ? moduleNotes[accountId]?.[id] : null;
                const supports = Boolean(family && tradeType && moduleSupports(id, family, tradeType));
                const live = plans.find((plan) => plan.type === tradeType && plan.status === "pricing" && plan.modules?.includes(id));
                const lastTrade = accountId
                  ? journal.find((row) => row.accountId === accountId && row.modules?.includes(id))
                  : undefined;
                return (
                  <article key={id} className="rounded-md border border-line p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-medium">{NAMES[id]}</h3>
                      <span className={`font-mono text-xs ${cfg.enabled ? "text-gold" : "text-muted"}`}>
                        {retired ? "Retired" : cfg.enabled ? "Selected" : "Not used"}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted">{moduleScope(id)} Status {cfg.status}.</p>
                    <p className="mt-1 text-sm text-fg">
                      {tradeType
                        ? supports
                          ? "Selected for this contract."
                          : "Not used for this contract."
                        : "Pick a contract and the matching strategies turn on."}
                    </p>
                    <details className="rounded-md border border-line px-3">
                      <summary className="min-h-11 cursor-pointer text-sm">Settings</summary>
                      <label className="flex min-h-11 items-center justify-between text-sm">
                        Use in ensemble
                        <input type="checkbox" checked={cfg.participate} onChange={(event) => update(id, { participate: event.target.checked })} />
                      </label>
                      <div className="grid grid-cols-2 gap-2 pb-3">
                        <Num label="Score filter" value={cfg.minConfidence} step={0.05} onChange={(minConfidence) => update(id, { minConfidence })} />
                        <Num label="Minimum ticks" value={cfg.minSample} step={1} onChange={(minSample) => update(id, { minSample })} />
                        <Num
                          label={id === "streakFade" || id === "streakFollow" ? "Minimum streak" : "Lookback"}
                          value={cfg.lookback}
                          step={1}
                          onChange={(lookback) => update(id, { lookback })}
                        />
                        <Num label="Observation loss" value={cfg.maxLoss} step={1} onChange={(maxLoss) => update(id, { maxLoss })} />
                      </div>
                    </details>
                    {reading ? (
                      <p className="mt-2 text-sm text-pretty text-fg">
                        {symbol ?? "No market"} · {reading.reason} Sample {reading.sample}. This is not a guaranteed win rate.
                      </p>
                    ) : (
                      <p className="mt-2 text-sm text-muted">Compares the other strategies. It does not invent a market direction.</p>
                    )}
                    <p className="mt-1 text-sm text-muted">
                      {live ? `Signaling now on ${live.symbol}.` : lastTrade ? `Last trade on this account ${new Date(lastTrade.openedAt).toLocaleString()}.` : "No signal recorded for this account."}
                    </p>
                    <p className="mt-1 font-mono text-xs text-muted">
                      {record
                        ? `This account · ${record.trades} settled · ${record.wins} wins · ${record.losses} losses · net ${record.pnl.toFixed(2)}`
                        : "No settled performance for this strategy on this account."}
                    </p>
                    {note ? <p className="mt-1 text-sm text-gold">{note}</p> : null}
                    {cfg.observeReason ? <p className="mt-1 text-sm text-gold">{cfg.observeReason}</p> : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" onClick={() => void save(id)} className="min-h-11 rounded-md bg-gold px-3 text-sm font-medium text-gold-ink">
                        Save module
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          update(id, { status: "active", observeReason: null });
                          if (!accountId) return;
                          useDesk.setState((s) => {
                            const notes = { ...(s.moduleNotes[accountId] ?? {}) };
                            delete notes[id];
                            return { moduleNotes: { ...s.moduleNotes, [accountId]: notes } };
                          });
                        }}
                        className="min-h-11 rounded-md border border-line px-3 text-sm"
                      >
                        Return to active
                      </button>
                      {id !== "ensemble" ? (
                        <button
                          type="button"
                          onClick={() => {
                            const row = walkModule(id, quotes, cfg, 5, symbol ? (pip[symbol] ?? 2) : 2, {
                              type: tradeType ?? "",
                              barrier: digitPick == null ? "" : String(digitPick),
                            });
                            setWalk((current) => ({
                              ...current,
                              [id]:
                                row.outTrials === 0
                                  ? "Not enough ticks for a walk-forward. Nothing was invented."
                                  : `In-sample ${pct(row.inSample)} · Out-of-sample ${pct(row.outSample)} · Out trials ${row.outTrials}. Historical only.`,
                            }));
                          }}
                          className="min-h-11 rounded-md border border-blue px-3 text-sm text-blue"
                        >
                          Walk-forward
                        </button>
                      ) : null}
                    </div>
                    {walk[id] ? <p className="mt-2 text-sm text-muted">{walk[id]}</p> : null}
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Num({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="block text-xs tracking-wide text-muted uppercase">
      {label}
      <input
        value={Number.isFinite(value) ? value : 0}
        step={step}
        inputMode="decimal"
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg"
      />
    </label>
  );
}
