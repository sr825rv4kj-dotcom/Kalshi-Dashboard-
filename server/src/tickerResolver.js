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

export const RESOLVER_VERSION = "2026-09-21-yes-side-anchored";

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
    // Strong words (mascot, surname, distinctive city) count double so
    // "NC State Wolfpack" does not match every school with "State" in it.
    for (const w of strong) if (hit(w)) score += 2;
    for (const w of words) if (WEAK.has(w) && hit(w)) score += 1;
    return score;
  };

  // --- Match on the YES SIDE, never on the title ------------------------
  const onYesSide = [];
  for (const m of dated) {
    const score = scoreAgainst(yesSideText(m));
    if (score > 0) onYesSide.push({ m, score });
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
    const score = scoreAgainst(contextText(m));
    if (score > 0) onTitle.push({ m, score });
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
