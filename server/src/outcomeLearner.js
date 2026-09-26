/**
 * outcomeLearner.js
 *
 * THE BOT LEARNS FROM ITS OWN RESULTS (2026-09-25)
 *
 * Three rules, all read from the bot's own trade ledger (every closed trade,
 * net of fees), recomputed at most once a minute:
 *
 * 1. CUT WHAT LOSES. Every closed trade is scored against what its entry
 *    price said it should win: a 40c contract is expected to win 40% of the
 *    time. Each sport and each price band keeps a running tally of wins versus
 *    that expectation. Once a segment has 8+ trades, is net negative, AND has
 *    won clearly less often than its prices implied (more than one standard
 *    deviation short), it is not traded. It is re-evaluated every minute, so
 *    a segment comes back on its own if later results recover it.
 *
 *    Replayed on the account's first 79 trades this never fired - no sport or
 *    band underperformed its prices by more than chance. It exists so that
 *    when one does, it is cut automatically instead of by hand.
 *
 * 2. LOSING-STREAK BRAKE. After N losses in a row (default 4) the stake is
 *    halved until the next win. This protects the balance; it does not
 *    predict the next game. On this account a trade that followed a loss won
 *    47% of the time and one that followed a win 36% - streaks are noise, but
 *    a run of losses at full stake is how a small balance gets emptied.
 *
 * 3. SLOTS ARE EARNED. In survival mode the bot holds at most 3 positions at
 *    once. It earns 5 when its last 20 closed trades are net profitable, and
 *    the full survival cap when its last 40 are. More open bets only once
 *    more open bets have shown they make money.
 */

import { getTradeLifecycles } from "./tradeLedgerStore.js";

export const LEARNER_VERSION = "2026-09-25-outcome-learner";

const CACHE_MS = 60_000;
let cache = { at: 0, closed: [] };

function closedChronological() {
  if (Date.now() - cache.at < CACHE_MS) return cache.closed;
  let completed = [];
  try { completed = getTradeLifecycles().completed || []; } catch { completed = []; }
  const closed = completed
    .filter((t) => Number.isFinite(Number(t.netDollars)) && Number.isFinite(Number(t.entryPriceCents)))
    .sort((a, b) => Date.parse(a.exitTimestamp) - Date.parse(b.exitTimestamp));
  cache = { at: Date.now(), closed };
  return closed;
}

export function bandOf(cents) {
  const c = Number(cents);
  if (c < 25) return "<25c";
  if (c < 35) return "25-35c";
  if (c < 50) return "35-50c";
  if (c < 70) return "50-70c";
  return "70c+";
}

/** Pure: segment tallies from a chronological list of closed trades. */
export function segmentStats(closed) {
  const stats = {};
  for (const t of closed) {
    const p = Number(t.entryPriceCents) / 100;
    const win = Number(t.netDollars) > 0;
    for (const key of [`sport:${t.sportKey ?? "unknown"}`, `band:${bandOf(t.entryPriceCents)}`]) {
      const s = (stats[key] ??= { n: 0, wins: 0, expectedWins: 0, variance: 0, net: 0 });
      s.n += 1;
      s.wins += win ? 1 : 0;
      s.expectedWins += p;
      s.variance += p * (1 - p);
      s.net += Number(t.netDollars);
    }
  }
  return stats;
}

/** Pure: is this segment tally bad enough to stop trading it? */
export function segmentBlocked(s, { minTrades = 8, z = 1.0 } = {}) {
  if (!s || s.n < minTrades || s.net >= 0) return false;
  const sd = Math.sqrt(s.variance) || 1;
  return s.wins - s.expectedWins < -z * sd;
}

/** Returns { blocked, reason } for a candidate. Never throws. */
export function learnedBlock({ sportKey, priceCents }, config = {}) {
  try {
    const stats = segmentStats(closedChronological());
    const opts = { minTrades: config.learnerMinTrades ?? 8, z: config.learnerZ ?? 1.0 };
    for (const key of [`sport:${sportKey}`, `band:${bandOf(priceCents)}`]) {
      const s = stats[key];
      if (segmentBlocked(s, opts)) {
        return {
          blocked: true,
          reason: `${key} has won ${s.wins} of ${s.n} against ${s.expectedWins.toFixed(1)} its prices implied, ` +
            `net ${s.net < 0 ? "-" : ""}$${Math.abs(s.net).toFixed(2)} - learned to skip it`,
        };
      }
    }
  } catch { /* learning must never stop a scan */ }
  return { blocked: false, reason: null };
}

/** Pure: consecutive losses at the end of a chronological list. */
export function trailingLosses(closed) {
  let n = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (Number(closed[i].netDollars) > 0) break;
    n++;
  }
  return n;
}

/** Stake multiplier from the losing-streak brake: 0.5 after N straight losses, else 1. */
export function streakStakeFactor(config = {}) {
  const limit = Number(config.streakBrakeLosses ?? 4);
  if (!(limit > 0)) return { factor: 1, losses: 0 };
  const losses = trailingLosses(closedChronological());
  return { factor: losses >= limit ? 0.5 : 1, losses };
}

/** Pure: positions allowed at once in survival mode, earned by recent results. */
export function earnedCapFrom(closed, baseCap, config = {}) {
  const min = Number(config.survivalStartingSlots ?? 3);
  const net = (k) => closed.slice(-k).reduce((t, x) => t + Number(x.netDollars), 0);
  if (closed.length >= 40 && net(40) > 0) return baseCap;
  if (closed.length >= 20 && net(20) > 0) return Math.min(baseCap, Math.max(min, 5));
  return Math.min(baseCap, min);
}

export function earnedPositionCap(baseCap, config = {}) {
  try { return earnedCapFrom(closedChronological(), baseCap, config); } catch { return Math.min(baseCap, 3); }
}

/** For the monitor. */
export function learnerReport(config = {}) {
  const closed = closedChronological();
  const stats = segmentStats(closed);
  const opts = { minTrades: config.learnerMinTrades ?? 8, z: config.learnerZ ?? 1.0 };
  return {
    version: LEARNER_VERSION,
    trailingLosses: trailingLosses(closed),
    stakeFactor: streakStakeFactor(config).factor,
    segments: Object.entries(stats).map(([k, s]) => ({
      segment: k, trades: s.n, wins: s.wins, expectedWins: Number(s.expectedWins.toFixed(1)),
      net: Number(s.net.toFixed(2)), blocked: segmentBlocked(s, opts),
    })).sort((a, b) => b.trades - a.trades),
  };
}
