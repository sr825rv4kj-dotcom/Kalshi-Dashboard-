/**
 * seriesDiscovery.js
 *
 * Finds out which Kalshi series actually exist, instead of assuming.
 *
 * THE BUG THIS FIXES. SPORT_SERIES_MAP held six hardcoded entries - NFL,
 * NCAAF, NBA, NCAAB, MLB, NHL - and sportsDiscovery filtered the odds feed
 * down to exactly those. Everything else was invisible. Traced against a live
 * Kalshi board of 86 markets: WNBA, ATP tennis, Caribbean Premier League
 * cricket and Brasileiro soccer were all running, five of them with a side
 * inside the tradeable price band, and the bot could not see a single one.
 * It sat idle looking at two MLB games priced 77/24 and 97/4 that were never
 * going to clear an edge bar.
 *
 * Adding six more hardcoded rows would have gone stale the moment Kalshi
 * listed a new sport. So the map is now DISCOVERED: Kalshi publishes its own
 * series list at GET /series, which needs no authentication, and the bot reads
 * it and matches each odds-feed sport against what is really there.
 *
 * Every match and every miss is logged. A sport the bot cannot address is now
 * a visible line in the log rather than silence.
 */

import { appendLog } from "./stateStore.js";

const V2 = "/trade-api/v2";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // series lists barely move

let cache = null;

/**
 * Confirmed mappings, kept as overrides because these six are in production
 * and known correct. Discovery fills in everything else; these are never
 * allowed to be overwritten by a weaker match.
 */
export const CONFIRMED_SERIES = {
  americanfootball_nfl: "KXNFLGAME",
  americanfootball_ncaaf: "KXNCAAFGAME",
  basketball_nba: "KXNBAGAME",
  basketball_ncaab: "KXNCAABGAME",
  baseball_mlb: "KXMLBGAME",
  icehockey_nhl: "KXNHLGAME",
};

/**
 * Words that describe the SPORT rather than the competition. They are stripped
 * when working out what makes a sport key distinctive, so soccer_epl is matched
 * on "epl" rather than on "soccer", which would match every league at once.
 */
const GENERIC_TOKENS = new Set([
  "americanfootball", "basketball", "baseball", "icehockey", "soccer", "tennis",
  "cricket", "golf", "mma", "boxing", "rugbyleague", "rugbyunion", "aussierules",
  "football", "hockey", "sport", "sports",
]);

/**
 * How leagues are written in English versus how an odds feed abbreviates them.
 * These are language facts, not assumptions about Kalshi's ticker format - the
 * match still has to find a real series before anything is used.
 */
const ALIASES = {
  epl: ["premier league", "epl"],
  spain_la_liga: ["la liga", "laliga"],
  germany_bundesliga: ["bundesliga"],
  italy_serie_a: ["serie a", "seriea"],
  france_ligue_one: ["ligue 1", "ligue1"],
  usa_mls: ["mls", "major league soccer"],
  uefa_champs_league: ["champions league", "ucl"],
  brazil_campeonato: ["brazil", "brasileiro", "campeonato"],
  atp: ["atp"],
  wta: ["wta"],
  wnba: ["wnba"],
  ncaaf: ["ncaaf", "college football"],
  ncaab: ["ncaab", "college basketball"],
  mlb: ["mlb"],
  nhl: ["nhl"],
  nba: ["nba"],
  nfl: ["nfl"],
};

/** The distinctive parts of an odds-feed sport key, plus any known aliases. */
export function distinctiveTokens(sportKey) {
  const parts = String(sportKey || "").toLowerCase().split("_").filter(Boolean);
  const kept = parts.filter((p) => !GENERIC_TOKENS.has(p));
  const base = kept.length ? kept : parts;

  const out = new Set();
  for (const p of base) out.add(p);

  // Aliases match on whole segments only.
  //
  // This used to test `joined.endsWith(key)`, and "wnba" ends with "nba" - so
  // basketball_wnba inherited every NBA alias. Proved harmful in testing: with
  // an NBA series present and no WNBA series, WNBA resolved to KXNBAGAME and
  // the bot would have traded men's basketball markets as if they were the
  // women's game. A raw substring test is not good enough for something that
  // decides which market real money goes into.
  const joined = base.join("_");
  const segments = new Set(base);
  for (const [key, words] of Object.entries(ALIASES)) {
    const keyParts = key.split("_");
    const isWholeKey = joined === key;
    // every part of a multi-word alias key must appear as its own segment
    const isSegmentMatch = keyParts.every((kp) => segments.has(kp));
    if (isWholeKey || isSegmentMatch) {
      for (const w of words) out.add(w);
    }
  }
  return [...out].filter((t) => t.length >= 2);
}

/**
 * Scores how well a Kalshi series matches a sport. A per-game or per-match
 * series is strongly preferred over a season-long or futures market: buying
 * "who wins the league" is not what this bot does.
 */
function scoreSeries(series, tokens) {
  const ticker = String(series.ticker || "").toLowerCase();
  const title = String(series.title || "").toLowerCase();
  const hay = `${ticker} ${title}`;

  let score = 0;
  let matched = false;
  for (const t of tokens) {
    if (ticker.includes(t)) { score += 10; matched = true; }
    else if (title.includes(t)) { score += 6; matched = true; }
  }
  if (!matched) return 0;

  if (/game|match|winner/.test(ticker)) score += 8;
  if (/\bgame\b|\bmatch\b/.test(title)) score += 4;
  // Futures and season-long markets are not per-event and are demoted hard.
  if (/champion|season|award|mvp|playoff|finals|cup winner/.test(hay)) score -= 12;

  return score;
}

async function fetchSeries(kalshiGet) {
  // Category is exact and case-sensitive upstream, so both spellings are tried
  // and the results merged rather than betting on one.
  const seen = new Map();
  for (const category of ["Sports", "sports"]) {
    try {
      const res = await kalshiGet(`${V2}/series`, `?category=${category}`);
      const list = res?.series || res?.series_list || [];
      for (const s of list) if (s?.ticker && !seen.has(s.ticker)) seen.set(s.ticker, s);
      if (seen.size) break;
    } catch {
      // try the next spelling
    }
  }
  return [...seen.values()];
}

/**
 * Builds sportKey -> Kalshi series ticker for every sport the odds feed offers.
 * Returns the confirmed six unchanged if discovery fails for any reason, so a
 * Kalshi outage degrades coverage rather than stopping trading.
 */
export async function discoverSeriesMap(kalshiGet, sportKeys = []) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;

  let series = [];
  try {
    series = await fetchSeries(kalshiGet);
  } catch (err) {
    appendLog(`Series discovery failed (${err.message}) - falling back to the six confirmed sports.`, "warn");
    return { ...CONFIRMED_SERIES };
  }

  if (!series.length) {
    appendLog("Series discovery returned nothing - falling back to the six confirmed sports.", "warn");
    return { ...CONFIRMED_SERIES };
  }

  const map = { ...CONFIRMED_SERIES };
  const found = [];
  const missed = [];

  for (const sportKey of sportKeys) {
    if (CONFIRMED_SERIES[sportKey]) continue;     // never override a known-good row

    const tokens = distinctiveTokens(sportKey);
    if (!tokens.length) { missed.push(sportKey); continue; }

    let best = null, bestScore = 0;
    for (const s of series) {
      const sc = scoreSeries(s, tokens);
      if (sc > bestScore) { bestScore = sc; best = s; }
    }

    // A single weak token hit is not enough to start trading a market on.
    if (best && bestScore >= 10) {
      map[sportKey] = best.ticker;
      found.push(`${sportKey} -> ${best.ticker}`);
    } else {
      missed.push(sportKey);
    }
  }

  appendLog(
    `Series discovery: ${series.length} Kalshi sports series seen, ` +
    `${Object.keys(map).length} sports addressable` +
    (found.length ? `. New: ${found.join(", ")}` : "") +
    (missed.length ? `. No series for: ${missed.join(", ")}` : "")
  );

  cache = { map, at: Date.now(), seriesCount: series.length, found, missed };
  return map;
}

/** What discovery last concluded, for the dashboard. */
export function lastDiscovery() {
  if (!cache) return null;
  return {
    at: new Date(cache.at).toISOString(),
    seriesCount: cache.seriesCount,
    addressable: Object.keys(cache.map).length,
    found: cache.found,
    missed: cache.missed,
    map: cache.map,
  };
}

export function clearSeriesCache() { cache = null; }
