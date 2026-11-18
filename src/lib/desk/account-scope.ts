export type ScopedTrade = {
  accountId?: string | null;
  closedAt?: number;
  profit?: number | null;
  status: string;
  stake?: number;
};

export function hasAccountId(accountId?: string | null): accountId is string {
  return typeof accountId === "string" && accountId.trim().length > 0;
}

export function forAccount<T extends { accountId?: string | null }>(rows: T[], accountId?: string | null): T[] {
  if (!hasAccountId(accountId)) return [];
  return rows.filter((row) => row.accountId === accountId);
}

export function scopedPnl(rows: ScopedTrade[], since: number, accountId?: string | null): number {
  return forAccount(rows, accountId).reduce((sum, row) => {
    if (row.closedAt == null || row.closedAt < since || row.profit == null) return sum;
    return sum + row.profit;
  }, 0);
}

export function scopedLossStreak(rows: ScopedTrade[], since: number, accountId?: string | null): number {
  const closed = forAccount(rows, accountId)
    .filter((row) => row.closedAt != null && row.profit != null && row.closedAt >= since)
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  let n = 0;
  for (const row of closed) {
    if ((row.profit ?? 0) < 0) n += 1;
    else break;
  }
  return n;
}

export function scopedWinRate(rows: ScopedTrade[], accountId?: string | null): number | null {
  const decisive = forAccount(rows, accountId).filter((row) => {
    if (row.status === "open" || row.closedAt == null || row.profit == null || row.profit === 0) return false;
    return row.profit > 0 || row.profit < 0;
  });
  if (decisive.length === 0) return null;
  return decisive.filter((row) => (row.profit ?? 0) > 0).length / decisive.length;
}

export function settlementStatus(sold: boolean, profit: number | null): "open" | "won" | "lost" | "sold" {
  if (!sold || profit == null) return "open";
  if (profit > 0) return "won";
  if (profit < 0) return "lost";
  return "sold";
}

export function armRealDecision(input: {
  phrase: string;
  account: { account_id: string; account_type: "demo" | "real" } | null;
}): { ok: boolean; armedAccountId: string | null; reason: string } {
  if (input.phrase.trim() !== "START REAL") {
    return { ok: false, armedAccountId: null, reason: "Type START REAL before starting a real-money account." };
  }
  if (!input.account || input.account.account_type !== "real") {
    return {
      ok: false,
      armedAccountId: null,
      reason: "Select the real account before arming it. Demo arming does not authorize real orders.",
    };
  }
  return { ok: true, armedAccountId: input.account.account_id, reason: "" };
}

export function armAfterAccountChange(): { armReal: false; armedAccountId: null } {
  return { armReal: false, armedAccountId: null };
}

/** Saved settings never restore real-money arming, even if an older save said otherwise. */
export function armFromStorage(_saved?: { armReal?: boolean; armedAccountId?: string | null } | null): { armReal: false; armedAccountId: null } {
  return { armReal: false, armedAccountId: null };
}

export type PortfolioCheck = "found" | "absent" | "unknown" | "rejected";

/**
 * A timed-out buy may be sent again only after Deriv rejects it.
 * An empty or incomplete portfolio is not a rejection.
 */
export function buyRetryAllowed(check: PortfolioCheck, holdUntil: number, now: number): boolean {
  if (now < holdUntil) return false;
  return check === "rejected";
}

export function canManageContract(contractAccountId: string | null | undefined, selectedAccountId: string | null | undefined): boolean {
  return Boolean(contractAccountId) && contractAccountId === selectedAccountId;
}

export function batchAccepts(
  lock: { key: string; size: number; ids: string[] } | null,
  signalKey: string,
  pending: number,
): boolean {
  if (!lock) return true;
  if (lock.key !== signalKey) return false;
  return lock.ids.length + pending < lock.size;
}

/** Demo orders skip this check. A real buy must match the exact armed account id. */
export function realBuyAllowed(input: {
  accountType: "demo" | "real" | null;
  accountId: string | null;
  armReal: boolean;
  armedAccountId: string | null;
}): { ok: boolean; reason: string } {
  if (input.accountType !== "real") return { ok: true, reason: "" };
  if (!hasAccountId(input.accountId)) return { ok: false, reason: "No real account is selected." };
  if (!input.armReal || input.armedAccountId !== input.accountId) {
    return { ok: false, reason: "Real trading is not started for this account. Type START REAL again." };
  }
  return { ok: true, reason: "" };
}

export function scopedOpenCount(rows: Array<{ accountId?: string | null; status: string }>, accountId?: string | null): number {
  return forAccount(rows, accountId).filter((row) => row.status === "open").length;
}

export function scopedExposure(rows: Array<{ accountId?: string | null; status: string; stake?: number }>, accountId?: string | null): number {
  return forAccount(rows, accountId)
    .filter((row) => row.status === "open")
    .reduce((sum, row) => sum + (row.stake || 0), 0);
}

export function scopedWins(rows: ScopedTrade[], accountId?: string | null): { wins: number; losses: number; closed: number } {
  const closed = forAccount(rows, accountId).filter((row) => row.closedAt != null && row.profit != null);
  return {
    closed: closed.length,
    wins: closed.filter((row) => (row.profit ?? 0) > 0).length,
    losses: closed.filter((row) => (row.profit ?? 0) < 0).length,
  };
}

export function unassignedCount(rows: Array<{ accountId?: string | null }>): number {
  return rows.filter((row) => !hasAccountId(row.accountId)).length;
}

/** Keep older rows. Never copy the current account onto a row that has no id. */
export function keepJournalOwnership<T extends { accountId?: string | null }>(rows: T[]): T[] {
  return rows.map((row) => ({
    ...row,
    accountId: typeof row.accountId === "string" ? row.accountId : "",
  }));
}

export function maskAccountId(id: string): string {
  const clean = id.trim();
  if (clean.length <= 4) return clean;
  return `${clean.slice(0, 2)}•••${clean.slice(-4)}`;
}

export function bumpPeak(peaks: Record<string, number>, accountId: string, balance: number): Record<string, number> {
  if (!hasAccountId(accountId) || !Number.isFinite(balance)) return peaks;
  const prev = peaks[accountId];
  const next = prev == null ? balance : Math.max(prev, balance);
  if (next === prev) return peaks;
  return { ...peaks, [accountId]: next };
}

export function drawdownPct(peak: number | null | undefined, balance: number | null | undefined): number | null {
  if (peak == null || balance == null || !(peak > 0) || !Number.isFinite(balance)) return null;
  return ((peak - balance) / peak) * 100;
}

/** Observation from one account is applied only while that account is selected. */
export function applyAccountObservation<T extends { status: string; observeReason: string | null }>(
  modules: Record<string, T>,
  notes: Record<string, string> | undefined,
): Record<string, T> {
  if (!notes) return modules;
  const copy = { ...modules };
  let changed = false;
  for (const [id, reason] of Object.entries(notes)) {
    const row = copy[id];
    if (!row || !reason || row.status !== "active") continue;
    copy[id] = { ...row, status: "observation" as T["status"], observeReason: reason };
    changed = true;
  }
  return changed ? copy : modules;
}
