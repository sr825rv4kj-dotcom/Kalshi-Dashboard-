/**
 * sportsDiscovery.
 *
 * Asks The-Odds-API which sports are actually active right now instead of
 * reading a hand-maintained list. Their /sports endpoint returns every sport
 * with an `active` flag and - per their docs - does not count against quota.
 *
 * Result: no sports pool to maintain. Seasons start and end on their own.
 */

import { SPORT_SERIES_MAP } from "./tickerResolver.js";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h - season status barely moves

let cache = null;

export async function discoverActiveSports() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.sports;

  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch(`${ODDS_API_BASE}/sports?apiKey=${apiKey}`);
    if (!res.ok) return cache?.sports ?? [];
    const all = await res.json();

    // Only sports that are (a) currently active and (b) ones we can actually
    // resolve to a Kalshi series. No point scanning odds we can't trade against.
    const tradeable = all
      .filter((s) => s.active && SPORT_SERIES_MAP[s.key])
      .map((s) => s.key);

    cache = { sports: tradeable, fetchedAt: Date.now() };
    return tradeable;
  } catch (err) {
    return cache?.sports ?? [];
  }
}

export function clearSportsCache() {
  cache = null;
}
