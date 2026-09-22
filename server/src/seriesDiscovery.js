/**
 * seriesDiscovery.js
 *
 * Works out which Kalshi series each odds-feed sport should trade against.
 *
 * ---------------------------------------------------------------------------
 * TWO FAILURES, IN OPPOSITE DIRECTIONS
 * ---------------------------------------------------------------------------
 * ROUND ONE - TOO LOOSE. The original scorer awarded +10 for ANY substring hit
 * anywhere in a series ticker and accepted anything at or above 10, so one
 * substring was always enough. Against the live board:
 *
 *   soccer_brazil_serie_b          -> KXSERIECGAME        on the word "serie"
 *   icehockey_sweden_hockey_league -> KXBALLERLEAGUEGAME  on "league"
 *   basketball_wnba                -> KXWNBAASGAME        All-Star, not WNBA
 *
 * A Brazilian club bound to an Italian league with 42 tradeable markets, and
 * ties were broken by list order - a coin flip in front of the order router.
 *
 * ROUND TWO - TOO TIGHT, AND WORSE. The fix demanded a token EQUAL the series
 * core. That killed every league Kalshi abbreviates:
 *
 *   soccer_argentina_primera_division -> KXARGPREMDIVGAME  core ARGPREMDIV
 *                                        score 0, REFUSED
 *
 * which is the market that produced +162% ROI on lanus vs ELP - the single
 * biggest winner in the account. What survived the tightening was MLB, the
 * most efficiently priced board there is, where the 2c fee demands a 2pt edge
 * that consensus devig cannot find. The bot went a full day at
 * "edge-too-small x16" and traded nothing, and the cause was here, not in the
 * edge bar.
 *
 * WHAT THIS DOES NOW. Kalshi series tickers are KX + CORE + GAME, and the core
 * is often abbreviated. So a token may match a CHUNK of the core, but the
 * chunks must be ANCHORED AND ORDERED: the first starts at position 0, later
 * ones follow it, and together they must explain at least half the core.
 *
 *   ARGPREMDIV  <- arg(entina) ... div(ision)    anchored, ordered, 6/10  BIND
 *   BALLERLEAGUE <- "all" from Allsvenskan        at index 1, not 0      REFUSE
 *   BALLERLEAGUE <- "league" from Ireland         at index 6, not 0      REFUSE
 *   SERIEC      <- "brazil"                       no chunk at all        REFUSE
 *
 * A tie between two different series is still a REFUSAL, never list order.
 *
 * Verified against every real series ticker in the production logs: MLB, NHL,
 * WNBA, Serie A, ODI cricket, WTA and the Argentine Primera - 25 assertions,
 * no mock tickers anywhere.
 * ---------------------------------------------------------------------------
 */

import { appendLog } from "./stateStore.js";

const V2 = "/trade-api/v2";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // series lists barely move

export const DISCOVERY_VERSION = "2026-09-22-abbreviated-core";

let cache = null;

/**
 * Confirmed mappings, kept as overrides because these are in production and
 * known correct. Discovery fills in everything else; these are never allowed
 * to be overwritten by a weaker match.
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
 *
 * "league", "liga" and "serie" are here because on their own they bound
 * Swedish hockey to a streamer exhibition series and Brazilian soccer to the
 * Italian third tier. "division" is NOT here - it is the DIV in ARGPREMDIV and
 * removing it is what let the Argentine Primera bind again.
 */
const GENERIC_TOKENS = new Set([
  "americanfootball", "basketball", "baseball", "icehockey", "soccer", "tennis",
  "cricket", "golf", "mma", "boxing", "rugbyleague", "rugbyunion", "aussierules",
  "football", "hockey", "sport", "sports", "league", "liga", "serie",
  "cup", "open", "championship", "pro", "premier", "national",
]);

/**
 * How leagues are written in English versus how an odds feed abbreviates them.
 * These are language facts, not assumptions about Kalshi's ticker format - the
 * match still has to find a real series core before anything is used.
 */
const ALIASES = {
  epl: ["epl", "premierleague"],
  spain_la_liga: ["laliga"],
  germany_bundesliga: ["bundesliga"],
  italy_serie_a: ["seriea"],
  italy_serie_b: ["serieb"],
  france_ligue_one: ["ligue1", "ligueone"],
  usa_mls: ["mls", "majorleaguesoccer"],
  uefa_champs_league: ["ucl", "championsleague"],
  uefa_europa_league: ["uel", "europaleague"],
  brazil_campeonato: ["brasileirao", "brasileiro", "campeonato"],
  atp: ["atp"],
  wta: ["wta"],
  wnba: ["wnba"],
  ncaaf: ["ncaaf"],
  ncaab: ["ncaab"],
  mlb: ["mlb"],
  nhl: ["nhl"],
  nba: ["nba"],
  nfl: ["nfl"],
};

/**
 * The league core of a Kalshi series ticker: KXNHLGAME -> NHL.
 *
 * The suffix strip runs twice because a few series end "...GAMES". Stripping
 * is anchored at the ends only - nothing is removed from the middle, so
 * BALLERLEAGUE stays BALLERLEAGUE and cannot be whittled down to LEAGUE.
 */
export function seriesCore(ticker) {
  let c = String(ticker || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  c = c.replace(/^KX/, "");
  for (let i = 0; i < 2; i++) c = c.replace(/(GAMES|GAME|MATCH|WINNER)$/, "");
  return c;
}

/**
 * All-star, pro-bowl and exhibition series. These are listed year-round and
 * dead for most of it - KXWNBAASGAME returned 0 markets on every query shape
 * in production, which is exactly what a dead series looks like from inside
 * the scanner. They are never an acceptable answer for a regular-season key.
 */
export function isExhibitionCore(core) {
  return /ALLSTAR|PROBOWL|EXHIB|FRIENDLY|PRESEASON/.test(core) || /^[A-Z]{3,}AS$/.test(core);
}

/** The distinctive parts of an odds-feed sport key, plus any known aliases. */
export function distinctiveTokens(sportKey) {
  const parts = String(sportKey || "").toLowerCase().split("_").filter(Boolean);
  const kept = parts.filter((p) => !GENERIC_TOKENS.has(p));
  const base = kept.length ? kept : parts;

  const out = new Set();
  for (const p of base) out.add(p);

  // The joined form matters as much as the parts: soccer_spain_la_liga only
  // becomes "laliga" once the segments are glued together, and "laliga" is the
  // thing that actually equals a ticker core.
  const allParts = parts.filter((p) => !["americanfootball", "basketball", "baseball", "icehockey", "soccer", "tennis", "cricket", "golf", "mma", "boxing"].includes(p));
  if (allParts.length > 1) out.add(allParts.join(""));
  if (base.length > 1) out.add(base.join(""));

  // Aliases match on whole segments only.
  //
  // This used to test `joined.endsWith(key)`, and "wnba" ends with "nba" - so
  // basketball_wnba inherited every NBA alias. With an NBA series present and
  // no WNBA series, WNBA would resolve to KXNBAGAME and the bot would trade
  // men's basketball as if it were the women's game.
  const joined = allParts.join("_");
  const segments = new Set(parts);
  for (const [key, words] of Object.entries(ALIASES)) {
    const keyParts = key.split("_");
    const isWholeKey = joined === key;
    const isSegmentMatch = keyParts.every((kp) => segments.has(kp));
    if (isWholeKey || isSegmentMatch) {
      for (const w of words) out.add(w);
    }
  }
  return [...out].filter((t) => t.length >= 2);
}

/**
 * Scores a series against a sport's tokens. Three ways to bind, in order of
 * confidence. Everything else scores 0.
 */
export function scoreSeries(series, tokens) {
  const core = seriesCore(series.ticker);
  if (!core) return 0;
  if (isExhibitionCore(core)) return 0;

  const lowerCore = core.toLowerCase();
  let best = 0;

  // 1. A token IS the core. MLB, NHL, EPL, LALIGA, ODI, WTA.
  for (const t of tokens) {
    const tok = t.replace(/[^a-z0-9]/g, "");
    if (!tok) continue;
    if (tok === lowerCore) best = Math.max(best, 100);
  }
  if (best) return best;

  // 2. ABBREVIATED CORES. Kalshi writes ARGPREMDIV, not
  //    ARGENTINAPRIMERADIVISION.
  //
  //    A token's leading letters may match a CHUNK of the core, but the chunks
  //    must be ANCHORED AND IN ORDER: the first starts at position 0, each
  //    later one after the previous. Floating matches are how "all" (from
  //    Allsvenskan) found the ALL inside bALLerleague, and how the compound
  //    token "leagueofireland" found LEAGUE inside ballerLEAGUE - both binding
  //    to a streamer exhibition series.
  const singleWordTokens = tokens.filter((t) => t.length >= 4 && !/\s/.test(t));
  let pos = 0, hits = 0, covered = 0;
  for (const t of singleWordTokens) {
    const tok = t.replace(/[^a-z0-9]/g, "");
    for (let n = Math.min(tok.length, 6); n >= 3; n--) {
      const at = lowerCore.indexOf(tok.slice(0, n), pos);
      // The FIRST chunk must start the core. Later chunks may sit after a gap
      // (ARG_PREM_DIV skips PREM) but never before an earlier one.
      if (at < 0) continue;
      if (hits === 0 && at !== 0) continue;
      pos = at + n; hits++; covered += n; break;
    }
  }
  // The core must be MOSTLY explained. ARGPREMDIV covered by arg+div is 6 of
  // 10 letters with the unmatched PREM sitting between them, which is a real
  // abbreviation; a single 3-letter hit against a long core is not.
  if (hits > 0 && covered * 2 >= lowerCore.length) return 40 + covered * 2 + hits;

  // 3. Whole-word title match, and ONLY if every distinctive single word is
  //    present. Compound tokens are excluded here: "argentinaprimeradivision"
  //    never appears in a title and its absence must not veto a real match.
  const title = String(series.title || "").toLowerCase();
  if (title) {
    const words = new Set(title.split(/[^a-z0-9]+/).filter(Boolean));
    const singles = tokens.filter((t) => t.length >= 3 && !/\s/.test(t));
    if (singles.length) {
      const allPresent = singles.every((t) => words.has(t.replace(/[^a-z0-9]/g, "")));
      if (allPresent) return 20;
    }
  }

  return 0;
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
 * Returns the confirmed rows unchanged if discovery fails for any reason, so a
 * Kalshi outage degrades coverage rather than stopping trading.
 */
export async function discoverSeriesMap(kalshiGet, sportKeys = []) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;

  let series = [];
  try {
    series = await fetchSeries(kalshiGet);
  } catch (err) {
    appendLog(`Series discovery failed (${err.message}) - falling back to the confirmed sports.`, "warn");
    return { ...CONFIRMED_SERIES };
  }

  if (!series.length) {
    appendLog("Series discovery returned nothing - falling back to the confirmed sports.", "warn");
    return { ...CONFIRMED_SERIES };
  }

  const map = { ...CONFIRMED_SERIES };
  const found = [];
  const missed = [];
  const ambiguous = [];

  for (const sportKey of sportKeys) {
    if (CONFIRMED_SERIES[sportKey]) continue;     // never override a known-good row

    const tokens = distinctiveTokens(sportKey);
    if (!tokens.length) { missed.push(sportKey); continue; }

    let bestScore = 0;
    let winners = [];
    for (const s of series) {
      const sc = scoreSeries(s, tokens);
      if (sc <= 0) continue;
      if (sc > bestScore) { bestScore = sc; winners = [s]; }
      else if (sc === bestScore) winners.push(s);
    }

    if (!winners.length || bestScore < 20) { missed.push(sportKey); continue; }

    // A TIE IS A REFUSAL.
    //
    // The old code took whichever tied series Kalshi happened to list first,
    // which is how the WNBA All-Star series beat the WNBA game series. If the
    // matcher cannot tell two competitions apart, neither can the bot, and the
    // right answer is to trade neither and say so.
    const distinct = [...new Set(winners.map((w) => w.ticker))];
    if (distinct.length > 1) {
      ambiguous.push(`${sportKey} -> ${distinct.join(" / ")}`);
      missed.push(sportKey);
      continue;
    }

    map[sportKey] = distinct[0];
    found.push(`${sportKey} -> ${distinct[0]}`);
  }

  appendLog(
    `Series discovery: ${series.length} Kalshi sports series seen, ` +
    `${Object.keys(map).length} sports addressable` +
    (found.length ? `. Matched: ${found.join(", ")}` : "") +
    (ambiguous.length ? `. REFUSED as ambiguous: ${ambiguous.join(", ")}` : "")
  );
  if (missed.length) {
    appendLog(
      `Series discovery: no Kalshi series for ${missed.length} sport(s) - they are not scanned and cost nothing. ` +
      `First few: ${missed.slice(0, 8).join(", ")}`
    );
  }

  cache = { map, at: Date.now(), seriesCount: series.length, found, missed, ambiguous };
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
    ambiguous: cache.ambiguous || [],
    map: cache.map,
  };
}

export function clearSeriesCache() { cache = null; }
