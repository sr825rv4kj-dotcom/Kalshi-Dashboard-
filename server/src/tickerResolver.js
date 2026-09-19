/**
 * Resolves a sportsbook team name + kickoff time to a live Kalshi ticker.
 *
 * Kalshi's /markets filters have not behaved as documented here, so this tries
 * progressively looser queries and keeps the first that returns anything, then
 * filters locally where the data is visible. lastFetchReport exposes what
 * happened for the diagnostic endpoint.
 */

import { kalshiGet } from "./kalshiClient.js";

const V2 = "/trade-api/v2";
const WINDOW_BEFORE_H = 3;
const WINDOW_AFTER_H = 30;
const CACHE_TTL_MS = 3 * 60 * 1000;

export const SPORT_SERIES_MAP = {
  americanfootball_nfl: "KXNFLGAME",
  americanfootball_ncaaf: "KXNCAAFGAME",
  basketball_nba: "KXNBAGAME",
  basketball_ncaab: "KXNCAABGAME",
  baseball_mlb: "KXMLBGAME",
  icehockey_nhl: "KXNHLGAME",
};

// Kalshi has used several words for "tradeable" across its API surface.
const TRADEABLE = new Set(["open", "active"]);
const NON_TEAM_OUTCOMES = new Set(["draw", "tie"]);
const WEAK = new Set([
  "state", "university", "college", "the", "saint", "north", "south", "east", "west",
  "central", "eastern", "western", "northern", "southern", "tech",
]);

const cache = new Map();
export const lastFetchReport = new Map();

function normalize(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function marketText(m) {
  return normalize(`${m.yes_sub_title ?? ""} ${m.subtitle ?? ""} ${m.title ?? ""} ${m.event_ticker ?? ""}`);
}

function closeMs(m) {
  const t = m.close_time ?? m.expected_expiration_time ?? m.expiration_time;
  if (!t) return null;
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? null : ms;
}

async function fetchPaged(query) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < 8; page++) {
    const q = query + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const data = await kalshiGet(`${V2}/markets`, q);
    const batch = data.markets ?? [];
    out.push(...batch);
    cursor = data.cursor || "";
    if (!cursor || !batch.length) break;
  }
  return out;
}

/** Tries each query shape in order, keeping the first that returns rows. */
async function getMarkets(series) {
  const hit = cache.get(series);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.markets;

  const nowSec = Math.floor(Date.now() / 1000);
  const attempts = [
    { label: "status=open", q: `?series_ticker=${series}&status=open&limit=1000` },
    { label: "status=active", q: `?series_ticker=${series}&status=active&limit=1000` },
    {
      label: "status=open+close_ts",
      q: `?series_ticker=${series}&status=open&limit=1000` +
         `&min_close_ts=${nowSec - WINDOW_BEFORE_H * 3600}&max_close_ts=${nowSec + WINDOW_AFTER_H * 3600}`,
    },
    { label: "no filters", q: `?series_ticker=${series}&limit=1000` },
  ];

  const tried = [];
  let markets = [];
  let winner = "none";
  for (const a of attempts) {
    try {
      const rows = await fetchPaged(a.q);
      tried.push({ label: a.label, returned: rows.length });
      if (rows.length) { markets = rows; winner = a.label; break; }
    } catch (err) {
      tried.push({ label: a.label, error: err.message });
    }
  }

  const statuses = {};
  for (const m of markets) statuses[m.status ?? "undefined"] = (statuses[m.status ?? "undefined"] || 0) + 1;

  lastFetchReport.set(series, {
    series, tried, winner, total: markets.length, statuses,
    sample: markets.slice(0, 3).map((m) => ({
      ticker: m.ticker, title: m.title, yes_sub_title: m.yes_sub_title,
      status: m.status, close_time: m.close_time, yes_ask: m.yes_ask,
    })),
    at: new Date().toISOString(),
  });

  cache.set(series, { markets, at: Date.now() });
  return markets;
}

export function getFetchReport(series) {
  return lastFetchReport.get(series) ?? null;
}

export async function resolveTicker({ sportKey, teamName, commenceTime }) {
  if (NON_TEAM_OUTCOMES.has((teamName || "").toLowerCase().trim())) {
    return { ticker: null, reason: "draw/tie is not a two-sided market" };
  }

  const series = SPORT_SERIES_MAP[sportKey];
  if (!series) return { ticker: null, reason: `no Kalshi series for "${sportKey}"` };

  let all;
  try {
    all = await getMarkets(series);
  } catch (err) {
    return { ticker: null, reason: `${series} markets fetch failed: ${err.message}` };
  }
  if (!all.length) {
    const r = getFetchReport(series);
    return { ticker: null, reason: `${series}: every query shape returned 0 (${JSON.stringify(r?.tried ?? [])})` };
  }

  // Status is the only gate that matters. Kalshi's close_time is the settlement
  // deadline, not kickoff - it sits days past the game - so filtering on it
  // discarded every genuinely tradeable market. "active" already means the book
  // is open right now, which is the whole question. Time survives only as a
  // tiebreak when a team appears in more than one fixture.
  const target = new Date(commenceTime).getTime();
  const tradeable = all.filter((m) => TRADEABLE.has(String(m.status || "").toLowerCase()));
  const pool = tradeable.length ? tradeable : all;

  if (!pool.length) {
    const statuses = {};
    for (const m of all) statuses[m.status ?? "?"] = (statuses[m.status ?? "?"] || 0) + 1;
    return { ticker: null, reason: `${series}: ${all.length} markets, none with a tradeable status (${JSON.stringify(statuses)})` };
  }

  const words = normalize(teamName).split(" ").filter((w) => w.length > 2);
  const strong = words.filter((w) => !WEAK.has(w));
  if (!words.length) return { ticker: null, reason: `no usable words in "${teamName}"` };

  // Strong words (mascot, distinctive city) count double so "NC State
  // Wolfpack" does not match every school with "State" in the name.
  const scored = [];
  for (const m of pool) {
    const text = marketText(m);
    let score = 0;
    for (const w of strong) if (text.includes(w)) score += 2;
    for (const w of words) if (WEAK.has(w) && text.includes(w)) score += 1;
    if (score > 0) scored.push({ m, score, ms: closeMs(m) });
  }

  if (!scored.length) {
    return { ticker: null, reason: `no ${series} market matched "${teamName}" among ${pool.length}, e.g. "${pool[0].title}"` };
  }

  const best = scored.reduce((a, b) => {
    if (b.score !== a.score) return b.score > a.score ? b : a;
    const da = a.ms == null || Number.isNaN(target) ? Infinity : Math.abs(a.ms - target);
    const db = b.ms == null || Number.isNaN(target) ? Infinity : Math.abs(b.ms - target);
    return db < da ? b : a;
  });

  return { ticker: best.m.ticker, reason: `matched "${best.m.title}" (${best.m.status}, score ${best.score})` };
}
