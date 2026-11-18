import { useEffect, useMemo, useState } from "react";
import { CONTRACTS, CONTRACT_BY_TYPE } from "@/lib/engine/catalog";
import { defaultModules, MODULE_NAMES, STRATEGY_GROUPS, type ModuleId } from "@/lib/engine/modules";
import { applyPreset, defaultProfile, fieldsFor, validateProfile, CONFIDENCE_LEVELS, type PresetName, type StrategyProfile } from "@/lib/engine/profiles";
import { resetLimits } from "@/lib/desk/session";
import { flashText, setSettingsFlash } from "@/lib/desk/settings-flash";
import { useDesk } from "@/lib/desk/store";
import { saveStrategyProfile } from "@/lib/strategy/control.functions";
import { writeLocalBook } from "@/lib/strategy/local";
import { saveStrategyModule } from "@/lib/strategy/modules.functions";

const GROUPS: Array<[string, string[]]> = [
  ["Digits", ["DIGITOVER", "DIGITUNDER", "DIGITDIFF", "DIGITMATCH", "DIGITEVEN", "DIGITODD"]],
  ["Rise and Fall", ["CALL", "PUT", "HIGHER", "LOWER", "CALLE", "PUTE"]],
  ["Touch and range", ["ONETOUCH", "NOTOUCH", "EXPIRYRANGE", "EXPIRYMISS", "RANGE", "UPORDOWN", "EXPIRYRANGEE", "EXPIRYMISSE", "TURBOSLONG", "TURBOSSHORT"]],
  ["Other", ["RESETCALL", "RESETPUT", "ASIANU", "ASIAND", "TICKHIGH", "TICKLOW", "VANILLALONGCALL", "VANILLALONGPUT", "LBFLOATCALL", "LBFLOATPUT", "LBHIGHLOW", "MULTUP", "MULTDOWN", "ACCU", "RUNHIGH", "RUNLOW"]],
];

const BASIC = ["enabled", "duration", "durationUnit", "barrier"] as const;
const DESK_RISK = new Set(["stake", "maxStake", "maxOpen", "cooldownSec", "dailyTradeLimit", "maxDailyLoss", "maxConsecutiveLosses", "maxExposure"]);

const LABEL: Record<string, string> = {
  stake: "Stake",
  maxStake: "Largest stake allowed",
  maxOpen: "Open trades allowed",
  cooldownSec: "Wait after a loss (seconds)",
  dailyTradeLimit: "Trades allowed today",
  maxDailyLoss: "Stop after this much loss",
  maxConsecutiveLosses: "Loss streak before a pause",
  minPayout: "Smallest payout multiple",
  duration: "How long the contract lasts",
  durationUnit: "Time unit",
  barrier: "Barrier or digit",
  minSample: "Ticks needed before a signal",
  shortWindow: "Short digit window",
  mediumWindow: "Medium digit window",
  longWindow: "Long digit window",
  minEffective: "Minimum effective sample",
  intervalZ: "Confidence interval",
  trainSize: "Training sample",
  validationSize: "Validation sample",
  finalSize: "Final out-of-sample sample",
  validationPeriods: "Validation periods",
  minOos: "Minimum out-of-sample evidence",
  method: "Probability method",
  walkForward: "Require a held-out period",
  autoBarrier: "Auto barrier selection",
  minScore: "How strong the signal must be",
  emaFast: "Fast average",
  emaSlow: "Slow average",
  rsiPeriod: "RSI length",
  rsiBuy: "RSI level for a rise",
  rsiSell: "RSI level for a fall",
  minAdx: "Minimum trend strength",
  multiplier: "Multiplier",
  stopLoss: "Stop loss",
  takeProfit: "Take profit",
  maxExposure: "Largest exposure",
  growthRate: "Growth rate",
  window: "Ticks to study",
  markets: "Markets",
};

export function SimpleControl() {
  const profiles = useDesk((s) => s.profiles);
  const modules = useDesk((s) => s.modules);
  const focus = useDesk((s) => s.focus);
  const known = useMemo(() => new Set(CONTRACTS.map((row) => row.type)), []);
  const [type, setType] = useState("CALL");
  const [draft, setDraft] = useState<StrategyProfile>(profiles.CALL ?? defaultProfile("CALL"));
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(useDesk.getState().profiles[type] ?? defaultProfile(type));
  }, [type]);

  const relevant = fieldsFor(type).filter((field) => !DESK_RISK.has(field));
  const basic = BASIC.filter((field) => relevant.includes(field));
  const extra = relevant.filter((field) => !BASIC.includes(field as (typeof BASIC)[number]));
  const meta = CONTRACT_BY_TYPE.get(type);

  function edit<K extends keyof StrategyProfile>(key: K, value: StrategyProfile[K]) {
    setDraft((row) => ({ ...row, [key]: value }));
  }

  async function save(profile: StrategyProfile, action: "save" | "reset" | "reactivate") {
    const errors = validateProfile(profile);
    if (errors.length) {
      setNote(errors[0] ?? "Check the numbers.");
      setSettingsFlash({ tone: "unsaved", text: flashText("unsaved") });
      return;
    }
    setBusy(true);
    setSettingsFlash({ tone: "saving", text: `Saving ${CONTRACT_BY_TYPE.get(profile.type)?.name ?? profile.type}…` });
    const result = await saveStrategyProfile({ data: { profile, action } });
    setBusy(false);
    if (!result.ok) {
      setNote("Changes not saved.");
      setSettingsFlash({ tone: "failed", text: flashText("failed", result.error) });
      return;
    }
    useDesk.setState((s) => {
      const next = { ...s.profiles, [result.profile.type]: result.profile };
      writeLocalBook(next);
      return { profiles: next };
    });
    setDraft(result.profile);
    const label = CONTRACT_BY_TYPE.get(result.profile.type)?.name ?? result.profile.type;
    const text = action === "reset" ? `${label} is back to its starting settings. Other contracts were not changed.` : `Saved ${label}. Other contracts, strategies, and accounts were not changed.`;
    setNote(text);
    setSettingsFlash({ tone: "saved", text });
  }

  async function toggleModule(id: ModuleId, enabled: boolean) {
    const previous = modules[id] ?? defaultModules()[id];
    const next = { ...previous, enabled };
    useDesk.setState((s) => ({ modules: { ...s.modules, [id]: next } }));
    const result = await saveStrategyModule({ data: { module: next } });
    if (!result.ok) {
      useDesk.setState((s) => ({ modules: { ...s.modules, [id]: previous } }));
      const text = flashText("failed", `${MODULE_NAMES[id]}. ${result.error}`);
      setNote("Changes not saved.");
      setSettingsFlash({ tone: "failed", text });
      return;
    }
    useDesk.setState((s) => ({ modules: { ...s.modules, [id]: result.module } }));
    setSettingsFlash({
      tone: "saved",
      text: `${enabled ? "Turned on" : "Turned off"} ${MODULE_NAMES[id]}. Other strategies were not changed.`,
    });
  }

  return (
    <div className="grid gap-3">
      <section className="rounded-md border border-line bg-surface p-3">
        <h2 className="text-sm font-medium">Control</h2>
        <p className="mt-1 text-sm text-pretty text-muted">
          Pick a contract and set the signal. Stake, open trades, loss limit, and cooldown come from the Risk tab. Nothing here turns on real-money trading.
        </p>
        <button
          type="button"
          onClick={() => {
            resetLimits();
            setNote("Limits cleared. The bot can trade again. Real money stays off.");
          }}
          className="mt-3 min-h-11 rounded-md bg-gold px-3 text-sm font-medium text-gold-ink"
        >
          Reset limits
        </button>
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
        <p className="mt-2 text-sm text-muted">{meta?.summary}</p>
        <p className="mt-2 text-sm text-fg">{draft.status === "active" ? "This contract is allowed to signal." : draft.suspendReason || "This contract is paused."}</p>

        <div className="mt-3 flex flex-wrap gap-2">
          {(["conservative", "balanced", "aggressive"] as PresetName[]).map((name) => (
            <button key={name} type="button" onClick={() => setDraft(applyPreset(draft, name))} className="min-h-11 rounded-md border border-line px-3 text-sm capitalize">
              {name}
            </button>
          ))}
        </div>
        <p className="mt-2 text-sm text-muted">These change how picky the signal is. They do not change your stake or loss limit.</p>

        <label className="mt-3 flex min-h-11 items-center justify-between text-sm">
          Use this contract
          <input type="checkbox" checked={draft.enabled} onChange={(event) => edit("enabled", event.target.checked)} />
        </label>
        <div className="mt-3 grid gap-3">
          {basic.filter((field) => field !== "enabled").map((field) => (
            <Editor key={field} field={field} draft={draft} markets={focus} onChange={edit} />
          ))}
        </div>

        {extra.length > 0 ? (
          <details className="mt-3 rounded-md border border-line px-3 py-2">
            <summary className="min-h-11 cursor-pointer text-sm">More settings</summary>
            <div className="grid gap-3 pb-2">
              {extra.map((field) => (
                <Editor key={field} field={field} draft={draft} markets={focus} onChange={edit} />
              ))}
            </div>
          </details>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void save(draft, "save")} className="min-h-11 rounded-md bg-gold px-3 text-sm font-medium text-gold-ink">
            Save
          </button>
          <button type="button" disabled={busy} onClick={() => void save(defaultProfile(type), "reset")} className="min-h-11 rounded-md border border-line px-3 text-sm">
            Starting settings
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save({ ...draft, status: "active", suspendReason: null }, "reactivate")}
            className="min-h-11 rounded-md border border-line px-3 text-sm"
          >
            Turn back on
          </button>
        </div>
        {note ? <p className="mt-3 text-sm text-gold">{note}</p> : null}
      </section>

      <section className="rounded-md border border-line bg-surface px-3 py-3">
        <h2 className="text-sm font-medium">Approved strategies</h2>
        <p className="mt-1 text-sm text-muted">Only these can open a trade. Older contract rules stay saved, but they do not send orders.</p>
        <div className="mt-3 grid gap-3">
          {STRATEGY_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="text-xs tracking-wide text-muted uppercase">{group.title}</div>
              <ul className="mt-1 grid gap-1">
                {group.ids.map((id) => {
                  const retired = id === "streakFade" || id === "streakFollow";
                  return (
                  <li key={id}>
                    <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
                      <span>
                        {MODULE_NAMES[id]}
                        {retired ? <span className="mt-0.5 block text-xs text-muted">Retired. A streak cannot open a trade.</span> : null}
                      </span>
                      <input
                        type="checkbox"
                        checked={!retired && (modules[id]?.enabled ?? false)}
                        disabled={retired}
                        onChange={(event) => void toggleModule(id, event.target.checked)}
                      />
                    </label>
                  </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Editor({
  field,
  draft,
  markets,
  onChange,
}: {
  field: string;
  draft: StrategyProfile;
  markets: string[];
  onChange: <K extends keyof StrategyProfile>(key: K, value: StrategyProfile[K]) => void;
}) {
  if (field === "markets") {
    return (
      <div>
        <div className="text-xs tracking-wide text-muted uppercase">Markets</div>
        <p className="mt-1 text-sm text-muted">Blank means every market you are watching.</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {markets.map((symbol) => {
            const on = draft.markets.includes(symbol);
            return (
              <button
                key={symbol}
                type="button"
                onClick={() => onChange("markets", on ? draft.markets.filter((item) => item !== symbol) : [...draft.markets, symbol])}
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
        Time unit
        <select
          value={draft.durationUnit}
          onChange={(event) => onChange("durationUnit", event.target.value as StrategyProfile["durationUnit"])}
          className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg normal-case"
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
      <label className="flex min-h-11 items-center justify-between gap-3 text-sm normal-case">
        {field === "walkForward" ? "Require a held-out period" : "Auto barrier selection"}
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => onChange(field, event.target.checked)}
        />
      </label>
    );
  }
  if (field === "intervalZ") {
    const current = CONFIDENCE_LEVELS.reduce((best, item) => (Math.abs(item.z - draft.intervalZ) < Math.abs(best.z - draft.intervalZ) ? item : best));
    return (
      <label className="block text-xs tracking-wide text-muted uppercase">
        Confidence interval
        <select
          value={String(current.z)}
          onChange={(event) => onChange("intervalZ", Number(event.target.value))}
          className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg normal-case"
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
        Probability method
        <select
          value={draft.method}
          onChange={(event) => onChange("method", event.target.value === "beta-binomial" ? "beta-binomial" : draft.method)}
          className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg normal-case"
        >
          <option value="beta-binomial">Beta-Binomial with Wilson bound</option>
        </select>
      </label>
    );
  }
  const value = draft[field as keyof StrategyProfile];
  return (
    <label className="block text-xs tracking-wide text-muted uppercase">
      {LABEL[field] ?? field}
      <input
        value={typeof value === "number" || typeof value === "string" ? value : ""}
        inputMode={typeof value === "number" ? "decimal" : "text"}
        onChange={(event) => onChange(field as keyof StrategyProfile, (typeof value === "number" ? Number(event.target.value) : event.target.value) as never)}
        className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg normal-case"
      />
    </label>
  );
}
