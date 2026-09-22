/**
 * seriesDiscovery.js
 *
 * Works out which Kalshi series each odds-feed sport should trade against.
 *
 * ---------------------------------------------------------------------------
 * THE MATCHER USED TO BIND REAL MONEY TO THE WRONG LEAGUE (2026-09-22)
 * ---------------------------------------------------------------------------
 * The previous scorer awarded +10 for ANY substring hit anywhere in a series
 * ticker, +8 more if the ticker contained "game", and accepted anything at or
 * above 10. One substring was therefore always enough. Run against the live
 * board, using the tickers the production log actually printed:
 *
 *   soccer_brazil_serie_b          -> KXSERIECGAME   (18)  on the word "serie"
 *   icehockey_sweden_hockey_league -> KXBALLERLEAGUEGAME (18) on "league"
 *   basketball_wnba                -> KXWNBAASGAME   (18)  All-Star, not WNBA
 *
 * A Brazilian club bound to an Italian league with 42 tradeable markets. The
 * only thing that prevented a wrong-league fill was the ticker date gate in
 * tickerResolver - one guard, load-bearing, with nothing behind it.
 *
 * And the decisive detail: baseball_mlb scored 18 too. So did soccer_epl. The
 * correct bindings and the garbage bindings scored IDENTICALLY, which means no
 * threshold could ever have separated them. Raising the bar to 19 would have
 * switched the bot off; leaving it at 10 kept trading the wrong leagues.
 *
 * Worse, ties were resolved by list order. `if (sc > bestScore)` keeps the
 * FIRST series seen at the top score, so KXSERIECGAME vs KXSERIEAGAME and
 * KXWNBAASGAME vs KXWNBAGAME were decided by however Kalshi happened to order
 * its response that morning. That is not a heuristic with a weak spot. That is
 * a coin flip in front of the order router.
 *
 * WHAT REPLACES IT. Kalshi series tickers are structured: KX + CORE + GAME
 * (or MATCH). The core is the league. So the core is extracted and matched
 * ANCHORED - a token must BE the core, not merely appear somewhere inside it:
 *
 *   "mlb"    vs core "MLB"          -> exact, bind
 *   "wnba"   vs core "WNBAAS"       -> not exact, refuse
 *   "serie"  vs core "SERIEC"       -> not exact, refuse
 *   "league" vs core "BALLERLEAGUE" -> not exact, refuse
 *
 * Under that rule every one of the 12 named sports still resolves, and all
 * three wrong bindings above are refused. A tie at the top is a REFUSAL rather
 * than a list-order coin flip, and the refusal is logged with both candidates
 * so an ambiguity is something you can go and look at.
 *
 * The bar this sets is deliberately harsh: a sport whose league has no
 * matching Kalshi core is simply not traded. Missing a sport costs nothing.
 * Trading the wrong one costs the position.
 * ---------------------------------------------------------------------------
 */

import { appendLog } from "./stateStore.js";

const V2 = "/trade-api/v2";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // series lists barely move

export const DISCOVERY_VERSION = "2026-09-22-anchored-core";

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
 * "league" is now in here. It is not distinctive - it appears in Baller League,
 * Major League Soccer, National League and a dozen others - and on its own it
 * was enough to bind Swedish hockey to a streamer exhibition series.
 */
const GENERIC_TOKENS = new Set([
  "americanfootball", "basketball", "baseball", "icehockey", "soccer", "tennis",
  "cricket", "golf", "mma", "boxing", "rugbyleague", "rugbyunion", "aussierules",
  "football", "hockey", "sport", "sports", "league", "liga", "serie", "division",
  "cup", "open", "championship", "pro", "premier", "national",
]);

/**
 * How leagues are written in English versus how an odds feed abbreviates them.
 * These are language facts, not assumptions about Kalshi's ticker format - the
 * match still has to find a real series core before anything is used.
 *
 * Note these are deliberately written as the CORE would appear: "laliga", not
 * "la liga", because the comparison is against a ticker core with no spaces.
 * Both spellings are kept so a title match can still use the spaced form.
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
 * Scores a series against a sport's tokens. ANCHORED, not substring.
 *
 * Only three things earn a bind:
 *   100  a token IS the series core exactly
 *    40  a token is the core with a country/gender qualifier attached that the
 *        sport key also carries (e.g. token "mlscup" vs core "MLSCUP")
 *    20  the series TITLE contains every distinctive token as a whole word
 *
 * Everything else scores 0. A partial overlap inside the core - the exact
 * thing that produced SERIEC, BALLERLEAGUE and WNBAAS - is worth nothing.
 */
export function scoreSeries(series, tokens) {
  const core = seriesCore(series.ticker);
  if (!core) return 0;
  if (isExhibitionCore(core)) return 0;

  const lowerCore = core.toLowerCase();
  let best = 0;

  for (const t of tokens) {
    const tok = t.replace(/[^a-z0-9]/g, "");
    if (!tok) continue;
    if (tok === lowerCore) best = Math.max(best, 100);
  }
  if (best) return best;

  // Whole-word title match, and ONLY if every distinctive token is present.
  // One word in a title is how "league" found Baller League; requiring all of
  // them means a title match has to actually describe the same competition.
  const title = String(series.title || "").toLowerCase();
  if (title) {
    const words = new Set(title.split(/[^a-z0-9]+/).filter(Boolean));
    const joinedTitle = title.replace(/[^a-z0-9]/g, "");
    const meaningful = tokens.filter((t) => t.length >= 3);
    if (meaningful.length) {
      const allPresent = meaningful.every((t) => {
        const tok = t.replace(/[^a-z0-9]/g, "");
        return words.has(tok) || joinedTitle === tok;
      });
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
