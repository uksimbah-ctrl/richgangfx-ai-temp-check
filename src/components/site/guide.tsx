import { useEffect } from "react";
import { beginOAuth, DERIV_CLIENT_ID, startDesk } from "@/lib/desk/session";
import { useDesk } from "@/lib/desk/store";
import { SiteNav } from "@/components/site/site-nav";

const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: "Getting started",
    body: [
      "Create a Deriv account with the Create a Deriv account button. It opens Deriv’s own registration page in a new tab. This site does not collect that form.",
      "Sign in with Deriv from Home. You are sent to Deriv’s authorization page and returned to this site’s existing callback. The desk then loads the accounts on that authorization.",
      "The password stays on Deriv. It is not typed here.",
      "On the desk, open Account to switch the active account. The header shows Demo or Real.",
      "Disconnect, also on Account, clears the session token from this browser.",
    ],
  },
  {
    title: "Dashboard",
    body: [
      "Balance is the figure Deriv sends for the selected account. It stays blank until that figure arrives.",
      "Feed live means market quotes are streaming. Orders live means the trading socket for that account is open.",
      "Open counts contracts this desk is still watching. Today is realized profit on those closed trades.",
      "Win rate counts only closed trades in the journal. It is empty until one closes.",
      "History lists the same journal: contract, stake, result, and time.",
    ],
  },
  {
    title: "Trading settings",
    body: [
      "Contract: on the digit board, choose Even, Odd, Over, Under, Matches, or Differs. Other contracts are in the Auto list. Full auto buys only the one you select.",
      "Digit: Over, Under, Matches, and Differs need a digit from the pad. Even and Odd do not. Over cannot use 9. Under cannot use 0.",
      "Market: pin symbols on the scanner. The digit table follows the symbol you tap.",
      "Stake: fixed amount or a percent of balance, never larger than the maximum stake. It does not increase after a loss.",
      "Duration is chosen from the durations Deriv lists for that contract. There is no duration field.",
      "Max open trades caps how many contracts can be open together. There is no separate “number of trades” counter.",
      "The digit model uses the fair probability. Rise and Fall use trend votes. You do not set indicator periods or a signal-strength slider — those controls are not on the desk.",
    ],
  },
  {
    title: "Risk",
    body: [
      "Daily loss limit and daily profit target stop new buys when today’s realized result crosses them.",
      "Cooldown is the wait after a loss, in seconds. A losing streak no longer locks the desk forever; after the cooldown, the next order is allowed.",
      "Drawdown compares the balance with the equity peak.",
      "Emergency stop blocks every new order until you clear it.",
      "There is no general stop-loss or take-profit field. Multiplier orders use a stop equal to the stake. Digits settle on their own.",
    ],
  },
  {
    title: "Controls",
    body: [
      "Full auto buys the selected contract when the account is armed and the other gates pass.",
      "Semi-auto prices the book and shows Approve trade when a quote is allowed.",
      "Signals prices contracts and does not buy. Scanner does not request prices.",
      "Stop in the header is the emergency stop. There is no separate Pause or Resume button.",
      "Sell tracked contracts asks Deriv to close contracts this desk is watching, when the broker allows a sale.",
      "Start allows demo orders. Start real asks you to type START REAL first.",
    ],
  },
  {
    title: "History",
    body: [
      "Each row is a contract this desk bought: symbol, type, stake, profit, and open time.",
      "Won and lost are set when Deriv reports the contract sold. A missing profit stays open until that update arrives.",
      "Entry is the ask at purchase. Exit is not a separate quote; the result is the profit Deriv reports.",
    ],
  },
  {
    title: "Troubleshooting",
    body: [
      "Connection error: sign in again from Home. If the authorization page shows an error, the log repeats Deriv’s message.",
      "Expired authorization: disconnect on Account and sign in again. The old code cannot be reused.",
      "Missing balance: the account can be connected while the balance field is still empty. Wait for the balance stream, or reconnect.",
      "Feed down: the public quote socket dropped. The desk retries. Leave the page open.",
      "Proposal error: the log shows Deriv’s reason, such as an invalid barrier or a stake below the minimum. The digit pad only offers digits that contract accepts.",
      "Buy failed: the order was refused after the quote. Read the log line. Real accounts stay blocked until START REAL is confirmed.",
      "Unsupported contract: if Deriv does not list it on that symbol, the plan says it is unavailable. Boom and Crash names are not a full digit book.",
    ],
  },
];

export function Guide() {
  useEffect(() => startDesk(), []);
  function connect() {
    const id = useDesk.getState().clientId.trim() || DERIV_CLIENT_ID;
    void beginOAuth(id);
  }
  return (
    <div className="min-h-dvh bg-navy text-fg">
      <SiteNav onConnect={connect} />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="font-mono text-xs tracking-widest text-gold uppercase">How to use</p>
        <h1 className="mt-2 text-3xl font-semibold">Every control on the desk</h1>
        <p className="mt-3 text-pretty text-muted">
          This page describes the buttons that exist. If a control is not listed, the desk does not have it.
        </p>
        <div className="mt-6 grid gap-3">
          {SECTIONS.map((section) => (
            <details key={section.title} className="rounded-md border border-line bg-surface/80 p-4" open>
              <summary className="cursor-pointer text-base font-medium">{section.title}</summary>
              <ul className="mt-3 grid gap-2">
                {section.body.map((line) => (
                  <li key={line} className="text-sm text-pretty text-muted">
                    {line}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </main>
    </div>
  );
}
