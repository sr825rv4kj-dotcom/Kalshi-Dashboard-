/**
 * gamesFeed.js
 *
 * Read-only feed of real, currently-open Kalshi game events for display
 * on the dashboard's Games Board - separate from tickerResolver.js
 * (which resolves a single team to a tradeable ticker). This just lists
 * what's on, for browsing.
 */

import { kalshiGet } from "./kalshiClient.js";
import { SPORT_SERIES_MAP } from "./tickerResolver.js";
import { getInSeasonSports } from "./seasonCalendar.js";

const V2 = "/trade-api/v2";

function splitTitle(title) {
  const separators = [" vs. ", " vs ", " @ ", " at "];
  for (const sep of separators) {
    if (title.includes(sep)) {
      const [a, b] = title.split(sep);
      return { teamA: a.trim(), teamB: b.trim() };
    }
  }
  return { teamA: title, teamB: null };
}

export async function getUpcomingGames(sportKey) {
  const seriesTicker = SPORT_SERIES_MAP[sportKey];
  if (!seriesTicker) return { games: [], seriesTicker: null };

  const data = await kalshiGet(`${V2}/events`, `?series_ticker=${seriesTicker}&status=open&with_nested_markets=true`);
  const events = data.events ?? [];

  const games = events
    .map((e) => {
      const { teamA, teamB } = splitTitle(e.title || "");
      const startTime = e.strike_date ?? e.expected_expiration_time ?? null;
      return {
        eventTicker: e.event_ticker,
        title: e.title,
        teamA, teamB,
        startTime,
        sportKey,
        isLive: startTime ? new Date(startTime).getTime() <= Date.now() : false,
      };
    })
    .filter((g) => g.startTime)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  return { games, seriesTicker };
}

/**
 * Aggregates getUpcomingGames() across every in-season sport in the pool,
 * for a single "everything the bot can currently see" feed. Live games
 * (already started) sort first, then soonest-upcoming.
 */
export async function getLiveFeed(sportsPool) {
  const activeSports = getInSeasonSports(sportsPool);
  const results = await Promise.all(
    activeSports.map((sportKey) => getUpcomingGames(sportKey).catch(() => ({ games: [] })))
  );

  const allGames = results.flatMap((r) => r.games);
  allGames.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return new Date(a.startTime) - new Date(b.startTime);
  });

  return { games: allGames, sportsScanned: activeSports };
}

export function getAvailableSportKeys() {
  return Object.keys(SPORT_SERIES_MAP);
}
