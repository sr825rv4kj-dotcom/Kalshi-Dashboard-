/**
 * Resolves a sportsbook team name + kickoff time to a live Kalshi ticker.
 * Filters by sport series and time window before any text matching.
 * Kalshi titles games by city ("Seattle vs Texas"); sportsbooks send full
 * names ("Seattle Mariners"), so matching is on any significant word.
 */

import { kalshiGet } from "./kalshiClient.js";

const V2 = "/trade-api/v2";
const MATCH_WINDOW_HOURS = 14;
const CACHE_TTL_MS = 5 * 60 * 1000;

export const SPORT_SERIES_MAP = {
  americanfootball_nfl: "KXNFLGAME",
  americanfootball_ncaaf: "KXNCAAFGAME",
  basketball_nba: "KXNBAGAME",
  basketball_ncaab: "KXNCAABGAME",
  baseball_mlb: "KXMLBGAME",
  icehockey_nhl: "KXNHLGAME",
};

const NON_TEAM_OUTCOMES = new Set(["draw", "tie"]);
const cache = new Map();

function normalize(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function eventTime(e) {
  return e.strike_date ?? e.expected_expiration_time;
}

async function getOpenEvents(series) {
  const hit = cache.get(series);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.events;
  const data = await kalshiGet(`${V2}/events`, `?series_ticker=${series}&status=open&with_nested_markets=true`);
  const events = data.events ?? [];
  cache.set(series, { events, at: Date.now() });
  return events;
}

export async function resolveTicker({ sportKey, teamName, commenceTime }) {
  if (NON_TEAM_OUTCOMES.has((teamName || "").toLowerCase().trim())) {
    return { ticker: null, reason: "draw/tie is not a two-sided market" };
  }

  const series = SPORT_SERIES_MAP[sportKey];
  if (!series) return { ticker: null, reason: `no Kalshi series for "${sportKey}"` };

  let events;
  try {
    events = await getOpenEvents(series);
  } catch (err) {
    return { ticker: null, reason: `${series} events fetch failed: ${err.message}` };
  }

  const target = new Date(commenceTime).getTime();
  const inWindow = events.filter((e) => {
    const t = eventTime(e);
    return t && Math.abs(new Date(t).getTime() - target) <= MATCH_WINDOW_HOURS * 3600 * 1000;
  });
  if (!inWindow.length) {
    return { ticker: null, reason: `no ${series} event within ${MATCH_WINDOW_HOURS}h (${events.length} open total)` };
  }

  const words = normalize(teamName).split(" ").filter((w) => w.length > 2);
  if (!words.length) return { ticker: null, reason: `no usable words in "${teamName}"` };

  const matches = inWindow.filter((e) => words.some((w) => normalize(e.title).includes(w)));
  if (!matches.length) {
    return { ticker: null, reason: `no title match for "${teamName}" among ${inWindow.length}, e.g. "${inWindow[0].title}"` };
  }

  // A team can appear in several fixtures; take the one closest to the
  // sportsbook's kickoff time rather than guessing.
  const event = matches.reduce((best, e) =>
    Math.abs(new Date(eventTime(e)).getTime() - target) < Math.abs(new Date(eventTime(best)).getTime() - target) ? e : best
  );

  const market = (event.markets ?? []).find((m) =>
    words.some((w) => normalize(`${m.yes_sub_title ?? ""} ${m.subtitle ?? ""} ${m.title ?? ""}`).includes(w))
  );
  if (!market) {
    return { ticker: null, reason: `matched "${event.title}" but no side matched "${teamName}"` };
  }

  return { ticker: market.ticker, reason: `resolved via ${series} "${event.title}"` };
}

