/**
 * Resolves a sportsbook team name + kickoff time to a live Kalshi ticker.
 *
 * Queries /markets directly rather than /events. The events list carried no
 * usable dates, which forced a title-only search across every open event and
 * matched teams to the wrong week's fixture - tickers resolved, but the market
 * was already settled. /markets filters by close time server-side, so what
 * comes back is open and closing today, by construction.
 */

import { kalshiGet } from "./kalshiClient.js";

const V2 = "/trade-api/v2";
const WINDOW_BEFORE_H = 2;   // markets closing before now + this are already underway/over
const WINDOW_AFTER_H = 16;   // a game started now closes within this
const CACHE_TTL_MS = 3 * 60 * 1000;

export const SPORT_SERIES_MAP = {
  americanfootball_nfl: "KXNFLGAME",
  americanfootball_ncaaf: "KXNCAAFGAME",
  basketball_nba: "KXNBAGAME",
  basketball_ncaab: "KXNCAABGAME",
  baseball_mlb: "KXMLBGAME",
  icehockey_nhl: "KXNHLGAME",
};

const NON_TEAM_OUTCOMES = new Set(["draw", "tie"]);

// Words that match far too many schools/teams to identify one on their own.
const WEAK = new Set([
  "state", "university", "college", "the", "saint", "north", "south", "east", "west",
  "central", "eastern", "western", "northern", "southern", "tech", "a&m", "am",
]);

const cache = new Map();

function normalize(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function marketText(m) {
  return normalize(`${m.yes_sub_title ?? ""} ${m.subtitle ?? ""} ${m.title ?? ""} ${m.event_ticker ?? ""}`);
}

function closeMs(m) {
  const t = m.close_time ?? m.expected_expiration_time;
  if (!t) return null;
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** All open markets in this series closing inside the window, paginated. */
async function getOpenMarkets(series) {
  const hit = cache.get(series);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.markets;

  const nowSec = Math.floor(Date.now() / 1000);
  const minTs = nowSec - WINDOW_BEFORE_H * 3600;
  const maxTs = nowSec + WINDOW_AFTER_H * 3600;

  const markets = [];
  let cursor = "";
  // Hard page cap: a full Saturday slate is large, but this must not loop forever
  // if Kalshi ever returns a non-advancing cursor.
  for (let page = 0; page < 10; page++) {
    const q =
      `?series_ticker=${series}&status=open&limit=1000` +
      `&min_close_ts=${minTs}&max_close_ts=${maxTs}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const data = await kalshiGet(`${V2}/markets`, q);
    for (const m of data.markets ?? []) markets.push(m);
    cursor = data.cursor || "";
    if (!cursor || !(data.markets ?? []).length) break;
  }

  cache.set(series, { markets, at: Date.now() });
  return markets;
}

export async function resolveTicker({ sportKey, teamName, commenceTime }) {
  if (NON_TEAM_OUTCOMES.has((teamName || "").toLowerCase().trim())) {
    return { ticker: null, reason: "draw/tie is not a two-sided market" };
  }

  const series = SPORT_SERIES_MAP[sportKey];
  if (!series) return { ticker: null, reason: `no Kalshi series for "${sportKey}"` };

  let markets;
  try {
    markets = await getOpenMarkets(series);
  } catch (err) {
    return { ticker: null, reason: `${series} markets fetch failed: ${err.message}` };
  }
  if (!markets.length) {
    return { ticker: null, reason: `${series}: no open markets closing in the next ${WINDOW_AFTER_H}h` };
  }

  const words = normalize(teamName).split(" ").filter((w) => w.length > 2);
  const strong = words.filter((w) => !WEAK.has(w));
  if (!words.length) return { ticker: null, reason: `no usable words in "${teamName}"` };

  const target = new Date(commenceTime).getTime();

  // Score every open market: strong words (mascot, distinctive city) count
  // double, weak ones count one. "NC State Wolfpack" must not match every
  // school with "State" in the name.
  const scored = [];
  for (const m of markets) {
    const text = marketText(m);
    let score = 0;
    for (const w of strong) if (text.includes(w)) score += 2;
    for (const w of words) if (WEAK.has(w) && text.includes(w)) score += 1;
    if (score > 0) scored.push({ m, score, ms: closeMs(m) });
  }

  if (!scored.length) {
    return {
      ticker: null,
      reason: `no open ${series} market matched "${teamName}" among ${markets.length}, e.g. "${markets[0].title}"`,
    };
  }

  // Best score wins; ties break on proximity to the sportsbook's kickoff.
  const best = scored.reduce((a, b) => {
    if (b.score !== a.score) return b.score > a.score ? b : a;
    const da = a.ms == null || Number.isNaN(target) ? Infinity : Math.abs(a.ms - target);
    const db = b.ms == null || Number.isNaN(target) ? Infinity : Math.abs(b.ms - target);
    return db < da ? b : a;
  });

  return {
    ticker: best.m.ticker,
    reason: `resolved to open market "${best.m.title}" (score ${best.score})`,
  };
}
