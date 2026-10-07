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
 * 1b. SPORT + PRICE, NOT THE WHOLE SPORT (2026-10-06, account holder's call:
 *    "not just oh we lost at NHL no more games - the system learns from past
 *    mistakes"). A sport was blocked outright when it lost: NHL went 1 of 8 -
 *    every one a 35-47c buy - and the learner then refused NHL favorites at
 *    73-80c and middle prices too, nine live NHL markets in one night, though
 *    none of those prices had ever lost. Segments are now a sport AT a price
 *    range ("sport:icehockey_nhl|band:35-50c") plus each price range across
 *    every sport. A sport that loses at one price keeps trading at the others.
 *
 * 1c. PROBATION, NOT FOREVER. A blocked segment produces no new trades, so it
 *    could never "come back on its own" - the block was permanent in practice.
 *    When the bot is behind its daily pace (tradeCounter.js), a blocked segment
 *    may take ONE probation trade a day at half stake (Kalshi scanner only).
 *    Its result feeds back into the tally: wins lift the block, losses keep it.
 *    A segment with strong evidence against it (15+ trades, 2+ sd short of its
 *    prices) gets no probation.
 *
 * 3. SLOTS ARE EARNED. In survival mode the bot holds at most 3 positions at
 *    once. It earns 5 when its last 20 closed trades are net profitable, and
 *    the full survival cap when its last 40 are. More open bets only once
 *    more open bets have shown they make money.
 */

import { getTradeLifecycles, loadLedger } from "./tradeLedgerStore.js";
import { behindPace, probationUsedToday } from "./tradeCounter.js";

export const LEARNER_VERSION = "2026-10-06-sport-price-probation";

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

/** The segments one trade belongs to: its sport at its price range, and its price range. */
export function segmentKeys(sportKey, priceCents) {
  const band = bandOf(priceCents);
  return [`sport:${sportKey ?? "unknown"}|band:${band}`, `band:${band}`];
}

/** Pure: segment tallies from a chronological list of closed trades. */
export function segmentStats(closed) {
  const stats = {};
  for (const t of closed) {
    const p = Number(t.entryPriceCents) / 100;
    const win = Number(t.netDollars) > 0;
    for (const key of segmentKeys(t.sportKey, t.entryPriceCents)) {
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

/** Pure: so much evidence against a segment that it gets no probation. */
export function segmentCondemned(s) {
  if (!s || s.n < 15 || s.net >= 0) return false;
  const sd = Math.sqrt(s.variance) || 1;
  return s.wins - s.expectedWins <= -2 * sd;
}

/** Entries in this segment (any venue) in the last 24 hours, from the ledger. */
function segmentEntriesLastDay(segment) {
  let ledger = [];
  try { ledger = loadLedger(); } catch { return 0; }
  const since = Date.now() - 24 * 60 * 60 * 1000;
  let n = 0;
  for (const t of ledger) {
    if (t.action !== "enter" || !(Number(t.filled) > 0) || Date.parse(t.timestamp) < since) continue;
    if (segmentKeys(t.sportKey, t.priceCents).includes(segment)) n += 1;
  }
  return n;
}

/**
 * { blocked, reason, probation, stakeFactor, segment } for a candidate.
 * allowProbation: only the Kalshi scanner passes true - it is the caller that
 * applies the half stake. Never throws.
 */
export function learnedBlock({ sportKey, priceCents, allowProbation = false }, config = {}) {
  try {
    const stats = segmentStats(closedChronological());
    const opts = { minTrades: config.learnerMinTrades ?? 8, z: config.learnerZ ?? 1.0 };
    for (const key of segmentKeys(sportKey, priceCents)) {
      const s = stats[key];
      if (!segmentBlocked(s, opts)) continue;
      const record = `${key} has won ${s.wins} of ${s.n} against ${s.expectedWins.toFixed(1)} its prices implied, ` +
        `net ${s.net < 0 ? "-" : ""}$${Math.abs(s.net).toFixed(2)}`;
      const probationOn = allowProbation && config.learnerProbation !== false && !segmentCondemned(s);
      if (probationOn && behindPace(config) && probationUsedToday(key) === 0 && segmentEntriesLastDay(key) === 0) {
        return {
          blocked: false, probation: true, stakeFactor: 0.5, segment: key,
          reason: `${record} - PROBATION: behind today's pace, one half-stake trade to re-test it`,
        };
      }
      return {
        blocked: true, probation: false, stakeFactor: 0, segment: key,
        reason: `${record} - learned to skip it` +
          (segmentCondemned(s) ? " (strong evidence - no probation)" : probationOn ? " (probation used today or on pace)" : ""),
      };
    }
  } catch { /* learning must never stop a scan */ }
  return { blocked: false, probation: false, stakeFactor: 1, segment: null, reason: null };
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
      net: Number(s.net.toFixed(2)), blocked: segmentBlocked(s, opts), noProbation: segmentCondemned(s),
    })).sort((a, b) => b.trades - a.trades),
  };
}

