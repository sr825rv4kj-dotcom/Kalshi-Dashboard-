/**
 * swingEngine.js
 *
 * IN-GAME SWING TRADING (2026-09-29, account holder's plan):
 *
 *   - BUY THE DIP: a team's price drops below what the score and clock say it
 *     is worth. (The entry scanners do this - scanner.js for Kalshi,
 *     polymarket/pmEngine.js for Polymarket: the price must sit under fair
 *     value by the fee plus a margin and return 10%+ after fees.)
 *   - SELL THE RALLY once the price climbs back, in two pieces:
 *       half   when the bid, after the sell fee, reaches fair value again
 *              (and the sale is a profit)
 *       rest   at +65% on what was paid, fees included
 *   - A BLOWOUT is cut: when the score and clock put the team under 10% to
 *     win AND the market agrees (mid 20c or less), everything left is sold
 *     and the bot looks for other trades. A close game is ridden out: down a
 *     few points in the second half is 15-35%, not a blowout.
 *   - REPEAT: once a game is fully sold, it can be bought again on the next
 *     dip after a short cool-off (3 minutes) - as many round trips as the
 *     game gives. A trade counts by its profit, not by who wins the game.
 *
 * FAIR VALUE = what the score and clock say, seconded by the sharp line:
 *   model   liveModel.js - pre-game closing line as team strength, the live
 *           score, and the time left (from the clock since the start)
 *   sharp   the latest sharp line the scanners read (fairValue.js cache)
 *   fair    the LOWER of the two when both exist (the same conservative
 *           number the entry used), the model alone when there is no line,
 *           or a sharp line under 2 minutes old when there is no live score.
 *
 * Every decision is pure (swingDecision) and every input is a real price or
 * score read this cycle. The desk (deskReport) shows each open position with
 * its live price, fair value and the exact price at which the next sale
 * happens, plus today's profit against the daily goal.
 */

import { getFair } from "./fairValue.js";
import { getLiveScores, findLiveGameForTeam } from "./scoresFetcher.js";
import { liveWinProbability, fractionRemaining, pregamePrior, paramsFor } from "./liveModel.js";
import { feePerContractCents } from "./riskManager.js";
import { getTradeLifecycles, venueOf } from "./tradeLedgerStore.js";
import { loadState, saveState } from "./stateStore.js";

export const SWING_VERSION = "2026-09-29-swing";

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** The swing settings, from config.swing, with the account holder's choices as defaults. */
export function swingSettings(config = {}) {
  const s = config.swing && typeof config.swing === "object" ? config.swing : {};
  return {
    enabled: s.enabled !== false,
    halfAtFair: s.halfAtFair !== false,
    targetPct: num(s.targetPct, 65),                 // sell the rest at +65% net
    blowoutBelowPct: num(s.blowoutBelowPct, 10),     // score+clock win chance under this = blowout
    blowoutMarketMaxCents: num(s.blowoutMarketMaxCents, 20), // ...and the market must agree
    minProfitCents: num(s.minProfitCents, 1),        // the half sale must clear this per contract
    reentryMinutes: num(s.reentryMinutes, 3),        // cool-off before buying the same game again
    dailyGoalPct: num(s.dailyGoalPct, 40),           // daily profit goal, % of start-of-day equity
    noScoreLineMaxAgeSeconds: num(config.noScoreMaxLineAgeSeconds, 120),
  };
}

// --- Fair value ------------------------------------------------------------------

/**
 * What the score and clock say this team is worth right now, seconded by the
 * sharp line. Never throws; fields are null when not knowable.
 */
export async function liveFair({ sportKey, teamName, commenceTime }, config = {}) {
  const s = swingSettings(config);
  const out = {
    fair: null, model: null, sharp: null, sharpLineAgeSeconds: null,
    score: null, lead: null, fracRemaining: null, prior: null, source: null,
  };

  const f = getFair(sportKey, teamName);
  const maxAge = num(config.fairValueMaxAgeSeconds, 420);
  const lineLimit = num(config.maxLineAgeSecondsLive, 900);
  if (f && f.ageSeconds <= maxAge && (f.lineAgeSeconds == null || f.lineAgeSeconds <= lineLimit)) {
    out.sharp = f.prob;
    out.sharpLineAgeSeconds = f.lineAgeSeconds != null ? Math.round(f.lineAgeSeconds + f.ageSeconds) : null;
  }

  const started = commenceTime && Date.parse(commenceTime) <= Date.now();
  if (started && paramsFor(sportKey)) {
    let events = [];
    try { events = (await getLiveScores(sportKey)).events || []; } catch { events = []; }
    const game = findLiveGameForTeam(events, teamName);
    if (game) {
      const frac = fractionRemaining(sportKey, commenceTime);
      const prior = pregamePrior({ sportKey, teamName, commenceTime });
      // No pre-game line on record: an even prior, so the lead is not
      // counted twice (a live line as the prior already contains the score).
      const usedPrior = prior != null ? prior : 0.5;
      const model = liveWinProbability({ sportKey, pregameProbability: usedPrior, lead: game.lead, fracRemaining: frac });
      out.model = model;
      out.prior = prior;
      out.lead = game.lead;
      out.fracRemaining = frac;
      out.score = `${game.homeTeam} ${game.homeScore}-${game.awayScore} ${game.awayTeam}`;
    }
  }

  if (out.model != null && out.sharp != null) { out.fair = Math.min(out.model, out.sharp); out.source = "score+clock and sharp line (lower)"; }
  else if (out.model != null) { out.fair = out.model; out.source = "score+clock"; }
  else if (out.sharp != null && out.sharpLineAgeSeconds != null && out.sharpLineAgeSeconds <= s.noScoreLineMaxAgeSeconds) {
    out.fair = out.sharp; out.source = `sharp line (${out.sharpLineAgeSeconds}s old, no live score)`;
  }
  return out;
}

// --- The decision ------------------------------------------------------------------

/** Lowest price in [1, 99] at which pred(price) holds, scanning up; null if none. */
function lowestPrice(pred) {
  for (let p = 1; p <= 99; p++) if (pred(p)) return p;
  return null;
}

/**
 * One position, one decision. Pure.
 *
 *   contracts, soldHalf            the position now
 *   entryCents, entryFeeCents      per contract, what was paid
 *   bidCents, askCents             this side's book now
 *   fair, model                    probabilities 0-1 or null (liveFair)
 *   feeMult                        0.07 Kalshi, 0.0695 Polymarket
 *
 * Returns { action: "hold" | "sell-half" | "sell-all", code, count, floorCents,
 *           why, net, gainPct, halfAtCents, targetAtCents }.
 */
export function swingDecision({ contracts, soldHalf = false, entryCents, entryFeeCents = 0, bidCents, askCents = null, fair = null, model = null, feeMult = 0.07, settings }) {
  const s = settings || swingSettings({});
  const n = Math.max(1, Math.floor(contracts || 1));
  const cost = Number(entryCents) + Number(entryFeeCents || 0);
  const netAt = (p) => p - feePerContractCents(p, n, feeMult);
  const gainAt = (p) => ((netAt(p) - cost) / cost) * 100;

  const targetAtCents = lowestPrice((p) => gainAt(p) >= s.targetPct);
  // The half sale is its own order of floor(n/2) contracts, and the fee is
  // rounded up per order - so its threshold uses that order's fee.
  const halfCount = n >= 2 ? Math.floor(n / 2) : n;
  const halfNetAt = (p) => p - feePerContractCents(p, halfCount, feeMult);
  const halfAtCents = fair != null && s.halfAtFair && !soldHalf
    ? lowestPrice((p) => halfNetAt(p) >= fair * 100 && halfNetAt(p) - cost >= s.minProfitCents)
    : null;
  const base = { halfAtCents, targetAtCents, net: null, gainPct: null };

  if (!(bidCents > 0)) return { ...base, action: "hold", code: "no-bid", why: "nobody is bidding for this side right now" };
  const net = netAt(bidCents);
  const gainPct = gainAt(bidCents);
  Object.assign(base, { net, gainPct });
  const mid = askCents > 0 && askCents < 100 ? (bidCents + askCents) / 2 : bidCents;

  // 1. BLOWOUT: the score and clock say the game is gone, and the market agrees.
  if (model != null) {
    if (model * 100 < s.blowoutBelowPct && mid <= s.blowoutMarketMaxCents) {
      return {
        ...base, action: "sell-all", code: "blowout", count: n, floorCents: null,
        why: `blowout - score and clock give ${(model * 100).toFixed(0)}% (under ${s.blowoutBelowPct}%) and the market agrees at ${mid.toFixed(0)}c; selling ${n} at ${bidCents}c and moving on`,
      };
    }
  } else if (mid <= s.blowoutBelowPct) {
    return {
      ...base, action: "sell-all", code: "blowout-market", count: n, floorCents: null,
      why: `blowout - no live score, and the market has this side at ${mid.toFixed(0)}c (under ${s.blowoutBelowPct}c); selling ${n} at ${bidCents}c and moving on`,
    };
  }

  // 2. TARGET: +65% on what was paid, after both fees.
  if (targetAtCents != null && bidCents >= targetAtCents) {
    return {
      ...base, action: "sell-all", code: "target", count: n, floorCents: targetAtCents,
      why: `target hit - ${bidCents}c bid nets ${net.toFixed(1)}c against ${cost.toFixed(1)}c paid (+${gainPct.toFixed(0)}%, target +${s.targetPct}%); selling ${n}`,
    };
  }

  // 3. THE RALLY: the price is back at fair value - bank half.
  if (halfAtCents != null && bidCents >= halfAtCents) {
    const count = halfCount;
    const hn = halfNetAt(bidCents);
    return {
      ...base, action: count === n ? "sell-all" : "sell-half", code: "rally-half", count, floorCents: halfAtCents,
      why: `rally - ${bidCents}c bid nets ${hn.toFixed(1)}c, at or above fair value ${(fair * 100).toFixed(1)}%, +${(hn - cost).toFixed(1)}c a contract; ` +
        `selling ${count} of ${n}${count < n ? `, the rest ride to ${targetAtCents != null ? `${targetAtCents}c (+${s.targetPct}%)` : "settlement"}` : ""}`,
    };
  }

  const next = [];
  if (halfAtCents != null) next.push(`half at ${halfAtCents}c`);
  else if (!soldHalf && fair == null) next.push("half at fair value once it can be read");
  next.push(targetAtCents != null ? `${soldHalf ? "rest" : "all"} at ${targetAtCents}c (+${s.targetPct}%)` : "holds to settlement (+65% is above 99c)");
  return {
    ...base, action: "hold", code: "hold",
    why: `holding - bid ${bidCents}c (${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}%)${fair != null ? `, fair ${(fair * 100).toFixed(1)}%` : ""}${model != null ? `, score+clock ${(model * 100).toFixed(0)}%` : ""}; next: ${next.join(", ")}`,
  };
}

// --- The desk -------------------------------------------------------------------------

const views = { kalshi: new Map(), polymarket: new Map() };
const VIEW_KEEP_MS = 10 * 60 * 1000;

/** The latest look at one open position (called by both exchanges every check). */
export function noteView(venue, key, view) {
  const m = views[venue];
  if (!m) return;
  m.set(key, { ...view, at: new Date().toISOString() });
}

/** Drops a position from the desk once it is fully sold or settled. */
export function dropView(venue, key) {
  views[venue]?.delete(key);
}

const PT = "America/Los_Angeles";
function ptDate(ms = Date.now()) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: PT });
}

/**
 * START-OF-DAY EQUITY (Pacific time - the account holder's day). The first
 * equity each exchange reports after midnight PT is the day's start; it is
 * kept in state, so a restart mid-day does not move the goal.
 */
const lastEquitySave = { kalshi: 0, polymarket: 0 };

export function noteEquity(venue, equity) {
  const e = Number(equity);
  if (!(e > 0) || !["kalshi", "polymarket"].includes(venue)) return;
  try {
    const st = loadState();
    const today = ptDate();
    const day = st.deskDay && st.deskDay.date === today ? { ...st.deskDay } : { date: today };
    const rounded = Math.round(e * 100) / 100;
    const startMissing = day[venue] == null;
    if (startMissing) day[venue] = rounded;
    const nowChanged = day[`${venue}Now`] !== rounded;
    day[`${venue}Now`] = rounded;
    // The day's start is written at once; the running figure at most once a minute.
    if (startMissing || !st.deskDay || st.deskDay.date !== today || (nowChanged && Date.now() - lastEquitySave[venue] > 60_000)) {
      st.deskDay = day;
      saveState(st);
      lastEquitySave[venue] = Date.now();
    }
  } catch { /* the desk never affects trading */ }
}

function eventKey(ticker) {
  const t = String(ticker || "");
  if (t.startsWith("PM:")) return t.split(":")[1] || t;
  const parts = t.split("-");
  return parts.length > 1 ? `${parts[0]}-${parts[1]}` : t;
}

/** Everything the Trading Desk shows. */
export function deskReport(config = {}) {
  const s = swingSettings(config);
  const today = ptDate();
  let st = {};
  try { st = loadState(); } catch { st = {}; }
  const day = st.deskDay && st.deskDay.date === today ? st.deskDay : { date: today };

  let pieces = [];
  let completed = [];
  try {
    const lc = getTradeLifecycles();
    pieces = lc.pieces || [];
    completed = lc.completed || [];
  } catch { /* shown empty */ }
  const isToday = (iso) => iso && ptDate(Date.parse(iso)) === today;
  const todayPieces = pieces.filter((p) => isToday(p.timestamp));

  const venueDay = (venue) => {
    const ps = todayPieces.filter((p) => venueOf(p.ticker) === venue);
    const closedToday = completed.filter((t) => venueOf(t.ticker) === venue && isToday(t.exitTimestamp));
    const byGame = new Map();
    for (const t of closedToday) {
      const k = eventKey(t.ticker);
      const g = byGame.get(k) || { game: t.teamName, sportKey: t.sportKey, roundTrips: 0, net: 0 };
      g.roundTrips++; g.net += t.netDollars;
      byGame.set(k, g);
    }
    const open = [...views[venue].values()].filter((v) => Date.now() - Date.parse(v.at) < VIEW_KEEP_MS);
    const unrealized = open.reduce((t, v) => t + (Number.isFinite(v.unrealizedDollars) ? v.unrealizedDollars : 0), 0);
    return {
      startEquity: day[venue] ?? null,
      equityNow: day[`${venue}Now`] ?? null,
      realizedDollars: round2(ps.reduce((t, p) => t + p.netDollars, 0)),
      unrealizedDollars: round2(unrealized),
      sells: ps.length,
      roundTrips: closedToday.length,
      wins: closedToday.filter((t) => t.netDollars > 0).length,
      losses: closedToday.filter((t) => t.netDollars < 0).length,
      games: [...byGame.values()].map((g) => ({ ...g, net: round2(g.net) })).sort((a, b) => b.roundTrips - a.roundTrips),
      positions: open.sort((a, b) => Date.parse(a.openedAt || 0) - Date.parse(b.openedAt || 0)),
    };
  };

  const kalshi = venueDay("kalshi");
  const polymarket = venueDay("polymarket");
  const start = (kalshi.startEquity ?? 0) + (polymarket.startEquity ?? 0);
  const realized = kalshi.realizedDollars + polymarket.realizedDollars;
  const unrealized = kalshi.unrealizedDollars + polymarket.unrealizedDollars;
  const goalDollars = start > 0 ? round2(start * (s.dailyGoalPct / 100)) : null;

  return {
    version: SWING_VERSION,
    date: today,
    settings: {
      enabled: s.enabled, halfAtFair: s.halfAtFair, targetPct: s.targetPct,
      blowoutBelowPct: s.blowoutBelowPct, reentryMinutes: s.reentryMinutes, dailyGoalPct: s.dailyGoalPct,
      minExpectedReturnPct: num(config.minExpectedReturnPct, 10),
    },
    goal: {
      startEquity: start > 0 ? round2(start) : null,
      goalDollars,
      doubleDollars: start > 0 ? round2(start) : null,
      realizedDollars: round2(realized),
      unrealizedDollars: round2(unrealized),
      totalDollars: round2(realized + unrealized),
      pctOfStart: start > 0 ? round2(((realized + unrealized) / start) * 100) : null,
      realizedPctOfStart: start > 0 ? round2((realized / start) * 100) : null,
    },
    kalshi,
    polymarket,
    recentSells: todayPieces.slice(-25).reverse().map((p) => ({
      venue: venueOf(p.ticker), team: p.teamName, sportKey: p.sportKey, contracts: p.contracts,
      entryCents: p.entryPriceCents, exitCents: p.exitPriceCents, net: round2(p.netDollars),
      reason: p.reason, at: p.timestamp, closesTrade: p.closesTrade,
    })),
  };
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** One position's desk row. */
export function viewFor({ venue, ticker, teamName, sportKey, side, contracts, soldHalf, entryCents, entryFeeCents, openedAt, bidCents, askCents, lf, d }) {
  const cost = Number(entryCents) + Number(entryFeeCents || 0);
  const unrealized = d.net != null ? ((d.net - cost) * contracts) / 100 : null;
  return {
    venue, ticker, teamName, sportKey, side, contracts, soldHalf: !!soldHalf,
    entryCents, bidCents: bidCents ?? null, askCents: askCents ?? null,
    fairPct: lf?.fair != null ? Math.round(lf.fair * 1000) / 10 : null,
    modelPct: lf?.model != null ? Math.round(lf.model * 1000) / 10 : null,
    sharpPct: lf?.sharp != null ? Math.round(lf.sharp * 1000) / 10 : null,
    score: lf?.score ?? null,
    minutesLeftPct: lf?.fracRemaining != null ? Math.round(lf.fracRemaining * 100) : null,
    gainPct: d.gainPct != null ? Math.round(d.gainPct * 10) / 10 : null,
    unrealizedDollars: unrealized != null ? Math.round(unrealized * 100) / 100 : null,
    halfAtCents: d.halfAtCents, targetAtCents: d.targetAtCents,
    action: d.action, code: d.code, why: d.why, openedAt,
  };
}
