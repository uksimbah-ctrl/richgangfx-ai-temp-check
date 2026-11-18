import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  Gauge,
  History,
  Layers,
  Shield,
  Wallet,
} from "lucide-react";
import { money } from "@/lib/format";
import { beginOAuth, DERIV_CLIENT_ID, startDesk } from "@/lib/desk/session";
import { useDesk } from "@/lib/desk/store";
import { SiteNav } from "@/components/site/site-nav";

const FEATURES = [
  {
    icon: Activity,
    title: "Model-assisted analysis",
    copy: "Each contract family has its own probability model. Digits use the fair chance. Directional contracts use trend votes. The desk shows the expected value instead of inventing a win rate.",
  },
  {
    icon: Gauge,
    title: "Automated execution",
    copy: "Full auto buys the contract you select when the account is armed and the risk checks pass. Semi-auto waits for your approval.",
  },
  {
    icon: Layers,
    title: "Over, Under, Matches, Differs",
    copy: "The digit board is on the desk. You pick the contract and the digit. Even and Odd do not use a barrier.",
  },
  {
    icon: BarChart3,
    title: "Live markets",
    copy: "Quotes stream from Deriv for the synthetic indices you pin, including Volatility and 1-second indices such as 1HZ25V.",
  },
  {
    icon: Wallet,
    title: "Demo and real accounts",
    copy: "OAuth returns the accounts on the token. Demo and real stay separate, and real orders need you to type START REAL.",
  },
  {
    icon: History,
    title: "History and balance",
    copy: "Balance updates from Deriv. The journal keeps stake, result, contract, and time for trades this desk placed.",
  },
  {
    icon: Shield,
    title: "Risk controls",
    copy: "Fixed or percent stake, a stake cap, open-trade limit, daily loss, daily target, cooldown, drawdown, and an emergency stop. Stake does not rise after a loss.",
  },
];

export function Landing() {
  const navigate = useNavigate();
  const auth = useDesk((s) => s.auth);
  const authError = useDesk((s) => s.authError);
  const accounts = useDesk((s) => s.accounts);
  const accountId = useDesk((s) => s.accountId);
  const account = accounts.find((row) => row.account_id === accountId) ?? null;
  const arrived = useRef(false);

  useEffect(() => {
    arrived.current = new URLSearchParams(window.location.search).has("code");
    return startDesk();
  }, []);

  useEffect(() => {
    if (arrived.current && auth === "ready") void navigate({ to: "/desk" });
  }, [auth, navigate]);

  function connect(prompt?: "registration") {
    const id = useDesk.getState().clientId.trim() || DERIV_CLIENT_ID;
    void beginOAuth(id, prompt);
  }

  return (
    <div className="min-h-dvh bg-navy text-fg">
      <SiteNav onConnect={connect} />
      <main>
        <section className="rg-grid border-b border-line">
          <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-12 lg:grid-cols-2 lg:py-16">
            <div>
              <p className="font-mono text-xs tracking-widest text-gold uppercase">RICHGANGFX AI</p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
                Trade Smarter. Analyze Deeper. Execute With Intelligence.
              </h1>
              <p className="mt-4 max-w-xl text-pretty text-muted">
                RICHGANGFX AI is a Deriv desk for live quotes, contract signals, and orders you arm yourself. Demo and
                real stay separate. Nothing here promises a profit.
              </p>
              <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <button
                  type="button"
                  onClick={() => connect()}
                  className="inline-flex min-h-11 items-center justify-center rounded-md bg-blue px-4 text-sm font-semibold text-navy"
                >
                  Sign in with Deriv
                </button>
                <button
                  type="button"
                  onClick={() => connect("registration")}
                  className="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface px-4 text-sm font-semibold"
                >
                  Create a Deriv account
                </button>
                <a
                  href="#features"
                  className="inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm text-muted"
                >
                  Explore features
                </a>
              </div>
              {auth === "checking" ? <p className="mt-4 text-sm text-gold">Connecting to Deriv…</p> : null}
              {authError ? <p className="mt-4 text-sm text-down">{authError}</p> : null}
              {account ? (
                <p className="mt-4 text-sm text-fg">
                  {account.account_type === "real" ? "Real" : "Demo"} {account.account_id} ·{" "}
                  {money(account.balance, account.currency)}{" "}
                  <Link to="/desk" className="text-blue">
                    Open the desk
                  </Link>
                </p>
              ) : null}
            </div>
            <HeroChart />
          </div>
        </section>

        <section id="features" className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-2xl font-semibold">What the desk actually does</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            These cards match the trading desk. Anything that is not a separate control is called out below.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {FEATURES.map((item) => (
              <article key={item.title} className="rounded-md border border-line bg-surface/80 p-4 backdrop-blur-md">
                <item.icon className="size-5 text-blue" />
                <h3 className="mt-3 font-medium">{item.title}</h3>
                <p className="mt-2 text-sm text-pretty text-muted">{item.copy}</p>
              </article>
            ))}
          </div>
          <div className="mt-4 rounded-md border border-gold/40 bg-surface/70 p-4">
            <h3 className="font-medium text-gold">You start it</h3>
            <p className="mt-2 text-sm text-pretty text-muted">
              You press Start. The desk does not start itself. Full auto plus Start is what places orders.
              Stop is the emergency stop. Duration is taken from the market, not a field you type. Indicators are
              inside the model and are not tuned from the page. A general stop-loss and take-profit are not offered;
              multipliers use a stop equal to the stake. A “number of trades” limit is not offered — the open-trade
              cap is.
            </p>
          </div>
        </section>

        <section id="how" className="border-y border-line bg-bg">
          <div className="mx-auto grid max-w-6xl gap-3 px-4 py-14 md:grid-cols-3">
            {[
              ["1", "Create or connect", "Open a Deriv account, or sign in with the Deriv authorization page. This site never asks for your Deriv password."],
              ["2", "Set the desk", "Pick the contract and, for digits, the digit. Set stake and risk. Press Start before any order."],
              ["3", "Analyze and trade", "Signals prices the book. Full auto buys only the contract you selected, inside the risk gates."],
            ].map(([step, title, copy]) => (
              <article key={step} className="rounded-md border border-line bg-surface p-4">
                <div className="font-mono text-sm text-violet">{step}</div>
                <h3 className="mt-2 font-medium">{title}</h3>
                <p className="mt-2 text-sm text-pretty text-muted">{copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="about" className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-2xl font-semibold">About</h2>
          <p className="mt-3 max-w-2xl text-pretty text-muted">
            RICHGANGFX AI is a Deriv trading desk. It prices contracts with explicit probabilities, shows the
            expected value, and sends an order only after you arm the account. It is not a promise of profit.
          </p>
        </section>

        <section id="trust" className="border-t border-line bg-bg">
          <div className="mx-auto max-w-6xl px-4 py-14">
            <h2 className="text-2xl font-semibold">Trust and risk</h2>
            <ul className="mt-4 grid gap-2 text-sm text-muted sm:grid-cols-2">
              <li>Sign-in uses Deriv’s authorization page and the existing callback on this site.</li>
              <li>Your Deriv password is never requested or stored here.</li>
              <li>Demo and real accounts are labeled, and real orders need the phrase START REAL.</li>
              <li>Statistics on the desk come from trades this session recorded, not from a made-up win rate.</li>
              <li>Trading can lose money. Nothing here guarantees a profit.</li>
            </ul>
            <div className="mt-6">
              <Link to="/guide" className="inline-flex min-h-11 items-center text-sm text-blue">
                Read how to use the desk
              </Link>
            </div>
          </div>
        </section>

        <section id="faq" className="border-t border-line bg-bg">
          <div className="mx-auto max-w-6xl px-4 py-14">
            <h2 className="text-2xl font-semibold">FAQ</h2>
            <div className="mt-4 grid gap-3">
              {[
                ["Does this guarantee a win rate?", "No. Win rate on the desk is counted only from contracts this desk bought and that have settled."],
                ["Can it trade real money by itself?", "No. Real orders stay off until you type START REAL and start the real account yourself."],
                ["What is a batch?", "A batch repeats one signal only, then waits until those contracts settle. One-at-a-time places a single contract."],
                ["Where is my Deriv password?", "It is never asked for. Sign-in uses Deriv’s own page."],
              ].map(([q, a]) => (
                <article key={q} className="rounded-md border border-line bg-surface p-4">
                  <h3 className="font-medium">{q}</h3>
                  <p className="mt-2 text-sm text-muted">{a}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
        <section id="support" className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-2xl font-semibold">Support</h2>
          <p className="mt-3 max-w-2xl text-sm text-pretty text-muted">
            If sign-in fails, start it again from this page. If the balance stays blank, open Account on the desk
            and reconnect. If a quote is rejected, the log names the Deriv error. The how-to page lists the usual
            failures. This desk does not offer a separate support inbox.
          </p>
        </section>
      </main>
      <footer className="border-t border-line px-4 py-6 text-center text-xs text-muted">
        RICHGANGFX AI · Deriv trading desk · Losses are possible
      </footer>
    </div>
  );
}

function HeroChart() {
  const ticks = useDesk((s) => s.ticks);
  const points = ticks["1HZ25V"] ?? ticks["R_100"] ?? ticks["1HZ100V"] ?? [];
  const path = useMemo(() => {
    const sample = points.slice(-48).map((point) => point.q);
    const values = sample.length > 2 ? sample : [];
    if (values.length < 2) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return values
      .map((value, index) => {
        const x = (index / (values.length - 1)) * 320;
        const y = 120 - ((value - min) / span) * 96 - 12;
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  }, [points]);
  const live = points.length > 2;

  return (
    <div className="rounded-md border border-line bg-surface/75 p-4 backdrop-blur-md">
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="font-mono">{live ? "1HZ25V or Volatility" : "Waiting for the feed"}</span>
        <span className={live ? "text-up" : "text-gold"}>{live ? "Live" : "Connecting"}</span>
      </div>
      <svg viewBox="0 0 320 140" className="mt-3 h-44 w-full text-blue" role="img" aria-label="Market chart">
        {live ? <path d={path} fill="none" stroke="currentColor" strokeWidth="2" className="rg-line" /> : null}
      </svg>
      <p className="text-xs text-muted">The line is the live quote when the feed is up. It is not a forecast.</p>
    </div>
  );
}
