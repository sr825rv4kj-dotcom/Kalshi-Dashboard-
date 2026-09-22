/**
 * tickerResolver.js
 *
 * Resolves a sportsbook team name + kickoff time to a live Kalshi ticker.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE WAS REPLACED: IT RETURNED LAST WEEK'S GAME
 * ---------------------------------------------------------------------------
 * A scan showed 33 "no matching Kalshi market", 11 "market not tradeable" and
 * 11 "status:finalized" in a single pass. Those three are the same bug.
 *
 * Teams play every week, so a series contains many markets carrying the same
 * team name. The tiebreak between them was:
 *
 *     Math.abs(closeMs(m) - kickoffTime)
 *
 * Kalshi's close_time is the SETTLEMENT deadline, not kickoff, and it sits days
 * past the game. For two fixtures of the same team a week apart it is often the
 * same timestamp to the hour:
 *
 *     KXNHLGAME-26SEP14STLDAL-STL   |close - target| = 145.0h
 *     KXNHLGAME-26SEP21STLDAL-STL   |close - target| = 145.0h
 *
 * Identical. So the tiebreak could not tell this week from last week and simply
 * kept whichever Kalshi listed first. When that was the older fixture, the
 * scanner fetched it, found status "finalized", and threw the line away - after
 * spending a Kalshi call on it. Every one of those was a game the bot could
 * have traded.
 *
 * Worse, the pool itself fell back to non-tradeable markets:
 *
 *     const pool = tradeable.length ? tradeable : all;
 *
 * so a settled market was a legitimate answer. It never could be.
 *
 * THE FIX, and it needs no guessing: Kalshi encodes the fixture date in the
 * ticker. Verified against ten real tickers from this account, 10/10 parsed:
 *
 *     KXNHLGAME-26SEP21STLDAL-STL      -> 2026-09-21
 *     KXWTAMATCH-26SEP20KASSAS-SAS     -> 2026-09-20
 *     KXARGPREMDIVGAME-26SEP21LANELP   -> 2026-09-21
 *
 * So the date is now a HARD GATE, not a tiebreak. A market whose ticker date is
 * not the game's date (allowing one day either side, because Kalshi names by
 * local date and the odds feed publishes UTC) is not a candidate at all. And the
 * pool never falls back to markets that cannot be traded.
 *
 * Every failure now returns a CODE as well as a sentence, so "33 unresolved"
 * becomes 33 rows split across five named causes instead of one dead end.
 * ---------------------------------------------------------------------------
 */

import { kalshiGet } from "./kalshiClient.js";

const V2 = "/trade-api/v2";
const CACHE_TTL_MS = 3 * 60 * 1000;

/** How many days either side of kickoff a ticker's date may sit. */
const DATE_SLACK_DAYS = 1;

export const RESOLVER_VERSION = "2026-09-22-ticker-code-identity";

/**
 * The six confirmed, in-production mappings. Everything beyond this is
 * DISCOVERED at runtime from Kalshi's own /series endpoint.
 */
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

/**
 * PLACE NAMES. These locate a team; they never identify one.
 *
 * "New York Yankees" and "New York Mets" share two of three words. Scoring
 * them equally is how, on 2026-09-22 at 12:12, a Yankees model sized three
 * contracts and the order went to KXMLBGAME-26SEP232005NYMTEX-NYM - the METS.
 *
 * Every shared-market city is exposed the same way: Lakers/Clippers,
 * Dodgers/Angels, Cubs/White Sox, Rangers/Islanders, Kings/Ducks, and in
 * soccer every Madrid, Manchester, Milan and London pair.
 *
 * This set is now used in two places: it stops a place name carrying a NAME
 * match on its own, and it stops a ticker code claiming a team when the only
 * word it reaches is a shared city.
 */
const GEO = new Set([
  // shared-market US metros and the words that make them up
  "new", "york", "los", "angeles", "la", "san", "francisco", "jose", "diego", "antonio",
  "chicago", "boston", "philadelphia", "philly", "washington", "dallas", "fort", "worth",
  "houston", "miami", "atlanta", "detroit", "denver", "phoenix", "seattle", "portland",
  "minnesota", "minneapolis", "tampa", "bay", "orlando", "cleveland", "cincinnati",
  "pittsburgh", "baltimore", "kansas", "city", "louis", "paul", "oakland", "sacramento",
  "vegas", "las", "nashville", "memphis", "milwaukee", "indianapolis", "columbus",
  "charlotte", "jacksonville", "buffalo", "brooklyn", "queens", "bronx", "anaheim",
  "arizona", "colorado", "carolina", "florida", "texas", "utah", "vancouver", "toronto",
  "montreal", "ottawa", "calgary", "edmonton", "winnipeg", "jersey", "england",
  // soccer cities with more than one club
  "madrid", "manchester", "milan", "london", "rome", "roma", "turin", "torino",
  "munich", "munchen", "liverpool", "barcelona", "sevilla", "seville",
  "lisbon", "porto", "glasgow", "birmingham", "nottingham", "sheffield", "bilbao",
]);

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

const cache = new Map();
export const lastFetchReport = new Map();

let runtimeSeriesMap = {};
export function setSeriesMap(map) {
  runtimeSeriesMap = map && typeof map === "object" ? map : {};
}
export function getSeriesMap() {
  return { ...SPORT_SERIES_MAP, ...runtimeSeriesMap };
}

/**
 * The fixture date encoded in a Kalshi ticker, as a UTC day number.
 * Returns null for a ticker that carries no date - those are then judged on
 * name alone rather than being discarded, because a series whose tickers are
 * shaped differently should degrade, not break.
 */
export function tickerDayNumber(ticker) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})/.exec(String(ticker || "").toUpperCase());
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (month == null) return null;
  const ms = Date.UTC(2000 + Number(m[1]), month, Number(m[3]));
  return Math.floor(ms / 86400000);
}

/**
 * The per-side team code a Kalshi ticker ends with.
 *
 *   KXMLBGAME-26SEP232005NYMTEX-NYM  -> "NYM"
 *   KXODIMATCH-26SEP220730SRIENG-SRI -> "SRI"
 *   KXARGPREMDIVGAME-26SEP21LANELP   -> null  (no side suffix on this series)
 *
 * A ticker with only two segments carries the fixture but not a side, so it
 * returns null and the caller falls back to name matching rather than trying
 * to read a pairing ("LANELP") as one team.
 */
export function tickerTeamCode(ticker) {
  const parts = String(ticker || "").toUpperCase().split("-");
  if (parts.length < 3) return null;
  const last = parts[parts.length - 1];
  return /^[A-Z0-9]{2,6}$/.test(last) ? last : null;
}

/**
 * Can `code` be segmented into consecutive chunks, each a PREFIX of a distinct
 * word of the team name, in order? Returns how many words were used, or 0.
 *
 *   NYM  -> new | york | mets      (3)
 *   CWS  -> chicago | white | sox  (3)
 *   DET  -> detroit               (1)
 *   NYM against "new york yankees" -> 0, because nothing starts with M.
 */
function segmentCode(code, words) {
  const memo = new Map();
  function go(ci, wi, used) {
    if (ci === code.length) return used;
    if (wi >= words.length) return 0;
    const k = `${ci}:${wi}`;
    if (memo.has(k)) return memo.get(k);
    let best = go(ci, wi + 1, used);            // skip this word
    const w = words[wi];
    for (let L = 1; L <= w.length && ci + L <= code.length; L++) {
      if (code.slice(ci, ci + L) !== w.slice(0, L)) break;
      best = Math.max(best, go(ci + L, wi + 1, used + 1));
    }
    memo.set(k, best);
    return best;
  }
  return go(0, 0, 0);
}

/** Is `code` an in-order subsequence of `word`? WSH inside "washington". */
function subsequenceOf(code, word) {
  let i = 0;
  for (const ch of word) {
    if (ch === code[i]) i++;
    if (i === code.length) return true;
  }
  return i === code.length;
}

/**
 * How strongly a Kalshi team code fits a sportsbook team name. 0 means no fit.
 *
 * Code LENGTH dominates the score, deliberately: more matched letters is
 * stronger evidence than more words touched. Without that weighting, TB - two
 * word-initials of "Toronto Blue Jays" - outscored TOR, and the Blue Jays
 * would have resolved to the Rays.
 */
export function codeAffinity(code, teamName) {
  const c = String(code || "").toLowerCase().replace(/[^a-z]/g, "");
  const words = String(teamName || "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
  if (!c || !words.length) return 0;

  // 1. Clean segmentation that starts at the first word. The common case.
  const seg = segmentCode(c, words);
  if (seg > 0 && c[0] === words[0][0]) return 100 + c.length * 10 + seg;

  // 2. Compressed inside the FIRST word only: WSH <- washington.
  //
  //    Restricted to the first word deliberately. Allowing any word let "MIL"
  //    match the MILAN in "Inter Milan", so with the Inter market absent the
  //    resolver returned AC Milan - the Yankees/Mets failure in code form.
  if (words[0][0] === c[0] && subsequenceOf(c, words[0])) return 60 + c.length * 10;

  // 3. Segmentation that does not begin at the first word - a mascot-only or
  //    surname-only code, which tennis needs ("SVI" <- Elina Svitolina).
  //
  //    PLACE NAMES ARE EXCLUDED HERE. A code that only reaches a shared city
  //    word identifies nothing: that is exactly how MIL reached "Inter Milan".
  //    Ranked below both rules above in any case.
  const identifying = words.filter((w) => !GEO.has(w));
  if (identifying.length) {
    const seg3 = segmentCode(c, identifying);
    if (seg3 > 0) return 20 + c.length * 5 + seg3;
  }

  return 0;
}

function dayNumberOf(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 86400000);
}

function normalize(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The YES side only. This is the single most important function in the file.
 *
 * A Kalshi game is listed as TWO markets - one per team - and BOTH carry the
 * same title, which names both teams: "Dallas Stars vs St. Louis Blues". Only
 * yes_sub_title says which side a YES contract actually pays on.
 *
 * The old scorer searched the title, so "Dallas Stars" scored 4 on the Dallas
 * market AND 4 on the St. Louis market. Tie. The tiebreak was close_time, which
 * is identical across both. So it kept whichever Kalshi listed first, and the
 * bot bought the OPPOSING TEAM whenever that was the other side.
 *
 * Nothing downstream could catch it: the edge was computed against the right
 * probability and the wrong contract, the order filled, and the position
 * settled against a team the model never picked.
 */
function yesSideText(m) {
  return normalize(`${m.yes_sub_title ?? ""} ${m.subtitle ?? ""}`);
}

/** Title and ticker. Used ONLY to break ties, never to create a match. */
function contextText(m) {
  return normalize(`${m.title ?? ""} ${m.event_ticker ?? ""} ${m.ticker ?? ""}`);
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

  const attempts = [
    { label: "status=open", q: `?series_ticker=${series}&status=open&limit=1000` },
    { label: "status=active", q: `?series_ticker=${series}&status=active&limit=1000` },
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

/** Drops the cached market list for a series, so the next call refetches. */
export function clearMarketCache(series = null) {
  if (series) cache.delete(series);
  else cache.clear();
}

/**
 * Usable words from a name.
 *
 * The length filter used to be a flat `> 2`, which erases short surnames -
 * a real problem in tennis, where the odds feed publishes full player names
 * and Kalshi publishes surnames. "Li Na" produced zero usable words and could
 * never match anything. Short tokens are now kept when dropping them would
 * leave nothing behind.
 */
function usableWords(teamName) {
  const all = normalize(teamName).split(" ").filter(Boolean);
  const long = all.filter((w) => w.length > 2);
  return long.length ? long : all.filter((w) => w.length >= 2);
}

export async function resolveTicker({ sportKey, teamName, commenceTime }) {
  if (NON_TEAM_OUTCOMES.has((teamName || "").toLowerCase().trim())) {
    return { ticker: null, code: "draw-or-tie", reason: "draw/tie is not a two-sided market" };
  }

  const series = runtimeSeriesMap[sportKey] || SPORT_SERIES_MAP[sportKey];
  if (!series) {
    return { ticker: null, code: "no-series", reason: `no Kalshi series is mapped for "${sportKey}"` };
  }

  let all;
  try {
    all = await getMarkets(series);
  } catch (err) {
    return { ticker: null, code: "fetch-failed", reason: `${series} markets fetch failed: ${err.message}` };
  }
  if (!all.length) {
    const r = getFetchReport(series);
    return {
      ticker: null, code: "series-empty",
      reason: `${series}: every query shape returned 0 markets (${JSON.stringify(r?.tried ?? [])})`,
    };
  }

  // --- Gate 1: it must be tradeable RIGHT NOW ---------------------------
  // There is no fallback to settled markets. Handing back a finalized ticker
  // was costing a Kalshi call per line and filling the tally with
  // "status:finalized" rows that looked like a market problem.
  const tradeable = all.filter((m) => TRADEABLE.has(String(m.status || "").toLowerCase()));
  if (!tradeable.length) {
    const statuses = {};
    for (const m of all) statuses[m.status ?? "?"] = (statuses[m.status ?? "?"] || 0) + 1;
    return {
      ticker: null, code: "none-tradeable",
      reason: `${series}: ${all.length} markets, none currently tradeable (${JSON.stringify(statuses)})`,
    };
  }

  // --- Gate 2: it must be THIS fixture ----------------------------------
  // The ticker carries the fixture date. This is the gate that stops the bot
  // buying into a game that finished last week.
  const wantDay = dayNumberOf(commenceTime);
  let dated = tradeable;
  let datedOut = 0;
  if (wantDay != null) {
    const sameDate = [];
    const undatedRows = [];
    for (const m of tradeable) {
      const d = tickerDayNumber(m.ticker);
      if (d == null) { undatedRows.push(m); continue; }
      if (Math.abs(d - wantDay) <= DATE_SLACK_DAYS) sameDate.push(m);
      else datedOut++;
    }
    // Undated tickers are kept - a series that does not encode dates should
    // still resolve on name, just without this gate's protection.
    const candidates = sameDate.concat(undatedRows);
    if (candidates.length) dated = candidates;
    else if (datedOut) {
      return {
        ticker: null, code: "wrong-date",
        reason: `${series}: ${tradeable.length} tradeable market(s), none dated within ${DATE_SLACK_DAYS} day(s) of this fixture`,
      };
    }
  }

  // --- Gate 3: the name ---------------------------------------------------
  const words = usableWords(teamName);
  if (!words.length) {
    return { ticker: null, code: "unusable-name", reason: `no usable words in "${teamName}"` };
  }
  const strong = words.filter((w) => !WEAK.has(w));

  // =====================================================================
  // GATE 3a: THE TICKER. This is the identity, and it always was.
  // =====================================================================
  //
  // The previous two attempts at this both failed because they read
  // yes_sub_title, and for MLB Kalshi publishes the CITY THERE AND NOTHING
  // ELSE. Production, 2026-09-22 14:44:
  //
  //   "detroit tigers" matched 2 KXMLBGAME market(s) on place name only
  //   ("Detroit", "Detroit")
  //
  // So "Tigers" can never match, "Yankees" can never match, and a rule that
  // demands a mascot refuses every baseball line there is - which is exactly
  // what happened: 16 lines, 16 refusals, zero trades.
  //
  // But the identity is not missing. It is in the ticker, and it is exact:
  //
  //   KXMLBGAME-26SEP232005NYMTEX-NYM   -> NYM, the Mets
  //   KXMLBGAME-26SEP231905TBNYY-NYY    -> NYY, the Yankees
  //
  // Two sides of one game carry two different codes. Same-city rivals carry
  // two different codes. This is the field that cannot be ambiguous, and it
  // is the field to match on.
  //
  // codeAffinity asks whether a code plausibly derives from a team name, by
  // segmenting it across the name's words: NYM -> new|york|mets, CWS ->
  // chicago|white|sox, DET -> detroit, WSH -> inside "washington". The wrong
  // side scores ZERO rather than merely less - NYM against "new york yankees"
  // fails on the M - so the separation is absolute, not a margin to tune.
  //
  // Verified against all 26 same-city and same-abbreviation collisions across
  // MLB, NBA, NHL and NFL before this shipped.
  const coded = [];
  let codesAvailable = 0;
  for (const m of dated) {
    const tcode = tickerTeamCode(m.ticker);
    if (!tcode) continue;
    codesAvailable++;
    const aff = codeAffinity(tcode, teamName);
    if (aff > 0) coded.push({ m, tcode, aff });
  }

  // IF THIS SERIES CARRIES SIDE CODES AND NONE OF THEM FIT, THE TEAM IS NOT
  // ON THIS BOARD. Full stop - do not fall through to name matching.
  //
  // This is the line that keeps the Yankees/Mets bug dead. Remove the NYY
  // market and no code fits "new york yankees", but the NYM market still says
  // "New York" on its YES side, so a name fallback matches it and buys the
  // Mets. Tested: without this guard the resolver returned
  // KXMLBGAME-26SEP232005NYMTEX-NYM for a Yankees line, which is precisely the
  // 12:12 order that started all of this.
  //
  // A code is a definitive answer in both directions. Its absence is evidence,
  // not a reason to go looking for a weaker one.
  if (!coded.length && codesAvailable > 0) {
    const seen = [...new Set(dated.map((m) => tickerTeamCode(m.ticker)).filter(Boolean))];
    return {
      ticker: null, code: "no-code-match",
      reason: `no ${series} ticker on this date carries a team code matching "${teamName}" ` +
        `(codes on the board: ${seen.slice(0, 12).join(", ")}${seen.length > 12 ? ", ..." : ""}). ` +
        `The team is not listed - refused rather than matching on a shared city name.`,
    };
  }

  if (coded.length) {
    const top = Math.max(...coded.map((x) => x.aff));
    const leaders = coded.filter((x) => x.aff === top);
    const distinctCodes = [...new Set(leaders.map((x) => x.tcode))];

    // Two DIFFERENT team codes fitting this name equally well means the codes
    // cannot identify the team. Refuse - this is the case the whole gate
    // exists to prevent.
    if (distinctCodes.length > 1) {
      return {
        ticker: null, code: "ambiguous-code",
        reason: `"${teamName}" fits ${distinctCodes.length} different ${series} team codes equally ` +
          `(${distinctCodes.join(", ")}) - refused rather than guessing which side pays out`,
      };
    }

    // One code, possibly several fixtures - the date window is +/-1 day, so a
    // team playing on consecutive days appears twice. Prefer the exact date,
    // then the tighter book.
    let best = leaders[0];
    if (leaders.length > 1) {
      const exact = leaders.filter((x) => tickerDayNumber(x.m.ticker) === wantDay);
      const pool = exact.length ? exact : leaders;
      const spreadOf = (x) => {
        const ask = Number(x.m.yes_ask ?? 0), bid = Number(x.m.yes_bid ?? 0);
        return ask > 0 && bid > 0 ? ask - bid : Infinity;
      };
      best = pool.reduce((a, b) => (spreadOf(b) < spreadOf(a) ? b : a));
    }

    return {
      ticker: best.m.ticker, code: "ok",
      reason: `ticker code ${best.tcode} identifies "${teamName}" ` +
        `(${best.m.status}, affinity ${best.aff}${leaders.length > 1 ? `, ${leaders.length} fixtures in window` : ""})`,
    };
  }

  // =====================================================================
  // GATE 3b: the NAME, for series whose tickers carry no side code.
  // =====================================================================
  // Reached only when no ticker on the board yields a usable code - some
  // series encode the fixture without a per-side suffix. The city guard below
  // still applies here, where it is cheap: these series publish real names.

  /**
   * Word-boundary matching, not substring.
   *
   * `text.includes(w)` matched "na" inside "rybakina" and resolved the player
   * "Li Na" to the Rybakina contract. The same flaw matches "la" inside
   * "dallas" and "ind" inside "indiana". A short token buried in a longer word
   * is not a name match, and here a false match buys the wrong contract.
   *
   * A token counts when it IS one of the market's words, or when it is 4+
   * characters and a market word starts with it - which keeps plurals and
   * possessives ("star" vs "stars") working without letting two-letter
   * fragments match anything.
   */
  const scoreAgainst = (text) => {
    const bag = new Set(text.split(" ").filter(Boolean));
    const hit = (w) => {
      if (bag.has(w)) return true;
      if (w.length < 4) return false;
      // Prefix matching needs BOTH sides to be substantial. Allowing a short
      // market word to prefix-match a long query word made "Stars" match the
      // "St." in "St. Louis Blues" - which selected the opposing team.
      for (const t of bag) {
        if (t.length < 4) continue;
        if (t.startsWith(w) || w.startsWith(t)) return true;
      }
      return false;
    };
    let score = 0;
    let distinctive = 0;
    // Strong words (mascot, surname, distinctive city) count double so
    // "NC State Wolfpack" does not match every school with "State" in it.
    for (const w of strong) {
      if (!hit(w)) continue;
      score += 2;
      // A place name adds to the score but never establishes identity. This
      // counter is what separates "New York Yankees" from "New York Mets".
      if (!GEO.has(w)) distinctive += 1;
    }
    for (const w of words) if (WEAK.has(w) && hit(w)) score += 1;
    // Whether the market itself offers anything but a place name. If its YES
    // side reads "Texas" and nothing more, there is no distinctive word to
    // match and geography is all either side has - handled below.
    const selfDistinctive = [...bag].some((t) => !GEO.has(t) && !WEAK.has(t));
    return { score, distinctive, selfDistinctive };
  };

  // --- Match on the YES SIDE, never on the title ------------------------
  //
  // A candidate must clear the identity test, not just score above zero.
  // Geography alone is accepted in exactly one case: the market's own YES side
  // carries no distinctive word either, so there is nothing better available -
  // and even then only if no other market on the board answers to the same
  // place, because two markets sharing a city is the collision this exists to
  // stop.
  const rawYes = [];
  for (const m of dated) {
    const s = scoreAgainst(yesSideText(m));
    if (s.score > 0) rawYes.push({ m, ...s });
  }

  const identified = rawYes.filter((x) => x.distinctive > 0);
  const geoOnly = rawYes.filter((x) => x.distinctive === 0);
  let onYesSide = identified;

  if (!identified.length && geoOnly.length) {
    const noBetterAvailable = geoOnly.filter((x) => !x.selfDistinctive);
    if (noBetterAvailable.length === 1 && geoOnly.length === 1) {
      onYesSide = noBetterAvailable;
    } else {
      // This is the Yankees/Mets case. The team's identifying word matched
      // nothing; only the city did. Refuse and say so, rather than buying
      // whichever same-city market happened to be listed.
      const names = geoOnly.slice(0, 3).map((x) => `"${x.m.yes_sub_title ?? x.m.title}"`).join(", ");
      return {
        ticker: null, code: "city-only-match",
        reason: `"${teamName}" matched ${geoOnly.length} ${series} market(s) on place name only ` +
          `(${names}) - no mascot or distinctive word matched, so which team a YES contract pays on ` +
          `cannot be established. Refused rather than buying a same-city rival.`,
      };
    }
  }

  if (onYesSide.length) {
    const top = Math.max(...onYesSide.map((x) => x.score));
    const leaders = onYesSide.filter((x) => x.score === top);

    if (leaders.length === 1) {
      const best = leaders[0];
      return {
        ticker: best.m.ticker, code: "ok",
        reason: `matched YES side "${best.m.yes_sub_title ?? best.m.title}" (${best.m.status}, score ${best.score})`,
      };
    }

    // Several markets name this team on their YES side - different fixtures
    // within the date window. The tighter book is the one being traded.
    const spreadOf = (x) => {
      const ask = Number(x.m.yes_ask ?? 0), bid = Number(x.m.yes_bid ?? 0);
      return ask > 0 && bid > 0 ? ask - bid : Infinity;
    };
    const best = leaders.reduce((a, b) => (spreadOf(b) < spreadOf(a) ? b : a));
    return {
      ticker: best.m.ticker, code: "ok",
      reason: `matched YES side "${best.m.yes_sub_title ?? best.m.title}" ` +
        `(${best.m.status}, score ${best.score}, tightest of ${leaders.length})`,
    };
  }

  // --- Fallback: this series does not populate a YES-side field ----------
  // Some series carry no yes_sub_title at all. Matching on the title is then
  // the only option, and the title names BOTH teams - so a tie between two
  // markets is a 50/50 guess about which team the money goes on. A refusal
  // costs one missed line. A wrong guess costs the whole stake, and the
  // strategy review then reads the loss as a bad model rather than a bad
  // ticker. So an ambiguous title match is refused, deliberately.
  const anyYesField = dated.some((m) => (m.yes_sub_title ?? m.subtitle ?? "").trim());
  const onTitle = [];
  for (const m of dated) {
    const s = scoreAgainst(contextText(m));
    // The title names BOTH teams, so a place-name hit here is worth even less
    // than on the YES side - it cannot distinguish the sides of one fixture,
    // let alone two same-city clubs. Distinctive words only.
    if (s.score > 0 && s.distinctive > 0) onTitle.push({ m, score: s.score });
  }

  if (!onTitle.length) {
    return {
      ticker: null, code: "no-name-match",
      reason: `no ${series} market has "${teamName}" on its YES side among ` +
        `${dated.length} same-date market(s), e.g. "${dated[0].title}" / YES="${dated[0].yes_sub_title ?? "(none)"}"`,
    };
  }

  if (anyYesField) {
    // The field exists on this series but did not match, which means this team
    // is the OPPONENT in the markets that matched. That is not our contract.
    return {
      ticker: null, code: "opponent-side-only",
      reason: `"${teamName}" appears only as the opponent in ${onTitle.length} ${series} market(s) - ` +
        `buying those would take the other side of the bet`,
    };
  }

  const topT = Math.max(...onTitle.map((x) => x.score));
  const leadersT = onTitle.filter((x) => x.score === topT);
  if (leadersT.length > 1) {
    return {
      ticker: null, code: "ambiguous-side",
      reason: `${series} publishes no YES-side field and ${leadersT.length} market(s) tie on the title, ` +
        `so which team a YES contract pays on cannot be determined - refused rather than guessed`,
    };
  }

  const best = leadersT[0];
  return {
    ticker: best.m.ticker, code: "ok-title-only",
    reason: `matched on title "${best.m.title}" (${best.m.status}, score ${best.score}); ` +
      `this series publishes no YES-side field`,
  };
}
