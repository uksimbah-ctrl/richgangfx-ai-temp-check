export type BulkRisk = {
  maxOpen: number;
  maxStake: number;
  maxExposure: number;
  dailyLoss: number;
  dailyProfit: number;
  maxConsecutiveLosses: number;
  cooldownSec: number;
  minPayoutMultiple: number;
  minEv: number;
  stake: number;
  duration: number;
  minSample: number;
};

export const DEFAULT_BULK_RISK: BulkRisk = {
  maxOpen: 3,
  maxStake: 5,
  maxExposure: 15,
  dailyLoss: 20,
  dailyProfit: 40,
  maxConsecutiveLosses: 4,
  cooldownSec: 30,
  minPayoutMultiple: 0,
  minEv: 0,
  stake: 1,
  duration: 1,
  minSample: 80,
};

export function bulkRiskBlock(input: {
  risk: BulkRisk;
  stake: number;
  open: number;
  exposure: number;
  dailyPnl: number;
  consecutiveLosses: number;
  secondsSinceLoss: number | null;
  running: boolean;
  stopped: boolean;
  connected: boolean;
}): string | null {
  if (input.stopped) return "Stop All is on. New entries are blocked. Open contracts keep being watched.";
  if (!input.running) return "Auto trading is not started.";
  if (!input.connected) return "The account connection is down. No new purchase is sent.";
  if (!(input.stake > 0)) return "Stake must be above zero.";
  if (input.stake > input.risk.maxStake) return "Stake is above the bulk maximum.";
  if (input.open >= input.risk.maxOpen) return "Maximum open trades reached.";
  if (input.exposure + input.stake > input.risk.maxExposure) return "Total exposure would pass the cap.";
  if (input.dailyPnl <= -Math.abs(input.risk.dailyLoss)) return "Daily loss limit reached. New entries are stopped.";
  if (input.dailyPnl >= Math.abs(input.risk.dailyProfit)) return "Daily profit target reached. New entries are stopped.";
  if (input.consecutiveLosses >= input.risk.maxConsecutiveLosses) return "Consecutive-loss limit reached.";
  if (input.secondsSinceLoss != null && input.secondsSinceLoss < input.risk.cooldownSec) return "Cooldown is still running.";
  return null;
}
