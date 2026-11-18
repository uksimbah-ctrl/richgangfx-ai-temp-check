// @ts-nocheck
import { SimpleControl } from "@/components/terminal/simple-control";
import { ModulesPanel } from "@/components/terminal/modules-panel";
import { MartingaleControl } from "@/components/terminal/martingale";
import { DigitInsight } from "@/components/terminal/digit-insight";
import { DigitDiagnostics } from "@/components/terminal/digit-diagnostics";
import { BulkTrader } from "@/components/bulk/bulk-trader";
import { DeskHome } from "@/components/terminal/desk-home";
import { JournalPanel } from "@/components/terminal/journal-panel";
import { HelpDesk, MarketChart, Notifications } from "@/components/terminal/desk-pages";
import { useEffect, useMemo, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { Line, LineChart as LineChart$1, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { signed, quoteText, money, pct, clock } from "@/lib/format";
import { lastDigit, digitChoices } from "@/lib/engine/math";
import { CONTRACTS, CONTRACT_BY_TYPE, FAMILY_LABEL, contractName } from "@/lib/engine/catalog";
import { DEFAULT_RISK, researchProfile } from "@/lib/engine/risk";
import { useDesk } from "@/lib/desk/store";
import {
  switchAccount,
  updateRisk,
  setMode,
  disconnect,
  setTradeType,
  pinSymbol,
  setArmDemo,
  setDigitPick,
  realizedToday,
  approve,
  flatten,
  resetLimits,
  setBatchSize,
  setArmReal,
  beginOAuth,
  DERIV_CLIENT_ID,
  lossStreak,
  runBacktest,
  setRealPhrase,
  toggleStrategy,
  setView,
} from "@/lib/desk/session";

function Panel({ title, action, children }) {
	return /* @__PURE__ */ jsxs("section", {
		className: "rounded-md border border-line bg-surface shadow-[0_10px_30px_rgba(0,0,0,0.28)] backdrop-blur-md",
		children: [/* @__PURE__ */ jsxs("header", {
			className: "flex items-center justify-between gap-3 border-b border-line px-3 py-2",
			children: [/* @__PURE__ */ jsx("h2", {
				className: "text-sm font-medium text-fg",
				children: title
			}), action]
		}), /* @__PURE__ */ jsx("div", {
			className: "p-3",
			children
		})]
	});
}
function Stat({ label, value, tone = "fg" }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "rounded-md border border-line bg-raised/80 px-3 py-3",
		children: [/* @__PURE__ */ jsx("div", {
			className: "text-xs tracking-wide text-muted uppercase",
			children: label
		}), /* @__PURE__ */ jsx("div", {
			className: `mt-1 font-mono text-lg tabular-nums ${tone === "gold" ? "text-gold" : tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "muted" ? "text-muted" : "text-fg"}`,
			children: value
		})]
	});
}
function Btn({ children, onClick, kind = "ghost", type = "button", disabled }) {
	return /* @__PURE__ */ jsx("button", {
		type,
		disabled,
		onClick,
		className: `inline-flex min-h-11 items-center justify-center rounded-md px-3 text-sm font-medium ${kind === "gold" ? "bg-gold text-gold-ink" : kind === "danger" ? "bg-down text-gold-ink" : "border border-line bg-raised text-fg"}`,
		children
	});
}
function TextInput(props) {
	return /* @__PURE__ */ jsx("input", {
		...props,
		className: `min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg outline-none focus:border-gold ${props.className ?? ""}`
	});
}
function Field({ label, children }) {
	return /* @__PURE__ */ jsxs("label", {
		className: "block",
		children: [/* @__PURE__ */ jsx("span", {
			className: "mb-1 block text-xs tracking-wide text-muted uppercase",
			children: label
		}), children]
	});
}
function Pill({ children, tone = "muted" }) {
	return /* @__PURE__ */ jsx("span", {
		className: `inline-flex items-center rounded-sm border px-2 py-1 font-mono text-xs ${tone === "up" ? "text-up border-up" : tone === "down" ? "text-down border-down" : tone === "gold" ? "text-gold border-gold" : "text-muted border-line"}`,
		children
	});
}
//#endregion
//#region src/components/terminal/views.tsx
function DeskViews() {
	const view = useDesk((s) => s.view);
	if (view === "overview") return /* @__PURE__ */ jsx(Overview, {});
	if (view === "scanner") return /* @__PURE__ */ jsx(Scanner, {});
	if (view === "signals") return /* @__PURE__ */ jsx(Signals, {});
	if (view === "auto") return /* @__PURE__ */ jsx(Auto, {});
	if (view === "strategies") return /* @__PURE__ */ jsx(ModulesPanel, {});
	if (view === "positions") return /* @__PURE__ */ jsx(Positions, {});
	if (view === "history") return /* @__PURE__ */ jsx(History$1, {});
	if (view === "analytics") return /* @__PURE__ */ jsx(Analytics, {});
	if (view === "backtest") return /* @__PURE__ */ jsx(Backtest, {});
	if (view === "risk") return /* @__PURE__ */ jsx(Risk, {});
	if (view === "control") return /* @__PURE__ */ jsx(SimpleControl, {});
	if (view === "chart") return /* @__PURE__ */ jsx(MarketChart, {});
	if (view === "alerts") return /* @__PURE__ */ jsx(Notifications, {});
	if (view === "help") return /* @__PURE__ */ jsx(HelpDesk, {});
	if (view === "bulk") return /* @__PURE__ */ jsx(BulkTrader, {});
	return /* @__PURE__ */ jsx(Settings$1, {});
}
function Overview() {
	return /* @__PURE__ */ jsxs("div", {
		className: "grid gap-3",
		children: [/* @__PURE__ */ jsx(DeskHome, {}), /* @__PURE__ */ jsx(DigitBoard, {})]
	});
}
function Scanner() {
	const symbols = useDesk((s) => s.symbols);
	const quotes = useDesk((s) => s.quotes);
	const ticks = useDesk((s) => s.ticks);
	const focus = useDesk((s) => s.focus);
	const offered = useDesk((s) => s.offered);
	const [q, setQ] = useState("");
	const rows = symbols.filter((row) => {
		return `${row.underlying_symbol} ${row.underlying_symbol_name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase());
	});
	return /* @__PURE__ */ jsx("div", {
		className: "grid gap-3",
		children: /* @__PURE__ */ jsxs(Panel, {
			title: "Market scanner",
			action: /* @__PURE__ */ jsxs("span", {
				className: "font-mono text-xs text-muted",
				children: [symbols.length, " symbols"]
			}),
			children: [/* @__PURE__ */ jsx(TextInput, {
				value: q,
				onChange: (e) => setQ(e.target.value),
				placeholder: "Filter symbols"
			}), /* @__PURE__ */ jsx("ul", {
				className: "mt-3 grid gap-2",
				children: rows.length === 0 ? /* @__PURE__ */ jsx("li", {
					className: "text-sm text-muted",
					children: symbols.length === 0 ? "Symbol list has not arrived yet." : "No symbol matches that filter."
				}) : rows.slice(0, 40).map((row) => {
					const tick = quotes[row.underlying_symbol];
					const streaming = focus.includes(row.underlying_symbol);
					return /* @__PURE__ */ jsxs("li", {
						className: "rounded-md border border-line px-3 py-2",
						children: [
							/* @__PURE__ */ jsxs("div", {
								className: "flex items-start justify-between gap-2",
								children: [
									/* @__PURE__ */ jsxs("div", {
										className: "min-w-0",
										children: [
											/* @__PURE__ */ jsx("div", { className: "font-mono text-sm", children: row.underlying_symbol }),
											/* @__PURE__ */ jsx("div", { className: "truncate text-xs text-muted", children: row.underlying_symbol_name ?? "Market" })
										]
									}),
									/* @__PURE__ */ jsx("span", {
										className: "font-mono text-sm tabular-nums text-gold",
										children: tick ? quoteText(tick.quote, tick.pip_size) : "—"
									})
								]
							}),
							/* @__PURE__ */ jsxs("div", {
								className: "mt-2 flex items-center justify-between gap-2",
								children: [
									/* @__PURE__ */ jsx("span", {
										className: "font-mono text-xs text-muted",
										children: `${ticks[row.underlying_symbol]?.length ?? 0} ticks · ${offered[row.underlying_symbol]?.length ?? "—"} contracts`
									}),
									/* @__PURE__ */ jsx(Btn, {
										kind: streaming ? "gold" : "ghost",
										onClick: () => void pinSymbol(row.underlying_symbol),
										children: streaming ? "Watching" : "Watch"
									})
								]
							})
						]
					}, row.underlying_symbol);
				})
			})]
		})
	});
}
function Signals() {
	const opportunities = useDesk((s) => s.opportunities);
	const mode = useDesk((s) => s.mode);
	const plans = useDesk((s) => s.plans);
	const tradeType = useDesk((s) => s.tradeType);
	const mine = tradeType ? plans.filter((plan) => plan.type === tradeType) : [];
	const ready = mine.filter((plan) => plan.status === "pricing").slice(0, 8);
	const warming = mine.filter((plan) => plan.status === "warming").slice(0, 6);
	const quotes = tradeType ? opportunities.filter((row) => row.type === tradeType) : [];
	return /* @__PURE__ */ jsxs("div", {
		className: "grid gap-3",
		children: [/* @__PURE__ */ jsx(Panel, {
			title: "Live proposals",
			children: mode === "scanner" ? /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted",
				children: "Scanner mode is analysis only. Switch to Signals, Semi-auto, or Full auto to request proposals."
			}) : quotes.length === 0 ? /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted",
				children: tradeType ? "No quote yet for the selected strategy." : "Pick the contract on Auto. Signals follow that strategy only."
			}) : /* @__PURE__ */ jsx(OppList, { rows: quotes })
		}), /* @__PURE__ */ jsxs(Panel, {
			title: "Setups being considered",
			children: [ready.length === 0 ? /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted",
				children: !tradeType ? "Pick the contract on Auto." : warming.length === 0 ? "This strategy is standing aside. Its own rule has not triggered." : "This strategy is still collecting ticks."
			}) : /* @__PURE__ */ jsx("ul", {
				className: "grid gap-2",
				children: ready.map((plan) => /* @__PURE__ */ jsxs("li", {
					className: "rounded-md border border-line px-3 py-2",
					children: [
						/* @__PURE__ */ jsxs("div", {
							className: "flex items-center justify-between gap-2",
							children: [/* @__PURE__ */ jsx("span", {
								className: "font-medium",
								children: plan.name
							}), /* @__PURE__ */ jsx("span", {
								className: "font-mono text-xs text-muted",
								children: plan.symbol
							})]
						}),
						/* @__PURE__ */ jsx("p", {
							className: "mt-1 text-sm text-muted",
							children: plan.note
						}),
						/* @__PURE__ */ jsxs("div", {
							className: "mt-1 font-mono text-xs text-gold",
							children: [
								"Model ",
								pct(plan.pModel),
								" · Conservative ",
								pct(plan.pCons)
							]
						})
					]
				}, `${plan.symbol}-${plan.type}-${plan.request?.barrier ?? ""}`))
			}), warming.length > 0 ? /* @__PURE__ */ jsx("ul", {
				className: "mt-3 grid gap-2",
				children: warming.map((plan) => /* @__PURE__ */ jsxs("li", {
					className: "text-sm text-muted",
					children: [
						/* @__PURE__ */ jsx("span", {
							className: "font-mono text-fg",
							children: plan.symbol
						}),
						" ",
						plan.name,
						": ",
						plan.note
					]
				}, `${plan.symbol}-${plan.type}-warm`))
			}) : null]
		})]
	});
}
function OppList({ rows }) {
	const mode = useDesk((s) => s.mode);
	return /* @__PURE__ */ jsx("ul", {
		className: "grid gap-2",
		children: rows.map((row) => /* @__PURE__ */ jsxs("li", {
			className: "rounded-md border border-line bg-bg px-3 py-3",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "flex flex-wrap items-center gap-2",
					children: [
						/* @__PURE__ */ jsx("span", {
							className: "font-medium",
							children: row.name
						}),
						/* @__PURE__ */ jsx("span", {
							className: "font-mono text-xs text-muted",
							children: row.symbol
						}),
						row.ev != null && row.ev > 0 ? /* @__PURE__ */ jsx(Pill, {
							tone: "up",
							children: `EV ${row.ev.toFixed(3)}`
						}) : null,
						/* @__PURE__ */ jsx("span", {
							className: "ml-auto font-mono text-xs text-muted",
							children: clock(row.at)
						})
					]
				}),
				/* @__PURE__ */ jsx("p", {
					className: "mt-2 text-sm text-pretty text-muted",
					children: row.longcode
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "mt-2 flex flex-wrap gap-3 font-mono text-xs tabular-nums text-fg",
					children: [
						/* @__PURE__ */ jsxs("span", { children: ["P ", pct(row.pCons)] }),
						/* @__PURE__ */ jsxs("span", { children: ["Ask ", row.ask == null ? "—" : row.ask] }),
						/* @__PURE__ */ jsxs("span", { children: ["Payout ", row.payout == null ? "—" : row.payout] })
					]
				}),
				row.reasons.length > 0 ? /* @__PURE__ */ jsx("p", {
					className: "mt-2 text-sm text-down",
					children: row.reasons[0]
				}) : null,
				mode === "semi" && row.tradable ? /* @__PURE__ */ jsx("div", {
					className: "mt-3",
					children: /* @__PURE__ */ jsx(Btn, {
						kind: "gold",
						onClick: () => void approve(row.id),
						children: "Approve trade"
					})
				}) : null
			]
		}, row.id))
	});
}
var DIGIT_CONTRACTS = [
	"DIGITEVEN",
	"DIGITODD",
	"DIGITOVER",
	"DIGITUNDER",
	"DIGITMATCH",
	"DIGITDIFF"
];
function DigitBoard() {
	const focus = useDesk((s) => s.focus);
	const ticks = useDesk((s) => s.ticks);
	const quotes = useDesk((s) => s.quotes);
	const pip = useDesk((s) => s.pip);
	const tradeType = useDesk((s) => s.tradeType);
	const digitPick = useDesk((s) => s.digitPick);
	const [symbol, setSymbol] = useState(null);
	const active = symbol && focus.includes(symbol) ? symbol : focus[0] ?? null;
	const series = active ? ticks[active] ?? [] : [];
	const places = active ? pip[active] ?? quotes[active]?.pip_size ?? 2 : 2;
	const prices = series.map((point) => point.q);
	const sample = prices.length;
	const last = sample ? lastDigit(prices[prices.length - 1], places) : null;
	const recent = prices.slice(-30).map((price) => lastDigit(price, places));
	const choices = tradeType ? digitChoices(tradeType) : null;
	return /* @__PURE__ */ jsxs(Panel, {
		title: "Digits",
		children: [
			/* @__PURE__ */ jsx("div", {
				className: "flex flex-wrap gap-2",
				children: focus.map((item) => /* @__PURE__ */ jsx("button", {
					type: "button",
					onClick: () => setSymbol(item),
					className: `min-h-11 rounded-md border px-3 font-mono text-sm ${item === active ? "border-gold bg-gold text-gold-ink" : "border-line bg-raised text-fg"}`,
					children: item
				}, item))
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "mt-3 flex items-end justify-between gap-3",
				children: [/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("div", {
					className: "text-xs tracking-wide text-muted uppercase",
					children: "Last digit"
				}), /* @__PURE__ */ jsx("div", {
					className: "font-mono text-3xl tabular-nums text-gold",
					children: last == null ? "—" : last
				})] }), /* @__PURE__ */ jsxs("div", {
					className: "text-right font-mono text-xs text-muted",
					children: [sample, " ticks"]
				})]
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-3 flex flex-wrap gap-1",
				children: recent.length === 0 ? /* @__PURE__ */ jsx("span", {
					className: "text-sm text-muted",
					children: "Waiting for ticks."
				}) : recent.map((digit, index) => /* @__PURE__ */ jsx("span", {
					className: `grid size-7 place-items-center rounded-sm font-mono text-xs ${digit === digitPick ? "bg-gold text-gold-ink" : digit === last && index === recent.length - 1 ? "bg-raised text-gold" : "bg-bg text-fg"}`,
					children: digit
				}, `${index}-${digit}`))
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-4 text-xs tracking-wide text-muted uppercase",
				children: "Contract"
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3",
				children: DIGIT_CONTRACTS.map((type) => {
					const meta = CONTRACT_BY_TYPE.get(type);
					const on = tradeType === type;
					return /* @__PURE__ */ jsx("button", {
						type: "button",
						onClick: () => setTradeType(on ? null : type),
						className: `min-h-11 rounded-md border px-3 text-sm font-medium ${on ? "border-gold bg-gold text-gold-ink" : "border-line bg-raised text-fg"}`,
						children: meta?.name ?? type
					}, type);
				})
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-4 text-xs tracking-wide text-muted uppercase",
				children: "Digit"
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-2 grid grid-cols-5 gap-2",
				children: Array.from({ length: 10 }, (_, digit) => {
					const legal = choices == null || choices.includes(digit);
					const on = digitPick === digit;
					return /* @__PURE__ */ jsx("button", {
						type: "button",
						disabled: !legal,
						onClick: () => setDigitPick(on ? null : digit),
						className: `min-h-11 rounded-md border font-mono text-lg ${on ? "border-gold bg-gold text-gold-ink" : legal ? "border-line bg-raised text-fg" : "border-line bg-bg text-muted"}`,
						children: digit
					}, digit);
				})
			}),
			choices == null || (digitPick != null && choices.includes(digitPick)) ? null : /* @__PURE__ */ jsx("p", {
				className: "mt-2 text-sm text-muted",
				children: digitPick == null ? tradeType === "DIGITMATCH" || tradeType === "DIGITDIFF" ? "Pick a digit from 0 to 9." : "Select a barrier, or turn on auto barrier for this contract." : `Digit ${digitPick} is not offered on this contract.`
			}),
			jsx(DigitInsight, {}),
			jsx(DigitDiagnostics, {})
		]
	});
}
var QUICK_CONTRACTS = ["CALL", "PUT"];
function ContractPicker() {
	const tradeType = useDesk((s) => s.tradeType);
	const enabled = useDesk((s) => s.enabled);
	const selected = tradeType ? CONTRACT_BY_TYPE.get(tradeType) : void 0;
	const groups = useMemo(() => {
		const map = /* @__PURE__ */ new Map();
		for (const contract of CONTRACTS) {
			const list = map.get(contract.family) ?? [];
			list.push(contract);
			map.set(contract.family, list);
		}
		return [...map.entries()];
	}, []);
	return /* @__PURE__ */ jsxs(Panel, {
		title: "Contract the bot trades",
		children: [
			/* @__PURE__ */ jsx("div", {
				className: "flex flex-wrap gap-2",
				children: QUICK_CONTRACTS.map((type) => {
					const meta = CONTRACT_BY_TYPE.get(type);
					if (!meta) return null;
					const on = tradeType === type;
					return /* @__PURE__ */ jsx("button", {
						type: "button",
						onClick: () => setTradeType(on ? null : type),
						className: `min-h-11 rounded-md border px-3 text-sm font-medium ${on ? "border-gold bg-gold text-gold-ink" : "border-line bg-raised text-fg"}`,
						children: meta.name
					}, type);
				})
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-3",
				children: /* @__PURE__ */ jsx(Field, {
					label: "All contracts",
					children: /* @__PURE__ */ jsxs("select", {
						value: tradeType ?? "",
						onChange: (e) => setTradeType(e.target.value || null),
						className: "min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg outline-none focus:border-gold",
						children: [/* @__PURE__ */ jsx("option", {
							value: "",
							children: "Not selected"
						}), groups.map(([family, rows]) => /* @__PURE__ */ jsx("optgroup", {
							label: FAMILY_LABEL[family],
							children: rows.map((contract) => /* @__PURE__ */ jsx("option", {
								value: contract.type,
								children: contract.name
							}, contract.type))
						}, family))]
					})
				})
			}),
			selected ? /* @__PURE__ */ jsxs("div", {
				className: "mt-3",
				children: [
					/* @__PURE__ */ jsx("div", {
						className: "font-medium",
						children: selected.name
					}),
					/* @__PURE__ */ jsx("div", {
						className: "font-mono text-xs text-muted",
						children: selected.type
					}),
					/* @__PURE__ */ jsx("p", {
						className: "mt-2 text-sm text-pretty text-muted",
						children: selected.summary
					}),
					enabled[selected.type] === false ? /* @__PURE__ */ jsx("p", {
						className: "mt-2 text-sm text-down",
						children: "This contract is switched off, so the bot will not price it."
					}) : /* @__PURE__ */ jsx("p", {
						className: "mt-2 text-sm text-muted",
						children: "The desk requests prices for this contract only. Full auto will not buy anything else."
					})
				]
			}) : /* @__PURE__ */ jsx("p", {
				className: "mt-3 text-sm text-muted",
				children: "Full auto will not place an order until you pick one contract. Tap a chip again to clear it."
			})
		]
	});
}
function idleReason(mode, tradeType, trading, emergency, account, armDemo, armReal, armedAccountId, digitPick, autoBarrier) {
	if (!account) return "No account is connected, so there is no balance and nothing can be bought.";
	if (!Number.isFinite(account.balance)) return "Account is connected. Waiting for Deriv to send the balance.";
	if (trading !== "live") return "Account is connected. The trading socket is still opening.";
	if (!tradeType) return "Pick Even, Odd, Over, Under, Matches, or Differs on the digit board.";
	const choices = digitChoices(tradeType);
	if (choices && (digitPick == null || !choices.includes(digitPick))) {
		if (tradeType === "DIGITMATCH" || tradeType === "DIGITDIFF") return "Pick a digit from 0 to 9. Matches and Differs will not trade until you do.";
		return autoBarrier ? "Auto barrier selection is on. Training chooses one barrier. Validation and the final period only judge that barrier. A miss is not replaced. Qualification is not a verified edge." : "SELECT A BARRIER. Auto barrier selection is off.";
	}
	if (mode !== "auto") return "Switch to Full auto when you want the bot to buy.";
	if (emergency) return "Emergency stop is on. New orders are blocked.";
	if (account.account_type === "demo" && !armDemo) return "Press Start. The desk will not buy until you do.";
	if (account.account_type === "real" && (!armReal || armedAccountId !== account.account_id)) return "Real trading is stopped. Type START REAL before any real order.";
	return "The bot is watching the selected contract.";
}
function Auto() {
	const mode = useDesk((s) => s.mode);
	const armDemo = useDesk((s) => s.armDemo);
	const armReal = useDesk((s) => s.armReal);
	const armedAccountId = useDesk((s) => s.armedAccountId);
	const phrase = useDesk((s) => s.realPhrase);
	const emergency = useDesk((s) => s.emergency);
	const log = useDesk((s) => s.log);
	const trading = useDesk((s) => s.trading);
	const tradeType = useDesk((s) => s.tradeType);
	const digitPick = useDesk((s) => s.digitPick);
	const profiles = useDesk((s) => s.profiles);
	const autoBarrier = tradeType ? profiles[tradeType]?.autoBarrier === true : false;
	const accounts = useDesk((s) => s.accounts);
	const accountId = useDesk((s) => s.accountId);
	const batchSize = useDesk((s) => s.batchSize);
	const batchLock = useDesk((s) => s.batchLock);
	const account = accounts.find((row) => row.account_id === accountId) ?? null;
	const plans = useDesk((s) => s.plans);
	const selectedPlans = tradeType ? plans.filter((plan) => plan.type === tradeType) : [];
	const readyPlans = selectedPlans.filter((plan) => plan.status === "pricing");
	const signalLine = !tradeType ? "" : readyPlans.length > 0 ? `Signal on ${readyPlans.map((plan) => plan.symbol).slice(0, 3).join(", ")}.` : "No entry on this contract yet.";
	return /* @__PURE__ */ jsxs("div", {
		className: "grid gap-3",
		children: [
			/* @__PURE__ */ jsx(DigitBoard, {}),
			/* @__PURE__ */ jsx(ContractPicker, {}),
			/* @__PURE__ */ jsxs(Panel, {
				title: "Trading mode",
				children: [/* @__PURE__ */ jsx("div", {
					className: "grid gap-2 sm:grid-cols-2",
					children: [
						{
							id: "scanner",
							label: "Scanner",
							copy: "Analyze only"
						},
						{
							id: "signal",
							label: "Signals",
							copy: "Price, don't trade"
						},
						{
							id: "semi",
							label: "Semi-auto",
							copy: "You approve"
						},
						{
							id: "auto",
							label: "Full auto",
							copy: "Buys if every gate passes"
						}
					].map((item) => /* @__PURE__ */ jsxs("button", {
						type: "button",
						onClick: () => setMode(item.id),
						className: `min-h-16 rounded-md border px-3 py-2 text-left ${mode === item.id ? "border-gold bg-raised" : "border-line"}`,
						children: [/* @__PURE__ */ jsx("div", {
							className: "font-medium",
							children: item.label
						}), /* @__PURE__ */ jsx("div", {
							className: "text-sm text-muted",
							children: item.copy
						})]
					}, item.id))
				}), /* @__PURE__ */ jsxs("p", {
					className: "mt-3 text-sm text-muted",
					children: [idleReason(mode, tradeType, trading, emergency, account, armDemo, armReal, armedAccountId, digitPick, autoBarrier), " ", signalLine]
				}), /* @__PURE__ */ jsx(MartingaleControl, {}), /* @__PURE__ */ jsxs("div", {
					className: "mt-3",
					children: [/* @__PURE__ */ jsx("div", {
						className: "text-xs tracking-wide text-muted uppercase",
						children: "Entries at once"
					}), /* @__PURE__ */ jsx("div", {
						className: "mt-2 flex flex-wrap gap-2",
						children: [1, 2, 3, 4, 5].map((size) => /* @__PURE__ */ jsx(Btn, {
							kind: (batchSize || 1) === size ? "gold" : "ghost",
							onClick: () => setBatchSize(size),
							children: size === 1 ? "1 · one at a time" : `Batch ${size}`
						}, size))
					}), /* @__PURE__ */ jsx("p", {
						className: "mt-2 text-sm text-muted",
						children: (batchSize || 1) === 1 ? "The bot places one contract and waits for it to finish." : batchLock ? `Batch is on ${batchLock.label}. ${batchLock.ids.length} of ${batchLock.size} placed. Other signals wait until it settles.` : "A batch buys one signal only, then waits until those contracts settle."
					})]
				})]
			}),
			/* @__PURE__ */ jsxs(Panel, {
				title: "Start",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "flex flex-wrap gap-2",
						children: [/* @__PURE__ */ jsx(Btn, {
							kind: armDemo ? "gold" : "ghost",
							onClick: () => setArmDemo(!armDemo),
							children: armDemo ? "Started" : "Start"
						}), /* @__PURE__ */ jsx(Btn, {
							kind: "ghost",
							onClick: () => resetLimits(),
							children: "Reset limits"
						}), /* @__PURE__ */ jsx(Btn, {
							kind: "danger",
							onClick: () => void flatten(),
							children: "Sell tracked contracts"
						})]
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "mt-3 grid gap-2",
						children: [/* @__PURE__ */ jsx(Field, {
							label: "Type START REAL to allow real-money orders",
							children: /* @__PURE__ */ jsx(TextInput, {
								value: phrase,
								onChange: (e) => setRealPhrase(e.target.value),
								placeholder: "START REAL",
								autoCapitalize: "characters"
							})
						}), /* @__PURE__ */ jsx(Btn, {
							kind: armReal ? "danger" : "ghost",
							onClick: () => setArmReal(!armReal),
							children: armReal && account?.account_type === "real" && armedAccountId === account.account_id ? "Started — click to stop" : "Start real account"
						})]
					}),
					emergency ? /* @__PURE__ */ jsx("p", {
						className: "mt-3 text-sm text-down",
						children: "Emergency stop is on. New orders are blocked."
					}) : null
				]
			}),
			log.length === 0 ? null : /* @__PURE__ */ jsx(Panel, {
				title: "Engine log",
				children: /* @__PURE__ */ jsx("ul", {
					className: "grid gap-1",
					children: log.slice(0, 3).map((line, i) => /* @__PURE__ */ jsxs("li", {
						className: "font-mono text-xs",
						children: [/* @__PURE__ */ jsxs("span", {
							className: "text-muted",
							children: [clock(line.at), " "]
						}), /* @__PURE__ */ jsx("span", {
							className: line.tone === "bad" ? "text-down" : line.tone === "good" ? "text-up" : line.tone === "warn" ? "text-gold" : "text-fg",
							children: line.text
						})]
					}, `${line.at}-${i}`))
				})
			})
		]
	});
}
function Strategies() {
	const enabled = useDesk((s) => s.enabled);
	const tradeType = useDesk((s) => s.tradeType);
	const plans = useDesk((s) => s.plans);
	const journal = useDesk((s) => s.journal);
	const accountId = useDesk((s) => s.accountId);
	const groups = useMemo(() => {
		const map = /* @__PURE__ */ new Map();
		for (const contract of CONTRACTS) {
			const list = map.get(contract.family) ?? [];
			list.push(contract);
			map.set(contract.family, list);
		}
		return [...map.entries()];
	}, []);
	return /* @__PURE__ */ jsx("div", {
		className: "grid gap-3",
		children: groups.map(([family, rows]) => /* @__PURE__ */ jsx(Panel, {
			title: FAMILY_LABEL[family] ?? family,
			children: /* @__PURE__ */ jsx("ul", {
				className: "grid gap-3",
				children: rows.map((contract) => {
					const sample = plans.find((plan) => plan.type === contract.type);
					const closed = journal.filter((row) => row.contractType === contract.type && row.profit != null && accountId && row.accountId === accountId);
					const pnl = closed.reduce((sum, row) => sum + (row.profit ?? 0), 0);
					return /* @__PURE__ */ jsxs("li", {
						className: "border-b border-line pb-3 last:border-0 last:pb-0",
						children: [
							/* @__PURE__ */ jsxs("div", {
								className: "flex flex-wrap items-start justify-between gap-3",
								children: [/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("div", {
									className: "font-medium",
									children: contract.name
								}), /* @__PURE__ */ jsx("div", {
									className: "font-mono text-xs text-muted",
									children: contract.type
								})] }), /* @__PURE__ */ jsxs("div", {
									className: "flex flex-wrap justify-end gap-2",
									children: [
										tradeType === contract.type ? /* @__PURE__ */ jsx(Pill, {
											tone: "gold",
											children: "Bot"
										}) : null,
										/* @__PURE__ */ jsx(Btn, {
											kind: tradeType === contract.type ? "gold" : "ghost",
											onClick: () => setTradeType(contract.type),
											children: tradeType === contract.type ? "Bot trades this" : "Trade this"
										}),
										/* @__PURE__ */ jsx(Btn, {
											kind: enabled[contract.type] ? "gold" : "ghost",
											onClick: () => toggleStrategy(contract.type),
											children: enabled[contract.type] ? "On" : "Off"
										})
									]
								})]
							}),
							/* @__PURE__ */ jsx("p", {
								className: "mt-2 text-sm text-pretty text-muted",
								children: contract.summary
							}),
							/* @__PURE__ */ jsx("p", {
								className: "mt-1 text-sm text-fg",
								children: sample?.note ?? "Not in the current watch window."
							}),
							/* @__PURE__ */ jsxs("p", {
								className: "mt-1 font-mono text-xs text-muted",
								children: [
									"Model ",
									pct(sample?.pModel),
									" · Lower bound ",
									pct(sample?.pCons),
									". Live, this browser: closed ",
									closed.length,
									closed.length ? ` · P/L ${pnl.toFixed(2)}` : "",
									". Not a forecast."
								]
							})
						]
					}, contract.type);
				})
			})
		}, family))
	});
}
function Positions() {
	const accountId = useDesk((s) => s.accountId);
	const journal = useDesk((s) => s.journal);
	const open = journal.filter((row) => row.status === "open" && accountId && row.accountId === accountId);
	const other = accountId ? journal.filter((row) => row.status === "open" && row.accountId !== accountId).length : 0;
	return /* @__PURE__ */ jsxs(Panel, {
		title: "Open positions",
		action: /* @__PURE__ */ jsx(Btn, {
			onClick: () => void flatten(),
			children: "Sell this account"
		}),
		children: [
			other > 0 ? /* @__PURE__ */ jsx("p", {
				className: "mb-3 text-sm text-muted",
				children: `${other} open ${other === 1 ? "contract is" : "contracts are"} not owned by this account. They stay tracked and are not sold on this connection.`
			}) : null,
			open.length === 0 ? /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted",
				children: "No open contracts for this account. Positions only appear after Deriv accepts a buy."
			}) : /* @__PURE__ */ jsx(TradeTable, { rows: open })
		]
	});
}
function History$1() {
	return /* @__PURE__ */ jsx(JournalPanel, {});
}
function TradeTable({ rows }) {
	return /* @__PURE__ */ jsx("ul", {
		className: "grid gap-2",
		children: rows.map((row) => /* @__PURE__ */ jsxs("li", {
			className: "rounded-md border border-line px-3 py-2 text-sm",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "flex items-center justify-between gap-2",
					children: [
						/* @__PURE__ */ jsx("span", { children: row.contractType }),
						/* @__PURE__ */ jsx("span", {
							className: row.profit == null ? "font-mono text-muted" : row.profit >= 0 ? "font-mono text-up" : "font-mono text-down",
							children: row.profit == null ? "—" : signed(row.profit, row.currency)
						})
					]
				}),
				/* @__PURE__ */ jsx("div", {
					className: "mt-1 font-mono text-xs text-muted",
					children: `${row.symbol} · ${row.accountId ? `${row.accountType} ${row.accountId}` : "Unknown account"} · ${money(row.stake, row.currency)} · ${row.status}`
				})
			]
		}, row.id))
	});
}
function Analytics() {
	const accountId = useDesk((s) => s.accountId);
	const closed = useDesk((s) => s.journal).filter((row) => row.closedAt != null && row.profit != null && accountId && row.accountId === accountId).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
	let running = 0;
	const data = closed.map((row) => {
		running += row.profit ?? 0;
		return {
			t: clock(row.closedAt ?? 0),
			pnl: Number(running.toFixed(2))
		};
	});
	const byType = /* @__PURE__ */ new Map();
	for (const row of closed) {
		const cur = byType.get(row.contractType) ?? {
			n: 0,
			pnl: 0,
			wins: 0
		};
		cur.n += 1;
		cur.pnl += row.profit ?? 0;
		if ((row.profit ?? 0) > 0) cur.wins += 1;
		byType.set(row.contractType, cur);
	}
	return /* @__PURE__ */ jsxs("div", {
		className: "grid gap-3",
		children: [/* @__PURE__ */ jsx(Panel, {
			title: "Realized equity",
			children: data.length < 2 ? /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted",
				children: "The curve starts after two closed trades. It is not a projection."
			}) : /* @__PURE__ */ jsx("div", {
				className: "h-52 min-w-0 overflow-hidden",
				children: /* @__PURE__ */ jsx(ResponsiveContainer, {
					width: "100%",
					height: "100%",
					children: /* @__PURE__ */ jsxs(LineChart$1, {
						data,
						children: [
							/* @__PURE__ */ jsx(XAxis, {
								dataKey: "t",
								hide: true
							}),
							/* @__PURE__ */ jsx(YAxis, {
								stroke: "var(--color-muted)",
								width: 48
							}),
							/* @__PURE__ */ jsx(Tooltip, {}),
							/* @__PURE__ */ jsx(Line, {
								type: "stepAfter",
								dataKey: "pnl",
								stroke: "var(--color-gold)",
								dot: false,
								strokeWidth: 2
							})
						]
					})
				})
			})
		}), /* @__PURE__ */ jsx(Panel, {
			title: "By contract",
			children: byType.size === 0 ? /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted",
				children: "No settled trades to group."
			}) : /* @__PURE__ */ jsx("ul", {
				className: "grid gap-2",
				children: [...byType.entries()].map(([type, stat]) => /* @__PURE__ */ jsxs("li", {
					className: "flex items-center justify-between gap-3 font-mono text-sm",
					children: [/* @__PURE__ */ jsx("span", { children: type }), /* @__PURE__ */ jsxs("span", { children: [
						stat.wins,
						"/",
						stat.n,
						" · ",
						stat.pnl.toFixed(2)
					] })]
				}, type))
			})
		})]
	});
}
function Backtest() {
	const focus = useDesk((s) => s.focus);
	const [symbol, setSymbol] = useState(focus[0] ?? "R_100");
	const [type, setType] = useState("DIGITEVEN");
	const [report, setReport] = useState(null);
	const [error, setError] = useState(null);
	const [busy, setBusy] = useState(false);
	return /* @__PURE__ */ jsxs(Panel, {
		title: "Backtest",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "grid gap-3 sm:grid-cols-2",
				children: [/* @__PURE__ */ jsx(Field, {
					label: "Symbol",
					children: /* @__PURE__ */ jsx(TextInput, {
						value: symbol,
						onChange: (e) => setSymbol(e.target.value.toUpperCase())
					})
				}), /* @__PURE__ */ jsx(Field, {
					label: "Contract",
					children: /* @__PURE__ */ jsx("select", {
						value: type,
						onChange: (e) => setType(e.target.value),
						className: "min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm",
						children: CONTRACTS.map((contract) => /* @__PURE__ */ jsx("option", {
							value: contract.type,
							children: contract.name
						}, contract.type))
					})
				})]
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-3",
				children: /* @__PURE__ */ jsx(Btn, {
					kind: "gold",
					disabled: busy,
					onClick: () => {
						setBusy(true);
						setError(null);
						runBacktest(symbol, type).then(setReport).catch((err) => setError(err instanceof Error ? err.message : "Backtest failed.")).finally(() => setBusy(false));
					},
					children: busy ? "Running" : "Run on live history"
				})
			}),
			error ? /* @__PURE__ */ jsx("p", {
				className: "mt-3 text-sm text-down",
				children: error
			}) : null,
			report ? /* @__PURE__ */ jsxs("div", {
				className: "mt-4 grid gap-3 sm:grid-cols-2",
				children: [
					/* @__PURE__ */ jsx(Stat, {
						label: "Trials",
						value: String(report.trials)
					}),
					/* @__PURE__ */ jsx(Stat, {
						label: "Hit rate",
						value: pct(report.hitRate)
					}),
					/* @__PURE__ */ jsx(Stat, {
						label: "Reference rate",
						value: pct(report.referenceRate)
					}),
					/* @__PURE__ */ jsx(Stat, {
						label: "Simulated return at the current payout",
						value: report.perTradeEv == null ? "—" : report.perTradeEv.toFixed(3)
					}),
					/* @__PURE__ */ jsx("p", {
						className: "text-sm text-pretty text-muted sm:col-span-2",
						children: report.note
					}),
					report.lines?.length ? /* @__PURE__ */ jsx("ul", {
						className: "grid gap-1 sm:col-span-2",
						children: report.lines.map((line) => /* @__PURE__ */ jsx("li", {
							className: "text-sm text-pretty text-fg",
							children: line
						}, line))
					}) : null
				]
			}) : null
		]
	});
}
function Risk() {
	const risk = useDesk((s) => s.risk);
	const journal = useDesk((s) => s.journal);
	const accountId = useDesk((s) => s.accountId);
	const todayPnl = realizedToday(journal, Date.now(), accountId);
	const nearLoss = todayPnl <= -Math.abs(risk.dailyLossLimit) * 0.8;
	return /* @__PURE__ */ jsxs(Panel, {
		title: "Risk limits",
		children: [
			/* @__PURE__ */ jsxs("p", {
				className: "mb-3 text-sm text-muted",
				children: [
					"These checks run before every buy. The preset is a research starting point, not a proven edge. Today ",
					money(realizedToday(journal, Date.now(), accountId)),
					" realized on this account, streak ",
					lossStreak(journal, accountId),
					". Minimum edge and a loss-streak field are saved, but they do not block a buy."
				]
			}),
			nearLoss ? /* @__PURE__ */ jsx("p", {
				className: "mb-3 text-sm text-down",
				children: "Today's loss is close to the daily limit. New buys stop when the limit is reached."
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: "grid gap-3 sm:grid-cols-2",
				children: [
					/* @__PURE__ */ jsx(Field, {
						label: "Research preset",
						children: jsxs("select", {
							value: risk.researchMode ?? "balanced",
							onChange: (e) => {
								const researchMode = e.target.value;
								const profile = researchProfile(researchMode);
								updateRisk({ researchMode, minSample: profile.minSample, minEdge: profile.minEdge });
							},
							className: "min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm",
							children: [
								jsx("option", { value: "conservative", children: "Conservative" }),
								jsx("option", { value: "balanced", children: "Balanced" }),
								jsx("option", { value: "aggressive", children: "Aggressive" }),
							],
						}),
					}),
					jsx(Field, {
						label: "Stake mode",
						children: /* @__PURE__ */ jsxs("select", {
							value: risk.stakeMode,
							onChange: (e) => updateRisk({ stakeMode: e.target.value }),
							className: "min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm",
							children: [/* @__PURE__ */ jsx("option", {
								value: "fixed",
								children: "Fixed"
							}), /* @__PURE__ */ jsx("option", {
								value: "percent",
								children: "Percent of balance"
							})]
						})
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Fixed stake",
						value: risk.fixedStake,
						onChange: (fixedStake) => updateRisk({ fixedStake })
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Percent stake",
						value: risk.percentStake,
						onChange: (percentStake) => updateRisk({ percentStake })
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Maximum stake",
						value: risk.maxStake,
						onChange: (maxStake) => updateRisk({ maxStake })
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Max open trades",
						value: risk.maxOpenTrades,
						onChange: (maxOpenTrades) => updateRisk({ maxOpenTrades })
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Daily loss limit",
						value: risk.dailyLossLimit,
						onChange: (dailyLossLimit) => updateRisk({ dailyLossLimit })
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Daily profit target",
						value: risk.dailyProfitTarget,
						onChange: (dailyProfitTarget) => updateRisk({ dailyProfitTarget })
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Max drawdown %",
						value: risk.maxDrawdownPct,
						onChange: (maxDrawdownPct) => updateRisk({ maxDrawdownPct })
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Cooldown seconds",
						value: risk.cooldownSec,
						onChange: (cooldownSec) => updateRisk({ cooldownSec })
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Minimum edge",
						value: risk.minEdge,
						step: "0.01",
						onChange: (minEdge) => updateRisk({ minEdge })
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Digit sample size",
						value: risk.minSample,
						onChange: (minSample) => updateRisk({ minSample })
					}),
					/* @__PURE__ */ jsx(Num, {
						label: "Max multiplier exposure",
						value: risk.maxMultiplierExposure,
						onChange: (maxMultiplierExposure) => updateRisk({ maxMultiplierExposure })
					})
				]
			}),
			/* @__PURE__ */ jsx(MartingaleControl, {}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-3",
				children: /* @__PURE__ */ jsx(Btn, {
					onClick: () => updateRisk(DEFAULT_RISK),
					children: "Reset defaults"
				})
			})
		]
	});
}
function Num({ label, value, onChange, step = "1" }) {
	return /* @__PURE__ */ jsx(Field, {
		label,
		children: /* @__PURE__ */ jsx(TextInput, {
			type: "number",
			step,
			value: Number.isFinite(value) ? value : 0,
			onChange: (e) => onChange(Number(e.target.value))
		})
	});
}
function Settings$1() {
  const auth = useDesk((s) => s.auth);
  const credential = useDesk((s) => s.credential);
  const authError = useDesk((s) => s.authError);
  const accounts = useDesk((s) => s.accounts);
  const accountId = useDesk((s) => s.accountId);
  const signedIn = credential != null || auth === "ready" || accounts.length > 0;
  function signIn() {
    const id = useDesk.getState().clientId.trim() || DERIV_CLIENT_ID;
    void beginOAuth(id);
  }
  return jsxs(Panel, {
    title: "Account",
    children: [
      accounts.length === 0
        ? jsx("p", { className: "text-sm text-muted", children: auth === "checking" ? "Signing in…" : "Not signed in." })
        : jsx("ul", {
            className: "grid gap-2",
            children: accounts.map((account) => {
              const selected = account.account_id === accountId;
              return jsx("li", {
                children: jsxs("button", {
                  type: "button",
                  onClick: () => void switchAccount(account.account_id),
                  className: "flex min-h-11 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left " + (selected ? "border-gold" : "border-line"),
                  children: [
                    jsxs("span", { children: [
                      jsx("span", { className: "block font-mono text-sm", children: account.account_id }),
                      jsx("span", { className: "block text-xs " + (account.account_type === "real" ? "text-down" : "text-gold"), children: account.account_type === "real" ? "Real" : "Demo" }),
                    ]}),
                    jsx("span", { className: "font-mono text-sm text-gold", children: money(account.balance, account.currency) }),
                  ],
                }),
              }, account.account_id);
            }),
          }),
      jsx("div", {
        className: "mt-3",
        children: signedIn
          ? jsx(Btn, { onClick: disconnect, children: "Sign out" })
          : jsx(Btn, { kind: "gold", disabled: auth === "checking", onClick: signIn, children: "Sign in to Deriv" }),
      }),
      authError ? jsx("p", { className: "mt-3 text-sm text-down", children: authError }) : null,
    ],
  });
}

export { DeskViews };
