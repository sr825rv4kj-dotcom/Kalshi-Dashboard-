/**
 * streakCounter.js  (2026-10-18)
 *
 * RESULTS DECIDE HOW MANY BETS MAY BE OPEN.
 *
 * mode "ladder" (2026-10-28, account holder's call: "deploy more with each
 * win and deploy one less bot with each loss"): the allowance walks through
 * every closed bet in order, starting at 1 -
 *   win  -> one more open bet allowed (never more than streak.max, default 6)
 *   loss -> one fewer (never fewer than 1)
 *
 * mode "reset" (2026-10-18, the original rule: "One loss draws deployments
 * back to 1"): open bets allowed = 1 + wins in a row since the last loss.
 *
 * Counted from the trade ledger (tradeLedgerStore.getTradeLifecycles), one
 * result per Kalshi bet, in the order they closed:
 *   - a bet that closed with net profit after fees is a WIN (held to the end
 *     or sold early - the money is what counts)
 *   - anything else is a LOSS
 *   - only bets closed at or after streak.since count (the moment the counter
 *     was first switched on, 2026-10-24)
 *   - Polymarket copies of a Kalshi bet are the same game, so they are not
 *     counted again; arbitrage pairs are not bets on a winner and never count
 * The same allowance caps Polymarket (botController passes it on).
 */

import { getTradeLifecycles } from "./tradeLedgerStore.js";

export const STREAK_VERSION = "2026-10-28-ladder";

const CACHE_MS = 15 * 1000;
let cache = { at: 0, key: "", value: null };

export function streakSettings(config = {}) {
  const s = config.streak && typeof config.streak === "object" ? config.streak : {};
  const fixed = Number(config.maxConcurrentPositions);
  const max = Number.isFinite(Number(s.max)) && Number(s.max) > 0 ? Number(s.max) : (Number.isFinite(fixed) && fixed > 0 ? fixed : 6);
  return { enabled: s.enabled === true, since: s.since || null, max, mode: s.mode === "reset" ? "reset" : "ladder" };
}

const isArb = (t) => /^ARBITRAGE/i.test(String(t.entryReason || ""));
const isPolymarket = (t) => String(t.ticker || "").startsWith("PM:");

/** Pure: the streak from closed bets (any order), counted after `since`. */
export function streakFrom(completed, { since = null, max = 6, mode = "ladder" } = {}) {
  const sinceMs = since ? Date.parse(since) : null;
  const bets = (Array.isArray(completed) ? completed : [])
    .filter((t) => !isArb(t) && !isPolymarket(t))
    .filter((t) => Number.isFinite(Number(t.netDollars)) && t.exitTimestamp)
    .filter((t) => !Number.isFinite(sinceMs) || Date.parse(t.exitTimestamp) >= sinceMs)
    .sort((a, b) => Date.parse(a.exitTimestamp) - Date.parse(b.exitTimestamp));
  let best = 0;
  let run = 0;
  let level = 1;
  let lastLoss = null;
  for (const t of bets) {
    if (Number(t.netDollars) > 0) {
      run += 1; best = Math.max(best, run);
      level = Math.min(max, level + 1);
    } else {
      run = 0; lastLoss = t;
      level = Math.max(1, level - 1);
    }
  }
  const wins = run;
  const cap = mode === "reset" ? Math.max(1, Math.min(max, 1 + wins)) : level;
  return {
    mode, wins, best, cap, max, counted: bets.length,
    lastLoss: lastLoss ? { team: lastLoss.teamName ?? lastLoss.ticker, at: lastLoss.exitTimestamp, net: Math.round(Number(lastLoss.netDollars) * 100) / 100 } : null,
    recent: bets.slice(-8).reverse().map((t) => `${Number(t.netDollars) > 0 ? "W" : "L"} ${t.teamName ?? t.ticker} ${Number(t.netDollars) >= 0 ? "+" : ""}${Number(t.netDollars).toFixed(2)}`),
  };
}

/** The streak right now, or null when the rule is off. */
export function streakNow(config = {}) {
  const s = streakSettings(config);
  if (!s.enabled) return null;
  const key = `${s.since}|${s.max}|${s.mode}`;
  if (cache.value && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;
  let completed = [];
  try { completed = getTradeLifecycles().completed || []; } catch { completed = []; }
  const value = { version: STREAK_VERSION, since: s.since, ...streakFrom(completed, s) };
  cache = { at: Date.now(), key, value };
  return value;
}

/** Open bets allowed by the streak, or null when the rule is off. */
export function streakCap(config = {}) {
  const v = streakNow(config);
  return v ? v.cap : null;
}
