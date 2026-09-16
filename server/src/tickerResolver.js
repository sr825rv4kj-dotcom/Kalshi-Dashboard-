/**
 * tickerResolver.js
 *
 * Finds the correct, currently-open Kalshi market for a given sportsbook
 * team name and kickoff time. Safety comes from two hard filters applied
 * BEFORE any text comparison:
 *
 *   1. Series filter - only looks within that sport's own Kalshi series.
 *   2. Time filter - only events within MATCH_WINDOW_HOURS of kickoff.
 *
 * Kalshi titles games by city ("Seattle vs Texas") while sportsbooks send
 * full names ("Seattle Mariners"), so matching is on any significant word.
 * Three-way sports (soccer, where "draw" is an outcome) are excluded.
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

const eventListCache = new Map();

function normalize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
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

const NON_TEAM_OUTCOMES = new Set(["draw", "tie"]);

export async function resolveTicker({ sportKey, teamName, commenceTime }) {
  if (NON_TEAM_OUTCOMES.has((teamName || "").toLowerCase().trim())) {
    return { ticker: null, reason: "draw/tie is not a two-sided market" };
  }
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
    return { ticker: null, reason: `no ${seriesTicker} event within ${MATCH_WINDOW_HOURS}h of kickoff (${events.length} open events total)` };
  }

  // Kalshi titles games by city ("Seattle vs Texas") while sportsbooks send
  // full names ("Seattle Mariners"). Matching on ANY significant word handles
  // both directions - city-only titles and nickname-only subtitles.
  const teamWords = normalize(teamName).split(" ").filter((w) => w.length > 2);
  if (!teamWords.length) {
    return { ticker: null, reason: `no usable words in team name "${teamName}"` };
  }

  const candidates = timeMatches.filter((event) => {
    const title = normalize(event.title);
    return teamWords.some((w) => title.includes(w));
  });

  if (candidates.length === 0) {
    return { ticker: null, reason: `no title match for "${teamName}" among ${timeMatches.length} event(s), e.g. "${timeMatches[0].title}"` };
  }

  // A team can appear in more than one upcoming fixture. The sportsbook gave
  // us an exact kickoff time, so take the event closest to it.
  const event = candidates.reduce((best, e) => {
    const t = (ev) => Math.abs(
      new Date(ev.strike_date ?? ev.expected_expiration_time).getTime() - new Date(commenceTime).getTime()
    );
    return t(e) 
