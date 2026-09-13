/**
 * tickerResolver.js
 *
 * Automatically finds the correct, currently-open Kalshi market for a
 * given sportsbook team name and kickoff time - without ever guessing
 * across the full universe of open markets. Safety comes from two hard
 * filters applied BEFORE any text comparison:
 *
 *   1. Series filter - only looks within that sport's own Kalshi series
 *      (e.g. NFL games only ever match against KXNFLGAME markets).
 *   2. Time filter - only considers events starting within a tight
 *      window of the odds provider's kickoff time (default 3 hours).
 *
 * Only after both filters narrow the field to (almost always) a single
 * real game does it compare team names - and even then, it requires an
 * unambiguous match. Zero or multiple candidates after that = skip and
 * log, never a guess. Manual entries in ticker-map.json / polymarket-map.json
 * always take priority over this and are checked first by the caller.
 *
 * SPORT_SERIES_MAP uses Kalshi's real series-ticker naming convention.
 * If a sport you're scanning isn't listed here, add its series ticker -
 * that's a one-time addition, not per-game maintenance.
 */

import { kalshiGet } from "./kalshiClient.js";

const V2 = "/trade-api/v2";
const MATCH_WINDOW_HOURS = 3;
const CACHE_TTL_MS = 5 * 60 * 1000;

const SPORT_SERIES_MAP = {
  americanfootball_nfl: "KXNFLGAME",
  americanfootball_ncaaf: "KXNCAAFGAME",
  basketball_nba: "KXNBAGAME",
  basketball_ncaab: "KXNCAABGAME",
  baseball_mlb: "KXMLBGAME",
  icehockey_nhl: "KXNHLGAME",
  soccer_epl: "KXEPLGAME",
  soccer_spain_la_liga: "KXLALIGAGAME",
  soccer_germany_bundesliga: "KXBUNDESLIGAGAME",
  soccer_italy_serie_a: "KXSERIEAGAME",
  soccer_usa_mls: "KXMLSGAME",
};

const eventListCache = new Map(); // seriesTicker -> { events, fetchedAt }

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

async function getOpenEvents(seriesTicker) {
  const cached = eventListCache.get(seriesTicker);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.events;

  const data = await kalshiGet(`${V2}/events`, `?series_ticker=${seriesTicker}&status=open&with_nested_markets=true`);
  const events = data.events ?? [];
  eventListCache.set(seriesTicker, { events, fetchedAt: Date.now() });
  return events;
}

function withinTimeWindow(eventTime, targetTime, hours) {
  if (!eventTime) return false;
  const diffMs = Math.abs(new Date(eventTime).getTime() - new Date(targetTime).getTime());
  return diffMs <= hours * 60 * 60 * 1000;
}

/**
 * Resolves { sportKey, teamName, commenceTime } to a real, currently-open
 * Kalshi ticker for that team to win, or null if no confident match exists.
 * Never falls back to a fuzzy/best-guess match across an unfiltered set.
 */
export async function resolveTicker({ sportKey, teamName, commenceTime }) {
  const seriesTicker = SPORT_SERIES_MAP[sportKey];
  if (!seriesTicker) {
    return { ticker: null, reason: `no Kalshi series mapping configured for "${sportKey}"` };
  }

  let events;
  try {
    events = await getOpenEvents(seriesTicker);
  } catch (err) {
    return { ticker: null, reason: `Kalshi events fetch failed for ${seriesTicker}: ${err.message}` };
  }

  const timeMatches = events.filter((e) =>
    withinTimeWindow(e.strike_date ?? e.expected_expiration_time, commenceTime, MATCH_WINDOW_HOURS)
  );
  if (timeMatches.length === 0) {
    return { ticker: null, reason: `no ${seriesTicker} event found within ${MATCH_WINDOW_HOURS}h of kickoff` };
  }

  const normalizedTeam = normalize(teamName);
  const teamWords = normalizedTeam.split(" ").filter((w) => w.length > 2);

  const candidates = [];
  for (const event of timeMatches) {
    const normalizedTitle = normalize(event.title);
    const overlap = teamWords.filter((w) => normalizedTitle.includes(w));
    if (overlap.length >= Math.max(1, teamWords.length - 1)) {
      candidates.push(event);
    }
  }

  if (candidates.length === 0) {
    return { ticker: null, reason: `no title match for "${teamName}" among ${timeMatches.length} candidate event(s)` };
  }
  if (candidates.length > 1) {
    return { ticker: null, reason: `ambiguous match for "${teamName}" - ${candidates.length} candidate events, skipping rather than guessing` };
  }

  const event = candidates[0];
  const markets = event.markets ?? [];
  const teamMarket = markets.find((m) => {
    const subtitle = normalize(m.yes_sub_title ?? m.subtitle ?? m.title);
    const overlap = teamWords.filter((w) => subtitle.includes(w));
    return overlap.length >= Math.max(1, teamWords.length - 1);
  });

  if (!teamMarket) {
    return { ticker: null, reason: `matched event "${event.title}" but no market side matched "${teamName}"` };
  }

  return { ticker: teamMarket.ticker, reason: `resolved via ${seriesTicker} event "${event.title}"` };
}
